/**
 * Core types for react-native-ar-effects.
 *
 * These types are the contract between the layers in ARCHITECTURE.md:
 * detection providers (§1) produce FaceFrames, the landmark stream (§2)
 * carries LandmarkPayloads over the live socket, the viewer overlay
 * renderer (§3) pins effects to anchors, and effects (§5) are data.
 *
 * Scaffold status: types + interface only. No native code yet (M1).
 *
 * M1 status: the MediaPipe provider implementation lives in
 * mediapipe-provider.ts (JS wrapper) plus the native modules under
 * packages/ios and packages/android. The interface gained two M1
 * additions, both documented here: FaceTrackingConfig.cameraPosition
 * (the provider owns the camera session) and
 * DetectionProvider.onFaceLost (face-loss is explicit, matching the
 * face.lost socket payload in §2).
 */

/** Which face-detection engine produced a frame. */
export type DetectionProviderKind = "mediapipe" | "mlkit" | "vision";

/** Which landmark map a set of indices refers to. */
export type LandmarkMap = "mediapipe-478" | "mlkit" | "vision";

/** A point in normalized 0..1 frame space (origin top-left). */
export interface NormalizedPoint {
  /** 0..1 across the frame width. */
  x: number;
  /** 0..1 down the frame height. */
  y: number;
  /** 0..1 depth estimate where the provider supplies one (MediaPipe). */
  z?: number;
}

/** A face bounding box in normalized 0..1 frame space. */
export interface FaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One tracked face on one camera frame, as produced by a detection
 * provider. All coordinates are normalized 0..1, origin top-left.
 */
export interface FaceFrame {
  /** Stable ID for one tracked face across frames (provider-assigned). */
  faceId: string;
  /** Landmarks in normalized coordinates. Ordering follows `landmarkMap`. */
  landmarks: NormalizedPoint[];
  /** Which map the landmark indices follow; MediaPipe-478 is canonical. */
  landmarkMap: LandmarkMap;
  /** Blendshape scores, MediaPipe only (e.g. { mouthSmileLeft: 0.8 }). */
  blendshapes?: Record<string, number>;
  /** Face bounding box, normalized. */
  bounds: FaceBounds;
  /** Camera frame timestamp (ms); shared with the video pipeline. */
  timestampMs: number;
  /** Which engine produced this frame. */
  source: DetectionProviderKind;
}

/**
 * The landmark payload that travels over the live socket so VIEWERS can
 * pin overlays (gifts) to the host's face. Carries a SUBSET of landmarks —
 * only the indices the active effects anchor to — never the full mesh.
 */
export interface LandmarkPayload {
  type: "face.landmarks";
  faceId: string;
  /** Sparse subset: { index } refers to `landmarkMap` numbering. */
  landmarks: Array<{ index: number; x: number; y: number }>;
  bounds: FaceBounds;
  timestampMs: number;
  /** Always 'normalized-top-left'. Consumers must honor it. */
  coordinateSpace: "normalized-top-left";
  /**
   * Front-camera mirroring rule: when true, the host sent raw sensor-space
   * coordinates and VIEWERS must flip x -> 1 - x before rendering.
   * Hosts never pre-flip.
   */
  mirrored: boolean;
  landmarkMap: LandmarkMap;
}

/** Sent when a provider loses a face; viewers fall back (banner/stage). */
export interface FaceLostPayload {
  type: "face.lost";
  faceId: string;
  timestampMs: number;
}

/** Configuration for a detection provider session. */
export interface FaceTrackingConfig {
  /** Max frames per second to process (not the camera's full rate). */
  maxFps?: number;
  /** Track one face (smoothed) vs many. Single-face is the default. */
  maxFaces?: number;
  /** Minimum detection confidence, 0..1. */
  minDetectionConfidence?: number;
  /**
   * Which camera the provider opens. The provider owns the camera session
   * (see ARCHITECTURE.md §1), so the app picks the camera here instead
   * of running its own preview camera — two sessions on one camera
   * hardware conflict. Front is the default (selfie / host camera).
   */
  cameraPosition?: "front" | "back";
}

/**
 * The detection provider interface (ARCHITECTURE.md §1). Every engine —
 * MediaPipe, ML Kit, Apple Vision — implements this, so the layers above
 * never care which detector produced the points.
 */
export interface DetectionProvider {
  /** Engine identifier. */
  readonly name: DetectionProviderKind;
  /** True when this provider can run on the current device/OS. */
  isSupported(): Promise<boolean>;
  /** Start emitting frames; resolves when camera + engine are ready. */
  start(config?: FaceTrackingConfig): Promise<void>;
  /** Stop emitting frames and release the engine. */
  stop(): Promise<void>;
  /** Subscribe to per-frame results; returns an unsubscribe function. */
  onFrame(callback: (frame: FaceFrame) => void): () => void;
  /**
   * Subscribe to face-loss events. Fires when a face the provider was
   * tracking disappears from processed frames — the same moment the host
   * would send a face.lost payload over the live socket (§2). The M2
   * overlay renderer uses this to trigger its banner/stage fallback.
   * Returns an unsubscribe function.
   */
  onFaceLost(callback: (payload: FaceLostPayload) => void): () => void;
}

/**
 * A face anchor: where an effect pins itself, expressed as landmark
 * indices plus placement. See ARCHITECTURE.md §5.
 */
export interface EffectAnchor {
  /** Landmark indices this effect pins to (MediaPipe-478 numbering). */
  landmarkIndices: number[];
  /** How the asset sits on the anchors. */
  placement: "above-head" | "on-face" | "follow" | "orbit" | "fullscreen";
  /** Scale relative to face bounds width (1.0 = as wide as the face). */
  scaleToFace: number;
  /** Offset in face-width units, applied after anchoring. */
  offset?: { x: number; y: number };
}

/** One renderable asset inside an effect (Lottie, SVGA, image, video-alpha). */
export interface EffectAsset {
  uri: string;
  kind: "lottie" | "svga" | "image" | "video-alpha";
  /** Intrinsic asset size, used for scaling to the anchor. */
  width: number;
  height: number;
}

/**
 * A filter or gift effect, defined as DATA, not code (ARCHITECTURE.md §5).
 * Shipping a new effect means shipping a new definition, not an SDK release.
 */
export interface EffectDefinition {
  id: string;
  kind: "filter" | "gift";
  name: string;
  /** Viewer overlay (gifts) or pre-encode (filters). */
  renderPath: "viewer-overlay" | "pre-encode";
  anchors: EffectAnchor[];
  assets: EffectAsset[];
  /** Loop, one-shot, or timed (ms). Gifts are usually one-shot. */
  animation: { mode: "loop" | "once" | "timed"; durationMs?: number };
  /** Sound on the viewing device (gifts) or host preview (filters).
      Never baked into the encoded video. */
  soundUri?: string;
  /** What to do when face tracking is lost (gifts). */
  trackingLostFallback: "banner" | "stage" | "hide";
}
