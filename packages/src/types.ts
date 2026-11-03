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
  /**
   * Effect-format schema version. Always 1 in M4; the validator
   * rejects any other value, so a future format change cannot
   * silently break older consumers (see effect-validation.ts).
   */
  formatVersion: number;
  /**
   * This effect's own version, starting at 1. Bump it when the
   * effect's data changes so consumers can tell revisions apart;
   * it is independent of formatVersion (the schema version).
   */
  version: number;
  /** Discovery tags, e.g. ["funny", "glasses"]. Catalogue entries
      always carry at least one tag (enforced by catalogue tests). */
  tags: string[];
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
  /**
   * Vector shapes drawn by the pre-encode compositor (M3 filters).
   * Absent/empty = no shapes (grade-only filters). Shapes are data,
   * like everything else in an effect — see FilterShapeDef.
   */
  shapes?: FilterShapeDef[];
  /**
   * Full-frame color grade (M3 filters). Applies whether or not a
   * face is tracked; shapes still need a face. Absent = no grade.
   */
  grade?: FilterGradeParams;
}

/**
 * Viewer-side anchor state for one face (M2, ARCHITECTURE.md §2–§3).
 * Produced by LandmarkStreamConsumer from LandmarkPayloads. All
 * coordinates are normalized 0..1 sensor space (mirroring is applied
 * later, at view mapping — never here).
 */
export interface FaceAnchorState {
  faceId: string;
  /** Smoothed landmarks, keyed by landmark index (sensor space). */
  landmarks: Record<number, NormalizedPoint>;
  /** Indices present in the most recent payload for this face. Anchor
      resolution only trusts these — a requested index absent from the
      latest payload is treated as missing, never as a stale point. */
  latestIndices: number[];
  /** Smoothed face bounds, normalized sensor space. */
  bounds: FaceBounds;
  /** Viewer-clock ms of the most recent payload for this face. Loss
      detection uses the viewer clock, not the host timestampMs — the
      two clocks are not synchronized. */
  lastSeenMs: number;
  /** 'tracked' while payloads arrive; 'lost' after face.lost or a gap
      longer than lostAfterMs. */
  status: "tracked" | "lost";
  /** Mirroring flag from the most recent payload (spec §2). */
  mirrored: boolean;
  landmarkMap: LandmarkMap;
}

/** Tuning for one face's anchor tracker (M2). */
export interface AnchorTrackerConfig {
  /**
   * EMA weight for new samples, (0,1]. Default 0.35: at the 15fps
   * stream rate this settles in ~5 frames while visibly damping
   * per-frame jitter. Higher = more responsive, less smooth.
   */
  smoothingAlpha?: number;
  /**
   * Gap after which a face counts as lost. Default 1500ms (spec §3:
   * "no landmark payload has arrived for > 1.5s").
   */
  lostAfterMs?: number;
}

/** Tuning for LandmarkStreamConsumer (M2). */
export interface LandmarkStreamConsumerConfig {
  lostAfterMs?: number;
  smoothingAlpha?: number;
  /**
   * Explicit primary face. Null (default) = first tracked face, in
   * arrival order. An explicit primary stays selected even when lost
   * (the overlay shows its fallback) — the gift must not jump to a
   * different face just because the host's face dropped.
   */
  primaryFaceId?: string | null;
}

/**
 * Color-grade parameters for a full-frame filter (M3). All fields are
 * required in a resolved grade; see resolveGradeParams for defaults.
 * The formula is documented in filter-renderer.ts and mirrored by the
 * native compositors so TS preview and encoded output agree:
 * warmth scales R/B gains, then saturation, contrast, brightness.
 */
export interface FilterGradeParams {
  /** Warmth in [-1, 1]: positive = warmer (more red, less blue). */
  warmth: number;
  /** Additive brightness, roughly [-1, 1] (0 = unchanged). */
  brightness: number;
  /** Saturation multiplier (1 = unchanged). */
  saturation: number;
  /** Contrast multiplier around mid-grey (1 = unchanged). */
  contrast: number;
}

/**
 * One vector shape inside a data-defined filter (M3). Shapes are drawn
 * by the native pre-encode compositor; the TS filter renderer computes
 * the same geometry in normalized frame space for preview + tests.
 * Geometry is relative to the shape's anchor rect (fractions of the
 * rect's width/height), so shapes scale with the face automatically.
 */
export interface FilterShapeDef {
  kind: "ellipse" | "rect" | "line" | "polyline";
  /** Index into the effect's anchors array. */
  anchor: number;
  /**
   * Sub-rect within the anchor rect, as fractions (default: the full
   * anchor rect { x: 0, y: 0, width: 1, height: 1 }).
   */
  rect?: { x: number; y: number; width: number; height: number };
  /**
   * Points for line (2 points) / polyline (2+ points), as fractions
   * of the anchor rect. Ignored for ellipse/rect.
   */
  points?: Array<{ x: number; y: number }>;
  /** Stroke/fill color as #rrggbb. */
  color: string;
  /** Ellipses/rects: filled vs stroked outline. Default false. */
  fill?: boolean;
  /** Stroke width as a fraction of frame width. Default 0.008. */
  lineWidth?: number;
}

/**
 * One draw command produced by the M3 filter renderer, in normalized
 * 0..1 frame space (origin top-left, sensor space — the same space
 * the pre-encode compositor draws in, so no mirroring is applied here;
 * see filter-renderer.ts). The native compositors consume this shape
 * (via JSON) and the example preview renders it with RN Views.
 */
export type FilterDrawCommand =
  | {
      kind: "shape";
      shape: "ellipse" | "rect" | "line" | "polyline";
      /** Absolute rect in normalized frame space. */
      rect: { x: number; y: number; width: number; height: number };
      /** Absolute points in normalized frame space (line/polyline). */
      points: Array<{ x: number; y: number }>;
      color: string;
      fill: boolean;
      lineWidth: number;
    }
  | { kind: "grade"; params: FilterGradeParams };

/**
 * One frame of filter output from HostFilterPipeline (M3). Consumers
 * render `commands` only when `filtered` is true; on a dropped frame
 * commands is empty and droppedReason explains why, so nobody ever
 * renders a stale filter state.
 */
export interface FilterFramePlan {
  timestampMs: number;
  effectId: string | null;
  filtered: boolean;
  commands: FilterDrawCommand[];
  droppedReason?: "no-filter" | "no-face" | "over-budget" | "bypassed";
}

/** Tuning for HostFilterPipeline + FilterPerformanceGovernor (M3). */
export interface HostFilterConfig {
  /** Target filtered frame rate; frame budget = 1000 / targetFps. */
  targetFps?: number;
  /** Consecutive over-budget frames before the filter bypasses. */
  maxConsecutiveDrops?: number;
  /** Cooldown in ms before a bypassed pipeline probes one frame. */
  bypassCooldownMs?: number;
}

/** Observable status of a HostFilterPipeline (M3). */
export interface FilterPipelineStatus {
  effectId: string | null;
  bypassed: boolean;
  consecutiveDrops: number;
  framesSeen: number;
}
