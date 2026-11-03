/**
 * M3 performance governor — pure TypeScript, no React Native imports.
 *
 * The contract: filtering must NEVER stall the stream. The encoder
 * owns the frame clock; the filter is a guest. So:
 *
 * - Every filtered frame has a budget: 1000 / targetFps ms
 *   (default 15fps -> ~66ms, matching M1's throttle).
 * - A frame whose measured render duration exceeds the budget is
 *   dropped: the ORIGINAL frame goes to the encoder unfiltered.
 *   The pipeline never blocks waiting for a slow render.
 * - After maxConsecutiveDrops (default 8) over-budget frames in a
 *   row, the pipeline enters bypass: the filter turns off entirely
 *   and every frame passes through unfiltered, so a persistently
 *   slow filter cannot flicker the stream.
 * - After bypassCooldownMs (default 3000ms), the next frame is a
 *   probe: filtering is attempted once. Within budget -> filtering
 *   resumes; over budget -> bypass restarts. No flapping.
 *
 * This TS governor is the shared logic + preview/test reference.
 * The native processors implement the identical thresholds with real
 * measured durations (see ARCHITECTURE.md §M3); the thresholds are
 * the contract, not the language.
 *
 * Clock: callers pass nowMs explicitly (default Date.now) so tests
 * can use a fake clock. The governor never reads the wall clock
 * itself except through that function.
 */

export const DEFAULT_TARGET_FPS = 15;
export const DEFAULT_MAX_CONSECUTIVE_DROPS = 8;
export const DEFAULT_BYPASS_COOLDOWN_MS = 3000;

export type GovernorObservation = "applied" | "dropped" | "bypassed";

export class FilterPerformanceGovernor {
  readonly budgetMs: number;
  readonly maxConsecutiveDrops: number;
  readonly bypassCooldownMs: number;
  private readonly nowMs: () => number;

  private consecutiveDrops = 0;
  private bypassed = false;
  private bypassUntilMs = 0;

  constructor(
    config: {
      targetFps?: number;
      maxConsecutiveDrops?: number;
      bypassCooldownMs?: number;
    } = {},
    nowMs: () => number = () => Date.now(),
  ) {
    const targetFps = config.targetFps ?? DEFAULT_TARGET_FPS;
    if (!(targetFps > 0)) {
      throw new RangeError(
        `targetFps must be positive, got ${String(targetFps)}`,
      );
    }
    const maxConsecutiveDrops =
      config.maxConsecutiveDrops ?? DEFAULT_MAX_CONSECUTIVE_DROPS;
    if (!Number.isInteger(maxConsecutiveDrops) || maxConsecutiveDrops < 1) {
      throw new RangeError(
        `maxConsecutiveDrops must be an integer >= 1, got ${String(
          maxConsecutiveDrops,
        )}`,
      );
    }
    const bypassCooldownMs =
      config.bypassCooldownMs ?? DEFAULT_BYPASS_COOLDOWN_MS;
    if (!(bypassCooldownMs >= 0)) {
      throw new RangeError(
        `bypassCooldownMs must be >= 0, got ${String(bypassCooldownMs)}`,
      );
    }
    this.budgetMs = 1000 / targetFps;
    this.maxConsecutiveDrops = maxConsecutiveDrops;
    this.bypassCooldownMs = bypassCooldownMs;
    this.nowMs = nowMs;
  }

  /**
   * Ask whether this frame may be filtered. Returns false while
   * bypassed and inside the cooldown (caller passes the frame through
   * unfiltered without measuring). Returns true when not bypassed,
   * or when the cooldown has elapsed — that frame is the probe.
   */
  admit(now?: number): boolean {
    const t = now ?? this.nowMs();
    if (!this.bypassed) return true;
    return t >= this.bypassUntilMs;
  }

  /**
   * Report a filtered frame's measured render duration. Within
   * budget -> "applied" (drops reset, bypass clears — this is how a
   * probe recovers). Over budget -> "dropped", or "bypassed" when
   * the drop streak hits maxConsecutiveDrops (bypass starts now).
   */
  observe(durationMs: number, now?: number): GovernorObservation {
    const t = now ?? this.nowMs();
    if (durationMs <= this.budgetMs) {
      this.consecutiveDrops = 0;
      this.bypassed = false;
      this.bypassUntilMs = 0;
      return "applied";
    }
    this.consecutiveDrops += 1;
    if (this.consecutiveDrops >= this.maxConsecutiveDrops) {
      this.bypassed = true;
      this.bypassUntilMs = t + this.bypassCooldownMs;
      return "bypassed";
    }
    return "dropped";
  }

  get status(): {
    bypassed: boolean;
    consecutiveDrops: number;
    budgetMs: number;
  } {
    return {
      bypassed: this.bypassed,
      consecutiveDrops: this.consecutiveDrops,
      budgetMs: this.budgetMs,
    };
  }

  reset(): void {
    this.consecutiveDrops = 0;
    this.bypassed = false;
    this.bypassUntilMs = 0;
  }
}
