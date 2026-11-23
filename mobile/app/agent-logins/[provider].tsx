import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { CloudOff } from "lucide-react-native";
import { View } from "react-native";
import type { CredentialConsent } from "@mobile/cloud/api";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { CODEX_LOGIN_ITEM, CodexLoginFlow, type CodexLoginState, type CodexLoginStorage } from "@mobile/cloud/codex-login";
import { CODEX_WORDS, LOGIN_CONSENT, loginAgent, loginPurpose, LOGINS_UNREAD, memberNote, storedLogin } from "@mobile/cloud/logins";
import { useAgentLogins } from "@mobile/cloud/useAgentLogins";
import { useApp } from "@mobile/state/AppProvider";
import { ConsentRow } from "@mobile/ui/ConsentRow";
import { CodexSignIn, codexSignInLeavable } from "@mobile/ui/logins/CodexSignIn";
import { LoginKeyForm } from "@mobile/ui/logins/LoginKeyForm";
import { Choices, Help, Lead, LoginHeaderTitle, LoginPage } from "@mobile/ui/logins/LoginPage";
import { SavedLogin } from "@mobile/ui/logins/SavedLogin";
import { Notice } from "@mobile/ui/Notice";
import { Button, EmptyState } from "@mobile/ui/primitives";

// A sign-in that is waiting is kept in the keychain, readable only while this phone is unlocked.
const SECURE: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const attempts: CodexLoginStorage = {
  get: () => SecureStore.getItemAsync(CODEX_LOGIN_ITEM, SECURE),
  set: (value) => SecureStore.setItemAsync(CODEX_LOGIN_ITEM, value, SECURE),
  delete: () => SecureStore.deleteItemAsync(CODEX_LOGIN_ITEM, SECURE),
};

/** Both things the service asks before it takes a login. Only ever made where the person's switch is on, or was when a kept sign-in began. */
const AGREED: CredentialConsent = { organizationSharing: true, machineInstallation: true };
const IDLE: CodexLoginState = { phase: "idle" };
const nothing = () => () => undefined;
const idle = () => IDLE;
type Method = "chatgpt" | "key";

/**
 * One agent's login for an organization (board 25.04), opened from the list
 * as `/agent-logins/<provider>?orgId=…`. A stored login shows its facts with
 * Replace, Revoke and Remove; with none stored, or with `replace=1`, the
 * page is the way in: a key or token to paste, and for Codex the choice
 * between that and signing in with ChatGPT.
 *
 * A Codex sign-in that is still waiting takes the page over, also after the
 * app was left or closed: the same code carries on, and no second one is asked for.
 */
