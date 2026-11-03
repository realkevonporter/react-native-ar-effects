/**
 * sample-filters tests (M3). Pure TS — compiled with tsc and run
 * under node --test. The catalogue is M4; these two samples must
 * stay valid EffectDefinitions with renderPath "pre-encode".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderFilterCommands, validateFilterEffect } from "../filter-renderer";
import { GOLDEN_SHADES, SAMPLE_FILTERS, WARM_SUNSET } from "../sample-filters";

describe("sample filters", () => {
  it("both samples validate and are pre-encode filters", () => {
    for (const effect of SAMPLE_FILTERS) {
      validateFilterEffect(effect);
      assert.equal(effect.kind, "filter");
      assert.equal(effect.renderPath, "pre-encode");
    }
    assert.equal(SAMPLE_FILTERS.length, 2);
  });

  it("golden shades anchors on the eye corners", () => {
    assert.equal(GOLDEN_SHADES.anchors.length, 1);
    assert.deepEqual(GOLDEN_SHADES.anchors[0].landmarkIndices, [33, 263]);
    assert.equal(GOLDEN_SHADES.shapes?.length, 3);
    assert.equal(GOLDEN_SHADES.grade, undefined);
    // Shapes render from a tracked face.
    const commands = renderFilterCommands(GOLDEN_SHADES, {
      faceId: "face-1",
      landmarks: {
        33: { x: 0.4, y: 0.4 },
        263: { x: 0.6, y: 0.4 },
      },
      latestIndices: [33, 263],
      bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
      lastSeenMs: 0,
      status: "tracked",
      mirrored: false,
      landmarkMap: "mediapipe-478",
    });
    assert.equal(commands.length, 3);
  });

  it("warm sunset is grade-only: no anchors, no shapes", () => {
    assert.deepEqual(WARM_SUNSET.anchors, []);
    assert.equal(WARM_SUNSET.shapes, undefined);
    assert.ok(WARM_SUNSET.grade);
    assert.equal(WARM_SUNSET.grade?.warmth, 0.3);
    // Grade renders even with no face.
    const commands = renderFilterCommands(WARM_SUNSET, null);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, "grade");
  });
});
