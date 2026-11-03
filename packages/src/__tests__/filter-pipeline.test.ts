/**
 * filter-pipeline tests (M3). Pure TS — compiled with tsc and run
 * under node --test. A fake clock makes loss behavior exact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HostFilterPipeline } from "../filter-pipeline";
import { GOLDEN_SHADES, WARM_SUNSET } from "../sample-filters";
import type { EffectDefinition, FaceFrame } from "../types";

function frame(overrides: Partial<FaceFrame> = {}): FaceFrame {
  // 478 slots; only the eye corners carry points for these tests.
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  landmarks[33] = { x: 0.4, y: 0.4 };
  landmarks[263] = { x: 0.6, y: 0.4 };
  return {
    faceId: "face-1",
    landmarks,
    landmarkMap: "mediapipe-478",
    bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
    timestampMs: 0,
    source: "mediapipe",
    ...overrides,
  };
}

describe("HostFilterPipeline", () => {
  it("reports no-filter with no effect set", () => {
    const p = new HostFilterPipeline();
    const plan = p.handleFrame(frame());
    assert.equal(plan.filtered, false);
    assert.equal(plan.effectId, null);
    assert.equal(plan.droppedReason, "no-filter");
    assert.deepEqual(plan.commands, []);
  });

  it("applies a grade-only filter without any face", () => {
    const p = new HostFilterPipeline();
    p.setEffect(WARM_SUNSET);
    const plan = p.handleFrame(frame());
    assert.equal(plan.filtered, true);
    assert.equal(plan.effectId, "warm-sunset");
    assert.equal(plan.commands.length, 1);
    assert.equal(plan.commands[0].kind, "grade");
  });

  it("renders anchor shapes from a tracked face", () => {
    const p = new HostFilterPipeline();
    p.setEffect(GOLDEN_SHADES);
    const plan = p.handleFrame(frame());
    assert.equal(plan.filtered, true);
    assert.equal(plan.effectId, "golden-shades");
    // 2 lenses + 1 bridge line.
    assert.equal(plan.commands.length, 3);
    assert.ok(plan.commands.every((c) => c.kind === "shape"));
  });

  it("hides shapes after explicit face loss, grade still applies", () => {
    const p = new HostFilterPipeline();
    const graded: EffectDefinition = {
      ...GOLDEN_SHADES,
      grade: { warmth: 0.2, brightness: 0, saturation: 1, contrast: 1 },
    };
    p.setEffect(graded);
    p.handleFrame(frame());
    p.handleFaceLost("face-1");
    // A frame for another face is ignored by the single-face tracker,
    // so the lost state persists and shapes stay hidden.
    const plan = p.handleFrame(frame({ faceId: "face-2" }));
    assert.equal(plan.filtered, true);
    assert.equal(plan.commands.length, 1);
    assert.equal(plan.commands[0].kind, "grade");
  });

  it("reports no-face for anchor effects with no tracked face", () => {
    const p = new HostFilterPipeline();
    p.setEffect(GOLDEN_SHADES);
    p.handleFrame(frame());
    p.handleFaceLost("face-1");
    const plan = p.handleFrame(frame({ faceId: "face-2" }));
    assert.equal(plan.filtered, false);
    assert.equal(plan.droppedReason, "no-face");
    assert.deepEqual(plan.commands, []);
  });

  it("re-tracks when the same face returns after loss", () => {
    const p = new HostFilterPipeline();
    p.setEffect(GOLDEN_SHADES);
    p.handleFrame(frame());
    p.handleFaceLost("face-1");
    const plan = p.handleFrame(frame()); // same faceId again
    assert.equal(plan.filtered, true);
    assert.equal(plan.commands.length, 3);
  });

  it("tracks only the first face; later faces are ignored", () => {
    const p = new HostFilterPipeline();
    p.setEffect(GOLDEN_SHADES);
    p.handleFrame(frame({ faceId: "face-1" }));
    const plan = p.handleFrame(frame({ faceId: "face-2" }));
    // The second face's landmarks never reach the tracker, so the
    // plan still reflects face-1's state (tracked, shapes present).
    assert.equal(plan.filtered, true);
    assert.equal(plan.commands.length, 3);
    assert.equal(p.getStatus().effectId, "golden-shades");
  });

  it("drops over-budget frames and empties commands", () => {
    const p = new HostFilterPipeline({ targetFps: 10 });
    p.setEffect(WARM_SUNSET);
    const plan = p.handleFrame(frame(), 500); // budget 100ms
    assert.equal(plan.filtered, false);
    assert.equal(plan.droppedReason, "over-budget");
    assert.deepEqual(plan.commands, []);
    assert.equal(p.getStatus().consecutiveDrops, 1);
  });

  it("bypasses after the drop streak and recovers on probe", () => {
    let now = 0;
    const p = new HostFilterPipeline(
      { targetFps: 10, maxConsecutiveDrops: 2, bypassCooldownMs: 1000 },
      () => now,
    );
    p.setEffect(WARM_SUNSET);
    p.handleFrame(frame(), 500);
    const bypassed = p.handleFrame(frame(), 500);
    assert.equal(bypassed.droppedReason, "bypassed");
    assert.equal(p.getStatus().bypassed, true);
    // In-budget probe after cooldown resumes filtering.
    now = 1000;
    const recovered = p.handleFrame(frame(), 10);
    assert.equal(recovered.filtered, true);
    assert.equal(p.getStatus().bypassed, false);
  });

  it("rejects invalid effects at setEffect time", () => {
    const p = new HostFilterPipeline();
    assert.throws(() =>
      p.setEffect({
        ...GOLDEN_SHADES,
        shapes: [{ kind: "rect", anchor: 7, color: "#ffffff" }],
      }),
    );
    assert.equal(p.getStatus().effectId, null);
  });

  it("setEffect(null) clears the filter and the tracker", () => {
    const p = new HostFilterPipeline();
    p.setEffect(GOLDEN_SHADES);
    p.handleFrame(frame());
    p.setEffect(null);
    const plan = p.handleFrame(frame());
    assert.equal(plan.droppedReason, "no-filter");
  });

  it("counts frames and reports status", () => {
    const p = new HostFilterPipeline();
    p.setEffect(WARM_SUNSET);
    p.handleFrame(frame());
    p.handleFrame(frame());
    const status = p.getStatus();
    assert.equal(status.framesSeen, 2);
    assert.equal(status.effectId, "warm-sunset");
    assert.equal(status.bypassed, false);
  });
});
