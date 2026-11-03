/**
 * Coordinate mapping (M2) — sensor space to view pixels.
 *
 * Pure TypeScript, no React Native imports: unit-testable in Node.
 *
 * Pipeline: sensor point (normalized 0..1, origin top-left) -> mirror
 * (if the payload says so) -> video rect inside the view (cover or
 * contain) -> view pixels. Video views letterbox/pillarbox, so the
 * mapping must account for the displayed video rect — never assume
 * the video fills the view.
 *
 * Conventions (documented, tested):
 * - Mirroring flips x -> 1 - x BEFORE rect mapping (spec §2).
 * - offset.y positive moves DOWN (screen convention).
 * - Asset width = scaleToFace * face width in view pixels; height
 *   follows the asset's intrinsic aspect ratio.
 * - above-head pins the asset's BOTTOM edge to the anchor point;
 *   on-face/follow/orbit center the asset on it; fullscreen fills
 *   the view and ignores the anchor.
 */

import type {
  EffectAnchor,
  EffectAsset,
  FaceAnchorState,
  FaceBounds,
  NormalizedPoint,
} from "./types";

export interface ViewSize {
  width: number;
  height: number;
}

export interface VideoSize {
  width: number;
  height: number;
}

export type ResizeMode = "cover" | "contain";

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function requirePositive(value: number, name: string): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(
      `${name} must be a positive finite number, got ${String(value)}`,
    );
  }
}

export interface MapOptions {
  mirrored: boolean;
  videoSize: VideoSize;
  viewSize: ViewSize;
  resizeMode?: ResizeMode;
}

interface VideoRect {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function displayedVideoRect(
  videoSize: VideoSize,
  viewSize: ViewSize,
  resizeMode: ResizeMode,
): VideoRect {
  requirePositive(videoSize.width, "videoSize.width");
  requirePositive(videoSize.height, "videoSize.height");
  requirePositive(viewSize.width, "viewSize.width");
  requirePositive(viewSize.height, "viewSize.height");
  const scale =
    resizeMode === "cover"
      ? Math.max(
          viewSize.width / videoSize.width,
          viewSize.height / videoSize.height,
        )
      : Math.min(
          viewSize.width / videoSize.width,
          viewSize.height / videoSize.height,
        );
  return {
    scale,
    offsetX: (viewSize.width - videoSize.width * scale) / 2,
    offsetY: (viewSize.height - videoSize.height * scale) / 2,
  };
}

/** Map one normalized sensor point to view pixels. */
export function mapSensorPointToView(
  point: NormalizedPoint,
  options: MapOptions,
): PixelPoint {
  const x = options.mirrored ? 1 - point.x : point.x;
  const rect = displayedVideoRect(
    options.videoSize,
    options.viewSize,
    options.resizeMode ?? "cover",
  );
  return {
    x: rect.offsetX + x * options.videoSize.width * rect.scale,
    y: rect.offsetY + point.y * options.videoSize.height * rect.scale,
  };
}

/** Map normalized sensor bounds to a view-pixel rect. */
export function mapSensorBoundsToView(
  bounds: FaceBounds,
  options: MapOptions,
): PixelRect {
  const topLeft = mapSensorPointToView({ x: bounds.x, y: bounds.y }, options);
  const bottomRight = mapSensorPointToView(
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    options,
  );
  return {
    left: topLeft.x,
    top: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

/**
 * Resolve the sensor-space anchor point for an effect anchor.
 * Returns null for fullscreen (no anchor needed).
 *
 * - above-head: top-center of the face bounds.
 * - on-face / follow: centroid of the requested landmark indices that
 *   are present in the face's latest payload; bounds center when none
 *   are present (never a stale point from an older payload).
 * - orbit: bounds center (the circular offset is applied at render).
 */
export function resolveAnchorPoint(
  face: FaceAnchorState,
  anchor: EffectAnchor,
): NormalizedPoint | null {
  if (anchor.placement === "fullscreen") {
    return null;
  }
  if (anchor.placement === "above-head") {
    return {
      x: face.bounds.x + face.bounds.width / 2,
      y: face.bounds.y,
    };
  }
  const fresh = new Set(face.latestIndices);
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const index of anchor.landmarkIndices) {
    if (!fresh.has(index)) {
      continue;
    }
    const point = face.landmarks[index];
    if (point) {
      sumX += point.x;
      sumY += point.y;
      count += 1;
    }
  }
  if (count > 0) {
    return { x: sumX / count, y: sumY / count };
  }
  return {
    x: face.bounds.x + face.bounds.width / 2,
    y: face.bounds.y + face.bounds.height / 2,
  };
}

/**
 * Compute the view-pixel rect for one asset of an effect.
 * anchorPoint must already be in view pixels (see
 * mapSensorPointToView); pass null only for fullscreen placement.
 */
export function computeAssetRect(args: {
  anchorPoint: PixelPoint | null;
  faceWidthPx: number;
  anchor: EffectAnchor;
  asset: EffectAsset;
  viewSize: ViewSize;
}): PixelRect {
  const { anchor, asset, viewSize } = args;
  if (anchor.placement === "fullscreen") {
    return { left: 0, top: 0, width: viewSize.width, height: viewSize.height };
  }
  if (!args.anchorPoint) {
    throw new Error(
      "computeAssetRect: anchorPoint is required for non-fullscreen placements",
    );
  }
  requirePositive(args.faceWidthPx, "faceWidthPx");
  const assetWidth = args.faceWidthPx * anchor.scaleToFace;
  const aspect =
    asset.width > 0 && asset.height > 0 ? asset.height / asset.width : 1;
  const assetHeight = assetWidth * aspect;
  const offsetX = (anchor.offset?.x ?? 0) * args.faceWidthPx;
  const offsetY = (anchor.offset?.y ?? 0) * args.faceWidthPx;
  if (anchor.placement === "above-head") {
    return {
      left: args.anchorPoint.x - assetWidth / 2 + offsetX,
      top: args.anchorPoint.y - assetHeight + offsetY,
      width: assetWidth,
      height: assetHeight,
    };
  }
  // on-face, follow, orbit: centered on the anchor point.
  return {
    left: args.anchorPoint.x - assetWidth / 2 + offsetX,
    top: args.anchorPoint.y - assetHeight / 2 + offsetY,
    width: assetWidth,
    height: assetHeight,
  };
}
