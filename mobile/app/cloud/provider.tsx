import { useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { CloudOff, Layers, MapPin, PowerOff, Receipt, Trash2, WifiOff, type LucideIcon } from "lucide-react-native";
import type { CloudProvider, CloudProviderConnection } from "@mobile/cloud/api";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { COMPUTE_OWNER_REQUIRED, CONNECT_OUTCOME_UNKNOWN, connectDisclosure, connectFailure, disconnectBody, disconnectFailure, disconnectTitle, KEY_HANDLING, listFailure, needsAttention, providerFacts, whenText, type ConnectFailure, type ProviderFactKind } from "@mobile/cloud/compute";
import { TitleWithOrganization, useProviders } from "@mobile/ui/compute";
import { ConsentRow } from "@mobile/ui/ConsentRow";
import { DescribedFields, type DescribedFieldsHandle } from "@mobile/ui/DescribedFields";
import { FactRows, type Fact } from "@mobile/ui/FactRows";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card, EmptyState, Screen } from "@mobile/ui/primitives";
import { ProviderMark, ProviderRow } from "@mobile/ui/ProviderRow";
import { providerBadge } from "@mobile/ui/StateBadge";
import { useTheme } from "@mobile/ui/theme";

type Connection = NonNullable<CloudProvider["connection"]>;

/**
 * One compute provider of an organization (25.03), for someone who manages
 * its compute: connect it with a key, see that a key is stored, replace it or
 * disconnect. The page is drawn from the server's description of the
 * provider: its name, mark, sentences and the fields it asks for.
 *
 * A key is read from its field once, for the one request that sends it, and
 * the field is emptied before the answer comes. Nothing of it is kept in this
 * page's state, and the server never sends it back: afterwards only its
 * fingerprint can be shown.
 */
export default function ComputeProviderScreen() {
  const { orgId, providerId } = useLocalSearchParams<{ orgId: string; providerId: string }>();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization.name ?? null;
  if (!catalog || !orgId || !providerId) return <>
    <Stack.Screen options={{ title: "Compute", headerLargeTitle: false }} />
    <EmptyState title="Compute unavailable" detail="Sign in, then open the organization again." />
  </>;
  return <Provider catalog={catalog} orgId={orgId} providerId={providerId} organization={organization} />;
}

function Provider({ catalog, orgId, providerId, organization }: { catalog: CloudCatalog; orgId: string; providerId: string; organization: string | null }) {
  const router = useRouter();
  const { providers, error, reading, read } = useProviders(catalog, orgId);
  const [replacing, setReplacing] = useState(false);
  // The connect answer, shown until the list has been read again.
  const [answered, setAnswered] = useState<Connection | null>(null);

  const listed = providers?.find((entry) => entry.id === providerId) ?? null;
  const provider = listed && answered ? { ...listed, availability: answered.state === "attention-required" ? "attention-required" : "available", connection: answered } : listed;
  const label = provider?.descriptor.label ?? "Compute";
  const asksForKey = !!provider && provider.canManage && provider.descriptor.credentialFields.length > 0;
  const form = asksForKey && (!provider.connection || replacing);
  const title = !provider ? "Compute" : form ? (replacing ? `Replace ${label} key` : `Connect ${label}`) : label;

  const connected = (connection: CloudProviderConnection) => {
    setReplacing(false);
    if (connection.state !== "not-connected") setAnswered({ state: connection.state, connectedAt: connection.connectedAt ?? catalog.api.serverNow(), lastValidatedAt: connection.lastValidatedAt, credentialFingerprint: connection.credentialFingerprint });
    void read().then((list) => { if (list) setAnswered(null); });
  };

  let body;
  if (!providers) {
    if (error) {
      const failure = listFailure(error);
      body = <Screen testID="provider-failed">
        <EmptyState title={failure.title} detail={failure.detail} icon={(color) => <CloudOff size={30} color={color} />} />
        <View style={styles.retry}><Button label="Try again" kind="secondary" disabled={reading} onPress={() => void read()} /></View>
      </Screen>;
    } else body = <EmptyState title="Reading" detail="Reading this provider from your account service." busy />;
  } else if (!provider) body = <EmptyState title="Provider not offered" detail="Your account service does not offer this provider to this organization any more." />;
  else if (!provider.canManage) body = <Screen testID="provider-member">
    <Notice testID="compute-owner-required" tone="info" text={COMPUTE_OWNER_REQUIRED} />
    <Card><ProviderRow name={label} description={provider.descriptor.description} billing={provider.descriptor.billing} icon={provider.descriptor.icon} badge={providerBadge(provider)} /></Card>
  </Screen>;
  else if (!asksForKey) body = <Ready provider={provider} />;
  else if (form) body = <ConnectForm key={`${provider.id}:${replacing ? "replace" : "connect"}`} catalog={catalog} orgId={orgId} provider={provider} replacing={replacing} read={read} onConnected={connected} onStored={() => setReplacing(false)} />;
  else body = <Stored catalog={catalog} orgId={orgId} provider={provider} connection={provider.connection!} read={read} onReplace={() => setReplacing(true)} onDisconnected={() => router.back()} />;

  return <>
    <Stack.Screen options={{ title, headerLargeTitle: false, headerTitle: () => <TitleWithOrganization title={title} organization={form ? null : organization} /> }} />
    {body}
  </>;
}

