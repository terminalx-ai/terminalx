import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { useTheme } from "@mobile/ui/theme";

/** The organization's name as the account's organization list has it; null until that is read. */
export function useOrganizationName(orgId: string | undefined): string | null {
  const snapshot = useCatalogSnapshot(useCloudCatalog());
  return snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization.name ?? null;
}

/** The header's title with the organization under it, as 25.03 draws "Compute / Northwind". */
export function HeaderTitle({ title, subtitle }: { title: string; subtitle: string | null }) {
  const { palette } = useTheme();
  return <View accessible accessibilityRole="header" accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title} style={styles.header}>
    <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
    {subtitle ? <Text numberOfLines={1} style={[styles.subtitle, { color: palette.muted }]}>{subtitle}</Text> : null}
  </View>;
}

/**
 * A page of the setup screens: its content scrolls, and its actions sit in a
 * bar at the foot, above a hairline, as the boards draw Connect and Replace key.
 */
export function Page({ children, foot, testID }: { children: ReactNode; foot?: ReactNode; testID?: string }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <View testID={testID} style={[styles.page, { backgroundColor: palette.page }]}>
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={styles.page} contentContainerStyle={[styles.content, { paddingBottom: foot ? 24 : insets.bottom + 24 }]}>{children}</ScrollView>
    {foot ? <View testID="page-foot" style={[styles.foot, { borderTopColor: palette.border, paddingBottom: insets.bottom + 8 }]}>{foot}</View> : null}
  </View>;
}

/** A quiet line under a card: what the card above means. */
export function Helper({ children, testID }: { children: string; testID?: string }) {
  const { palette } = useTheme();
  return <Text testID={testID} style={[styles.helper, { color: palette.muted }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  header: { alignItems: "center", maxWidth: 240 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  subtitle: { fontSize: 13, lineHeight: 17 },
  page: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  foot: { paddingHorizontal: 16, paddingTop: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  helper: { fontSize: 13, lineHeight: 18, marginHorizontal: 4, marginTop: -4 },
});
