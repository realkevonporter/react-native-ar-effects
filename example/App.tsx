/**
 * AR Effects example app (M1).
 *
 * Shows what the MediaPipe provider actually sees: the native camera
 * preview (ARCameraView) with live landmark dots overlaid, plus face
 * count and FPS. This is a demo, not a production overlay — dots are
 * React state updated at the throttled provider rate (15fps). The M2
 * overlay renderer moves this work to Reanimated/Skia worklets so
 * per-frame React renders do not jank.
 *
 * Mirroring rule (ARCHITECTURE.md §2): the native preview mirrors the
 * front camera while landmark coordinates are raw sensor space, so
 * front-camera dots flip x -> 1 - x before rendering. Hosts never
 * pre-flip; this flip is the consumer-side (viewer-side) step.
 *
 * M2 adds a mock mode ("Mock demo" button): scripted LandmarkPayloads
 * animate a face along a Lissajous path and AnchoredGiftOverlay pins a
 * gift to it — anchoring can be seen and judged WITHOUT a camera or a
 * phone. Mock mode never starts the provider. Pause stops the payload
 * stream so the 1.5s fallback banner demonstrates; Resume re-anchors.
 *
 * M3 adds a filter preview ("Filter" button, camera mode only): the
 * provider's frames also feed a HostFilterPipeline, and
 * FilterPreviewOverlay renders the plan over the preview. Dots hide
 * while a filter is active so the filter can be judged cleanly. The
 * preview is an APPROXIMATION (see FilterPreviewOverlay) — true
 * pre-encode compositing happens natively on a LiveKit track, which
 * this example does not publish.
 *
 * M4 adds the catalogue picker (EffectPicker): camera mode browses
 * CATALOGUE_FILTERS and applies the chosen filter to the preview
 * pipeline (replacing M3's cycle-through button); mock mode browses
 * CATALOGUE_GIFTS and switches the gift pinned to the scripted face
 * (replacing M3's hardcoded mock gift). M1 dots mode and the M2 mock
 * stream are otherwise unchanged.
 *
 * Requires a dev build (native modules do not run in Expo Go):
 *   npm install
 *   npx expo prebuild
 *   npx expo run:ios   # or run:android
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  AnchoredGiftOverlay,
  ARCameraView,
  CATALOGUE_FILTERS,
  CATALOGUE_GIFTS,
  HostFilterPipeline,
  LandmarkStreamConsumer,
  mediaPipeProvider,
} from "react-native-ar-effects";
import { EffectPicker } from "./EffectPicker";
import type {
  EffectDefinition,
  FaceFrame,
  FilterFramePlan,
  LandmarkPayload,
} from "react-native-ar-effects";
import { FilterPreviewOverlay } from "./FilterPreviewOverlay";

/** Well-known MediaPipe-478 anchor indices (nose, forehead, chin,
 *  eye corners, mouth corners) plus a sampled subset so the mesh
 *  distribution is visible without rendering all 478 points as Views. */
const ANCHOR_INDICES = [1, 10, 33, 61, 152, 263, 291];
const SAMPLE_STEP = 12;

function dotIndices(landmarkCount: number): number[] {
  const indices = new Set<number>(ANCHOR_INDICES);
  for (let i = 0; i < landmarkCount; i += SAMPLE_STEP) {
    indices.add(i);
  }
  return [...indices].filter((index) => index < landmarkCount);
}

/** Scripted mock face path (~15fps, matching the camera throttle). */
const MOCK_INTERVAL_MS = 66;
const MOCK_FACE_ID = "mock-face";
const MOCK_INDICES = [1, 10, 33, 152, 263];

function mockPayload(nowMs: number): LandmarkPayload {
  const t = nowMs / 1000;
  const cx = 0.5 + 0.28 * Math.sin(t * 0.7);
  const cy = 0.45 + 0.18 * Math.sin(t * 1.1 + 1);
  const offsets: Record<number, { dx: number; dy: number }> = {
    1: { dx: 0, dy: 0 },
    10: { dx: 0, dy: -0.09 },
    33: { dx: -0.06, dy: -0.03 },
    152: { dx: 0, dy: 0.11 },
    263: { dx: 0.06, dy: -0.03 },
  };
  return {
    type: "face.landmarks",
    faceId: MOCK_FACE_ID,
    landmarks: MOCK_INDICES.map((index) => ({
      index,
      x: cx + (offsets[index]?.dx ?? 0),
      y: cy + (offsets[index]?.dy ?? 0),
    })),
    bounds: { x: cx - 0.19, y: cy - 0.22, width: 0.38, height: 0.44 },
    timestampMs: nowMs,
    coordinateSpace: "normalized-top-left",
    mirrored: true,
    landmarkMap: "mediapipe-478",
  };
}

