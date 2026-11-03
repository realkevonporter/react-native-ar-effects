package com.areffects

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.RectF
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessor
import org.json.JSONObject
import org.webrtc.JavaI420Buffer
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
import org.webrtc.YuvConverter
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

/**
 * M3 host-side filter processor (Android).
 *
 * Registered with the LiveKit fork's VideoEffect registry under the
 * name "ar-effects-filter" (see ARFilterModule). The fork calls
 * process() for every camera frame and forwards the returned frame
 * to the encoder — so anything this processor draws is what ALL
 * viewers see. That is the pre-encode contract: no viewer-side
 * overlay, no second camera.
 *
 * Frame flow (mirrors the TS HostFilterPipeline + filter renderer):
 * 1. No filter, or bypassed inside cooldown -> return frame untouched.
 * 2. Texture frames are converted to I420 via YuvConverter (the
 *    fork's camera delivers texture frames; the conversion runs on
 *    the capture thread, which owns the EGL context — see
 *    ARCHITECTURE.md §M3). Conversion failure passes the frame
 *    through untouched, never crashes the stream. Other buffer
 *    types pass through unfiltered.
 * 3. Grade-only filters skip detection entirely (a grade needs no
 *    face). Anchor filters run MediaPipe on the clean bitmap and
 *    draw shapes from the first face's landmarks.
 * 4. The output is ALWAYS a freshly allocated I420 buffer — the
 *    source buffer is never mutated.
 * 5. Over-budget frames return the ORIGINAL frame and count toward
 *    bypass (8 consecutive -> 3s bypass -> probe), exactly the TS
 *    governor contract. The filter never stalls the encoder.
 *
 * Coordinate space: detection + compositing share the frame's
 * buffer space, so landmarks map to pixels directly (x * width,
 * y * height) with NO mirroring — same rule as the TS renderer.
 * Rotation is passed through on the output frame; whether landmark
 * geometry needs rotation compensation depends on how the fork's
 * capturer orients buffers, and is a first-device verification
 * point (see ARCHITECTURE.md §M3).
 *
 * Landmarks are emitted via onLandmarks (same map shape as M1's
 * onFaceFrame, single face, id "host-face") so the host app can
 * forward them over the live socket for M2 viewer anchoring at M5.
 *
 * FIRST-BUILD VERIFICATION (uncompiled in the sandbox — see
 * ARCHITECTURE.md §M3): the fork's VideoFrameProcessor import, the
 * project(':livekit-react-native-webrtc') Gradle wiring, and the
 * YuvConverter EGL behavior on the capture thread.
 */
class ARFilterProcessor : VideoFrameProcessor {

  companion object {
    /** Shared instance: module filter state must reach the track's processor. */
    val shared = ARFilterProcessor()

    var onLandmarks: ((List<Map<String, Any?>>, Long) -> Unit)? = null
    var onBypassed: (() -> Unit)? = null
  }

  // Filter state (parsed EffectDefinition subset). Volatile: set from
  // the JS thread (module), read on the capture thread (process).
  @Volatile
  var filterState: FilterState? = null

  private var appContext: Context? = null
  private var landmarker: FaceLandmarker? = null
  private var landmarkerFailed = false
  private var lastTimestampMs: Long = 0
  private var consecutiveDrops = 0
  private var bypassed = false
  private var bypassUntilNs: Long = 0
  private var yuvConverter: YuvConverter? = null

  private val budgetMs = 1000.0 / 15.0
  private val maxConsecutiveDrops = 8
  private val bypassCooldownNs = 3_000_000_000L

  data class Grade(
    val warmth: Double,
    val brightness: Double,
    val saturation: Double,
    val contrast: Double
  )

  data class Anchor(
    val placement: String,
    val landmarkIndices: List<Int>,
    val scaleToFace: Double,
    val offsetX: Double,
    val offsetY: Double
  )

  data class Shape(
    val kind: String,
    val anchor: Int,
    val rect: RectF,
    val points: List<Pair<Double, Double>>,
    val color: Int,
    val fill: Boolean,
    val lineWidth: Double
  )

  data class FilterState(
    val grade: Grade?,
    val anchors: List<Anchor>,
    val shapes: List<Shape>
  )

  /** Called by the module so detection has a Context for the model asset. */
  fun init(context: Context) {
    appContext = context.applicationContext
  }

