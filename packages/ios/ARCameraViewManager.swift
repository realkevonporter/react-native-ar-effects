import React

/// View manager for ARCameraView. The manager name minus the "Manager"
/// suffix is the JS component name: `ARCameraView`.
@objc(ARCameraViewManager)
final class ARCameraViewManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func view() -> UIView {
    return ARCameraView()
  }
}
