/**
 * AnchoredGiftOverlay (M2) — viewer-side gift pinned to a tracked face.
 *
 * Position and size live in Reanimated shared values, updated from the
 * landmark-stream subscription: per-frame updates never touch React
 * state (spec §3: socket-rate React renders would jank). React state
 * is used only for tracked/fallback transitions, which are rare.
 *
 * Rendering choices, documented so a later milestone can revisit them:
 * - Reanimated (not Skia) for M2: gift anchoring needs positioning,
 *   not custom drawing, so Reanimated + Image covers it. Skia is
 *   deferred to M3, where GPU filter rendering earns it.
 * - Sound is NOT played in M2: EffectDefinition.soundUri is carried
 *   but not wired — sound playback lands with the gift-system
 *   integration (the app owns audio policy), not here.
 * - Only the effect's FIRST anchor is used in M2; multi-anchor
 *   effects (e.g. two-handed) land in a later milestone.
 * - An effect with no anchors renders nothing; an effect with no
 *   assets renders a name pill (so data-defined effects stay visible
 *   before their artwork lands).
 * - When no tracked anchor is available — face never seen, or lost —
 *   the overlay renders the effect's trackingLostFallback (banner /
 *   stage / hide) instead of vanishing or freezing mid-screen.
 *   Re-anchoring happens automatically if the face returns.
 */

import React, { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  computeAssetRect,
  mapSensorBoundsToView,
  mapSensorPointToView,
  resolveAnchorPoint,
} from "./coordinate-mapping";
import type { ResizeMode, VideoSize, ViewSize } from "./coordinate-mapping";
import type { LandmarkStreamConsumer } from "./landmark-stream";
import type { EffectAsset, EffectDefinition } from "./types";

export interface AnchoredGiftOverlayProps {
  /** Stream consumer fed by the app's socket (or mock) payloads. */
  consumer: LandmarkStreamConsumer;
  /** The gift effect to render (data, per spec §5). */
  effect: EffectDefinition;
  /** Sensor frame size in pixels (host camera frame). */
  videoSize: VideoSize;
  /** On-screen view size in pixels (from onLayout). */
  viewSize: ViewSize;
  /** How the video fills the view. Default "cover". */
  resizeMode?: ResizeMode;
  /** Face to follow; default is the consumer's primary face. */
  faceId?: string | null;
  /** Fires once per tracked -> fallback transition. */
  onFallback?: (mode: "banner" | "stage" | "hide") => void;
}

type RenderMode = "anchored" | "fallback";

function renderAssetContent(
  asset: EffectAsset | undefined,
  effect: EffectDefinition,
  thumb: boolean,
): React.ReactNode {
  if (asset && asset.kind === "image") {
    return (
      <Image
        source={{ uri: asset.uri }}
        style={thumb ? styles.thumb : styles.assetImage}
        resizeMode="contain"
      />
    );
  }
  // Lottie / SVGA / video-alpha playback needs player deps that land
  // later; until then the effect stays visible as a name pill.
  return (
    <View style={thumb ? styles.thumbPill : styles.namePill}>
      <Text style={styles.nameText}>{effect.name}</Text>
    </View>
  );
}

