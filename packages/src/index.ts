/**
 * react-native-ar-effects — public API surface.
 *
 * M1: MediaPipe Face Landmarker provider (native Swift + Kotlin modules)
 * behind the DetectionProvider interface, plus the ARCameraView preview
 * component. M2: viewer-side gift anchoring — LandmarkStreamConsumer,
 * AnchorTracker, coordinate mapping, and AnchoredGiftOverlay. M3:
 * host-side pre-encode filters — HostFilterPipeline, filter renderer,
 * performance governor, LiveKit adapter, and sample filters. See
 * ARCHITECTURE.md.
 *
 * On-device verification (dev build + real-phone camera test) is owed
 * for M1, M2, and M3 — the sandbox cannot prove on-device behavior.
 * Do not ship this to users until the example app shows live
 * landmarks, anchored gifts, and filtered publishing on a phone.
 */

export type {
  DetectionProviderKind,
  LandmarkMap,
  NormalizedPoint,
  FaceBounds,
  FaceFrame,
  LandmarkPayload,
  FaceLostPayload,
  FaceTrackingConfig,
  DetectionProvider,
  EffectAnchor,
  EffectAsset,
  EffectDefinition,
  FaceAnchorState,
  AnchorTrackerConfig,
  LandmarkStreamConsumerConfig,
  FilterGradeParams,
  FilterShapeDef,
  FilterDrawCommand,
  FilterFramePlan,
  HostFilterConfig,
  FilterPipelineStatus,
} from "./types";

export {
  MediaPipeFaceLandmarkerProvider,
  mediaPipeProvider,
} from "./mediapipe-provider";

export { ARCameraView } from "./ARCameraView";
export type { ARCameraViewProps } from "./ARCameraView";

export {
  AnchorTracker,
  DEFAULT_SMOOTHING_ALPHA,
  DEFAULT_LOST_AFTER_MS,
} from "./anchor-tracker";

export { LandmarkStreamConsumer, payloadFromFrame } from "./landmark-stream";
export type { StreamPayload } from "./landmark-stream";

export {
  mapSensorPointToView,
  mapSensorBoundsToView,
  resolveAnchorPoint,
  computeAssetRect,
} from "./coordinate-mapping";
export type {
  ViewSize,
  VideoSize,
  ResizeMode,
  PixelPoint,
  PixelRect,
  MapOptions,
} from "./coordinate-mapping";

export { AnchoredGiftOverlay } from "./AnchoredGiftOverlay";
export type { AnchoredGiftOverlayProps } from "./AnchoredGiftOverlay";

export {
  renderFilterCommands,
  validateFilterEffect,
  applyGradeToRgb,
  anchorRectNormalized,
  parseHexColor,
  resolveGradeParams,
  DEFAULT_GRADE,
  DEFAULT_LINE_WIDTH,
} from "./filter-renderer";

export {
  FilterPerformanceGovernor,
  DEFAULT_TARGET_FPS,
  DEFAULT_MAX_CONSECUTIVE_DROPS,
  DEFAULT_BYPASS_COOLDOWN_MS,
} from "./performance-governor";
export type { GovernorObservation } from "./performance-governor";

export { HostFilterPipeline } from "./filter-pipeline";

export {
  LiveKitFilterAdapter,
  FilterNotSupportedError,
  PROCESSOR_NAME,
} from "./livekit-adapter";
export type {
  FilterableVideoTrack,
  FilterNativeBridge,
  AppliedFilter,
} from "./livekit-adapter";

export { NativeFilterBridge } from "./filter-bridge";

export { GOLDEN_SHADES, WARM_SUNSET, SAMPLE_FILTERS } from "./sample-filters";
