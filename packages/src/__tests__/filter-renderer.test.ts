/**
 * filter-renderer tests (M3). Pure TS — compiled with tsc and run
 * under node --test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anchorRectNormalized,
  applyGradeToRgb,
  parseHexColor,
  renderFilterCommands,
  validateFilterEffect,
} from "../filter-renderer";
import { GOLDEN_SHADES, WARM_SUNSET } from "../sample-filters";
import type { EffectDefinition, FaceAnchorState } from "../types";

function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

function faceState(overrides: Partial<FaceAnchorState> = {}): FaceAnchorState {
  return {
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
    ...overrides,
  };
}

function baseEffect(
  overrides: Partial<EffectDefinition> = {},
): EffectDefinition {
  return {
    id: "test-filter",
    kind: "filter",
    name: "Test Filter",
    renderPath: "pre-encode",
    animation: { mode: "loop" },
    anchors: [
      {
        placement: "on-face",
        landmarkIndices: [33, 263],
        scaleToFace: 1.15,
        offset: { x: 0, y: 0 },
      },
    ],
    assets: [],
    trackingLostFallback: "hide",
    ...overrides,
  };
}

describe("parseHexColor", () => {
  it("parses #rrggbb into 0..1 channels", () => {
    const c = parseHexColor("#d4af37");
    approx(c.r, 212 / 255);
    approx(c.g, 175 / 255);
    approx(c.b, 55 / 255);
  });

  it("rejects malformed colors", () => {
    assert.throws(() => parseHexColor("d4af37"));
    assert.throws(() => parseHexColor("#fff"));
    assert.throws(() => parseHexColor("#gggggg"));
  });
});

describe("applyGradeToRgb", () => {
  it("is identity for a neutral grade", () => {
    const out = applyGradeToRgb(
      { r: 0.2, g: 0.5, b: 0.8 },
      { warmth: 0, brightness: 0, saturation: 1, contrast: 1 },
    );
    approx(out.r, 0.2);
    approx(out.g, 0.5);
    approx(out.b, 0.8);
  });

  it("warmth raises red and lowers blue", () => {
    const out = applyGradeToRgb(
      { r: 0.5, g: 0.5, b: 0.5 },
      { warmth: 1, brightness: 0, saturation: 1, contrast: 1 },
    );
    approx(out.r, 0.6);
    approx(out.g, 0.5);
    approx(out.b, 0.4);
  });

  it("saturation 0 gives luminance gray", () => {
    const out = applyGradeToRgb(
      { r: 1, g: 0, b: 0 },
      { warmth: 0, brightness: 0, saturation: 0, contrast: 1 },
    );
    const gray = 0.299;
    approx(out.r, gray);
    approx(out.g, gray);
    approx(out.b, gray);
  });

  it("contrast pivots around 0.5 and brightness adds", () => {
    const out = applyGradeToRgb(
      { r: 0.75, g: 0.25, b: 0.5 },
      { warmth: 0, brightness: 0.1, saturation: 1, contrast: 2 },
    );
    approx(out.r, 1); // (0.75-0.5)*2+0.5+0.1 = 1.1 -> clamped
    approx(out.g, 0.1); // (0.25-0.5)*2+0.5+0.1 = 0.1
    approx(out.b, 0.6);
  });
});

describe("anchorRectNormalized", () => {
  it("centers on-face rects on the landmark centroid", () => {
    const rect = anchorRectNormalized(faceState(), baseEffect().anchors[0]);
    // centroid (0.5, 0.4); width = 1.15*0.4 = 0.46, height = 0.46.
    approx(rect.x, 0.5 - 0.23);
    approx(rect.y, 0.4 - 0.23);
    approx(rect.width, 0.46);
    approx(rect.height, 0.46);
  });

  it("bottom-pins above-head rects at the bounds top-center", () => {
    const rect = anchorRectNormalized(faceState(), {
      placement: "above-head",
      landmarkIndices: [],
      scaleToFace: 1,
      offset: { x: 0, y: 0 },
    });
    approx(rect.x, 0.5 - 0.2);
    approx(rect.y, 0.2 - 0.4); // bottom edge at bounds top (y=0.2)
    approx(rect.width, 0.4);
    approx(rect.height, 0.4);
  });

  it("covers the full frame for fullscreen anchors", () => {
    const rect = anchorRectNormalized(faceState(), {
      placement: "fullscreen",
      landmarkIndices: [],
      scaleToFace: 1,
      offset: { x: 0, y: 0 },
    });
    assert.deepEqual(rect, { x: 0, y: 0, width: 1, height: 1 });
  });

  it("applies offsets in face-width units", () => {
    const rect = anchorRectNormalized(faceState(), {
      placement: "on-face",
      landmarkIndices: [33, 263],
      scaleToFace: 1,
      offset: { x: 0.5, y: -0.25 },
    });
    // centroid (0.5, 0.4), face width 0.4 -> +0.2 x, -0.1 y.
    approx(rect.x, 0.5 - 0.2 + 0.2);
    approx(rect.y, 0.4 - 0.2 - 0.1);
  });
});

describe("renderFilterCommands", () => {
  it("emits grade always and shapes only with a tracked face", () => {
    const effect = baseEffect({
      grade: { warmth: 0.3, brightness: 0, saturation: 1, contrast: 1 },
      shapes: [
        {
          kind: "rect",
          anchor: 0,
          color: "#ffffff",
          fill: true,
        },
      ],
    });
    const withFace = renderFilterCommands(effect, faceState());
    assert.equal(withFace.length, 2);
    assert.equal(withFace[0].kind, "grade");
    assert.equal(withFace[1].kind, "shape");
    const withoutFace = renderFilterCommands(effect, null);
    assert.equal(withoutFace.length, 1);
    assert.equal(withoutFace[0].kind, "grade");
    const lost = renderFilterCommands(effect, faceState({ status: "lost" }));
    assert.equal(lost.length, 1);
    assert.equal(lost[0].kind, "grade");
  });

  it("maps shape sub-rects and points into frame space", () => {
    const effect = baseEffect({
      shapes: [
        {
          kind: "line",
          anchor: 0,
          points: [
            { x: 0, y: 0.5 },
            { x: 1, y: 0.5 },
          ],
          color: "#d4af37",
        },
      ],
    });
    const commands = renderFilterCommands(effect, faceState());
    assert.equal(commands.length, 1);
    const cmd = commands[0];
    assert.equal(cmd.kind, "shape");
    if (cmd.kind !== "shape") throw new Error("unreachable");
    // Anchor rect: x 0.27, y 0.17, w/h 0.46 (see centroid test).
    approx(cmd.rect.x, 0.27);
    approx(cmd.rect.y, 0.17);
    approx(cmd.points[0].x, 0.27);
    approx(cmd.points[0].y, 0.17 + 0.23);
    approx(cmd.points[1].x, 0.27 + 0.46);
  });

  it("mirrors rects when the pipeline mirrors frames", () => {
    const effect = baseEffect({
      shapes: [{ kind: "rect", anchor: 0, color: "#ffffff" }],
    });
    const commands = renderFilterCommands(effect, faceState(), {
      mirrored: true,
    });
    const cmd = commands[0];
    if (cmd.kind !== "shape") throw new Error("unreachable");
    approx(cmd.rect.x, 1 - (0.27 + 0.46));
    approx(cmd.rect.y, 0.17);
  });

  it("skips shapes whose anchor index is missing", () => {
    const effect = baseEffect({
      shapes: [{ kind: "rect", anchor: 5, color: "#ffffff" }],
    });
    assert.equal(renderFilterCommands(effect, faceState()).length, 0);
  });
});

describe("validateFilterEffect", () => {
  it("accepts the sample filters", () => {
    validateFilterEffect(GOLDEN_SHADES);
    validateFilterEffect(WARM_SUNSET);
  });

  it("rejects bad colors, anchors, grades, and line points", () => {
    assert.throws(() =>
      validateFilterEffect(
        baseEffect({
          shapes: [{ kind: "rect", anchor: 0, color: "gold" }],
        }),
      ),
    );
    assert.throws(() =>
      validateFilterEffect(
        baseEffect({
          shapes: [{ kind: "rect", anchor: 9, color: "#ffffff" }],
        }),
      ),
    );
    assert.throws(() =>
      validateFilterEffect(
        baseEffect({
          grade: { warmth: 2, brightness: 0, saturation: 1, contrast: 1 },
        }),
      ),
    );
    assert.throws(() =>
      validateFilterEffect(
        baseEffect({
          shapes: [{ kind: "line", anchor: 0, color: "#ffffff" }],
        }),
      ),
    );
    assert.throws(() =>
      validateFilterEffect(
        baseEffect({
          shapes: [
            {
              kind: "line",
              anchor: 0,
              color: "#ffffff",
              points: [{ x: 0, y: 0 }],
            },
          ],
        }),
      ),
    );
  });
});
