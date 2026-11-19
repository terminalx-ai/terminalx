import { ScrollView, StyleSheet, Text } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { organizationRoleName as roleName } from "@mobile/cloud/words";
import { OrganizationDelete } from "@mobile/ui/OrganizationDelete";
import { Card, EmptyState } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * One organization of the signed-in account (#1292), opened from Account:
 * its name, this person's role in it, and, for its owner, deleting it.
 */
export default function OrganizationScreen() {
  const { orgId } = useLocalSearchParams<{ orgId: string }>();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization ?? null;
  return <>
    <Stack.Screen options={{ title: organization?.name || "Organization" }} />
    {catalog && organization ? <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}>
      <Card style={styles.block}>
        <Text style={[styles.label, { color: palette.muted }]}>Organization</Text>
        <Text selectable style={[styles.name, { color: palette.ink }]}>{organization.name}</Text>
        <Text style={[styles.detail, { color: palette.muted }]}>{organization.isPersonal ? `Your personal organization · ${roleName(organization.role)}` : `Your role · ${roleName(organization.role)}`}</Text>
      </Card>
      {/* The list is the server's answer from this run, not one kept from before: a role read earlier decides nothing. */}
      {snapshot.saved ? null : <OrganizationDelete organization={organization}
        remove={(name) => catalog.deleteOrganization(organization.orgId, name)}
        onDeleted={() => router.back()} />}
    </ScrollView> : <EmptyState title="Organization unavailable" detail={catalog ? "It is no longer on this account. Go back to see your organizations." : "Sign in to see your organizations."} />}
  </>;
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  block: { padding: 16, gap: 4 },
  label: { fontSize: 13 },
  name: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 15, lineHeight: 21 },
});
