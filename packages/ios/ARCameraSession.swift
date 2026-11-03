import AVFoundation
import MediaPipeTasksVision

/// Owns the camera session + MediaPipe Face Landmarker for M1.
///
/// One session is shared by two consumers, and that sharing is the point:
/// the bridge module (ARFaceLandmarker) starts/stops detection, and the
/// preview view (ARCameraView) renders the same session's video. A second
/// camera session (e.g. expo-camera) would fight this one for the camera
/// hardware, so consumers must preview through ARCameraView, not their
/// own camera component.
///
/// Coordinate contract (see ARCHITECTURE.md §2): landmarks are emitted
/// in raw sensor space, normalized 0..1, origin top-left, portrait
/// oriented (the video output connection is locked to portrait). The
/// preview layer mirrors the front camera (standard selfie behavior)
/// while the sensor frames are NOT mirrored, so a consumer rendering
/// dots over its own preview must flip x -> 1 - x for the front camera.
/// Hosts never pre-flip.
///
/// MediaPipe's result carries no separate detection box on this path, so
/// bounds are computed from landmark extremes. Face IDs are stabilized
/// across frames by matching bounds centroids (MediaPipe exposes no
/// tracking ID in VIDEO mode).
final class ARCameraSession: NSObject {
  static let shared = ARCameraSession()

  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "com.areffects.camera-session")
  private let detectionQueue = DispatchQueue(label: "com.areffects.detection", qos: .userInitiated)

  private var videoOutput: AVCaptureVideoDataOutput?
  private var currentInput: AVCaptureDeviceInput?
  private var landmarker: FaceLandmarker?
  private var lastProcessedMs: Int64 = 0
  private var lastTimestampMs: Int64 = 0
  private var faceCounter = 0
  private var previousFaces: [(id: String, cx: Double, cy: Double)] = []

  private var maxFps: Double = 15
  private var maxFaces: Int = 1
  private var minDetectionConfidence: Float = 0.5
  private var cameraPosition: AVCaptureDevice.Position = .front

  /// Called on detectionQueue with one event payload per processed frame.
  var onFrame: (([[String: Any]], Int64) -> Void)?

  lazy var previewLayer: AVCaptureVideoPreviewLayer = {
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    return layer
  }()

  private override init() {
    super.init()
  }

  /// Start camera + detection. Assumes camera permission is granted
  /// (the bridge module checks authorization first). Completion fires on
  /// sessionQueue.
  func start(
    maxFps: Double,
    maxFaces: Int,
    minDetectionConfidence: Float,
    cameraPosition: AVCaptureDevice.Position,
    completion: @escaping (Error?) -> Void
  ) {
    sessionQueue.async { [weak self] in
      guard let self = self else { return }
      self.tearDownLocked()
      self.maxFps = maxFps > 0 ? maxFps : 15
      self.maxFaces = maxFaces > 0 ? maxFaces : 1
      self.minDetectionConfidence = minDetectionConfidence
      self.cameraPosition = cameraPosition

      do {
        guard let device = AVCaptureDevice.default(
          .builtInWideAngleCamera,
          for: .video,
          position: cameraPosition
        ) else {
          throw NSError(
            domain: "ARFaceEffects",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "No camera device for the requested position."]
          )
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard self.session.canAddInput(input) else {
          throw NSError(
            domain: "ARFaceEffects",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Cannot add camera input to the session."]
          )
        }

        let output = AVCaptureVideoDataOutput()
        // MediaPipe requires 32BGRA pixel buffers for sample-buffer input.
        output.videoSettings = [
          kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: self.detectionQueue)
        guard self.session.canAddOutput(output) else {
          throw NSError(
            domain: "ARFaceEffects",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "Cannot add video output to the session."]
          )
        }
        if let connection = output.connection(with: .video),
           connection.isVideoOrientationSupported {
          // Delivered buffers are portrait-oriented, so landmark
          // coordinates match a portrait preview.
          connection.videoOrientation = .portrait
        }

        guard let modelPath = Bundle(for: ARCameraSession.self)
          .path(forResource: "face_landmarker", ofType: "task")
          ?? Bundle.main.path(forResource: "face_landmarker", ofType: "task")
        else {
          throw NSError(
            domain: "ARFaceEffects",
            code: 4,
            userInfo: [NSLocalizedDescriptionKey: "face_landmarker.task is missing from the app bundle."]
          )
        }
        let options = FaceLandmarkerOptions()
        options.baseOptions.modelAssetPath = modelPath
        options.runningMode = .video
        options.numFaces = self.maxFaces
        options.minFaceDetectionConfidence = self.minDetectionConfidence
        options.minTrackingConfidence = 0.5
        options.outputFaceBlendshapes = true
        self.landmarker = try FaceLandmarker(options: options)

        self.session.beginConfiguration()
        if self.session.canSetSessionPreset(.hd1280x720) {
          self.session.sessionPreset = .hd1280x720
        }
        self.session.addInput(input)
        self.session.addOutput(output)
        self.session.commitConfiguration()
        self.currentInput = input
        self.videoOutput = output

        self.session.startRunning()
        completion(nil)
      } catch {
        self.tearDownLocked()
        completion(error)
      }
    }
  }

  func stop() {
    sessionQueue.async { [weak self] in
      self?.tearDownLocked()
    }
  }

  /// Must be called on sessionQueue.
  private func tearDownLocked() {
    if session.isRunning {
      session.stopRunning()
    }
    if let output = videoOutput {
      output.setSampleBufferDelegate(nil, queue: nil)
      session.removeOutput(output)
    }
    if let input = currentInput {
      session.removeInput(input)
    }
    videoOutput = nil
    currentInput = nil
    landmarker = nil
    lastProcessedMs = 0
    lastTimestampMs = 0
    previousFaces = []
    faceCounter = 0
  }
}

