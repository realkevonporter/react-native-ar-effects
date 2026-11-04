/**
 * The M4 effects catalogue — every effect is DATA, never a component.
 *
 * Layout: filters (pre-encode, host-side) first, then gifts
 * (viewer-overlay). The two M3 samples open the catalogue; everything
 * after them is new in M4. Every entry carries a stable id, display
 * name, formatVersion (schema version, always 1 in M4), its own
 * version (starting at 1), and at least one tag. All entries pass
 * validateEffectDefinition (see __tests__/catalogue.test.ts).
 *
 * What the renderers can actually draw (do not add effects outside
 * this envelope without extending a renderer first):
 *  - Pre-encode filters: ellipse / rect / line / polyline shapes with
 *    #rrggbb colors, fill or stroke, anchored to MediaPipe-478
 *    landmarks or face bounds — plus full-frame color grades. This
 *    is what both native compositors implement (iOS CoreImage +
 *    CoreGraphics, Android I420 + Canvas).
 *  - Viewer gifts: image assets rendered by AnchoredGiftOverlay, or
 *    no assets (name pill). Lottie / SVGA / video-alpha assets are
 *    valid data but render as name pills until player dependencies
 *    land — the catalogue therefore ships image gifts only.
 *  - Animated gift artwork: NOT in M4. A TikTok-grade animated gift
 *    (roaring lion, swimming whale) is animator-made artwork, not
 *    something this catalogue generates. The gift entries here are
 *    simple geometric images; the animated catalogue is later work.
 *
 * Gift artwork lives in catalogue-assets.ts as self-contained
 * data-URI PNGs (no Metro asset resolution, no network fetch).
 */

import {
  CAT_EARS_GOLD_PNG,
  CROWN_ROYAL_GOLD_PNG,
  GOLD_ORB_PNG,
  LOVE_HEART_PNG,
  NERD_GLASSES_GOLD_PNG,
  SUPER_STAR_PNG,
} from "./catalogue-assets";
import { GOLDEN_SHADES, WARM_SUNSET } from "./sample-filters";
import type { EffectDefinition } from "./types";

/** Funny face filters — landmark-anchored shapes, pre-encode. */
export const CAT_EARS: EffectDefinition = {
  id: "cat-ears",
  kind: "filter",
  name: "Cat Ears",
  formatVersion: 1,
  version: 2,
  tags: ["funny", "animal", "ears"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "above-head",
      landmarkIndices: [10],
      scaleToFace: 1.25,
      offset: { x: 0, y: 0 },
    },
  ],
  shapes: [
    {
      kind: "image",
      anchor: 0,
      asset: 0,
    },
  ],
    assets: [
    {
      uri: CAT_EARS_GOLD_PNG,
      kind: "image",
      width: 768,
      height: 453,
    },
  ],
  trackingLostFallback: "hide",
};

export const BUNNY_EARS: EffectDefinition = {
  id: "bunny-ears",
  kind: "filter",
  name: "Bunny Ears",
  formatVersion: 1,
  version: 1,
  tags: ["funny", "animal", "ears"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "above-head",
      landmarkIndices: [10],
      scaleToFace: 1.1,
      offset: { x: 0, y: 0 },
    },
  ],
  shapes: [
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.18, y: 0.0, width: 0.22, height: 0.75 },
      color: "#f5f5f5",
      fill: true,
    },
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.6, y: 0.0, width: 0.22, height: 0.75 },
      color: "#f5f5f5",
      fill: true,
    },
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.24, y: 0.15, width: 0.1, height: 0.45 },
      color: "#ffb6c1",
      fill: true,
    },
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.66, y: 0.15, width: 0.1, height: 0.45 },
      color: "#ffb6c1",
      fill: true,
    },
  ],
  assets: [],
  trackingLostFallback: "hide",
};

export const CROWN_ROYAL: EffectDefinition = {
  id: "crown-royal",
  kind: "filter",
  name: "Royal Crown",
  formatVersion: 1,
  version: 2,
  tags: ["funny", "crown", "royal"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "above-head",
      landmarkIndices: [10],
      scaleToFace: 1.1,
      offset: { x: 0, y: 0 },
    },
  ],
  shapes: [
    {
      kind: "image",
      anchor: 0,
      asset: 0,
    },
  ],
    assets: [
    {
      uri: CROWN_ROYAL_GOLD_PNG,
      kind: "image",
      width: 768,
      height: 503,
    },
  ],
  trackingLostFallback: "hide",
};

