# API reference

`react-native-ar-effects` ships TypeScript source (`main: src/index.ts`).
All names below are exported from the package root unless noted. The
pure-TS layers (stream, tracker, mapping, renderer, pipeline, governor,
validation, catalogue) have no React Native imports and are unit-tested
in Node; the components and provider wrap native modules and need a
dev build (see `INTEGRATION.md`).

On-device verification is owed for M1–M3 (see the repo README). Do not
ship to users until the example app proves the flow on a phone.

## Detection — `DetectionProvider`

```ts
import { mediaPipeProvider } from "react-native-ar-effects";

await mediaPipeProvider.start({
  cameraPosition: "front", // or "back"; default "front"
  maxFps: 15, // processed frames per second; default 15
  maxFaces: 1, // default 1
  minDetectionConfidence: 0.5,
});
const off = mediaPipeProvider.onFrame((frame: FaceFrame) => { /* ... */ });
const offLost = mediaPipeProvider.onFaceLost((payload) => { /* ... */ });
await mediaPipeProvider.stop();
```

- `mediaPipeProvider` is a singleton `MediaPipeFaceLandmarkerProvider`
  (MediaPipe Face Landmarker, VIDEO mode, CPU delegate, bundled
  `face_landmarker.task`). `isSupported()` reports whether it can run
  on the device.
- The provider **owns the camera session**. Preview through
  `<ARCameraView />` (a `ViewProps` wrapper around the native preview
  bound to the shared session) — never mount a second camera component
  such as expo-camera, or the two sessions fight for the hardware.
- `FaceFrame`: `faceId`, `landmarks` (normalized 0..1, origin top-left,
  MediaPipe-478 order), `landmarkMap`, optional `blendshapes`,
  `bounds`, `timestampMs`, `source`. Coordinates are raw sensor space;
  the front-camera preview is mirrored, so viewer-side consumers flip
  `x -> 1 - x` (see Mapping). Hosts never pre-flip.
- `FaceTrackingConfig` fields are all optional. `DetectionProvider` is
  the interface every engine implements (MediaPipe today; ML Kit and
  Apple Vision remain specified fallbacks).

## Landmark stream — host → viewers

```ts
import { LandmarkStreamConsumer, payloadFromFrame } from "react-native-ar-effects";

// Host: shrink a frame to the socket payload (subset of landmarks only;
// mirrored = true for the front camera, so viewers flip x -> 1 - x).
const payload: LandmarkPayload = payloadFromFrame(
  frame,
  [1, 10, 33, 263],
  cameraPosition === "front",
);
socket.send(payload);

// Viewer: feed received payloads to one consumer.
const consumer = new LandmarkStreamConsumer({ lostAfterMs: 1500 });
consumer.handlePayload(incoming); // LandmarkPayload | FaceLostPayload
const face = consumer.getPrimaryFaceState();
consumer.setPrimaryFace("face-1"); // or null for first-tracked default
consumer.onUpdate(() => { /* re-render from getFaceState */ });
```

- `LandmarkPayload` (`type: "face.landmarks"`): `faceId`, sparse
  `landmarks` (`{ index, x, y }` in `landmarkMap` numbering), `bounds`,
  `timestampMs`, `coordinateSpace: "normalized-top-left"`, `mirrored`
  (viewers flip when true), `landmarkMap`. Only the indices the active
  effects anchor to travel — never the full mesh.
- `FaceLostPayload` (`type: "face.lost"`): `faceId`, `timestampMs`.
- `LandmarkStreamConsumer` keeps one `FaceAnchorState` per face
  (`landmarks` keyed by index, `latestIndices` from the newest payload
  only — anchors never trust stale points, `bounds`, `lastSeenMs` on
  the viewer clock, `status: "tracked" | "lost"`, `mirrored`,
  `landmarkMap`). Loss is a `face.lost` payload or a gap longer than
  `lostAfterMs` (default 1500ms). An explicit primary stays selected
  even when lost, so a gift never jumps to another face.

## Anchor tracker + coordinate mapping

```ts
import { AnchorTracker } from "react-native-ar-effects";
import {
  computeAssetRect,
  mapSensorBoundsToView,
  mapSensorPointToView,
  resolveAnchorPoint,
} from "react-native-ar-effects";
```

- `AnchorTracker` smooths one face's landmarks with an EMA
  (`smoothingAlpha`, default 0.35 — settles in ~5 frames at 15fps),
  snaps exactly on first sight and on reappearance after loss/gap, and
  reports `isLost()` / `getState()`. Constructor takes an optional
  `{ smoothingAlpha, lostAfterMs }` config.
- Mapping pipeline: sensor point → mirror first (`x -> 1 - x` when the
  payload says `mirrored`) → displayed video rect (cover `max` scale /
  contain `min` scale, centered offsets — letterbox/pillarbox accounted
  for, fullscreen never assumed) → view pixels.
  `mapSensorPointToView(point, { mirrored, videoSize, viewSize, resizeMode })`,
  `mapSensorBoundsToView(bounds, options)`.
- `resolveAnchorPoint(face, anchor)`: above-head → bounds top-center;
  on-face / follow → centroid of fresh requested indices, bounds center
  when none are fresh; orbit → bounds center (offset applied at
  render); fullscreen → null.
- `computeAssetRect({ anchorPoint, faceWidthPx, anchor, asset, viewSize })`:
  asset width = `scaleToFace × faceWidthPx`, height from the asset's
  intrinsic aspect (square fallback on invalid size); above-head
  bottom-pins the rect at the anchor point, others center it; offsets
  are in face-width units, x right, y down.

## Viewer overlay — `AnchoredGiftOverlay`

