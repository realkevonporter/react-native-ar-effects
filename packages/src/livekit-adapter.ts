/**
 * M3 LiveKit adapter — pure TypeScript, no React Native imports.
 *
 * Hands a data-defined filter to a LiveKit video track so the fork's
 * native VideoEffect processor composites it BEFORE encoding. The
 * adapter itself never touches pixels: it (1) registers the SDK's
 * native processor by name, (2) hands the effect JSON to the native
 * module, (3) tells the track to route frames through the processor.
 * The host app then publishes the track exactly as usual — no
 * LiveKit client changes.
 *
 * Why this shape: the fork (@livekit/react-native-webrtc 144.1.2)
 * ships a VideoEffect registry (ProcessorProvider) on both platforms
 * — see ARCHITECTURE.md §M3 spike. There is NO frame-injection API
 * in the fork, so the SDK cannot feed its own frames into a track;
 * the processor is the only supported path, and it is the right one:
 * frames flow capturer -> processor -> encoder inside WebRTC.
 *
 * Processor name: "ar-effects-filter" (PROCESSOR_NAME). The native
 * module registers exactly this name; the adapter applies exactly
 * this name. A mismatch means Android silently skips the filter
 * (unknown names are logged + skipped, and _setVideoEffects returns
 * void, so JS cannot detect the skip) — registration-before-apply
 * is the mitigation, and the bridge must report registration
 * failure as an error.
 *
 * Track shape: structural, not imported. A real track is the fork's
 * MediaStreamTrack, whose _setVideoEffects is a private/custom API
 * in 144.1.2 — the adapter feature-detects it (typeof check) and
 * throws FilterNotSupportedError when it is missing, instead of
 * failing silently.
 *
 * Limits (documented, not hidden): iOS shares ONE processor instance
 * + ONE module-level effect processor, so only ONE filtered camera
 * track can exist at a time — exactly the host-camera case. Screen
 * share tracks cannot be filtered (the fork only applies effects to
 * camera tracks). clearFilter restores pass-through: an empty names
 * array forwards frames unchanged on both platforms.
 */

import { validateFilterEffect } from "./filter-renderer";
import { EffectDefinition } from "./types";

export const PROCESSOR_NAME = "ar-effects-filter";

/** Structural shape of a LiveKit video track (fork MediaStreamTrack). */
export interface FilterableVideoTrack {
  id: string;
  kind: string;
  /**
   * Fork-private/custom API (144.1.2): routes the track's frames
   * through the named processors. Empty array = pass-through.
   */
  _setVideoEffects?: (names: string[]) => void;
}

/** The native ARFilter module, as the adapter needs it. */
export interface FilterNativeBridge {
  /** Register PROCESSOR_NAME with the fork. Idempotent. */
  registerProcessor(): Promise<boolean>;
  /** Hand the effect JSON to the shared processor instance. */
  setFilter(effectJson: string): Promise<void>;
  /** Clear the processor's effect (frames pass through). */
  clearFilter(): Promise<void>;
}

export class FilterNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterNotSupportedError";
  }
}

export interface AppliedFilter {
  trackId: string;
  effectId: string;
  processorName: string;
}

export class LiveKitFilterAdapter {
  private readonly bridge: FilterNativeBridge;
  private registered = false;

  constructor(bridge: FilterNativeBridge) {
    this.bridge = bridge;
  }

  /** True when the track can carry a filter at all. */
  isFilterable(track: FilterableVideoTrack): boolean {
    return (
      track.kind === "video" && typeof track._setVideoEffects === "function"
    );
  }

  /**
   * Apply a filter to a video track. Validates the track kind, the
   * effect data, and the fork API; registers the processor (once),
   * hands the effect to native, then routes the track through it.
   * Throws FilterNotSupportedError when the track cannot carry
   * effects (wrong kind, or a fork without _setVideoEffects).
   */
  async applyFilter(
    track: FilterableVideoTrack,
    effect: EffectDefinition,
  ): Promise<AppliedFilter> {
    if (track.kind !== "video") {
      throw new FilterNotSupportedError(
        `Cannot apply a filter to a ${track.kind} track (expected video)`,
      );
    }
    validateFilterEffect(effect);
    if (!this.registered) {
      const ok = await this.bridge.registerProcessor();
      if (!ok) {
        throw new Error(
          "Filter processor registration failed: the native ARFilter module could not register with the WebRTC VideoEffect registry",
        );
      }
      this.registered = true;
    }
    await this.bridge.setFilter(JSON.stringify(effect));
    if (typeof track._setVideoEffects !== "function") {
      throw new FilterNotSupportedError(
        "Track has no _setVideoEffects: this LiveKit React Native fork does not expose video effects (need @livekit/react-native-webrtc 144.x)",
      );
    }
    track._setVideoEffects([PROCESSOR_NAME]);
    return {
      trackId: track.id,
      effectId: effect.id,
      processorName: PROCESSOR_NAME,
    };
  }

  /**
   * Remove any filter from a track. Clears the native effect, then
   * restores pass-through (empty names array forwards frames
   * unchanged on both platforms, verified in the fork source).
   */
  async clearFilter(track: FilterableVideoTrack): Promise<void> {
    await this.bridge.clearFilter();
    if (typeof track._setVideoEffects === "function") {
      track._setVideoEffects([]);
    }
  }
}
