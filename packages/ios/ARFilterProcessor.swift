import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import MediaPipeTasksVision
import WebRTC

/// M3 host-side filter processor (iOS).
///
/// Registered with the LiveKit fork's VideoEffect registry under the
/// name "ar-effects-filter" (see ARFilterModule). The fork calls
/// `capturer:didCaptureVideoFrame:` for every camera frame and
/// forwards the returned frame to the encoder — so anything this
/// processor draws is what ALL viewers see. That is the pre-encode
/// contract: no viewer-side overlay, no second camera.
///
/// Frame flow (mirrors the TS HostFilterPipeline + filter renderer):
/// 1. No filter, or bypassed inside cooldown -> return frame untouched.
/// 2. Non-pixel-buffer frames (e.g. I420) pass through unfiltered:
///    the camera capturer produces pixel buffers, so this is a
///    defensive branch, not the normal path.
/// 3. Grade-only filters skip detection entirely (a grade needs no
///    face). Anchor filters run MediaPipe on the UPRIGHT buffer
///    (uprightBGRABuffer: rotation-compensated + BGRA) and draw
///    shapes on that same buffer — the anchor layout assumes
///    face-x is left-right, which is only true upright. A shape
///    filter's output frame carries rotation 0 (already upright);
///    grade-only filters keep the original buffer + rotation
///    passthrough.
/// 4. The output is ALWAYS a new pixel buffer — the source buffer is
///    never mutated (WebRTC may reuse it downstream).
/// 5. Over-budget frames return the ORIGINAL frame and count toward
///    bypass (8 consecutive -> 3s bypass -> probe), exactly the TS
///    governor contract. The filter never stalls the encoder.
///
/// Coordinate space: shape filters composite in UPRIGHT space
/// (detection buffer + upright landmarks + rotation-0 output),
/// because the anchor layout assumes face-x is left-right. The
/// landmark relay stays in sensor space (mapped back) for M2
/// viewer anchoring. Grade-only filters composite on the original
/// buffer with rotation passthrough. Landmarks map to pixels
/// directly (x * width, y * height) with NO mirroring — same rule
/// as the TS renderer. (On-device 1.0.45 proved the old
/// sensor-space compositing transposes shapes: Nerd Glasses
/// rendered as two stacked landscape rects instead of
/// side-by-side lenses.)
///
/// Head roll: drawShapes rotates every shape by the eye-line
/// angle (landmarks 33 -> 263, normalized to (-90, 90]) around
/// its anchor center, so filters tilt with the face. Position
/// already tracks via landmarks; above-head placement along the
/// head's tilted up-axis (rather than the bounding-box top) is
/// future work.
///
/// Landmarks are emitted via onLandmarks (same dict shape as M1's
/// onFaceFrame, single face, id "host-face") so the host app can
/// forward them over the live socket for M2 viewer anchoring at M5.
///
/// FIRST-BUILD VERIFICATION (uncompiled in the sandbox — see
/// ARCHITECTURE.md §M3): MPImage(pixelBuffer:) initializer,
/// RTCVideoFrame(buffer:rotation:timeStampNs:) initializer,
/// RTCCVPixelBuffer(pixelBuffer:) initializer, and the runtime
/// lookup of the fork's ProcessorProvider class (see ARFilterModule).
@objc(ARFilterProcessor)
final class ARFilterProcessor: NSObject {
  static let shared = ARFilterProcessor()

  static let processorName = "ar-effects-filter"

  /// Current filter state (parsed EffectDefinition subset). Set by
  /// ARFilterModule.setFilter; nil = no filter (pass-through).
  var filter: FilterState?

  /// Called with ([face dict], timestampMs) when detection runs.
  var onLandmarks: (([[String: Any]], Double) -> Void)?
  /// Called when the pipeline enters bypass (filter off).
  var onBypassed: (() -> Void)?

  private var landmarker: FaceLandmarker?
  private var landmarkerFailed = false
  private var lastTimestampMs: Int64 = 0
  private var consecutiveDrops = 0
  private var bypassed = false
  private var bypassUntil = CFAbsoluteTime(0)