export const HALO_ANGEL: EffectDefinition = {
  id: "halo-angel",
  kind: "filter",
  name: "Angel Halo",
  formatVersion: 1,
  version: 1,
  tags: ["funny", "angel", "halo"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "above-head",
      landmarkIndices: [10],
      scaleToFace: 1.0,
      offset: { x: 0, y: 0 },
    },
  ],
  shapes: [
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.2, y: 0.05, width: 0.6, height: 0.25 },
      color: "#ffd700",
      fill: false,
      lineWidth: 0.012,
    },
  ],
  assets: [],
  trackingLostFallback: "hide",
};

export const NERD_GLASSES: EffectDefinition = {
  id: "nerd-glasses",
  kind: "filter",
  name: "Nerd Glasses",
  formatVersion: 1,
  version: 2,
  tags: ["funny", "glasses"],
  renderPath: "pre-encode",
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
      kind: "image",
      anchor: 0,
      asset: 0,
    },
  ],
    assets: [
    {
      uri: NERD_GLASSES_GOLD_PNG,
      kind: "image",
      width: 768,
      height: 272,
    },
  ],
  trackingLostFallback: "hide",
};

export const CLOWN_NOSE: EffectDefinition = {
  id: "clown-nose",
  kind: "filter",
  name: "Clown Nose",
  formatVersion: 1,
  version: 1,
  tags: ["funny", "clown", "nose"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "on-face",
      landmarkIndices: [1],
      scaleToFace: 0.4,
      offset: { x: 0, y: 0 },
    },
  ],
  shapes: [
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.15, y: 0.15, width: 0.7, height: 0.7 },
      color: "#ff2222",
      fill: true,
    },
  ],
  assets: [],
  trackingLostFallback: "hide",
};

export const KITTY_WHISKERS: EffectDefinition = {
  id: "kitty-whiskers",
  kind: "filter",
  name: "Kitty Whiskers",
  formatVersion: 1,
  version: 1,
  tags: ["funny", "animal", "whiskers"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "on-face",
      landmarkIndices: [1],
      scaleToFace: 0.9,
      offset: { x: 0, y: 0 },
    },
  ],
  shapes: [
    {
      kind: "line",
      anchor: 0,
      points: [
        { x: 0.05, y: 0.35 },
        { x: 0.35, y: 0.45 },
      ],
      color: "#1a1a1a",
      lineWidth: 0.006,
    },
    {
      kind: "line",
      anchor: 0,
      points: [
        { x: 0.05, y: 0.5 },
        { x: 0.35, y: 0.5 },
      ],
      color: "#1a1a1a",
      lineWidth: 0.006,
    },
    {
      kind: "line",
      anchor: 0,
      points: [
        { x: 0.05, y: 0.65 },
        { x: 0.35, y: 0.55 },
      ],
      color: "#1a1a1a",
      lineWidth: 0.006,
    },
    {
      kind: "line",
      anchor: 0,
      points: [
        { x: 0.95, y: 0.35 },
        { x: 0.65, y: 0.45 },
      ],
      color: "#1a1a1a",
      lineWidth: 0.006,
    },
    {
      kind: "line",
      anchor: 0,
      points: [
        { x: 0.95, y: 0.5 },
        { x: 0.65, y: 0.5 },
      ],
      color: "#1a1a1a",
      lineWidth: 0.006,
    },
    {
      kind: "line",
      anchor: 0,
      points: [
        { x: 0.95, y: 0.65 },
        { x: 0.65, y: 0.55 },
      ],
      color: "#1a1a1a",
      lineWidth: 0.006,
    },
  ],
  assets: [],
  trackingLostFallback: "hide",
};

export const HANDLEBAR_MUSTACHE: EffectDefinition = {
  id: "handlebar-mustache",
  kind: "filter",
  name: "Handlebar Mustache",
  formatVersion: 1,
  version: 1,
  tags: ["funny", "mustache"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [
    {
      placement: "on-face",
      landmarkIndices: [1],
      scaleToFace: 0.6,
      offset: { x: 0, y: 0.14 },
    },
  ],
  shapes: [
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.05, y: 0.3, width: 0.45, height: 0.4 },
      color: "#3b2314",
      fill: true,
    },
    {
      kind: "ellipse",
      anchor: 0,
      rect: { x: 0.5, y: 0.3, width: 0.45, height: 0.4 },
      color: "#3b2314",
      fill: true,
    },
  ],
  assets: [],
  trackingLostFallback: "hide",
};

