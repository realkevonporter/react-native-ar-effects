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

**M1 + M2 landed (this branch).** The repository now contains:

- `packages/src/` — the `DetectionProvider` interface, core types, the
  MediaPipe JS wrapper (`mediapipe-provider.ts`), the `ARCameraView`
  preview component, and the M2 viewer stack: `LandmarkStreamConsumer`
  + `AnchorTracker` (EMA smoothing, 1500ms loss threshold),
  coordinate mapping (mirror + cover/contain), and the
  `AnchoredGiftOverlay` component (Reanimated shared values, no
  React re-render per frame).
- `packages/ios/` — Swift native module (MediaPipe Face Landmarker,
  VIDEO mode, CPU delegate) + shared camera session + preview view,
  with the `face_landmarker.task` model vendored as a pod resource.
- `packages/android/` — Kotlin native module (MediaPipe Face
  Landmarker via CameraX) + shared camera session + preview view,
  with the model vendored as an asset.
- `packages/app.plugin.js` — minimal Expo config plugin (camera
  permission only; autolinking handles the native wiring).
- `example/` — Expo app: native preview + live landmark dots + face
  count + FPS, plus an M2 mock mode (scripted face path with a gift
  pinned to it, no camera needed) and a committed `yarn.lock`.
  Pure-TS unit tests for the M2 stack live in
  `packages/src/__tests__/` (37 tests: serialization, mapping,
  smoothing, fallback).

**On-device verification is owed and is NOT claimed by M1 or M2.**
The sandbox has no phone and no iOS/Android build environment, so the
native code is uncompiled and untested on hardware, and the overlay
has only been exercised in mock mode. The first human device pass must
confirm: dev build installs, camera permission flow, dots track the
face on front and back cameras, the gift stays pinned as the face
moves, fallback shows on real tracking loss, FPS holds near the 15fps
throttle with the overlay rendering, and the camera toggle switches
cleanly. Do not ship this to users until that pass is green.

## Roadmap

- **M1 — Detection provider + example app.** MediaPipe Face Landmarker
  implemented (the single primary provider for M1); ML Kit and Apple
  Vision remain specified fallbacks for later milestones. Example app
  shows live landmarks. See the spike record in `ARCHITECTURE.md`.
- **M2 — Viewer-side gift anchoring.** Landmark stream over the live socket;
  viewers pin gift overlays to streamed anchors, with fallback to
  banner/stage when tracking is lost.
- **M3 — Host-side pre-encode filters.** Custom camera capturer feeding
  frames through detection + filter render *before* encode, bridged into
  LiveKit React Native. This is the hard phase.
- **M4 — Effects catalogue + docs.** A starter set of data-defined filters
  and gift effects, plus integration guides.
- **M5 — npm publish.** `react-native-ar-effects` on npm, versioned releases.

See `ARCHITECTURE.md` for the full spec and `CONTRIBUTING.md` to help.

## License

Apache 2.0 — see `LICENSE`.
