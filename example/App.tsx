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
import { ARCameraView, mediaPipeProvider } from "react-native-ar-effects";
import type { FaceFrame } from "react-native-ar-effects";

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

export default function App(): React.JSX.Element {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [started, setStarted] = useState(false);
  const [faces, setFaces] = useState<FaceFrame[]>([]);
  const [fps, setFps] = useState(0);
  const [cameraPosition, setCameraPosition] = useState<"front" | "back">(
    "front",
  );
  const [error, setError] = useState<string | null>(null);
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

  const handleFrame = useCallback((frame: FaceFrame) => {
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
  }, []);

  const handleFaceLost = useCallback((payload: { faceId: string }) => {
    setFaces((previous) =>
      previous.filter((face) => face.faceId !== payload.faceId),
    );
  }, []);

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

  const face = faces[0];
  const dots = face ? dotIndices(face.landmarks.length) : [];

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <ARCameraView style={StyleSheet.absoluteFill} />
      <View style={styles.dots} pointerEvents="none">
        {face &&
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
        <View style={styles.bottomBar}>
          {started ? (
            <Button title="Stop" onPress={stop} />
          ) : (
            <Button title="Start" onPress={start} />
          )}
          <Button title={`Camera: ${cameraPosition}`} onPress={switchCamera} />
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
    ...StyleSheet.absoluteFillObject,
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
