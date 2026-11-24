import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { CirclePause, CloudOff, ServerOff } from "lucide-react-native";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { refusalText } from "@mobile/cloud/words";
import { useCloudApi, useRead } from "@mobile/cloud/setup/read";
import { holdLaunch, LaunchFlow, useLaunchSnapshot } from "@mobile/cloud/setup/launch/flow";
import { agentLogins, defaultSelection, launchableProviders, nothingToLaunchOn, readFailure, readLogins, type BlockedPage } from "@mobile/cloud/setup/launch/form";
import { ChoiceSheet, LaunchHeader, LaunchPage, LoginRow, SettingRow } from "@mobile/cloud/setup/launch/parts";
import { repositoryShown } from "@mobile/cloud/setup/launch/repository";
import { idleChoice, idleChoices, idleValue, loginDetail, loginName, machineDetail, OPEN_TO_ORGANIZATION, IDLE_NOTE, problemsTitle, sizeSheetNote, sizeValue } from "@mobile/cloud/setup/launch/words";
import { priceText } from "@mobile/ui/PriceLines";
import { Button, Card, EmptyState, SectionTitle } from "@mobile/ui/primitives";
import { Notice } from "@mobile/ui/Notice";
import { TextField } from "@mobile/ui/TextField";
import { useTheme } from "@mobile/ui/theme";

/**
 * A new cloud workspace (25.05 rows 1 to 3): a name, then what the chosen
 * provider's setup answer offers, already at its defaults, the repository and
 * the agent logins. Review price has the server check the repository and the
 * logins and quote the price in one go; the review and the spend confirmation
 * are the next page's. Every value here is one the server answered.
 */
