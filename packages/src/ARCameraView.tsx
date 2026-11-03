/**
 * ARCameraView — the native camera preview view (M1).
 *
 * The detection provider owns the camera session (see ARCHITECTURE.md
 * §1), so the preview must come from the same session — a second
 * preview camera (e.g. expo-camera) would fight the provider for the
 * camera hardware. ARCameraView is a thin wrapper around the native
 * preview view bound to the shared provider session: mount it where
 * the preview should appear, then start the provider.
 *
 * The preview is mirrored for the front camera (standard selfie
 * behavior) while the landmark coordinates are raw sensor space, so
 * consumers overlaying dots must flip x -> 1 - x for the front camera
 * (see the example app). Hosts never pre-flip; see ARCHITECTURE.md §2.
 */

import { requireNativeComponent } from "react-native";
import type { ViewProps } from "react-native";

export interface ARCameraViewProps extends ViewProps {
  /** Reserved for future props (e.g. preview gravity). No props in M1. */
}

const NativeARCameraView =
  requireNativeComponent<ARCameraViewProps>("ARCameraView");

export function ARCameraView(props: ARCameraViewProps) {
  return <NativeARCameraView {...props} />;
}
