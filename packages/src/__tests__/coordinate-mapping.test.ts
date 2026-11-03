/**
 * Coordinate mapping tests (M2). Pure TS — compiled with tsc and run
 * under node --test. No React Native imports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAssetRect,
  mapSensorBoundsToView,
  mapSensorPointToView,
  resolveAnchorPoint,
} from "../coordinate-mapping";
import type { FaceAnchorState } from "../types";

function state(overrides: Partial<FaceAnchorState> = {}): FaceAnchorState {
  return {
    faceId: "face-1",
    landmarks: {
      1: { x: 0.5, y: 0.4 },
      10: { x: 0.5, y: 0.2 },
      33: { x: 0.43, y: 0.4 },
    },
    latestIndices: [1, 10, 33],
    bounds: { x: 0.31, y: 0.18, width: 0.38, height: 0.44 },
    lastSeenMs: 0,
    status: "tracked",
    mirrored: false,
    landmarkMap: "mediapipe-478",
    ...overrides,
  };
}

function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${expected}, got ${actual}`,
  );
}

describe("mapSensorPointToView", () => {
  it("maps same-aspect cover 1:1", () => {
    const p = mapSensorPointToView(
      { x: 0.25, y: 0.5 },
      {
        mirrored: false,
        videoSize: { width: 720, height: 1280 },
        viewSize: { width: 360, height: 640 },
        resizeMode: "cover",
      },
    );
    approx(p.x, 90);
    approx(p.y, 320);
  });

  it("mirrors x before mapping when mirrored", () => {
    const p = mapSensorPointToView(
      { x: 0.25, y: 0.5 },
      {
        mirrored: true,
        videoSize: { width: 720, height: 1280 },
        viewSize: { width: 360, height: 640 },
        resizeMode: "cover",
      },
    );
    approx(p.x, 270);
    approx(p.y, 320);
  });

  it("cover-crops landscape video into a portrait view", () => {
    const p = mapSensorPointToView(
      { x: 0.5, y: 0.5 },
      {
        mirrored: false,
        videoSize: { width: 1280, height: 720 },
        viewSize: { width: 360, height: 640 },
        resizeMode: "cover",
      },
    );
    approx(p.x, 180);
    approx(p.y, 320);
  });

  it("contain-letterboxes landscape video into a portrait view", () => {
    const p = mapSensorPointToView(
      { x: 0.5, y: 0.5 },
      {
        mirrored: false,
        videoSize: { width: 1280, height: 720 },
        viewSize: { width: 360, height: 640 },
        resizeMode: "contain",
      },
    );
    approx(p.x, 180);
    approx(p.y, 320);
    const corner = mapSensorPointToView(
      { x: 0, y: 0 },
      {
        mirrored: false,
        videoSize: { width: 1280, height: 720 },
        viewSize: { width: 360, height: 640 },
        resizeMode: "contain",
      },
    );
    approx(corner.y, 218.75);
  });

  it("rejects non-positive sizes", () => {
    assert.throws(() =>
      mapSensorPointToView(
        { x: 0.5, y: 0.5 },
        {
          mirrored: false,
          videoSize: { width: 0, height: 1280 },
          viewSize: { width: 360, height: 640 },
        },
      ),
    );
  });
});

describe("mapSensorBoundsToView", () => {
  it("maps a centered box 1:1", () => {
    const r = mapSensorBoundsToView(
      { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      {
        mirrored: false,
        videoSize: { width: 720, height: 1280 },
        viewSize: { width: 360, height: 640 },
        resizeMode: "cover",
      },
    );
    approx(r.left, 90);
    approx(r.top, 160);
    approx(r.width, 180);
    approx(r.height, 320);
  });
});

describe("resolveAnchorPoint", () => {
  it("above-head resolves to bounds top-center", () => {
    const p = resolveAnchorPoint(state(), {
      landmarkIndices: [1],
      placement: "above-head",
      scaleToFace: 1,
    });
    assert.deepEqual(p, { x: 0.5, y: 0.18 });
  });

  it("follow resolves to the centroid of fresh indices", () => {
    const p = resolveAnchorPoint(state(), {
      landmarkIndices: [33, 1],
      placement: "follow",
      scaleToFace: 1,
    });
    assert.ok(p);
    approx(p.x, 0.465);
    approx(p.y, 0.4);
  });

  it("follow falls back to bounds center when indices are stale", () => {
    const p = resolveAnchorPoint(state({ latestIndices: [10] }), {
      landmarkIndices: [1, 33],
      placement: "follow",
      scaleToFace: 1,
    });
    assert.deepEqual(p, { x: 0.5, y: 0.4 });
  });

  it("fullscreen resolves to null", () => {
    assert.equal(
      resolveAnchorPoint(state(), {
        landmarkIndices: [],
        placement: "fullscreen",
        scaleToFace: 1,
      }),
      null,
    );
  });
});

describe("computeAssetRect", () => {
  it("above-head pins the asset bottom to the anchor", () => {
    const r = computeAssetRect({
      anchorPoint: { x: 180, y: 100 },
      faceWidthPx: 180,
      anchor: {
        landmarkIndices: [],
        placement: "above-head",
        scaleToFace: 1.2,
      },
      asset: { uri: "x", kind: "image", width: 100, height: 100 },
      viewSize: { width: 360, height: 640 },
    });
    approx(r.width, 216);
    approx(r.height, 216);
    approx(r.left, 72);
    approx(r.top, -116);
  });

  it("on-face centers the asset on the anchor", () => {
    const r = computeAssetRect({
      anchorPoint: { x: 180, y: 100 },
      faceWidthPx: 180,
      anchor: { landmarkIndices: [], placement: "on-face", scaleToFace: 1.2 },
      asset: { uri: "x", kind: "image", width: 100, height: 100 },
      viewSize: { width: 360, height: 640 },
    });
    approx(r.left, 72);
    approx(r.top, -8);
  });

  it("offset applies in face-width units, y positive down", () => {
    const r = computeAssetRect({
      anchorPoint: { x: 180, y: 100 },
      faceWidthPx: 180,
      anchor: {
        landmarkIndices: [],
        placement: "above-head",
        scaleToFace: 1.2,
        offset: { x: 0.1, y: -0.05 },
      },
      asset: { uri: "x", kind: "image", width: 100, height: 100 },
      viewSize: { width: 360, height: 640 },
    });
    approx(r.left, 90);
    approx(r.top, -125);
  });

  it("fullscreen fills the view", () => {
    const r = computeAssetRect({
      anchorPoint: null,
      faceWidthPx: 180,
      anchor: { landmarkIndices: [], placement: "fullscreen", scaleToFace: 1 },
      asset: { uri: "x", kind: "image", width: 100, height: 100 },
      viewSize: { width: 360, height: 640 },
    });
    assert.deepEqual(r, { left: 0, top: 0, width: 360, height: 640 });
  });

  it("invalid asset size falls back to square", () => {
    const r = computeAssetRect({
      anchorPoint: { x: 180, y: 100 },
      faceWidthPx: 180,
      anchor: { landmarkIndices: [], placement: "on-face", scaleToFace: 1 },
      asset: { uri: "x", kind: "image", width: 0, height: 0 },
      viewSize: { width: 360, height: 640 },
    });
    approx(r.width, 180);
    approx(r.height, 180);
  });
});
