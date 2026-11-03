package com.areffects

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.oney.WebRTCModule.videoEffects.ProcessorProvider
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessorFactoryInterface

/**
 * React Native bridge module for the M3 host filter (Android).
 *
 * Thin by design, mirroring ARFaceLandmarkerModule (M1): registration
 * + promise plumbing live here, while the MediaPipe engine and the
 * compositing live in ARFilterProcessor. JS calls registerProcessor /
 * setFilter / clearFilter (see filter-bridge.ts); landmark frames
 * arrive as `onFilterFrame` events (same map shape as M1's
 * onFaceFrame) and bypass transitions as `onFilterBypassed`.
 *
 * Registration hands the fork's ProcessorProvider a factory that
 * returns the SHARED processor instance — not a fresh one per call.
 * That is deliberate: the module's filter state must reach the
 * track's processor, and the fork calls factory.build() once per
 * filtered track. It is also why only ONE filtered camera track can
 * exist at a time (same limit as iOS, same as the host-camera case).
 *
 * Fail-loud rule: if registration throws, the promise rejects. The
 * fork itself logs + silently skips unknown processor names at
 * apply time, so a silent registration failure here would surface
 * at M5 as "the filter just doesn't show up" with no error anywhere.
 */
class ARFilterModule(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ARFilter"

  init {
    ARFilterProcessor.onLandmarks = { faces, timestampMs ->
      val params = Arguments.createMap()
      params.putArray("faces", facesToWritable(faces))
      params.putDouble("timestampMs", timestampMs.toDouble())
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("onFilterFrame", params)
    }
    ARFilterProcessor.onBypassed = {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("onFilterBypassed", Arguments.createMap())
    }
  }

  @ReactMethod
  fun registerProcessor(promise: Promise) {
    try {
      ARFilterProcessor.shared.init(reactApplicationContext)
      ProcessorProvider.addProcessor(
        "ar-effects-filter",
        VideoFrameProcessorFactoryInterface { ARFilterProcessor.shared }
      )
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_REGISTER_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun setFilter(effectJson: String, promise: Promise) {
    try {
      ARFilterProcessor.shared.setFilter(effectJson)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_INVALID_FILTER", error.message, error)
    }
  }

  @ReactMethod
  fun clearFilter(promise: Promise) {
    ARFilterProcessor.shared.filterState = null
    promise.resolve(true)
  }

  private fun facesToWritable(faces: List<Map<String, Any?>>): com.facebook.react.bridge.WritableArray {
    val array = Arguments.createArray()
    for (face in faces) {
      array.pushMap(toWritableMap(face))
    }
    return array
  }

  private fun toWritableMap(map: Map<String, Any?>): com.facebook.react.bridge.WritableMap {
    val out = Arguments.createMap()
    for ((key, value) in map) {
      when (value) {
        null -> out.putNull(key)
        is String -> out.putString(key, value)
        is Double -> out.putDouble(key, value)
        is Int -> out.putInt(key, value)
        is Boolean -> out.putBoolean(key, value)
        is List<*> -> {
          @Suppress("UNCHECKED_CAST")
          val list = value as List<Map<String, Any?>>
          out.putArray(key, facesToWritable(list))
        }
        is Map<*, *> -> {
          @Suppress("UNCHECKED_CAST")
          out.putMap(key, toWritableMap(value as Map<String, Any?>))
        }
        else -> out.putString(key, value.toString())
      }
    }
    return out
  }
}
