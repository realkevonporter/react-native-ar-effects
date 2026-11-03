# Architecture

`react-native-ar-effects` is a face-tracking + AR-effects SDK for React Native
live video. It answers one question: how does a host's face, tracked on the
host's phone, turn into (a) gift overlays pinned to that face on every
viewer's screen, and (b) filters baked into the host's outgoing video so
every viewer sees them?

The architecture has five layers. Each layer is replaceable; the interfaces
between them are the contract.

```
Camera frames
  └─► [1] Detection providers ──► landmarks (normalized)
        ├─► [2] Landmark stream ──► live socket ──► [3] Viewer overlay renderer (gifts)
        └─► [4] Pre-encode compositor ──► filter baked into outgoing video (filters)
  [5] Effects format — filters and gifts defined as data, not code
```

## 1. Detection providers

Face detection is a solved problem in the open. We do not write our own
detector. We wrap existing engines behind one interface and let the app
pick (or auto-pick) at runtime.

### Providers

| Provider | Role | Notes |
|---|---|---|
| **MediaPipe Face Landmarker** | **Primary** | Google, Apache 2.0, on-device. 478 3D face landmarks + 52 blendshape scores (facial expressions) + transformation matrices. iOS, Android, Web. This is the default wherever it runs. |
| **Google ML Kit face detection** | Fallback | Free Google SDK. Face bounds, landmarks (eyes, ears, nose, cheeks, mouth), contours, and classifications (smiling probability, eyes open). Simpler and lighter than MediaPipe; fewer points. Used when MediaPipe is unavailable or too heavy for the device. |
| **Apple Vision** | iOS native | Built into iOS (`VNDetectFaceLandmarksRequest`). No extra dependency, no download. Used on iOS when the app prefers a zero-dependency path. |

All providers output the same shape: normalized landmarks, bounds, and a
stable tracking ID per face, so the layers above never care which engine
produced the points.

### Provider interface (TypeScript)

```ts
interface DetectionProvider {
  /** Engine identifier: 'mediapipe' | 'mlkit' | 'vision'. */
  readonly name: DetectionProviderKind;

  /** True when this provider can run on the current device/OS. */
  isSupported(): Promise<boolean>;

  /** Start emitting frames. Resolves when the camera + engine are ready. */
  start(config?: FaceTrackingConfig): Promise<void>;

  /** Stop emitting frames and release the engine. */
  stop(): Promise<void>;

  /**
   * Subscribe to per-frame results. Returns an unsubscribe function.
   * Callbacks fire on every processed camera frame (throttled to the
   * configured frame rate, not the camera's full rate).
   */
  onFrame(callback: (frame: FaceFrame) => void): () => void;
}
```

### Per-frame output

```ts
interface NormalizedPoint {
  /** 0..1 across the frame width. */
  x: number;
  /** 0..1 down the frame height. */
  y: number;
  /** 0..1 depth estimate where the provider supplies one (MediaPipe). */
  z?: number;
}

interface FaceBounds {
  /** Normalized top-left corner + size, same 0..1 space as landmarks. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FaceFrame {
  /** Stable ID for one tracked face across frames (provider-assigned). */
  faceId: string;
  /** Landmarks in normalized 0..1 coordinates (see §2 for the space). */
  landmarks: NormalizedPoint[];
  /** Landmark ordering follows the provider's documented map; MediaPipe's
      478-point map is the canonical ordering when it is the provider. */
  landmarkMap: 'mediapipe-478' | 'mlkit' | 'vision';
  /** Blendshape scores (MediaPipe only): e.g. { mouthSmileLeft: 0.8 }. */
  blendshapes?: Record<string, number>;
  /** Face bounding box, normalized. */
  bounds: FaceBounds;
  /** Camera frame timestamp, milliseconds since an arbitrary epoch shared
      with the video pipeline (used to align overlays to frames). */
  timestampMs: number;
  /** Which engine produced this frame. */
  source: DetectionProviderKind;
}
```

## 2. Landmark stream format (host → viewers over the live socket)

Face-following gifts do **not** need the gift baked into the video. The
host's phone detects the face, sends a small landmark payload over the
live socket, and every viewer's phone renders the gift overlay pinned to
those coordinates on top of the video. This is the M2 path, and it is the
easier half of the system: no camera-pipeline surgery, just coordinates
plus an overlay.

### JSON shape

```jsonc
{
  "type": "face.landmarks",
  "faceId": "face-1",
  // Landmark SUBSET, not the full 478 points: only the anchors the active
  // effects need (see §5). Keeps every socket message small.
  "landmarks": [
    { "index": 1, "x": 0.512, "y": 0.381 },
    { "index": 33, "x": 0.441, "y": 0.402 },
    { "index": 263, "x": 0.583, "y": 0.402 }
  ],
  "bounds": { "x": 0.31, "y": 0.18, "width": 0.38, "height": 0.44 },
  "timestampMs": 1730000000123,
  // Coordinate space contract — every consumer must honor this:
  "coordinateSpace": "normalized-top-left",
  // Front-camera mirroring rule (see below). Viewers apply it; hosts do not.
  "mirrored": true,
  // Which landmark map the indices refer to.
  "landmarkMap": "mediapipe-478"
}
```

### Rules

- **Normalized 0..1, origin top-left.** Coordinates are fractions of the
  frame, never pixels, so viewers on any screen size or video resolution
  pin to the same place.
- **Front-camera mirroring.** When the host uses the front camera, the
  video the viewers see is mirrored relative to the host's sensor. The
  host sends `mirrored: true` and raw sensor-space coordinates; **viewers**
  flip `x → 1 - x` before rendering. Hosts never pre-flip. (If the
  pipeline already un-mirrors the video, the host sends `mirrored: false`.)
- **Subset, not full mesh.** The host sends only the landmark indices the
  currently active effects anchor to (typically < 20 points). Full-mesh
  streaming is wasteful on a live socket and is never the default.
- **Timestamp alignment.** `timestampMs` comes from the same clock as the
  video frames. Viewers hold the latest landmark payload and render the
  overlay at the face's last known position; they do not interpolate
  between payloads (head motion at socket rates looks fine; interpolation
  adds lag).
- **Tracking loss is explicit.** When the provider loses the face, the host
  sends `{ "type": "face.lost", "faceId": "...", "timestampMs": ... }`.
  Viewers then fall back per §3 instead of freezing a stale overlay.

## 3. Overlay renderer (viewer-side)