/** A provider with nothing to connect (TerminalX Cloud): no form, and nothing to disconnect. */
function Ready({ provider }: { provider: CloudProvider }) {
  const { palette } = useTheme();
  return <Screen testID="provider-ready">
    <Card><ProviderRow name={provider.descriptor.label} billing={provider.descriptor.billing} icon={provider.descriptor.icon} badge={providerBadge(provider)} badgeAtEnd /></Card>
    {provider.descriptor.description ? <Text style={[styles.help, { color: palette.muted }]}>{provider.descriptor.description}</Text> : null}
  </Screen>;
}

function ConnectForm({ catalog, orgId, provider, replacing, read, onConnected, onStored }: {
  catalog: CloudCatalog;
  orgId: string;
  provider: CloudProvider;
  replacing: boolean;
  read(): Promise<CloudProvider[] | null>;
  onConnected(connection: CloudProviderConnection): void;
  /** The list shows the key stored though the connect itself got no answer. */
  onStored(): void;
}) {
  const { palette } = useTheme();
  const { descriptor } = provider;
  const label = descriptor.label;
  const fields = useRef<DescribedFieldsHandle>(null);
  const [ready, setReady] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  // The server takes one value with a connect. A provider that asks for several cannot be connected from here yet.
  const field = descriptor.credentialFields.length === 1 ? descriptor.credentialFields[0]! : null;

  const send = async () => {
    if (!field || busy || !ready || !accepted) return;
    const before = provider.connection;
    setBusy(true);
    setFailure(null);
    // Read once, for this one request, and the field is emptied before the answer comes: nothing here holds the key after it is sent.
    const request = catalog.api.connectProvider(orgId, provider.id, fields.current?.read()[field.name] ?? "", { providerBilling: true, organizationUse: true });
    fields.current?.clear();
    try {
      onConnected(await request);
    } catch (error) {
      let next = connectFailure(error, label);
      if (next.stored === "unknown") {
        // No answer that says either way: the key may have been stored. The server's list says.
        const list = await read();
        const now = list?.find((entry) => entry.id === provider.id)?.connection;
        if (!list) next = { where: "form", text: CONNECT_OUTCOME_UNKNOWN, stored: "unknown" };
        // Stored after all: the page shows the key the list now describes.
        else if (now && (!before || now.connectedAt !== before.connectedAt || now.credentialFingerprint !== before.credentialFingerprint)) return onStored();
        else if (before) next = { ...next, text: "The service did not answer. The key stored before is still the one in use. Paste the new key and try again." };
      }
      setFailure(next);
      if (next.where === "field") fields.current?.focus(field.name);
    } finally {
      setBusy(false);
    }
  };

  return <Screen testID="provider-form">
    <Card>
      <View style={styles.about}>
        <ProviderMark icon={descriptor.icon} />
        <View style={styles.aboutBody}>
          {descriptor.description ? <Text style={[styles.description, { color: palette.ink }]}>{descriptor.description}</Text> : null}
          {descriptor.billing ? <Text style={[styles.billing, { color: palette.muted }]}>{descriptor.billing}</Text> : null}
        </View>
      </View>
    </Card>
    {field ? <>
      <DescribedFields
        key={provider.id}
        ref={fields}
        testID="provider-fields"
        fields={descriptor.credentialFields}
        helper={KEY_HANDLING}
        errors={failure?.where === "field" ? { [field.name]: failure.text } : undefined}
        disabled={busy}
        onReadyChange={setReady}
        onOpenHelp={(url) => { void WebBrowser.openBrowserAsync(url).catch(() => undefined); }}
      />
      <ConsentRow testID="provider-consent" text={connectDisclosure(label)} value={accepted} disabled={busy} onValueChange={setAccepted} />
      {failure?.where === "form" ? <Notice testID="provider-form-failure" tone="danger" text={failure.text} icon={failure.offline ? (color) => <WifiOff size={16} color={color} /> : undefined} /> : null}
      <Button testID="provider-connect" label={busy ? "Checking the key…" : replacing ? "Replace key" : "Connect"} accessibilityState={{ disabled: !ready || !accepted || busy, busy }} disabled={!ready || !accepted || busy} onPress={() => void send()} />
    </> : <Notice testID="provider-several-fields" tone="info" text={`${label} asks for more than one value, which this app cannot send yet. Connect it from the TerminalX desktop app or the web console.`} />}
  </Screen>;
}

