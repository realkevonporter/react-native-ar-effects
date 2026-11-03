/**
 * M3 host filter pipeline — pure TypeScript, no React Native imports.
 *
 * One pipeline, one frame flow. The pipeline does NOT own a camera:
 * it consumes FaceFrames from any detector (M1 provider events in the
 * example preview, M3 processor landmark events on a LiveKit track at
 * M5) and emits FilterFramePlans. The native pre-encode compositor
 * consumes the same EffectDefinition data on the track itself; this
 * pipeline is the TS-side planner + preview + the testable contract
 * for the native behavior.
 *
 * Single face for M3 (matching M1's maxFaces default of 1): the first
 * faceId seen becomes the tracked face; frames from other faceIds are
 * ignored until reset. An explicitly lost face (handleFaceLost, or a
 * gap past the tracker's loss threshold) hides shapes; the grade
 * still applies, because a grade needs no face.
 *
 * Frames are never held: handleFrame returns a plan synchronously.
 * When the caller supplies a measured render duration, the
 * performance governor gates the plan — an over-budget frame becomes
 * an unfiltered plan (commands emptied, droppedReason set) so the
 * caller forwards the ORIGINAL frame. When no duration is supplied
 * (preview path), the governor is not consulted.
 */

import { AnchorTracker } from "./anchor-tracker";
import { renderFilterCommands, validateFilterEffect } from "./filter-renderer";
import { payloadFromFrame } from "./landmark-stream";
import { FilterPerformanceGovernor } from "./performance-governor";
import {
  EffectDefinition,
  FaceFrame,
  FilterFramePlan,
  FilterPipelineStatus,
  HostFilterConfig,
} from "./types";

export class HostFilterPipeline {
  private effect: EffectDefinition | null = null;
  private tracker: AnchorTracker | null = null;
  private readonly governor: FilterPerformanceGovernor;
  private readonly nowMs: () => number;
  private framesSeen = 0;

  constructor(
    config: HostFilterConfig = {},
    nowMs: () => number = () => Date.now(),
  ) {
    this.governor = new FilterPerformanceGovernor(config, nowMs);
    this.nowMs = nowMs;
  }

  /**
   * Set (or clear with null) the active filter. Validates the effect
   * (throws on bad data) and resets the tracker + governor, so a
   * filter switch never inherits stale face state or a bypass.
   */
  setEffect(effect: EffectDefinition | null): void {
    if (effect) validateFilterEffect(effect);
    this.effect = effect;
    this.tracker = null;
    this.governor.reset();
  }

  get currentEffect(): EffectDefinition | null {
    return this.effect;
  }

  /** Feed one detected frame; returns the plan for that frame. */
  handleFrame(frame: FaceFrame, measuredDurationMs?: number): FilterFramePlan {
    this.framesSeen += 1;
    const now = this.nowMs();
    const effect = this.effect;

    if (!effect) {
      return {
        timestampMs: frame.timestampMs,
        effectId: null,
        filtered: false,
        commands: [],
        droppedReason: "no-filter",
      };
    }

    // Grade-only effects skip detection entirely: no anchors, no
    // tracker, no face needed. (Anchor effects fall through below.)
    const hasShapes = (effect.shapes ?? []).length > 0;
    if (!hasShapes) {
      const commands = renderFilterCommands(effect, null);
      if (measuredDurationMs !== undefined) {
        const outcome = this.governor.observe(measuredDurationMs, now);
        if (outcome !== "applied") {
          return {
            timestampMs: frame.timestampMs,
            effectId: effect.id,
            filtered: false,
            commands: [],
            droppedReason: outcome === "bypassed" ? "bypassed" : "over-budget",
          };
        }
      }
      return {
        timestampMs: frame.timestampMs,
        effectId: effect.id,
        filtered: commands.length > 0,
        commands,
      };
    }

    // Anchor effect: track the (single) primary face. FaceFrame is
    // one face (M1); the first faceId seen becomes the primary, and
    // frames from other faceIds are ignored until reset — the filter
    // must not jump between faces mid-stream.
    if (!this.tracker) {
      this.tracker = new AnchorTracker(frame.faceId, {}, this.nowMs);
    }
    if (frame.faceId === this.tracker.faceId) {
      const neededIndices = new Set<number>();
      for (const anchor of effect.anchors ?? []) {
        for (const index of anchor.landmarkIndices) {
          neededIndices.add(index);
        }
      }
      // Subset rule (spec §2): only the effect's anchor indices are
      // trusted; the payload never fabricates points. Mirrored=false:
      // host-side frames stay in sensor space (see filter-renderer).
      const payload = payloadFromFrame(frame, Array.from(neededIndices), false);
      this.tracker.update(payload);
    }
    const faceState = this.tracker?.getState() ?? null;
    const tracked = faceState && faceState.status === "tracked";
    const commands = renderFilterCommands(effect, tracked ? faceState : null);

    if (measuredDurationMs !== undefined) {
      const outcome = this.governor.observe(measuredDurationMs, now);
      if (outcome !== "applied") {
        return {
          timestampMs: frame.timestampMs,
          effectId: effect.id,
          filtered: false,
          commands: [],
          droppedReason: outcome === "bypassed" ? "bypassed" : "over-budget",
        };
      }
    }

    if (!tracked && !effect.grade) {
      return {
        timestampMs: frame.timestampMs,
        effectId: effect.id,
        filtered: false,
        commands: [],
        droppedReason: "no-face",
      };
    }
    return {
      timestampMs: frame.timestampMs,
      effectId: effect.id,
      filtered: commands.length > 0,
      commands,
    };
  }

  /** Mark the tracked face lost (explicit loss event from detector). */
  handleFaceLost(faceId: string): void {
    if (this.tracker && this.tracker.faceId === faceId) {
      this.tracker.markLost();
    }
  }

  getStatus(): FilterPipelineStatus {
    return {
      effectId: this.effect?.id ?? null,
      bypassed: this.governor.status.bypassed,
      consecutiveDrops: this.governor.status.consecutiveDrops,
      framesSeen: this.framesSeen,
    };
  }

  reset(): void {
    this.effect = null;
    this.tracker = null;
    this.governor.reset();
    this.framesSeen = 0;
  }
}
