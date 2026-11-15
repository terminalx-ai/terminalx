import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "lucide-react-native";
import { useTheme } from "../theme";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

/**
 * A sheet of choices, one of them current, as design 22.07 draws the
 * session's notification sheet: a title, an optional line under it, and the
 * choices as rows of one card.
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
    <View style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 16 }]}>
      <View style={[styles.grabber, { backgroundColor: palette.border }]} />
      <View style={styles.heading}>
        <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
        {detail ? <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text> : null}
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.card, { borderColor: palette.border }]}>
        {choices.map((choice, index) => {
          const selected = choice.value === current;
          return <Pressable key={choice.value} accessibilityRole="button" accessibilityLabel={choice.label} accessibilityState={{ selected }} onPress={() => { onChoose(choice.value); onClose(); }} style={({ pressed }) => [styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, (pressed || selected) && { backgroundColor: palette.selected }]}>
            <Text style={[styles.label, { color: palette.ink }]}>{choice.label}</Text>
            {selected ? <Check size={17} color={palette.accent} /> : null}
          </Pressable>;
        })}
      </ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 10, gap: 14, maxHeight: "75%" },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3 },
  heading: { gap: 3, paddingHorizontal: 4 },
  title: { fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  detail: { fontSize: 13, lineHeight: 18 },
  scroll: { flexGrow: 0 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { minHeight: 50, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  label: { fontSize: 15 },
});