export function AnchoredGiftOverlay(
  props: AnchoredGiftOverlayProps,
): React.ReactNode {
  const { consumer, effect, videoSize, viewSize } = props;
  const resizeMode = props.resizeMode ?? "cover";
  const [mode, setMode] = useState<RenderMode>("fallback");
  const prevModeRef = useRef<RenderMode>("fallback");

  const baseX = useSharedValue(0);
  const baseY = useSharedValue(0);
  const assetW = useSharedValue(0);
  const assetH = useSharedValue(0);
  const opacity = useSharedValue(0);
  const faceWShared = useSharedValue(0);
  const placementShared = useSharedValue(
    effect.anchors[0]?.placement ?? "on-face",
  );
  const orbitClock = useSharedValue(0);

  const orbitOffset = useDerivedValue(() => {
    if (placementShared.value !== "orbit") {
      return { x: 0, y: 0 };
    }
    const angle = orbitClock.value;
    return {
      x: Math.cos(angle) * faceWShared.value * 0.75,
      y: Math.sin(angle) * faceWShared.value * 0.4,
    };
  });

  const animatedStyle = useAnimatedStyle(() => ({
    width: assetW.value,
    height: assetH.value,
    opacity: opacity.value,
    transform: [
      { translateX: baseX.value + orbitOffset.value.x },
      { translateY: baseY.value + orbitOffset.value.y },
    ],
  }));

  // Orbit clock: one revolution per 6s while an orbit effect is shown.
  useEffect(() => {
    const placement = effect.anchors[0]?.placement;
    placementShared.value = placement ?? "on-face";
    if (placement === "orbit") {
      orbitClock.value = withRepeat(
        withTiming(Math.PI * 2, { duration: 6000 }),
        -1,
        false,
      );
    } else {
      orbitClock.value = 0;
    }
    return () => {
      orbitClock.value = 0;
    };
  }, [effect, orbitClock, placementShared]);

  useEffect(() => {
    const anchor = effect.anchors[0];
    if (!anchor) {
      return () => undefined;
    }
    const recompute = (): void => {
      if (viewSize.width <= 0 || viewSize.height <= 0) {
        return;
      }
      const state =
        props.faceId != null
          ? consumer.getFaceState(props.faceId)
          : consumer.getPrimaryFaceState();
      if (!state || state.status !== "tracked") {
        if (prevModeRef.current === "anchored") {
          props.onFallback?.(effect.trackingLostFallback);
        }
        prevModeRef.current = "fallback";
        setMode("fallback");
        return;
      }
      const sensorPoint = resolveAnchorPoint(state, anchor);
      const mappedBounds = mapSensorBoundsToView(state.bounds, {
        mirrored: state.mirrored,
        videoSize,
        viewSize,
        resizeMode,
      });
      const rect =
        sensorPoint === null
          ? { left: 0, top: 0, width: viewSize.width, height: viewSize.height }
          : computeAssetRect({
              anchorPoint: mapSensorPointToView(sensorPoint, {
                mirrored: state.mirrored,
                videoSize,
                viewSize,
                resizeMode,
              }),
              faceWidthPx: mappedBounds.width,
              anchor,
              asset: effect.assets[0],
              viewSize,
            });
      baseX.value = rect.left;
      baseY.value = rect.top;
      assetW.value = rect.width;
      assetH.value = rect.height;
      faceWShared.value = mappedBounds.width;
      opacity.value = withTiming(1, { duration: 150 });
      if (prevModeRef.current !== "anchored") {
        prevModeRef.current = "anchored";
        setMode("anchored");
      }
    };
    recompute();
    const unsubscribe = consumer.onUpdate(recompute);
    return unsubscribe;
  }, [
    consumer,
    effect,
    videoSize,
    viewSize,
    resizeMode,
    props.faceId,
    props.onFallback,
    baseX,
    baseY,
    assetW,
    assetH,
    faceWShared,
    opacity,
  ]);

  if (viewSize.width <= 0 || viewSize.height <= 0) {
    return null;
  }
  const anchor = effect.anchors[0];
  if (!anchor) {
    return null;
  }
  if (mode === "fallback") {
    const fallback = effect.trackingLostFallback;
    if (fallback === "hide") {
      return null;
    }
    if (fallback === "banner") {
      return (
        <View style={styles.banner} pointerEvents="none">
          {renderAssetContent(effect.assets[0], effect, true)}
          <Text style={styles.bannerText}>{effect.name}</Text>
        </View>
      );
    }
    const stageSize = Math.min(viewSize.width, viewSize.height) * 0.5;
    return (
      <View style={styles.stage} pointerEvents="none">
        <View style={{ width: stageSize, height: stageSize }}>
          {renderAssetContent(effect.assets[0], effect, false)}
        </View>
      </View>
    );
  }
  return (
    <Animated.View
      style={[styles.anchored, animatedStyle]}
      pointerEvents="none"
    >
      {renderAssetContent(effect.assets[0], effect, false)}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchored: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  assetImage: {
    width: "100%",
    height: "100%",
  },
  namePill: {
    width: "100%",
    height: "100%",
    borderRadius: 999,
    backgroundColor: "#d4af37",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  nameText: {
    color: "#1a1a1a",
    fontWeight: "700",
    fontSize: 16,
  },
  banner: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 24,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 12,
  },
  bannerText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 16,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  thumbPill: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#d4af37",
    alignItems: "center",
    justifyContent: "center",
  },
  stage: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
