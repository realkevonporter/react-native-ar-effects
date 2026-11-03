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

### Why this is the hard phase

React Native live apps do not normally own the camera-to-encoder path.
LiveKit React Native publishes camera frames through its own native
capturer, built on LiveKit's WebRTC fork. To composite before encode, we
must:

1. **Build a custom camera capturer** (Swift on iOS, Kotlin on Android)
   that replaces LiveKit's default capturer for the host's video track.
2. **Bridge it into LiveKit's WebRTC fork** — the capturer must speak the
   fork's frame format and lifecycle, and survive LiveKit's track
   publish/unpublish, mute, and reconnection paths.
3. **Ship it as an Expo config plugin** so host apps (Expo-based, like the
   ones this SDK is built for) get the native code wired into their builds
   without hand-editing Xcode/Gradle projects.
4. **Render filters on the frame** (Skia/Metal on iOS, Skia/OpenGL on
   Android) at camera frame rate, without dropping the encode pipeline
   below real-time. Filter rendering must be GPU-side; CPU compositing
   will not hold 30fps on mid-range phones.
5. **Keep audio untouched.** The compositor touches video frames only;
   the audio track flows through LiveKit unchanged.

This is M3, not M1, for a reason: M1/M2 (detection + viewer gift anchors)
deliver real value without it, and M3's capturer bridge is the piece most
likely to break across LiveKit/React Native upgrades. It gets its own
milestone, its own example app, and its own device-testing pass.

### Filter pipeline (host)

```
Camera (custom capturer)
  → Detection provider (MediaPipe/ML Kit/Vision, same interface as §1)
  → Filter renderer (Skia/Metal/OpenGL, GPU)
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
- **M3 — Host-side pre-encode filters.** Custom camera capturer (§4)
  bridged into LiveKit React Native, shipped as an Expo config plugin.
  Filters composited before encode so all viewers see them. The hard
  phase; gets its own device-testing pass.
- **M4 — Effects catalogue + docs.** Starter data-defined filters and gift
  effects, integration guides (LiveKit setup, socket wiring, performance
  notes), and a contribution guide for effect authors.
- **M5 — npm publish.** `react-native-ar-effects` on npm with versioned
  releases, changelog, and a compatibility matrix (React Native / Expo SDK
  / LiveKit versions tested).
