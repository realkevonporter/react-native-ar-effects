# react-native-ar-effects

Open-source face tracking + AR effects for React Native live video.

`react-native-ar-effects` gives a live-streaming app two things that are usually
locked behind a commercial SDK:

1. **Face-following gift anchors** — a host's face is tracked on-device, the
   normalized landmarks travel over the live socket, and every viewer's phone
   pins gift overlays (a lion, a whale, anything) to the host's face.
2. **Host-side filters** — funny face filters the host adds while streaming
   that *all* viewers see, because they are composited into the video before
   it is encoded — not faked as a preview-only overlay on the host's screen.

It is built to integrate with **LiveKit-based live streaming** (the
`@livekit/react-native` stack), but the detection, landmark-stream, and
effects layers are transport-agnostic: any live socket can carry landmarks,
and any video pipeline can consume the pre-encode compositor.

## Install

```sh
npm install react-native-ar-effects
```

Peer dependencies (from `packages/package.json`, declared with `"*"` — use
the versions your app already runs; the example app runs react 19.2.3,
react-native 0.86.2, react-native-reanimated 4.5.1):

- `react`
- `react-native`
- `react-native-reanimated` — the viewer overlay positions gifts with
  Reanimated shared values (no React re-render per frame). If your app
  does not have it yet, `npm install react-native-reanimated`, and keep
  `react-native-reanimated/plugin` last in your Babel plugin list (see
  `example/babel.config.js`).

### Config plugin (Expo)

Add the package to your app config. The plugin does one thing — camera
permission. iOS gets `NSCameraUsageDescription`; Android gets the `CAMERA`
permission. Autolinking wires the podspec / Gradle module; the plugin
adds no other native wiring.

```json
// app.json
{
  "expo": {
    "plugins": ["react-native-ar-effects"]
  }
}
```

With a custom permission message:

```json
// app.json
{
  "expo": {
    "plugins": [
      [
        "react-native-ar-effects",
        {
          "cameraPermissionText": "We need the camera to track your face."
        }
      ]
    ]
  }
}
```

Camera permission note: the native modules need a dev build
(`expo prebuild` + run) — they do not run in Expo Go, and the camera
permission prompt must be granted before the provider starts. If you are
not on Expo, add the same two permission entries manually and let
autolinking wire the native modules.

### Minimal usage

Host — start the provider and show its preview (the provider owns the
camera session, so preview through `<ARCameraView />`, never a second
camera component):

```tsx
import { ARCameraView, mediaPipeProvider } from "react-native-ar-effects";
import { useEffect } from "react";
import { StyleSheet } from "react-native";

function HostCamera() {
  useEffect(() => {
    let offFrame: () => void = () => {};
    let offLost: () => void = () => {};
    mediaPipeProvider
      .start({ cameraPosition: "front", maxFps: 15, maxFaces: 1 })
      .then(() => {
        offFrame = mediaPipeProvider.onFrame((frame) => {
          // Forward payloadFromFrame(frame, indices, mirrored) to viewers.
        });
        offLost = mediaPipeProvider.onFaceLost(({ faceId }) => {
          // Clear local face state.
        });
      });
    return () => {
      offFrame();
      offLost();
      void mediaPipeProvider.stop();
    };
  }, []);

  return <ARCameraView style={StyleSheet.absoluteFill} />;
}
```

Viewer — pin a gift to the tracked face (`viewSize` comes from the video
view's `onLayout`; `liveSocket` is your app's socket):

```tsx
import {
  AnchoredGiftOverlay,
  GOLDEN_ORB_GIFT,
  LandmarkStreamConsumer,
} from "react-native-ar-effects";

const consumer = useMemo(() => new LandmarkStreamConsumer(), []);
useEffect(() => liveSocket.on("face", (p) => consumer.handlePayload(p)), []);

<AnchoredGiftOverlay
  consumer={consumer}
  effect={GOLDEN_ORB_GIFT}
  videoSize={{ width: 720, height: 1280 }}
  viewSize={viewSize}
  resizeMode="cover"
/>;
```

Host — apply a pre-encode filter (viewers see it in the encoded video,
not as a preview-only overlay):

