/**
 * Expo config plugin for react-native-ar-effects (M1).
 *
 * The library itself needs NO native wiring from a plugin: autolinking
 * picks up the podspec (iOS) and the Gradle module (Android). What Expo
 * consumers genuinely need is the camera permission, which is what this
 * plugin adds — and nothing else:
 *
 * - iOS: NSCameraUsageDescription (default message overridable via
 *   `cameraPermissionText`).
 * - Android: CAMERA uses-permission.
 *
 * Usage in an Expo app's app.json:
 *
 *   { "expo": { "plugins": ["react-native-ar-effects"] } }
 *
 * Or with a custom permission message:
 *
 *   { "expo": {
 *       "plugins": [["react-native-ar-effects", {
 *         "cameraPermissionText": "We need the camera to track your face."
 *       }]]
 *   } }
 */
const {
  withInfoPlist,
  withAndroidManifest,
  createRunOncePlugin,
} = require("@expo/config-plugins");

const CAMERA_PERMISSION = "android.permission.CAMERA";

function withARCameraPermissions(config, props = {}) {
  const message =
    props.cameraPermissionText ||
    "Allow camera access to track your face for live AR effects.";

  config = withInfoPlist(config, (cfg) => {
    if (!cfg.modResults.NSCameraUsageDescription) {
      cfg.modResults.NSCameraUsageDescription = message;
    }
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest["uses-permission"]) {
      manifest["uses-permission"] = [];
    }
    const permissions = manifest["uses-permission"];
    const hasCamera = permissions.some(
      (entry) => entry.$ && entry.$["android:name"] === CAMERA_PERMISSION,
    );
    if (!hasCamera) {
      permissions.push({ $: { "android:name": CAMERA_PERMISSION } });
    }
    return cfg;
  });

  return config;
}

module.exports = createRunOncePlugin(
  withARCameraPermissions,
  "react-native-ar-effects",
  "1.0.0",
);
