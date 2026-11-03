/**
 * M3 native bridge — React Native wrapper for the ARFilter module.
 *
 * Imported by host apps, NOT by unit tests (tests use a fake
 * FilterNativeBridge). Mirrors mediapipe-provider.ts's native-module
 * lookup: the module is named "ARFilter" on both platforms, and a
 * missing module fails with a clear linking error instead of a
 * cryptic undefined-method crash.
 */

import { NativeModules } from "react-native";
import { FilterNativeBridge } from "./livekit-adapter";

interface ARFilterNativeModule {
  registerProcessor(): Promise<boolean>;
  setFilter(effectJson: string): Promise<void>;
  clearFilter(): Promise<void>;
}

function getNativeModule(): ARFilterNativeModule {
  const mod = (NativeModules as Record<string, unknown>).ARFilter as
    ARFilterNativeModule | undefined;
  if (!mod) {
    throw new Error(
      "ARFilter native module is not linked. In an Expo app this " +
        "means the dev build was made before react-native-ar-effects " +
        "was installed (autolinking runs at prebuild); rebuild the " +
        "dev client. In a bare app, link the ARFaceEffects pod/Gradle module.",
    );
  }
  return mod;
}

/** FilterNativeBridge backed by the real native ARFilter module. */
export class NativeFilterBridge implements FilterNativeBridge {
  registerProcessor(): Promise<boolean> {
    return getNativeModule().registerProcessor();
  }

  setFilter(effectJson: string): Promise<void> {
    return getNativeModule().setFilter(effectJson);
  }

  clearFilter(): Promise<void> {
    return getNativeModule().clearFilter();
  }
}
