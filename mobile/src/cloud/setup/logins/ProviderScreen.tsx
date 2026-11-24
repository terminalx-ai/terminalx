import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { CloudApiError, type CloudCredential, type CredentialConsent } from "../../api";
import { refusalText } from "../../words";
import { useCloudApi, useRead } from "../read";
import { ConsentRow } from "../../../ui/ConsentRow";
import { FactRows, type Fact } from "../../../ui/FactRows";
import { Notice } from "../../../ui/Notice";
import { Button, Card, EmptyState } from "../../../ui/primitives";
import { ProviderRow } from "../../../ui/ProviderRow";
import { Spinner } from "../../../ui/Spinner";
import { credentialBadge } from "../../../ui/StateBadge";
import { TextField, type TextFieldHandle } from "../../../ui/TextField";
import { agentLogin, dayText, kindLabel, managesLogins, savedLogin, type AgentLogin } from "./agents";
import { useOrganization } from "./ListScreen";
import { ChoiceCard, HeaderTitle, Intro, Note, Page } from "./parts";
import {
  AUTHORIZATION, CHATGPT, CODEX_KEY, DEVICE_CODE_SETTING, IDENTITY_LABEL, IDENTITY_PLACEHOLDER, IN_USE_TITLE, REVOKE_TEXT, SAVED_NOTE, SECRET_HELPER,
  checkingLabel, failure, formIntro, listFailure, memberNotice, removeText, removeTitle, revokeTitle, saveFailure, signInRequired,
} from "./words";

/** What the admin agreed to on the switch; sent with the request, never kept. */
export const CONSENT: CredentialConsent = { organizationSharing: true, machineInstallation: true };

type How = "chatgpt" | "api-key";

/**
 * One agent's login (25.04): the saved login by its fingerprint, with
 * Replace, Revoke and Remove; or, with none saved, the form that sends one.
 */
export function LoginProviderScreen() {
  const params = useLocalSearchParams<{ provider?: string; orgId?: string; how?: string }>();
  const orgId = typeof params.orgId === "string" && params.orgId ? params.orgId : null;
  const entry = agentLogin(params.provider);
  const api = useCloudApi();
  const organization = useOrganization(orgId);
  const orgName = organization.name ?? "this organization";
  const manages = managesLogins(organization.role);
  const logins = useRead((client) => (orgId && manages !== false ? client.credentials(orgId) : Promise.resolve(null)), [orgId, manages], { refreshOnFocus: true });
  // Replace, Sign in again, or "Use an API key" from a device sign-in that could not start: the form, over a saved login.
  const [replacing, setReplacing] = useState<How | null>(params.how === "api-key" || params.how === "chatgpt" ? params.how : null);
  const credential = entry ? logins.value?.find((item) => item.provider === entry.provider) ?? null : null;
  const name = entry?.name ?? "Agent login";
  const showSaved = !!entry && savedLogin(credential) && replacing === null;
  const header = <Stack.Screen options={{ title: name, headerLargeTitle: false, headerBackButtonDisplayMode: "minimal", ...(showSaved ? { headerTitle: () => <HeaderTitle title={name} subtitle={organization.name} /> } : {}) }} />;

  if (!api) return <Page>{header}<EmptyState title={name} detail={refusalText("signed-out")} /></Page>;
  if (!orgId || !entry) return <Page>{header}<EmptyState title={name} detail={refusalText("not-found")} /></Page>;
  if (manages === false || logins.error?.refusal === "admin-required") return <Page>{header}<Notice tone="info" text={memberNotice(orgName)} /></Page>;
  if (logins.state === "could-not-be-read" && !logins.value) return <Page>{header}<Notice tone="danger" text={listFailure(logins.error)} action={{ label: "Try again", onPress: () => void logins.refresh(), disabled: logins.refreshing }} /></Page>;
  if (logins.state === "reading" || !logins.value) return <Page>{header}<View style={styles.reading}><ActivityIndicator testID="login-reading" /></View></Page>;
  if (showSaved && credential) return <SavedLogin key={credential.id} header={header} entry={entry} credential={credential} orgId={orgId} orgName={orgName} onChanged={logins.refresh} onReplace={setReplacing} />;
  return <LoginForm key={replacing ?? "new"} header={header} entry={entry} orgId={orgId} orgName={orgName} initialHow={replacing ?? "chatgpt"} />;
}

