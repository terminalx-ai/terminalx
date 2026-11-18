import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageSquareDashed, Play, Send, Square, Users } from "lucide-react-native";
import { interruptUnanswered } from "@terminalx/portable/events";
import { buildTranscript, type PendingAsk } from "@terminalx/portable/transcript";
import { leaseHeldBy, NOTE_MAX_CHARS } from "@terminalx/portable/workspaceCollab";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { workspaceTitle, type CloudCatalog } from "@mobile/cloud/catalog";
import type { CloudRole } from "@mobile/cloud/api";
import { accessText, attentionDetail, codeText, connectionLine, leaseLine, outboxLine, presenceLine, rolePhrase, whoCanStart } from "@mobile/cloud/words";
import type { CloudWorkspaceSession } from "@mobile/cloud/workspace";
import { useConversationState } from "@mobile/state/conversation-state";
import { useKeyboardShown } from "@mobile/ui/keyboard";
import { Button, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { GlassIconButton } from "@mobile/ui/glass";
import { HeaderLine, ScreenHeader } from "@mobile/ui/SessionChrome";
import { TranscriptList } from "@mobile/ui/TranscriptList";
import { useTheme } from "@mobile/ui/theme";
import { CompactingLine, PermissionCard, QuestionCard, TurnCard } from "@mobile/ui/transcript";
import { linkedText } from "@mobile/ui/LinkedText";

/**
 * One cloud workspace: its agent tabs and the conversation of the chosen one.
 * A running workspace is shown live. A stopped one is shown from its saved,
 * encrypted conversation, and opening this screen starts nothing: in place of
 * the composer it says so, with Start for someone who may start it (#988).
 * Under the title, one line says its state and the person's role.
 */
export default function CloudWorkspaceScreen() {
  const params = useLocalSearchParams<{ workspaceId: string; orgId?: string; tabId?: string; title?: string }>();
  const { palette } = useTheme();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const orgId = params.orgId ?? snapshot.organizations.find((entry) => entry.workspaces.some((item) => item.workspace.id === params.workspaceId))?.organization.orgId ?? null;
  // What the list says of this person's access decides whether anything is opened at all.
  const access = catalog && orgId ? catalog.access(orgId, params.workspaceId) : "unknown";
  // Leaving lets go of the connection; nothing keeps a phone attached unseen.
  useEffect(() => (catalog && orgId && access === "ok" ? catalog.retain(orgId, params.workspaceId) : undefined), [catalog, orgId, params.workspaceId, access]);
  // While in front, the list is read now and then, so a start or stop from elsewhere shows (#500); not under a screen pushed over this one.
  useFocusEffect(useCallback(() => catalog?.watch(), [catalog]));
  const session = catalog && orgId && access === "ok" ? catalog.opened(orgId, params.workspaceId) : null;

  const listed = catalog && orgId ? catalog.workspace(orgId, params.workspaceId) : null;
  // Just shared? The list this phone holds may be from before: read it once before saying no.
  const [checked, setChecked] = useState<string | null>(null);
  const key = `${orgId}/${params.workspaceId}`;
  useEffect(() => {
    if (!catalog || access !== "not-shared" || checked === key) return;
    let current = true;
    void catalog.refresh().then(() => { if (current) setChecked(key); });
    return () => { current = false; };
  }, [catalog, access, checked, key]);
  const checking = access === "not-shared" && checked !== key;
  const closed = !checking && (access === "not-shared" || access === "deleted" || access === "gone") ? accessText(access) : null;
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: (listed ? workspaceTitle(snapshot, listed) : null) ?? params.title ?? "Workspace" }} />
    {!catalog ? <EmptyState title="Workspace unavailable" detail="Sign in, then open it again from the Cloud tab." />
      // Access ended, also while this screen was open: the conversation goes at once, with the reason.
      : closed ? <EmptyState title={closed.title} detail={closed.detail} />
      : session && orgId ? <Workspace key={`${orgId}/${params.workspaceId}`} catalog={catalog} session={session} orgId={orgId} workspaceId={params.workspaceId} listedState={listed?.state ?? null} initialTabId={params.tabId ?? null} />
      : <EmptyState title="Checking access…" detail="Reading the list of workspaces from your account." busy />}
  </View>;
}

