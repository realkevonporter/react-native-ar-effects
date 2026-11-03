# AR Effects example app (M1 + M2)

Expo app showing what the MediaPipe provider sees and what the M2
viewer overlay does: the native camera preview with live landmark
dots overlaid, plus face count and FPS — and a mock mode that
demonstrates gift anchoring with no camera at all.

## What it shows

- `ARCameraView` — the provider's native camera preview (the provider
  owns the camera session; do not add a second camera component such
  as expo-camera, or the two sessions will fight for the camera).
- Landmark dots — a sampled subset of the MediaPipe-478 mesh (every
  12th point plus nose/forehead/chin/eye/mouth anchors), positioned from
  normalized 0..1 coordinates. Front-camera dots flip x -> 1 - x because
  the preview is mirrored while sensor coordinates are not.
- Face count + FPS (rolling 1-second window of provider events).
- Mock demo (M2, "Mock demo" button) — scripted `LandmarkPayload`s
  animate a face along a Lissajous path while `AnchoredGiftOverlay`
  pins a Golden Orb gift above its head. No camera, no phone needed.
  Pause stops the payload stream so the 1.5s fallback banner
  demonstrates; Resume re-anchors. Mock mode never starts the
  provider (it releases the camera first if a session is running).

## Run it

```sh
yarn install
npx expo prebuild
npx expo run:ios      # or: npx expo run:android
```

**A dev build is required.** Native modules do not run in Expo Go, so
`expo start` alone shows a red screen about the missing native module
— that is expected until a dev build is installed.

Camera permission comes from the library's own Expo config plugin
(`react-native-ar-effects` in app.json): NSCameraUsageDescription on
iOS, CAMERA permission on Android. If plugin resolution ever fails,
declare the same two entries directly in app.json instead.

**Babel note (M2).** `babel.config.js` includes
`react-native-reanimated/plugin` LAST. The SDK ships TypeScript source
whose Reanimated worklets compile under the consumer's Babel config,
so any app using `AnchoredGiftOverlay` needs this plugin.

## Lockfile

`yarn.lock` (yarn v1) is committed. It was generated from registry
metadata with every integrity hash verified by downloading the
tarball and computing sha512, and a full pattern check proving every
dependency range has a key (entries are keyed by requested range,
never exact version). M1 deliberately shipped without one; M2 lands
it.

## What is NOT proven yet

On-device behavior is owed for M1 + M2: a dev build on a real phone,
front and back camera, dots tracking the face as it moves, the gift
staying pinned as the face moves, fallback showing on real tracking
loss, FPS holding near the 15fps throttle with the overlay rendering,
and the camera toggle switching cleanly. The sandbox has no phone and
no iOS/Android build environment, so none of that is claimed by this
PR — it is the first checklist item for a human device pass. A full
Gradle build and CocoaPods install/resolution are likewise owed (pins
were verified against the registries, but no native build ran here).