extension ARCameraSession: AVCaptureVideoDataOutputSampleBufferDelegate {
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let landmarker = landmarker else { return }
    let presentationMs = Int64(
      CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1000
    )
    // Throttle to maxFps: the camera runs faster than detection needs.
    if presentationMs - lastProcessedMs < Int64(1000.0 / maxFps) {
      return
    }
    lastProcessedMs = presentationMs
    // VIDEO mode requires strictly increasing timestamps.
    let timestampMs = max(presentationMs, lastTimestampMs + 1)
    lastTimestampMs = timestampMs

    do {
      let image = try MPImage(sampleBuffer: sampleBuffer)
      let result = try landmarker.detect(
        videoFrame: image,
        timestampInMilliseconds: Int(timestampMs)
      )
      var faces: [[String: Any]] = []
      var currentFaces: [(id: String, cx: Double, cy: Double)] = []
      for (faceIndex, landmarks) in result.faceLandmarks.enumerated() {
        let points: [[String: Double]] = landmarks.map {
          ["x": Double($0.x), "y": Double($0.y), "z": Double($0.z)]
        }
        let xs = points.map { $0["x"] ?? 0 }
        let ys = points.map { $0["y"] ?? 0 }
        guard let minX = xs.min(), let maxX = xs.max(),
              let minY = ys.min(), let maxY = ys.max() else {
          continue
        }
        let bounds: [String: Double] = [
          "x": minX,
          "y": minY,
          "width": maxX - minX,
          "height": maxY - minY,
        ]
        let cx = minX + (maxX - minX) / 2
        let cy = minY + (maxY - minY) / 2
        // Stabilize IDs by nearest-centroid matching (threshold 0.2 in
        // normalized space); unmatched faces get fresh IDs.
        var faceId: String?
        var bestDistance = 0.2
        for previous in previousFaces {
          let dx = previous.cx - cx
          let dy = previous.cy - cy
          let distance = (dx * dx + dy * dy).squareRoot()
          if distance < bestDistance {
            bestDistance = distance
            faceId = previous.id
          }
        }
        if faceId == nil {
          faceId = "face-\(faceCounter)"
          faceCounter += 1
        }
        currentFaces.append((id: faceId!, cx: cx, cy: cy))

        var faceDict: [String: Any] = [
          "faceId": faceId!,
          "landmarks": points,
          "landmarkMap": "mediapipe-478",
          "bounds": bounds,
          "timestampMs": Double(timestampMs),
          "source": "mediapipe",
        ]
        if faceIndex < result.faceBlendshapes.count {
          var blendshapes: [String: Double] = [:]
          for category in result.faceBlendshapes[faceIndex].categories {
            blendshapes[category.categoryName ?? ""] = Double(category.score)
          }
          if !blendshapes.isEmpty {
            faceDict["blendshapes"] = blendshapes
          }
        }
        faces.append(faceDict)
      }
      previousFaces = currentFaces
      onFrame?(faces, timestampMs)
    } catch {
      // A single failed frame must not kill the stream; the next frame
      // is processed normally. Errors surface via missing frames, which
      // the JS side already treats as tracking loss after a gap.
    }
  }
}
