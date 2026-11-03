/**
 * EffectPicker (M4) — browse the catalogue, preview an effect.
 *
 * A horizontal chip row: one chip per effect, plus an "Off" chip when
 * allowOff is set (camera filters). The selected effect's name,
 * version, and tags show underneath so the catalogue can be browsed
 * without leaving the preview. Pure React Native core components —
 * no new dependencies.
 *
 * Camera mode passes CATALOGUE_FILTERS (tap to apply a filter to the
 * preview pipeline); mock mode passes CATALOGUE_GIFTS (tap to switch
 * the gift pinned to the scripted face). The picker only selects
 * data — applying it stays the parent's job.
 */

import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { EffectDefinition } from "react-native-ar-effects";

export interface EffectPickerProps {
  /** Effects to browse (filters in camera mode, gifts in mock mode). */
  effects: EffectDefinition[];
  /** Id of the selected effect, or null for "Off". */
  selectedId: string | null;
  /** Called with the chosen effect, or null for "Off". */
  onSelect: (effect: EffectDefinition | null) => void;
  /** Show the "Off" chip. Default true; gift pickers pass false. */
  allowOff?: boolean;
}

export function EffectPicker(props: EffectPickerProps): React.JSX.Element {
  const { effects, selectedId, onSelect } = props;
  const allowOff = props.allowOff !== false;
  const selected = effects.find((effect) => effect.id === selectedId) ?? null;
  return (
    <View style={styles.picker} pointerEvents="box-none">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {allowOff && (
          <TouchableOpacity
            onPress={() => onSelect(null)}
            style={[styles.chip, selectedId === null && styles.chipSelected]}
          >
            <Text
              style={[
                styles.chipText,
                selectedId === null && styles.chipTextSelected,
              ]}
            >
              Off
            </Text>
          </TouchableOpacity>
        )}
        {effects.map((effect) => {
          const isSelected = effect.id === selectedId;
          return (
            <TouchableOpacity
              key={effect.id}
              onPress={() => onSelect(effect)}
              style={[styles.chip, isSelected && styles.chipSelected]}
            >
              <Text
                style={[styles.chipText, isSelected && styles.chipTextSelected]}
              >
                {effect.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {selected !== null && (
        <Text style={styles.detail}>
          {selected.name} · v{selected.version} · {selected.tags.join(", ")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: {
    paddingVertical: 8,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  row: {
    flexDirection: "row",
    paddingHorizontal: 12,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
  },
  chipSelected: {
    backgroundColor: "#d4af37",
  },
  chipText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 14,
  },
  chipTextSelected: {
    color: "#1a1a1a",
  },
  detail: {
    color: "#cccccc",
    fontSize: 12,
    paddingHorizontal: 12,
    paddingTop: 6,
  },
});