```tsx
<AnchoredGiftOverlay
  consumer={consumer}
  effect={GOLDEN_ORB_GIFT}
  videoSize={{ width: 720, height: 1280 }}
  viewSize={viewSize}
  resizeMode="cover"
  faceId={null} // default: consumer's primary face
  onFallback={(mode) => { /* "banner" | "stage" | "hide" */ }}
/>
```

- Position/size live in Reanimated shared values — per-frame updates
  never touch React state. Only the effect's **first** anchor is used;
  multi-anchor effects land later.
- Image assets render as `Image`; lottie / svga / video-alpha assets
  render as a name pill until player dependencies land; an effect with
  no anchors renders nothing; an effect with no assets renders a name
  pill (so data-defined effects stay visible before artwork lands).
- When no tracked anchor is available the overlay renders the
  effect's `trackingLostFallback` (banner / stage / hide) instead of
  vanishing or freezing; re-anchoring is automatic. `onFallback` fires
  once per tracked → fallback transition, never on initial mount.
- Sound (`soundUri`) is carried, not played: audio policy belongs to
  the app's gift system.

## Host filters — `HostFilterPipeline` + renderer + governor

```ts
import { HostFilterPipeline } from "react-native-ar-effects";

const pipeline = new HostFilterPipeline(
  { targetFps: 15, maxConsecutiveDrops: 8, bypassCooldownMs: 3000 },
  () => Date.now(),
);
pipeline.setEffect(CAT_EARS); // throws on invalid data; null clears
const plan: FilterFramePlan = pipeline.handleFrame(frame, measuredMs);
pipeline.handleFaceLost(faceId);
pipeline.getStatus(); // { effectId, bypassed, consecutiveDrops, framesSeen }
```

- `renderFilterCommands(effect, face | null, { mirrored })` computes
  `FilterDrawCommand[]` in normalized sensor space: grade commands
  always (when the effect has a grade), shapes only while the face is
  tracked. Geometry here is the geometry viewers see in encoded video.
- Grade formula (shared with the native compositors, in order):
  warmth (`R *= 1 + 0.2w`, `B *= 1 - 0.2w`), saturation (Rec. 601
  luminance gray), contrast around mid-grey, brightness, clamp [0, 1].
  `applyGradeToRgb` is the reference implementation;
  `resolveGradeParams` fills neutral defaults; `parseHexColor`
  enforces `#rrggbb`.
- `FilterPerformanceGovernor`: frame budget `1000 / targetFps`
  (~66ms at 15fps); an over-budget frame passes through **unfiltered**,
  never blocking the encoder; 8 consecutive over-budget frames bypass
  (filter off) + `onFilterBypassed`; after a 3s cooldown a probe frame
  retries (in-budget → resume, over → bypass restarts, no flapping).
- `validateFilterEffect(effect)` throws on bad grade ranges, hex
  colors, line widths, shape rects, missing points, or dangling shape
  anchors. `HostFilterPipeline.setEffect` calls it, so bad data fails
  at load, not mid-frame.

## LiveKit adapter — `LiveKitFilterAdapter`

```ts
import { LiveKitFilterAdapter, PROCESSOR_NAME } from "react-native-ar-effects";

const adapter = new LiveKitFilterAdapter(nativeBridge);
if (adapter.isFilterable(track)) {
  await adapter.applyFilter(track, CAT_EARS);
  await adapter.clearFilter(track);
}
```

- No custom capturer: the fork's VideoEffect registry
  (`@livekit/react-native-webrtc` 144.x) already ships the bridge.
  `applyFilter` validates the track (video kind) and the effect,
  registers the processor once (`registerProcessor`), hands the effect
  JSON to native (`setFilter`), then routes the track through it
  (`track._setVideoEffects([PROCESSOR_NAME])`, processor name
  `ar-effects-filter`). `clearFilter` restores pass-through.
- Throws `FilterNotSupportedError` when the track cannot carry effects
  (wrong kind, or a fork without `_setVideoEffects`). There is **no**
  frame-injection API in the fork: the filtered track uses WebRTC's
  camera, and the native processor runs its own MediaPipe detection on
  those frames. One filtered camera track at a time; screen-share
  tracks cannot be filtered.
- `FilterNativeBridge` (`registerProcessor(): Promise<boolean>`,
  `setFilter(effectJson: string)`, `clearFilter()`) is implemented by
  `NativeFilterBridge` (see `filter-bridge.ts`).

## Catalogue + validation

```ts
import {
  CATALOGUE,
  CATALOGUE_FILTERS,
  CATALOGUE_GIFTS,
  getEffectById,
  getEffectsByTag,
  validateCatalogue,
  validateEffectDefinition,
  EFFECT_FORMAT_VERSION, // 1
} from "react-native-ar-effects";

validateEffectDefinition(untrustedEffect); // throws, naming the problem
validateCatalogue(CATALOGUE); // every entry valid, ids unique
```

- `CATALOGUE` (16 entries in M4): 13 filters + 3 gifts, filters first.
  Every entry: stable slug `id`, display `name`, `formatVersion` (1),
  own `version` (starts at 1), at least one `tag`. See
  `EFFECT_AUTHORING.md` for the full schema.
- `getEffectById(id)` throws on unknown ids; `getEffectsByTag(tag)`
  returns matching entries (empty array when none match).
- Validation rules (full list in `EFFECT_AUTHORING.md`): slug ids,
  kind/renderPath invariant (filters pre-encode, gifts viewer-overlay),
  animation modes, fallbacks, anchor indices in [0, 477],
  `scaleToFace` in (0, 5], filter-noop rejection, assets-on-filter and
  shapes/grade-on-gift rejection, asset URI resolution (data: URIs
  fully decoded and checked, http(s) syntactically validated), and the
  delegated grade/shape checks. Invalid data throws at load — never
  silently at render.
