import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { CloudOff } from "lucide-react-native";
import { View } from "react-native";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { LOGIN_AGENTS, loginDetail, LOGINS_INTRO, LOGINS_ONE_IS_ENOUGH, LOGINS_UNREAD, memberNote, storedLogin, type LoginAgent } from "@mobile/cloud/logins";
import { useAgentLogins } from "@mobile/cloud/useAgentLogins";
import { Help, Lead, LoginHeaderTitle, LoginPage } from "@mobile/ui/logins/LoginPage";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card, EmptyState, SectionTitle } from "@mobile/ui/primitives";
import { ProviderRow } from "@mobile/ui/ProviderRow";
import { credentialBadge } from "@mobile/ui/StateBadge";

/**
 * Agent logins of one organization (board 25.04): what Codex, Claude Code and
 * Cursor sign in with on its cloud workspaces, and the GitHub token that
 * clones private repositories. The service keeps one login per agent and
 * lists them for owners and admins only; a member is told who manages them.
 * Opened as `/agent-logins?orgId=…`.
 */
export default function AgentLoginsScreen() {
  const { orgId } = useLocalSearchParams<{ orgId: string }>();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization ?? null;
  const { logins, reload } = useAgentLogins(catalog && organization ? catalog.api : null, orgId);

  const header = <Stack.Screen options={{ title: "Agent logins", headerLargeTitle: false, headerTitle: () => <LoginHeaderTitle title="Agent logins" organization={organization?.name} /> }} />;
  if (!catalog || !organization) return <>{header}<EmptyState title="Organization unavailable" detail={catalog ? "It is no longer on this account. Go back to see your organizations." : "Sign in to see your organizations."} /></>;
  if (logins.status === "member") return <>{header}<LoginPage testID="agent-logins"><Notice tone="info" text={memberNote(organization.name)} testID="agent-logins-member" /></LoginPage></>;
  if (logins.status === "failed") return <>{header}<LoginPage testID="agent-logins">
    <EmptyState title={LOGINS_UNREAD.title} detail={LOGINS_UNREAD.detail} icon={(color) => <CloudOff size={28} color={color} />} />
    <View style={{ paddingHorizontal: 8 }}><Button label="Try again" kind="secondary" onPress={() => { void reload(); }} /></View>
  </LoginPage></>;
  if (logins.status === "loading") return <>{header}<EmptyState busy title="Reading agent logins" detail={organization.name} /></>;

  const row = (agent: LoginAgent, index: number) => {
    const credential = storedLogin(logins.credentials, agent.provider);
    return <ProviderRow key={agent.provider} testID={`agent-login-${agent.provider}`} name={agent.name} letter={agent.name} divided={index > 0}
      description={loginDetail(agent, credential)} badge={credential ? credentialBadge(credential.state) : "not-connected"}
      onPress={() => router.push({ pathname: "/agent-logins/[provider]", params: { provider: agent.provider, orgId } })} />;
  };
  const agents = LOGIN_AGENTS.filter((agent) => agent.group === "agents");
  const repositories = LOGIN_AGENTS.filter((agent) => agent.group === "repositories");
  const none = LOGIN_AGENTS.every((agent) => !storedLogin(logins.credentials, agent.provider));
  return <>{header}<LoginPage testID="agent-logins">
    <Lead>{LOGINS_INTRO}</Lead>
    <SectionTitle>Agents</SectionTitle>
    <Card>{agents.map(row)}</Card>
    <SectionTitle>Repositories</SectionTitle>
    <Card>{repositories.map(row)}</Card>
    {none ? <Help>{LOGINS_ONE_IS_ENOUGH}</Help> : null}
  </LoginPage></>;
}
