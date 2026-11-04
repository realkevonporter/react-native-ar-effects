/**
 * Effect validation (M4) — fail LOUD at load, never silently at render.
 *
 * Every effect a consumer loads — from the built-in catalogue, from a
 * server, or from a third-party author — must pass
 * validateEffectDefinition before anything renders it. Invalid data
 * throws an Error naming the effect and the exact problem, so a bad
 * effect breaks loudly at load time instead of drawing wrong (or
 * nothing) mid-stream.
 *
 * What is checked (in order, first problem throws):
 *  - identity: id is a stable slug, name is non-empty.
 *  - format: formatVersion is exactly EFFECT_FORMAT_VERSION (1 in
 *    M4). Missing and unknown versions throw with distinct messages
 *    so a future format change cannot silently break older consumers.
 *  - version: positive integer. tags: array of non-empty strings.
 *  - kind/renderPath invariant: filters are pre-encode, gifts are
 *    viewer-overlay — the two render paths never cross.
 *  - animation: mode loop|once|timed; timed requires durationMs > 0.
 *  - trackingLostFallback: banner|stage|hide.
 *  - anchors: landmark indices are integers in [0, 477] (the
 *    MediaPipe-478 map); placement is known; scaleToFace is in
 *    (0, 5]; offsets are finite. Empty landmarkIndices are allowed:
 *    above-head anchors resolve from face bounds, not indices.
 *  - render-path payload rules: filters must carry a grade or at
 *    least one shape (otherwise they render nothing) and may only
 *    list image assets (the pre-encode compositor draws images but
 *    would silently ignore a lottie/svga/video-alpha asset); gifts
 *    must not carry shapes or a grade (the viewer overlay never
 *    renders them).
 *    Gifts may list zero assets — they render as a name pill (M2).
 *  - assets: kind is lottie|svga|image|video-alpha, dimensions are
 *    positive, and the uri RESOLVES: data: URIs must be well-formed
 *    base64 that decodes to non-empty bytes (PNG-declared URIs must
 *    start with the PNG signature); http(s) URIs must parse as URLs
 *    (network reachability is the app's runtime concern, not a load
 *    check); any other scheme is rejected — React Native's Image
 *    loader cannot resolve it either.
 *  - grade + shapes: delegated to validateFilterEffect, which checks
 *    grade ranges, hex colors, line widths, shape rects, image-shape
 *    asset references, and that line/polyline shapes carry points
 *    and shape anchors exist.
 *
 * Pure TypeScript, no React Native imports, no Buffer/atob — the
 * base64 check is hand-rolled so this module runs under Hermes too.
 * Unit-testable in Node (see __tests__/effect-validation.test.ts).
 */

import { validateFilterEffect } from "./filter-renderer";
import type { EffectDefinition } from "./types";

/** The only effect-format schema version M4 understands. */
export const EFFECT_FORMAT_VERSION = 1;