function SavedLogin({ header, entry, credential, orgId, orgName, onChanged, onReplace }: { header: ReactNode; entry: AgentLogin; credential: CloudCredential; orgId: string; orgName: string; onChanged(): Promise<void>; onReplace(how: How): void }) {
  const api = useCloudApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const alive = useAlive();
  const needsSignIn = credential.state === "sign-in-required";
  // Revoke stops new grants; once revoked (or never usable again) the login can only be replaced or removed.
  const removable = credential.state === "revoked" || credential.state === "disconnected";
  const badge = credentialBadge(credential.state);
  const facts: Fact[] = [
    ...(credential.displayIdentity?.trim() ? [{ label: "Account", value: credential.displayIdentity.trim() }] : []),
    { label: "Key", value: credential.fingerprint, mono: true },
    { label: "Updated", value: dayText(credential.updatedAt, true) },
  ];

  const act = (work: () => Promise<void>) => {
    setBusy(true);
    void work().finally(() => { if (alive.current) setBusy(false); });
  };
  const revoke = () => Alert.alert(revokeTitle(entry), REVOKE_TEXT, [
    { text: "Cancel", style: "cancel" },
    { text: "Revoke", style: "destructive", onPress: () => act(async () => {
      if (!api) return;
      try {
        await api.revokeCredential(orgId, entry.provider);
        await onChanged();
      } catch (error) {
        if (!(error instanceof CloudApiError)) throw error;
        Alert.alert("Not revoked", failure(error));
      }
    }) },
  ]);
  const remove = () => Alert.alert(removeTitle(entry), removeText(entry), [
    { text: "Cancel", style: "cancel" },
    { text: "Remove", style: "destructive", onPress: () => act(async () => {
      if (!api) return;
      try {
        await api.deleteCredential(orgId, entry.provider);
        router.back();
      } catch (error) {
        if (!(error instanceof CloudApiError)) throw error;
        // cloud_workspace_credential_in_use: a running workspace was set up with it.
        if (error.refusal === "login-in-use") Alert.alert(IN_USE_TITLE, refusalText(error), [{ text: "OK" }]);
        else Alert.alert("Not removed", failure(error));
      }
    }) },
  ]);

  const primary = needsSignIn && entry.provider === "codex"
    ? <Button label="Sign in again" disabled={busy} onPress={() => onReplace("chatgpt")} />
    : <Button label="Replace" kind={needsSignIn ? "primary" : "secondary"} disabled={busy} onPress={() => onReplace(entry.provider === "codex" && credential.authKind !== "api-key" ? "chatgpt" : "api-key")} />;
  return <Page testID="login-saved" footer={<>{primary}{removable ? <Button label="Remove…" kind="danger" disabled={busy} onPress={remove} /> : <Button label="Revoke…" kind="danger" disabled={busy} onPress={revoke} />}</>}>
    {header}
    <Card>
      <ProviderRow name={entry.name} letter={entry.name} description={kindLabel(credential.authKind)} badge={badge} badgeAtEnd />
      <FactRows facts={facts} embedded />
    </Card>
    {needsSignIn ? <Notice tone="warning" text={signInRequired(entry, orgName)} testID="login-sign-in-required" /> : <Note>{SAVED_NOTE}</Note>}
  </Page>;
}

/** Whether the page is still shown, for answers that come after it is gone. */
function useAlive() {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

/**
 * The form for a key or a token (Codex's, Claude Code's and Cursor's API key,
 * GitHub's personal access token), and Codex's choice of ChatGPT sign-in.
 *
 * The secret is held by the field alone, never in this page's state: it is
 * read once for the request that sends it, and the field is emptied as soon
 * as the answer says it is not wanted again (saved, or failed the check).
 */
function LoginForm({ header, entry, orgId, orgName, initialHow }: { header: ReactNode; entry: AgentLogin; orgId: string; orgName: string; initialHow: How }) {
  const api = useCloudApi();
  const router = useRouter();
  const codex = entry.provider === "codex";
  const [how, setHow] = useState<How>(codex ? initialHow : "api-key");
  const [authorized, setAuthorized] = useState(false);
  const [filled, setFilled] = useState(false);
  const [identity, setIdentity] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, raise] = useState<null>(null);
  const field = useRef<TextFieldHandle>(null);
  const alive = useAlive();
  const deviceLogin = codex && how === "chatgpt";
  const fieldLabel = entry.fieldLabel;

  const save = async () => {
    if (!api || saving) return;
    const secret = field.current?.read() ?? "";
    if (!secret || !authorized) return;
    setSaving(true);
    setFieldError(null);
    setNotice(null);
    try {
      await api.saveCredential(orgId, entry.provider, { authKind: entry.authKind, secret, displayIdentity: identity.trim() || null }, CONSENT);
      field.current?.clear();
      if (alive.current) router.back();
    } catch (error) {
      if (!(error instanceof CloudApiError)) { raise(() => { throw error; }); return; }
      const said = saveFailure(entry, error);
      if (!said.keep) field.current?.clear();
      if (!alive.current) return;
      setFieldError(said.field);
      setNotice(said.notice);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const footer = deviceLogin
    ? <Button label="Get a sign-in code" disabled={!authorized} onPress={() => router.replace(`/cloud/logins/codex-sign-in?orgId=${encodeURIComponent(orgId)}&authorized=1`)} />
    : <Button label={saving ? checkingLabel(entry) : "Save"} disabled={saving || !filled || !authorized} icon={saving ? (color) => <Spinner size={14} color={color} /> : undefined} onPress={() => void save()} />;
  return <Page testID="login-form" footer={footer}>
    {header}
    <Intro>{formIntro(entry, orgName)}</Intro>
    {codex ? <>
      <ChoiceCard choices={[{ value: "chatgpt" as const, ...CHATGPT }, { value: "api-key" as const, ...CODEX_KEY }]} value={how} disabled={saving} onChange={(value) => { setHow(value); setNotice(null); setFieldError(null); }} />
      {deviceLogin ? <View style={styles.tight}><Note>{DEVICE_CODE_SETTING}</Note></View> : null}
    </> : null}
    {deviceLogin ? null : <>
      <TextField ref={field} secret label={fieldLabel} placeholder={fieldLabel} paste helper={SECRET_HELPER} error={fieldError} disabled={saving} testID="login-secret"
        onFilledChange={(value) => { setFilled(value); if (value) setFieldError(null); }} />
      <TextField label={IDENTITY_LABEL} hint="optional" placeholder={IDENTITY_PLACEHOLDER} value={identity} onChangeText={setIdentity} disabled={saving} autoCapitalize="none" autoCorrect={false} testID="login-identity" />
    </>}
    <ConsentRow text={AUTHORIZATION} value={authorized} onValueChange={setAuthorized} disabled={saving} testID="login-consent" />
    {notice ? <Notice tone="danger" text={notice} testID="login-notice" /> : null}
  </Page>;
}

const styles = StyleSheet.create({
  reading: { paddingVertical: 48, alignItems: "center" },
  tight: { marginTop: -6 },
});