const FACT_ICONS: Record<ProviderFactKind, LucideIcon> = { location: MapPin, source: Layers, pricing: Receipt, release: Trash2, suspend: PowerOff };

/** A provider with a key stored: the key's facts, what to know about the provider, replace and disconnect. */
function Stored({ catalog, orgId, provider, connection, read, onReplace, onDisconnected }: {
  catalog: CloudCatalog;
  orgId: string;
  provider: CloudProvider;
  connection: Connection;
  read(): Promise<CloudProvider[] | null>;
  onReplace(): void;
  onDisconnected(): void;
}) {
  const { palette } = useTheme();
  const { descriptor } = provider;
  const label = descriptor.label;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attention = needsAttention(provider);
  const now = catalog.api.serverNow();
  const key: Fact[] = [
    ...(connection.credentialFingerprint ? [{ label: "Key", value: connection.credentialFingerprint, mono: true }] : []),
    { label: "Connected", value: whenText(connection.connectedAt, now) },
    ...(connection.lastValidatedAt !== undefined ? [{ label: "Last checked", value: whenText(connection.lastValidatedAt, now) }] : []),
  ];
  const facts = providerFacts(provider);

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await catalog.api.disconnectProvider(orgId, provider.id);
      onDisconnected();
    } catch (error) {
      const refused = disconnectFailure(error, label);
      if (refused.blocked) Alert.alert(refused.title ?? "", refused.text, [{ text: "OK" }]);
      else {
        setFailure(refused.text);
        // What the server says now is shown, whatever became of the request.
        void read();
      }
    } finally {
      setBusy(false);
    }
  };
  const ask = () => Alert.alert(disconnectTitle(label), disconnectBody(label), [
    { text: "Cancel", style: "cancel" },
    { text: "Disconnect", style: "destructive", onPress: () => void disconnect() },
  ]);

  return <Screen testID="provider-stored">
    <Card>
      <ProviderRow name={label} billing={descriptor.billing} icon={descriptor.icon} badge={attention ? "attention-required" : "connected"} badgeAtEnd />
      <FactRows embedded testID="provider-key" facts={key} />
    </Card>
    {attention ? <Notice testID="provider-attention" tone="danger" text={`${label} rejected the stored key on its last check. Replace the key to continue. Workspaces on it cannot be started until then.`} /> : null}
    {facts.length ? <Card testID="provider-facts">
      {facts.map((fact, index) => {
        const Icon = FACT_ICONS[fact.kind];
        return <View key={fact.kind} style={[styles.fact, index ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null]}>
          <Icon size={16} color={palette.faint} />
          <Text style={[styles.factText, { color: palette.ink }]}>{fact.text}</Text>
        </View>;
      })}
    </Card> : null}
    {failure ? <Notice testID="provider-disconnect-failure" tone="danger" text={failure} /> : null}
    {/* A provider that is no longer offered is listed only so it can be disconnected. */}
    {descriptor.listed ? <Button testID="provider-replace" label="Replace key" kind={attention ? "primary" : "secondary"} disabled={busy} onPress={onReplace} /> : null}
    <Button testID="provider-disconnect" label="Disconnect…" kind="danger" disabled={busy} onPress={ask} />
  </Screen>;
}

const styles = StyleSheet.create({
  help: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  retry: { paddingHorizontal: 8 },
  about: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  aboutBody: { flex: 1, minWidth: 0 },
  description: { fontSize: 14, lineHeight: 21 },
  billing: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  fact: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  factText: { flex: 1, fontSize: 14, lineHeight: 20 },
});
