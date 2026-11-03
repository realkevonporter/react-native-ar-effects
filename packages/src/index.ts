/**
 * react-native-ar-effects — public API surface (scaffold).
 *
 * This package is at the spec stage: core types + the DetectionProvider
 * interface only. Native provider implementations (MediaPipe, ML Kit,
 * Apple Vision) land in M1; the viewer overlay renderer in M2; the
 * pre-encode filter compositor in M3. See ARCHITECTURE.md.
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
} from './types';