  /** Parse the EffectDefinition JSON handed over by the JS adapter. */
  fun setFilter(effectJson: String) {
    val root = JSONObject(effectJson)
    var grade: Grade? = null
    if (root.has("grade")) {
      val g = root.getJSONObject("grade")
      grade = Grade(
        warmth = g.optDouble("warmth", 0.0),
        brightness = g.optDouble("brightness", 0.0),
        saturation = g.optDouble("saturation", 1.0),
        contrast = g.optDouble("contrast", 1.0)
      )
    }
    val anchors = mutableListOf<Anchor>()
    val anchorsJson = root.optJSONArray("anchors")
    if (anchorsJson != null) {
      for (i in 0 until anchorsJson.length()) {
        val raw = anchorsJson.getJSONObject(i)
        val indices = mutableListOf<Int>()
        val indicesJson = raw.optJSONArray("landmarkIndices")
        if (indicesJson != null) {
          for (j in 0 until indicesJson.length()) indices.add(indicesJson.getInt(j))
        }
        val offset = raw.optJSONObject("offset")
        anchors.add(
          Anchor(
            placement = raw.optString("placement", "on-face"),
            landmarkIndices = indices,
            scaleToFace = raw.optDouble("scaleToFace", 1.0),
            offsetX = offset?.optDouble("x", 0.0) ?: 0.0,
            offsetY = offset?.optDouble("y", 0.0) ?: 0.0
          )
        )
      }
    }
    val shapes = mutableListOf<Shape>()
    val shapesJson = root.optJSONArray("shapes")
    if (shapesJson != null) {
      for (i in 0 until shapesJson.length()) {
        val raw = shapesJson.getJSONObject(i)
        val rectJson = raw.optJSONObject("rect")
        val points = mutableListOf<Pair<Double, Double>>()
        val pointsJson = raw.optJSONArray("points")
        if (pointsJson != null) {
          for (j in 0 until pointsJson.length()) {
            val p = pointsJson.getJSONObject(j)
            points.add(Pair(p.optDouble("x", 0.0), p.optDouble("y", 0.0)))
          }
        }
        shapes.add(
          Shape(
            kind = raw.optString("kind", "rect"),
            anchor = raw.optInt("anchor", 0),
            rect = RectF(
              rectJson?.optDouble("x", 0.0)?.toFloat() ?: 0f,
              rectJson?.optDouble("y", 0.0)?.toFloat() ?: 0f,
              rectJson?.optDouble("width", 1.0)?.toFloat() ?: 1f,
              rectJson?.optDouble("height", 1.0)?.toFloat() ?: 1f
            ),
            points = points,
            // Throws on malformed colors: bad data fails at setFilter
            // time, not mid-frame.
            color = Color.parseColor(raw.optString("color", "#ffffff")),
            fill = raw.optBoolean("fill", false),
            lineWidth = raw.optDouble("lineWidth", 0.008)
          )
        )
      }
    }
    filterState = FilterState(grade, anchors, shapes)
  }

