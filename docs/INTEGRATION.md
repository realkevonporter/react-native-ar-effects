# Integration guide

Adopt `react-native-ar-effects` in a live-streaming app from docs
alone. This guide covers install, config plugin, provider setup, host
filters, and viewer anchoring. On-device verification is owed for
M1–M3 (see the repo README) — run the example app on a real phone
before shipping.

## Install

**At M5, the package lands on npm.** Until then (M4 and earlier), the
only honest install path is the example app's: a file path into the
repo's package directory.

```json
// package.json (pre-M5 only — the example app uses this today)
{
  "dependencies": {
    "react-native-ar-effects": "file:../packages"
  }
}
```

After M5:

```sh
npm install react-native-ar-effects
```

Peer dependencies (M4): `react-native` and `react-native-reanimated`
(the viewer overlay positions effects with Reanimated shared values —
no React re-render per frame). The example app pins
`react-native-reanimated` 4.5.1 with `react-native-reanimated/plugin`
**last** in its Babel plugin list. The SDK adds no other runtime
dependencies; MediaPipe Tasks Vision, CameraX, and the WebRTC fork come
through the native wiring below.

## Config plugin

The package ships a minimal Expo config plugin
(`packages/app.plugin.js`). Add it to your app config:

```json
// app.json
{
  "expo": {
    "plugins": ["react-native-ar-effects"]
  }
}
```

The plugin does **one thing**: camera permission. iOS gets
`NSCameraUsageDescription`; Android gets the `CAMERA` permission.
Autolinking handles the podspec / Gradle wiring. M3's LiveKit
filtering needs **no plugin change** — the fork VideoEffect registry
is registered at runtime by the adapter.

> If you are not on Expo, apply the same two permission entries
> manually and let autolinking wire the native modules.

## Provider setup (detection + preview)

The detection provider owns the camera session, so preview through
`<ARCameraView />` — never a second camera component.

```tsx
import {
  ARCameraView,
  mediaPipeProvider,
} from "react-native-ar-effects";
import { StyleSheet } from "react-native";

function HostCamera() {
  useEffect(() => {
    let offFrame: () => void = () => {};
    let offLost: () => void = () => {};
    mediaPipeProvider
      .start({ cameraPosition: "front", maxFps: 15, maxFaces: 1 })
      .then(() => {
        offFrame = mediaPipeProvider.onFrame((frame) => {
          // 1. Forward landmarks to viewers (see below).
          // 2. Feed the filter pipeline for preview (see below).
        });
        offLost = mediaPipeProvider.onFaceLost(({ faceId }) => {
          // Clear local face state; the pipeline hides shapes.
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

Landmark coordinates are normalized 0..1 sensor space. The
front-camera preview is mirrored, but the coordinates are **not** —
hosts never pre-flip; viewers flip with the payload's `mirrored` flag.

## Host filters (pre-encode, everyone sees them)

Host filters composite into the video **before encode** via the
LiveKit WebRTC fork's VideoEffect registry — not as a preview overlay.
That is the whole point: viewers see the filter in the encoded video,
on any client, with no SDK on their side.

```ts
import {
  LiveKitFilterAdapter,
  NativeFilterBridge,
} from "react-native-ar-effects";

const adapter = new LiveKitFilterAdapter(new NativeFilterBridge());

// After the local camera track is published:
if (adapter.isFilterable(localVideoTrack)) {
  await adapter.applyFilter(localVideoTrack, CAT_EARS);
  // Host picks another filter, or turns it off:
  await adapter.applyFilter(localVideoTrack, WARM_SUNSET);
  await adapter.clearFilter(localVideoTrack);
}
```

Notes and limits (all from the M3 spike record):

- Requires `@livekit/react-native-webrtc` 144.x — the fork exposes
  `_setVideoEffects` on video tracks; stock WebRTC does not. The
  adapter throws `FilterNotSupportedError` otherwise.
- The filtered track uses WebRTC's camera; the native processor runs
  its own MediaPipe detection on track frames. There is no
  frame-injection API in the fork, so the M1 session's frames are not
  reused here.
- One filtered camera track at a time; screen-share tracks cannot be
  filtered. Android silently skips unknown processor names, so the
  adapter registers before applying and fails loud on registration
  failure.
- Filtered publishing is proven at M5 (real-phone filtered LiveKit
  publish, FPS under filter load). The example app's filter preview
  over the camera is an approximation of intent, not the encoded
  output — see `example/FilterPreviewOverlay.tsx`.
- Filter data is validated at `applyFilter` time: bad data throws
  before anything reaches native. Performance is guarded by the
  governor (over-budget frames pass through unfiltered; sustained
  over-budget bypasses the filter with `onFilterBypassed`).

## Viewer anchoring (gifts following the face)

The SDK is transport-agnostic: it defines the payload, not the socket.
Your app wires payload JSON to whatever live socket it already has.

```ts
// Host side — shrink each frame to the indices the active effects need.
import { payloadFromFrame } from "react-native-ar-effects";

mediaPipeProvider.onFrame((frame) => {
  const payload = payloadFromFrame(
    frame,
    effect.anchors.flatMap((a) => a.landmarkIndices),
    cameraPosition === "front", // mirrored flag for viewers
  );
  liveSocket.send(payload);
});
mediaPipeProvider.onFaceLost(({ faceId }) => {
  liveSocket.send({ type: "face.lost", faceId, timestampMs: Date.now() });
});
```

```tsx
// Viewer side — one consumer per room, one overlay per gift.
import {
  AnchoredGiftOverlay,
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
  onFallback={(mode) => { /* banner | stage | hide */ }}
/>
```

- Send only the landmark indices the active effects anchor to — never
  the full 478-point mesh. The consumer trusts only the latest
  payload's indices, so stale points never anchor a gift.
- Smoothing is per-index EMA (default α = 0.35, ~5 frames to settle);
  gifts snap exactly on first sight and on reappearance after loss, so
  they never glide from stale positions.
- On tracking loss (explicit `face.lost` or > 1500ms gap) the overlay
  renders the effect's `trackingLostFallback` instead of vanishing or
  freezing, and re-anchors automatically when the face returns.
- Only the effect's first anchor is used in M4. Multi-anchor effects
  land later.
- Sound (`soundUri`) is carried, not played — wire it to your app's
  gift audio policy.

## The example app

`example/` is the reference integration and the device-test vehicle:

- **Camera mode** — native preview + live landmark dots + face count +
  FPS + front/back toggle, plus the M4 effect picker: browse
  `CATALOGUE_FILTERS`, tap to apply a filter to the preview pipeline
  (Off restores raw). Dots hide while a filter is active.
- **Mock mode** — scripted face path with a gift pinned to it, no
  camera needed, plus the M4 picker over `CATALOGUE_GIFTS`. Pause
  demonstrates the fallback banner after 1.5s.
- Run it with `yarn install && yarn start` from `example/` (a dev
  build is required — the native modules do not run in Expo Go).

## Performance notes

- Detection throttles to `maxFps` (default 15) — the overlay and the
  filter pipeline are both designed around 15fps landmark updates.
- The filter governor's budget is `1000 / targetFps` (~66ms at 15fps).
  Over-budget frames pass through unfiltered; 8 consecutive
  over-budget frames bypass the filter; a probe frame retries after a
  3s cooldown. The encoder is never blocked by a filter.
- The viewer overlay never re-renders React per frame — positions
  live in Reanimated shared values. FPS with the overlay rendering is
  part of the owed device pass.
