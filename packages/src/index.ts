/**
 * react-native-ar-effects — public API surface.
 *
 * M1: MediaPipe Face Landmarker provider (native Swift + Kotlin modules)
 * behind the DetectionProvider interface, plus the ARCameraView preview
 * component. M2: viewer-side gift anchoring — LandmarkStreamConsumer,
 * AnchorTracker, coordinate mapping, and AnchoredGiftOverlay. The
 * pre-encode filter compositor lands in M3. See ARCHITECTURE.md.
 *
 * On-device verification (dev build + real-phone camera test) is owed
 * for M1 and M2 — the sandbox cannot prove on-device behavior. Do not
 * ship this to users until the example app shows live landmarks and
 * anchored gifts on a phone.
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