/** M3 sample filters cycled by the Filter button (index 0 = off). */

export default function App(): React.JSX.Element {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [started, setStarted] = useState(false);
  const [faces, setFaces] = useState<FaceFrame[]>([]);
  const [fps, setFps] = useState(0);
  const [cameraPosition, setCameraPosition] = useState<"front" | "back">(
    "front",
  );
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"camera" | "mock">("camera");
  const [mockPaused, setMockPaused] = useState(false);
  const [mockViewSize, setMockViewSize] = useState({ width: 0, height: 0 });
  const [mockConsumer] = useState(() => new LandmarkStreamConsumer());
  const [selectedFilter, setSelectedFilter] = useState<EffectDefinition | null>(
    null,
  );
  const [selectedGift, setSelectedGift] = useState<EffectDefinition>(
    CATALOGUE_GIFTS[0],
  );
  const [filterPlan, setFilterPlan] = useState<FilterFramePlan | null>(null);
  const [cameraViewSize, setCameraViewSize] = useState({ width: 0, height: 0 });
  const [filterPipeline] = useState(() => new HostFilterPipeline());
  const selectedFilterRef = useRef<EffectDefinition | null>(null);
  const eventTimestamps = useRef<number[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    mediaPipeProvider
      .isSupported()
      .then((value) => {
        if (!cancelled) {
          setSupported(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSupported(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFrame = useCallback(
    (frame: FaceFrame) => {
      // FPS from a rolling 1-second window of frame events.
      const now = Date.now();
      const recent = eventTimestamps.current.filter(
        (timestamp) => now - timestamp < 1000,
      );
      recent.push(now);
      eventTimestamps.current = recent;
      setFps(recent.length);
      setFaces((previous) => {
        // Replace only this face's entry so multi-face frames stay stable.
        const next = previous.filter((item) => item.faceId !== frame.faceId);
        next.push(frame);
        return next;
      });
      // M3 preview: feed the same frame through the filter pipeline
      // when a filter is active (no measured duration on this path —
      // the governor only gates the native track path).
      if (selectedFilterRef.current !== null) {
        setFilterPlan(filterPipeline.handleFrame(frame));
      }
    },
    [filterPipeline],
  );

  const handleFaceLost = useCallback(
    (payload: { faceId: string }) => {
      setFaces((previous) =>
        previous.filter((face) => face.faceId !== payload.faceId),
      );
      // M3 preview: explicit loss hides shapes (grade still applies).
      filterPipeline.handleFaceLost(payload.faceId);
    },
    [filterPipeline],
  );

  const selectFilter = useCallback(
    (effect: EffectDefinition | null) => {
      selectedFilterRef.current = effect;
      setSelectedFilter(effect);
      filterPipeline.setEffect(effect);
      if (effect === null) {
        setFilterPlan(null);
      }
    },
    [filterPipeline],
  );

  const start = useCallback(async () => {
    setError(null);
    try {
      const unsubscribeFrame = mediaPipeProvider.onFrame(handleFrame);
      const unsubscribeLost = mediaPipeProvider.onFaceLost(handleFaceLost);
      cleanupRef.current = () => {
        unsubscribeFrame();
        unsubscribeLost();
      };
      await mediaPipeProvider.start({
        cameraPosition,
        maxFps: 15,
        maxFaces: 1,
      });
      startedRef.current = true;
      setStarted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cameraPosition, handleFrame, handleFaceLost]);

  const stop = useCallback(async () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    await mediaPipeProvider.stop();
    startedRef.current = false;
    setFaces([]);
    setFps(0);
    setStarted(false);
  }, []);

  // Mock mode never starts the provider; release the camera first if
  // a session is running so the mock view does not hold it.
  const enterMock = useCallback(async () => {
    if (startedRef.current) {
      await stop();
    }
    setMockPaused(false);
    setMode("mock");
  }, [stop]);

  const switchCamera = useCallback(async () => {
    // If a session is running, stop the provider (but keep the UI in
    // its "started" state) so the camera-position effect restarts it
    // with the new camera below.
    if (startedRef.current) {
      cleanupRef.current?.();
      cleanupRef.current = null;
      await mediaPipeProvider.stop();
    }
    setCameraPosition((previous) => (previous === "front" ? "back" : "front"));
  }, []);

  // Restart with the new camera when the toggle changes mid-session.
  // Runs only when cameraPosition changes while a session is active.
  useEffect(() => {
    if (startedRef.current) {
      start().catch(() => {
        // start() already surfaces errors via setError.
      });
    }
  }, [cameraPosition, start]);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      mediaPipeProvider.stop().catch(() => {
        // Best-effort cleanup on unmount.
      });
    };
  }, []);

  // Mock stream: scripted payloads at ~15fps while mock mode runs.
  useEffect(() => {
    if (mode !== "mock" || mockPaused) {
      return undefined;
    }
    const timer = setInterval(() => {
      mockConsumer.handlePayload(mockPayload(Date.now()));
    }, MOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [mode, mockPaused, mockConsumer]);

  if (mode === "mock") {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" />
        <View
          style={styles.mockVideo}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setMockViewSize({ width, height });
          }}
        >
          <AnchoredGiftOverlay
            consumer={mockConsumer}
            effect={selectedGift}
            videoSize={{ width: 720, height: 1280 }}
            viewSize={mockViewSize}
            resizeMode="cover"
          />
        </View>
        <SafeAreaView style={styles.bars} pointerEvents="box-none">
          <View style={styles.topBar}>
            <Text style={styles.stat}>
              Mock demo · scripted face path · no camera
            </Text>
            <Text style={styles.stat}>
              {mockPaused
                ? "Paused — fallback banner shows after 1.5s"
                : "Gift pinned above the face"}
            </Text>
          </View>
          <EffectPicker
            effects={CATALOGUE_GIFTS}
            selectedId={selectedGift.id}
            onSelect={(effect) => {
              if (effect !== null) {
                setSelectedGift(effect);
              }
            }}
            allowOff={false}
          />
          <View style={styles.bottomBar}>
            {mockPaused ? (
              <Button title="Resume" onPress={() => setMockPaused(false)} />
            ) : (
              <Button title="Pause" onPress={() => setMockPaused(true)} />
            )}
            <Button title="Back to camera" onPress={() => setMode("camera")} />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  const face = faces[0];
  const dots = face ? dotIndices(face.landmarks.length) : [];

  return (
    <View
      style={styles.root}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setCameraViewSize({ width, height });
      }}
    >
      <StatusBar barStyle="light-content" />
      <ARCameraView style={StyleSheet.absoluteFill} />
      <FilterPreviewOverlay
        plan={filterPlan}
        viewSize={cameraViewSize}
        mirrored={cameraPosition === "front"}
      />
      <View style={styles.dots} pointerEvents="none">
        {face &&
          selectedFilter === null &&
          dots.map((index) => {
            const point = face.landmarks[index];
            if (!point) {
              return null;
            }
            // Front-camera preview is mirrored; sensor coords are not.
            const displayX = cameraPosition === "front" ? 1 - point.x : point.x;
            return (
              <View
                key={index}
                style={[
                  styles.dot,
                  {
                    left: `${displayX * 100}%`,
                    top: `${point.y * 100}%`,
                  },
                ]}
              />
            );
          })}
      </View>
      <SafeAreaView style={styles.bars} pointerEvents="box-none">
        <View style={styles.topBar}>
          <Text style={styles.stat}>
            Faces: {faces.length} · FPS: {fps}
          </Text>
          <Text style={styles.stat}>
            {supported === null
              ? "Checking support…"
              : supported
                ? "MediaPipe ready"
                : "Not supported on this device"}
          </Text>
        </View>
        {error !== null && <Text style={styles.error}>{error}</Text>}
        <EffectPicker
          effects={CATALOGUE_FILTERS}
          selectedId={selectedFilter?.id ?? null}
          onSelect={selectFilter}
        />
        <View style={styles.bottomBar}>
          {started ? (
            <Button title="Stop" onPress={stop} />
          ) : (
            <Button title="Start" onPress={start} />
          )}
          <Button title={`Camera: ${cameraPosition}`} onPress={switchCamera} />
          <Button title="Mock demo" onPress={enterMock} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
  },
  dots: {
    ...StyleSheet.absoluteFill,
  },
  mockVideo: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#111111",
  },
  dot: {
    position: "absolute",
    width: 6,
    height: 6,
    marginLeft: -3,
    marginTop: -3,
    borderRadius: 3,
    backgroundColor: "#00ff88",
  },
  bars: {
    flex: 1,
    justifyContent: "space-between",
  },
  topBar: {
    padding: 12,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  stat: {
    color: "#ffffff",
    fontSize: 14,
  },
  error: {
    color: "#ff6666",
    padding: 12,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  bottomBar: {
    flexDirection: "row",
    justifyContent: "space-around",
    padding: 12,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
});
