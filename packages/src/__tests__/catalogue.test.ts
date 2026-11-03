/**
 * catalogue tests (M4). Pure TS — compiled with tsc and run under
 * node --test. Catalogue integrity is enforced here, not by eyeball:
 * every entry must validate, every id must be unique, every asset
 * reference must resolve, and every filter must actually render.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOGUE,
  CATALOGUE_FILTERS,
  CATALOGUE_GIFTS,
  getEffectById,
  getEffectsByTag,
} from "../catalogue";
import { decodeBase64ToBytes } from "../effect-validation";
import { validateCatalogue } from "../effect-validation";
import { renderFilterCommands } from "../filter-renderer";
import type { FaceAnchorState } from "../types";

function trackedFace(): FaceAnchorState {
  const indices = [1, 10, 33, 61, 152, 263, 291];
  const landmarks: Record<number, { x: number; y: number }> = {
    1: { x: 0.5, y: 0.5 },
    10: { x: 0.5, y: 0.3 },
    33: { x: 0.4, y: 0.4 },
    61: { x: 0.45, y: 0.6 },
    152: { x: 0.5, y: 0.7 },
    263: { x: 0.6, y: 0.4 },
    291: { x: 0.55, y: 0.6 },
  };
  return {
    faceId: "face-1",
    landmarks,
    latestIndices: indices,
    bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
    lastSeenMs: 0,
    status: "tracked",
    mirrored: false,
    landmarkMap: "mediapipe-478",
  };
}

/** PNG IHDR dimensions (big-endian width/height at bytes 16/20). */
function pngDimensions(dataUri: string): { width: number; height: number } {
  const base64 = dataUri.split(",")[1];
  const bytes = decodeBase64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("catalogue integrity", () => {
  it("has 13 filters and 3 gifts, all validating with unique ids", () => {
    assert.equal(CATALOGUE_FILTERS.length, 13);
    assert.equal(CATALOGUE_GIFTS.length, 3);
    assert.equal(CATALOGUE.length, 16);
    assert.equal(validateCatalogue(CATALOGUE).length, 16);
  });

  it("every entry carries formatVersion 1, a positive version, and tags", () => {
    for (const effect of CATALOGUE) {
      assert.equal(effect.formatVersion, 1, effect.id);
      assert.ok(
        Number.isInteger(effect.version) && effect.version >= 1,
        effect.id,
      );
      assert.ok(effect.tags.length >= 1, effect.id);
      assert.ok(effect.name.trim().length > 0, effect.id);
    }
  });

  it("filters are pre-encode and gifts are viewer-overlay", () => {
    for (const effect of CATALOGUE_FILTERS) {
      assert.equal(effect.kind, "filter", effect.id);
      assert.equal(effect.renderPath, "pre-encode", effect.id);
    }
    for (const effect of CATALOGUE_GIFTS) {
      assert.equal(effect.kind, "gift", effect.id);
      assert.equal(effect.renderPath, "viewer-overlay", effect.id);
    }
  });

  it("filters carry a grade or shapes; gifts carry at least one asset", () => {
    for (const effect of CATALOGUE_FILTERS) {
      const hasGrade = effect.grade !== undefined;
      const hasShapes = (effect.shapes ?? []).length > 0;
      assert.ok(hasGrade || hasShapes, effect.id);
      assert.equal(effect.assets.length, 0, effect.id);
    }
    for (const effect of CATALOGUE_GIFTS) {
      assert.ok(effect.assets.length >= 1, effect.id);
      assert.ok(effect.anchors.length >= 1, effect.id);
    }
  });

  it("every gift image asset resolves and its dimensions match", () => {
    for (const effect of CATALOGUE_GIFTS) {
      for (const asset of effect.assets) {
        assert.equal(asset.kind, "image", effect.id);
        assert.ok(asset.uri.startsWith("data:image/png;base64,"), effect.id);
        const dims = pngDimensions(asset.uri);
        assert.equal(dims.width, asset.width, effect.id);
        assert.equal(dims.height, asset.height, effect.id);
      }
    }
  });

  it("preserves the M3 samples in the catalogue", () => {
    assert.equal(getEffectById("golden-shades").name, "Golden Shades");
    assert.equal(getEffectById("warm-sunset").name, "Warm Sunset");
  });

  it("lookups behave: known ids resolve, unknown ids throw, tags filter", () => {
    assert.equal(getEffectById("cat-ears").name, "Cat Ears");
    assert.throws(() => getEffectById("no-such-effect"), /Unknown catalogue/);
    const funny = getEffectsByTag("funny");
    assert.ok(funny.length >= 8);
    assert.ok(funny.every((e) => e.tags.includes("funny")));
    assert.deepEqual(getEffectsByTag("no-such-tag"), []);
  });
});

describe("catalogue filters render", () => {
  it("every shape filter emits commands from a tracked face", () => {
    const face = trackedFace();
    for (const effect of CATALOGUE_FILTERS) {
      if ((effect.shapes ?? []).length === 0) {
        continue;
      }
      const commands = renderFilterCommands(effect, face);
      assert.ok(commands.length >= 1, effect.id);
      assert.ok(
        commands.every((c) => c.kind === "shape"),
        effect.id,
      );
    }
  });

  it("every grade filter emits a grade command with no face", () => {
    for (const effect of CATALOGUE_FILTERS) {
      if (effect.grade === undefined) {
        continue;
      }
      const commands = renderFilterCommands(effect, null);
      assert.ok(
        commands.some((c) => c.kind === "grade"),
        effect.id,
      );
    }
  });
});
