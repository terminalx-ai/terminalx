import type { ReactNode } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card } from "@mobile/ui/primitives";
import { useKeyboardShown, keyboardAvoidingBehavior } from "@mobile/ui/keyboard";
import { BAR_TITLE_MAX_SCALE } from "@mobile/ui/text-size";
import { useTheme } from "@mobile/ui/theme";

/**
 * A page of board 25.04: what it says scrolls, and what it does sits in a
 * foot that stays in view, over the keyboard while a key is being entered.
 */
export function LoginPage({ children, footer, testID }: { children: ReactNode; footer?: ReactNode; testID?: string }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  return <KeyboardAvoidingView testID={testID} style={[styles.flex, { backgroundColor: palette.page }]} behavior={keyboardAvoidingBehavior()} keyboardVerticalOffset={92}>
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={styles.flex} contentContainerStyle={[styles.content, footer ? null : { paddingBottom: insets.bottom + 24 }]}>{children}</ScrollView>
    {footer ? <View testID="login-footer" style={[styles.footer, { paddingBottom: (keyboard ? 0 : insets.bottom) + 12, borderTopColor: palette.border, backgroundColor: palette.page }]}>{footer}</View> : null}
  </KeyboardAvoidingView>;
}

/** The header of a page that belongs to one organization: its title over the organization's name. */
export function LoginHeaderTitle({ title, organization }: { title: string; organization?: string | null }) {
  const { palette } = useTheme();
  return <View accessible accessibilityRole="header" accessibilityLabel={organization ? `${title}, ${organization}` : title} style={styles.header}>
    <Text numberOfLines={1} maxFontSizeMultiplier={BAR_TITLE_MAX_SCALE} style={[styles.headerTitle, { color: palette.ink }]}>{title}</Text>
    {organization ? <Text numberOfLines={1} maxFontSizeMultiplier={BAR_TITLE_MAX_SCALE} style={[styles.headerSub, { color: palette.muted }]}>{organization}</Text> : null}
  </View>;
}

/** A sentence of the page: what it is for. */
export function Lead({ children }: { children: string }) {
  const { palette } = useTheme();
  return <Text style={[styles.lead, { color: palette.muted }]}>{children}</Text>;
}

/** A quiet line under a card or a field. */
export function Help({ children }: { children: string }) {
  const { palette } = useTheme();
  return <Text style={[styles.help, { color: palette.muted }]}>{children}</Text>;
}

/** One of a few ways, with a tick on the one chosen: the row the new-session form's Account section draws. */
export function Choices<T extends string>({ value, options, onChange, disabled }: { value: T; options: readonly { id: T; label: string; detail: string }[]; onChange(value: T): void; disabled?: boolean }) {
  const { palette } = useTheme();
  return <Card style={styles.choices}>
    {options.map((option) => {
      const selected = option.id === value;
      return <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={option.label} accessibilityHint={option.detail} accessibilityState={{ selected, disabled: !!disabled }} disabled={disabled}
        onPress={() => onChange(option.id)} style={[styles.choice, { backgroundColor: selected ? palette.selected : palette.raised }]}>
        <View style={styles.flex}>
          <Text style={[styles.choiceLabel, { color: palette.ink }]}>{option.label}</Text>
          <Text style={[styles.choiceDetail, { color: palette.muted }]}>{option.detail}</Text>
        </View>
        {selected ? <Check size={17} color={palette.accent} /> : null}
      </Pressable>;
    })}
  </Card>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 14 },
  footer: { paddingHorizontal: 16, paddingTop: 12, gap: 10, borderTopWidth: StyleSheet.hairlineWidth },
  header: { alignItems: "center", maxWidth: 220 },
  headerTitle: { fontSize: 17, fontWeight: "600" },
  headerSub: { fontSize: 12, lineHeight: 16 },
  lead: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  help: { fontSize: 13, lineHeight: 18, marginHorizontal: 4, marginTop: -6 },
  choices: { padding: 6, gap: 4 },
  choice: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  choiceLabel: { fontSize: 15, fontWeight: "600" },
  choiceDetail: { fontSize: 13, lineHeight: 18 },
});
