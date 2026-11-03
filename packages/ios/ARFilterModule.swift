import React

/// React Native bridge module for the M3 host filter (iOS).
///
/// Thin by design, mirroring ARFaceLandmarker (M1): registration +
/// promise plumbing live here, while the MediaPipe engine and the
/// compositing live in ARFilterProcessor. JS calls
/// registerProcessor / setFilter / clearFilter (see filter-bridge.ts);
/// landmark frames arrive as `onFilterFrame` events (same dict shape
/// as M1's onFaceFrame) and bypass transitions as `onFilterBypassed`.
///
/// Registration uses a runtime lookup, not a compile-time import:
/// the fork's ProcessorProvider lives in the fork's module, whose
/// Swift module name for the dashed pod name
/// (livekit-react-native-webrtc) is not something to guess at in
/// source. NSClassFromString("ProcessorProvider") finds the ObjC
/// class by its runtime name, and performSelector delivers
/// addProcessor:forName: — ObjC message dispatch does not check
/// declared protocol conformance. If the class is missing at runtime
/// (e.g. the host app pinned a fork version without video effects),
/// registerProcessor rejects loudly instead of silently skipping —
/// the Android side has the same fail-loud rule, because Android's
/// silent skip on unknown names is exactly what M5 must not hit.
@objc(ARFilter)
final class ARFilter: RCTEventEmitter {
  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String] {
    return ["onFilterFrame", "onFilterBypassed"]
  }

  private var registered = false

  @objc func registerProcessor(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    if registered {
      resolve(true)
      return
    }
    // Wire events before registering, so no frame is missed.
    ARFilterProcessor.shared.onLandmarks = { [weak self] faces, timestampMs in
      DispatchQueue.main.async {
        self?.sendEvent(
          withName: "onFilterFrame",
          body: ["faces": faces, "timestampMs": timestampMs]
        )
      }
    }
    ARFilterProcessor.shared.onBypassed = { [weak self] in
      DispatchQueue.main.async {
        self?.sendEvent(withName: "onFilterBypassed", body: [:])
      }
    }
    guard let providerClass = NSClassFromString("ProcessorProvider") else {
      reject(
        "E_NO_PROCESSOR_PROVIDER",
        "The LiveKit fork's ProcessorProvider class was not found at runtime. " +
        "Host apps need @livekit/react-native-webrtc 144.x with video effects.",
        nil
      )
      return
    }
    let selector = NSSelectorFromString("addProcessor:forName:")
    let provider = providerClass as NSObjectProtocol
    guard provider.responds(to: selector) else {
      reject(
        "E_NO_PROCESSOR_PROVIDER",
        "ProcessorProvider does not respond to addProcessor:forName:. " +
        "Host apps need @livekit/react-native-webrtc 144.x with video effects.",
        nil
      )
      return
    }
    provider.perform(
      selector,
      with: ARFilterProcessor.shared,
      with: ARFilterProcessor.processorName
    )
    registered = true
    resolve(true)
  }

  @objc func setFilter(
    _ effectJson: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ARFilterProcessor.shared.setFilter(json: effectJson)
      resolve(true)
    } catch {
      reject("E_INVALID_FILTER", error.localizedDescription, error)
    }
  }

  @objc func clearFilter(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    ARFilterProcessor.shared.filter = nil
    resolve(true)
  }
}
