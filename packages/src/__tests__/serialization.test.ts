/**
 * Serialization tests (M2). Pure TS — compiled with tsc and run
 * under node --test. Proves the socket JSON shape round-trips through
 * the consumer exactly, and that payloadFromFrame subsets correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LandmarkStreamConsumer, payloadFromFrame } from "../landmark-stream";
import type { FaceFrame } from "../types";

describe("payload JSON round-trip", () => {
  it("a stringified LandmarkPayload feeds the consumer exactly", () => {
    const consumer = new LandmarkStreamConsumer({}, () => 0);
    const json = JSON.stringify({
      type: "face.landmarks",
      faceId: "host-1",
      landmarks: [
        { index: 1, x: 0.512, y: 0.381 },
        { index: 33, x: 0.441, y: 0.402 },
      ],
      bounds: { x: 0.31, y: 0.18, width: 0.38, height: 0.44 },
      timestampMs: 1730000000123,
      coordinateSpace: "normalized-top-left",
      mirrored: true,
      landmarkMap: "mediapipe-478",
    });
    consumer.handlePayload(JSON.parse(json));
    const state = consumer.getFaceState("host-1");
    assert.ok(state);
    assert.equal(state.status, "tracked");
    assert.equal(state.mirrored, true);
    assert.deepEqual(state.landmarks[1], { x: 0.512, y: 0.381 });
    assert.deepEqual(state.landmarks[33], { x: 0.441, y: 0.402 });
    assert.deepEqual(state.latestIndices, [1, 33]);
  });

  it("a stringified face.lost payload marks the face lost", () => {
    const consumer = new LandmarkStreamConsumer({}, () => 0);
    consumer.handlePayload(
      JSON.parse(
        JSON.stringify({
          type: "face.landmarks",
          faceId: "host-1",
          landmarks: [{ index: 1, x: 0.5, y: 0.4 }],
          bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
          timestampMs: 1,
          coordinateSpace: "normalized-top-left",
          mirrored: false,
          landmarkMap: "mediapipe-478",
        }),
      ),
    );
    consumer.handlePayload(
      JSON.parse(
        JSON.stringify({
          type: "face.lost",
          faceId: "host-1",
          timestampMs: 2,
        }),
      ),
    );
    assert.equal(consumer.getFaceState("host-1")?.status, "lost");
  });
});

describe("payloadFromFrame", () => {
  it("subsets landmarks and preserves frame metadata", () => {
    const landmarks = Array.from({ length: 478 }, (_, i) => ({
      x: i / 478,
      y: 0.5,
      z: 0,
    }));
    const frame: FaceFrame = {
      faceId: "face-9",
      landmarks,
      landmarkMap: "mediapipe-478",
      bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
      timestampMs: 4242,
      source: "mediapipe",
    };
    const payload = payloadFromFrame(frame, [1, 10, 152], true);
    assert.equal(payload.type, "face.landmarks");
    assert.equal(payload.faceId, "face-9");
    assert.equal(payload.timestampMs, 4242);
    assert.equal(payload.mirrored, true);
    assert.equal(payload.coordinateSpace, "normalized-top-left");
    assert.equal(payload.landmarkMap, "mediapipe-478");
    assert.deepEqual(
      payload.landmarks.map((p) => p.index),
      [1, 10, 152],
    );
    assert.equal(payload.landmarks[0].x, 1 / 478);
    assert.deepEqual(payload.bounds, frame.bounds);
  });

  it("skips indices absent from the frame, never fabricates", () => {
    const frame: FaceFrame = {
      faceId: "face-9",
      landmarks: [
        { x: 0.5, y: 0.5 },
        { x: 0.6, y: 0.6 },
      ],
      landmarkMap: "mediapipe-478",
      bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
      timestampMs: 1,
      source: "mediapipe",
    };
    const payload = payloadFromFrame(frame, [0, 5, 1], false);
    assert.deepEqual(
      payload.landmarks.map((p) => p.index),
      [0, 1],
    );
  });
});
