import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "lucide-react-native";
import { Card } from "./primitives";
import { useTheme } from "./theme";

export interface Choice {
  id: string;
  label: string;
  /** A quiet line under the label: a size's machine. */
  detail?: string;
  /** At the row's end, in place of the tick's column: a size's hourly rate, over what it is a rate of. */
  value?: string;
  valueDetail?: string;
  /** It is shown but cannot be chosen (25.10: an agent not signed in there); `detail` says why. */
  disabled?: boolean;
}

/**
 * One choice among what the server offers, in a sheet over the form (25.05:
 * Size, Region, Provider, Stop when idle). The chosen row is filled and
 * ticked; a tap chooses and closes. A tap outside closes and changes nothing.
 */
export function ChoiceSheet({ title, subtitle, choices, chosen, help, onChoose, onClose }: {
  title: string;
  subtitle?: string;
  choices: readonly Choice[];
  chosen: string | null;
  /** Under the choices: what the choice means later. */
  help?: string;
  onChoose(id: string): void;
  onClose(): void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <Pressable testID="choice-sheet-backdrop" accessibilityRole="button" accessibilityLabel={`Close ${title}`} onPress={onClose} style={[styles.fill, styles.backdrop]} />
    <View testID="choice-sheet" accessibilityViewIsModal style={[styles.sheet, { backgroundColor: palette.page, borderColor: palette.border, paddingBottom: insets.bottom + 16 }]}>
      <View style={[styles.handle, { backgroundColor: palette.faint }]} />
      <Text accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>{title}</Text>
      {subtitle ? <Text style={[styles.subtitle, { color: palette.muted }]}>{subtitle}</Text> : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        <Card>
          {choices.map((choice, index) => {
            const selected = choice.id === chosen;
            return <Pressable key={choice.id} testID={`choice-${choice.id}`} accessibilityRole="button" accessibilityLabel={[choice.label, choice.detail, choice.value, choice.valueDetail].filter(Boolean).join(", ")} accessibilityState={{ selected, disabled: !!choice.disabled }}
              disabled={choice.disabled}
              onPress={() => { onChoose(choice.id); onClose(); }}
              style={({ pressed }) => [styles.row, choice.detail ? styles.tall : null, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null, selected || pressed ? { backgroundColor: palette.selected } : null, choice.disabled ? styles.off : null]}>
              <View style={styles.body}>
                <Text style={[styles.label, choice.detail ? styles.strong : null, { color: palette.ink }]}>{choice.label}</Text>
                {choice.detail ? <Text style={[styles.detail, { color: palette.muted }]}>{choice.detail}</Text> : null}
              </View>
              {choice.value ? <View style={styles.end}>
                <Text style={[styles.value, { color: palette.ink }]}>{choice.value}</Text>
                {choice.valueDetail ? <Text style={[styles.valueDetail, { color: palette.muted }]}>{choice.valueDetail}</Text> : null}
              </View> : selected ? <Check size={18} color={palette.accent} /> : null}
            </Pressable>;
          })}
        </Card>
        {help ? <Text style={[styles.help, { color: palette.muted }]}>{help}</Text> : null}
      </ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { backgroundColor: "#00000080" },
  sheet: { maxHeight: "80%", borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, marginBottom: 12, opacity: 0.6 },
  title: { fontSize: 17, fontWeight: "600", lineHeight: 22, paddingHorizontal: 4 },
  subtitle: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4, paddingTop: 2 },
  list: { flexGrow: 0, marginTop: 12 },
  listContent: { gap: 8 },
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 9 },
  tall: { minHeight: 60 },
  off: { opacity: 0.5 },
  body: { flex: 1, minWidth: 0 },
  label: { fontSize: 16, lineHeight: 21 },
  strong: { fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 18 },
  end: { alignItems: "flex-end" },
  value: { fontSize: 15, lineHeight: 20, fontWeight: "600", fontVariant: ["tabular-nums"] },
  valueDetail: { fontSize: 12, lineHeight: 16 },
  help: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
});
