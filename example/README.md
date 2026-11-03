# AR Effects example app (M1)

Expo app showing what the MediaPipe provider sees: the native camera
preview with live landmark dots overlaid, plus face count and FPS.

## What it shows

- `ARCameraView` — the provider's native camera preview (the provider
  owns the camera session; do not add a second camera component such
  as expo-camera, or the two sessions will fight for the camera).
- Landmark dots — a sampled subset of the MediaPipe-478 mesh (every
  12th point plus nose/forehead/chin/eye/mouth anchors), positioned from
  normalized 0..1 coordinates. Front-camera dots flip x -> 1 - x because
  the preview is mirrored while sensor coordinates are not.
- Face count + FPS (rolling 1-second window of provider events).

## Run it

No lockfile is committed for M1 (deliberate — see below), so install
fresh and let Expo align versions:

```sh
npm install
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

## What is NOT proven yet

On-device behavior is owed for M1: a dev build on a real phone, front
and back camera, dots tracking the face as it moves, FPS holding near
the 15fps throttle, and the camera toggle switching cleanly. The
sandbox has no phone and no iOS/Android build environment, so none of
that is claimed by this PR — it is the first checklist item for a
human device pass.

## Why no lockfile

M1 ships the example without a committed lockfile on purpose. The
sandbox cannot run a full `npm install` reliably (its egress proxy
mangles some registry metadata), so any hand-written lockfile would be
unverified. The example's dependency set is tiny (expo, react,
react-native, the local package), and `npm install` at build time
resolves it. A lockfile lands with M2, generated on a machine with a
real toolchain.
