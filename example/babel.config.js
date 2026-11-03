/**
 * Example app Babel config (M2).
 *
 * The reanimated plugin MUST be last. The SDK ships TypeScript source
 * (main: src/index.ts) whose Reanimated worklets compile under the
 * CONSUMER's Babel config — so any app using AnchoredGiftOverlay needs
 * this plugin. Metro + babel-preset-expo handle the rest.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-reanimated/plugin"],
  };
};
