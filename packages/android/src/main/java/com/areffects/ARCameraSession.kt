package com.areffects

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Owns the camera session + MediaPipe Face Landmarker for M1 (Android).
 *
 * One session is shared by the bridge module (ARFaceLandmarker, which
 * starts/stops detection) and the preview view (ARCameraViewManager's
 * layout, which attaches a PreviewView). A second camera session (e.g.
 * expo-camera) would fight this one for the camera hardware, so
 * consumers must preview through ARCameraView, not their own camera
 * component.
 *
 * Coordinate contract (see ARCHITECTURE.md §2): landmarks are emitted
 * in raw sensor space, normalized 0..1, origin top-left, upright
 * (frames are rotated by ImageProxy rotation before inference). The
 * PreviewView mirrors the front camera while analysis frames are NOT
 * mirrored, so a consumer rendering dots over its own preview must
 * flip x -> 1 - x for the front camera. Hosts never pre-flip.
 *
 * MediaPipe's result carries no separate detection box on this path, so
 * bounds are computed from landmark extremes. Face IDs are stabilized
 * across frames by matching bounds centroids (MediaPipe exposes no
 * tracking ID in VIDEO mode).
 */
object ARCameraSession {
  var maxFps: Double = 15.0
  var maxFaces: Int = 1
  var minDetectionConfidence: Float = 0.5f
  var cameraPosition: Int = CameraSelector.LENS_FACING_FRONT

  /** Called on the analysis thread with one event per processed frame. */
  var onFrame: ((List<Map<String, Any?>>, Long) -> Unit)? = null

  private var cameraProvider: ProcessCameraProvider? = null
  private var preview: Preview? = null
  private var analysis: ImageAnalysis? = null
  private var landmarker: FaceLandmarker? = null
  private var analysisExecutor: ExecutorService? = null
  private var pendingPreviewView: PreviewView? = null
  private var lastProcessedMs: Long = 0
  private var lastTimestampMs: Long = 0
  private var faceCounter: Int = 0
  private var previousFaces: MutableList<PrevFace> = mutableListOf()
  private var started: Boolean = false

  private data class PrevFace(val id: String, val cx: Double, val cy: Double)

  fun isSupported(context: Context): Boolean {
    return android.os.Build.VERSION.SDK_INT >= 23
  }

  fun start(
    context: Context,
    lifecycleOwner: LifecycleOwner,
    onReady: () -> Unit,
    onError: (Exception) -> Unit
  ) {
    if (started) {
      onReady()
      return
    }
    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener(
      {
        try {
          val provider = providerFuture.get()
          cameraProvider = provider
          val baseOptions = BaseOptions.builder()
            .setModelAssetPath("face_landmarker.task")
            .build()
          val options = FaceLandmarker.FaceLandmarkerOptions.builder()
            .setBaseOptions(baseOptions)
            .setRunningMode(RunningMode.VIDEO)
            .setNumFaces(maxFaces)
            .setMinFaceDetectionConfidence(minDetectionConfidence)
            .setMinTrackingConfidence(0.5f)
            .setOutputFaceBlendshapes(true)
            .build()
          landmarker = FaceLandmarker.createFromOptions(context, options)

          val previewUseCase = Preview.Builder().build()
          preview = previewUseCase
          val analysisUseCase = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
          analysis = analysisUseCase
          val executor = Executors.newSingleThreadExecutor()
          analysisExecutor = executor
          analysisUseCase.setAnalyzer(executor) { imageProxy ->
            analyzeFrame(imageProxy)
          }

          val selector = CameraSelector.Builder()
            .requireLensFacing(cameraPosition)
            .build()
          provider.bindToLifecycle(lifecycleOwner, selector, previewUseCase, analysisUseCase)
          // The view may have attached before start(); bind its surface
          // provider now so the preview appears without remounting.
          pendingPreviewView?.let { previewUseCase.setSurfaceProvider(it.surfaceProvider) }
          started = true
          onReady()
        } catch (e: Exception) {
          onError(e)
        }
      },
      ContextCompat.getMainExecutor(context)
    )
  }

  fun stop() {
    try {
      cameraProvider?.unbindAll()
    } catch (_: Exception) {
      // Unbinding during teardown must not crash the app.
    }
    try {
      landmarker?.close()
    } catch (_: Exception) {
      // Same: close failures during teardown are non-fatal.
    }
    landmarker = null
    cameraProvider = null
    preview = null
    analysis = null
    analysisExecutor?.shutdown()
    analysisExecutor = null
    lastProcessedMs = 0
    lastTimestampMs = 0
    previousFaces.clear()
    faceCounter = 0
    started = false
  }

  /** Attach a PreviewView to the running session's Preview use case.
   *  If the session is not started yet, the view is remembered and
   *  bound when start() binds the use cases. */
  fun attachPreview(previewView: PreviewView) {
    pendingPreviewView = previewView
    preview?.setSurfaceProvider(previewView.surfaceProvider)
  }

  fun detachPreview() {
    pendingPreviewView = null
    preview?.setSurfaceProvider(null)
  }