  override fun process(
    frame: VideoFrame,
    textureHelper: SurfaceTextureHelper
  ): VideoFrame {
    val state = filterState ?: return frame
    val nowNs = System.nanoTime()
    if (bypassed && nowNs < bypassUntilNs) return frame
    val startNs = System.nanoTime()

    // Normalize to I420. Texture frames (the camera norm) go through
    // YuvConverter; I420 frames go straight to the CPU path. Anything
    // else passes through unfiltered.
    val i420: VideoFrame.I420Buffer
    var converted: VideoFrame.I420Buffer? = null
    try {
      val buffer = frame.buffer
      i420 = when (buffer) {
        is VideoFrame.I420Buffer -> buffer
        is VideoFrame.TextureBuffer -> {
          if (yuvConverter == null) yuvConverter = YuvConverter()
          val out = yuvConverter!!.convert(buffer)
          converted = out
          out
        }
        else -> return frame
      }
    } catch (_: Exception) {
      // Conversion failure must not kill the stream.
      return frame
    }

    val width = i420.width
    val height = i420.height
    val argb = i420ToArgb(i420)
    converted?.release()

    // Detection: only when shapes need a face; grade-only skips it.
    var landmarks: List<Pair<Double, Double>> = emptyList()
    var bounds: RectF? = null
    if (state.shapes.isNotEmpty() && !landmarkerFailed) {
      val detected = detectFirstFace(argb, width, height, frame.timestampNs)
      if (detected != null) {
        landmarks = detected.first
        bounds = detected.second
      }
    }

    val bitmap = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    if (state.grade != null) {
      val paint = Paint()
      paint.colorFilter = ColorMatrixColorFilter(buildGradeMatrix(state.grade))
      canvas.drawBitmap(bitmap, 0f, 0f, paint)
    }
    if (state.shapes.isNotEmpty() && bounds != null) {
      drawShapes(canvas, state, landmarks, bounds, width, height)
    }

    val outBuffer = argbToI420(bitmap, width, height)
    val durationMs = (System.nanoTime() - startNs) / 1_000_000.0
    if (durationMs > budgetMs) {
      consecutiveDrops += 1
      if (consecutiveDrops >= maxConsecutiveDrops) {
        bypassed = true
        bypassUntilNs = System.nanoTime() + bypassCooldownNs
        onBypassed?.invoke()
      }
      outBuffer.release()
      return frame
    }
    consecutiveDrops = 0
    bypassed = false

    if (bounds != null) {
      val points = landmarks.map { (x, y) ->
        mapOf("x" to x, "y" to y, "z" to 0.0)
      }
      val face = mapOf<String, Any?>(
        "faceId" to "host-face",
        "landmarks" to points,
        "landmarkMap" to "mediapipe-478",
        "bounds" to mapOf(
          "x" to bounds.left.toDouble(),
          "y" to bounds.top.toDouble(),
          "width" to bounds.width().toDouble(),
          "height" to bounds.height().toDouble()
        ),
        "timestampMs" to (frame.timestampNs / 1_000_000).toDouble(),
        "source" to "mediapipe"
      )
      onLandmarks?.invoke(listOf(face), frame.timestampNs / 1_000_000)
    }

    // The fork releases the returned frame; a fresh buffer is correct.
    return VideoFrame(outBuffer, frame.rotation, frame.timestampNs)
  }

  // MARK: - Detection (same engine + options pattern as M1)

  private fun ensureLandmarker(): FaceLandmarker? {
    if (landmarker != null || landmarkerFailed) return landmarker
    val context = appContext ?: return null
    return try {
      val baseOptions = BaseOptions.builder()
        .setModelAssetPath("face_landmarker.task")
        .build()
      val options = FaceLandmarker.FaceLandmarkerOptions.builder()
        .setBaseOptions(baseOptions)
        .setRunningMode(RunningMode.VIDEO)
        .setNumFaces(1)
        .setMinFaceDetectionConfidence(0.5f)
        .setMinTrackingConfidence(0.5f)
        // Blendshapes are not needed for filters; skipping saves compute.
        .setOutputFaceBlendshapes(false)
        .build()
      val created = FaceLandmarker.createFromOptions(context, options)
      landmarker = created
      created
    } catch (_: Exception) {
      // Detection failure must not kill the stream: grade still
      // applies, shapes are omitted.
      landmarkerFailed = true
      null
    }
  }

