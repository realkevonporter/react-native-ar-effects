/**
 * M3 sample filters — data only, no code. The catalogue is M4; M3
 * ships exactly two samples so the pipeline, the adapter, and the
 * example preview have real EffectDefinitions to exercise.
 *
 * Both use renderPath "pre-encode" and kind "filter": they are meant
 * for the host-side compositor, never the viewer overlay. Sound is
 * unwired (soundUri absent) — audio policy belongs to the host app's
 * gift/live system, as in M2. Animation mode is "loop": filters
 * persist while active, they are not one-shot gifts.
 *
 * GOLDEN_SHADES — landmark-anchored overlay: two gold lenses over
 * the eyes (MediaPipe indices 33 = left eye outer corner, 263 =
 * right eye outer corner in the 478 map) joined by a bridge line.
 * The anchor rect spans both eye corners (scaleToFace 1.15 of the
 * face bounds, centered on the eye centroid); the lens sub-rects
 * sit inside it. Shapes hide when the face is lost
 * (trackingLostFallback "hide"); there is no grade, so a lost face
 * means a clean frame.
 *
 * WARM_SUNSET — full-frame color grade, no anchors, no shapes: it
 * applies with or without a face, which is the point of the sample
 * (grades are the face-independent half of M3).
 */

import { EffectDefinition } from "./types";

export const GOLDEN_SHADES: EffectDefinition = {
  id: "golden-shades",
  kind: "filter",
  name: "Golden Shades",
  renderPath: "pre-encode",
  // Filters persist while active: loop mode (no timed expiry).
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "on-face",
      landmarkIndices: [33, 263],
      scaleToFace: 1.15,
      offset: { x: 0, y: 0 },
    },
  ],
  shapes: [
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.02, y: 0.25, width: 0.44, height: 0.5 },
      color: "#d4af37",
      fill: false,
      lineWidth: 0.008,
    },
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.54, y: 0.25, width: 0.44, height: 0.5 },
      color: "#d4af37",
      fill: false,
      lineWidth: 0.008,
    },
    {
      kind: "line",
      anchor: 0,
      points: [
        { x: 0.46, y: 0.5 },
        { x: 0.54, y: 0.5 },
      ],
      color: "#d4af37",
      lineWidth: 0.008,
    },
  ],
  assets: [],
  trackingLostFallback: "hide",
};

export const WARM_SUNSET: EffectDefinition = {
  id: "warm-sunset",
  kind: "filter",
  name: "Warm Sunset",
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [],
  grade: {
    warmth: 0.3,
    brightness: 0.04,
    saturation: 1.18,
    contrast: 1.06,
  },
  assets: [],
  trackingLostFallback: "hide",
};

export const SAMPLE_FILTERS: EffectDefinition[] = [GOLDEN_SHADES, WARM_SUNSET];