```ts
import {
  CAT_EARS,
  LiveKitFilterAdapter,
  NativeFilterBridge,
} from "react-native-ar-effects";

const adapter = new LiveKitFilterAdapter(new NativeFilterBridge());
// After the local camera track is published:
if (adapter.isFilterable(localVideoTrack)) {
  await adapter.applyFilter(localVideoTrack, CAT_EARS);
  await adapter.clearFilter(localVideoTrack);
}
```

Host filters need the LiveKit React Native fork's video-effect track
(`@livekit/react-native-webrtc` 144.x — stock WebRTC has no
`_setVideoEffects`); otherwise `applyFilter` throws
`FilterNotSupportedError`. Full guides: `docs/INTEGRATION.md`.

### What ships (M5 publish story)

- `dist/` — compiled JS + TypeScript declarations, built by
  `npm run build` (`tsc`, strict). `main` points at `dist/index.js` and
  `types` at `dist/index.d.ts`, so Node, bundlers, and TypeScript
  consumers resolve compiled output. Source-ship alone was rejected:
  a `.ts` entry point is not resolvable by plain Node/bundler tooling,
  and it would force every consumer to compile the library under their
  own `tsconfig`.
- `src/` — also ships, because the `react-native` field points Metro at
  `src/index.ts`: React Native apps keep bundling TS source under the
  consumer's Babel config (which is what compiles the Reanimated
  worklets), exactly as the example app does today. No behavior change
  for RN consumers.
- Native code and the config plugin ship too: `ios/`, `android/`,
  `app.plugin.js`, `ARFaceEffects.podspec`.
- Publish exclusions live in exactly one place, `packages/.npmignore`
  (unit tests only) — there is no `files` field to conflict with it.
  Publishing runs from `packages/`, so `example/` and `docs/` never
  enter the tarball. `dist/` is built fresh at publish time
  (`prepublishOnly` / the publish workflow) and is never committed.
- Version stays `0.1.0`: pre-1.0 honestly signals the API may change.

## Why open-source

Commercial face-AR SDKs (Banuba, DeepAR, and friends) do this job well — and
charge per-user licensing for it. Face detection itself is a solved problem
in the open: Google's MediaPipe Face Landmarker (Apache 2.0) gives 478 3D
face landmarks on-device for free, and ML Kit / Apple Vision cover the
platform-native fallback. What the open-source world has *not* had is the
glue: a single provider interface, a landmark-stream format for live video,
a viewer-side anchor renderer, and a pre-encode filter compositor that plugs
into a real live pipeline. This project is that glue, in the open, so any
creator app can ship TikTok-grade live gifts and filters without a
per-user bill.

## Status

**M1 + M2 + M3 landed, M4 built to PR (this branch).** The repository now contains:

- `packages/src/` — the `DetectionProvider` interface, core types, the
  MediaPipe JS wrapper (`mediapipe-provider.ts`), the `ARCameraView`
  preview component, and the M2 viewer stack: `LandmarkStreamConsumer`
  + `AnchorTracker` (EMA smoothing, 1500ms loss threshold),
  coordinate mapping (mirror + cover/contain), and the
  `AnchoredGiftOverlay` component (Reanimated shared values, no
  React re-render per frame).
- `packages/src/` (M4 additions) — effects catalogue + validation:
  `catalogue.ts` (16 data-defined effects: 13 filters + 3 gifts),
  `catalogue-assets.ts` (self-contained 128×128 PNG gift artwork as
  data URIs), `effect-validation.ts` (schema validator — fails loud
  at load, never silently at render), and tests for validation +
  catalogue integrity. No new dependencies.
- `packages/src/` (M3 additions) — host-side pre-encode filters:
  `HostFilterPipeline` + filter renderer (data-defined shapes +
  grade, sensor-space geometry) + performance governor (drop /
  bypass / probe, never blocks the encoder) + `LiveKitFilterAdapter`
  (fork VideoEffect registry, processor name `ar-effects-filter`) +
  two sample filters (Golden Shades, Warm Sunset).
