import CoreGraphics
import CoreImage
import Foundation
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
///    face). Anchor filters run MediaPipe on the ORIGINAL buffer
///    (cleaner for detection than the graded one) and draw shapes
///    from the first face's landmarks.
/// 4. The output is ALWAYS a new pixel buffer — the source buffer is
///    never mutated (WebRTC may reuse it downstream).
/// 5. Over-budget frames return the ORIGINAL frame and count toward
///    bypass (8 consecutive -> 3s bypass -> probe), exactly the TS
///    governor contract. The filter never stalls the encoder.
///
/// Coordinate space: detection + compositing share the frame's
/// sensor space, so landmarks map to pixels directly (x * width,
/// y * height) with NO mirroring — same rule as the TS renderer.
/// Rotation is passed through on the output frame; whether landmark
/// geometry needs rotation compensation depends on how the fork's
/// capturer orients buffers, and is a first-device verification
/// point (see ARCHITECTURE.md §M3).
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
  }

  struct FilterState {
    var grade: Grade?
    var anchors: [Anchor]
    var shapes: [Shape]
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
        lineWidth: (raw["lineWidth"] as? NSNumber)?.doubleValue ?? 0.008
      ))
    }
    self.filter = FilterState(grade: grade, anchors: anchors, shapes: shapes)
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
    var landmarks: [(x: Double, y: Double)] = []
    var bounds: (x: Double, y: Double, width: Double, height: Double)?
    if !filter.shapes.isEmpty, !landmarkerFailed {
      if let result = detectFirstFace(pixelBuffer: sourceBuffer, timestampNs: frame.timeStampNs) {
        landmarks = result.landmarks
        bounds = result.bounds
      }
    }

    guard let outputBuffer = render(
      sourceBuffer: sourceBuffer,
      width: width, height: height,
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
      let points: [[String: Double]] = landmarks.map {
        ["x": $0.x, "y": $0.y, "z": 0]
      }
      let faceDict: [String: Any] = [
        "faceId": "host-face",
        "landmarks": points,
        "landmarkMap": "mediapipe-478",
        "bounds": [
          "x": bounds.x, "y": bounds.y,
          "width": bounds.width, "height": bounds.height,
        ],
        "timestampMs": Double(frame.timeStampNs / 1_000_000),
        "source": "mediapipe",
      ]
      onLandmarks?([faceDict], Double(frame.timeStampNs / 1_000_000))
    }

    let outputFrame = RTCVideoFrame(
      buffer: RTCCVPixelBuffer(pixelBuffer: outputBuffer),
      rotation: frame.rotation,
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
      default:
        continue
      }
    }
  }
}
