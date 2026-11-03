/**
 * MediaPipe Face Landmarker provider (M1).
 *
 * JS wrapper around the native ARFaceLandmarker modules (Swift + Kotlin).
 * The native side owns the camera session and the MediaPipe engine and
 * emits one `onFaceFrame` event per processed frame:
 *
 *   { faces: FaceFrame[], timestampMs: number }
 *
 * This wrapper splits that stream into the DetectionProvider contract:
 * one onFrame callback per face, plus onFaceLost when a previously
 * tracked face stops appearing. Face IDs are stabilized natively (the
 * native session matches faces across frames by bounds centroid), so
 * the diff here is a plain set difference.
 *
 * Coordinate space: normalized 0..1, origin top-left, in raw sensor
 * space. The native camera preview is mirrored for the front camera
 * while the sensor frames are not, so a consumer rendering dots over
 * its own preview must flip x -> 1 - x for the front camera — the same
 * rule ARCHITECTURE.md §2 assigns to viewers. Hosts never pre-flip.
 */

import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type {
  DetectionProvider,
  FaceFrame,
  FaceLostPayload,
  FaceTrackingConfig,
} from "./types";

/** Native module surface (subset used by this wrapper). */
interface ARFaceLandmarkerNativeModule {
  start(config: {
    maxFps?: number;
    maxFaces?: number;
    minDetectionConfidence?: number;
    cameraPosition?: string;
  }): Promise<void>;
  stop(): Promise<void>;
  isSupported(): Promise<boolean>;
}

/** Native per-frame event payload. */
interface NativeFaceFrameEvent {
  faces?: FaceFrame[];
  timestampMs?: number;
}

function getNativeModule(): ARFaceLandmarkerNativeModule | undefined {
  const mod = (NativeModules as Record<string, unknown>).ARFaceLandmarker;
  return mod as ARFaceLandmarkerNativeModule | undefined;
}

export class MediaPipeFaceLandmarkerProvider implements DetectionProvider {
  readonly name = "mediapipe" as const;

  private frameListeners = new Set<(frame: FaceFrame) => void>();
  private lostListeners = new Set<(payload: FaceLostPayload) => void>();
  private previousFaceIds = new Set<string>();
  private emitter: NativeEventEmitter | null = null;
  private subscription: { remove: () => void } | null = null;
  private running = false;

  async isSupported(): Promise<boolean> {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      return false;
    }
    const native = getNativeModule();
    if (!native) {
      return false;
    }
    try {
      return await native.isSupported();
    } catch {
      return false;
    }
  }

  async start(config?: FaceTrackingConfig): Promise<void> {
    if (this.running) {
      return;
    }
    const native = getNativeModule();
    if (!native) {
      throw new Error(
        "react-native-ar-effects: native module ARFaceLandmarker is not linked. " +
          "Run a dev build (expo prebuild + run); native modules do not run in Expo Go.",
      );
    }
    this.emitter = new NativeEventEmitter(
      NativeModules.ARFaceLandmarker as never,
    );
    this.subscription = this.emitter.addListener(
      "onFaceFrame",
      (event: NativeFaceFrameEvent) => this.handleFrameEvent(event),
    );
    try {
      await native.start({
        maxFps: config?.maxFps,
        maxFaces: config?.maxFaces,
        minDetectionConfidence: config?.minDetectionConfidence,
        cameraPosition: config?.cameraPosition ?? "front",
      });
      this.running = true;
    } catch (error) {
      this.subscription.remove();
      this.subscription = null;
      this.emitter = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    const native = getNativeModule();
    if (native) {
      await native.stop();
    }
    this.subscription?.remove();
    this.subscription = null;
    this.emitter = null;
    this.previousFaceIds.clear();
    this.running = false;
  }

  onFrame(callback: (frame: FaceFrame) => void): () => void {
    this.frameListeners.add(callback);
    return () => {
      this.frameListeners.delete(callback);
    };
  }

  onFaceLost(callback: (payload: FaceLostPayload) => void): () => void {
    this.lostListeners.add(callback);
    return () => {
      this.lostListeners.delete(callback);
    };
  }

  private handleFrameEvent(event: NativeFaceFrameEvent): void {
    const faces = event.faces ?? [];
    const timestampMs = event.timestampMs ?? Date.now();
    const currentIds = new Set(faces.map((face) => face.faceId));
    for (const face of faces) {
      for (const listener of this.frameListeners) {
        listener(face);
      }
    }
    for (const faceId of this.previousFaceIds) {
      if (!currentIds.has(faceId)) {
        const payload: FaceLostPayload = {
          type: "face.lost",
          faceId,
          timestampMs,
        };
        for (const listener of this.lostListeners) {
          listener(payload);
        }
      }
    }
    this.previousFaceIds = currentIds;
  }
}

/** Shared singleton — the native module is a process singleton, so one
 *  provider instance per app is the correct shape. */
export const mediaPipeProvider = new MediaPipeFaceLandmarkerProvider();
