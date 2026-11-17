import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "lucide-react-native";
import { useTheme } from "../theme";

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** A mark before the words, drawn in the colour given (22.07 draws Mute with a struck bell). */
  icon?: (color: string) => ReactNode;
}

/**
 * A sheet of choices, one of them current, as design 22.07 draws the
 * session's notification sheet: a title, an optional line under it, and the
 * choices as rows of one card, the current one marked by the accent check.
 */
export function ChoiceSheet<T extends string>({ visible, title, detail, choices, current, onChoose, onClose }: {
  visible: boolean;
  title: string;
  detail?: string;
  choices: Choice<T>[];
  current: T | null;
  onChoose(value: T): void;
  onClose(): void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
    <View style={[styles.sheet, { backgroundColor: palette.card, borderColor: palette.border, paddingBottom: insets.bottom + 16 }]}>
      <View style={[styles.grabber, { backgroundColor: palette.selected }]} />
      <View style={styles.heading}>
        <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
        {detail ? <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text> : null}
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.card, { borderColor: palette.border }]}>
        {choices.map((choice, index) => {
          const selected = choice.value === current;
          return <Pressable key={choice.value} accessibilityRole="button" accessibilityLabel={choice.label} accessibilityState={{ selected }} onPress={() => { onChoose(choice.value); onClose(); }} style={({ pressed }) => [styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.selected }]}>
            {choice.icon?.(palette.muted)}
            <Text style={[styles.label, { color: palette.ink }]}>{choice.label}</Text>
            {selected ? <Check size={18} color={palette.accent} /> : null}
          </Pressable>;
        })}
      </ScrollView>
    </View>
  </Modal>;
}

// 22.07 frame 5's sizes: the machine menu's sheet (26 pt corners, the grabber 14 pt above the title), 50 pt rows of 16 pt words.
const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, borderCurve: "continuous", borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10, gap: 12, maxHeight: "75%" },
  grabber: { alignSelf: "center", width: 38, height: 5, borderRadius: 3, marginBottom: 2 },
  heading: { gap: 2 },
  title: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 18 },
  scroll: { flexGrow: 0 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { minHeight: 50, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  label: { flex: 1, fontSize: 16 },
});
