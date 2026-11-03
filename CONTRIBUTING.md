# Contributing

Thanks for helping build an open face-AR SDK for live streaming. This
project is early — the architecture spec (`ARCHITECTURE.md`) is the best
place to start before writing code.

## How to help

- **Issues welcome** — bugs, device reports (especially Android device +
  OS version for anything camera-related), and effect ideas.
- **Pull requests welcome** — please keep them focused, and note which
  milestone they belong to (M1 detection, M2 gift anchoring, M3 pre-encode
  filters, M4 catalogue/docs, M5 publish).
- **Effect authors** — effects are data, not code (see `ARCHITECTURE.md`
  §5). A new filter or gift effect is a new `EffectDefinition` plus its
  assets; you do not need to touch SDK code.

## Ground rules

- Apache 2.0 throughout. By contributing, you agree your work is licensed
  under the same terms.
- No proprietary SDK code, no decompiled commercial effects, no assets you
  do not have the rights to share.
- Device-test camera work on a real phone before opening a PR — emulators
  do not exercise the camera pipeline this SDK depends on.
- Keep secrets out of the repo: no API keys, no private endpoints, no
  internal URLs.

## Code of conduct

Be kind, be direct, assume good intent. Maintainers may close threads
that are not.