export default function AgentLoginScreen() {
  const { orgId, provider, replace } = useLocalSearchParams<{ orgId: string; provider: string; replace?: string }>();
  const router = useRouter();
  const userId = useApp().session?.user.userId ?? null;
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization ?? null;
  const agent = loginAgent(provider);
  const api = catalog && organization && agent ? catalog.api : null;
  const { logins, reload, put, drop } = useAgentLogins(api, orgId);
  const [consent, setConsent] = useState(false);
  const [picked, setPicked] = useState<Method | null>(null);

  const codex = agent?.provider === "codex";
  const flow = useMemo(() => (api && userId && codex ? new CodexLoginFlow({ api, orgId, userId, storage: attempts }) : null), [api, codex, orgId, userId]);
  // In front: a sign-in this phone was waiting on is carried on with. Gone: nothing more is asked.
  useEffect(() => {
    if (!flow) return;
    void flow.resume(AGREED);
    return () => flow.close();
  }, [flow]);
  const device = useSyncExternalStore(flow?.subscribe ?? nothing, flow?.getSnapshot ?? idle, flow?.getSnapshot ?? idle);
  // The login the service stored takes its place in the list at once.
  const signedIn = device.phase === "done" ? device.credential : null;
  useEffect(() => { if (signedIn) put(signedIn); }, [put, signedIn]);

  const title = (name: string, sub?: string | null, options: { leavable?: boolean } = {}) => <Stack.Screen options={{ title: name, headerLargeTitle: false, headerBackVisible: options.leavable !== false, gestureEnabled: options.leavable !== false, headerTitle: () => <LoginHeaderTitle title={name} organization={sub} /> }} />;

  if (!catalog || !organization) return <>{title("Agent login")}<EmptyState title="Organization unavailable" detail={catalog ? "It is no longer on this account. Go back to see your organizations." : "Sign in to see your organizations."} /></>;
  if (!agent || !api) return <>{title("Agent login")}<EmptyState title="Login unavailable" detail="Update the app to manage this login." /></>;

  if (flow && device.phase !== "idle" && device.phase !== "looking") return <>
    {title(CODEX_WORDS.chatgpt.label, null, { leavable: codexSignInLeavable(device) })}
    <CodexSignIn flow={flow} organization={organization.name} consent={AGREED} onDone={() => router.back()}
      onUseKey={() => { flow.reset(); setPicked("key"); }}
      onBackToList={() => router.dismissTo({ pathname: "/agent-logins", params: { orgId } })} />
  </>;

  if (logins.status === "member") return <>{title(agent.name)}<LoginPage testID="agent-login"><Notice tone="info" text={memberNote(organization.name)} testID="agent-logins-member" /></LoginPage></>;
  if (logins.status === "failed") return <>{title(agent.name)}<LoginPage testID="agent-login">
    <EmptyState title={LOGINS_UNREAD.title} detail={LOGINS_UNREAD.detail} icon={(color) => <CloudOff size={28} color={color} />} />
    <View style={{ paddingHorizontal: 8 }}><Button label="Try again" kind="secondary" onPress={() => { void reload(); }} /></View>
  </LoginPage></>;
  if (logins.status === "loading" || device.phase === "looking") return <>{title(agent.name)}<EmptyState busy title="Reading agent logins" detail={organization.name} /></>;

  const stored = storedLogin(logins.credentials, agent.provider);
  if (stored && replace !== "1") return <>
    {title(agent.name, organization.name)}
    <SavedLogin agent={agent} credential={stored} organization={organization.name}
      revoke={() => api.revokeCredential(orgId, agent.provider)}
      remove={() => api.deleteCredential(orgId, agent.provider)}
      onReplace={() => router.push({ pathname: "/agent-logins/[provider]", params: { provider: agent.provider, orgId, replace: "1" } })}
      onRevoked={put}
      onRemoved={() => { drop(agent.provider); router.back(); }} />
  </>;

  const method: Method = picked ?? (stored?.authKind === "api-key" ? "key" : "chatgpt");
  const ways = codex ? <Choices<Method> value={method} onChange={setPicked} options={[{ id: "chatgpt", ...CODEX_WORDS.chatgpt }, { id: "key", ...CODEX_WORDS.key }]} /> : null;
  if (codex && flow && method === "chatgpt") return <>
    {title(agent.name)}
    <LoginPage testID="codex-method" footer={<Button label="Get a sign-in code" disabled={!consent} accessibilityState={{ disabled: !consent }} onPress={() => { if (consent) void flow.start(AGREED); }} />}>
      <Lead>{loginPurpose(agent, organization.name)}</Lead>
      {ways}
      <Help>{CODEX_WORDS.hint}</Help>
      <ConsentRow text={LOGIN_CONSENT} value={consent} onValueChange={setConsent} testID="login-consent" />
    </LoginPage>
  </>;
  return <>
    {title(agent.name)}
    <LoginKeyForm agent={agent} organization={organization.name} above={ways} consent={consent} onConsentChange={setConsent}
      save={(key, agreed) => api.saveCredential(orgId, agent.provider, key, agreed)}
      onSaved={(credential) => { put(credential); router.back(); }} />
  </>;
}
