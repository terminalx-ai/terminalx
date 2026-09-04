import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type PressableProps, type ScrollViewProps, type ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./theme";

export function Screen({ children, contentContainerStyle, ...props }: ScrollViewProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <ScrollView automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.screen, { paddingBottom: insets.bottom + 24 }, contentContainerStyle]} {...props}>{children}</ScrollView>;
}

export function Card({ style, ...props }: ViewProps) {
  const { palette } = useTheme();
  return <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }, style]} {...props} />;
}

export function Button({ label, kind = "primary", disabled, style, ...props }: PressableProps & { label: string; kind?: "primary" | "secondary" | "danger" }) {
  const { palette } = useTheme();
  const background = kind === "primary" ? palette.accent : kind === "danger" ? `${palette.danger}24` : palette.raised;
  const color = kind === "primary" ? palette.accentInk : kind === "danger" ? palette.danger : palette.ink;
  return <Pressable accessibilityRole="button" disabled={disabled} style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: disabled ? 0.42 : pressed ? 0.72 : 1 }, style as object]} {...props}><Text style={[styles.buttonText, { color }]}>{label}</Text></Pressable>;
}

export function EmptyState({ title, detail, busy }: { title: string; detail: string; busy?: boolean }) {
  const { palette } = useTheme();
  return <View style={styles.empty}>{busy ? <ActivityIndicator color={palette.accent} /> : null}<Text style={[styles.emptyTitle, { color: palette.ink }]}>{title}</Text><Text style={[styles.emptyDetail, { color: palette.muted }]}>{detail}</Text></View>;
}

export function SectionTitle({ children }: { children: string }) {
  const { palette } = useTheme();
  return <Text style={[styles.sectionTitle, { color: palette.muted }]}>{children.toUpperCase()}</Text>;
}

export function StatusDot({ color }: { color: string }) { return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />; }

const styles = StyleSheet.create({
  screen: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  button: { minHeight: 44, paddingHorizontal: 17, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 16, fontWeight: "600" },
  empty: { paddingHorizontal: 28, paddingVertical: 56, alignItems: "center", gap: 10 },
  emptyTitle: { fontSize: 20, fontWeight: "700", textAlign: "center" },
  emptyDetail: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  sectionTitle: { fontSize: 12, fontWeight: "600", letterSpacing: 0.7, marginLeft: 4, marginTop: 8 },
});
