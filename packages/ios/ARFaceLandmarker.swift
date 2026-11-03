import AVFoundation
import React

/// React Native bridge module for the MediaPipe provider (M1).
///
/// Thin by design: camera permission + promise plumbing live here, while
/// the camera session and the MediaPipe engine live in ARCameraSession.
/// JS calls start/stop/isSupported; per-frame results arrive as
/// `onFaceFrame` events with { faces: FaceFrame[], timestampMs }.
@objc(ARFaceLandmarker)
final class ARFaceLandmarker: RCTEventEmitter {
  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String] {
    return ["onFaceFrame"]
  }

  @objc func start(
    _ config: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let maxFps = (config["maxFps"] as? NSNumber)?.doubleValue ?? 15
    let maxFaces = (config["maxFaces"] as? NSNumber)?.intValue ?? 1
    let minDetectionConfidence =
      (config["minDetectionConfidence"] as? NSNumber)?.floatValue ?? 0.5
    let position: AVCaptureDevice.Position =
      (config["cameraPosition"] as? String) == "back" ? .back : .front

    // Wire frame events before starting, so no frame is missed.
    ARCameraSession.shared.onFrame = { [weak self] faces, timestampMs in
      DispatchQueue.main.async {
        self?.sendEvent(
          withName: "onFaceFrame",
          body: ["faces": faces, "timestampMs": Double(timestampMs)]
        )
      }
    }

    let proceed = {
      ARCameraSession.shared.start(
        maxFps: maxFps,
        maxFaces: maxFaces,
        minDetectionConfidence: minDetectionConfidence,
        cameraPosition: position
      ) { error in
        if let error = error {
          reject("E_START_FAILED", error.localizedDescription, error)
        } else {
          resolve(true)
        }
      }
    }

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      proceed()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        if granted {
          proceed()
        } else {
          reject(
            "E_CAMERA_PERMISSION",
            "Camera permission was not granted.",
            nil
          )
        }
      }
    default:
      reject(
        "E_CAMERA_PERMISSION",
        "Camera permission is denied. Enable it in Settings to use face tracking.",
        nil
      )
    }
  }

  @objc func stop(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    ARCameraSession.shared.stop()
    resolve(true)
  }

  @objc func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // MediaPipe Tasks Vision runs on every iOS version this library
    // supports (podspec minimum iOS 13); no per-device gating in M1.
    resolve(true)
  }
}
