/**
 * LandmarkStreamConsumer (M2) — transport-agnostic landmark stream state.
 *
 * Pure TypeScript, no React Native imports: unit-testable in Node.
 *
 * The SDK does NOT own the socket. The host app (Tokrah at M5, any
 * LiveKit app, or the example app's mock mode) receives LandmarkPayload
 * JSON over its own transport and feeds it here via handlePayload.
 * This class only owns per-face anchor state: tracking by faceId,
 * smoothing (via AnchorTracker), primary-face selection, and loss
 * notification. Nothing in this file imports Tokrah code or assumes a
 * particular socket library.
 *
 * Primary-face rule: an explicitly set primary stays selected even
 * when lost — the gift shows that face's fallback instead of jumping
 * to a different face. Auto mode (null) picks the first tracked face
 * in arrival order, falling back to the first known face when none is
 * currently tracked (so the overlay can still show its fallback).
 */

import { AnchorTracker } from "./anchor-tracker";
import type {
  FaceAnchorState,
  FaceFrame,
  FaceLostPayload,
  LandmarkMap,
  LandmarkPayload,
  LandmarkStreamConsumerConfig,
} from "./types";

export type StreamPayload = LandmarkPayload | FaceLostPayload;

/**
 * Build a LandmarkPayload from a full FaceFrame, keeping only the
 * requested landmark indices. Host-side helper: the host converts its
 * provider frames to payloads and sends them over the socket; viewers
 * feed received payloads to LandmarkStreamConsumer.handlePayload.
 * Indices absent from the frame are skipped, never fabricated.
 */
export function payloadFromFrame(
  frame: FaceFrame,
  indices: number[],
  mirrored: boolean,
): LandmarkPayload {
  const byIndex = new Map<number, { x: number; y: number }>();
  frame.landmarks.forEach((point, i) => {
    byIndex.set(i, { x: point.x, y: point.y });
  });
  const landmarks: Array<{ index: number; x: number; y: number }> = [];
  for (const index of indices) {
    const point = byIndex.get(index);
    if (point) {
      landmarks.push({ index, x: point.x, y: point.y });
    }
  }
  return {
    type: "face.landmarks",
    faceId: frame.faceId,
    landmarks,
    bounds: { ...frame.bounds },
    timestampMs: frame.timestampMs,
    coordinateSpace: "normalized-top-left",
    mirrored,
    landmarkMap: frame.landmarkMap as LandmarkMap,
  };
}

export class LandmarkStreamConsumer {
  private readonly trackers = new Map<string, AnchorTracker>();
  private readonly lostAfterMs: number;
  private readonly smoothingAlpha: number | undefined;
  private readonly nowMs: () => number;
  private primaryFaceId: string | null;
  private updateListeners = new Set<() => void>();
  private lostListeners = new Set<(payload: FaceLostPayload) => void>();

  constructor(
    config: LandmarkStreamConsumerConfig = {},
    nowMs: () => number = () => Date.now(),
  ) {
    this.lostAfterMs = config.lostAfterMs ?? 1500;
    this.smoothingAlpha = config.smoothingAlpha;
    this.primaryFaceId = config.primaryFaceId ?? null;
    this.nowMs = nowMs;
  }

  /** Feed one socket payload (face.landmarks or face.lost). */
  handlePayload(payload: StreamPayload): void {
    if (payload.type === "face.lost") {
      const tracker = this.trackers.get(payload.faceId);
      if (tracker) {
        tracker.markLost();
      }
      for (const listener of this.lostListeners) {
        listener(payload);
      }
    } else {
      let tracker = this.trackers.get(payload.faceId);
      if (!tracker) {
        tracker = new AnchorTracker(
          payload.faceId,
          {
            lostAfterMs: this.lostAfterMs,
            ...(this.smoothingAlpha !== undefined
              ? { smoothingAlpha: this.smoothingAlpha }
              : {}),
          },
          this.nowMs,
        );
        this.trackers.set(payload.faceId, tracker);
      }
      tracker.update(payload);
    }
    this.notifyUpdate();
  }

  /** Anchor state for one face, or undefined if never seen. */
  getFaceState(faceId: string): FaceAnchorState | undefined {
    return this.trackers.get(faceId)?.getState(this.nowMs());
  }

  /** Anchor state for the primary face (explicit, else first tracked). */
  getPrimaryFaceState(): FaceAnchorState | undefined {
    if (this.primaryFaceId !== null) {
      return this.getFaceState(this.primaryFaceId);
    }
    const now = this.nowMs();
    let firstKnown: FaceAnchorState | undefined;
    for (const tracker of this.trackers.values()) {
      const state = tracker.getState(now);
      if (!firstKnown) {
        firstKnown = state;
      }
      if (state.status === "tracked") {
        return state;
      }
    }
    return firstKnown;
  }

  /** All known faces, in arrival order. */
  getAllFaceStates(): FaceAnchorState[] {
    const now = this.nowMs();
    return [...this.trackers.values()].map((t) => t.getState(now));
  }

  /** Set (or clear, with null) the explicit primary face. */
  setPrimaryFace(faceId: string | null): void {
    if (this.primaryFaceId !== faceId) {
      this.primaryFaceId = faceId;
      this.notifyUpdate();
    }
  }

  /**
   * Subscribe to state changes (payloads, losses, primary changes).
   * Listeners must not throw: an exception propagates to the
   * handlePayload caller. Returns an unsubscribe function.
   */
  onUpdate(callback: () => void): () => void {
    this.updateListeners.add(callback);
    return () => {
      this.updateListeners.delete(callback);
    };
  }

  /** Subscribe to face.lost payloads. Returns an unsubscribe function. */
  onFaceLost(callback: (payload: FaceLostPayload) => void): () => void {
    this.lostListeners.add(callback);
    return () => {
      this.lostListeners.delete(callback);
    };
  }

  private notifyUpdate(): void {
    for (const listener of this.updateListeners) {
      listener();
    }
  }
}
