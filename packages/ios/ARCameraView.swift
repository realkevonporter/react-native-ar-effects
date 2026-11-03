import AVFoundation
import UIKit

/// Native preview view bound to the shared provider session.
///
/// The session owns the camera, so this view only hosts its preview
/// layer — it never opens a camera itself. Consumers overlay landmark
/// dots on top of this view. The preview layer mirrors the front camera
/// (standard selfie behavior) while landmark coordinates are raw sensor
/// space, so front-camera overlays must flip x -> 1 - x (see the
/// example app and ARCHITECTURE.md §2).
final class ARCameraView: UIView {
  private let previewLayer = ARCameraSession.shared.previewLayer

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.addSublayer(previewLayer)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    if let connection = previewLayer.connection,
       connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }
}
