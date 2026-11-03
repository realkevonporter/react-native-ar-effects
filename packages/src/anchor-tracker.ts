/**
 * AnchorTracker (M2) — per-face smoothing + loss detection.
 *
 * Pure TypeScript, no React Native imports: unit-testable in Node.
 *
 * Why smoothing exists: raw landmarks jitter frame to frame (detection
 * noise + socket timing), and a gift pinned to a jittery anchor visibly
 * shakes. An exponential moving average (EMA) damps that jitter with
 * one multiply per point and no history buffer. This is jitter
 * filtering, NOT interpolation: the tracker never predicts positions
 * between payloads (spec §2 says viewers do not interpolate) — it
 * renders the last known position, smoothed.
 *
 * Snap rules: the first payload for a face snaps (no history to
 * average from), and a payload arriving after the face was lost snaps
 * too — averaging from a stale pre-loss position would glide the gift
 * across the screen to the new position.
 */

import type {
  AnchorTrackerConfig,
  FaceAnchorState,
  FaceBounds,
  LandmarkMap,
  LandmarkPayload,
  NormalizedPoint,
} from "./types";

export const DEFAULT_SMOOTHING_ALPHA = 0.35;
/** Spec §3: "no landmark payload has arrived for > 1.5s". */
export const DEFAULT_LOST_AFTER_MS = 1500;

function emaPoint(
  previous: NormalizedPoint | undefined,
  raw: NormalizedPoint,
  alpha: number,
): NormalizedPoint {
  if (!previous) {
    return { x: raw.x, y: raw.y, z: raw.z };
  }
  const next: NormalizedPoint = {
    x: previous.x + alpha * (raw.x - previous.x),
    y: previous.y + alpha * (raw.y - previous.y),
  };
  if (raw.z !== undefined || previous.z !== undefined) {
    const pz = previous.z ?? raw.z ?? 0;
    const rz = raw.z ?? pz;
    next.z = pz + alpha * (rz - pz);
  }
  return next;
}

function emaBounds(
  previous: FaceBounds | undefined,
  raw: FaceBounds,
  alpha: number,
): FaceBounds {
  if (!previous) {
    return { ...raw };
  }
  return {
    x: previous.x + alpha * (raw.x - previous.x),
    y: previous.y + alpha * (raw.y - previous.y),
    width: previous.width + alpha * (raw.width - previous.width),
    height: previous.height + alpha * (raw.height - previous.height),
  };
}

export class AnchorTracker {
  readonly faceId: string;
  private readonly alpha: number;
  private readonly lostAfterMs: number;
  private readonly nowMs: () => number;

  private landmarks: Record<number, NormalizedPoint> = {};
  private latestIndices: number[] = [];
  private bounds: FaceBounds | undefined;
  private lastSeenMs = 0;
  private lost = false;
  private mirrored = false;
  private landmarkMap: LandmarkMap = "mediapipe-478";
  private seen = false;

  constructor(
    faceId: string,
    config: AnchorTrackerConfig = {},
    nowMs: () => number = () => Date.now(),
  ) {
    this.faceId = faceId;
    const alpha = config.smoothingAlpha ?? DEFAULT_SMOOTHING_ALPHA;
    if (!(alpha > 0 && alpha <= 1)) {
      throw new RangeError(
        `smoothingAlpha must be in (0,1], got ${String(alpha)}`,
      );
    }
    this.alpha = alpha;
    this.lostAfterMs = config.lostAfterMs ?? DEFAULT_LOST_AFTER_MS;
    if (!(this.lostAfterMs > 0)) {
      throw new RangeError(
        `lostAfterMs must be positive, got ${String(this.lostAfterMs)}`,
      );
    }
    this.nowMs = nowMs;
  }

  /** Feed one LandmarkPayload for this face. */
  update(payload: LandmarkPayload): void {
    if (payload.faceId !== this.faceId) {
      throw new Error(
        `AnchorTracker for ${this.faceId} received payload for ${payload.faceId}`,
      );
    }
    const now = this.nowMs();
    const gapLost = this.seen && now - this.lastSeenMs > this.lostAfterMs;
    const snap = !this.seen || this.lost || gapLost;
    const next: Record<number, NormalizedPoint> = {};
    for (const point of payload.landmarks) {
      const raw: NormalizedPoint = { x: point.x, y: point.y };
      next[point.index] = snap
        ? raw
        : emaPoint(this.landmarks[point.index], raw, this.alpha);
    }
    this.landmarks = next;
    this.latestIndices = payload.landmarks.map((point) => point.index);
    this.bounds = snap
      ? { ...payload.bounds }
      : emaBounds(this.bounds, payload.bounds, this.alpha);
    this.lastSeenMs = now;
    this.lost = false;
    this.mirrored = payload.mirrored;
    this.landmarkMap = payload.landmarkMap;
    this.seen = true;
  }

  /** Mark this face lost immediately (face.lost payload). */
  markLost(): void {
    this.lost = true;
  }

  /** True when explicitly lost or the payload gap exceeded lostAfterMs. */
  isLost(now: number = this.nowMs()): boolean {
    if (!this.seen) {
      return true;
    }
    return this.lost || now - this.lastSeenMs > this.lostAfterMs;
  }

  getState(now: number = this.nowMs()): FaceAnchorState {
    return {
      faceId: this.faceId,
      landmarks: { ...this.landmarks },
      latestIndices: [...this.latestIndices],
      bounds: this.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      lastSeenMs: this.lastSeenMs,
      status: this.isLost(now) ? "lost" : "tracked",
      mirrored: this.mirrored,
      landmarkMap: this.landmarkMap,
    };
  }
}