  private fun detectFirstFace(
    argb: IntArray,
    width: Int,
    height: Int,
    timestampNs: Long
  ): Pair<List<Pair<Double, Double>>, RectF>? {
    val landmarker = ensureLandmarker() ?: return null
    // VIDEO mode requires strictly increasing timestamps (M1 rule).
    val timestampMs = max(timestampNs / 1_000_000, lastTimestampMs + 1)
    lastTimestampMs = timestampMs
    return try {
      val bitmap = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888)
      val mpImage = BitmapImageBuilder(bitmap).build()
      val result = landmarker.detectForVideo(mpImage, timestampMs)
      val first = result.landmarks().firstOrNull() ?: return null
      val points = first.map { Pair(it.x().toDouble(), it.y().toDouble()) }
      val xs = points.map { it.first }
      val ys = points.map { it.second }
      val minX = xs.minOrNull() ?: return null
      val maxX = xs.maxOrNull() ?: return null
      val minY = ys.minOrNull() ?: return null
      val maxY = ys.maxOrNull() ?: return null
      Pair(points, RectF(minX.toFloat(), minY.toFloat(), maxX.toFloat(), maxY.toFloat()))
    } catch (_: Exception) {
      null
    }
  }

  // MARK: - Grade matrix (same formula as the TS renderer, one matrix)

  /**
   * Composes warmth -> saturation (Rec. 601) -> contrast -> brightness
   * into a single 4x5 ColorMatrix, so the native grade matches the TS
   * reference (applyGradeToRgb) exactly. Matrices are multiplied
   * manually to keep the order unambiguous.
   */
  internal fun buildGradeMatrix(grade: Grade): ColorMatrix {
    val w = grade.warmth
    val warmth = floatArrayOf(
      (1 + 0.2 * w).toFloat(), 0f, 0f, 0f, 0f,
      0f, 1f, 0f, 0f, 0f,
      0f, 0f, (1 - 0.2 * w).toFloat(), 0f, 0f,
      0f, 0f, 0f, 1f, 0f
    )
    val s = grade.saturation.toFloat()
    val inv = 1f - s
    val saturation = floatArrayOf(
      s + inv * 0.299f, inv * 0.587f, inv * 0.114f, 0f, 0f,
      inv * 0.299f, s + inv * 0.587f, inv * 0.114f, 0f, 0f,
      inv * 0.299f, inv * 0.587f, s + inv * 0.114f, 0f, 0f,
      0f, 0f, 0f, 1f, 0f
    )
    val c = grade.contrast.toFloat()
    val t = 0.5f - 0.5f * c
    val contrast = floatArrayOf(
      c, 0f, 0f, 0f, t,
      0f, c, 0f, 0f, t,
      0f, 0f, c, 0f, t,
      0f, 0f, 0f, 1f, 0f
    )
    val br = grade.brightness.toFloat()
    val brightness = floatArrayOf(
      1f, 0f, 0f, 0f, br,
      0f, 1f, 0f, 0f, br,
      0f, 0f, 1f, 0f, br,
      0f, 0f, 0f, 1f, 0f
    )
    // Apply warmth first, then saturation, contrast, brightness:
    // total = brightness * contrast * saturation * warmth.
    val composed = multiply4x5(
      brightness,
      multiply4x5(contrast, multiply4x5(saturation, warmth))
    )
    return ColorMatrix(composed)
  }

  /** 4x5 matrix multiply: result = a * b (b applied first). */
  private fun multiply4x5(a: FloatArray, b: FloatArray): FloatArray {
    val out = FloatArray(20)
    for (row in 0 until 4) {
      for (col in 0 until 4) {
        var sum = 0f
        for (k in 0 until 4) sum += a[row * 5 + k] * b[k * 5 + col]
        out[row * 5 + col] = sum
      }
      var sum = a[row * 5 + 4]
      for (k in 0 until 4) sum += a[row * 5 + k] * b[k * 5 + 4]
      out[row * 5 + 4] = sum
    }
    return out
  }

  // MARK: - Shapes (same geometry as the TS renderer)

  private fun anchorRect(
    anchor: Anchor,
    landmarks: List<Pair<Double, Double>>,
    bounds: RectF
  ): RectF {
    if (anchor.placement == "fullscreen") {
      return RectF(0f, 0f, 1f, 1f)
    }
    val faceWidth = bounds.width().toDouble()
    val width = anchor.scaleToFace * bounds.width().toDouble()
    val height = anchor.scaleToFace * bounds.height().toDouble()
    val point: Pair<Double, Double>
    if (anchor.placement == "above-head") {
      point = Pair(
        bounds.left.toDouble() + bounds.width().toDouble() / 2,
        bounds.top.toDouble()
      )
    } else {
      var sumX = 0.0
      var sumY = 0.0
      var count = 0
      for (index in anchor.landmarkIndices) {
        if (index < landmarks.size) {
          sumX += landmarks[index].first
          sumY += landmarks[index].second
          count += 1
        }
      }
      point = if (count > 0) {
        Pair(sumX / count, sumY / count)
      } else {
        Pair(
          bounds.left.toDouble() + bounds.width().toDouble() / 2,
          bounds.top.toDouble() + bounds.height().toDouble() / 2
        )
      }
    }
    val offsetX = anchor.offsetX * faceWidth
    val offsetY = anchor.offsetY * faceWidth
    val left = point.first - width / 2 + offsetX
    val top = if (anchor.placement == "above-head") {
      point.second - height + offsetY
    } else {
      point.second - height / 2 + offsetY
    }
    return RectF(left.toFloat(), top.toFloat(), (left + width).toFloat(), (top + height).toFloat())
  }

  private fun drawShapes(
    canvas: Canvas,
    state: FilterState,
    landmarks: List<Pair<Double, Double>>,
    bounds: RectF,
    width: Int,
    height: Int
  ) {
    for (shape in state.shapes) {
      if (shape.anchor >= state.anchors.size) continue
      val anchor = state.anchors[shape.anchor]
      val rect = anchorRect(anchor, landmarks, bounds)
      val absLeft = rect.left + shape.rect.left * rect.width()
      val absTop = rect.top + shape.rect.top * rect.height()
      val absRight = absLeft + shape.rect.width() * rect.width()
      val absBottom = absTop + shape.rect.height() * rect.height()
      val paint = Paint()
      paint.color = shape.color
      paint.isAntiAlias = true
      paint.style = if (shape.fill) Paint.Style.FILL else Paint.Style.STROKE
      paint.strokeWidth = (shape.lineWidth * width).toFloat()
      val px = RectF(
        absLeft * width, absTop * height,
        absRight * width, absBottom * height
      )
      when (shape.kind) {
        "ellipse" -> canvas.drawOval(px, paint)
        "rect" -> canvas.drawRect(px, paint)
        "line", "polyline" -> {
          val pts = shape.points.map { (fx, fy) ->
            Pair(
              (rect.left + fx * rect.width()) * width,
              (rect.top + fy * rect.height()) * height
            )
          }
          if (pts.size < 2) continue
          for (i in 0 until pts.size - 1) {
            canvas.drawLine(
              pts[i].first.toFloat(), pts[i].second.toFloat(),
              pts[i + 1].first.toFloat(), pts[i + 1].second.toFloat(),
              paint
            )
          }
        }
        else -> continue
      }
    }
  }

  // MARK: - YUV <-> ARGB (BT.601 limited range, as in M1's converter)

  private fun i420ToArgb(i420: VideoFrame.I420Buffer): IntArray {
    val width = i420.width
    val height = i420.height
    val yBuffer = i420.dataY
    val uBuffer = i420.dataU
    val vBuffer = i420.dataV
    val strideY = i420.strideY
    val strideU = i420.strideU
    val strideV = i420.strideV
    val out = IntArray(width * height)
    for (y in 0 until height) {
      for (x in 0 until width) {
        val yIndex = y * strideY + x
        val uvIndex = (y / 2) * strideU + (x / 2)
        val uvIndexV = (y / 2) * strideV + (x / 2)
        val yy = (yBuffer.get(yIndex).toInt() and 0xFF) - 16
        val uu = (uBuffer.get(uvIndex).toInt() and 0xFF) - 128
        val vv = (vBuffer.get(uvIndexV).toInt() and 0xFF) - 128
        var r = (298 * yy + 409 * vv + 128) shr 8
        var g = (298 * yy - 100 * uu - 208 * vv + 128) shr 8
        var b = (298 * yy + 516 * uu + 128) shr 8
        r = min(255, max(0, r))
        g = min(255, max(0, g))
        b = min(255, max(0, b))
        out[y * width + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
      }
    }
    return out
  }

  private fun argbToI420(bitmap: Bitmap, width: Int, height: Int): JavaI420Buffer {
    val argb = IntArray(width * height)
    bitmap.getPixels(argb, 0, width, 0, 0, width, height)
    val out = JavaI420Buffer.allocate(width, height)
    val yBuffer = out.dataY
    val uBuffer = out.dataU
    val vBuffer = out.dataV
    for (y in 0 until height) {
      for (x in 0 until width) {
        val pixel = argb[y * width + x]
        val r = (pixel shr 16) and 0xFF
        val g = (pixel shr 8) and 0xFF
        val b = pixel and 0xFF
        val yy = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
        yBuffer.put(y * out.strideY + x, min(255, max(0, yy)).toByte())
      }
    }
    // 2x2-averaged chroma.
    for (y in 0 until height / 2) {
      for (x in 0 until width / 2) {
        var sumR = 0
        var sumG = 0
        var sumB = 0
        for (dy in 0 until 2) {
          for (dx in 0 until 2) {
            val pixel = argb[(2 * y + dy) * width + (2 * x + dx)]
            sumR += (pixel shr 16) and 0xFF
            sumG += (pixel shr 8) and 0xFF
            sumB += pixel and 0xFF
          }
        }
        val r = sumR / 4
        val g = sumG / 4
        val b = sumB / 4
        val uu = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
        val vv = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
        uBuffer.put(y * out.strideU + x, min(255, max(0, uu)).toByte())
        vBuffer.put(y * out.strideV + x, min(255, max(0, vv)).toByte())
      }
    }
    return out
  }
}
