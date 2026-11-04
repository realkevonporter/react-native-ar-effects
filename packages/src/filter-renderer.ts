/**
 * M3 filter renderer — pure TypeScript, no React Native imports.
 *
 * Renders an EffectDefinition into FilterDrawCommands in normalized
 * 0..1 SENSOR space (origin top-left), the same space the native
 * pre-encode compositors draw in. That is the whole point of M3: the
 * geometry computed here is the geometry viewers see in the encoded
 * video, not a viewer-side overlay guess.
 *
 * Mirroring: do NOT mirror here by default. Detection and compositing
 * share the frame's sensor space, so a filter drawn in sensor space
 * lands on the face in the encoded frame. The `mirrored` option exists
 * only for pipelines that mirror frames before compositing (not M3's
 * fork processors) and defaults to false. This is the one coordinate
 * decision that differs from M2's viewer overlay, which mirrors the
 * front camera for the viewer.
 *
 * Grade formula (shared with the native compositors, in this order):
 *   1. warmth:   R *= 1 + 0.2*warmth, B *= 1 - 0.2*warmth
 *   2. saturation: rgb = mix(gray, rgb, saturation) (luminance gray)
 *   3. contrast: rgb = (rgb - 0.5) * contrast + 0.5
 *   4. brightness: rgb += brightness
 *   Clamp to [0, 1] at the end. applyGradeToRgb is the reference
 *   implementation; the native compositors implement the same math.
 *
 * Face rules: grade commands apply whenever the effect has a grade,
 * face or no face. Anchor shapes apply ONLY while a face is tracked
 * (face.status === "tracked"); with no face they are omitted, never
 * drawn at a stale position.
 *
 * Anchor math mirrors M2's computeAssetRect (anchor-tracker.ts):
 * anchor rect width = scaleToFace * bounds.width, height =
 * scaleToFace * bounds.height; above-head bottom-pins the rect at
 * the anchor point, on-face/follow centers it; offsets are in
 * face-width units, x right, y down. Fullscreen anchors cover the
 * whole frame (bounds are ignored).
 */

import {
  EffectAnchor,
  EffectDefinition,
  FaceAnchorState,
  FilterDrawCommand,
  FilterGradeParams,
} from "./types";
import { resolveAnchorPoint } from "./coordinate-mapping";

export const DEFAULT_GRADE: FilterGradeParams = {
  warmth: 0,
  brightness: 0,
  saturation: 1,
  contrast: 1,
};

export const DEFAULT_LINE_WIDTH = 0.008;

/** Fill missing grade fields with neutral defaults. */
export function resolveGradeParams(
  partial?: Partial<FilterGradeParams>,
): FilterGradeParams {
  return { ...DEFAULT_GRADE, ...(partial ?? {}) };
}