/** Full-frame grades — face-independent, apply with or without a face. */
export const COOL_MINT: EffectDefinition = {
  id: "cool-mint",
  kind: "filter",
  name: "Cool Mint",
  formatVersion: 1,
  version: 1,
  tags: ["grade", "cool"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [],
  grade: { warmth: -0.35, brightness: 0.02, saturation: 1.1, contrast: 1.02 },
  assets: [],
  trackingLostFallback: "hide",
};

export const NOIR: EffectDefinition = {
  id: "noir",
  kind: "filter",
  name: "Noir",
  formatVersion: 1,
  version: 1,
  tags: ["grade", "black-and-white"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [],
  grade: { warmth: 0, brightness: -0.02, saturation: 0, contrast: 1.25 },
  assets: [],
  trackingLostFallback: "hide",
};

export const VIVID_POP: EffectDefinition = {
  id: "vivid-pop",
  kind: "filter",
  name: "Vivid Pop",
  formatVersion: 1,
  version: 1,
  tags: ["grade", "vivid"],
  renderPath: "pre-encode",
  animation: { mode: "loop" },
  anchors: [],
  grade: { warmth: 0.1, brightness: 0.03, saturation: 1.5, contrast: 1.1 },
  assets: [],
  trackingLostFallback: "hide",
};

/** Viewer gifts — pinned to the face by AnchoredGiftOverlay. */
export const GOLDEN_ORB_GIFT: EffectDefinition = {
  id: "golden-orb",
  kind: "gift",
  name: "Golden Orb",
  formatVersion: 1,
  version: 1,
  tags: ["gift", "orb", "gold"],
  renderPath: "viewer-overlay",
  animation: { mode: "once", durationMs: 5000 },
  anchors: [
    {
      placement: "above-head",
      landmarkIndices: [10],
      scaleToFace: 1.0,
      offset: { x: 0, y: -0.05 },
    },
  ],
  assets: [{ uri: GOLD_ORB_PNG, kind: "image", width: 128, height: 128 }],
  trackingLostFallback: "banner",
};

export const LOVE_HEART_GIFT: EffectDefinition = {
  id: "love-heart",
  kind: "gift",
  name: "Love Heart",
  formatVersion: 1,
  version: 1,
  tags: ["gift", "heart", "love"],
  renderPath: "viewer-overlay",
  animation: { mode: "once", durationMs: 5000 },
  anchors: [
    {
      placement: "follow",
      landmarkIndices: [1],
      scaleToFace: 0.85,
      offset: { x: 0, y: 0 },
    },
  ],
  assets: [{ uri: LOVE_HEART_PNG, kind: "image", width: 128, height: 128 }],
  trackingLostFallback: "stage",
};

export const SUPER_STAR_GIFT: EffectDefinition = {
  id: "super-star",
  kind: "gift",
  name: "Super Star",
  formatVersion: 1,
  version: 1,
  tags: ["gift", "star"],
  renderPath: "viewer-overlay",
  animation: { mode: "once", durationMs: 5000 },
  anchors: [
    {
      placement: "follow",
      landmarkIndices: [1],
      scaleToFace: 0.9,
      offset: { x: 0, y: 0 },
    },
  ],
  assets: [{ uri: SUPER_STAR_PNG, kind: "image", width: 128, height: 128 }],
  trackingLostFallback: "banner",
};

/** All catalogue filters (pre-encode), in display order. */
export const CATALOGUE_FILTERS: EffectDefinition[] = [
  GOLDEN_SHADES,
  WARM_SUNSET,
  CAT_EARS,
  BUNNY_EARS,
  CROWN_ROYAL,
  HALO_ANGEL,
  NERD_GLASSES,
  CLOWN_NOSE,
  KITTY_WHISKERS,
  HANDLEBAR_MUSTACHE,
  COOL_MINT,
  NOIR,
  VIVID_POP,
];

/** All catalogue gifts (viewer-overlay), in display order. */
export const CATALOGUE_GIFTS: EffectDefinition[] = [
  GOLDEN_ORB_GIFT,
  LOVE_HEART_GIFT,
  SUPER_STAR_GIFT,
];

/** The full catalogue: filters first, then gifts. */
export const CATALOGUE: EffectDefinition[] = [
  ...CATALOGUE_FILTERS,
  ...CATALOGUE_GIFTS,
];

/**
 * Look up a catalogue effect by id. Throws on an unknown id — a
 * missing effect is a load-time error, never a silent empty render.
 */
export function getEffectById(id: string): EffectDefinition {
  const effect = CATALOGUE.find((entry) => entry.id === id);
  if (!effect) {
    throw new Error(`Unknown catalogue effect id "${id}"`);
  }
  return effect;
}

/** All catalogue effects carrying a given tag. */
export function getEffectsByTag(tag: string): EffectDefinition[] {
  return CATALOGUE.filter((entry) => entry.tags.includes(tag));
}
