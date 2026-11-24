import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Ban, Images, MapPin, Receipt, type LucideIcon } from "lucide-react-native";
import { CloudApiError, type CloudApi, type CloudProvider } from "@mobile/cloud/api";
import { useCloudApi, useRead } from "@mobile/cloud/setup/read";
import { refusalText } from "@mobile/cloud/words";
import { ConsentRow } from "@mobile/ui/ConsentRow";
import { DescribedFields, type DescribedFieldsHandle } from "@mobile/ui/DescribedFields";
import { FactRows, type Fact } from "@mobile/ui/FactRows";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card, EmptyState } from "@mobile/ui/primitives";
import { ProviderMark, ProviderRow } from "@mobile/ui/ProviderRow";
import { Spinner } from "@mobile/ui/Spinner";
import { providerBadge } from "@mobile/ui/StateBadge";
import { useTheme } from "@mobile/ui/theme";
import { answeredConnection, credentialOf, keyField, listedConnection, providerPage, storedAfterTimeout, type ShownConnection } from "./model";
import { Helper, HeaderTitle, Page, useOrganizationName } from "./parts";
import {
  attentionText, CHECKING, checkedText, connectRefusal, connectTitle, consentText, dayText, disconnectQuestion, FINGERPRINT_HELPER, KEY_HELPER,
  listFailure, MEMBER, notDisconnectedTitle, providerFacts, replaceTitle, SEVERAL_FIELDS, stillHoldsWorkspaces, UNREADABLE_TITLE, type ProviderFact,
} from "./words";

const ACCEPTED = { providerBilling: true, organizationUse: true } as const;

/**
 * One compute provider (board 25.03), as the server describes it. Not
 * connected, it is the form its descriptor makes; connected, the stored key's
 * facts by fingerprint, with Replace key and Disconnect; with nothing to
 * connect, it is ready. `replacing` is the form again, under another title,
 * for a provider that already has a key.
 *
 * There is no single-provider route: the page reads the organization's list
 * and shows the one it asked for.
 */
export function ProviderScreen({ orgId, providerId, replacing }: { orgId: string; providerId: string; replacing: boolean }) {
  const api = useCloudApi();
  const organization = useOrganizationName(orgId);
  const list = useRead((client) => client.providers(orgId), [orgId], { refreshOnFocus: true });
  // What a connect just answered, shown until the list read after it says otherwise.
  const [justConnected, setJustConnected] = useState<ShownConnection | null>(null);
  const shownList = useRef(list.value);
  useEffect(() => {
    if (list.value === shownList.current) return;
    shownList.current = list.value;
    setJustConnected(null);
  }, [list.value]);

  const header = (title: string, subtitle: string | null) => <Stack.Screen options={{ title, headerLargeTitle: false, headerBackButtonDisplayMode: "minimal", headerTitle: () => <HeaderTitle title={title} subtitle={subtitle} /> }} />;

  if (!api) return <>{header("Compute", organization)}<EmptyState title="Compute unavailable" detail={refusalText("signed-out")} /></>;
  if (list.value === null) {
    if (list.state === "could-not-be-read") return <>{header("Compute", organization)}<Page testID="provider-unreadable">
      <View style={styles.gap} />
      <EmptyState title={UNREADABLE_TITLE} detail={listFailure(list.error)} />
      <View style={styles.retry}><Button label="Try again" kind="secondary" disabled={list.refreshing} onPress={() => void list.refresh()} /></View>
    </Page></>;
    return <>{header("Compute", organization)}<EmptyState title="Reading" detail="Reading this organization’s compute providers." busy /></>;
  }

  const provider = list.value.find((entry) => entry.id === providerId);
  if (!provider) return <>{header("Compute", organization)}<EmptyState title="Not offered" detail={refusalText("not-found")} /></>;
  const name = provider.displayName || provider.descriptor.label;
  const page = providerPage(provider, { replacing, justConnected });

  switch (page.kind) {
    case "member": return <>{header(name, organization)}<Page testID="provider-member">
      <Notice tone="info" text={MEMBER} />
      <Card style={styles.clip}><ProviderRow name={name} description={provider.descriptor.description} billing={provider.descriptor.billing} icon={provider.descriptor.icon} badge={providerBadge(provider)} /></Card>
    </Page></>;
    case "ready": return <>{header(name, organization)}<Page testID="provider-ready">
      <Card style={styles.clip}><ProviderRow name={name} billing={provider.descriptor.billing} icon={provider.descriptor.icon} badge={providerBadge(provider)} badgeAtEnd /></Card>
      <Helper>{provider.descriptor.description}</Helper>
    </Page></>;
    case "form": return <>{header(page.replacing ? replaceTitle(name) : connectTitle(name), null)}
      <ConnectForm
        key={`${provider.id}:${page.replacing ? "replace" : "connect"}`}
        api={api}
        orgId={orgId}
        provider={provider}
        name={name}
        replacing={page.replacing}
        onConnected={(connection) => {
          if (page.replacing) { void list.refresh(); return "back"; }
          setJustConnected(connection);
          void list.refresh();
          return "stay";
        }}
      />
    </>;
    case "connected": return <>{header(name, organization)}
      <ConnectedPage api={api} orgId={orgId} provider={provider} name={name} connection={page.connection} />
    </>;
  }
}

