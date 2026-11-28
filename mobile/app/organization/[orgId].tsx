import { useCallback } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { keyboardAvoidingBehavior } from "@mobile/ui/keyboard";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { connectedCompute, managesOrganization, signedInAgents, type OrganizationSetup, type SetupStepKey } from "@mobile/cloud/setup";
import { stepHref, useSetupPages } from "@mobile/cloud/setup-routes";
import { useOrganizationSetups } from "@mobile/cloud/useSetup";
import { organizationRoleName as roleName } from "@mobile/cloud/words";
import { organizationDeletionOffered } from "@terminalx/portable/organizationDeletion";
import { OrganizationDelete } from "@mobile/ui/OrganizationDelete";
import { Card, EmptyState, SectionTitle } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * One organization of the signed-in account (#1292), opened from Account:
 * its name, this person's role in it, and, for its owner, deleting it. Its
 * compute and agent logins are here too (25.02), where they are changed
 * after the first setup: each row opens its own page.
 */
export default function OrganizationScreen() {
  const { orgId } = useLocalSearchParams<{ orgId: string }>();
  const router = useRouter();
  const pages = useSetupPages();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization ?? null;
  const { store, setups } = useOrganizationSetups(catalog);
  const listed = snapshot.organizations.some((entry) => entry.organization.orgId === orgId) ? orgId : null;
  // Read when the page opens and again on coming back from a row's page, which may have changed it.
  useFocusEffect(useCallback(() => { if (listed) void store?.read(listed); }, [listed, store]));
  const setup = listed ? setups.get(listed) : undefined;
  const manages = !!organization && managesOrganization(organization);
  // A row opens only when its page is in the app: both are other issues' screens (PRO-528, PRO-529).
  const open = (step: SetupStepKey) => (manages && listed && pages(step) ? () => router.push(stepHref(step, listed)) : undefined);
  return <>
    <Stack.Screen options={{ title: organization?.name || "Organization" }} />
    {catalog && organization ? <KeyboardAvoidingView style={[styles.flex, { backgroundColor: palette.page }]} behavior={keyboardAvoidingBehavior()} keyboardVerticalOffset={insets.top + 44}><ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}>
      <Card style={styles.block}>
        <Text style={[styles.label, { color: palette.muted }]}>Organization</Text>
        <Text selectable style={[styles.name, { color: palette.ink }]}>{organization.name}</Text>
        <Text style={[styles.detail, { color: palette.muted }]}>{organization.isPersonal ? `Your personal organization · ${roleName(organization.role)}` : `Your role · ${roleName(organization.role)}`}</Text>
      </Card>
      <SectionTitle>Cloud workspaces</SectionTitle>
      <Card>
        <SetupRow title="Compute" detail={computeDetail(setup)} onPress={open("compute")} />
        <SetupRow title="Agent logins" detail={loginsDetail(setup)} onPress={open("agents")} divided />
      </Card>
      <Text style={[styles.note, styles.under, { color: palette.muted }]}>Owners and admins manage these. Members use them when they launch a workspace.</Text>
      {/* The list is the server's answer from this run, not one kept from before: a role read earlier decides nothing. */}
      {snapshot.saved ? null : snapshot.deletesOrganizations ? <OrganizationDelete organization={organization}
        remove={(name) => catalog.deleteOrganization(organization.orgId, name)}
        onDeleted={() => router.back()} />
        // A server that takes deletion from desktop tokens only (terminalx-saas#279): say where it can be done.
        : organizationDeletionOffered(organization) ? <Text style={[styles.note, { color: palette.muted }]}>To delete this organization, use the TerminalX desktop app or the web console. Your account service does not take deletion from the phone yet.</Text> : null}
    </ScrollView></KeyboardAvoidingView> : <EmptyState title="Organization unavailable" detail={catalog ? "It is no longer on this account. Go back to see your organizations." : "Sign in to see your organizations."} />}
  </>;
}

const NOT_CONNECTED = "Not connected";
const UNREAD = "Could not be read.";

/** "Boat · connected", from the organization's provider list; nothing until it was read. */
export function computeDetail(setup: OrganizationSetup | undefined): string | null {
  if (!setup?.read) return null;
  if (!setup.providers.value) return UNREAD;
  const { connected, attention } = connectedCompute(setup.providers.value);
  return connected.length ? `${connected.join(", ")} · connected` : attention.length ? `${attention.join(", ")} · needs attention` : NOT_CONNECTED;
}

/** "Codex, Claude Code · connected", from the organization's agent logins; nothing for someone the service does not show them to. */
export function loginsDetail(setup: OrganizationSetup | undefined): string | null {
  if (!setup?.read || setup.logins.refused) return null;
  if (!setup.logins.value) return UNREAD;
  const agents = signedInAgents(setup.logins.value);
  return agents.length ? `${agents.join(", ")} · connected` : NOT_CONNECTED;
}

/** A row of the Cloud workspaces section: it opens its page for someone who manages the organization. */
function SetupRow({ title, detail, onPress, divided }: { title: string; detail: string | null; onPress?: () => void; divided?: boolean }) {
  const { palette } = useTheme();
  const line = divided ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null;
  const body = <>
    <View style={styles.flex}>
      <Text style={[styles.rowTitle, { color: palette.ink }]}>{title}</Text>
      {detail ? <Text style={[styles.rowDetail, { color: palette.muted }]}>{detail}</Text> : null}
    </View>
    {onPress ? <ChevronRight size={18} color={palette.faint} /> : null}
  </>;
  const said = detail ? `${title}, ${detail}` : title;
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={said} onPress={onPress} style={({ pressed }) => [styles.row, line, { backgroundColor: pressed ? palette.raised : undefined }]}>{body}</Pressable>
    : <View accessible accessibilityLabel={said} style={[styles.row, line]}>{body}</View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  rowTitle: { fontSize: 16 },
  rowDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  under: { marginTop: -8 },
  page: { padding: 16, gap: 14 },
  block: { padding: 16, gap: 4 },
  label: { fontSize: 13 },
  name: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
});
