import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { Check, ChevronRight, CirclePause, CloudOff, ServerOff, WifiOff } from "lucide-react-native";
import { CloudApiError, type CloudApi, type CloudCredential, type CloudFirstRunSetup, type CloudLaunch, type CloudOrganization, type CloudProvider, type CloudProviderSetup, type CloudQuote } from "@mobile/cloud/api";
import { BYPASS_NOT_FROM_PHONE, PHONE_DEFAULT_MODE, phoneModeLabel, phoneModes } from "@mobile/cloud/agent-settings";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { EMPTY_FIRST_TASK, FIRST_TASK_PLACEHOLDER, FIRST_TASK_TOO_LONG, NO_AGENT_TICKED, keptTaskKey, launchOf, taskAgent, taskAgents, taskFacts, taskTooLong, taskWritten, type FirstTaskDraft } from "@mobile/cloud/first-task";
import { EMPTY_FIRST_TASK_CHECKED_LIVE } from "@mobile/cloud/live-checks";
import { ACCESS_NOTICE, LaunchAttempt, QUOTE_EXPIRED, REPOSITORY_INVALID, SPEND_NOTICE, agentLogins, credentialName, firstRunSetup, idleChoiceLabel, idleChoices, idleValue, launchProviders, launchRefusal, loginDetail, preflightProblems, pricingNote, problemsTitle, providerLabel, quotedSize, repositoryOf, sizeDetail, sizeValue, unanswered, type LaunchRefusal, type PreflightProblems } from "@mobile/cloud/launch";
import { ChoiceSheet, type Choice } from "@mobile/ui/ChoiceSheet";
import { FactRows } from "@mobile/ui/FactRows";
import { Notice } from "@mobile/ui/Notice";
import { AgentSettingsRows, PickRow } from "@mobile/ui/PickRow";
import { PriceLines, priceText } from "@mobile/ui/PriceLines";
import { Button, Card, EmptyState, SectionTitle } from "@mobile/ui/primitives";
import { ScreenHeader } from "@mobile/ui/SessionChrome";
import { TextField } from "@mobile/ui/TextField";
import { useTheme } from "@mobile/ui/theme";
import { keepConversationState, takeConversationState } from "@mobile/state/conversation-state";

/** The longest name the server takes for a workspace. */
const NAME_MAX = 80;

/**
 * Launch a cloud workspace (25.05): one form, one review with the price, one
 * confirmation that it spends money, then the workspace's own page, which
 * shows the launch until it runs. Every choice on the form is what the
 * server's setup answer offers for the chosen provider, and the price is the
 * server's quote. Nothing is created before the confirmation's Launch.
 */
export default function NewWorkspaceScreen() {
  // `from`: a canceled launch whose unsent first task the form opens with (Launch again).
  const params = useLocalSearchParams<{ orgId?: string; from?: string }>();
  const { palette } = useTheme();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const organizations = useMemo(() => snapshot.organizations.map((entry) => entry.organization), [snapshot.organizations]);
  const [chosen, setChosen] = useState<string | null>(params.orgId ?? null);
  // Opened for one organization, it launches there; otherwise in the first, until another is picked on the form.
  const organization = organizations.find((entry) => entry.orgId === chosen) ?? (chosen === null ? organizations[0] : undefined) ?? null;
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: "New workspace", headerShown: false }} />
    {catalog && organization
      ? <LaunchFlow key={organization.orgId} catalog={catalog} organization={organization} organizations={organizations} onOrganization={setChosen} again={params.orgId === organization.orgId ? params.from ?? null : null} />
      : <>
        <ScreenHeader title="New workspace" onBack={() => router.back()} />
        {catalog
          ? <EmptyState title={snapshot.refreshedAt || snapshot.error ? "No organization to launch in" : "Reading your organizations…"} detail={snapshot.refreshedAt || snapshot.error ? "Cloud workspaces belong to an organization of your account." : "From your TerminalX account."} busy={!snapshot.refreshedAt && !snapshot.error} />
          : <EmptyState title="Sign in to launch a workspace" detail="Cloud workspaces belong to your TerminalX account." />}
      </>}
  </View>;
}

