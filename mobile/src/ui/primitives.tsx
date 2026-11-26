import { cloneElement, type ReactElement, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type PressableProps, type ScrollViewProps, type ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LargeTitle } from "./glass";
import { useInTabs, useTabBarInset } from "./tab-bar-inset";
import { TopBar, useTopBar } from "./top-bar";
import { useTheme } from "./theme";

/**
 * A scrolling page; `title` is a tab's own large title, as tabs draw no header.
 * `titleActions` sit at the end of the large title (#987: Machines' one + to add a machine).
 * `aboveTitle` is drawn in the page before the large title (PRO-578: the logo of the signed-out Machines tab).
 * In a tab the page has its own top bar (#984): content scrolls under it and is
 * never drawn over the status bar. Elsewhere the stack's header sits on top.
 */
export function Screen({ children, contentContainerStyle, title, titleActions, aboveTitle, refreshControl, ...props }: ScrollViewProps & { title?: string; titleActions?: ReactNode; aboveTitle?: ReactNode }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  // In a tab on iOS, the bar floats over the foot of the page: the last of it scrolls clear.
  const inTabs = useInTabs();
  const bar = useTabBarInset();
  const top = useTopBar();
  const style = { backgroundColor: palette.page };
  const content = [styles.screen, { paddingBottom: (inTabs ? bar : insets.bottom) + 24 }, contentContainerStyle];
  if (!inTabs) return <ScrollView automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={style} contentContainerStyle={content} refreshControl={refreshControl} {...props}>{aboveTitle}{title ? <LargeTitle title={title}>{titleActions}</LargeTitle> : null}{children}</ScrollView>;
  const { contentInset, contentOffset, scrollIndicatorInsets, paddingTop } = top.insets;
  // Where the content is padded rather than inset, the pull-to-refresh spinner is moved below the bar.
  const refresh = refreshControl && paddingTop ? cloneElement(refreshControl as ReactElement<{ progressViewOffset?: number }>, { progressViewOffset: paddingTop }) : refreshControl;
  return <View style={[styles.page, style]}>
    <ScrollView refreshControl={refresh} automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" contentInset={contentInset} contentOffset={contentOffset} scrollIndicatorInsets={scrollIndicatorInsets} onScroll={top.onScroll} scrollEventThrottle={16} keyboardShouldPersistTaps="handled" style={style} contentContainerStyle={[content, paddingTop ? { paddingTop: paddingTop + styles.screen.paddingTop } : null]} {...props}>{aboveTitle}{title ? <LargeTitle title={title} onLayout={top.onTitleLayout}>{titleActions}</LargeTitle> : null}{children}</ScrollView>
    <TopBar title={title} shown={top.shown} />
  </View>;
}

export function Card({ style, ...props }: ViewProps) {
  const { palette } = useTheme();
  return <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }, style]} {...props} />;
}

export function Button({ label, kind = "primary", size = "regular", icon, disabled, style, ...props }: PressableProps & { label: string; kind?: "primary" | "secondary" | "danger"; /** `small` sits in a bar beside text (22.06's Start). */ size?: "regular" | "small"; /** Drawn before the label, in its colour. */ icon?: (color: string) => ReactNode }) {
  const { palette } = useTheme();
  const background = kind === "primary" ? palette.accent : kind === "danger" ? `${palette.danger}24` : palette.raised;
  const color = kind === "primary" ? palette.accentInk : kind === "danger" ? palette.danger : palette.ink;
  return <Pressable accessibilityRole="button" disabled={disabled} style={({ pressed }) => [styles.button, size === "small" && styles.smallButton, { backgroundColor: background, opacity: disabled ? 0.42 : pressed ? 0.72 : 1 }, style as object]} {...props}>{icon ? <View style={styles.buttonRow}>{icon(color)}<Text style={[styles.buttonText, size === "small" && styles.smallText, { color }]}>{label}</Text></View> : <Text style={[styles.buttonText, size === "small" && styles.smallText, { color }]}>{label}</Text>}</Pressable>;
}

/** A screen with nothing to show yet, as 22.06 draws one: a quiet icon, a title, and a line on why. */
export function EmptyState({ title, detail, busy, icon }: { title: string; detail: string; busy?: boolean; /** Drawn above the title, in the faint colour. */ icon?: (color: string) => ReactNode }) {
  const { palette } = useTheme();
  const mark = busy ? <ActivityIndicator color={palette.accent} /> : icon ? icon(palette.faint) : null;
  return <View style={styles.empty}>{mark ? <View style={styles.emptyMark}>{mark}</View> : null}<Text style={[styles.emptyTitle, { color: palette.ink }]}>{title}</Text><Text style={[styles.emptyDetail, { color: palette.muted }]}>{detail}</Text></View>;
}

export function SectionTitle({ children }: { children: string }) {
  const { palette } = useTheme();
  return <Text style={[styles.sectionTitle, { color: palette.muted }]}>{children.toUpperCase()}</Text>;
}

export function StatusDot({ color }: { color: string }) { return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />; }

const styles = StyleSheet.create({
  page: { flex: 1 },
  screen: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  // The padding is what a label taller than the button grows it by (PRO-563): at the default size 44 still holds it.
  button: { minHeight: 44, paddingHorizontal: 17, paddingVertical: 10, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  buttonText: { flexShrink: 1, fontSize: 16, fontWeight: "600", textAlign: "center" },
  buttonRow: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
  smallButton: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  smallText: { fontSize: 14 },
  empty: { paddingHorizontal: 32, paddingVertical: 56, alignItems: "center", gap: 6 },
  emptyMark: { marginBottom: 6 },
  emptyTitle: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  emptyDetail: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  sectionTitle: { fontSize: 12, fontWeight: "600", letterSpacing: 0.7, marginLeft: 4, marginTop: 8 },
});