/** Highest valid MediaPipe-478 landmark index. */
export const MAX_LANDMARK_INDEX = 477;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function fail(effectId: string, problem: string): never {
  throw new Error(`Invalid effect "${effectId}": ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Minimal base64 decoder (no Buffer/atob, Hermes-safe). Throws on bad input. */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) {
    lookup.set(alphabet[i], i);
  }
  const clean = base64.replace(/\s/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0) {
    throw new Error("base64 length must be a non-zero multiple of 4");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const quad = clean.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const ch = quad[j];
      if (ch === "=") {
        if (i + 4 !== clean.length || j < 4 - padding) {
          throw new Error("misplaced base64 padding");
        }
        // Padding contributes zero bits but still occupies a sextet
        // slot — shift so the real bits stay aligned.
        n = n << 6;
        continue;
      }
      const value = lookup.get(ch);
      if (value === undefined) {
        throw new Error(`invalid base64 character "${ch}"`);
      }
      n = (n << 6) | value;
    }
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  return new Uint8Array(bytes.slice(0, bytes.length - padding));
}

function validateAssetUri(uri: unknown, effectId: string): void {
  if (typeof uri !== "string" || uri.length === 0) {
    fail(effectId, "asset uri must be a non-empty string");
  }
  if (uri.startsWith("data:")) {
    const match = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/.exec(
      uri,
    );
    if (!match) {
      fail(
        effectId,
        `asset uri "${uri.slice(0, 40)}…" is not a supported data URI ` +
          "(expected data:image/png|jpeg|gif;base64,…)",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64ToBytes(match[2]);
    } catch (err) {
      fail(
        effectId,
        `asset data URI has undecodable base64: ${(err as Error).message}`,
      );
    }
    if (bytes.length === 0) {
      fail(effectId, "asset data URI decodes to empty bytes");
    }
    if (match[1] === "png") {
      const magic = PNG_SIGNATURE.every((b, i) => bytes[i] === b);
      if (!magic) {
        fail(
          effectId,
          "asset declares image/png but bytes lack the PNG signature",
        );
      }
    }
    return;
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        fail(effectId, `asset uri "${uri}" has an unsupported protocol`);
      }
    } catch {
      fail(effectId, `asset uri "${uri}" is not a valid URL`);
    }
    return;
  }
  fail(
    effectId,
    `asset uri "${uri.slice(0, 40)}" uses an unsupported scheme ` +
      "(only data: and http(s): URIs resolve in React Native Image)",
  );
}

/**
 * Validate one effect definition. Returns the typed definition on
 * success; throws an Error naming the effect and the problem on the
 * first failure. Call this at load time, before any rendering.
 */
export function validateEffectDefinition(effect: unknown): EffectDefinition {
  if (!isRecord(effect)) {
    throw new Error("Invalid effect: expected an object");
  }
  const id =
    typeof effect.id === "string" && effect.id.length > 0
      ? effect.id
      : "(unknown id)";
  if (typeof effect.id !== "string" || !ID_PATTERN.test(effect.id)) {
    fail(
      id,
      `id ${JSON.stringify(effect.id)} must be a stable slug ` +
        "(lowercase letters, digits, hyphens)",
    );
  }
  if (typeof effect.name !== "string" || effect.name.trim().length === 0) {
    fail(id, "name must be a non-empty string");
  }
  if (effect.formatVersion === undefined) {
    fail(
      id,
      "formatVersion is missing (M4 requires formatVersion 1 — " +
        "an effect without a format version cannot be trusted)",
    );
  }
  if (effect.formatVersion !== EFFECT_FORMAT_VERSION) {
    fail(
      id,
      `unsupported formatVersion ${String(effect.formatVersion)} ` +
        `(this build understands only ${EFFECT_FORMAT_VERSION})`,
    );
  }
  if (
    typeof effect.version !== "number" ||
    !Number.isInteger(effect.version) ||
    effect.version < 1
  ) {
    fail(id, `version ${String(effect.version)} must be a positive integer`);
  }
  if (!Array.isArray(effect.tags)) {
    fail(id, "tags must be an array of strings");
  }
  for (const tag of effect.tags as unknown[]) {
    if (typeof tag !== "string" || tag.trim().length === 0) {
      fail(id, "every tag must be a non-empty string");
    }
  }
  if (effect.kind !== "filter" && effect.kind !== "gift") {
    fail(id, `kind ${JSON.stringify(effect.kind)} must be "filter" or "gift"`);
  }
  if (effect.kind === "filter" && effect.renderPath !== "pre-encode") {
    fail(id, 'filters must use renderPath "pre-encode"');
  }
  if (effect.kind === "gift" && effect.renderPath !== "viewer-overlay") {
    fail(id, 'gifts must use renderPath "viewer-overlay"');
  }
  const animation = effect.animation as
    { mode?: unknown; durationMs?: unknown } | undefined;
  if (
    !isRecord(animation) ||
    (animation.mode !== "loop" &&
      animation.mode !== "once" &&
      animation.mode !== "timed")
  ) {
    fail(
      id,
      `animation.mode ${JSON.stringify(animation?.mode)} must be "loop", "once", or "timed"`,
    );
  }
  if (animation.mode === "timed") {
    if (
      !isFiniteNumber(animation.durationMs) ||
      (animation.durationMs as number) <= 0
    ) {
      fail(id, "timed animation requires durationMs > 0");
    }
  } else if (
    animation.durationMs !== undefined &&
    (!isFiniteNumber(animation.durationMs) ||
      (animation.durationMs as number) <= 0)
  ) {
    fail(id, "animation.durationMs, when present, must be > 0");
  }
  if (
    effect.trackingLostFallback !== "banner" &&
    effect.trackingLostFallback !== "stage" &&
    effect.trackingLostFallback !== "hide"
  ) {
    fail(
      id,
      `trackingLostFallback ${JSON.stringify(effect.trackingLostFallback)} must be "banner", "stage", or "hide"`,
    );
  }
  if (!Array.isArray(effect.anchors)) {
    fail(id, "anchors must be an array");
  }
  for (const anchor of effect.anchors as unknown[]) {
    if (!isRecord(anchor)) {
      fail(id, "every anchor must be an object");
    }
    if (
      anchor.placement !== "above-head" &&
      anchor.placement !== "on-face" &&
      anchor.placement !== "follow" &&
      anchor.placement !== "orbit" &&
      anchor.placement !== "fullscreen"
    ) {
      fail(
        id,
        `anchor placement ${JSON.stringify(anchor.placement)} is unknown`,
      );
    }
    if (!Array.isArray(anchor.landmarkIndices)) {
      fail(id, "anchor landmarkIndices must be an array");
    }
    for (const index of anchor.landmarkIndices as unknown[]) {
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > MAX_LANDMARK_INDEX
      ) {
        fail(
          id,
          `anchor landmark index ${String(index)} is outside the MediaPipe-478 range [0, ${MAX_LANDMARK_INDEX}]`,
        );
      }
    }
    if (
      !isFiniteNumber(anchor.scaleToFace) ||
      (anchor.scaleToFace as number) <= 0 ||
      (anchor.scaleToFace as number) > 5
    ) {
      fail(
        id,
        `anchor scaleToFace ${String(anchor.scaleToFace)} must be in (0, 5]`,
      );
    }
    const offset = anchor.offset as { x?: unknown; y?: unknown } | undefined;
    if (offset !== undefined) {
      if (
        !isRecord(offset) ||
        !isFiniteNumber(offset.x) ||
        !isFiniteNumber(offset.y)
      ) {
        fail(
          id,
          "anchor offset, when present, must be { x, y } finite numbers",
        );
      }
    }
  }
  if (!Array.isArray(effect.assets)) {
    fail(id, "assets must be an array");
  }
  const assets = effect.assets as unknown[];
  if (effect.kind === "filter") {
    for (const asset of assets) {
      if (
        isRecord(asset) &&
        asset.kind !== undefined &&
        asset.kind !== "image"
      ) {
        fail(
          id,
          `filters may only list image assets — the pre-encode compositor ` +
            `draws images but would silently ignore a ${JSON.stringify(asset.kind)} asset`,
        );
      }
    }
  }
  if (effect.kind === "gift") {
    if (
      effect.shapes !== undefined &&
      Array.isArray(effect.shapes) &&
      effect.shapes.length > 0
    ) {
      fail(
        id,
        "gifts must not list shapes — the viewer overlay never renders " +
          "them, so listed shapes would be silently ignored",
      );
    }
    if (effect.grade !== undefined) {
      fail(
        id,
        "gifts must not list a grade — the viewer overlay never applies " +
          "it, so a listed grade would be silently ignored",
      );
    }
  }
  for (const asset of assets) {
    if (!isRecord(asset)) {
      fail(id, "every asset must be an object");
    }
    if (
      asset.kind !== "lottie" &&
      asset.kind !== "svga" &&
      asset.kind !== "image" &&
      asset.kind !== "video-alpha"
    ) {
      fail(id, `asset kind ${JSON.stringify(asset.kind)} is unknown`);
    }
    if (
      !isFiniteNumber(asset.width) ||
      (asset.width as number) <= 0 ||
      !isFiniteNumber(asset.height) ||
      (asset.height as number) <= 0
    ) {
      fail(id, "asset width and height must be positive numbers");
    }
    validateAssetUri(asset.uri, id);
  }
  if (
    effect.soundUri !== undefined &&
    (typeof effect.soundUri !== "string" || effect.soundUri.length === 0)
  ) {
    fail(id, "soundUri, when present, must be a non-empty string");
  }
  // Shape the deep check's inputs first: validateFilterEffect assumes
  // grade is an object and shapes is an array, and a malformed value
  // of either could slip through its numeric comparisons silently.
  if (effect.grade !== undefined) {
    const grade = effect.grade as Record<string, unknown>;
    if (
      !isRecord(grade) ||
      !isFiniteNumber(grade.warmth) ||
      !isFiniteNumber(grade.brightness) ||
      !isFiniteNumber(grade.saturation) ||
      !isFiniteNumber(grade.contrast)
    ) {
      fail(
        id,
        "grade must be an object with finite warmth, brightness, " +
          "saturation, and contrast numbers",
      );
    }
  }
  if (effect.shapes !== undefined) {
    if (!Array.isArray(effect.shapes)) {
      fail(id, "shapes must be an array when present");
    }
    for (const shape of effect.shapes as unknown[]) {
      if (!isRecord(shape)) {
        fail(id, "every shape must be an object");
      }
    }
  }
  if (effect.kind === "filter") {
    const shapes = effect.shapes as unknown[] | undefined;
    if (effect.grade === undefined && (!shapes || shapes.length === 0)) {
      fail(
        id,
        "filters must carry a grade or at least one shape — otherwise " +
          "they render nothing",
      );
    }
  }
  // Deep grade + shape checks (ranges, colors, points, anchor refs).
  try {
    validateFilterEffect(effect as unknown as EffectDefinition);
  } catch (err) {
    fail(id, (err as Error).message);
  }
  return effect as unknown as EffectDefinition;
}

/**
 * Validate a whole catalogue: every entry must validate and ids must
 * be unique. Returns the typed entries on success; throws on the
 * first duplicate or invalid entry.
 */
export function validateCatalogue(effects: unknown[]): EffectDefinition[] {
  const seen = new Set<string>();
  const out: EffectDefinition[] = [];
  for (const effect of effects) {
    const valid = validateEffectDefinition(effect);
    if (seen.has(valid.id)) {
      throw new Error(`Invalid catalogue: duplicate effect id "${valid.id}"`);
    }
    seen.add(valid.id);
    out.push(valid);
  }
  return out;
}
