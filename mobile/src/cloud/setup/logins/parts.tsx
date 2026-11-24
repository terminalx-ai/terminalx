import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "lucide-react-native";
import { Card } from "../../../ui/primitives";
import { useTheme } from "../../../ui/theme";

/**
 * The frame every 25.04 page shares: what scrolls, and the buttons that stay
 * at the foot of the screen above a hairline.
 */
export function Page({ children, footer, testID }: { children: ReactNode; footer?: ReactNode; testID?: string }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  // The buttons ride above the keyboard while a field is being typed in.
  return <KeyboardAvoidingView testID={testID} behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.page, { backgroundColor: palette.page }]}>
    <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" style={styles.page} contentContainerStyle={styles.content}>{children}</ScrollView>
    {footer ? <View testID="page-footer" style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: palette.border, backgroundColor: palette.page }]}>{footer}</View> : null}
  </KeyboardAvoidingView>;
}

/** The header's title with the organization under it (the list, a saved login). */
export function HeaderTitle({ title, subtitle }: { title: string; subtitle?: string | null }) {
  const { palette } = useTheme();
  return <View accessible accessibilityRole="header" accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title} style={styles.header}>
    <Text numberOfLines={1} style={[styles.headerTitle, { color: palette.ink }]}>{title}</Text>
    {subtitle ? <Text numberOfLines={1} style={[styles.headerSubtitle, { color: palette.muted }]}>{subtitle}</Text> : null}
  </View>;
}

/** The muted sentence at the head of a page. */
export function Intro({ children }: { children: string }) {
  const { palette } = useTheme();
  return <Text style={[styles.intro, { color: palette.muted }]}>{children}</Text>;
}

/** A small muted line between cards: the section's name, or a note under a card. */
export function Note({ children, center }: { children: string; center?: boolean }) {
  const { palette } = useTheme();
  return <Text style={[styles.note, center ? styles.center : null, { color: palette.muted }]}>{children}</Text>;
}

export interface Choice<T extends string> { value: T; title: string; detail: string }

/** One of a few ways, in one card, the chosen one raised with a tick (Codex: ChatGPT or an API key). */
export function ChoiceCard<T extends string>({ choices, value, onChange, disabled }: { choices: readonly Choice<T>[]; value: T; onChange(value: T): void; disabled?: boolean }) {
  const { palette } = useTheme();
  return <Card>
    {choices.map((choice, index) => {
      const chosen = choice.value === value;
      return <Pressable key={choice.value} testID={`choice-${choice.value}`} accessibilityRole="radio" accessibilityLabel={`${choice.title}, ${choice.detail}`} accessibilityState={{ selected: chosen, disabled: !!disabled }} disabled={disabled} onPress={() => onChange(choice.value)}
        style={[styles.choice, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null, chosen ? { backgroundColor: palette.raised } : null]}>
        <View style={styles.choiceBody}>
          <Text style={[styles.choiceTitle, { color: palette.ink }]}>{choice.title}</Text>
          <Text style={[styles.choiceDetail, { color: palette.muted }]}>{choice.detail}</Text>
        </View>
        {chosen ? <Check size={16} color={palette.accent} /> : null}
      </Pressable>;
    })}
  </Card>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 12 },
  footer: { paddingHorizontal: 16, paddingTop: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  header: { alignItems: "center", maxWidth: 240 },
  headerTitle: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  headerSubtitle: { fontSize: 12, lineHeight: 16 },
  intro: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  note: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  center: { textAlign: "center" },
  choice: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  choiceBody: { flex: 1, minWidth: 0 },
  choiceTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  choiceDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