/** Names for user ids, re-read whenever one is learned. */
function useNames(catalog: CloudCatalog) {
  useSyncExternalStore(catalog.people.subscribe, catalog.people.getVersion, catalog.people.getVersion);
  return catalog.people.name;
}

/** The time now, read again when `at` passes (a lease's expiry), so what depends on it updates by itself. */
function useNowUntil(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

function Workspace({ catalog, session, orgId, workspaceId, listedState, initialTabId }: { catalog: CloudCatalog; session: CloudWorkspaceSession; orgId: string; workspaceId: string; listedState: string | null; initialTabId: string | null }) {
  const { palette } = useTheme();
  const router = useRouter();
  const nameOf = useNames(catalog);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [chosen, setChosen] = useState<string | null>(initialTabId);
  // The runtime's word, which can be ahead of the list (and stays so if the list cannot be read): with no
  // role nothing of the workspace is shown, not its agent tabs' titles and not who else is in it.
  const unshared = snapshot.role === "none";
  const tab = unshared ? null : (snapshot.tabs.find((entry) => entry.tabId === chosen) ?? snapshot.tabs[0] ?? null);
  const tabId = tab?.tabId ?? null;
  const live = snapshot.connection.state === "connected";
  const starting = listedState === "suspended" && snapshot.outbox.some((entry) => (entry.state === "queued" || entry.state === "leased") && (entry.wake === "queued" || entry.wake === "in-progress"));
  const listed = catalog.workspace(orgId, workspaceId);
  const listing = useCatalogSnapshot(catalog);
  // The runtime's word on the role, else the list's while nothing is running.
  const roleNow: CloudRole | null = snapshot.role ?? listed?.you?.role ?? null;
  const line = connectionLine(snapshot.connection, listedState, snapshot.problem, starting, { role: roleNow, checking: snapshot.checkingAccess });
  // The link stopped trying by itself, or was refused: it tries again only when asked.
  const canReconnect = snapshot.connection.state === "stopped" && listedState === "ready";
  const role = unshared ? null : rolePhrase(roleNow);
  const subtitle = [line.short, role].filter(Boolean).join(" · ");
  const title = listed ? workspaceTitle(listing, listed) : "Workspace";
  const sharing = listedState !== null && !unshared;
  const stopped = listedState === "suspended";

  useEffect(() => (tabId ? session.view(tabId) : undefined), [session, tabId]);
  // The names behind the user ids the runtime reports; without them a short id is shown.
  useEffect(() => { void catalog.people.roster(orgId).catch(() => undefined); }, [catalog, orgId]);
  const presence = presenceLine(snapshot.collab.participants, snapshot.collab.userId, (id) => snapshot.tabs.find((entry) => entry.tabId === id)?.title ?? null, nameOf);

  return <>
    {/* The bar a session has (22.06): back, the title over its state and the person's role as plain words, and Sharing. */}
    <Stack.Screen options={{ title, headerShown: false }} />
    <ScreenHeader title={title} onBack={() => router.back()}
      subtitle={<HeaderLine testID="workspace-state-line" text={subtitle} label={[line.tone === "live" ? line.text : line.short, role].filter(Boolean).join(", ")} />}
      trailing={sharing ? <GlassIconButton label="Sharing" size={40} icon={<Users size={19} color={palette.ink} strokeWidth={1.9} />} onPress={() => router.push({ pathname: "/cloud/shares", params: { orgId, workspaceId } })} /> : null} />
    {/* A warning says more than fits under the title, here, with what can be done about it. */}
    {line.tone === "warn" ? <View accessibilityRole="summary" style={[styles.banner, { backgroundColor: `${palette.warning}18` }]}>
      <StatusDot color={palette.warning} />
      <Text style={[styles.bannerText, { color: palette.ink }]}>{line.text}</Text>
      {canReconnect ? <Pressable accessibilityRole="button" accessibilityLabel="Reconnect" onPress={() => { session.reconnect(); void catalog.refresh(); }} style={[styles.reconnect, { backgroundColor: palette.raised }]}><Text style={[styles.reconnectText, { color: palette.ink }]}>Reconnect</Text></Pressable> : null}
    </View> : null}
    {presence && !unshared ? <Text accessibilityLabel={presence} style={[styles.presence, { color: palette.muted }]}>{presence}</Text> : null}
    {snapshot.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}
    {snapshot.tabs.length > 1 && !unshared ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>{snapshot.tabs.map((entry, index) => <Pressable key={entry.tabId} accessibilityRole="tab" accessibilityState={{ selected: entry.tabId === tabId }} onPress={() => setChosen(entry.tabId)} style={[styles.tab, { backgroundColor: entry.tabId === tabId ? palette.selected : palette.raised }]}><Text numberOfLines={1} style={[styles.tabText, { color: palette.ink }]}>{entry.title ?? `Agent ${index + 1}`}</Text></Pressable>)}</ScrollView> : null}
    {unshared ? <EmptyState title={accessText("not-shared").title} detail={accessText("not-shared").detail} />
      : tab ? <Conversation key={tab.tabId} catalog={catalog} session={session} scope={`${orgId}/${workspaceId}`} orgId={orgId} workspaceId={workspaceId} tabId={tab.tabId} live={live} listedState={listedState} />
      : <View style={styles.flex}>
        <View style={[styles.flex, styles.centred]}>{live ? <EmptyState title="No agent tabs" detail="This workspace has no agent conversation." />
          : stopped || starting || listedState === "attention-required" ? <EmptyState icon={(color) => <MessageSquareDashed size={34} color={color} strokeWidth={1.6} />} title="No conversation yet" detail={listedState === "attention-required" ? "Nothing has been saved in this workspace yet." : "Nothing was said in this workspace before it stopped."} />
          : listedState === "archived" ? <EmptyState title="No conversation yet" detail="Nothing was saved in this workspace before it was archived." />
          : <EmptyState title="Connecting…" detail="The conversation shows once this phone reaches the workspace." busy />}</View>
        {startBarShown(listedState, starting, live) ? <StartBar catalog={catalog} orgId={orgId} workspaceId={workspaceId} role={roleNow} creatorId={listed?.createdBy ?? null} starting={starting} /> : null}
      </View>}
  </>;
}

/** Whether the composer's place holds the Start bar: stopped, or starting and not running yet. */
function startBarShown(listedState: string | null, starting: boolean, live: boolean): boolean {
  return listedState === "suspended" || listedState === "resuming" || listedState === "provisioning" || (listedState === "attention-required" && !live) || starting;
}

/**
 * In place of the composer while a workspace is stopped: Start, for its
 * managers (the server lets only them), and who can start it for a viewer. A
 * driver keeps the composer, whose message starts it (see `Conversation`).
 * Starting it is billed, so it is asked first. When it runs, the composer is back.
 */
function StartBar({ catalog, orgId, workspaceId, role, creatorId, starting }: { catalog: CloudCatalog; orgId: string; workspaceId: string; role: CloudRole | null; creatorId: string | null; starting: boolean }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const nameOf = useNames(catalog);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const listedState = catalog.workspace(orgId, workspaceId)?.state ?? null;
  const changing = starting || asking || listedState === "resuming" || listedState === "provisioning";
  const mayStart = role === "manager";
  const needsAttention = listedState === "attention-required";
  const operation = catalog.getSnapshot().organizations.find((entry) => entry.organization.orgId === orgId)?.workspaces.find((item) => item.workspace.id === workspaceId)?.latestOperation;
  const retryResume = needsAttention && operation?.state === "failed" && operation.action === "resume" && ["cloud_workspace_runtime_bootstrap_failed", "cloud_provider_unavailable", "cloud_provider_rate_limited", "cloud_provider_state_conflict", "cloud_provider_permission_denied"].includes(operation.errorCode ?? "");
  const start = () => Alert.alert(retryResume ? "Retry resume?" : "Start this workspace?", "It is billed to the organization while it runs.", [
    { text: "Cancel", style: "cancel" },
    { text: retryResume ? "Retry resume" : "Start", onPress: () => {
      setAsking(true);
      setFailure(null);
      void catalog.start(orgId, workspaceId).catch((error: unknown) => {
        const code = (error as { code?: unknown })?.code;
        setFailure(codeText(typeof code === "string" ? code : null) ?? "That did not work.");
      }).finally(() => setAsking(false));
    } },
  ]);
  // In the composer's place, as a card like it (22.06).
  return <View testID="start-bar" style={[styles.startBar, { backgroundColor: palette.card, borderColor: palette.border, marginBottom: insets.bottom + 8 }]}>
    <View style={styles.flex}>
      <Text style={[styles.startTitle, { color: palette.ink }]}>{changing ? "Starting the workspace…" : needsAttention ? "This workspace needs attention" : "This workspace is stopped"}</Text>
      <Text style={[styles.startDetail, { color: palette.muted }]}>{changing ? "The composer appears when it is running." : needsAttention ? (retryResume ? (mayStart ? attentionDetail(operation?.errorCode) : `${attentionDetail(operation?.errorCode)} ${creatorId ? `${nameOf(creatorId)}, its creator, or an organization owner or admin` : "Its creator or an organization owner or admin"} can retry resume.`) : `${attentionDetail(operation?.errorCode)} Open this workspace on the desktop to see how to recover.`) : mayStart ? "Start it to send a message." : whoCanStart(creatorId ? nameOf(creatorId) : null)}</Text>
      {/* A refusal is about the last Start: once the workspace starts after all (from elsewhere too), it is past. */}
      {failure && !changing ? <Text accessibilityRole="alert" style={[styles.startDetail, { color: palette.danger }]}>{failure}</Text> : null}
    </View>
    {mayStart && (!needsAttention || retryResume) ? <Button label={changing ? "Starting…" : retryResume ? "Retry resume" : "Start"} size="small" icon={changing ? undefined : (color) => <Play size={14} color={color} />} disabled={changing} onPress={start} /> : null}
  </View>;
}

function Conversation({ catalog, session, scope, orgId, workspaceId, tabId, live, listedState }: { catalog: CloudCatalog; session: CloudWorkspaceSession; scope: string; orgId: string; workspaceId: string; tabId: string; live: boolean; listedState: string | null }) {
  const { palette } = useTheme();
  // Docked at the bottom: clear of the home indicator and the screen's rounded corners, as the session screen's composer is.
  const insets = useSafeAreaInsets();
  const keyboardShown = useKeyboardShown();
  const dockBottom = { paddingBottom: (keyboardShown ? 0 : insets.bottom) + 12 };
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const tab = snapshot.tabs.find((entry) => entry.tabId === tabId);
  const [draft, setDraft] = useConversationState(`cloud:${scope}:${tabId}:draft`, "");
  const [sending, setSending] = useState(false);
  const answeringQuestion = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const nameOf = useNames(catalog);
  const [notesOpen, setNotesOpen] = useState(false);
  const [note, setNote] = useConversationState(`cloud:${scope}:${tabId}:note`, "");
  const shared = snapshot.collab.available;
  const lease = snapshot.collab.leases[tabId] ?? null;
  const now = useNowUntil(lease?.expiresAt ?? null);
  const wheel = leaseLine(lease, snapshot.collab.userId, snapshot.role, now, nameOf);
  const notes = snapshot.collab.notes[tabId] ?? [];
  const events = tab?.events;
  // A compaction is shown as running only while the tab's live feed has caught up; otherwise its status is unknown (#644).
  const continuous = tab?.continuous === true;
  const transcript = useMemo(() => buildTranscript(events ?? [], live, { compactionContinuityKnown: continuous }), [events, live, continuous]);
  const outbox = snapshot.outbox.filter((entry) => entry.tabId === tabId);
  const pending = outbox.filter((entry) => entry.kind !== "permission-decision" && outboxLine(entry, listedState === "suspended", nameOf));

  const mayWrite = snapshot.role === "manager" || snapshot.role === "driver";
  const stopped = listedState === "suspended";
  // Asked to start by a message that is on its way: the workspace is starting, as far as anyone here can tell.
  const starting = stopped && snapshot.outbox.some((entry) => (entry.state === "queued" || entry.state === "leased") && (entry.wake === "queued" || entry.wake === "in-progress"));
  // Written earlier and still on the phone, for a workspace that is stopped now: held until the person says to start it.
  // Also what the server holds for a workspace that stopped before it was delivered: nothing starts it until the person says so.
  const held = stopped ? outbox.filter((entry) => entry.state === "unsent" || entry.asleep) : [];
  const roleHere: CloudRole | null = snapshot.role ?? catalog.workspace(orgId, workspaceId)?.you?.role ?? null;
  // A driver may not start a stopped workspace with Start (/resume is for its managers), but a message they
  // queue wakes it (contract §11.2): for them the composer stays, and sending asks first, as it always has.
  const sendStarts = stopped && !starting && roleHere === "driver";
  const working = tab?.status === "in_progress";
  // Stop is Escape first (#427), as on the desktop: the turn is interrupted and the agent's process stays. While the
  // turn it was sent to is still the one running, the same button is the stop that ends the process. A runtime that
  // cannot take an interrupt (older, or not connected) only has that stop.
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);
  if (!working && interruptedAt !== null) setInterruptedAt(null);
  const unanswered = working && interruptUnanswered(events ?? [], interruptedAt);

  const run = async (action: () => Promise<unknown>, done?: () => void) => {
    setSending(true);
    setFailure(null);
    try {
      await action();
      done?.();
      // The list says when a workspace that was asked to start is running.
      void catalog.refresh();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const holder = leaseHeldBy(error);
      setFailure(holder ? `${nameOf(holder.holderId)} is driving this tab.` : (codeText(typeof code === "string" ? code : null) ?? "That did not work."));
    } finally {
      setSending(false);
    }
  };

  /** The one question that comes before anything here starts a stopped workspace. */
  const confirmStart = (what: string, go: () => Promise<unknown>, done?: () => void) =>
    Alert.alert("Start this workspace?", `It is stopped. ${what} starts it, and it is billed to the organization while it runs.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Start and send", onPress: () => void run(go, done) },
    ]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const start = () => confirmStart("Sending this message", () => session.send(tabId, text, { allowWake: true }), () => setDraft(""));
    if (stopped) return start();
    setSending(true);
    setFailure(null);
    try {
      await session.send(tabId, text);
      setDraft("");
      void catalog.refresh();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      // It was stopped from elsewhere since this screen last heard: ask, as for any stopped workspace.
      if (code === "would-wake") start();
      else setFailure(codeText(typeof code === "string" ? code : null) ?? "That did not work.");
    } finally {
      setSending(false);
    }
  };

  const sendHeld = () => confirmStart(held.length === 1 ? "Sending the message that is waiting" : `Sending the ${held.length} messages that are waiting`, () => session.deliverHeld({ allowWake: true }));

  const stopAgent = () => {
    if (!snapshot.interrupts || unanswered) return void run(() => session.stop(tabId));
    // Read now, not at the last render: the turn this is for may have ended since.
    const seen = session.getSnapshot().tabs.find((entry) => entry.tabId === tabId)?.events ?? [];
    setInterruptedAt(seen.length ? seen[seen.length - 1].seq : 0);
    void run(() => session.interrupt(tabId));
  };

  const decide = (ask: PendingAsk, optionId: string) => void run(() => session.decide(tabId, { requestId: ask.requestId, optionId }));
  // A question is answered as the desktop answers a cloud tab's: the same decision command, carrying the answers (#979).
  // One at a time: a second tap lands before the first one's render, and would only be told the question is already answered.
  const answer = (ask: PendingAsk, answers: Record<string, string>) => {
    if (answeringQuestion.current) return;
    answeringQuestion.current = true;
    void run(() => session.decide(tabId, { requestId: ask.requestId, answers })).finally(() => { answeringQuestion.current = false; });
  };
  /** What the runtime said of this phone's answer when it would not take it: someone answered first. */
  const refusedAnswer = (ask: PendingAsk) => {
    const entry = outbox.find((item) => item.kind === "permission-decision" && item.requestId === ask.requestId && item.state === "rejected");
    return entry ? codeText(entry.category) ?? "That answer was not taken." : undefined;
  };

  const addNote = () => {
    const text = note.trim();
    if (!text || sending) return;
    void run(() => session.postNote(tabId, text), () => setNote(""));
  };

  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={92}>
    {shared ? <View style={[styles.wheel, { borderBottomColor: palette.border }]}>
      <Text accessibilityLabel={wheel.text} numberOfLines={1} style={[styles.wheelText, { color: wheel.mine ? palette.accent : palette.muted }]}>{wheel.text}</Text>
      {wheel.canTake ? <Pressable accessibilityRole="button" disabled={sending} onPress={() => void run(() => session.takeWheel(tabId))} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.accent }]}>Take the wheel</Text></Pressable> : null}
      {wheel.canRelease ? <Pressable accessibilityRole="button" disabled={sending} onPress={() => void run(() => session.releaseWheel(tabId))} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.accent }]}>Release</Text></Pressable> : null}
      {wheel.canTakeOver ? <Pressable accessibilityRole="button" disabled={sending} onPress={() => void run(() => session.takeOverWheel(tabId))} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.accent }]}>Take over</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: notesOpen }} onPress={() => setNotesOpen((open) => !open)} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.ink }]}>{`Notes${notes.length ? ` (${notes.length})` : ""}`}</Text></Pressable>
    </View> : null}
    {shared && notesOpen ? <View style={[styles.notes, { backgroundColor: palette.card, borderBottomColor: palette.border }]}>
      <Text style={[styles.notesHint, { color: palette.muted }]}>Notes are for the people here. They are not sent to the agent.</Text>
      <ScrollView style={styles.notesList}>{notes.length ? notes.map((entry) => <Text key={entry.id} selectable style={[styles.noteLine, { color: palette.ink }]}><Text style={{ color: palette.accent, fontWeight: "700" }}>{entry.authorId === snapshot.collab.userId ? "You" : nameOf(entry.authorId)}</Text>{"  "}{linkedText(entry.text)}</Text>) : <Text style={[styles.notesHint, { color: palette.muted }]}>No notes yet.</Text>}</ScrollView>
      <View style={styles.composeLine}>
        <TextInput value={note} onChangeText={setNote} multiline maxLength={NOTE_MAX_CHARS} placeholder="Add a note for people here" placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink }]} />
        <Button label="Add note" kind="secondary" disabled={!note.trim() || sending} onPress={addNote} />
      </View>
    </View> : null}
    {/* Opens at the newest turn, as the desktop and the session screen do; the asks and messages waiting sit at that edge. */}
    <TranscriptList key={tabId ?? "none"} data={transcript.turns} keyExtractor={(turn) => turn.key}
      earlier={tab?.truncated ? <Text style={[styles.notice, { color: palette.muted }]}>Earlier messages are not in the saved conversation.</Text> : null}
      ListEmptyComponent={tab?.noKey ? <EmptyState title="Not readable on this phone yet" detail={codeText("no-key")!} /> : <EmptyState title="No conversation yet" detail={live ? "This tab has not published any turns." : "Nothing has been saved for this tab."} />}
      renderItem={({ item }) => <TurnCard turn={item} />}
      latest={<>
        {transcript.compacting ? <CompactingLine /> : null}
        {transcript.pendingAsks.map((ask) => ask.kind === "questions"
          // The question and its options are for everyone here; answering is for those who may approve.
          ? <QuestionCard key={ask.requestId} ask={ask} stateKey={`cloud:${scope}:${tabId}`} connected={!stopped} answering={sending || session.outbox.isDeciding(ask.requestId)} readOnly={snapshot.canApprove ? null : CANNOT_ANSWER} error={refusedAnswer(ask)} onAnswer={(answers) => answer(ask, answers)} />
          : snapshot.canApprove
          ? <PermissionCard key={ask.requestId} ask={ask} connected={!stopped} answering={sending || session.outbox.isDeciding(ask.requestId)} onRespond={(optionId) => decide(ask, optionId)} />
          : <Text key={ask.requestId} style={[styles.notice, { color: palette.warning }]}>The agent is waiting for a permission ({ask.title ?? ask.toolName ?? "request"}). Waiting for someone who can approve.</Text>)}
        {pending.map((entry) => { const line = outboxLine(entry, stopped, nameOf)!; return <View key={entry.clientCommandId} style={styles.pending}>
          {entry.text ? <Text numberOfLines={3} style={[styles.pendingText, { color: palette.ink, backgroundColor: palette.selected }]}>{entry.text}</Text> : null}
          <Text style={[styles.pendingState, { color: line.tone === "warn" ? palette.warning : palette.muted }]}>{entry.kind === "stop" ? "Stop: " : ""}{line.text}</Text>
          {entry.state === "unsent" || entry.state === "queued" ? <Pressable accessibilityRole="button" accessibilityLabel={entry.text ? `Cancel the message: ${entry.text.slice(0, 60)}` : "Cancel this command"} onPress={() => void run(() => session.cancel(entry.clientCommandId))} style={styles.cancel}><Text style={[styles.pendingState, { color: palette.accent }]}>Cancel</Text></Pressable> : null}
        </View>; })}
        {held.length && mayWrite ? <Button label={held.length === 1 ? "Send it and start the workspace" : `Send ${held.length} messages and start the workspace`} kind="secondary" disabled={sending} onPress={sendHeld} style={styles.held} /> : null}
      </>} />
    {failure ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.danger }]}>{failure}</Text> : null}
    {startBarShown(listedState, starting, live) && !sendStarts
      ? <StartBar catalog={catalog} orgId={orgId} workspaceId={workspaceId} role={roleHere} creatorId={catalog.workspace(orgId, workspaceId)?.createdBy ?? null} starting={starting} />
      : mayWrite && listedState !== "archived" && listedState !== null
      ? <View style={[styles.composer, dockBottom, { backgroundColor: palette.card, borderTopColor: palette.border }]}>
        {!snapshot.hasKey ? <Text style={[styles.notice, { color: palette.muted }]}>{codeText("no-key")}</Text> : null}
        {wheel.heldByOther ? <Text style={[styles.notice, { color: palette.warning }]}>{`${nameOf(lease?.holderId)} is driving this tab. ${wheel.canTakeOver ? "Take over to send." : "You can send when they release it."}`}</Text> : null}
        <View style={styles.composeLine}>
          <TextInput accessibilityLabel={stopped ? "Message for the agent. Sending starts the workspace." : "Message for the agent"} value={draft} onChangeText={(value) => { setDraft(value); if (value) session.typingIn(tabId); }} multiline editable={snapshot.hasKey && !wheel.heldByOther} placeholder={stopped ? "Message (starts the workspace)" : "Message the agent"} placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink }]} />
          {working && !stopped && (!wheel.heldByOther || snapshot.role === "manager") ? <Pressable accessibilityRole="button" accessibilityLabel={unanswered ? "Stop the session" : "Stop the agent"} accessibilityHint={unanswered ? "Ends the agent's process. The conversation resumes with the next message." : undefined} disabled={sending} onPress={stopAgent} style={[styles.round, { backgroundColor: unanswered ? palette.danger : palette.raised }]}><Square size={16} color={unanswered ? palette.accentInk : palette.ink} /></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!draft.trim() || sending || !snapshot.hasKey || wheel.heldByOther} onPress={() => void send()} style={[styles.round, { backgroundColor: palette.accent }, (!draft.trim() || sending || !snapshot.hasKey || wheel.heldByOther) && styles.disabled]}><Send size={17} color={palette.accentInk} /></Pressable>
        </View>
      </View>
      : <View style={[styles.composer, dockBottom, { backgroundColor: palette.card, borderTopColor: palette.border }]}><Text style={[styles.notice, { color: palette.muted }]}>{listedState === "archived" ? "This workspace is archived. Its conversation can be read." : listedState === null ? codeText("cloud_workspace_not_found") : codeText("read-only")}</Text></View>}
  </KeyboardAvoidingView>;
}

/** Why someone who may not approve sees a question without Answer and Skip (contract §21.4). */
const CANNOT_ANSWER = "Only someone allowed to approve can answer this question.";

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  centred: { justifyContent: "center" },
  banner: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  // The title and, under it, the state and the role in plain words.
  // An icon button with a full 44 pt target.
  reconnectText: { fontSize: 12, fontWeight: "600" },
  startBar: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 12, marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, borderCurve: "continuous", paddingHorizontal: 14, paddingVertical: 12 },
  startTitle: { fontSize: 15, fontWeight: "600", lineHeight: 20 },
  startDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  presence: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingTop: 6 },
  // Wraps on a narrow phone: the buttons go under the driver's name rather than squeezing it.
  wheel: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingLeft: 16, paddingRight: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  wheelText: { flexGrow: 1, flexShrink: 1, minWidth: 120, fontSize: 13, fontWeight: "600" },
  wheelAction: { minHeight: 44, paddingHorizontal: 10, justifyContent: "center" },
  wheelActionText: { fontSize: 13, fontWeight: "600" },
  notes: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  notesHint: { fontSize: 12, lineHeight: 17 },
  notesList: { maxHeight: 180 },
  noteLine: { fontSize: 14, lineHeight: 20, paddingVertical: 3 },
  notice: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 6 },
  tabs: { flexGrow: 0 },
  tabsContent: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  tab: { minHeight: 36, maxWidth: 220, paddingHorizontal: 13, borderRadius: 10, justifyContent: "center" },
  tabText: { fontSize: 14, fontWeight: "600" },
  pending: { alignItems: "flex-end", gap: 4, marginTop: 12 },
  pendingText: { maxWidth: "88%", borderRadius: 17, borderBottomRightRadius: 5, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, lineHeight: 22, overflow: "hidden", opacity: 0.7 },
  pendingState: { fontSize: 12, lineHeight: 17 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, paddingBottom: 12, gap: 6 },
  composeLine: { flexDirection: "row", alignItems: "flex-end", gap: 9 },
  input: { flex: 1, maxHeight: 120, minHeight: 42, paddingHorizontal: 10, paddingVertical: 9, fontSize: 16 },
  round: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  reconnect: { minHeight: 32, paddingHorizontal: 11, borderRadius: 9, justifyContent: "center" },
  cancel: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "flex-end" },
  held: { marginTop: 10 },
});
