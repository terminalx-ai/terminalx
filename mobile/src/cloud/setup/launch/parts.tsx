import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronRight } from "lucide-react-native";
import { Card } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * The launch pages' own parts (25.05): a setting in the form's card, an agent
 * login to tick, the bar the page's button sits in, and the sheet that picks
 * Provider, Size, Region and Stop when idle.
 */

const divider = (color: string, divided?: boolean) => (divided ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color } : null);

/** A setting: its name, what is chosen, and a chevron when a tap opens its sheet. A failed check marks its value. */
export function SettingRow({ label, value, onPress, marked, divided, disabled, testID }: { label: string; value: string; onPress?(): void; marked?: boolean; divided?: boolean; disabled?: boolean; testID?: string }) {
  const { palette } = useTheme();
  const body = <>
    <Text style={[styles.label, { color: palette.ink }]}>{label}</Text>
    <Text numberOfLines={1} style={[styles.value, { color: marked ? palette.danger : palette.muted }]}>{value}</Text>
    {onPress ? <ChevronRight size={17} color={palette.faint} /> : null}
  </>;
  const said = value ? `${label}: ${value}` : label;
  if (!onPress) return <View testID={testID} accessible accessibilityLabel={said} style={[styles.row, divider(palette.border, divided)]}>{body}</View>;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={said} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, divider(palette.border, divided), { backgroundColor: pressed ? palette.raised : undefined }]}>{body}</Pressable>;
}

/** An agent login to start the workspace with: a tick, its name, and who it is. */
export function LoginRow({ name, detail, chosen, marked, divided, disabled, onPress, testID }: { name: string; detail: string; chosen: boolean; marked?: boolean; divided?: boolean; disabled?: boolean; onPress(): void; testID?: string }) {
  const { palette } = useTheme();
  return <Pressable testID={testID} accessibilityRole="checkbox" accessibilityLabel={detail ? `${name}, ${detail}` : name} accessibilityState={{ checked: chosen, disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, divider(palette.border, divided), { backgroundColor: pressed ? palette.raised : undefined }]}>
    <View style={[styles.tick, chosen ? { backgroundColor: palette.accent, borderColor: palette.accent } : { borderColor: palette.faint }]}>
      {chosen ? <Check size={13} color={palette.accentInk} strokeWidth={3} /> : null}
    </View>
    <Text style={[styles.label, styles.grow, { color: palette.ink }]}>{name}</Text>
    {detail ? <Text numberOfLines={1} style={[styles.detail, { color: marked ? palette.danger : palette.muted }]}>{detail}</Text> : null}
  </Pressable>;
}

/** A way on to another page: what it does, with a line under it. */
export function LinkRow({ title, detail, onPress, testID }: { title: string; detail?: string; onPress(): void; testID?: string }) {
  const { palette } = useTheme();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={detail ? `${title}, ${detail}` : title} onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? palette.raised : undefined }]}>
    <View style={styles.grow}>
      <Text style={[styles.label, { color: palette.ink }]}>{title}</Text>
      {detail ? <Text style={[styles.linkDetail, { color: palette.muted }]}>{detail}</Text> : null}
    </View>
    <ChevronRight size={17} color={palette.faint} />
  </Pressable>;
}

/** The bar at the foot of a launch page, with a hairline above it. */
export function FootBar({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[styles.foot, { borderTopColor: palette.border, backgroundColor: palette.page, paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>{children}</View>;
}

/** A page of the launch: what scrolls, then its bar, with the keyboard kept off the field being typed in. */
export function LaunchPage({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView style={styles.fill} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    {foot ? <FootBar>{foot}</FootBar> : null}
  </KeyboardAvoidingView>;
}

export interface Choice {
  key: string;
  label: string;
  detail?: string;
  /** A rate beside it, with what it is per. */
  price?: { amount: string; per: string };
}

/**
 * Picks one of the server's choices, in a sheet over the form (the shape of
 * BotQuestionSheet). Chosen, it closes; a tap outside closes it as it was.
 */
export function ChoiceSheet({ title, note, choices, chosen, footer, onChoose, onClose, testID }: {
  title: string;
  note?: string;
  choices: readonly Choice[];
  chosen: string | null;
  footer?: string;
  onChoose(key: string): void;
  onClose(): void;
  testID?: string;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.fill}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title}`} onPress={onClose} style={[styles.fill, styles.backdrop]} />
      <View testID={testID} accessibilityViewIsModal style={[styles.sheet, { backgroundColor: palette.card, borderColor: palette.border, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.handle, { backgroundColor: palette.faint }]} />
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={[styles.sheetTitle, { color: palette.ink }]}>{title}</Text>
          {note ? <Text style={[styles.note, { color: palette.muted }]}>{note}</Text> : null}
        </View>
        <Card style={styles.choices}>
          {choices.map((choice, index) => {
            const selected = choice.key === chosen;
            const said = [choice.label, choice.detail, choice.price ? `${choice.price.amount} ${choice.price.per}` : null].filter(Boolean).join(", ");
            return <Pressable key={choice.key} testID={testID ? `${testID}-${choice.key}` : undefined} accessibilityRole="button" accessibilityLabel={said} accessibilityState={{ selected }} onPress={() => onChoose(choice.key)}
              style={({ pressed }) => [styles.choice, divider(palette.border, index > 0), { backgroundColor: selected ? palette.selected : pressed ? palette.raised : undefined }]}>
              <View style={styles.grow}>
                <Text style={[choice.detail ? styles.choiceStrong : styles.choiceLabel, { color: palette.ink }]}>{choice.label}</Text>
                {choice.detail ? <Text style={[styles.choiceDetail, { color: palette.muted }]}>{choice.detail}</Text> : null}
              </View>
              {choice.price ? <View style={styles.price}>
                <Text style={[styles.amount, { color: palette.ink }]}>{choice.price.amount}</Text>
                <Text style={[styles.per, { color: palette.muted }]}>{choice.price.per}</Text>
              </View> : selected ? <Check size={18} color={palette.accent} /> : null}
            </Pressable>;
          })}
        </Card>
        {footer ? <Text style={[styles.footer, { color: palette.ink }]}>{footer}</Text> : null}
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  page: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 8 },
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  label: { fontSize: 16, lineHeight: 21, fontWeight: "500" },
  value: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, textAlign: "right" },
  detail: { flexShrink: 1, fontSize: 13, lineHeight: 18, textAlign: "right" },
  linkDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  tick: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  foot: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  backdrop: { backgroundColor: "#00000080" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10, gap: 12 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, opacity: 0.6 },
  heading: { gap: 4, paddingHorizontal: 4 },
  sheetTitle: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  note: { fontSize: 13, lineHeight: 18 },
  choices: { overflow: "hidden" },
  choice: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  choiceLabel: { fontSize: 16, lineHeight: 21 },
  choiceStrong: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  choiceDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  price: { alignItems: "flex-end" },
  amount: { fontSize: 16, lineHeight: 21, fontWeight: "700", fontVariant: ["tabular-nums"] },
  per: { fontSize: 12, lineHeight: 16 },
  footer: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
});