Viewers render gift overlays with **Skia and/or Reanimated** (the standard
React Native renderers for this kind of work), pinned to the streamed
anchors:

- Each active gift effect declares its anchor landmark indices (§5). The
  renderer converts the streamed normalized points to the on-screen video
  rect (accounting for the video's aspect-fit/crop) and positions the
  effect's asset there every frame.
- The renderer runs on the UI thread (Reanimated worklets / Skia draw
  calls), not through React state per frame — socket-rate React renders
  would jank.
- **Fallback when tracking is lost.** On `face.lost`, or when no landmark
  payload has arrived for > 1.5s, the overlay detaches from the face and
  falls back to the gift system's existing display modes: the banner lane
  for small gifts, the full stage for large ones. A gift never freezes
  mid-air on a stale face position, and never vanishes without a fallback.
- Viewer-side overlays are for **gifts**. They are the wrong tool for
  **filters** (§4): a filter rendered only on each viewer's phone would
  drift against the video whenever landmarks lag frames. Filters go
  pre-encode.

## 4. Pre-encode filter compositing (host-side) — the hard phase

A filter must be visible to **all** viewers, in sync with the video, on
every device. The only correct way is to composite it into the host's
video **before encoding**: camera frame → detection → filter render →
encoder → network. A filter the host alone sees (preview-only) is fake and
is explicitly out of scope.

> **Correction (M3 spike — the plan above changed).** The original
> plan called for a custom camera capturer bridged into LiveKit's
> WebRTC fork. The M3 spike proved the fork ALREADY ships the bridge:
> a `VideoEffect` processor registry that routes camera frames
> capturer → processor → encoder inside WebRTC. M3 therefore builds
> a processor, not a capturer — no custom capturer, no LiveKit client
> changes, no frame-injection API needed. The list below is kept for
> history with the superseded items struck through in prose; the M3
> spike record (below, after the M2 record) carries the evidence.

### Why this is the hard phase

React Native live apps do not normally own the camera-to-encoder path.
LiveKit React Native publishes camera frames through its own native
capturer, built on LiveKit's WebRTC fork. To composite before encode, we
must:

1. **Register a filter processor with the fork's VideoEffect registry**
   (Swift on iOS, Kotlin on Android) — the fork routes the host's
   camera frames through it before the encoder. (Supersedes the
   original "custom camera capturer" plan; see the M3 spike record.)
2. **Bridge it into LiveKit's WebRTC fork** — the processor must speak
   the fork's frame format and lifecycle, and survive LiveKit's track
   publish/unpublish, mute, and reconnection paths. The adapter
   (`livekit-adapter.ts`) owns the JS side of this bridge.
3. **Ship it as an Expo config plugin** so host apps (Expo-based, like the
   ones this SDK is built for) get the native code wired into their builds
   without hand-editing Xcode/Gradle projects. (M3 needs NO plugin
   change: the camera permission the filter needs is already covered
   by M1's plugin; autolinking wires the new module. See the M3
   implementation record.)
4. **Render filters on the frame** (native compositing on iOS and
   Android — NOT React Native Skia; see the M3 spike record for why
   Skia lost) at camera frame rate, without dropping the encode pipeline
   below real-time. The performance contract (§M3 below) is: over-budget
   frames pass through unfiltered, never block the encoder; persistent
   slowness bypasses the filter entirely until a probe recovers.
5. **Keep audio untouched.** The compositor touches video frames only;
   the audio track flows through LiveKit unchanged.

This is M3, not M1, for a reason: M1/M2 (detection + viewer gift anchors)
deliver real value without it, and M3's fork bridge is the piece most
likely to break across LiveKit/React Native upgrades. It gets its own
milestone, its own example app, and its own device-testing pass.

### Filter pipeline (host)

```
WebRTC camera (fork's capturer — NOT ours)
  → VideoEffect processor (M3: detection + filter render, pre-encode)
  → Encoder (LiveKit WebRTC fork) → viewers
```

The filter renderer consumes the same `FaceFrame` shape as §1 and the
same effects format as §5 — the only difference from viewer overlays is
*where* the pixels land (into the encoded frame, not on top of the video
element).

## 5. Effects format — effects are data, not code

A filter or a gift effect is a **data file**, not a code change. Shipping
a new lion, a new funny face, or a new whale means shipping a new effect
definition, not a new SDK release.

```ts
interface EffectAsset {
  /** Lottie JSON, SVGA, image sequence, or video-with-alpha. */
  uri: string;
  /** Asset kind determines the renderer. */
  kind: 'lottie' | 'svga' | 'image' | 'video-alpha';
  /** Intrinsic size of the asset (used for scaling to the anchor). */
  width: number;
  height: number;
}

interface EffectAnchor {
  /** Landmark indices this effect pins to (MediaPipe-478 numbering). */
  landmarkIndices: number[];
  /** How the asset sits on the anchors: e.g. 'above-head', 'on-face',
      'follow' (track the anchor centroid), 'orbit' (circle the face). */
  placement: 'above-head' | 'on-face' | 'follow' | 'orbit' | 'fullscreen';
  /** Scale relative to face bounds width (1.0 = as wide as the face). */
  scaleToFace: number;
  /** Offset in face-width units, applied after anchoring. */
  offset?: { x: number; y: number };
}

interface EffectDefinition {
  id: string; // e.g. 'golden-lion', 'dog-ears'
  kind: 'filter' | 'gift';
  name: string;
  /** Where this effect renders: viewer overlay (gifts) or pre-encode (filters). */
  renderPath: 'viewer-overlay' | 'pre-encode';
  anchors: EffectAnchor[];
  assets: EffectAsset[];
  /** Loop, one-shot, or timed (ms). Gift effects are usually one-shot. */
  animation: { mode: 'loop' | 'once' | 'timed'; durationMs?: number };
  /** Optional sound, played on the viewing device for gifts, or on the
      host device preview for filters. Never baked into the encoded video. */
  soundUri?: string;
  /** What to do when face tracking is lost (gifts): 'banner' | 'stage' | 'hide'. */
  trackingLostFallback: 'banner' | 'stage' | 'hide';
}
```

Effect assets themselves (the lion artwork, the whale animation) are
animator work or licensed assets — the SDK plays them, it does not draw
them. The starter catalogue (M4) ships a small set of data-defined effects
to prove the format; the community can add more without touching SDK code.

**M3 extension (filters only).** `EffectDefinition` gains two optional
fields (see `packages/src/types.ts`): `shapes?: FilterShapeDef[]`
(vector shapes — ellipse / rect / line / polyline — drawn by the
pre-encode compositor, positioned by anchor rects) and
`grade?: FilterGradeParams` (full-frame color grade: warmth [-1, 1],
brightness, saturation and contrast multipliers). Both are data, like
everything else in an effect. Grade applies with or without a face;
shapes need a tracked face. Filters are still `renderPath:
"pre-encode"`, `kind: "filter"`, with `animation: { mode: "loop" }`
(they persist while active, unlike one-shot gifts).

## M1 spike record — provider decision

M1 implements exactly one provider: **MediaPipe Face Landmarker via
custom native modules** (Swift on iOS, Kotlin on Android), CPU
delegate, VIDEO running mode, bundled `face_landmarker.task` model.
This section records why, and what was rejected, so a later milestone
does not relitigate it without new evidence.

### Why MediaPipe

- **One API + one model across iOS and Android.** The same Tasks
  Vision API shape and the same `.task` file serve both platforms, so
  the provider interface stays honest: one implementation, two
  platforms, identical output.
- **License matches the repo.** MediaPipe itself is Apache 2.0, and
  the `face_landmarker.task` model ships under the same terms. Nothing
  in M1's detection path introduces a non-Apache license.
- **Dense mesh + blendshapes serve both halves.** The 478-point mesh
  and 52 blendshape scores anchor gifts today and can drive face masks
  in M3. A sparse-point engine would force a second detector for
  filters later.
- **Native, not web.** The native Tasks libraries (CocoaPods
  `MediaPipeTasksVision`, Maven `com.google.mediapipe:tasks-vision`)
  run on-device with no JS runtime dependency.

### What was rejected for M1

- **Google ML Kit face detection** — free SDK, but under Google's own
  terms, not Apache 2.0 (license distinction, recorded here). It also
  returns sparse landmarks/contours only, no dense mesh, so it cannot
  carry M3 filters. Kept as a future fallback for low-end devices
  where MediaPipe is too heavy.
- **Apple Vision** (`VNDetectFaceLandmarksRequest`) — excellent and
  zero-dependency, but iOS-only. M1 needs one cross-platform provider;
  a Vision primary would force a second Android provider in the same
  milestone. Kept as a future iOS zero-dependency option.
- **MediaPipe JS/WASM in React Native** — rejected outright. The
  `@mediapipe/tasks-vision` JS build is web-targeted: it needs
  WebAssembly and DOM-adjacent APIs that Hermes does not provide.
  There is no credible WASM-in-Hermes path for this; the native Tasks
  libraries are the only viable React Native route.

### Camera ownership (M1 design decision)

The §1 interface says `start()` resolves "when the camera + engine
are ready" — the provider owns the camera session. That is deliberate:
camera hardware is exclusive, so a second preview camera (e.g.
expo-camera) would fight the provider's session. The SDK therefore
exposes `ARCameraView`, a native preview view bound to the shared
provider session, and the example app previews through it. The native
session runs portrait-oriented; the preview layer mirrors the front
camera while sensor frames are not mirrored, so front-camera
consumers flip x -> 1 - x — the same rule §2 assigns to viewers.

### Config plugin (M1)

The library ships a minimal Expo config plugin that adds ONLY the
camera permission (NSCameraUsageDescription + Android CAMERA). No
native-dep wiring is needed from a plugin: autolinking picks up the
podspec (iOS) and the Gradle module (Android). If a future provider
needs plist/entitlement/gradle changes, the plugin grows then.

### Interface changes in M1

- `FaceTrackingConfig.cameraPosition` (`'front' | 'back'`) — the app
  picks the camera through the provider, since the provider owns the
  session.
- `DetectionProvider.onFaceLost` — fires when a tracked face stops
  appearing, mirroring the `face.lost` socket payload. Native face IDs
  are stabilized by bounds-centroid matching (MediaPipe exposes no
  tracking ID in VIDEO mode); the JS wrapper diffs ID sets.

### Version pins and model vendoring

- iOS: `MediaPipeTasksVision ~> 0.10.14` (CocoaPods existence
  confirmed via trunk). Android: `com.google.mediapipe:tasks-vision`
  0.10.14 (same release line; Gradle resolution is confirmed at first
  build — the sandbox cannot reach Maven Central reliably).
  CameraX 1.3.4 (core/camera2/lifecycle/view).
- `face_landmarker.task` (float16/1, 3,758,596 bytes, sha256
  `64184e22…0bc9ff`) is vendored twice — iOS pod resource and Android
  asset — because the two build systems consume resources differently.
  The model is loaded from the bundle/assets, never from the network
  at runtime.

## M2 implementation record — viewer-side gift anchoring

M2 implements the viewer half of the face-following gift: a host app
feeds spec-§2 payload JSON into a consumer, and an overlay component
pins a gift effect to the tracked anchor. The SDK stays
transport-agnostic — it never imports a socket library or Tokrah code.
The host app owns the socket and calls `consumer.handlePayload`
(or `onFaceLost`) with whatever arrives.

### Stream consumer (`landmark-stream.ts`, `anchor-tracker.ts`)

- `LandmarkStreamConsumer` keeps one `AnchorTracker` per faceId and
  exposes `getFaceState`, `getPrimaryFaceState`, `getAllFaceStates`,
  `setPrimaryFace`, plus `onUpdate` / `onFaceLost` subscriptions.
- Primary rule: an explicitly set primary stays selected even when
  lost, so the gift shows that face's fallback instead of jumping to a
  different face. Auto mode picks the first tracked face in arrival
  order, falling back to the first known face when none is tracked.
- `payloadFromFrame` builds a subset payload from a full `FaceFrame`
  (host-side helper for M5 wiring): only the requested indices, never
  fabricated points, with bounds / timestamp / faceId / map / mirrored
  preserved.
- Loss detection uses the VIEWER clock (`lastSeenMs` vs `Date.now`),
  never the host `timestampMs` — the two clocks are not synchronized.

### Smoothing (EMA, tunable)

Raw landmarks jitter frame to frame; a gift pinned to raw points looks
broken. Each tracker applies an exponential moving average,
`smoothed = previous + alpha * (raw - previous)`, per landmark index
and per bounds field. Default `alpha = 0.35`, configurable via
`AnchorTrackerConfig.smoothingAlpha` (must be in (0, 1]).
- Snap, don't glide: the first payload for a face snaps exactly, and a
  payload arriving after a loss or a gap snaps too — gliding from a
  stale position looks worse than a jump.
- Only the latest payload's indices are kept (`latestIndices`):
  anchor resolution trusts only indices present in the most recent
  payload, never a stale point from an older one.
- This is jitter filtering, not interpolation: the overlay renders the
  latest smoothed state; it never invents positions between payloads
  (spec §2's no-interpolation rule stands).

### Coordinate mapping (`coordinate-mapping.ts`)

Pipeline: sensor point (normalized 0..1, origin top-left) -> mirror
(if the payload says `mirrored: true`, `x -> 1 - x`) -> displayed
video rect -> view pixels. Mirroring happens BEFORE rect mapping, per
spec §2 (hosts send raw sensor coords; viewers flip).
- `cover`: `s = max(vw/videow, vh/videoh)` (video crops to fill).
- `contain`: `s = min(vw/videow, vh/videoh)` (video letterboxes).
- Offsets center the video: `ox = (vw - videow*s)/2`,
  `oy = (vh - videoh*s)/2`; `viewX = ox + x*videow*s`,
  `viewY = oy + y*videoh*s`. Non-positive sizes throw `RangeError`.
- Anchor resolution: `above-head` -> top-center of bounds;
  `on-face` / `follow` -> centroid of the requested indices present in
  `latestIndices`, else bounds center; `orbit` -> bounds center (the
  circular offset is applied at render); `fullscreen` -> null.
- Asset rect: width = `scaleToFace * faceWidthPx`, height follows the
  asset's intrinsic aspect (invalid asset size falls back to square);
  offset in face-width units, y positive DOWN; `above-head` pins the
  asset's bottom edge to the anchor, everything else centers on it;
  `fullscreen` fills the view.

### Fallback rule (default 1500ms)

A gift falls back to banner/stage display instead of vanishing or
freezing mid-screen when: an explicit `face.lost` payload arrives, OR
no landmark payload has arrived for that face for more than
`lostAfterMs` (default **1500ms**, spec §3, configurable). The mode
comes from the effect's `trackingLostFallback`: `banner` (bottom bar),
`stage` (centered at 50% of the smaller view dimension), or `hide`.
The overlay's `onFallback` fires only on tracked -> fallback
transitions, never on initial mount in fallback. Re-anchoring is
automatic when the face returns.

### Overlay (`AnchoredGiftOverlay.tsx`)

Position and size live in Reanimated shared values, updated from the
stream subscription — per-frame updates never touch React state
(spec §3). React state is used only for tracked/fallback transitions.
- M2 uses the effect's FIRST anchor; multi-anchor effects land later.
  An effect with no anchors renders nothing.
- Asset rendering: `image` assets render via RN `Image`; other kinds
  (lottie / svga / video-alpha) render a name pill until their player
  deps land — data-defined effects stay visible before artwork does.
- Sound (`soundUri`) is NOT played in M2: audio policy belongs to the
  app's gift system, not the overlay. Wiring lands with integration.
- `orbit` adds a derived circular offset (radius 0.75x face width
  horizontal, 0.4x vertical, 6s revolution).
- The SDK ships TypeScript source (`main: src/index.ts`), so its
  Reanimated worklets compile under the CONSUMER's Babel config: any
  app using the overlay needs `react-native-reanimated/plugin` LAST
  in its Babel plugins (see `example/babel.config.js`).

### Deviations from the M1 plan (stated, not silent)

- **Reanimated, not Skia, for M2.** Spec §3 allows Reanimated
  worklets / Skia; M2 gift anchoring needs positioning, not custom
  drawing, so Reanimated + `Image` covers it. Skia is deferred to M3,
  where GPU filter rendering earns it. This adds
  `react-native-reanimated` as an SDK peer dependency and as an
  example direct dependency (4.5.1, matching the SDK-57 / RN 0.86.2
  stack the example already targets).
- **EMA is jitter filtering, not interpolation** (see above).
- **Sound not wired in M2** (see above).

### Step 0 proof table (M1 build-proof gate, resolved in M2)

| Item | Proven in the sandbox | Still owed |
| ---- | --------------------- | ---------- |
| Real `tsc --strict` on SDK + example + tests | Clean under real RN 0.86.2 / reanimated 4.5.1 types (TS 5.6.3). With `skipLibCheck: false` the only errors are 6 inside reanimated/worklets `.d.ts` files (missing `Keyframe` / `WeakRef` globals — those libs assume a DOM/ES2021 lib, which RN projects exclude); zero errors in project files. Final clean run uses `skipLibCheck: true`, as default Expo projects do. | Nothing for types. |
| Gradle + CocoaPods files | Pins verified: `tasks-vision:0.10.14` pom + aar on Google's Maven repo (`google()` first in `build.gradle`; NOT on Maven Central); CameraX 1.3.4 poms; kotlin-gradle-plugin 1.9.24 pom; `MediaPipeTasksVision` 0.10.14 on CocoaPods trunk; native/JS event + module names consistent across Swift/Kotlin/JS; `app.plugin.js` syntax-checked. | Full Gradle build, CocoaPods install/resolution, and a dev build — all need a build machine. |
| Example lockfile | `example/yarn.lock` (yarn v1) generated and verified: 472 registry packages, all 472 tarballs hash-verified (sha512), 564 keys, 0 pattern-check misses. Entries keyed by requested range. | Install from the lockfile on a real toolchain (sandbox proxy mangles some registry metadata through package managers, so install itself was not run here). |
| On-device behavior (M1 + M2) | Example mock mode (scripted face path + pinned gift + pause-to-fallback) lets anchoring be judged without a phone. | Real-phone pass: dev build, permission flow, dots + anchored gift tracking front/back cameras, fallback behavior on real loss, FPS with the overlay rendering. |

## M3 spike record — LiveKit publish path + renderer decision

Step 0 of M3, done before any pipeline code was written. Sources are
the fork's shipped source (`@livekit/react-native-webrtc` 144.1.2,
`@livekit/react-native` 2.12.0, `livekit-client` 2.22.1), read
directly — not assumed from docs.

### LiveKit publish path: the fork's VideoEffect registry (VERDICT: SUPPORTED)

The fork already ships the bridge M3 needs. No custom capturer
subclass, no LiveKit client changes, no frame-injection API:

- **Android** (`package/android/src/main/java/com/oney/WebRTCModule/videoEffects/`):
  `ProcessorProvider.addProcessor(name, factory)` (static, stores a
  factory per name) + `VideoFrameProcessor.process(frame,
  textureHelper): VideoFrame` + `VideoEffectProcessor implements
  VideoProcessor`, wired via `videoSource.setVideoProcessor(...)` in
  `GetUserMediaImpl.setVideoEffects`. Frames flow capturer →
  processor → sink (encoder). `onFrameCaptured` retains the input,
  runs each processor, sends the output to the sink, then releases
  both — so a processor may return the input frame (pass-through) or
  a fresh frame; both are ownership-correct.
- **iOS** (`package/ios/RCTWebRTC/videoEffects/`):
  `ProcessorProvider +addProcessor:forName:` (stores an INSTANCE, not
  a factory) + `VideoFrameProcessorDelegate`
  (`capturer:didCaptureVideoFrame: -> RTCVideoFrame*`) +
  `VideoEffectProcessor: RTCVideoCapturerDelegate`, wired via
  `capturer.delegate = videoEffectProcessor` in
  `mediaStreamTrackSetVideoEffects`. Same pre-encode chain.
- **JS**: `MediaStreamTrack._setVideoEffects([names])` (private/custom
  API in the fork, but shipped in 144.1.2) → native
  `mediaStreamTrackSetVideoEffects`. Empty names array = clean
  pass-through on both platforms (iOS forwards the frame unchanged
  with zero processors; Android's processor list is empty) — so
  `clearFilter` via `_setVideoEffects([])` works.
- **Normal publish is unchanged**: the app gets a camera track via
  `getUserMedia` / `createLocalVideoTrack`, the adapter applies the
  effect, the app publishes the track as usual. `livekit-client`
  2.22.1 exports `LocalVideoTrack` / `createLocalVideoTrack` /
  `publishTrack` as usual.

**What does NOT exist: a frame-injection API.** Local tracks come
ONLY from camera/screen capturer controllers via `getUserMedia`
(`createVideoTrack` takes a capture controller). There is no API for
feeding SDK-produced frames into a track — so an M1-session
frame-source path is NOT available, and M3 does not pretend otherwise.
M1's camera session cannot feed a LiveKit track; the filtered track
uses WebRTC's camera, and the processor runs its own MediaPipe
detection on those frames.

**Caveats, all load-bearing for M5:**
- Camera tracks only. Android's `setVideoEffects` applies only when
  the controller is a `CameraCaptureController`; iOS requires a local
  track with a capture controller. Screen-share tracks cannot be
  filtered — fine for the host-camera case.
- iOS shares ONE processor instance + ONE module-level
  `videoEffectProcessor` → ONE filtered camera track at a time.
  Exactly the host-camera case; multi-track filtering is out of scope.
- Android unknown processor names are logged + skipped silently, and
  `_setVideoEffects` returns void — JS cannot detect a skip. The
  adapter therefore registers before applying and treats a
  registration failure as an error (fail loud at registration, not
  silent at apply).
- JS `_setVideoEffects` is private/custom → the adapter
  feature-detects (`typeof === 'function'`) and throws a clear
  `FilterNotSupportedError` otherwise.

### Renderer: native compositing, NOT React Native Skia (VERDICT: NATIVE WINS)

`@shopify/react-native-skia` 2.14.0 DOES ship headless/offscreen
APIs (`makeOffscreenSurface`, `drawOffscreen`, `Offscreen` renderer
export) — but they render JS-driven scenes to images. They cannot sit
in the fork's native per-frame pipeline (VideoFrame in → VideoFrame
out, GPU textures, encoder timing) without per-frame GPU readback
through JS. Not viable for pre-encode. Winner: native compositing
inside the processor — iOS CoreImage (grade) + CoreGraphics (shapes)
into a new `CVPixelBuffer` → new `RTCVideoFrame` (same timestamp);
Android I420 buffer path (`toI420` → draw → wrap) for M3 simplicity,
with a documented GLES fast-path follow-up. **Consequence: NO Skia
dependency is added in M3, so `example/package.json` is untouched
and NO lockfile update is needed** (the task's lockfile clause is
vacuous for M3 — stated here, not silently skipped).

### Camera ownership reconciliation (spike-corrected architecture)

"One camera, one flow" still holds, but the flow changed: M1's
provider session and a filtered LiveKit track cannot run concurrently
on one camera. The M3 filtered track uses WebRTC's camera; the
processor runs its own MediaPipe detection on those frames (same
engine + model as M1, hosted in the processor) and emits landmarks to
JS so the host app can forward them over the socket for M2 viewer
anchoring at M5. M1's standalone session remains for detection-only
use. The TS `HostFilterPipeline` therefore does NOT own a camera: it
consumes `FaceFrame`s from any detector (M1 provider events in the
example preview, M3 processor landmark events on a LiveKit track at
M5) and emits plans; the native compositor consumes the same effect
data on the track itself.

### Registration mechanics (planned, first-build verification owed)

- **iOS**: podspec adds `livekit-react-native-webrtc ~> 144.1` +
  `WebRTC-SDK = 144.7559.10` (exact pin matching the fork's podspec,
  verified in the fork source: podspec name
  `livekit-react-native-webrtc`, version from package.json 144.1.2,
  platforms iOS 12.0+, `source_files ios/**/*.{h,m}`, dependency
  `React-Core` + `WebRTC-SDK =144.7559.10`,
  `DEFINES_MODULE=YES`). Swift processor imports WebRTC types only;
  registry access uses runtime lookup (`NSClassFromString(
  "ProcessorProvider")` + `perform(_:with:with:)` for
  `addProcessor:forName:`) to avoid fork header/module-map fragility
  for the dashed pod name. The processor class is an NSObject
  subclass with an `@objc capturer:didCaptureVideoFrame:` method
  whose selector matches the fork's delegate protocol structurally;
  runtime message dispatch does not check declared protocol
  conformance. If the class is missing at runtime → clear
  registration error.
- **Android**: processor class implements the fork's
  `VideoFrameProcessor` directly (compile-time import
  `com.oney.WebRTCModule.videoEffects.*`). Build.gradle adds
  `implementation project(':livekit-react-native-webrtc')` with a
  comment stating the assumption (autolinking names the project after
  the npm package name) + fix instruction (check `settings.gradle`
  after prebuild; adjust one line if different). `org.webrtc`
  classes come transitively via the fork's `api
  'io.github.webrtc-sdk:android:144.7559.05'` (api = transitive).
  The factory returns the SHARED processor instance (not a fresh one
  per call) so module filter state reaches the track's processor —
  consistent with the one-filtered-track limit on both platforms.
  The new module is added to the EXISTING
  `ARFaceLandmarkerPackage.createNativeModules` — no second package
  class.
- **Fork facts recorded**: webrtc podspec as above; Android fork
  build.gradle: namespace `com.oney.WebRTCModule`, minSdk 24, `api
  'io.github.webrtc-sdk:android:144.7559.05'`, implementation
  `react-android:+`, `androidx.core:core:1.7.0`. Fork package.json
  peers (via `@livekit/react-native` 2.12.0):
  `@livekit/react-native-webrtc ^144.1.2`, `livekit-client ^2.19.0`,
  `react *`, `react-native *`. Note: the fork's minSdk 24 exceeds
  this SDK's minSdk 23 — filter users need minSdk 24 (the host app
  already does, via the fork itself); M1-only apps are unaffected.

## M3 implementation record — host-side pre-encode filters

### TS core (`packages/src/`, pure + tested)

- **Types** (`types.ts`): `FilterGradeParams` (warmth [-1, 1],
  brightness, saturation + contrast multipliers), `FilterShapeDef`
  (kind ellipse | rect | line | polyline; anchor index into
  `effect.anchors`; sub-rect fractions of the anchor rect; polyline
  points fractions; color #rrggbb; fill; lineWidth as fraction of
  frame width, default 0.008), `FilterDrawCommand` (shape | grade, in
  normalized 0..1 frame space), `FilterFramePlan` (timestampMs,
  effectId | null, filtered boolean, commands, droppedReason
  "over-budget" | "no-filter" | "no-face" | "bypassed"),
  `HostFilterConfig`, `FilterPipelineStatus`.
  `EffectDefinition` gains optional `shapes?` + `grade?` —
  backward-compatible: filters are still DATA, not code.
- **Filter renderer** (`filter-renderer.ts`): `renderFilterCommands(
  effect, faceState | null, { mirrored })` — grade commands always
  apply when present; anchor shapes only with a tracked face (no face
  → shapes omitted, grade still applies). Anchor math mirrors M2
  (`resolveAnchorPoint` on `FaceAnchorState`; anchor rect width =
  `scaleToFace` × bounds.width, height = `scaleToFace` ×
  bounds.height; above-head bottom-pins, on-face/follow center).
  Pre-encode compositing uses sensor space directly (NO flip) because
  detection + compositing share the frame's coordinate space; the
  `mirrored` option exists only for pipelines that mirror frames
  before compositing (not M3's) and defaults false. Grade formula
  (shared TS + native, same order): warmth → R *= (1+0.2w), B *=
  (1−0.2w); saturation gray-mix (Rec. 601 luminance); contrast
  (rgb−0.5)*c+0.5; brightness rgb += b. `validateFilterEffect`
  fails bad data at load time, not mid-frame.
- **Performance governor** (`performance-governor.ts`): budget =
  1000/targetFps ms (default ~66ms at 15fps); over-budget frame
  passes through UNFILTERED (never blocks the encoder); consecutive
  over-budget frames counted; at MAX_CONSECUTIVE_DROPS (default 8)
  the pipeline enters bypass (filter off, pass-through) +
  onFilterBypassed; after BYPASS_COOLDOWN_MS (default 3000ms) a probe
  frame is attempted (within budget → filtering resumes; over →
  bypass restarts, no flapping). TS governor is the shared logic +
  preview/test reference; native processors implement identical
  thresholds with real measured durations.
- **Filter pipeline** (`filter-pipeline.ts`): `HostFilterPipeline` —
  does NOT own a camera (M3 corrected architecture); consumes
  `FaceFrame`s from any detector. Owns an `AnchorTracker` per primary
  face (single face for M3, matching M1 maxFaces default 1) fed via
  `payloadFromFrame` with the union of the active effect's anchor
  indices (subset rule, §2). Methods: `setEffect(effect | null)`
  (validates, resets tracker + governor), `handleFrame(frame,
  measuredDurationMs?)` → `FilterFramePlan` (grade-only effects skip
  detection entirely; no active effect → filtered:false,
  droppedReason "no-filter"; anchor filter with no face → shapes
  omitted, droppedReason "no-face" unless grade present),
  `handleFaceLost`, `getStatus`, `reset`. Governor consulted only
  when a measured duration is supplied (TS path otherwise applies;
  native enforces with real measurements).
- **LiveKit adapter** (`livekit-adapter.ts`, pure, NO react-native
  import — Node-testable): `PROCESSOR_NAME = "ar-effects-filter"`;
  `LiveKitFilterAdapter` with injectable `FilterNativeBridge`;
  `applyFilter(track, effect)` validates track.kind === "video",
  requires bridge (else `FilterNotSupportedError`), registerProcessor()
  idempotent, `setFilter(JSON.stringify(effect))`, then
  `track._setVideoEffects([PROCESSOR_NAME])` if function exists else
  `FilterNotSupportedError` (fork `_setVideoEffects` missing — need
  @livekit/react-native-webrtc 144.x); returns {trackId, effectId,
  processorName}. `clearFilter(track)` = bridge.clearFilter() +
  `track._setVideoEffects([])` (verified pass-through with empty
  processors on both platforms). Status/bypass events come via bridge
  events (M5 wiring).
- **Filter bridge** (`filter-bridge.ts`): RN `NativeModules.ARFilter`
  wrapper implementing `FilterNativeBridge` (registerProcessor /
  setFilter / clearFilter) — imported by apps, NOT by unit tests
  (tests use a fake bridge).
- **Sample filters** (`sample-filters.ts`, data only, renderPath
  pre-encode, kind filter, animation loop, trackingLostFallback
  "hide" — shapes hide when no face; grade unaffected): (1)
  GOLDEN_SHADES — anchors [{landmarkIndices: [33, 263] (eye
  corners), placement "on-face", scaleToFace: 1.15}], shapes: left
  lens ellipse {x:0.02,y:0.25,w:0.44,h:0.5} gold stroke, right lens
  {x:0.54,y:0.25,w:0.44,h:0.5} gold stroke, bridge line points
  [(0.46,0.5),(0.54,0.5)] gold, assets []. (2) WARM_SUNSET — anchors
  [], grade {warmth:0.3, brightness:0.04, saturation:1.18,
  contrast:1.06}, assets [].
- **Tests** (node --test, strict tsc compile, mirroring M2 pattern):
  filter-renderer (compositing math, filter application from
  EffectDefinition data, anchor placement from landmarks, grade
  always / shapes-only-with-face), performance-governor
  (drop/bypass/probe/recover), filter-pipeline (state machine,
  subset indices, no-filter/no-face/grade-only paths),
  livekit-adapter (fake track + fake bridge: register→apply→clear,
  missing _setVideoEffects → FilterNotSupportedError, unknown-name
  silent-skip caveat documented), sample-filters (definitions valid,
  anchors resolve, renderPath pre-encode).
- **index.ts exports**: all new types, classes, functions, sample
  filters.

### Native (written, uncompiled, disclosed as owed — same honesty standard as M1/M2)

- **iOS** `packages/ios/ARFilterProcessor.swift` (@objc NSObject;
  method `capturer(_: RTCVideoCapturer, didCaptureVideoFrame:) ->
  RTCVideoFrame`): holds FaceLandmarker (same options pattern as
  ARCameraSession: model from bundle, VIDEO mode, numFaces 1,
  minFaceDetectionConfidence 0.5, outputFaceBlendshapes false — not
  needed for filters, saves compute), current filter state (parsed
  JSON: grade + shapes + anchor defs), governor counters, monotonic
  timestamps (max(prev+1), as in M1). Per frame: no filter /
  bypassed-in-cooldown → return frame unchanged; CVPixelBuffer frames
  only (I420 frames pass through unfiltered, documented limitation —
  camera capturer produces pixel buffers); detection skipped when
  filter is grade-only; landmarks from MPImage(pixelBuffer:) → first
  face → bounds from extremes (as in M1); anchor math mirrors TS;
  grade via CoreImage (CIColorMatrix warmth + CIColorControls
  saturation/brightness/contrast) rendered to a new pixel buffer;
  shapes via CoreGraphics on top; wrap as RTCCVPixelBuffer →
  RTCVideoFrame(buffer:rotation:timeStampNs:) with original timestamp
  + rotation (first-build verification point for the init signature).
  Over-budget → return ORIGINAL frame + drops++ → bypass +
  onFilterBypassed via module closure; landmark emission to JS via
  onLandmarks closure → module emits onFilterFrame (same shape as M1
  onFaceFrame) for M5 socket forwarding.
- **iOS** `packages/ios/ARFilterModule.swift` (RCTEventEmitter
  "ARFilter", mirroring M1's ARFaceLandmarker pattern):
  registerProcessor (runtime NSClassFromString lookup +
  performSelector addProcessor:forName: with shared processor
  instance; idempotent), setFilter(effectJson), clearFilter; events
  onFilterFrame + onFilterBypassed (main queue for emit, as in M1).
  Camera permission already covered by existing plugin — no plugin
  changes.
- **Android** `packages/android/src/main/java/com/areffects/ARFilterProcessor.kt`
  (implements fork VideoFrameProcessor): holds FaceLandmarker
  (tasks-vision VIDEO mode, asset "face_landmarker.task", numFaces 1,
  same options as ARCameraSession.kt), filter state (org.json),
  governor counters. Per frame: no filter / bypassed-in-cooldown →
  return frame; texture frames convert via YuvConverter (verified in
  the real 144.7559.05 artifact: `YuvConverter.convert(
  TextureBuffer): I420Buffer` exists; `TextureBuffer.toI420()` does
  NOT — conversion failure passes through, never crashes the stream);
  I420 path: buffer.toI420() → YUV→ARGB (BT.601, documented) →
  Bitmap → detect first on clean bitmap (skipped when grade-only) →
  Canvas draw grade (single composed ColorMatrix, same formula as TS)
  + shapes (Paint: oval/rect/lines/path, hex color parse, stroke =
  lineWidth × width) → ARGB→YUV → JavaI420Buffer.allocate + put →
  VideoFrame(buffer, frame.rotation, frame.timestampNs). Rotation
  preserved on output; landmarks computed in buffer space (rotation
  behavior is a first-device verification point). Over-budget →
  original frame + drops++ → bypass + module callback
  (companion-object lambdas mirroring M1's ARCameraSession.onFrame
  pattern).
- **Android** `packages/android/src/main/java/com/areffects/ARFilterModule.kt`
  (ReactContextBaseJavaModule "ARFilter", mirroring M1 module
  pattern): registerProcessor (ProcessorProvider.addProcessor with
  factory returning the SHARED processor instance — so module filter
  state reaches the track's processor; consistent with
  one-filtered-track limit), setFilter/clearFilter, events
  onFilterFrame/onFilterBypassed via DeviceEventManagerModule.
- **Android** `ARFaceLandmarkerPackage.kt`: add ARFilterModule to
  createNativeModules (same registration path M1 uses — do NOT create
  a second package class).
- `packages/android/build.gradle`: add `implementation
  project(':livekit-react-native-webrtc')` with comment (assumption:
  autolinking names the project after the npm package name; fix =
  check settings.gradle after prebuild, adjust one line if different).
  org.webrtc classes arrive transitively via fork's api dependency.
- `packages/ARFaceEffects.podspec`: add `s.dependency
  'livekit-react-native-webrtc', '~> 144.1'` + `s.dependency
  'WebRTC-SDK', '=144.7559.10'` with comments (pins must match the
  host app's fork version; first-build resolution confirms).
- **Config plugin: NO changes** (camera permission already covers M3;
  no new permissions).

### Example app extension (`example/App.tsx` + new `example/FilterPreviewOverlay.tsx`, NO new deps → NO lockfile change)

Raw-vs-filtered preview toggle in camera mode (Off / Golden Shades /
Warm Sunset cycling button; dots hidden while a filter preview is
active so the filter can be judged cleanly). Preview is an
APPROXIMATION, documented in code + example README: pipeline.
handleFrame(provider frames) → FilterFramePlan →
FilterPreviewOverlay renders plan.commands as RN Views (ellipse =
borderRadius view, rect = view, line = rotated view; grade =
full-screen tint view approximating warmth/brightness) positioned by
normalized coords → view pixels (stretch mapping, front-camera flip).
True pre-encode compositing happens natively on the LiveKit track —
preview shows placement/grade intent only. M1 dots mode and M2 mock
mode stay intact.

### What M5 must supply (integration, NOT in M3)

Host app: get a camera track → `adapter.applyFilter(track, effect)`
→ publish the track as usual; forward the processor's
`onFilterFrame` landmark events over the live socket so viewers'
M2 anchoring can track the host's face; wire `onFilterBypassed` to
host UI (filter temporarily off); wire `soundUri` per the app's audio
policy (still unwired in M3, as in M2). Device proof owed at M5:
real-phone filtered publish, FPS under filter load, LiveKit publish
end-to-end, permission flow, first-build Gradle/CocoaPods resolution
(incl. the fork project-name assumption + WebRTC module import +
RTCVideoFrame init signature + I420/rotation behavior).

## M4 — Effects catalogue + docs

M3 proved two sample filters end to end. M4 turns samples into a
catalogue third parties can extend: effects are DATA
(`EffectDefinition` objects), never hardcoded components, and every
entry is validated at load.

### Catalogue layout

- `packages/src/catalogue.ts` — `CATALOGUE` (16 entries: 13 filters,
  then 3 gifts), `CATALOGUE_FILTERS`, `CATALOGUE_GIFTS`,
  `getEffectById` (throws on unknown ids), `getEffectsByTag`.
  File order is catalogue order; the example picker reads these
  arrays directly, so new entries appear automatically.
- `packages/src/catalogue-assets.ts` — gift artwork as self-contained
  data URIs (128×128 PNGs drawn in-session: gold orb, heart, star).
  No Metro asset resolution, no network fetch at render. These are
  simple geometric images, NOT TikTok-grade animated gift art —
  animated lottie/svga/video-alpha artwork is animator work that
  lands with player dependencies in a later milestone; until then
  such assets render as name pills (M2 behavior).
- `packages/src/sample-filters.ts` — the M3 samples (Golden Shades,
  Warm Sunset) now carry the M4 schema fields; they are catalogue
  entries too (`golden-shades`, `warm-sunset`).
- `packages/src/effect-validation.ts` — `validateEffectDefinition`
  / `validateCatalogue` / `decodeBase64ToBytes`
  (hand-rolled, no Buffer/atob, so it runs under Hermes).

### Schema + versioning

Every entry carries a stable slug `id`, display `name`,
`formatVersion`, own `version`, and ≥1 `tag`. The two version fields
are deliberately separate:

- `formatVersion` is the SCHEMA version (M4: 1). It changes only
  when the `EffectDefinition` shape itself changes. An unknown
  `formatVersion` fails loud at load — never silently misrenders.
- `version` is the EFFECT version (starts at 1). It changes when one
  effect's data changes. Hosts and viewers match by `id`; a version
  bump tells an app its cached copy is stale.

Validation enforces the full contract (see
`docs/EFFECT_AUTHORING.md`): slug ids, kind/renderPath invariant
(filter → pre-encode, gift → viewer-overlay), animation modes,
fallbacks, anchor indices in [0, 477], `scaleToFace` in (0, 5],
filter-noop rejection (a filter with neither grade nor shapes renders
nothing), assets-on-filter and shapes/grade-on-gift rejection, asset
URI resolution (data: URIs fully decoded and checked, http(s)
syntactically validated), plus the delegated grade/shape checks from
M3. Invalid data throws `Invalid effect "<id>": <problem>` at load —
catalogue import, `HostFilterPipeline.setEffect`,
`LiveKitFilterAdapter.applyFilter` — never silently at render.

### Renderer envelope (unchanged by M4)

M4 defines no effect the renderers cannot express. Pre-encode
compositors (iOS CoreImage/CoreGraphics, Android I420/Canvas) draw
ellipse / rect / line / polyline shapes with `#rrggbb` colors plus
full-frame grades; the viewer overlay renders image assets via RN
`Image` (first anchor only) and ignores animation timing and sound
(sound still unwired, as in M2/M3). Anything outside that envelope
(gradients, masks, 3D models, particles) is a renderer extension and
a schema version bump — a milestone, not a catalogue entry.

### Example picker + docs

- `example/EffectPicker.tsx` — RN-core horizontal chip row (filters
  in camera mode with an Off chip, gifts in mock mode without one)
  plus a selected-detail line (name · version · tags). Camera mode
  applies the chosen filter to the preview pipeline and hides dots
  while a filter is active; mock mode switches the pinned gift.
  M3's cycle-through button and hardcoded mock gift are gone; M1
  dots mode and the M2 mock stream are otherwise unchanged.
- `docs/API.md` — providers, anchor tracker, overlay, filter
  pipeline, LiveKit adapter, catalogue/validation.
- `docs/EFFECT_AUTHORING.md` — schema fields, validation rules,
  worked Cat Ears example, how to add to the catalogue, renderer
  capability matrix, versioning policy.
- `docs/INTEGRATION.md` — install (honest: npm lands at M5; pre-M5
  install is the example's `file:../packages` path), config plugin
  (camera permission only), provider setup, host filters, viewer
  anchoring, performance notes.
- M4 adds NO dependencies: `example/package.json` and
  `example/yarn.lock` are byte-identical to main, so no lockfile
  update is owed. No npm publish, no Tokrah integration (both M5).
  Owed on-device/at M5: real-phone catalogue browsing + filter/gift
  preview, FPS with catalogue effects, full Tokrah integration.

## Milestones

- **M1 — Detection provider + example app.** MediaPipe Face Landmarker
  implemented (the single primary provider for M1); ML Kit and Apple
  Vision remain specified fallbacks for later milestones. Example app
  shows live landmarks on a real phone. No socket, no filters yet —
  prove detection works on-device first. On-device verification is
  owed (see README).
- **M2 — Viewer-side gift anchoring.** Landmark stream (§2) over the live
  socket; viewer overlay renderer (§3) pins gift effects to streamed
  anchors; banner/stage fallback on tracking loss. This is the
  face-following-gift feature, end to end.
- **M3 — Host-side pre-encode filters.** Fork VideoEffect processor
  (§4, spike-corrected: no custom capturer, no plugin change)
  bridged into LiveKit React Native via the adapter; filters
  composited before encode so all viewers see them. The hard phase;
  gets its own device-testing pass (at M5, with integration).
- **M4 — Effects catalogue + docs.** Starter data-defined filters and gift
  effects, integration guides (LiveKit setup, socket wiring, performance
  notes), and a contribution guide for effect authors.
- **M5 — npm publish.** `react-native-ar-effects` on npm with versioned
  releases, changelog, and a compatibility matrix (React Native / Expo SDK
  / LiveKit versions tested).