export default function LaunchScreen() {
  const { orgId = "" } = useLocalSearchParams<{ orgId?: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const api = useCloudApi();
  const organizations = useCatalogSnapshot(useCloudCatalog()).organizations;
  const organizationName = organizations.find((entry) => entry.organization.orgId === orgId)?.organization.name ?? "";

  // One flow for as long as this page is open; the repository page and the review read it.
  const flow = useMemo(() => (api && orgId ? new LaunchFlow({ api, orgId, newKey: () => Crypto.randomUUID() }) : null), [api, orgId]);
  useEffect(() => (flow ? holdLaunch(flow) : undefined), [flow]);
  const { draft, check } = useLaunchSnapshot(flow);

  const providers = useRead((client) => client.providers(orgId), [orgId]);
  const logins = useRead((client) => readLogins(client, orgId), [orgId], { refreshOnFocus: true });
  const launchable = useMemo(() => launchableProviders(providers.value ?? []), [providers.value]);
  const provider = launchable.find((entry) => entry.id === draft.providerId) ?? null;
  const providerId = provider?.id ?? null;
  const setup = useRead((client) => (providerId ? client.providerSetup(orgId, providerId) : Promise.resolve(null)), [orgId, providerId]);
  const offered = setup.value && setup.value.provider === providerId ? setup.value : null;
  const agents = useMemo(() => agentLogins(logins.value ?? []), [logins.value]);

  // The server's first launchable provider, until another is picked.
  useEffect(() => {
    if (!flow || providers.state !== "read") return;
    if (!launchable.some((entry) => entry.id === flow.getSnapshot().draft.providerId)) flow.edit({ providerId: launchable[0]?.id ?? null, selection: null });
  }, [flow, providers.state, launchable]);
  // The provider's defaults, as soon as its setup answer is read.
  useEffect(() => {
    if (flow && offered && flow.getSnapshot().draft.selection === null) flow.edit({ selection: defaultSelection(offered) });
  }, [flow, offered]);
  // The first agent login is ticked to begin with; after that only the person changes it.
  const ticked = useRef(false);
  useEffect(() => {
    if (!flow || ticked.current || logins.state !== "read") return;
    ticked.current = true;
    if (agents[0]) flow.edit({ agents: [agents[0].id] });
  }, [flow, logins.state, agents]);
  // Logins read again (back from Agent logins): what failed because of one may be fixed now.
  useEffect(() => { if (flow && logins.value) flow.loginsRead(logins.value); }, [flow, logins.value]);

  const [sheet, setSheet] = useState<"provider" | "size" | "region" | "idle" | null>(null);
  const header = <>
    <Stack.Screen options={{ title: "New workspace", headerLargeTitle: false, headerShown: false }} />
    <LaunchHeader title="New workspace" subtitle={organizationName} onBack={() => router.back()} />
  </>;

  const tryAgain = () => {
    if (providers.state === "could-not-be-read") void providers.refresh();
    if (logins.state === "could-not-be-read") void logins.refresh();
    if (setup.state === "could-not-be-read") void setup.refresh();
  };
  const reading = (detail: string) => <>{header}<EmptyState title="Reading sizes and prices…" detail={detail} busy /></>;
  const blockedPage = (page: BlockedPage) => <>{header}<Blocked page={page} organizationName={organizationName} onConnect={() => router.push(`/cloud/compute?orgId=${encodeURIComponent(orgId)}`)} onTryAgain={tryAgain} /></>;

  if (!api || !flow) return blockedPage({ kind: "unreadable", detail: refusalText("signed-out") });
  if (providers.state === "could-not-be-read") return blockedPage(readFailure(providers.error));
  if (providers.state === "reading") return reading("");
  const nothing = nothingToLaunchOn(providers.value);
  if (nothing) return blockedPage(nothing);
  if (setup.state === "could-not-be-read" && !offered) return blockedPage(readFailure(setup.error));
  if (logins.state === "could-not-be-read" && !logins.value) return blockedPage(readFailure(logins.error));
  const from = provider ? `From ${provider.descriptor.label}, for ${organizationName}.` : "";
  if (!provider || !offered || !draft.selection || logins.state === "reading") return reading(from);

  const selection = draft.selection;
  const machine = offered.machineClasses.find((entry) => entry.id === selection.machineClassId);
  const location = offered.locations.find((entry) => entry.id === selection.locationId);
  const idle = idleChoices(offered);
  const checking = check.state === "checking";
  const problems = check.state === "problems" ? check.problems : [];
  const repositoryMarked = problems.some((problem) => problem.field?.kind === "repository");
  const loginMarked = (id: string, kind: string) => problems.some((problem) => problem.field?.kind === "login" && (problem.field.credentialId === id || (problem.field.credentialId === null && problem.field.provider === kind)));
  const choose = (patch: Partial<typeof selection>) => { flow.edit({ selection: { ...selection, ...patch } }); setSheet(null); };
  const toggle = (id: string) => flow.edit({ agents: draft.agents.includes(id) ? draft.agents.filter((each) => each !== id) : [...draft.agents, id] });
  const review = async () => {
    if (await flow.price({ provider, setup: offered, credentials: logins.value ?? [], organizationName })) router.push(`/cloud/launch/review?orgId=${encodeURIComponent(orgId)}`);
  };

  return <>
    {header}
    <LaunchPage foot={<Button testID="launch-review-price" label={checking ? "Checking and pricing…" : "Review price"} disabled={checking || !flow.canPrice()} accessibilityState={{ disabled: checking || !flow.canPrice(), busy: checking }}
      icon={checking ? (color) => <ActivityIndicator size="small" color={color} /> : undefined} onPress={() => void review()} />}>
      {problems.length ? <Notice testID="launch-problems" tone="danger" title={problemsTitle(problems.length)} items={problems.map((problem) => problem.text)} /> : null}
      {check.state === "refused" ? <Notice testID="launch-refused" tone="danger" text={refusalText(check.error)} /> : null}
      <TextField label="Name" value={draft.name} onChangeText={(name) => flow.edit({ name })} disabled={checking} steady={checking} autoCapitalize="sentences" returnKeyType="done" testID="launch-name" />
      <View style={styles.section}><SectionTitle>Machine</SectionTitle></View>
      <Card>
        {launchable.length > 1 ? <SettingRow testID="launch-provider" label="Provider" value={provider.descriptor.label} disabled={checking} onPress={() => setSheet("provider")} /> : null}
        <SettingRow testID="launch-size" divided={launchable.length > 1} label="Size" value={machine ? sizeValue(machine, offered.currency) : ""} disabled={checking} onPress={() => setSheet("size")} />
        <SettingRow testID="launch-region" divided label="Region" value={location?.label ?? ""} disabled={checking} onPress={offered.locations.length > 1 ? () => setSheet("region") : undefined} />
        {idle.length ? <SettingRow testID="launch-idle" divided label="Stop when idle" value={idleValue(selection.idleSuspendMinutes)} disabled={checking} onPress={() => setSheet("idle")} /> : null}
      </Card>
      <View style={styles.section}><SectionTitle>Repository and agents</SectionTitle></View>
      <Card>
        <SettingRow testID="launch-repository" label="Repository" value={draft.repository ? repositoryShown(draft.repository.url) : ""} marked={repositoryMarked} disabled={checking}
          onPress={() => router.push(`/cloud/launch/repository?orgId=${encodeURIComponent(orgId)}`)} />
        {agents.map((login) => <LoginRow key={login.id} testID={`launch-login-${login.provider}`} divided name={loginName(login.provider)} detail={loginDetail(login)} chosen={draft.agents.includes(login.id)} marked={loginMarked(login.id, login.provider)} disabled={checking} onPress={() => toggle(login.id)} />)}
      </Card>
      <Text style={[styles.open, { color: palette.muted }]}>{OPEN_TO_ORGANIZATION}</Text>
    </LaunchPage>
    {sheet === "provider" ? <ChoiceSheet testID="launch-provider-sheet" title="Provider" chosen={provider.id} onClose={() => setSheet(null)}
      choices={launchable.map((entry) => ({ key: entry.id, label: entry.descriptor.label, detail: entry.descriptor.billing || undefined }))}
      onChoose={(id) => { if (id !== provider.id) flow.edit({ providerId: id, selection: null }); setSheet(null); }} /> : null}
    {sheet === "size" ? <ChoiceSheet testID="launch-size-sheet" title="Size" note={sizeSheetNote(provider.descriptor.label, offered.currency)} chosen={selection.machineClassId} onClose={() => setSheet(null)}
      choices={offered.machineClasses.map((entry) => ({ key: entry.id, label: entry.label, detail: machineDetail(entry), price: entry.activeHourlyMicros === undefined ? undefined : { amount: priceText(entry.activeHourlyMicros, offered.currency), per: "per active hour" } }))}
      onChoose={(machineClassId) => choose({ machineClassId })} /> : null}
    {sheet === "region" ? <ChoiceSheet testID="launch-region-sheet" title="Region" chosen={selection.locationId} onClose={() => setSheet(null)}
      choices={offered.locations.map((entry) => ({ key: entry.id, label: entry.label }))} onChoose={(locationId) => choose({ locationId })} /> : null}
    {sheet === "idle" ? <ChoiceSheet testID="launch-idle-sheet" title="Stop when idle" footer={IDLE_NOTE} chosen={String(selection.idleSuspendMinutes)} onClose={() => setSheet(null)}
      choices={idle.map((minutes) => ({ key: String(minutes), label: idleChoice(minutes) }))} onChoose={(minutes) => choose({ idleSuspendMinutes: Number(minutes) })} /> : null}
  </>;
}

/** Before there is anything to set up: no compute, launching paused, or what the provider offers could not be read. */
function Blocked({ page, organizationName, onConnect, onTryAgain }: { page: BlockedPage; organizationName: string; onConnect(): void; onTryAgain(): void }) {
  if (page.kind === "connect") return <View style={styles.blocked}>
    <EmptyState icon={(color) => <ServerOff size={34} color={color} strokeWidth={1.6} />} title="Connect compute first" detail={`${organizationName} has no provider to launch on yet.`} />
    <View style={styles.action}><Button testID="launch-connect-compute" label="Connect compute" onPress={onConnect} /></View>
  </View>;
  if (page.kind === "paused") return <View style={styles.blocked}>
    <EmptyState icon={(color) => <CirclePause size={34} color={color} strokeWidth={1.6} />} title="New workspaces are paused" detail="New cloud workspaces are paused for this organization." />
  </View>;
  return <View style={styles.blocked}>
    <EmptyState icon={(color) => <CloudOff size={34} color={color} strokeWidth={1.6} />} title="Sizes and prices could not be read" detail={page.detail} />
    <View style={styles.action}><Button testID="launch-try-again" label="Try again" kind="secondary" onPress={onTryAgain} /></View>
  </View>;
}

const styles = StyleSheet.create({
  section: { marginTop: 12 },
  open: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  blocked: { flex: 1 },
  action: { paddingHorizontal: 24 },
});
