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

**Early scaffold.** This repository currently contains:

- `ARCHITECTURE.md` — the full design spec (providers, landmark-stream
  format, overlay renderer, pre-encode compositing, effects format,
  milestones).
- `packages/` — the package skeleton: core TypeScript types and the
  `DetectionProvider` interface. **No native code yet** — detection
  provider implementations land in M1.

Nothing here is production-ready yet. Do not ship this to users until M1
lands and the example app shows live landmarks on a real phone.

## Roadmap

- **M1 — Detection providers + example app.** MediaPipe Face Landmarker as
  the primary provider, ML Kit as fallback, Apple Vision on iOS, behind one
  `DetectionProvider` interface. Example app shows live landmarks.
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
