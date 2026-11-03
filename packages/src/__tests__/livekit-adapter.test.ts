/**
 * livekit-adapter tests (M3). Pure TS — compiled with tsc and run
 * under node --test. A fake track + fake bridge stand in for the
 * fork's MediaStreamTrack and the native ARFilter module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FilterNotSupportedError,
  LiveKitFilterAdapter,
  PROCESSOR_NAME,
  type FilterableVideoTrack,
  type FilterNativeBridge,
} from "../livekit-adapter";
import { GOLDEN_SHADES } from "../sample-filters";

class FakeBridge implements FilterNativeBridge {
  registerCalls = 0;
  lastEffectJson: string | null = null;
  cleared = 0;
  registerResult = true;

  async registerProcessor(): Promise<boolean> {
    this.registerCalls += 1;
    return this.registerResult;
  }

  async setFilter(effectJson: string): Promise<void> {
    this.lastEffectJson = effectJson;
  }

  async clearFilter(): Promise<void> {
    this.cleared += 1;
  }
}

function fakeTrack(
  overrides: Partial<FilterableVideoTrack> = {},
): FilterableVideoTrack & { effectNames: string[][] } {
  const calls: string[][] = [];
  return {
    id: "track-1",
    kind: "video",
    _setVideoEffects: (names: string[]) => {
      calls.push([...names]);
    },
    effectNames: calls,
    ...overrides,
  };
}

describe("LiveKitFilterAdapter", () => {
  it("applies a filter: register once, set effect, route track", async () => {
    const bridge = new FakeBridge();
    const adapter = new LiveKitFilterAdapter(bridge);
    const track = fakeTrack();
    const applied = await adapter.applyFilter(track, GOLDEN_SHADES);
    assert.deepEqual(applied, {
      trackId: "track-1",
      effectId: "golden-shades",
      processorName: PROCESSOR_NAME,
    });
    assert.equal(bridge.registerCalls, 1);
    assert.equal(JSON.parse(bridge.lastEffectJson ?? "{}").id, "golden-shades");
    assert.deepEqual(track.effectNames, [[PROCESSOR_NAME]]);
    // Second apply reuses the registration.
    await adapter.applyFilter(track, GOLDEN_SHADES);
    assert.equal(bridge.registerCalls, 1);
    assert.deepEqual(track.effectNames, [[PROCESSOR_NAME], [PROCESSOR_NAME]]);
  });

  it("clearFilter clears native state and restores pass-through", async () => {
    const bridge = new FakeBridge();
    const adapter = new LiveKitFilterAdapter(bridge);
    const track = fakeTrack();
    await adapter.applyFilter(track, GOLDEN_SHADES);
    await adapter.clearFilter(track);
    assert.equal(bridge.cleared, 1);
    assert.deepEqual(track.effectNames[1], []); // empty = pass-through
  });

  it("rejects non-video tracks", async () => {
    const adapter = new LiveKitFilterAdapter(new FakeBridge());
    await assert.rejects(
      adapter.applyFilter(fakeTrack({ kind: "audio" }), GOLDEN_SHADES),
      (err: unknown) => err instanceof FilterNotSupportedError,
    );
  });

  it("throws FilterNotSupportedError without _setVideoEffects", async () => {
    const adapter = new LiveKitFilterAdapter(new FakeBridge());
    const track = fakeTrack({ _setVideoEffects: undefined });
    await assert.rejects(
      adapter.applyFilter(track, GOLDEN_SHADES),
      (err: unknown) =>
        err instanceof FilterNotSupportedError &&
        /_setVideoEffects/.test(err.message),
    );
  });

  it("throws when processor registration fails", async () => {
    const bridge = new FakeBridge();
    bridge.registerResult = false;
    const adapter = new LiveKitFilterAdapter(bridge);
    await assert.rejects(adapter.applyFilter(fakeTrack(), GOLDEN_SHADES));
  });

  it("isFilterable reflects kind + fork API presence", () => {
    const adapter = new LiveKitFilterAdapter(new FakeBridge());
    assert.equal(adapter.isFilterable(fakeTrack()), true);
    assert.equal(adapter.isFilterable(fakeTrack({ kind: "audio" })), false);
    assert.equal(
      adapter.isFilterable(fakeTrack({ _setVideoEffects: undefined })),
      false,
    );
  });

  it("processor name is stable (native modules register this name)", () => {
    assert.equal(PROCESSOR_NAME, "ar-effects-filter");
  });
});
