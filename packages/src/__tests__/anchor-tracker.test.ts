/**
 * AnchorTracker tests (M2). Pure TS — compiled with tsc and run
 * under node --test. A fake clock makes loss/gap behavior exact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnchorTracker } from "../anchor-tracker";
import type { LandmarkPayload } from "../types";

function payload(
  faceId: string,
  landmarks: Array<{ index: number; x: number; y: number }>,
  bounds = { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
): LandmarkPayload {
  return {
    type: "face.landmarks",
    faceId,
    landmarks,
    bounds,
    timestampMs: 0,
    coordinateSpace: "normalized-top-left",
    mirrored: false,
    landmarkMap: "mediapipe-478",
  };
}

function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${expected}, got ${actual}`,
  );
}

describe("AnchorTracker", () => {
  it("snaps on the first payload", () => {
    const tracker = new AnchorTracker("a");
    tracker.update(payload("a", [{ index: 1, x: 0.2, y: 0.3 }]));
    const state = tracker.getState();
    assert.equal(state.status, "tracked");
    assert.deepEqual(state.landmarks[1], { x: 0.2, y: 0.3 });
    assert.deepEqual(state.latestIndices, [1]);
  });

  it("smooths with EMA (alpha 0.5)", () => {
    const tracker = new AnchorTracker("a", { smoothingAlpha: 0.5 }, () => 0);
    tracker.update(payload("a", [{ index: 1, x: 0.2, y: 0.3 }]));
    tracker.update(payload("a", [{ index: 1, x: 0.4, y: 0.5 }]));
    approx(tracker.getState().landmarks[1].x, 0.3);
    approx(tracker.getState().landmarks[1].y, 0.4);
    tracker.update(payload("a", [{ index: 1, x: 0.6, y: 0.5 }]));
    approx(tracker.getState().landmarks[1].x, 0.45);
    approx(tracker.getState().landmarks[1].y, 0.45);
  });

  it("smooths bounds with the same alpha", () => {
    const tracker = new AnchorTracker("a", { smoothingAlpha: 0.5 }, () => 0);
    tracker.update(
      payload("a", [{ index: 1, x: 0.5, y: 0.5 }], {
        x: 0.2,
        y: 0.2,
        width: 0.4,
        height: 0.4,
      }),
    );
    tracker.update(
      payload("a", [{ index: 1, x: 0.5, y: 0.5 }], {
        x: 0.4,
        y: 0.4,
        width: 0.6,
        height: 0.6,
      }),
    );
    const bounds = tracker.getState().bounds;
    approx(bounds.x, 0.3);
    approx(bounds.width, 0.5);
  });

  it("marks lost immediately on markLost", () => {
    const tracker = new AnchorTracker("a", {}, () => 0);
    tracker.update(payload("a", [{ index: 1, x: 0.5, y: 0.5 }]));
    assert.equal(tracker.getState().status, "tracked");
    tracker.markLost();
    assert.equal(tracker.getState().status, "lost");
    assert.equal(tracker.isLost(), true);
  });

  it("goes lost after the gap threshold, not at it", () => {
    let now = 0;
    const tracker = new AnchorTracker("a", { lostAfterMs: 1500 }, () => now);
    tracker.update(payload("a", [{ index: 1, x: 0.5, y: 0.5 }]));
    now = 1500;
    assert.equal(tracker.isLost(), false);
    now = 1501;
    assert.equal(tracker.isLost(), true);
  });

  it("snaps on reappearance after loss", () => {
    const tracker = new AnchorTracker("a", { smoothingAlpha: 0.5 }, () => 0);
    tracker.update(payload("a", [{ index: 1, x: 0.2, y: 0.2 }]));
    tracker.markLost();
    tracker.update(payload("a", [{ index: 1, x: 0.8, y: 0.8 }]));
    // Snap, not EMA (0.2 + 0.5*(0.8-0.2) would be 0.5).
    approx(tracker.getState().landmarks[1].x, 0.8);
    assert.equal(tracker.getState().status, "tracked");
  });

  it("snaps on reappearance after a gap", () => {
    let now = 0;
    const tracker = new AnchorTracker(
      "a",
      { smoothingAlpha: 0.5, lostAfterMs: 1500 },
      () => now,
    );
    tracker.update(payload("a", [{ index: 1, x: 0.2, y: 0.2 }]));
    now = 5000;
    tracker.update(payload("a", [{ index: 1, x: 0.8, y: 0.8 }]));
    approx(tracker.getState().landmarks[1].x, 0.8);
  });

  it("drops indices absent from the latest payload", () => {
    const tracker = new AnchorTracker("a", {}, () => 0);
    tracker.update(
      payload("a", [
        { index: 1, x: 0.5, y: 0.5 },
        { index: 10, x: 0.5, y: 0.2 },
      ]),
    );
    tracker.update(payload("a", [{ index: 1, x: 0.6, y: 0.6 }]));
    const state = tracker.getState();
    assert.deepEqual(state.latestIndices, [1]);
    assert.equal(state.landmarks[10], undefined);
  });

  it("rejects invalid config and foreign payloads", () => {
    assert.throws(() => new AnchorTracker("a", { smoothingAlpha: 0 }));
    assert.throws(() => new AnchorTracker("a", { smoothingAlpha: 1.5 }));
    assert.throws(() => new AnchorTracker("a", { lostAfterMs: 0 }));
    const tracker = new AnchorTracker("a");
    assert.throws(() =>
      tracker.update(payload("b", [{ index: 1, x: 0.5, y: 0.5 }])),
    );
  });
});