  private let budgetMs = 1000.0 / 15.0
  private let maxConsecutiveDrops = 8
  private let bypassCooldownSeconds = 3.0
  private let ciContext = CIContext()

  private override init() {}

  // MARK: - Filter state

  struct Grade {
    var warmth: Double
    var brightness: Double
    var saturation: Double
    var contrast: Double
  }

  struct Anchor {
    var placement: String
    var landmarkIndices: [Int]
    var scaleToFace: Double
    var offsetX: Double
    var offsetY: Double
  }

  struct Shape {
    var kind: String
    var anchor: Int
    var rect: (x: Double, y: Double, width: Double, height: Double)
    var points: [(x: Double, y: Double)]
    var color: UInt32
    var fill: Bool
    var lineWidth: Double
    /// Image shapes only: index into FilterState.images (-1 = none).
    var asset: Int
  }

  struct FilterState {
    var grade: Grade?
    var anchors: [Anchor]
    var shapes: [Shape]
    /// Decoded image assets, parallel to the definition's assets
    /// array (nil for non-image or undecodable entries). Decoded
    /// once at setFilter, never per frame.
    var images: [CGImage?]
  }

  /// Parse the EffectDefinition JSON handed over by the JS adapter.
  /// Only the fields the compositor needs are read; unknown fields
  /// are ignored so the definition format can grow.
  func setFilter(json: String) throws {
    guard let data = json.data(using: .utf8),
          let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      throw NSError(
        domain: "ARFaceEffects", code: 10,
        userInfo: [NSLocalizedDescriptionKey: "setFilter: invalid effect JSON."]
      )
    }
    var grade: Grade?
    if let g = root["grade"] as? [String: Any] {
      grade = Grade(
        warmth: (g["warmth"] as? NSNumber)?.doubleValue ?? 0,
        brightness: (g["brightness"] as? NSNumber)?.doubleValue ?? 0,
        saturation: (g["saturation"] as? NSNumber)?.doubleValue ?? 1,
        contrast: (g["contrast"] as? NSNumber)?.doubleValue ?? 1
      )
    }
    var anchors: [Anchor] = []
    for raw in (root["anchors"] as? [[String: Any]]) ?? [] {
      let offset = raw["offset"] as? [String: Any]
      anchors.append(Anchor(
        placement: (raw["placement"] as? String) ?? "on-face",
        landmarkIndices: (raw["landmarkIndices"] as? [NSNumber])?.map { $0.intValue } ?? [],
        scaleToFace: (raw["scaleToFace"] as? NSNumber)?.doubleValue ?? 1,
        offsetX: (offset?["x"] as? NSNumber)?.doubleValue ?? 0,
        offsetY: (offset?["y"] as? NSNumber)?.doubleValue ?? 0
      ))
    }
    var images: [CGImage?] = []
    for raw in (root["assets"] as? [[String: Any]]) ?? [] {
      guard (raw["kind"] as? String) == "image",
            let uri = raw["uri"] as? String,
            uri.hasPrefix("data:image/"),
            let comma = uri.firstIndex(of: ",")
      else {
        images.append(nil)
        continue
      }
      let b64 = String(uri[uri.index(after: comma)...])
      guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
      else {
        images.append(nil)
        continue
      }
      images.append(cgImage)
    }
    var shapes: [Shape] = []
    for raw in (root["shapes"] as? [[String: Any]]) ?? [] {
      let rectRaw = raw["rect"] as? [String: Any]
      let pointsRaw = raw["points"] as? [[String: Any]] ?? []
      let colorString = (raw["color"] as? String) ?? "#ffffff"
      shapes.append(Shape(
        kind: (raw["kind"] as? String) ?? "rect",
        anchor: (raw["anchor"] as? NSNumber)?.intValue ?? 0,
        rect: (
          x: (rectRaw?["x"] as? NSNumber)?.doubleValue ?? 0,
          y: (rectRaw?["y"] as? NSNumber)?.doubleValue ?? 0,
          width: (rectRaw?["width"] as? NSNumber)?.doubleValue ?? 1,
          height: (rectRaw?["height"] as? NSNumber)?.doubleValue ?? 1
        ),
        points: pointsRaw.map {
          (
            x: ($0["x"] as? NSNumber)?.doubleValue ?? 0,
            y: ($0["y"] as? NSNumber)?.doubleValue ?? 0
          )
        },
        color: Self.parseHex(colorString),
        fill: (raw["fill"] as? Bool) ?? false,
        lineWidth: (raw["lineWidth"] as? NSNumber)?.doubleValue ?? 0.008,
        asset: (raw["asset"] as? NSNumber)?.intValue ?? -1
      ))
    }
    self.filter = FilterState(grade: grade, anchors: anchors, shapes: shapes, images: images)
  }

  private static func parseHex(_ string: String) -> UInt32 {
    var hex = string
    if hex.hasPrefix("#") { hex.removeFirst() }
    return UInt32(hex, radix: 16) ?? 0xFFFFFF
  }

  // MARK: - VideoFrameProcessorDelegate (fork protocol, by selector)

  /// Selector must match the fork's protocol exactly:
  /// capturer:didCaptureVideoFrame:. ObjC message dispatch does not
  /// check declared protocol conformance, so this NSObject subclass
  /// satisfies the fork's `NSObject<VideoFrameProcessorDelegate>*`
  /// requirement structurally. (First-build verification: the fork
  /// calls this method on the registered instance.)
  @objc func capturer(
    _ capturer: RTCVideoCapturer,
    didCaptureVideoFrame frame: RTCVideoFrame
  ) -> RTCVideoFrame {
    guard let filter = self.filter else { return frame }
    let now = CFAbsoluteTimeGetCurrent()
    if bypassed && now < bypassUntil { return frame }
    guard let rtcBuffer = frame.buffer as? RTCCVPixelBuffer else {
      // Non-pixel-buffer frames pass through unfiltered.
      return frame
    }
    let sourceBuffer = rtcBuffer.pixelBuffer
    let width = CVPixelBufferGetWidth(sourceBuffer)
    let height = CVPixelBufferGetHeight(sourceBuffer)
    let start = CFAbsoluteTimeGetCurrent()

    // Detection: only when shapes need a face; grade-only skips it.
    // Shape filters composite in UPRIGHT space: the anchor layout
    // assumes face-x is left-right, which is only true of the
    // upright buffer. On a portrait phone the sensor buffer holds
    // a sideways face, so laying lenses out on sensor landmarks
    // transposes them — on-device 1.0.45: Nerd Glasses rendered as
    // two stacked landscape rects instead of side-by-side lenses.
    // So for shape filters the render source is the upright
    // detection buffer and the output frame carries rotation 0
    // (already upright); grade-only filters keep the original
    // buffer + rotation passthrough.
    var landmarks: [(x: Double, y: Double)] = []
    var bounds: (x: Double, y: Double, width: Double, height: Double)?
    var renderBuffer = sourceBuffer
    var renderWidth = width
    var renderHeight = height
    var outputRotation = frame.rotation
    var detectionRotated = false
    if !filter.shapes.isEmpty, !landmarkerFailed {
      if let up = uprightBGRABuffer(from: sourceBuffer, rotation: frame.rotation) {
        renderBuffer = up
        renderWidth = CVPixelBufferGetWidth(up)
        renderHeight = CVPixelBufferGetHeight(up)
        if frame.rotation.rawValue != 0 {
          outputRotation = RTCVideoRotation(rawValue: 0) ?? frame.rotation
          detectionRotated = true
        }
        if let result = detectFirstFace(pixelBuffer: up, timestampNs: frame.timeStampNs) {
          landmarks = result.landmarks
          bounds = result.bounds
        }
      } else {
        // Upright conversion failed: detect on the source buffer
        // (pre-0.1.5 behavior — shapes may transpose, but the
        // stream keeps flowing).
        if let result = detectFirstFace(pixelBuffer: sourceBuffer, timestampNs: frame.timeStampNs) {
          landmarks = result.landmarks
          bounds = result.bounds
        }
      }
    }

    guard let outputBuffer = render(
      sourceBuffer: renderBuffer,
      width: renderWidth, height: renderHeight,
      filter: filter,
      landmarks: landmarks,
      bounds: bounds
    ) else {
      return frame
    }

    let durationMs = (CFAbsoluteTimeGetCurrent() - start) * 1000
    if durationMs > budgetMs {
      consecutiveDrops += 1
      if consecutiveDrops >= maxConsecutiveDrops {
        bypassed = true
        bypassUntil = CFAbsoluteTimeGetCurrent() + bypassCooldownSeconds
        onBypassed?()
      }
      return frame
    }
    consecutiveDrops = 0
    bypassed = false

    if let bounds = bounds {
      // Relay stays in sensor (buffer) space, as M5 expects: when
      // detection ran on a rotated upright buffer, map back.
      let relayLandmarks: [(x: Double, y: Double)]
      let relayBounds: (x: Double, y: Double, width: Double, height: Double)
      if detectionRotated {
        relayLandmarks = landmarks.map { mapBack($0, rotation: frame.rotation) }
        let xs = relayLandmarks.map { $0.x }
        let ys = relayLandmarks.map { $0.y }
        let minX = xs.min() ?? 0
        let maxX = xs.max() ?? 0
        let minY = ys.min() ?? 0
        let maxY = ys.max() ?? 0
        relayBounds = (x: minX, y: minY, width: maxX - minX, height: maxY - minY)
      } else {
        relayLandmarks = landmarks
        relayBounds = bounds
      }
      let points: [[String: Double]] = relayLandmarks.map {
        ["x": $0.x, "y": $0.y, "z": 0]
      }
      let faceDict: [String: Any] = [
        "faceId": "host-face",
        "landmarks": points,
        "landmarkMap": "mediapipe-478",
        "bounds": [
          "x": relayBounds.x, "y": relayBounds.y,
          "width": relayBounds.width, "height": relayBounds.height,
        ],
        "timestampMs": Double(frame.timeStampNs / 1_000_000),
        "source": "mediapipe",
      ]
      onLandmarks?([faceDict], Double(frame.timeStampNs / 1_000_000))
    }

    let outputFrame = RTCVideoFrame(
      buffer: RTCCVPixelBuffer(pixelBuffer: outputBuffer),
      rotation: outputRotation,
      timeStampNs: frame.timeStampNs
    )
    return outputFrame
  }

  // MARK: - Detection (same engine + options pattern as M1)

  private func ensureLandmarker() {
    if landmarker != nil || landmarkerFailed { return }
    do {
      let bundle = Bundle(for: ARFilterProcessor.self)
      guard let modelPath = bundle.path(forResource: "face_landmarker", ofType: "task")
        ?? Bundle.main.path(forResource: "face_landmarker", ofType: "task")
      else {
        throw NSError(
          domain: "ARFaceEffects", code: 4,
          userInfo: [NSLocalizedDescriptionKey: "face_landmarker.task is missing from the app bundle."]
        )
      }
      let options = FaceLandmarkerOptions()
      options.baseOptions.modelAssetPath = modelPath
      options.runningMode = .video
      options.numFaces = 1
      options.minFaceDetectionConfidence = 0.5
      options.minTrackingConfidence = 0.5
      // Blendshapes are not needed for filters; skipping them saves compute.
      options.outputFaceBlendshapes = false
      landmarker = try FaceLandmarker(options: options)
    } catch {
      // Detection failure must not kill the stream: grade still
      // applies, shapes are omitted until detection recovers (the
      // flag is sticky for the process lifetime; a filter re-set
      // clears it via setFilter only if the module recreates state).
      landmarkerFailed = true
    }
  }

  /// Detect the first face on an already-upright buffer (the
  /// caller prepares it via uprightBGRABuffer). Returns landmarks
  /// + bounds in THAT buffer's coordinates — the caller draws on
  /// the same buffer, so no mapping is needed here. The landmark
  /// relay maps back to sensor space separately (see capturer).
  private func detectFirstFace(
    pixelBuffer: CVPixelBuffer,
    timestampNs: Int64
  ) -> (landmarks: [(x: Double, y: Double)], bounds: (x: Double, y: Double, width: Double, height: Double))? {
    ensureLandmarker()
    guard let landmarker = landmarker else { return nil }
    // VIDEO mode requires strictly increasing timestamps (M1 rule).
    let timestampMs = max(timestampNs / 1_000_000, lastTimestampMs + 1)
    lastTimestampMs = timestampMs
    do {
      let image = try MPImage(pixelBuffer: pixelBuffer)
      let result = try landmarker.detect(
        videoFrame: image,
        timestampInMilliseconds: Int(timestampMs)
      )
      guard let first = result.faceLandmarks.first else { return nil }
      let points = first.map { (x: Double($0.x), y: Double($0.y)) }
      let xs = points.map { $0.x }
      let ys = points.map { $0.y }
      guard let minX = xs.min(), let maxX = xs.max(),
            let minY = ys.min(), let maxY = ys.max() else { return nil }
      return (
        landmarks: points,
        bounds: (x: minX, y: minY, width: maxX - minX, height: maxY - minY)
      )
    } catch {
      return nil
    }
  }

  /// Upright BGRA buffer for detection, or nil to fall back to the
  /// original buffer. Returns the original buffer untouched when it
  /// is already upright BGRA (rotation 0 + 32BGRA). Otherwise renders
  /// through CoreImage: orientation applied (portrait phone buffers
  /// are landscape) into a fresh 32BGRA buffer.
  private func uprightBGRABuffer(
    from buffer: CVPixelBuffer,
    rotation: RTCVideoRotation
  ) -> CVPixelBuffer? {
    let format = CVPixelBufferGetPixelFormatType(buffer)
    let needsRotate = rotation.rawValue != 0
    let needsConvert = format != kCVPixelFormatType_32BGRA
    guard needsRotate || needsConvert else { return buffer }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    var image = CIImage(cvPixelBuffer: buffer)
    if needsRotate {
      let orientation: CGImagePropertyOrientation
      switch rotation.rawValue {
      case 90: orientation = .right
      case 180: orientation = .down
      case 270: orientation = .left
      default: orientation = .up
      }
      image = image.oriented(orientation)
      // Normalize the extent origin so the render fills the buffer.
      let origin = image.extent.origin
      if origin.x != 0 || origin.y != 0 {
        image = image.transformed(by: CGAffineTransform(translationX: -origin.x, y: -origin.y))
      }
    }
    let swapped = rotation.rawValue == 90 || rotation.rawValue == 270
    let outWidth = swapped ? height : width
    let outHeight = swapped ? width : height
    var out: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      nil, outWidth, outHeight,
      kCVPixelFormatType_32BGRA,
      nil,
      &out
    )
    guard status == kCVReturnSuccess, let out = out else { return nil }
    ciContext.render(image, to: out)
    return out
  }

  /// Map a landmark from upright detection coordinates back to
  /// buffer coordinates (inverse of the display rotation).
  /// Normalized coordinates, so dimensions cancel.
  private func mapBack(
    _ p: (x: Double, y: Double),
    rotation: RTCVideoRotation
  ) -> (x: Double, y: Double) {
    switch rotation.rawValue {
    case 90: return (x: p.y, y: 1 - p.x)
    case 180: return (x: 1 - p.x, y: 1 - p.y)
    case 270: return (x: 1 - p.y, y: p.x)
    default: return p
    }
  }

  // MARK: - Compositing (grade via CoreImage, shapes via CoreGraphics)

  private func render(
    sourceBuffer: CVPixelBuffer,
    width: Int, height: Int,
    filter: FilterState,
    landmarks: [(x: Double, y: Double)],
    bounds: (x: Double, y: Double, width: Double, height: Double)?
  ) -> CVPixelBuffer? {
    var outputBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      nil, width, height,
      kCVPixelFormatType_32BGRA,
      nil,
      &outputBuffer
    )
    guard status == kCVReturnSuccess, let out = outputBuffer else { return nil }

    // Grade (or straight copy when there is no grade).
    var image = CIImage(cvPixelBuffer: sourceBuffer)
    if let grade = filter.grade {
      if let matrix = CIFilter(name: "CIColorMatrix") {
        matrix.setValue(image, forKey: kCIInputImageKey)
        let w = grade.warmth
        matrix.setValue(CIVector(x: 1 + 0.2 * w, y: 0, z: 0, w: 0), forKey: "inputRVector")
        matrix.setValue(CIVector(x: 0, y: 1, z: 0, w: 0), forKey: "inputGVector")
        matrix.setValue(CIVector(x: 0, y: 0, z: 1 - 0.2 * w, w: 0), forKey: "inputBVector")
        matrix.setValue(CIVector(x: 0, y: 0, z: 0, w: 1), forKey: "inputAVector")
        matrix.setValue(CIVector(x: 0, y: 0, z: 0, w: 0), forKey: "inputBiasVector")
        if let warmed = matrix.outputImage { image = warmed }
      }
      if let controls = CIFilter(name: "CIColorControls") {
        controls.setValue(image, forKey: kCIInputImageKey)
        controls.setValue(grade.saturation, forKey: kCIInputSaturationKey)
        controls.setValue(grade.brightness, forKey: kCIInputBrightnessKey)
        controls.setValue(grade.contrast, forKey: kCIInputContrastKey)
        if let graded = controls.outputImage { image = graded }
      }
    }
    ciContext.render(image, to: out)

    // Shapes (only with a detected face — same rule as the TS renderer).
    if !filter.shapes.isEmpty, let bounds = bounds {
      drawShapes(filter: filter, landmarks: landmarks, bounds: bounds,
                 buffer: out, width: width, height: height)
    }
    return out
  }

  private func anchorRect(
    anchor: Anchor,
    landmarks: [(x: Double, y: Double)],
    bounds: (x: Double, y: Double, width: Double, height: Double)
  ) -> (x: Double, y: Double, width: Double, height: Double) {
    if anchor.placement == "fullscreen" {
      return (x: 0, y: 0, width: 1, height: 1)
    }
    let faceWidth = bounds.width
    let width = anchor.scaleToFace * bounds.width
    let height = anchor.scaleToFace * bounds.height
    let point: (x: Double, y: Double)
    if anchor.placement == "above-head" {
      point = (x: bounds.x + bounds.width / 2, y: bounds.y)
    } else {
      // on-face / follow: centroid of the anchor's landmark indices
      // that are present; bounds center when none are.
      var sumX = 0.0, sumY = 0.0, count = 0
      for index in anchor.landmarkIndices where index < landmarks.count {
        sumX += landmarks[index].x
        sumY += landmarks[index].y
        count += 1
      }
      if count > 0 {
        point = (x: sumX / Double(count), y: sumY / Double(count))
      } else {
        point = (x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2)
      }
    }
    let offsetX = anchor.offsetX * faceWidth
    let offsetY = anchor.offsetY * faceWidth
    if anchor.placement == "above-head" {
      return (x: point.x - width / 2 + offsetX, y: point.y - height + offsetY,
              width: width, height: height)
    }
    return (x: point.x - width / 2 + offsetX, y: point.y - height / 2 + offsetY,
            width: width, height: height)
  }

  private func drawShapes(
    filter: FilterState,
    landmarks: [(x: Double, y: Double)],
    bounds: (x: Double, y: Double, width: Double, height: Double),
    buffer: CVPixelBuffer,
    width: Int, height: Int
  ) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    guard let context = CGContext(
      data: base, width: width, height: height,
      bitsPerComponent: 8, bytesPerRow: bytesPerRow,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
        | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { return }
    // CoreGraphics origin is bottom-left; flip so normalized
    // top-left coordinates map directly.
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)

    // Head roll: the eye line tilts with the head. Every shape is
    // rotated by the eye-line angle around its anchor center so
    // filters tilt with the face instead of staying axis-aligned.
    // Normalized to (-90, 90] so the result does not depend on
    // which eye index is left vs right; correct for all normal
    // head tilts (upside-down heads are out of scope). When the
    // face is upright the angle is ~0 and rendering is unchanged.
    var rollAngle = 0.0
    if landmarks.count > 263 {
      let dx = landmarks[263].x - landmarks[33].x
      let dy = landmarks[263].y - landmarks[33].y
      if dx != 0 || dy != 0 {
        var angle = atan2(dy, dx)
        if angle > Double.pi / 2 { angle -= Double.pi }
        if angle < -Double.pi / 2 { angle += Double.pi }
        rollAngle = angle
      }
    }

    for shape in filter.shapes {
      guard shape.anchor < filter.anchors.count else { continue }
      let anchor = filter.anchors[shape.anchor]
      let rect = anchorRect(anchor: anchor, landmarks: landmarks, bounds: bounds)
      let abs = (
        x: rect.x + shape.rect.x * rect.width,
        y: rect.y + shape.rect.y * rect.height,
        width: shape.rect.width * rect.width,
        height: shape.rect.height * rect.height
      )
      let r = CGFloat((shape.color >> 16) & 0xFF) / 255
      let g = CGFloat((shape.color >> 8) & 0xFF) / 255
      let b = CGFloat(shape.color & 0xFF) / 255
      let color = CGColor(red: r, green: g, blue: b, alpha: 1)
      context.setStrokeColor(color)
      context.setFillColor(color)
      context.setLineWidth(CGFloat(shape.lineWidth) * CGFloat(width))
      let cgRect = CGRect(
        x: abs.x * Double(width), y: abs.y * Double(height),
        width: abs.width * Double(width), height: abs.height * Double(height)
      )
      // Rotate the shape around its anchor center by the head
      // roll. In this flipped context, rotate(by:) turns shapes
      // clockwise-positive in y-down coordinates, matching the
      // eye-line angle measured above. The defer restores the
      // context even when a case below hits `continue`.
      context.saveGState()
      defer { context.restoreGState() }
      let pivotX = (rect.x + rect.width / 2) * Double(width)
      let pivotY = (rect.y + rect.height / 2) * Double(height)
      context.translateBy(x: pivotX, y: pivotY)
      context.rotate(by: CGFloat(rollAngle))
      context.translateBy(x: -pivotX, y: -pivotY)
      switch shape.kind {
      case "ellipse":
        if shape.fill { context.fillEllipse(in: cgRect) }
        else { context.strokeEllipse(in: cgRect) }
      case "rect":
        if shape.fill { context.fill(cgRect) }
        else { context.stroke(cgRect) }
      case "line", "polyline":
        let pts = shape.points.map {
          CGPoint(
            x: (rect.x + $0.x * rect.width) * Double(width),
            y: (rect.y + $0.y * rect.height) * Double(height)
          )
        }
        guard pts.count >= 2 else { continue }
        context.beginPath()
        context.move(to: pts[0])
        for pt in pts.dropFirst() { context.addLine(to: pt) }
        context.strokePath()
      case "image":
        guard shape.asset >= 0, shape.asset < filter.images.count,
              let cgImage = filter.images[shape.asset]
        else { continue }
        // Aspect-fit inside cgRect (pixel space): never stretch.
        // Above-head anchors bottom-pin (the crown sits ON the
        // head; its rect extends above the face), on-face anchors
        // center. The outer context is y-flipped (normalized
        // top-left coords map directly), which would draw the
        // image upside down; counter-flip around the fitted
        // rect's center. Nested save/restore pairs with the roll
        // rotation above.
        let imgW = CGFloat(cgImage.width)
        let imgH = CGFloat(cgImage.height)
        guard imgW > 0, imgH > 0 else { continue }
        let scale = min(cgRect.width / imgW, cgRect.height / imgH)
        let fittedWidth = imgW * scale
        let fittedHeight = imgH * scale
        let fittedX = cgRect.midX - fittedWidth / 2
        let fittedY = anchor.placement == "above-head"
          ? cgRect.maxY - fittedHeight
          : cgRect.midY - fittedHeight / 2
        context.saveGState()
        context.translateBy(x: fittedX + fittedWidth / 2, y: fittedY + fittedHeight / 2)
        context.scaleBy(x: 1, y: -1)
        context.interpolationQuality = .high
        context.draw(
          cgImage,
          in: CGRect(
            x: -fittedWidth / 2, y: -fittedHeight / 2,
            width: fittedWidth, height: fittedHeight
          )
        )
        context.restoreGState()
      default:
        continue
      }
    }
  }
}
