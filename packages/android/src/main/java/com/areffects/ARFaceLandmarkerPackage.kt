package com.areffects

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers the M1/M3 native modules + preview view with React Native. */
class ARFaceLandmarkerPackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> {
    // One package, both modules: the M3 filter module rides the same
    // registration path M1 already uses. Do NOT create a second
    // package class — autolinking registers packages, not modules.
    return listOf(
      ARFaceLandmarkerModule(reactContext),
      ARFilterModule(reactContext)
    )
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> {
    return listOf(ARCameraViewManager())
  }
}
