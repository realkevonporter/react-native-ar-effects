package com.areffects

import android.content.Context
import android.widget.FrameLayout
import androidx.camera.view.PreviewView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

/**
 * Layout hosting the CameraX PreviewView. Attaching to a window binds
 * the view to the shared provider session; detaching releases it. The
 * view never opens a camera itself — the session owns the camera.
 *
 * The PreviewView mirrors the front camera (standard selfie behavior)
 * while analysis frames are raw sensor space, so front-camera overlays
 * must flip x -> 1 - x (see the example app and ARCHITECTURE.md §2).
 * Scale type is FILL_CENTER: the preview fills the view and crops
 * overflow, so M1 dot alignment assumes the camera aspect roughly
 * matches the view aspect. Precise crop-aware mapping is M2 renderer
 * work (ARCHITECTURE.md §3).
 */
class ARCameraPreviewLayout(context: Context) : FrameLayout(context) {
  private val previewView: PreviewView = PreviewView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }

  init {
    addView(previewView)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ARCameraSession.attachPreview(previewView)
  }

  override fun onDetachedFromWindow() {
    ARCameraSession.detachPreview()
    super.onDetachedFromWindow()
  }
}

/** View manager for ARCameraView. The manager name is the JS component name. */
class ARCameraViewManager : SimpleViewManager<ARCameraPreviewLayout>() {
  override fun getName(): String = "ARCameraView"

  override fun createViewInstance(reactContext: ThemedReactContext): ARCameraPreviewLayout {
    return ARCameraPreviewLayout(reactContext)
  }
}
