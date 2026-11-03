/**
 * LandmarkStreamConsumer tests (M2). Pure TS — compiled with tsc and
 * run under node --test. A fake clock makes gap behavior exact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LandmarkStreamConsumer } from "../landmark-stream";
import type { FaceLostPayload, LandmarkPayload } from "../types";

function landmarks(
  faceId: string,
  points: Array<{ index: number; x: number; y: number }> = [
    { index: 1, x: 0.5, y: 0.4 },
  ],
): LandmarkPayload {
  return {
    type: "face.landmarks",
    faceId,
    landmarks: points,
    bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
    timestampMs: 0,
    coordinateSpace: "normalized-top-left",
    mirrored: false,
    landmarkMap: "mediapipe-478",
  };
}

function lost(faceId: string): FaceLostPayload {
  return { type: "face.lost", faceId, timestampMs: 0 };
}

describe("LandmarkStreamConsumer", () => {
  it("tracks faces and picks the first tracked as primary", () => {
    const consumer = new LandmarkStreamConsumer({}, () => 0);
    consumer.handlePayload(landmarks("a"));
    consumer.handlePayload(landmarks("b"));
    assert.equal(consumer.getPrimaryFaceState()?.faceId, "a");
    assert.deepEqual(
      consumer.getAllFaceStates().map((s) => s.faceId),
      ["a", "b"],
    );
  });

  it("auto primary moves to the next tracked face on loss", () => {
    const consumer = new LandmarkStreamConsumer({}, () => 0);
    consumer.handlePayload(landmarks("a"));
    consumer.handlePayload(landmarks("b"));
    consumer.handlePayload(lost("a"));
    assert.equal(consumer.getPrimaryFaceState()?.faceId, "b");
    assert.equal(consumer.getFaceState("a")?.status, "lost");
  });

  it("auto primary falls back to the first known face when none tracked", () => {
    const consumer = new LandmarkStreamConsumer({}, () => 0);
    consumer.handlePayload(landmarks("a"));
    consumer.handlePayload(lost("a"));
    const primary = consumer.getPrimaryFaceState();
    assert.equal(primary?.faceId, "a");
    assert.equal(primary?.status, "lost");
  });

  it("explicit primary stays selected even when lost", () => {
    const consumer = new LandmarkStreamConsumer(
      { primaryFaceId: "b" },
      () => 0,
    );
    consumer.handlePayload(landmarks("a"));
    consumer.handlePayload(landmarks("b"));
    consumer.handlePayload(lost("b"));
    assert.equal(consumer.getPrimaryFaceState()?.faceId, "b");
    assert.equal(consumer.getPrimaryFaceState()?.status, "lost");
  });

  it("explicit primary returns undefined when never seen", () => {
    const consumer = new LandmarkStreamConsumer(
      { primaryFaceId: "ghost" },
      () => 0,
    );
    consumer.handlePayload(landmarks("a"));
    assert.equal(consumer.getPrimaryFaceState(), undefined);
  });

  it("setPrimaryFace(null) returns to auto selection", () => {
    const consumer = new LandmarkStreamConsumer(
      { primaryFaceId: "b" },
      () => 0,
    );
    consumer.handlePayload(landmarks("a"));
    consumer.handlePayload(landmarks("b"));
    assert.equal(consumer.getPrimaryFaceState()?.faceId, "b");
    consumer.setPrimaryFace(null);
    assert.equal(consumer.getPrimaryFaceState()?.faceId, "a");
  });

  it("notifies update listeners and honors unsubscribe", () => {
    const consumer = new LandmarkStreamConsumer({}, () => 0);
    let calls = 0;
    const unsubscribe = consumer.onUpdate(() => {
      calls += 1;
    });
    consumer.handlePayload(landmarks("a"));
    consumer.handlePayload(landmarks("a"));
    assert.equal(calls, 2);
    unsubscribe();
    consumer.handlePayload(landmarks("a"));
    assert.equal(calls, 2);
  });

  it("fires onFaceLost listeners and tolerates unknown faces", () => {
    const consumer = new LandmarkStreamConsumer({}, () => 0);
    const seen: string[] = [];
    consumer.onFaceLost((payload) => {
      seen.push(payload.faceId);
    });
    consumer.handlePayload(lost("ghost"));
    consumer.handlePayload(landmarks("a"));
    consumer.handlePayload(lost("a"));
    assert.deepEqual(seen, ["ghost", "a"]);
  });

  it("marks faces lost after a payload gap", () => {
    let now = 0;
    const consumer = new LandmarkStreamConsumer(
      { lostAfterMs: 1500 },
      () => now,
    );
    consumer.handlePayload(landmarks("a"));
    now = 2000;
    assert.equal(consumer.getFaceState("a")?.status, "lost");
    consumer.handlePayload(landmarks("a"));
    assert.equal(consumer.getFaceState("a")?.status, "tracked");
  });
});
