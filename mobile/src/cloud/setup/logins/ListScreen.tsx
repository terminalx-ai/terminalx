import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { CloudOff } from "lucide-react-native";
import { useCatalogSnapshot, useCloudCatalog } from "../../CloudProvider";
import { refusalText } from "../../words";
import { useCloudApi, useRead } from "../read";
import { Notice } from "../../../ui/Notice";
import { Button, Card, EmptyState, SectionTitle } from "../../../ui/primitives";
import { ProviderRow } from "../../../ui/ProviderRow";
import { useTheme } from "../../../ui/theme";
import { AGENT_LOGINS, listRow, managesLogins } from "./agents";
import { HeaderTitle, Intro, Note, Page } from "./parts";
import { LIST_INTRO, LIST_UNREADABLE, ONE_IS_ENOUGH, listFailure, memberNotice } from "./words";

const TITLE = "Agent logins";

/** The organization a page is about, as the account's list names it, with this person's role there. */
export function useOrganization(orgId: string | null) {
  const snapshot = useCatalogSnapshot(useCloudCatalog());
  const organization = orgId ? snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization ?? null : null;
  return { name: organization?.name ?? null, role: organization?.role ?? null };
}

/**
 * Step 3 of setup (25.04): what each agent signs in with on one
 * organization's cloud workspaces. Owners and admins see the four logins and
 * open each; a member is told who manages them.
 */
export function LoginsListScreen() {
  const params = useLocalSearchParams<{ orgId?: string }>();
  const orgId = typeof params.orgId === "string" && params.orgId ? params.orgId : null;
  const router = useRouter();
  const api = useCloudApi();
  const organization = useOrganization(orgId);
  const manages = managesLogins(organization.role);
  // A member's list is refused by the server too, so it is not asked for.
  const logins = useRead((client) => (orgId && manages !== false ? client.credentials(orgId) : Promise.resolve(null)), [orgId, manages], { refreshOnFocus: true });
  const header = <Stack.Screen options={{ title: TITLE, headerLargeTitle: false, headerBackButtonDisplayMode: "minimal", headerTitle: () => <HeaderTitle title={TITLE} subtitle={organization.name} /> }} />;

  if (!api) return <Page>{header}<EmptyState title={TITLE} detail={refusalText("signed-out")} /></Page>;
  if (!orgId) return <Page>{header}<EmptyState title={TITLE} detail={refusalText("not-found")} /></Page>;
  const member = manages === false || logins.error?.refusal === "admin-required";
  if (member) return <Page>{header}<Notice tone="info" text={memberNotice(organization.name ?? "this organization")} testID="logins-member" /></Page>;
  if (logins.state === "could-not-be-read" && !logins.value) return <Page>{header}<Unreadable text={listFailure(logins.error)} onRetry={() => void logins.refresh()} retrying={logins.refreshing} /></Page>;
  if (logins.state === "reading" || !logins.value) return <Page>{header}<View style={styles.reading}><ActivityIndicator testID="logins-reading" /></View></Page>;

  const credentials = logins.value;
  const open = (provider: string) => router.push(`/cloud/logins/${provider}?orgId=${encodeURIComponent(orgId)}`);
  const anyAgent = AGENT_LOGINS.some((entry) => entry.section === "agents" && credentials.some((credential) => credential.provider === entry.provider && credential.state === "connected"));
  const section = (key: "agents" | "repositories") => AGENT_LOGINS.filter((entry) => entry.section === key).map((entry, index) => {
    const credential = credentials.find((item) => item.provider === entry.provider);
    const row = listRow(entry, credential);
    return <ProviderRow key={entry.provider} testID={`login-row-${entry.provider}`} name={entry.name} letter={entry.name} badge={row.badge} description={row.detail} divided={index > 0} onPress={() => open(entry.provider)} />;
  });
  return <Page testID="logins-list">
    {header}
    <Intro>{LIST_INTRO}</Intro>
    {logins.state === "could-not-be-read" ? <Notice tone="warning" text={listFailure(logins.error)} /> : null}
    <View style={styles.section}><SectionTitle>Agents</SectionTitle></View>
    <Card>{section("agents")}</Card>
    <View style={styles.section}><SectionTitle>Repositories</SectionTitle></View>
    <Card>{section("repositories")}</Card>
    {!anyAgent ? <Note>{ONE_IS_ENOUGH}</Note> : null}
  </Page>;
}

function Unreadable({ text, onRetry, retrying }: { text: string; onRetry(): void; retrying: boolean }) {
  const { palette } = useTheme();
  return <View testID="logins-unreadable" style={styles.unreadable}>
    <CloudOff size={30} color={palette.faint} />
    <Text accessibilityRole="header" style={[styles.unreadableTitle, { color: palette.ink }]}>{LIST_UNREADABLE}</Text>
    <Text style={[styles.unreadableText, { color: palette.muted }]}>{text}</Text>
    <View style={styles.retry}><Button label="Try again" kind="secondary" disabled={retrying} onPress={onRetry} /></View>
  </View>;
}

const styles = StyleSheet.create({
  reading: { paddingVertical: 48, alignItems: "center" },
  section: { marginTop: 4, marginBottom: -4 },
  unreadable: { alignItems: "center", paddingTop: 56, paddingHorizontal: 8, gap: 8 },
  unreadableTitle: { fontSize: 17, lineHeight: 22, fontWeight: "600", textAlign: "center", marginTop: 8 },
  unreadableText: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  retry: { alignSelf: "stretch", marginTop: 32 },
});