  private fun analyzeFrame(imageProxy: ImageProxy) {
    try {
      val landmarker = landmarker ?: return
      val timestampMs = imageProxy.imageInfo.timestamp / 1_000_000
      // Throttle to maxFps: the camera runs faster than detection needs.
      if (timestampMs - lastProcessedMs < (1000.0 / maxFps).toLong()) {
        return
      }
      lastProcessedMs = timestampMs
      // VIDEO mode requires strictly increasing timestamps.
      val monotonicMs = maxOf(timestampMs, lastTimestampMs + 1)
      lastTimestampMs = monotonicMs

      val mediaImage = imageProxy.image ?: return
      val bitmap = yuvToBitmap(mediaImage) ?: return
      val rotation = imageProxy.imageInfo.rotationDegrees
      val upright = if (rotation == 0) {
        bitmap
      } else {
        val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
        Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
      }
      val mpImage = BitmapImageBuilder(upright).build()
      val result = landmarker.detectForVideo(mpImage, monotonicMs)

      val faces = mutableListOf<Map<String, Any?>>()
      val currentFaces = mutableListOf<PrevFace>()
      val blendshapeLists = try {
        result.faceBlendshapes().orElse(null)
      } catch (_: Exception) {
        null
      }
      for ((faceIndex, landmarks) in result.landmarks().withIndex()) {
        val points = landmarks.map { landmark ->
          mapOf(
            "x" to landmark.x().toDouble(),
            "y" to landmark.y().toDouble(),
            "z" to landmark.z().toDouble()
          )
        }
        val xs = points.mapNotNull { it["x"] }
        val ys = points.mapNotNull { it["y"] }
        val minX = xs.minOrNull() ?: continue
        val maxX = xs.maxOrNull() ?: continue
        val minY = ys.minOrNull() ?: continue
        val maxY = ys.maxOrNull() ?: continue
        val bounds = mapOf(
          "x" to minX,
          "y" to minY,
          "width" to (maxX - minX),
          "height" to (maxY - minY)
        )
        val cx = minX + (maxX - minX) / 2
        val cy = minY + (maxY - minY) / 2
        // Stabilize IDs by nearest-centroid matching (threshold 0.2 in
        // normalized space); unmatched faces get fresh IDs.
        var faceId: String? = null
        var bestDistance = 0.2
        for (previous in previousFaces) {
          val dx = previous.cx - cx
          val dy = previous.cy - cy
          val distance = kotlin.math.sqrt(dx * dx + dy * dy)
          if (distance < bestDistance) {
            bestDistance = distance
            faceId = previous.id
          }
        }
        if (faceId == null) {
          faceId = "face-$faceCounter"
          faceCounter += 1
        }
        currentFaces.add(PrevFace(faceId, cx, cy))

        val faceMap = mutableMapOf<String, Any?>(
          "faceId" to faceId,
          "landmarks" to points,
          "landmarkMap" to "mediapipe-478",
          "bounds" to bounds,
          "timestampMs" to monotonicMs.toDouble(),
          "source" to "mediapipe"
        )
        val blendshapes = blendshapeLists?.getOrNull(faceIndex)?.categories()
          ?.associate { it.categoryName() to it.score().toDouble() }
        if (!blendshapes.isNullOrEmpty()) {
          faceMap["blendshapes"] = blendshapes
        }
        faces.add(faceMap)
      }
      previousFaces = currentFaces
      onFrame?.invoke(faces, monotonicMs)
    } catch (_: Exception) {
      // A single failed frame must not kill the stream; the next frame
      // is processed normally. Errors surface via missing frames, which
      // the JS side already treats as tracking loss after a gap.
    } finally {
      imageProxy.close()
    }
  }

  /** Convert a YUV_420_888 frame to a Bitmap via an NV21 JPEG round-trip.
   *  Simple and dependency-free; at the throttled M1 frame rate this is
   *  fast enough, and a GPU path is a documented follow-up. */
  private fun yuvToBitmap(image: Image): Bitmap? {
    val width = image.width
    val height = image.height
    val nv21 = yuv420ToNv21(image)
    val yuvImage = YuvImage(nv21, ImageFormat.NV21, width, height, null)
    val stream = ByteArrayOutputStream()
    if (!yuvImage.compressToJpeg(Rect(0, 0, width, height), 90, stream)) {
      return null
    }
    val bytes = stream.toByteArray()
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
  }

  private fun yuv420ToNv21(image: Image): ByteArray {
    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]
    val ySize = yPlane.buffer.remaining()
    val nv21 = ByteArray(ySize + uPlane.buffer.remaining() + vPlane.buffer.remaining())
    yPlane.buffer.get(nv21, 0, ySize)
    // NV21 interleaves V then U at half resolution. Absolute gets keep
    // the plane buffers' positions untouched.
    val rowStride = uPlane.rowStride
    val pixelStride = uPlane.pixelStride
    var offset = ySize
    for (row in 0 until image.height / 2) {
      for (col in 0 until image.width / 2) {
        val index = row * rowStride + col * pixelStride
        nv21[offset++] = vPlane.buffer.get(index)
        nv21[offset++] = uPlane.buffer.get(index)
      }
    }
    return nv21
  }
}
