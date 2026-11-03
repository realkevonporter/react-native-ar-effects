/**
 * FilterPreviewOverlay (M3 example only, not SDK API).
 *
 * Renders a HostFilterPipeline plan as React Native Views over the
 * camera preview so a sample filter's placement and grade intent can
 * be judged WITHOUT a LiveKit track. This is an APPROXIMATION, and
 * the code says so wherever it matters:
 *
 * - Positioning stretches normalized sensor coords directly to view
 *   pixels (x * viewWidth, y * viewHeight). The real pre-encode
 *   compositor draws in sensor space on the video frame itself, so
 *   the encoded output is exact; this preview only shows intent.
 * - Ellipses render as stadium-rounded rects (RN has no true
 *   ellipse view); lines render as rotated thin rects.
 * - Grades preview warmth/brightness as tint overlays only —
 *   saturation/contrast have no tint equivalent and are not shown.
 * - The front camera preview is mirrored, so front-camera plans flip
 *   x -> 1 - x here (the encoded frame is NOT flipped; this flip is
 *   preview-only, mirroring the M1 dots rule).
 *
 * True pre-encode compositing happens natively on the LiveKit track
 * (see ARFilterProcessor). This overlay never ships in the SDK.
 */

import React from "react";
import { StyleSheet, View } from "react-native";
import type {
  FilterDrawCommand,
  FilterFramePlan,
} from "react-native-ar-effects";

export interface FilterPreviewOverlayProps {
  plan: FilterFramePlan | null;
  viewSize: { width: number; height: number };
  /** Front-camera preview mirror (preview-only, not encoded). */
  mirrored: boolean;
}

function hexToRgba(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ShapeView({
  command,
  viewSize,
  mirrored,
}: {
  command: Extract<FilterDrawCommand, { kind: "shape" }>;
  viewSize: { width: number; height: number };
  mirrored: boolean;
}): React.JSX.Element | null {
  const flip = (x: number) => (mirrored ? 1 - x : x);
  if (command.shape === "ellipse" || command.shape === "rect") {
    const left = flip(command.rect.x + command.rect.width) * viewSize.width;
    const top = command.rect.y * viewSize.height;
    const width = command.rect.width * viewSize.width;
    const height = command.rect.height * viewSize.height;
    const style =
      command.shape === "ellipse"
        ? {
            borderRadius: Math.min(width, height) / 2,
          }
        : {};
    return (
      <View
        pointerEvents="none"
        style={[
          styles.shape,
          style,
          {
            left,
            top,
            width,
            height,
            backgroundColor: command.fill
              ? hexToRgba(command.color, 0.6)
              : "transparent",
            borderColor: command.color,
            borderWidth: command.fill
              ? 0
              : Math.max(1, command.lineWidth * viewSize.width),
          },
        ]}
      />
    );
  }
  // line / polyline: one rotated thin rect per segment.
  const segments: React.JSX.Element[] = [];
  for (let i = 0; i + 1 < command.points.length; i += 1) {
    const p0 = command.points[i];
    const p1 = command.points[i + 1];
    const x0 = flip(p0.x) * viewSize.width;
    const y0 = p0.y * viewSize.height;
    const x1 = flip(p1.x) * viewSize.width;
    const y1 = p1.y * viewSize.height;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const thickness = Math.max(1, command.lineWidth * viewSize.width);
    // RN rotates about the view's center, so position the rect's
    // center on the segment midpoint, then rotate.
    segments.push(
      <View
        key={i}
        pointerEvents="none"
        style={[
          styles.line,
          {
            left: (x0 + x1) / 2 - length / 2,
            top: (y0 + y1) / 2 - thickness / 2,
            width: length,
            height: thickness,
            backgroundColor: command.color,
            transform: [{ rotate: `${angle}deg` }],
          },
        ]}
      />,
    );
  }
  return <>{segments}</>;
}

export function FilterPreviewOverlay({
  plan,
  viewSize,
  mirrored,
}: FilterPreviewOverlayProps): React.JSX.Element | null {
  if (!plan || !plan.filtered || viewSize.width === 0) {
    return null;
  }
  const grades = plan.commands.filter(
    (c): c is Extract<FilterDrawCommand, { kind: "grade" }> =>
      c.kind === "grade",
  );
  const shapes = plan.commands.filter(
    (c): c is Extract<FilterDrawCommand, { kind: "shape" }> =>
      c.kind === "shape",
  );
  // Grade preview: warmth/brightness tints only (saturation and
  // contrast have no tint equivalent — see module doc).
  const tints: React.JSX.Element[] = [];
  for (const grade of grades) {
    const { warmth, brightness } = grade.params;
    if (warmth > 0) {
      tints.push(
        <View
          key="warm"
          pointerEvents="none"
          style={[
            styles.tint,
            { backgroundColor: `rgba(255, 140, 0, ${warmth * 0.22})` },
          ]}
        />,
      );
    } else if (warmth < 0) {
      tints.push(
        <View
          key="cool"
          pointerEvents="none"
          style={[
            styles.tint,
            { backgroundColor: `rgba(0, 100, 255, ${-warmth * 0.22})` },
          ]}
        />,
      );
    }
    if (brightness > 0) {
      tints.push(
        <View
          key="bright"
          pointerEvents="none"
          style={[
            styles.tint,
            { backgroundColor: `rgba(255, 255, 255, ${brightness * 0.4})` },
          ]}
        />,
      );
    } else if (brightness < 0) {
      tints.push(
        <View
          key="dark"
          pointerEvents="none"
          style={[
            styles.tint,
            { backgroundColor: `rgba(0, 0, 0, ${-brightness * 0.4})` },
          ]}
        />,
      );
    }
  }
  return (
    <View style={styles.overlay} pointerEvents="none">
      {tints}
      {shapes.map((command, index) => (
        <ShapeView
          key={index}
          command={command}
          viewSize={viewSize}
          mirrored={mirrored}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
  },
  tint: {
    ...StyleSheet.absoluteFill,
  },
  shape: {
    position: "absolute",
  },
  line: {
    position: "absolute",
  },
});
