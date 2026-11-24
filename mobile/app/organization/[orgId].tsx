import { useCallback, useEffect, useRef } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { organizationRoleName as roleName } from "@mobile/cloud/words";
import { organizationDeletionOffered } from "@terminalx/portable/organizationDeletion";
import { useSetupReads } from "@mobile/cloud/setup/first-run/reads";
import { computeRowDetail, hrefs, loginsRowDetail } from "@mobile/cloud/setup/first-run/steps";
import { CLOUD_WORKSPACES, COMPUTE_ROW, LOGINS_ROW, MANAGED_BY } from "@mobile/cloud/setup/first-run/words";
import { OrganizationDelete } from "@mobile/ui/OrganizationDelete";
import { Card, EmptyState, SectionTitle } from "@mobile/ui/primitives";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { useTheme } from "@mobile/ui/theme";

/**
 * One organization of the signed-in account (#1292), opened from Account:
 * its name, this person's role in it, its cloud workspaces' compute and agent
 * logins (25.02: they open 25.03 and 25.04, where they are changed), and,
 * for its owner, deleting it.
 */
export default function OrganizationScreen() {
  const { orgId } = useLocalSearchParams<{ orgId: string }>();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization ?? null;
  const setup = useSetupReads(catalog, organization ? [organization] : []);
  const reads = organization ? setup.get(organization.orgId) : null;
  const refresh = () => (organization ? setup.refresh([organization]) : Promise.resolve());
  const pull = usePullRefresh(refresh);
  // Back from the compute or logins page: read again, as a step may have changed there.
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; });
  const focusedBefore = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedBefore.current) void latest.current();
    focusedBefore.current = true;
  }, []));
  const rows = organization ? [
    { key: "compute", title: COMPUTE_ROW, detail: computeRowDetail(reads), href: hrefs.compute(organization.orgId) },
    { key: "logins", title: LOGINS_ROW, detail: loginsRowDetail(reads), href: hrefs.logins(organization.orgId) },
  ] : [];
  return <>
    <Stack.Screen options={{ title: organization?.name || "Organization" }} />
    {catalog && organization ? <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]} refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} />}>
      <Card style={styles.block}>
        <Text style={[styles.label, { color: palette.muted }]}>Organization</Text>
        <Text selectable style={[styles.name, { color: palette.ink }]}>{organization.name}</Text>
        <Text style={[styles.detail, { color: palette.muted }]}>{organization.isPersonal ? `Your personal organization · ${roleName(organization.role)}` : `Your role · ${roleName(organization.role)}`}</Text>
      </Card>
      <View style={styles.section}>
        <SectionTitle>{CLOUD_WORKSPACES}</SectionTitle>
        <Card>
          {rows.map((row, index) => <Pressable key={row.key} testID={`organization-${row.key}`} accessibilityRole="button" accessibilityLabel={row.detail ? `${row.title}, ${row.detail}` : row.title} onPress={() => router.push(row.href as never)}
            style={({ pressed }) => [styles.row, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null, pressed ? { backgroundColor: palette.raised } : null]}>
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.ink }]}>{row.title}</Text>
              {row.detail ? <Text style={[styles.rowDetail, { color: palette.muted }]}>{row.detail}</Text> : null}
            </View>
            <ChevronRight size={18} color={palette.faint} />
          </Pressable>)}
        </Card>
        <Text style={[styles.note, { color: palette.muted }]}>{MANAGED_BY}</Text>
      </View>
      {/* The list is the server's answer from this run, not one kept from before: a role read earlier decides nothing. */}
      {snapshot.saved ? null : snapshot.deletesOrganizations ? <OrganizationDelete organization={organization}
        remove={(name) => catalog.deleteOrganization(organization.orgId, name)}
        onDeleted={() => router.back()} />
        // A server that takes deletion from desktop tokens only (terminalx-saas#279): say where it can be done.
        : organizationDeletionOffered(organization) ? <Text style={[styles.note, { color: palette.muted }]}>To delete this organization, use the TerminalX desktop app or the web console. Your account service does not take deletion from the phone yet.</Text> : null}
    </ScrollView> : <EmptyState title="Organization unavailable" detail={catalog ? "It is no longer on this account. Go back to see your organizations." : "Sign in to see your organizations."} />}
  </>;
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  block: { padding: 16, gap: 4 },
  label: { fontSize: 13 },
  name: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  section: { gap: 8 },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  rowDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