- `packages/ios/` — Swift native module (MediaPipe Face Landmarker,
  VIDEO mode, CPU delegate) + shared camera session + preview view,
  with the `face_landmarker.task` model vendored as a pod resource.
  M3 adds `ARFilterProcessor` (fork VideoEffect processor: CoreImage
  grade + CoreGraphics shapes, own MediaPipe detection on track
  frames) + `ARFilterModule` bridge.
- `packages/android/` — Kotlin native module (MediaPipe Face
  Landmarker via CameraX) + shared camera session + preview view,
  with the model vendored as an asset. M3 adds `ARFilterProcessor`
  (fork VideoFrameProcessor: YuvConverter texture→I420 + Canvas
  grade/shapes) + `ARFilterModule` bridge.
- `packages/app.plugin.js` — minimal Expo config plugin (camera
  permission only; autolinking handles the native wiring). M3 needs
  NO plugin change.
- `example/` — Expo app: native preview + live landmark dots + face
  count + FPS, plus an M2 mock mode (scripted face path with a gift
  pinned to it, no camera needed), plus an M4 effect picker: camera mode browses the catalogue
  filters and applies the chosen filter to the preview pipeline
  (replacing M3's cycle-through button), mock mode browses the
  catalogue gifts and switches the pinned gift (replacing M3's
  hardcoded mock gift). The filter preview remains an approximation
  of intent, not the encoded output. `yarn.lock` is unchanged by M4:
  no new dependencies.
  Pure-TS unit tests for the M2 stack live in
  `packages/src/__tests__/` (37 tests: serialization, mapping,
  smoothing, fallback); M3 adds tests for the renderer, governor,
  pipeline, adapter, and sample filters.

**On-device verification is owed and is NOT claimed by M1, M2, or M3.**
The sandbox has no phone and no iOS/Android build environment, so the
native code is uncompiled and untested on hardware, and the overlay
has only been exercised in mock mode. The first human device pass must
confirm: dev build installs, camera permission flow, dots track the
face on front and back cameras, the gift stays pinned as the face
moves, fallback shows on real tracking loss, FPS holds near the 15fps
throttle with the overlay rendering, and the camera toggle switches
cleanly. M3 additionally owes, at M5: a real-phone filtered LiveKit
publish (viewers see the filter), FPS under filter load, and the
first-build Gradle/CocoaPods resolution of the fork wiring. M4
additionally owes: real-phone catalogue browsing, filter preview
and gift preview from the picker, and FPS with catalogue effects
applied. Do not ship this to users until that pass is green.

## Roadmap

- **M1 — Detection provider + example app.** MediaPipe Face Landmarker
  implemented (the single primary provider for M1); ML Kit and Apple
  Vision remain specified fallbacks for later milestones. Example app
  shows live landmarks. See the spike record in `ARCHITECTURE.md`.
- **M2 — Viewer-side gift anchoring.** Landmark stream over the live socket;
  viewers pin gift overlays to streamed anchors, with fallback to
  banner/stage when tracking is lost.
- **M3 — Host-side pre-encode filters.** Fork VideoEffect processor
  (not a custom capturer — see the M3 spike record in
  `ARCHITECTURE.md`) + LiveKit adapter + native compositors, so a
  host's filter reaches every viewer through the encoded video. The
  example app previews filter intent over the camera; true filtered
  publishing is proven at M5.
- **M4 — Effects catalogue + docs.** A starter set of data-defined filters
  and gift effects, plus integration guides.
- **M5 — npm publish prep (this PR) + publish.** Publish prep (dist build, manual publish workflow, install docs) lands here; the actual publish waits on an npm credential — see the PR body. Version stays 0.1.0.

See `ARCHITECTURE.md` for the full spec and `CONTRIBUTING.md` to help.
Docs: `docs/API.md` (providers, anchor tracker, overlay, filter
pipeline, LiveKit adapter, catalogue/validation), `docs/EFFECT_AUTHORING.md`
(how a third party defines an effect in data, with a worked example),
`docs/INTEGRATION.md` (install, config plugin, provider setup, host
filters, viewer anchoring).

## License

Apache 2.0 — see `LICENSE`.