type Offer =
  | { status: "reading" }
  | { status: "closed"; kind: "not-connected" | "paused" | "unavailable" | "unreachable"; text: string }
  /** `loginsRead`: false for a member, whom the server does not show the organization's logins. */
  | { status: "open"; providers: CloudProvider[]; credentials: CloudCredential[]; loginsRead: boolean };

interface Draft {
  name: string;
  providerId: string | null;
  sizeId: string;
  locationId: string;
  sourceId: string;
  idleMinutes: number;
  repository: string;
  ref: string;
  /** Agent logins the person unticked; every other working one is given to the workspace. */
  withoutAgents: string[];
  /** The first task (25.09): which ticked agent starts, in which mode, and what it is told. */
  task: FirstTaskDraft;
}

/** What a price was asked for and is launched with: fixed when the quote comes back. */
interface Priced {
  name: string;
  quote: CloudQuote;
  setup: CloudFirstRunSetup | undefined;
  repository: string | null;
  agents: string[];
  provider: CloudProvider;
  /** The first task, as it is sent; none when no agent is ticked or the person cannot choose logins. */
  launch: CloudLaunch | undefined;
}

type Sheet = "organization" | "provider" | "size" | "region" | "image" | "idle" | "agent" | "mode" | null;

const NO_TASK: FirstTaskDraft = { agent: null, mode: PHONE_DEFAULT_MODE, text: "" };

