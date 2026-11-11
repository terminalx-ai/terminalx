import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useTheme } from "./theme";

// Liquid Glass on iOS 26 and later; a quiet raised surface everywhere else.
const LIQUID = (() => { try { return isLiquidGlassAvailable(); } catch { return false; } })();

/** A surface that floats above the page: Liquid Glass where the system has it. */
export function Glass({ style, tint, interactive, children }: { style?: StyleProp<ViewStyle>; tint?: string; interactive?: boolean; children?: ReactNode }) {
  const { palette } = useTheme();
  if (LIQUID) return <GlassView glassEffectStyle="regular" tintColor={tint} isInteractive={interactive} style={style}>{children}</GlassView>;
  return <View style={[styles.fallback, { backgroundColor: tint ?? palette.raised, borderColor: palette.border }, style]}>{children}</View>;
}

/** A round glass button holding one icon; `prominent` tints it with the accent, as a primary action. */
export function GlassIconButton({ icon, label, onPress, disabled, prominent, size = 40, testID }: {
  icon: ReactNode;
  label: string;
  onPress(): void;
  disabled?: boolean;
  prominent?: boolean;
  size?: number;
  testID?: string;
}) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID} disabled={disabled} onPress={onPress} hitSlop={6} style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}>
    <Glass interactive tint={prominent ? palette.accent : undefined} style={[styles.round, { width: size, height: size, borderRadius: size / 2 }]}>{icon}</Glass>
  </Pressable>;
}

/** A tab's title, large and in the page as iOS draws it, with its actions on the right. */
export function LargeTitle({ title, children }: { title: string; children?: ReactNode }) {
  const { palette } = useTheme();
  return <View style={styles.titleRow}>
    <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
    {children ? <View style={styles.actions}>{children}</View> : null}
  </View>;
}

const styles = StyleSheet.create({
  fallback: { borderWidth: StyleSheet.hairlineWidth },
  round: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 6, paddingBottom: 4, paddingHorizontal: 4 },
  title: { flex: 1, fontSize: 34, fontWeight: "700", letterSpacing: 0.4 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10 },
});