/** Parse a #rrggbb color into 0..1 channels. Throws on bad input. */
export function parseHexColor(color: string): {
  r: number;
  g: number;
  b: number;
} {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!match) {
    throw new Error(`Invalid filter color "${color}": expected #rrggbb`);
  }
  const value = parseInt(match[1], 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

/**
 * Reference grade implementation (see module doc for the formula).
 * Input/output channels are 0..1 floats.
 */
export function applyGradeToRgb(
  rgb: { r: number; g: number; b: number },
  params: FilterGradeParams,
): { r: number; g: number; b: number } {
  let { r, g, b } = rgb;
  const w = params.warmth;
  r *= 1 + 0.2 * w;
  b *= 1 - 0.2 * w;
  // Luminance gray (Rec. 601), same weights the native code uses.
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const s = params.saturation;
  r = gray + (r - gray) * s;
  g = gray + (g - gray) * s;
  b = gray + (b - gray) * s;
  const c = params.contrast;
  r = (r - 0.5) * c + 0.5;
  g = (g - 0.5) * c + 0.5;
  b = (b - 0.5) * c + 0.5;
  const br = params.brightness;
  r += br;
  g += br;
  b += br;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

/**
 * Anchor rect in normalized frame space, mirroring M2's asset-rect
 * math. Returns null only for a null face state (callers handle the
 * no-face case before calling). Fullscreen anchors return the full
 * frame regardless of bounds.
 */
export function anchorRectNormalized(
  face: FaceAnchorState,
  anchor: EffectAnchor,
): { x: number; y: number; width: number; height: number } {
  if (anchor.placement === "fullscreen") {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const bounds = face.bounds;
  const faceWidth = bounds.width;
  const width = anchor.scaleToFace * bounds.width;
  const height = anchor.scaleToFace * bounds.height;
  const anchorPoint = resolveAnchorPointNormalized(face, anchor);
  const offsetX = (anchor.offset?.x ?? 0) * faceWidth;
  const offsetY = (anchor.offset?.y ?? 0) * faceWidth;
  if (anchor.placement === "above-head") {
    // Bottom-pin: the rect's bottom edge sits at the anchor point.
    return {
      x: anchorPoint.x - width / 2 + offsetX,
      y: anchorPoint.y - height + offsetY,
      width,
      height,
    };
  }
  // on-face / follow: centered on the anchor point.
  return {
    x: anchorPoint.x - width / 2 + offsetX,
    y: anchorPoint.y - height / 2 + offsetY,
    width,
    height,
  };
}

function mirrorRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: 1 - (rect.x + rect.width),
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Validate a filter effect's M3 fields. Throws on the first problem
 * (bad hex color, anchor index out of range, out-of-range grade,
 * line/polyline without points, impossible geometry). Pipeline
 * setEffect calls this so bad data fails at load time, not mid-frame.
 */
export function validateFilterEffect(effect: EffectDefinition): void {
  const grade = effect.grade;
  if (grade) {
    if (grade.warmth < -1 || grade.warmth > 1) {
      throw new Error(
        `Invalid filter grade warmth ${grade.warmth}: expected [-1, 1]`,
      );
    }
    if (grade.brightness < -1 || grade.brightness > 1) {
      throw new Error(
        `Invalid filter grade brightness ${grade.brightness}: expected [-1, 1]`,
      );
    }
    if (grade.saturation < 0 || grade.saturation > 3) {
      throw new Error(
        `Invalid filter grade saturation ${grade.saturation}: expected [0, 3]`,
      );
    }
    if (grade.contrast < 0 || grade.contrast > 3) {
      throw new Error(
        `Invalid filter grade contrast ${grade.contrast}: expected [0, 3]`,
      );
    }
  }
  const anchors = effect.anchors ?? [];
  for (const shape of effect.shapes ?? []) {
    if (shape.anchor < 0 || shape.anchor >= anchors.length) {
      throw new Error(
        `Invalid filter shape anchor ${shape.anchor}: effect "${effect.id}" has ${anchors.length} anchors`,
      );
    }
    if (shape.kind === "image") {
      const assets = effect.assets ?? [];
      if (
        !Number.isInteger(shape.asset) ||
        shape.asset < 0 ||
        shape.asset >= assets.length
      ) {
        throw new Error(
          `Invalid filter image shape asset ${shape.asset}: effect "${effect.id}" has ${assets.length} assets`,
        );
      }
      if (assets[shape.asset].kind !== "image") {
        throw new Error(
          `Invalid filter image shape asset ${shape.asset}: effect "${effect.id}" asset is ${assets[shape.asset].kind}, not image`,
        );
      }
    } else {
      parseHexColor(shape.color);
    }
    if (shape.kind !== "image") {
      const lineWidth = shape.lineWidth ?? DEFAULT_LINE_WIDTH;
      if (!(lineWidth > 0) || lineWidth > 0.1) {
        throw new Error(
          `Invalid filter lineWidth ${lineWidth}: expected (0, 0.1]`,
        );
      }
    }
    const rect = shape.rect ?? { x: 0, y: 0, width: 1, height: 1 };
    for (const [key, value] of Object.entries(rect)) {
      if (!Number.isFinite(value) || value < -1 || value > 2) {
        throw new Error(
          `Invalid filter shape rect ${key}=${value}: expected [-1, 2]`,
        );
      }
    }
    if ((shape.kind === "line" || shape.kind === "polyline") && !shape.points) {
      throw new Error(`Filter shape "${shape.kind}" requires points`);
    }
    if (shape.kind === "line" && shape.points && shape.points.length !== 2) {
      throw new Error(
        `Filter shape "line" requires exactly 2 points, got ${shape.points.length}`,
      );
    }
  }
}

/**
 * Render an effect's filter into draw commands. Grade commands are
 * always emitted when the effect has a grade; anchor shapes are
 * emitted only when `face` is tracked. Returns [] for an effect with
 * no grade and no shapes (or shapes without a face).
 */
export function renderFilterCommands(
  effect: EffectDefinition,
  face: FaceAnchorState | null,
  options?: { mirrored?: boolean },
): FilterDrawCommand[] {
  const commands: FilterDrawCommand[] = [];
  if (effect.grade) {
    commands.push({ kind: "grade", params: { ...effect.grade } });
  }
  if (!face || face.status !== "tracked") {
    return commands;
  }
  const anchors = effect.anchors ?? [];
  for (const shape of effect.shapes ?? []) {
    const anchor = anchors[shape.anchor];
    if (!anchor) continue;
    let rect = anchorRectNormalized(face, anchor);
    if (options?.mirrored) {
      rect = mirrorRect(rect);
    }
    const sub = shape.rect ?? { x: 0, y: 0, width: 1, height: 1 };
    const absolute = {
      x: rect.x + sub.x * rect.width,
      y: rect.y + sub.y * rect.height,
      width: sub.width * rect.width,
      height: sub.height * rect.height,
    };
    if (shape.kind === "image") {
      const asset = (effect.assets ?? [])[shape.asset];
      if (!asset) continue;
      commands.push({
        kind: "image",
        rect: absolute,
        assetUri: asset.uri,
        bottomPin: anchor.placement === "above-head",
      });
      continue;
    }
    const points = (shape.points ?? []).map((p) => ({
      x: rect.x + p.x * rect.width,
      y: rect.y + p.y * rect.height,
    }));
    commands.push({
      kind: "shape",
      shape: shape.kind,
      rect: absolute,
      points,
      color: shape.color,
      fill: shape.fill ?? false,
      lineWidth: shape.lineWidth ?? DEFAULT_LINE_WIDTH,
    });
  }
  return commands;
}

function resolveAnchorPointNormalized(
  face: FaceAnchorState,
  anchor: EffectAnchor,
): { x: number; y: number } {
  // coordinate-mapping.resolveAnchorPoint is view-agnostic: it returns
  // the anchor point in the face state's own coordinate space, which
  // is exactly normalized frame space for host-side frames. It
  // returns null only for fullscreen anchors, which anchorRect
  // Normalized handles before calling this.
  const point = resolveAnchorPoint(face, anchor);
  if (!point) {
    throw new Error(
      "resolveAnchorPointNormalized: fullscreen anchor has no point",
    );
  }
  return point;
}