function LaunchFlow({ catalog, organization, organizations, onOrganization, again }: { catalog: CloudCatalog; organization: CloudOrganization; organizations: CloudOrganization[]; onOrganization(orgId: string): void; again: string | null }) {
  const { palette } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const api: CloudApi = catalog.api;
  const orgId = organization.orgId;

  const [offer, setOffer] = useState<Offer>({ status: "reading" });
  const [setup, setSetup] = useState<CloudProviderSetup | null>(null);
  // Launch again after a cancel opens with the first task that was not sent, taken from where the launch kept it.
  const [draft, setDraft] = useState<Draft>(() => ({ name: "", providerId: null, sizeId: "", locationId: "", sourceId: "", idleMinutes: 0, repository: "", ref: "", withoutAgents: [], task: (again ? takeConversationState<FirstTaskDraft>(keptTaskKey(orgId, again)) : undefined) ?? NO_TASK }));
  const [step, setStep] = useState<"form" | "repository" | "review">("form");
  const [sheet, setChosenSheet] = useState<Sheet>(null);
  // The task is the form's last field: while it is typed in, the form keeps its end in view, above the keyboard
  // the page shrinks for and as the field grows.
  const scroller = useRef<ScrollViewInstance>(null);
  const typing = useRef(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => { if (typing.current) scroller.current?.scrollToEnd({ animated: true }); });
    return () => shown.remove();
  }, []);
  // A sheet opened while the name or the task is being typed would open under the keyboard.
  const setSheet = (next: Sheet) => { if (next) Keyboard.dismiss(); setChosenSheet(next); };
  const [busy, setBusy] = useState<"pricing" | "launching" | "checking" | null>(null);
  const [problems, setProblems] = useState<PreflightProblems | null>(null);
  const [formRefusal, setFormRefusal] = useState<LaunchRefusal | null>(null);
  const [priced, setPriced] = useState<Priced | null>(null);
  /** The hourly rate of the quote before this one, when a new price was asked for the same choice. */
  const [priceBefore, setPriceBefore] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [refusal, setRefusal] = useState<LaunchRefusal | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  const [reads, setReads] = useState(0);
  const attempt = useRef<LaunchAttempt | null>(null);
  attempt.current ??= new LaunchAttempt(api, () => Crypto.randomUUID());
  // One request at a time, also between a tap and the render that disables the button.
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const closed = useCallback((error: unknown): Offer => {
    const said = launchRefusal(error);
    if (said.fix === "compute") return { status: "closed", kind: "not-connected", text: said.text };
    const kind = error instanceof CloudApiError ? error.refusal : null;
    if (said.closed) return { status: "closed", kind: kind === "provisioning-paused" || kind === "provider-not-offered" ? "paused" : "unavailable", text: said.text };
    return { status: "closed", kind: "unreachable", text: unanswered(error) ? "The service could not be reached. Nothing was launched." : said.text };
  }, []);

  // What can be launched on, and the logins a workspace can be given: read when the page opens and when it is come back to.
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const providers = await api.providers(orgId);
        const { choices, blocked } = launchProviders(providers);
        // The logins are for owners and admins to read; a member launches without choosing any.
        const credentials = await api.credentials(orgId).catch((error: unknown) => { if (error instanceof CloudApiError && error.refusal === "admin-required") return null; throw error; });
        if (!current) return;
        if (blocked) return setOffer({ status: "closed", kind: blocked, text: blocked === "paused" ? "New cloud workspaces are paused for this organization." : `${organization.name} has no provider to launch on yet.` });
        setOffer({ status: "open", providers: choices, credentials: credentials ?? [], loginsRead: credentials !== null });
        setDraft((held) => (held.providerId && choices.some((provider) => provider.id === held.providerId) ? held : { ...held, providerId: choices[0]!.id }));
      } catch (error) {
        if (current) setOffer((held) => (held.status === "open" ? held : closed(error)));
      }
    })();
    return () => { current = false; };
  }, [api, orgId, organization.name, reads, closed]);

  // Back from Agent logins or Compute: what was wrong may be fixed, so it is read again and asked again.
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!focused.current) { focused.current = true; return; }
    setProblems(null);
    setFormRefusal(null);
    setRefusal(null);
    setReads((count) => count + 1);
  }, []));

  // What the chosen provider offers right now; its defaults are the form's until the person picks.
  const providerId = draft.providerId;
  useEffect(() => {
    if (!providerId || offer.status !== "open") return;
    let current = true;
    setSetup(null);
    api.providerSetup(orgId, providerId).then((read) => {
      if (!current) return;
      setSetup(read);
      setDraft((held) => ({
        ...held,
        sizeId: read.machineClasses.some((size) => size.id === held.sizeId) ? held.sizeId : read.defaults.machineClassId,
        locationId: read.locations.some((place) => place.id === held.locationId) ? held.locationId : read.defaults.locationId,
        sourceId: read.sources.some((source) => source.id === held.sourceId) ? held.sourceId : read.defaults.sourceId,
        // No size yet means nothing was chosen yet: the provider's default idle time, not the draft's blank.
        idleMinutes: held.sizeId && idleChoices(read).includes(held.idleMinutes) ? held.idleMinutes : read.defaults.idleSuspendMinutes,
      }));
    }, (error: unknown) => { if (current) setOffer(closed(error)); });
    return () => { current = false; };
    // `offer.status`, not the offer: reading the logins again does not ask the provider again.
  }, [api, orgId, providerId, offer.status, closed]);

  const change = (patch: Partial<Draft>) => {
    setDraft((held) => ({ ...held, ...patch }));
    setProblems(null);
    setFormRefusal(null);
  };
  const changeTask = (patch: Partial<FirstTaskDraft>) => setDraft((held) => ({ ...held, task: { ...held.task, ...patch } }));

  const toOrganization = () => router.push({ pathname: "/organization/[orgId]", params: { orgId } });
  const header = (title: string, onBack: () => void) => <ScreenHeader title={title} subtitle={organization.name} onBack={onBack} />;

  if (offer.status !== "open" || !setup) {
    const provider = offer.status === "open" ? offer.providers.find((entry) => entry.id === providerId) : null;
    return <>
      {header("New workspace", () => router.back())}
      {offer.status === "closed" ? <View testID={`launch-${offer.kind}`}>
        <EmptyState
          title={offer.kind === "not-connected" ? "Connect compute first" : offer.kind === "paused" ? "New workspaces are paused" : offer.kind === "unavailable" ? "Not available yet" : "Sizes and prices could not be read"}
          detail={offer.text}
          icon={(color) => offer.kind === "not-connected" ? <ServerOff size={34} color={color} strokeWidth={1.6} /> : offer.kind === "unreachable" ? <CloudOff size={34} color={color} strokeWidth={1.6} /> : <CirclePause size={34} color={color} strokeWidth={1.6} />} />
        <View style={styles.stateAction}>
          {offer.kind === "not-connected" ? <Button label="Connect compute" onPress={toOrganization} /> : null}
          {offer.kind === "unreachable" ? <Button label="Try again" kind="secondary" onPress={() => { setOffer({ status: "reading" }); setReads((count) => count + 1); }} /> : null}
        </View>
      </View> : <EmptyState busy title="Reading sizes and prices…" detail={provider ? `From ${providerLabel(provider)}, for ${organization.name}.` : `For ${organization.name}.`} />}
    </>;
  }

  const provider = offer.providers.find((entry) => entry.id === providerId) ?? offer.providers[0]!;
  const providerName = providerLabel(provider);
  const size = setup.machineClasses.find((entry) => entry.id === draft.sizeId) ?? null;
  const place = setup.locations.find((entry) => entry.id === draft.locationId) ?? null;
  const source = setup.sources.find((entry) => entry.id === draft.sourceId) ?? null;
  const logins = agentLogins(offer.credentials);
  const ticked = logins.filter((login) => !draft.withoutAgents.includes(login.id));
  // The first task starts one of the ticked agents. A member, who cannot see the logins, launches without one,
  // and so does an organization with no working login: there is nothing to start.
  const agents = taskAgents(ticked);
  const firstTask = offer.loginsRead && logins.length > 0;
  const agent = firstTask ? taskAgent(draft.task.agent, agents) : null;
  const tooLong = firstTask && taskTooLong(draft.task.text);
  const typedRepository = draft.repository.trim();
  const repository = typedRepository ? repositoryOf(typedRepository) : null;
  const hourly = (micros: number | undefined) => (micros == null ? null : priceText(micros, setup.currency));

  /** Check the setup, then ask for the price: the review opens on the quote. */
  const price = async () => {
    // A launch that got no answer may be running: nothing is priced, and so nothing launched anew, until that is known.
    if (inFlight.current || noAnswer) return;
    const name = draft.name.trim();
    if (!name || !size || !place || !source || tooLong) return;
    if (typedRepository && !repository) return setProblems({ items: [REPOSITORY_INVALID], repository: REPOSITORY_INVALID, ref: null, needsGithubToken: false });
    const first = firstRunSetup({ repository, ref: draft.ref, agentIds: ticked.map((login) => login.id) }, offer.credentials);
    inFlight.current = true;
    setBusy("pricing");
    setProblems(null);
    setFormRefusal(null);
    setRefusal(null);
    setNoAnswer(false);
    try {
      if (first) {
        const found = preflightProblems(await api.preflight(orgId, first), { repository }, offer.credentials);
        if (found) { if (alive.current) { setProblems(found); setStep("form"); } return; }
      }
      const quote = await api.quote(orgId, { provider: provider.id, sourceId: source.id, locationId: place.id, machineClassId: size.id, idleSuspendMinutes: draft.idleMinutes, retentionDays: setup.defaults.retentionDays, networkPolicy: setup.defaults.networkPolicy });
      if (!alive.current) return;
      // A new price for what was already under review: said when it is not the same.
      const before = step === "review" && priced && priced.name === name && priced.quote.configuration.machineClassId === quote.configuration.machineClassId && priced.quote.provider === quote.provider ? priced.quote.activeHourlyMicros : null;
      setPriceBefore(before !== null && before !== quote.activeHourlyMicros ? before : null);
      setPriced({ name, quote, setup: first, repository: repository ? [repository.fullName, draft.ref.trim()].filter(Boolean).join(" · ") : null, agents: ticked.map((login) => credentialName(login.provider)), provider, launch: firstTask ? launchOf(draft.task, agents) : undefined });
      setExpired(false);
      setStep("review");
    } catch (error) {
      if (!alive.current) return;
      const said = launchRefusal(error, providerName);
      if (said.closed) setOffer(closed(error));
      else if (step === "review") setRefusal(said);
      else setFormRefusal(said);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  /** The person said yes to the spend: launch what was priced, once. */
  const launch = async () => {
    // An expired price is never launched. Asking again about a launch already sent is not launching: it goes
    // out under the same key, and the server answers a key it knows before it looks at the quote.
    if (inFlight.current || !priced || (expired && !noAnswer)) return;
    const asked = noAnswer;
    inFlight.current = true;
    setBusy(asked ? "checking" : "launching");
    setRefusal(null);
    try {
      const answer = await attempt.current!.launch(orgId, { name: priced.name, quoteId: priced.quote.id, ...(priced.setup ? { setup: priced.setup } : {}), ...(priced.launch ? { launch: priced.launch } : {}) }, () => { if (alive.current) { setBusy("checking"); setNoAnswer(true); } });
      catalog.adopt(orgId, answer);
      // Kept on the phone until the agent has it: a canceled launch puts it back in the form.
      if (priced.launch) keepConversationState(keptTaskKey(orgId, answer.workspace.id), { ...draft.task, agent: priced.launch.agent });
      // The workspace exists from here: its own page shows the launch until it runs.
      router.replace({ pathname: "/cloud/[workspaceId]", params: { workspaceId: answer.workspace.id, orgId, operationId: answer.operation.id, title: answer.workspace.name } });
    } catch (error) {
      if (!alive.current) return;
      // No answer, or on asking again an answer that says nothing of the first request (too many requests, a
      // server error): whether the launch started is still not known, and the same key stays the only way on.
      if (unanswered(error) || (asked && error instanceof CloudApiError && (error.status === 429 || (error.status ?? 0) >= 500))) return setNoAnswer(true);
      // The server answered this key with a refusal: it holds no launch under it.
      setNoAnswer(false);
      const said = launchRefusal(error, providerName);
      // An old price is never launched: the server said so, and a new one is asked for.
      if (said.fix === "new-price") setExpired(true);
      else if (said.closed) setOffer(closed(error));
      else setRefusal(said);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const confirmSpend = () => Alert.alert("Launch and start spending?", SPEND_NOTICE, [
    { text: "Cancel", style: "cancel" },
    { text: "Launch", onPress: () => void launch() },
  ]);

  const page = (title: string, onBack: () => void, body: ReactNode, foot: ReactNode) => <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    {header(title, onBack)}
    <ScrollView ref={scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
      onContentSizeChange={() => { if (typing.current) scroller.current?.scrollToEnd({ animated: false }); }}>{body}</ScrollView>
    <View style={[styles.foot, { paddingBottom: insets.bottom + 12 }]}>{foot}</View>
  </KeyboardAvoidingView>;

  if (step === "repository") {
    return <RepositoryStep organization={organization.name} repository={draft.repository} gitRef={draft.ref} problems={problems} page={page}
      onUse={(next, ref) => { change({ repository: next, ref }); setStep("form"); }}
      onNone={() => { change({ repository: "", ref: "" }); setStep("form"); }}
      onBack={() => setStep("form")} onToken={toOrganization} />;
  }

  if (step === "review" && priced) {
    const { quote } = priced;
    const launching = busy === "launching" || busy === "checking";
    // While a launch may have started, this page is not left for the form: a new price there would be a second launch.
    return page("Review", () => { if (!launching && !noAnswer) setStep("form"); }, <>
      <FactRows testID="review-facts" facts={[
        { label: "Name", value: priced.name },
        { label: "Provider", value: providerLabel(priced.provider) },
        { label: "Size", value: quotedSize(quote.configuration) },
        { label: "Region", value: quote.configuration.locationLabel },
        { label: "Stops when idle", value: idleValue(quote.configuration.idleSuspendMinutes) },
        { label: "Repository", value: priced.repository ?? "None" },
        { label: "Agents", value: priced.agents.length ? priced.agents.join(", ") : "None" },
      ]} />
      {priced.launch ? <>
        <SectionTitle>First task</SectionTitle>
        <FactRows testID="review-task" facts={taskFacts(priced.launch)} />
        {!priced.launch.prompt && EMPTY_FIRST_TASK_CHECKED_LIVE ? <Text testID="review-empty-task" style={[styles.help, { color: palette.muted }]}>{EMPTY_FIRST_TASK}</Text> : null}
      </> : null}
      <SectionTitle>Price</SectionTitle>
      <PriceLines testID="review-price" quote={quote} now={api.serverNow} note={pricingNote(priced.provider, quote.pricing)} onExpired={() => setExpired(true)} />
      {noAnswer ? null : expired ? <Notice testID="price-expired" tone="warning" text={QUOTE_EXPIRED} />
        : priceBefore !== null ? <Notice testID="price-changed" tone="warning" text={`The price changed since you last looked: it was ${priceText(priceBefore, quote.currency)} per active hour.`} /> : null}
      {refusal ? <Notice testID="launch-refusal" tone="danger" text={refusal.text} action={refusal.fix === "compute" ? { label: "Connect compute", onPress: toOrganization } : undefined} /> : null}
      {noAnswer ? <Notice testID="launch-unanswered" tone="warning" icon={(color) => <WifiOff size={16} color={color} />} text="No answer came back. Checking whether the launch started; nothing is launched twice." /> : null}
    </>, noAnswer && !launching
      // The same launch, asked again under the same key: the person already said yes to this price. It stays
      // the only way on until the server answers, also once the price has run out.
      ? <Button testID="launch" label="Check again" disabled={busy !== null} onPress={() => void launch()} />
      : expired && !launching
      ? <Button testID="new-price" label={busy === "pricing" ? "Pricing…" : "Get a new price"} disabled={busy !== null} accessibilityState={{ disabled: busy !== null, busy: busy === "pricing" }} onPress={() => void price()} />
      : <Button testID="launch" label={busy === "checking" ? "Checking whether it started…" : busy === "launching" ? "Launching…" : "Launch workspace"} disabled={busy !== null} accessibilityState={{ disabled: busy !== null, busy: launching }} onPress={confirmSpend} />);
  }

  const sheets: Record<Exclude<Sheet, null>, { title: string; subtitle?: string; help?: string; chosen: string | null; choices: Choice[]; choose(id: string): void }> = {
    organization: { title: "Organization", chosen: orgId, choices: organizations.map((entry) => ({ id: entry.orgId, label: entry.name })), choose: onOrganization },
    provider: { title: "Provider", chosen: provider.id, choices: offer.providers.map((entry) => ({ id: entry.id, label: providerLabel(entry), detail: entry.descriptor.billing || undefined })), choose: (id) => change({ providerId: id }) },
    size: { title: "Size", subtitle: `${providerName} · ${setup.pricing === "provider-rate" ? "Prices come from the provider's live rates." : "Prices shown are estimates."}`, chosen: draft.sizeId, choices: setup.machineClasses.map((entry) => ({ id: entry.id, label: entry.label, detail: sizeDetail(entry), ...(hourly(entry.activeHourlyMicros) ? { value: hourly(entry.activeHourlyMicros)!, valueDetail: "per active hour" } : {}) })), choose: (id) => change({ sizeId: id }) },
    region: { title: "Region", subtitle: providerName, chosen: draft.locationId, choices: setup.locations.map((entry) => ({ id: entry.id, label: entry.label })), choose: (id) => change({ locationId: id }) },
    image: { title: "Image", subtitle: providerName, chosen: draft.sourceId, choices: setup.sources.map((entry) => ({ id: entry.id, label: entry.label, detail: entry.description })), choose: (id) => change({ sourceId: id }) },
    idle: { title: "Stop when idle", chosen: String(draft.idleMinutes), help: "A stopped workspace starts again when you send it a message.", choices: idleChoices(setup).map((minutes) => ({ id: String(minutes), label: idleChoiceLabel(minutes) })), choose: (id) => change({ idleMinutes: Number(id) }) },
    agent: { title: "Agent", subtitle: "The agents ticked for this workspace", chosen: agent?.id ?? null, choices: agents.map((entry) => ({ id: entry.id, label: entry.label, detail: entry.detail })), choose: (id) => { changeTask({ agent: id }); setProblems(null); } },
    mode: { title: "Permission mode", help: BYPASS_NOT_FROM_PHONE, chosen: draft.task.mode, choices: phoneModes().map((mode) => ({ id: mode.id, label: mode.label, detail: mode.hint })), choose: (id) => changeTask({ mode: phoneModes().find((mode) => mode.id === id)?.id ?? PHONE_DEFAULT_MODE }) },
  };
  const open = sheet ? sheets[sheet] : null;
  const ready = !!draft.name.trim() && !!size && !!place && !!source && !tooLong;

  return <>
    {page("New workspace", () => router.back(), <>
      {problems ? <Notice testID="preflight-problems" tone="danger" title={problemsTitle(problems.items.length)} items={problems.items} /> : null}
      {formRefusal ? <Notice testID="form-refusal" tone="danger" text={formRefusal.text} action={formRefusal.fix === "compute" ? { label: "Connect compute", onPress: toOrganization } : undefined} /> : null}
      <TextField testID="workspace-name" label="Name" value={draft.name} onChangeText={(name) => change({ name })} placeholder="What it is for" maxLength={NAME_MAX} autoFocus={!draft.name} disabled={busy !== null} returnKeyType="done" />
      <SectionTitle>Machine</SectionTitle>
      <Card>
        {organizations.length > 1 ? <PickRow label="Organization" value={organization.name} onPress={() => setSheet("organization")} first /> : null}
        {/* Provider shows only when more than one can launch. */}
        {offer.providers.length > 1 ? <PickRow label="Provider" value={providerName} onPress={() => setSheet("provider")} first={organizations.length <= 1} /> : null}
        <PickRow label="Size" value={size ? sizeValue(size, hourly(size.activeHourlyMicros)) : "Choose"} onPress={() => setSheet("size")} first={organizations.length <= 1 && offer.providers.length <= 1} />
        {/* A provider that places the machine itself has a region to state, not one to choose. */}
        {provider.descriptor.offering.locations === "automatic" || setup.locations.length < 2
          ? <PickRow label="Region" value={place?.label ?? "Automatic"} />
          : <PickRow label="Region" value={place?.label ?? "Choose"} onPress={() => setSheet("region")} />}
        {provider.descriptor.offering.sources === "required" && setup.sources.length > 1 ? <PickRow label="Image" value={source?.label ?? "Choose"} onPress={() => setSheet("image")} /> : null}
        <PickRow label="Stop when idle" value={idleValue(draft.idleMinutes)} onPress={() => setSheet("idle")} />
      </Card>
      <SectionTitle>Repository and agents</SectionTitle>
      <Card>
        <PickRow label="Repository" value={repository?.fullName ?? (typedRepository || "None")} bad={!!problems?.repository || !!problems?.ref} onPress={() => setStep("repository")} first />
        {logins.map((login) => {
          const on = !draft.withoutAgents.includes(login.id);
          return <Pressable key={login.id} testID={`agent-${login.provider}`} accessibilityRole="checkbox" accessibilityLabel={`${credentialName(login.provider)}, ${loginDetail(login)}`} accessibilityState={{ checked: on }}
            onPress={() => change({ withoutAgents: on ? [...draft.withoutAgents, login.id] : draft.withoutAgents.filter((id) => id !== login.id) })}
            style={({ pressed }) => [styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed ? { backgroundColor: palette.raised } : null]}>
            <View style={[styles.tick, on ? { backgroundColor: palette.accent } : { borderWidth: 1.5, borderColor: palette.faint }]}>{on ? <Check size={14} color={palette.accentInk} /> : null}</View>
            <Text style={[styles.rowLabel, styles.grow, { color: palette.ink }]}>{credentialName(login.provider)}</Text>
            <Text numberOfLines={1} style={[styles.agentDetail, { color: palette.muted }]}>{loginDetail(login)}</Text>
          </Pressable>;
        })}
      </Card>
      {firstTask ? <>
        <SectionTitle>First task</SectionTitle>
        {agent ? <>
          <AgentSettingsRows testID="first-task-rows" agent={agent.label} model={null} effort={null} mode={phoneModeLabel(draft.task.mode)} badAgent={!!problems?.agents?.includes(agent.id)}
            onAgent={() => setSheet("agent")} onMode={() => setSheet("mode")} />
          <TextField testID="first-task" accessibilityLabel="First task" multiline onFocus={() => { typing.current = true; }} onBlur={() => { typing.current = false; }} value={draft.task.text} onChangeText={(text) => changeTask({ text })} placeholder={FIRST_TASK_PLACEHOLDER} disabled={busy !== null}
            error={tooLong ? FIRST_TASK_TOO_LONG : null} helper={!taskWritten(draft.task.text) && EMPTY_FIRST_TASK_CHECKED_LIVE ? EMPTY_FIRST_TASK : undefined} />
        </> : <Notice testID="first-task-none" tone="info" text={NO_AGENT_TICKED} />}
      </> : null}
      <Text style={[styles.help, { color: palette.muted }]}>{ACCESS_NOTICE}</Text>
    </>, <Button testID="review-price" label={busy === "pricing" ? "Checking and pricing…" : "Review price"} disabled={!ready || busy !== null || !!problems} accessibilityState={{ disabled: !ready || busy !== null || !!problems, busy: busy === "pricing" }} onPress={() => void price()} />)}
    {open ? <ChoiceSheet title={open.title} subtitle={open.subtitle} help={open.help} choices={open.choices} chosen={open.chosen} onChoose={open.choose} onClose={() => setSheet(null)} /> : null}
  </>;
}

/** The repository's own page: one typed or pasted GitHub URL and an optional branch, with what the last check said of each. */
function RepositoryStep({ organization, repository, gitRef, problems, page, onUse, onNone, onBack, onToken }: {
  organization: string;
  repository: string;
  gitRef: string;
  problems: PreflightProblems | null;
  page(title: string, onBack: () => void, body: ReactNode, foot: ReactNode): ReactNode;
  onUse(repository: string, ref: string): void;
  onNone(): void;
  onBack(): void;
  onToken(): void;
}) {
  const { palette } = useTheme();
  const [url, setUrl] = useState(repository);
  const [ref, setRef] = useState(gitRef);
  const [invalid, setInvalid] = useState(false);
  // What the last check said is about what was checked: gone once it is edited.
  const unchanged = url === repository && ref === gitRef;
  const empty = !url.trim();
  const use = () => {
    if (!repositoryOf(url)) return setInvalid(true);
    onUse(url.trim(), ref.trim());
  };
  return page("Repository", onBack, <>
    <Text style={[styles.lede, { color: palette.muted }]}>Optional. The repository is cloned before the workspace becomes available.</Text>
    <TextField testID="repository-url" label="GitHub repository URL" value={url} onChangeText={(value) => { setUrl(value); setInvalid(false); }} placeholder="github.com/owner/repository" paste autoFocus={empty} autoCapitalize="none" autoCorrect={false} keyboardType="url"
      error={invalid ? REPOSITORY_INVALID : unchanged ? problems?.repository : null} />
    <TextField testID="repository-ref" label="Branch or tag" hint="optional" value={ref} onChangeText={setRef} placeholder="main" autoCapitalize="none" autoCorrect={false} error={unchanged ? problems?.ref : null} />
    {unchanged && problems?.needsGithubToken
      ? <Card><Pressable testID="add-github-token" accessibilityRole="button" accessibilityLabel={`Add a GitHub token, saved for ${organization}, in Agent logins`} onPress={onToken} style={({ pressed }) => [styles.row, styles.tokenRow, pressed ? { backgroundColor: palette.raised } : null]}>
        <View style={styles.grow}>
          <Text style={[styles.rowLabel, { color: palette.ink }]}>Add a GitHub token</Text>
          <Text style={[styles.tokenDetail, { color: palette.muted }]}>{`Saved for ${organization}, in Agent logins`}</Text>
        </View>
        <ChevronRight size={18} color={palette.faint} />
      </Pressable></Card>
      : <Text style={[styles.help, { color: palette.muted }]}>A private repository is cloned with the GitHub token saved in Agent logins.</Text>}
  </>, <>
    <Button testID="use-repository" label="Use this repository" disabled={empty} onPress={use} />
    {repository.trim() || !empty ? <Button testID="no-repository" label="Launch without a repository" kind="secondary" onPress={onNone} /> : null}
  </>);
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 12 },
  foot: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  stateAction: { paddingHorizontal: 24, gap: 8 },
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  rowLabel: { fontSize: 16, lineHeight: 21 },
  grow: { flex: 1, minWidth: 0 },
  tick: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  agentDetail: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  help: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  lede: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  tokenRow: { minHeight: 52 },
  tokenDetail: { fontSize: 13, lineHeight: 18 },
});