/**
 * The connect form (25.03, "Connect: the path that works"): the descriptor's
 * description and billing, one input per credential field, the
 * acknowledgement, and Connect, which is off until both are there.
 *
 * The key is held only by its field (`TextField` keeps a secret in a ref,
 * never in state or props). Connect reads it once into the request and keeps
 * no copy: not in this component's state, not in a log, not in an error, not
 * in a route. After the provider rejects it the field is emptied and focused;
 * after any other refusal it stays for another try, as the board draws it;
 * once connected the field is emptied and the form leaves the screen.
 */
function ConnectForm({ api, orgId, provider, name, replacing, onConnected }: {
  api: CloudApi;
  orgId: string;
  provider: CloudProvider;
  name: string;
  replacing: boolean;
  /** A key was stored. "back" when the page that opened this form is to show it. */
  onConnected(connection: ShownConnection): "back" | "stay";
}) {
  const { palette } = useTheme();
  const router = useRouter();
  const fields = useRef<DescribedFieldsHandle>(null);
  const [filled, setFilled] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ name: string; text: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const several = provider.descriptor.credentialFields.length > 1;
  const field = keyField(provider);
  const canSend = filled && consent && !busy && !several;

  const done = (connection: ShownConnection) => {
    // The key has done its one job: it leaves the field before the form leaves the screen.
    fields.current?.clear();
    if (onConnected(connection) === "back") router.back();
  };

  const send = async () => {
    if (!canSend || !fields.current) return;
    const credential = credentialOf(provider, fields.current.read());
    if (credential === null) return;
    setBusy(true);
    setFieldError(null);
    setFormError(null);
    try {
      const answer = answeredConnection(await api.connectProvider(orgId, provider.id, credential, ACCEPTED));
      if (!mounted.current) return;
      if (answer) done(answer);
      else setFormError(refusalText("unknown"));
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      if (error.reason === "timeout") {
        // No answer in time: the server may have stored the key, so the list says what happened before the phone does.
        const after = await api.providers(orgId).then((providers) => providers.find((entry) => entry.id === provider.id) ?? null, () => undefined);
        if (!mounted.current) return;
        const stored = after ? listedConnection(after) : null;
        if (after !== undefined && stored && storedAfterTimeout(provider, after)) { done(stored); return; }
        setFormError(refusalText("unreachable"));
        return;
      }
      if (!mounted.current) return;
      const refusal = connectRefusal(error, name);
      if (refusal.where === "field" && field) setFieldError({ name: field, text: refusal.text });
      else setFormError(refusal.text);
      if (refusal.clearKey && field) {
        fields.current?.clear(field);
        fields.current?.focus(field);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={92}>
    <Page testID="connect-form" foot={<Button
      testID="connect-button"
      label={busy ? CHECKING : replacing ? "Replace key" : "Connect"}
      accessibilityLabel={busy ? CHECKING : replacing ? "Replace key" : "Connect"}
      accessibilityState={{ disabled: !canSend, busy }}
      icon={busy ? (color) => <Spinner size={16} color={color} /> : undefined}
      disabled={!canSend}
      onPress={() => void send()}
    />}>
      <Card style={styles.describe}>
        <ProviderMark icon={provider.descriptor.icon} />
        <View style={styles.describeText}>
          <Text style={[styles.description, { color: palette.ink }]}>{provider.descriptor.description}</Text>
          <Text style={[styles.billing, { color: palette.muted }]}>{provider.descriptor.billing}</Text>
        </View>
      </Card>
      <DescribedFields
        ref={fields}
        fields={provider.descriptor.credentialFields}
        helper={KEY_HELPER}
        errors={fieldError ? { [fieldError.name]: fieldError.text } : undefined}
        disabled={busy}
        onOpenHelp={(url) => void WebBrowser.openBrowserAsync(url).catch(() => undefined)}
        onReadyChange={(ready) => {
          setFilled(ready);
          // Something new in the field: what was said about the last key no longer applies.
          if (ready) setFieldError(null);
        }}
      />
      <ConsentRow testID="connect-consent" text={consentText(name)} value={consent} disabled={busy} onValueChange={setConsent} />
      {several ? <Notice tone="info" text={SEVERAL_FIELDS} testID="connect-several" /> : null}
      {formError ? <Notice tone="danger" text={formError} testID="connect-refused" /> : null}
    </Page>
  </KeyboardAvoidingView>;
}

const FACT_ICONS: Record<ProviderFact["kind"], LucideIcon> = { location: MapPin, source: Images, pricing: Receipt, suspend: Ban };

/**
 * A provider with a stored key (25.03, "Connected", "Needs attention"): the
 * key by fingerprint only, when it was connected and last checked, what the
 * descriptor says about its machines, then Replace key and Disconnect.
 */
function ConnectedPage({ api, orgId, provider, name, connection }: { api: CloudApi; orgId: string; provider: CloudProvider; name: string; connection: ShownConnection }) {
  const { palette } = useTheme();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const attention = connection.state === "attention-required";
  // When the page was drawn, for "today": read once, not on every render.
  const [now] = useState(() => Date.now());
  const facts: Fact[] = [
    ...(connection.fingerprint ? [{ label: "Key", value: connection.fingerprint, mono: true }] : []),
    ...(connection.connectedAt !== null ? [{ label: "Connected", value: dayText(connection.connectedAt) }] : []),
    ...(connection.lastValidatedAt !== null ? [{ label: "Last checked", value: checkedText(connection.lastValidatedAt, now) }] : []),
  ];
  const described = providerFacts(provider.descriptor);

  const replace = () => router.push(`/cloud/compute/${encodeURIComponent(provider.id)}?orgId=${encodeURIComponent(orgId)}&replace=1`);
  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnectProvider(orgId, provider.id);
      router.back();
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      if (error.refusal === "provider-has-machines") {
        const said = stillHoldsWorkspaces(name);
        Alert.alert(said.title, said.detail, [{ text: "OK" }]);
      } else {
        Alert.alert(notDisconnectedTitle(name), refusalText(error), [{ text: "OK" }]);
      }
    } finally {
      setBusy(false);
    }
  };
  const ask = () => {
    const said = disconnectQuestion(name);
    Alert.alert(said.title, said.detail, [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => void disconnect() },
    ]);
  };

  return <Page testID={attention ? "provider-attention" : "provider-connected"} foot={<>
    <Button label="Replace key" kind={attention ? "primary" : "secondary"} disabled={busy} onPress={replace} />
    <Button label="Disconnect…" accessibilityLabel="Disconnect…" kind="danger" disabled={busy} onPress={ask} />
  </>}>
    <Card style={styles.clip}>
      <ProviderRow name={name} billing={provider.descriptor.billing} icon={provider.descriptor.icon} badge={attention ? "attention-required" : "connected"} badgeAtEnd />
      {facts.length ? <FactRows facts={facts} embedded testID="provider-key-facts" /> : null}
    </Card>
    {attention ? <Notice tone="danger" text={attentionText(name)} testID="provider-attention-notice" /> : connection.fingerprint ? <Helper>{FINGERPRINT_HELPER}</Helper> : null}
    {described.length ? <Card testID="provider-facts" style={styles.clip}>{described.map((fact, index) => {
      const Icon = FACT_ICONS[fact.kind];
      return <View key={fact.kind} style={[styles.fact, index > 0 ? { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth } : null]}>
        <Icon size={16} color={palette.faint} />
        <Text style={[styles.factText, { color: palette.ink }]}>{fact.text}</Text>
      </View>;
    })}</Card> : null}
  </Page>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { height: 48 },
  retry: { marginTop: 20, marginHorizontal: 8 },
  clip: { overflow: "hidden" },
  describe: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  describeText: { flex: 1, minWidth: 0, gap: 4 },
  description: { fontSize: 15, lineHeight: 21 },
  billing: { fontSize: 13, lineHeight: 18 },
  fact: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  factText: { flex: 1, fontSize: 14, lineHeight: 20 },
});
