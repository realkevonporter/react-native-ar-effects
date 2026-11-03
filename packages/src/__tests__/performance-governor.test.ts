/**
 * performance-governor tests (M3). Pure TS — compiled with tsc and
 * run under node --test. A fake clock makes bypass/probe exact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FilterPerformanceGovernor } from "../performance-governor";

describe("FilterPerformanceGovernor", () => {
  it("budgets 1000/targetFps and applies within budget", () => {
    const g = new FilterPerformanceGovernor({ targetFps: 15 });
    assert.equal(g.budgetMs, 1000 / 15);
    assert.equal(g.observe(10), "applied");
    assert.equal(g.status.consecutiveDrops, 0);
    assert.equal(g.status.bypassed, false);
  });

  it("counts drops and bypasses at the streak limit", () => {
    let now = 0;
    const g = new FilterPerformanceGovernor(
      { targetFps: 10, maxConsecutiveDrops: 3, bypassCooldownMs: 1000 },
      () => now,
    );
    assert.equal(g.observe(200), "dropped"); // budget 100ms
    assert.equal(g.observe(200), "dropped");
    assert.equal(g.observe(200), "bypassed");
    assert.equal(g.status.bypassed, true);
    assert.equal(g.status.consecutiveDrops, 3);
  });

  it("does not admit frames during cooldown, then probes", () => {
    let now = 0;
    const g = new FilterPerformanceGovernor(
      { targetFps: 10, maxConsecutiveDrops: 2, bypassCooldownMs: 1000 },
      () => now,
    );
    g.observe(200);
    g.observe(200); // bypassed, cooldown until now=1000
    assert.equal(g.admit(), false);
    now = 999;
    assert.equal(g.admit(), false);
    now = 1000;
    assert.equal(g.admit(), true); // probe frame
    assert.equal(g.observe(10), "applied"); // probe recovers
    assert.equal(g.status.bypassed, false);
    assert.equal(g.status.consecutiveDrops, 0);
  });

  it("restarts bypass when the probe is also over budget", () => {
    let now = 0;
    const g = new FilterPerformanceGovernor(
      { targetFps: 10, maxConsecutiveDrops: 2, bypassCooldownMs: 1000 },
      () => now,
    );
    g.observe(200);
    g.observe(200); // bypassed until 1000
    now = 1000;
    assert.equal(g.admit(), true);
    assert.equal(g.observe(200), "bypassed"); // streak already at max
    assert.equal(g.status.bypassed, true);
    assert.equal(g.admit(), false); // new cooldown until 2000
    now = 2000;
    assert.equal(g.admit(), true);
  });

  it("resets drops on any in-budget frame (no latch on singles)", () => {
    const g = new FilterPerformanceGovernor({
      targetFps: 10,
      maxConsecutiveDrops: 3,
    });
    g.observe(200);
    g.observe(200);
    assert.equal(g.observe(10), "applied");
    assert.equal(g.status.consecutiveDrops, 0);
    assert.equal(g.status.bypassed, false);
  });

  it("reset clears bypass immediately", () => {
    const g = new FilterPerformanceGovernor({
      targetFps: 10,
      maxConsecutiveDrops: 1,
    });
    g.observe(200);
    assert.equal(g.status.bypassed, true);
    g.reset();
    assert.equal(g.status.bypassed, false);
    assert.equal(g.admit(), true);
  });

  it("rejects invalid tuning", () => {
    assert.throws(() => new FilterPerformanceGovernor({ targetFps: 0 }));
    assert.throws(
      () => new FilterPerformanceGovernor({ maxConsecutiveDrops: 0 }),
    );
    assert.throws(
      () => new FilterPerformanceGovernor({ bypassCooldownMs: -1 }),
    );
  });
});
