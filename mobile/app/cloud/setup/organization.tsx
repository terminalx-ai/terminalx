import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Check, ChevronRight, Plus } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CloudOrganization } from "@mobile/cloud/api";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { connectedCompute, managesOrganization, type OrganizationSetup } from "@mobile/cloud/setup";
import { chooseSetupOrganization, useSetupChoice } from "@mobile/cloud/setup-choice";
import { SETUP_PATHS } from "@mobile/cloud/setup-routes";
import { useOrganizationSetups } from "@mobile/cloud/useSetup";
import { organizationRoleName } from "@mobile/cloud/words";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState } from "@mobile/ui/primitives";
import { useLargeText } from "@mobile/ui/text-size";
import { useTheme } from "@mobile/ui/theme";

export const ORGANIZATION_TEXT = {
  belongs: "Cloud workspaces, the compute they run on and the agent logins they use belong to an organization.",
  choose: "Choose the organization to set up.",
  personal: "Just you. A personal organization cannot have members.",
  create: "Create an organization",
  createDetail: "For a team: invite people later and share workspaces with them.",
  elsewhere: "To create an organization for a team, use the TerminalX desktop app or the web console. Your account service does not take it from the phone yet.",
  member: "an owner or admin sets it up",
  connected: "compute connected",
} as const;

/** "Continue with the personal one", or with the organization's name. */
export const continueLabel = (organization: CloudOrganization) => `Continue with ${organization.isPersonal ? "the personal one" : organization.name}`;

/** An organization's line in the list of several: whose it is, this person's role, and how far its setup is. */
export function organizationDetail(organization: CloudOrganization, setup: OrganizationSetup | undefined): string {
  const role = organizationRoleName(organization.role);
  const words = [organization.isPersonal ? "Personal" : null, role];
  if (!managesOrganization(organization)) words.push(ORGANIZATION_TEXT.member);
  else if (setup?.providers.value && connectedCompute(setup.providers.value).connected.length) words.push(ORGANIZATION_TEXT.connected);
  return words.filter(Boolean).join(" · ");
}

/**
 * Step 1 of the cloud setup (25.02): which organization the workspaces will
 * belong to. Every account has a personal one from its first sign-in, so one
 * tap carries on; a team's is created on the next page, where the account
 * service takes that from a phone. Choosing changes nothing on the server:
 * the phone keeps which organization is being set up, and goes back.
 */
export default function SetupOrganizationScreen() {
  const app = useApp();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  // At the accessibility text sizes a name is read in full: one line holds only its first word (PRO-563).
  const large = useLargeText();
  const userId = app.session?.user.userId ?? null;
  const choice = useSetupChoice(app.ready === false ? undefined : userId);
  const { store, setups } = useOrganizationSetups(catalog);
  const organizations = snapshot.organizations.map((entry) => entry.organization);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = organizations.find((entry) => entry.orgId === picked) ?? organizations.find((entry) => entry.orgId === choice.orgId) ?? organizations.find((entry) => entry.isPersonal) ?? organizations[0] ?? null;
  const several = organizations.length > 1;
  // The list is this run's answer, not one kept from before: only then does it say what the service takes from a phone.
  const creates = !!catalog && !snapshot.saved && catalog.api.createsOrganizations();

  // How far each organization's setup is, for the ones this person may set up; a member is not asked for it.
  const readable = several ? organizations.filter(managesOrganization).map((entry) => entry.orgId).join(" ") : "";
  useEffect(() => { for (const orgId of readable.split(" ").filter(Boolean)) void store?.read(orgId); }, [readable, store]);

  const carryOn = () => {
    if (!selected || !userId) return;
    chooseSetupOrganization(userId, selected.orgId);
    router.back();
  };
  const create = () => router.push(SETUP_PATHS.newOrganization);
  const line = (index: number) => (index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null);

  return <>
    <Stack.Screen options={{ title: "Organization", headerLargeTitle: false, headerBackTitle: "Cloud" }} />
    {catalog && userId ? <View style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.page}>
        <Text style={[styles.intro, { color: palette.muted }]}>{several ? ORGANIZATION_TEXT.choose : ORGANIZATION_TEXT.belongs}</Text>
        <Card>
          {organizations.map((organization, index) => {
            const on = organization.orgId === selected?.orgId;
            const detail = several ? organizationDetail(organization, setups.get(organization.orgId)) : organization.isPersonal ? ORGANIZATION_TEXT.personal : organizationDetail(organization, undefined);
            return <Pressable key={organization.orgId} testID={`organization-${organization.orgId}`} accessibilityRole="button" accessibilityLabel={organization.name} accessibilityHint={detail} accessibilityState={{ selected: on }}
              onPress={() => setPicked(organization.orgId)} style={[styles.choice, line(index), { backgroundColor: on ? palette.selected : undefined }]}>
              <View style={styles.body}>
                <Text numberOfLines={large ? undefined : 1} style={[styles.name, { color: palette.ink }]}>{organization.name}</Text>
                <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text>
              </View>
              {on ? <Check size={17} color={palette.accent} /> : null}
            </Pressable>;
          })}
          {creates && !several ? <Pressable testID="create-organization" accessibilityRole="button" accessibilityLabel={ORGANIZATION_TEXT.create} accessibilityHint={ORGANIZATION_TEXT.createDetail} onPress={create} style={({ pressed }) => [styles.choice, line(organizations.length), { backgroundColor: pressed ? palette.raised : undefined }]}>
            <View style={styles.body}>
              <Text style={[styles.name, { color: palette.ink }]}>{ORGANIZATION_TEXT.create}</Text>
              <Text style={[styles.detail, { color: palette.muted }]}>{ORGANIZATION_TEXT.createDetail}</Text>
            </View>
            <ChevronRight size={18} color={palette.faint} />
          </Pressable> : null}
        </Card>
        {creates && several ? <Card style={styles.apart}>
          <Pressable testID="create-organization" accessibilityRole="button" accessibilityLabel={ORGANIZATION_TEXT.create} onPress={create} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? palette.raised : undefined }]}>
            <Plus size={18} color={palette.muted} />
            <Text style={[styles.body, styles.rowText, { color: palette.ink }]}>{ORGANIZATION_TEXT.create}</Text>
            <ChevronRight size={18} color={palette.faint} />
          </Pressable>
        </Card> : null}
        {/* A server that does not say it takes creation from a phone (PRO-526): say where a team's organization is made. */}
        {creates || snapshot.saved ? null : <Text style={[styles.help, { color: palette.muted }]}>{ORGANIZATION_TEXT.elsewhere}</Text>}
      </ScrollView>
      <View style={[styles.foot, { backgroundColor: palette.page, borderTopColor: palette.border, paddingBottom: Math.max(insets.bottom, 10) }]}>
        {/* An account with no organization yet has none to carry on with: it creates one. */}
        {selected ? <Button label={continueLabel(selected)} onPress={carryOn} /> : creates ? <Button label={ORGANIZATION_TEXT.create} onPress={create} /> : null}
      </View>
    </View> : <EmptyState title="Sign in to set up cloud workspaces" detail="Sign in to see your organizations." />}
  </>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  page: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  intro: { fontSize: 15, lineHeight: 21, marginHorizontal: 4, marginBottom: 14 },
  choice: { minHeight: 64, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  apart: { marginTop: 12 },
  row: { minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  rowText: { fontSize: 16 },
  help: { fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 },
  foot: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
