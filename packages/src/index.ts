/**
 * react-native-ar-effects — public API surface.
 *
 * M1: MediaPipe Face Landmarker provider (native Swift + Kotlin modules)
 * behind the DetectionProvider interface, plus the ARCameraView preview
 * component. The viewer overlay renderer lands in M2; the pre-encode
 * filter compositor in M3. See ARCHITECTURE.md.
 *
 * On-device verification (dev build + real-phone camera test) is owed
 * for M1 — the sandbox cannot prove on-device behavior. Do not ship
 * this to users until the example app shows live landmarks on a phone.
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
} from "./types";

export {
  MediaPipeFaceLandmarkerProvider,
  mediaPipeProvider,
} from "./mediapipe-provider";

export { ARCameraView } from "./ARCameraView";
export type { ARCameraViewProps } from "./ARCameraView";
