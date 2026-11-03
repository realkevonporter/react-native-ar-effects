/**
 * effect-validation tests (M4). Pure TS — compiled with tsc and run
 * under node --test. Every invalid class must throw with a message
 * naming the problem; valid effects must pass through unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeBase64ToBytes,
  EFFECT_FORMAT_VERSION,
  validateCatalogue,
  validateEffectDefinition,
} from "../effect-validation";
import type { EffectDefinition } from "../types";

function baseFilter(
  overrides: Partial<EffectDefinition> = {},
): EffectDefinition {
  return {
    id: "test-filter",
    kind: "filter",
    name: "Test Filter",
    formatVersion: 1,
    version: 1,
    tags: ["test"],
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
    shapes: [
      {
        kind: "ellipse",
        anchor: 0,
        rect: { x: 0.02, y: 0.25, width: 0.44, height: 0.5 },
        color: "#d4af37",
        fill: false,
        lineWidth: 0.008,
      },
    ],
    assets: [],
    trackingLostFallback: "hide",
    ...overrides,
  };
}

function baseGift(overrides: Partial<EffectDefinition> = {}): EffectDefinition {
  return {
    id: "test-gift",
    kind: "gift",
    name: "Test Gift",
    formatVersion: 1,
    version: 1,
    tags: ["gift", "test"],
    renderPath: "viewer-overlay",
    animation: { mode: "once", durationMs: 5000 },
    anchors: [
      {
        placement: "follow",
        landmarkIndices: [1],
        scaleToFace: 0.9,
        offset: { x: 0, y: 0 },
      },
    ],
    assets: [
      {
        uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        kind: "image",
        width: 1,
        height: 1,
      },
    ],
    trackingLostFallback: "banner",
    ...overrides,
  };
}

function expectThrow(effect: unknown, pattern: RegExp): void {
  assert.throws(
    () => validateEffectDefinition(effect),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, pattern);
      return true;
    },
  );
}

describe("validateEffectDefinition: valid effects pass", () => {
  it("accepts a valid filter and a valid gift", () => {
    assert.deepEqual(validateEffectDefinition(baseFilter()), baseFilter());
    assert.deepEqual(validateEffectDefinition(baseGift()), baseGift());
    assert.equal(EFFECT_FORMAT_VERSION, 1);
  });

  it("accepts a grade-only filter and an assetless gift (name pill)", () => {
    const gradeOnly = baseFilter({ anchors: [], shapes: undefined });
    delete (gradeOnly as Partial<EffectDefinition>).shapes;
    gradeOnly.grade = { warmth: 0, brightness: 0, saturation: 1, contrast: 1 };
    validateEffectDefinition(gradeOnly);
    const pill = baseGift({ assets: [] });
    validateEffectDefinition(pill);
  });
});

describe("validateEffectDefinition: identity and version", () => {
  it("rejects missing, empty, and malformed ids", () => {
    expectThrow({ ...baseFilter(), id: "" }, /id/);
    expectThrow({ ...baseFilter(), id: "Bad Id" }, /id/);
    expectThrow({ ...baseFilter(), id: "has_underscore" }, /id/);
    const { id: _id, ...noId } = baseFilter();
    expectThrow(noId, /id/);
  });

  it("rejects missing and empty names", () => {
    expectThrow({ ...baseFilter(), name: "" }, /name/);
    expectThrow({ ...baseFilter(), name: "   " }, /name/);
  });

  it("rejects missing and unsupported format versions", () => {
    const { formatVersion: _fv, ...noVersion } = baseFilter();
    expectThrow(noVersion, /formatVersion is missing/);
    expectThrow(
      { ...baseFilter(), formatVersion: 2 },
      /unsupported formatVersion 2/,
    );
  });

  it("rejects non-positive and non-integer effect versions", () => {
    expectThrow({ ...baseFilter(), version: 0 }, /version/);
    expectThrow({ ...baseFilter(), version: 1.5 }, /version/);
  });

  it("rejects missing tags and empty-string tags", () => {
    expectThrow({ ...baseFilter(), tags: "funny" }, /tags/);
    expectThrow({ ...baseFilter(), tags: ["funny", ""] }, /tag/);
  });
});

describe("validateEffectDefinition: kind, animation, fallback", () => {
  it("rejects unknown kinds and crossed render paths", () => {
    expectThrow(
      { ...baseFilter(), kind: "sticker" } as unknown as EffectDefinition,
      /kind/,
    );
    expectThrow(
      { ...baseFilter(), renderPath: "viewer-overlay" },
      /pre-encode/,
    );
    expectThrow({ ...baseGift(), renderPath: "pre-encode" }, /viewer-overlay/);
  });

  it("rejects bad animation modes and timed without duration", () => {
    expectThrow(
      { ...baseFilter(), animation: { mode: "bounce" } },
      /animation\.mode/,
    );
    expectThrow(
      { ...baseFilter(), animation: { mode: "timed" } },
      /durationMs/,
    );
    expectThrow(
      { ...baseFilter(), animation: { mode: "timed", durationMs: 0 } },
      /durationMs/,
    );
  });

  it("rejects unknown fallbacks", () => {
    expectThrow(
      { ...baseFilter(), trackingLostFallback: "toast" },
      /trackingLostFallback/,
    );
  });
});

describe("validateEffectDefinition: anchors", () => {
  it("rejects out-of-range, non-integer, and bad-placement anchors", () => {
    const anchor = (landmarkIndices: unknown, extra = {}) => ({
      ...baseFilter(),
      anchors: [
        {
          placement: "on-face",
          landmarkIndices,
          scaleToFace: 1,
          ...extra,
        },
      ],
    });
    expectThrow(anchor([-1]), /landmark index/);
    expectThrow(anchor([478]), /landmark index/);
    expectThrow(anchor([33.5]), /landmark index/);
    expectThrow(anchor([33], { placement: "sideways" }), /placement/);
    expectThrow(anchor([33], { scaleToFace: 0 }), /scaleToFace/);
    expectThrow(anchor([33], { scaleToFace: 6 }), /scaleToFace/);
    expectThrow(anchor([33], { offset: { x: Number.NaN, y: 0 } }), /offset/);
  });
});

describe("validateEffectDefinition: render-path payload rules", () => {
  it("rejects filters with assets, gifts with shapes or grades", () => {
    expectThrow(
      { ...baseFilter(), assets: [baseGift().assets[0]] },
      /must not list assets/,
    );
    expectThrow(
      {
        ...baseGift(),
        shapes: [
          {
            kind: "ellipse",
            anchor: 0,
            color: "#ffffff",
            fill: true,
          },
        ],
      },
      /must not list shapes/,
    );
    expectThrow(
      {
        ...baseGift(),
        grade: { warmth: 0, brightness: 0, saturation: 1, contrast: 1 },
      },
      /must not list a grade/,
    );
  });

  it("rejects filters that render nothing", () => {
    const noop = baseFilter({ anchors: [] });
    delete (noop as Partial<EffectDefinition>).shapes;
    expectThrow(noop, /render nothing/);
  });
});

describe("validateEffectDefinition: assets", () => {
  it("rejects bad kinds, sizes, and unresolvable URIs", () => {
    const asset = (overrides: Record<string, unknown>) => ({
      ...baseGift(),
      assets: [{ ...baseGift().assets[0], ...overrides }],
    });
    expectThrow(asset({ kind: "model3d" }), /asset kind/);
    expectThrow(asset({ width: 0 }), /width and height/);
    expectThrow(asset({ uri: "" }), /uri/);
    expectThrow(asset({ uri: "bundle://orb.png" }), /unsupported scheme/);
    expectThrow(asset({ uri: "data:image/png;base64,!!!" }), /data URI/);
    expectThrow(
      asset({
        uri: "data:image/png;base64,aGVsbG8=",
      }),
      /PNG signature/,
    );
  });

  it("accepts http(s) URLs syntactically (reachability is runtime)", () => {
    validateEffectDefinition(
      baseGift({
        assets: [
          {
            uri: "https://cdn.example.com/gifts/orb.png",
            kind: "image",
            width: 128,
            height: 128,
          },
        ],
      }),
    );
  });
});

describe("validateEffectDefinition: grade and shapes", () => {
  it("rejects malformed grades and shapes loudly", () => {
    expectThrow(
      { ...baseFilter(), grade: "warm" } as unknown as EffectDefinition,
      /grade must be an object/,
    );
    expectThrow(
      {
        ...baseFilter(),
        grade: { warmth: 2, brightness: 0, saturation: 1, contrast: 1 },
      },
      /warmth/,
    );
    expectThrow(
      { ...baseFilter(), shapes: "ellipse" } as unknown as EffectDefinition,
      /shapes must be an array/,
    );
    expectThrow(
      {
        ...baseFilter(),
        shapes: [{ kind: "line", anchor: 0, color: "#ffffff" }],
      },
      /requires points/,
    );
    expectThrow(
      {
        ...baseFilter(),
        shapes: [
          {
            kind: "ellipse",
            anchor: 5,
            color: "#ffffff",
            fill: true,
          },
        ],
      },
      /anchor 5/,
    );
    expectThrow(
      {
        ...baseFilter(),
        shapes: [
          {
            kind: "ellipse",
            anchor: 0,
            color: "gold",
            fill: true,
          },
        ],
      },
      /color/,
    );
  });
});

describe("validateCatalogue", () => {
  it("accepts a valid list and rejects duplicate ids", () => {
    assert.equal(validateCatalogue([baseFilter(), baseGift()]).length, 2);
    assert.throws(
      () => validateCatalogue([baseFilter(), baseFilter()]),
      /duplicate/,
    );
  });
});

describe("decodeBase64ToBytes", () => {
  it("round-trips and rejects bad input", () => {
    const bytes = decodeBase64ToBytes("aGVsbG8=");
    assert.deepEqual([...bytes], [104, 101, 108, 108, 111]);
    assert.throws(() => decodeBase64ToBytes("!!!"));
    assert.throws(() => decodeBase64ToBytes("abc"));
  });
});
