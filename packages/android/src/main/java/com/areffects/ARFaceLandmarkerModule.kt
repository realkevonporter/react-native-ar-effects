package com.areffects

import android.Manifest
import android.content.pm.PackageManager
import androidx.camera.core.CameraSelector
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native bridge module for the MediaPipe provider (M1).
 *
 * Thin by design: permission + promise plumbing live here, while the
 * camera session and the MediaPipe engine live in ARCameraSession.
 * JS calls start/stop/isSupported; per-frame results arrive as
 * `onFaceFrame` events with { faces: FaceFrame[], timestampMs }.
 */
class ARFaceLandmarkerModule(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ARFaceLandmarker"

  init {
    ARCameraSession.onFrame = { faces, timestampMs ->
      val params = Arguments.createMap()
      params.putArray("faces", facesToWritable(faces))
      params.putDouble("timestampMs", timestampMs.toDouble())
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("onFaceFrame", params)
    }
  }

  @ReactMethod
  fun start(config: ReadableMap, promise: Promise) {
    if (ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.CAMERA
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject(
        "E_CAMERA_PERMISSION",
        "Camera permission is not granted. Grant it to use face tracking."
      )
      return
    }
    val activity = currentActivity as? LifecycleOwner
    if (activity == null) {
      promise.reject(
        "E_NO_ACTIVITY",
        "No foreground activity to bind the camera lifecycle to."
      )
      return
    }
    ARCameraSession.maxFps =
      if (config.hasKey("maxFps")) config.getDouble("maxFps") else 15.0
    ARCameraSession.maxFaces =
      if (config.hasKey("maxFaces")) config.getInt("maxFaces") else 1
    ARCameraSession.minDetectionConfidence =
      if (config.hasKey("minDetectionConfidence")) {
        config.getDouble("minDetectionConfidence").toFloat()
      } else {
        0.5f
      }
    ARCameraSession.cameraPosition =
      if (config.hasKey("cameraPosition") &&
        config.getString("cameraPosition") == "back"
      ) {
        CameraSelector.LENS_FACING_BACK
      } else {
        CameraSelector.LENS_FACING_FRONT
      }
    ARCameraSession.start(
      reactApplicationContext,
      activity,
      onReady = { promise.resolve(true) },
      onError = { error ->
        promise.reject("E_START_FAILED", error.message, error)
      }
    )
  }

  @ReactMethod
  fun stop(promise: Promise) {
    ARCameraSession.stop()
    promise.resolve(true)
  }

  @ReactMethod
  fun isSupported(promise: Promise) {
    // MediaPipe Tasks Vision runs on every Android version this library
    // supports (minSdk 23); no per-device gating in M1.
    promise.resolve(ARCameraSession.isSupported(reactApplicationContext))
  }

  private fun facesToWritable(faces: List<Map<String, Any?>>): WritableArray {
    val array = Arguments.createArray()
    for (face in faces) {
      array.pushMap(toWritableMap(face))
    }
    return array
  }

  private fun toWritableMap(map: Map<String, Any?>): WritableMap {
    val writable = Arguments.createMap()
    for ((key, value) in map) {
      when (value) {
        null -> writable.putNull(key)
        is String -> writable.putString(key, value)
        is Double -> writable.putDouble(key, value)
        is Float -> writable.putDouble(key, value.toDouble())
        is Int -> writable.putInt(key, value)
        is Long -> writable.putDouble(key, value.toDouble())
        is Boolean -> writable.putBoolean(key, value)
        is Map<*, *> -> {
          @Suppress("UNCHECKED_CAST")
          writable.putMap(key, toWritableMap(value as Map<String, Any?>))
        }
        is List<*> -> {
          val nested = Arguments.createArray()
          for (item in value) {
            when (item) {
              null -> nested.pushNull()
              is String -> nested.pushString(item)
              is Double -> nested.pushDouble(item)
              is Float -> nested.pushDouble(item.toDouble())
              is Int -> nested.pushInt(item)
              is Long -> nested.pushDouble(item.toDouble())
              is Boolean -> nested.pushBoolean(item)
              is Map<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                nested.pushMap(toWritableMap(item as Map<String, Any?>))
              }
              else -> nested.pushNull()
            }
          }
          writable.putArray(key, nested)
        }
        else -> writable.putNull(key)
      }
    }
    return writable
  }
}
