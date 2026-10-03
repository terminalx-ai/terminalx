import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Send, Square } from "lucide-react-native";
import { buildTranscript, type PendingAsk } from "@terminalx/portable/transcript";
import { leaseHeldBy, NOTE_MAX_CHARS } from "@terminalx/portable/workspaceCollab";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { accessText, codeText, connectionLine, leaseLine, outboxLine, presenceLine, roleLabel } from "@mobile/cloud/words";
import type { CloudWorkspaceSession } from "@mobile/cloud/workspace";
import { useConversationState } from "@mobile/state/conversation-state";
import { Button, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";
import { PermissionCard, TurnCard } from "@mobile/ui/transcript";

/**
 * One cloud workspace: its agent tabs and the conversation of the chosen one.
 * A running workspace is shown live. A stopped one is shown from its saved,
 * encrypted conversation, and opening this screen starts nothing; only
 * sending a message does, after the person confirms.
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
    <Stack.Screen options={{ title: listed?.name ?? params.title ?? "Workspace" }} />
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
  const tab = snapshot.tabs.find((entry) => entry.tabId === chosen) ?? snapshot.tabs[0] ?? null;
  const tabId = tab?.tabId ?? null;
  const live = snapshot.connection.state === "connected";
  const starting = listedState === "suspended" && snapshot.outbox.some((entry) => (entry.state === "queued" || entry.state === "leased") && (entry.wake === "queued" || entry.wake === "in-progress"));
  const banner = connectionLine(snapshot.connection, listedState, snapshot.problem, starting);
  // The link stopped trying by itself, or was refused: it tries again only when asked.
  const canReconnect = snapshot.connection.state === "stopped" && listedState === "ready";
  const role = roleLabel(snapshot.role);

  useEffect(() => (tabId ? session.view(tabId) : undefined), [session, tabId]);
  // The names behind the user ids the runtime reports; without them a short id is shown.
  useEffect(() => { void catalog.people.roster(orgId).catch(() => undefined); }, [catalog, orgId]);
  const presence = presenceLine(snapshot.collab.participants, snapshot.collab.userId, (id) => snapshot.tabs.find((entry) => entry.tabId === id)?.title ?? null, nameOf);

  return <>
    <View accessibilityRole="summary" style={[styles.banner, { backgroundColor: banner.tone === "live" ? `${palette.success}16` : banner.tone === "warn" ? `${palette.warning}18` : palette.raised }]}>
      <StatusDot color={banner.tone === "live" ? palette.success : banner.tone === "warn" ? palette.warning : palette.faint} />
      <Text style={[styles.bannerText, { color: palette.ink }]}>{banner.text}</Text>
      {role ? <Text style={[styles.role, { color: palette.muted }]}>{role}</Text> : null}
      {canReconnect ? <Pressable accessibilityRole="button" accessibilityLabel="Reconnect" onPress={() => { session.reconnect(); void catalog.refresh(); }} style={[styles.reconnect, { backgroundColor: palette.raised }]}><Text style={[styles.role, { color: palette.ink }]}>Reconnect</Text></Pressable> : null}
      {listedState !== null ? <Pressable accessibilityRole="button" accessibilityLabel="Sharing" onPress={() => router.push({ pathname: "/cloud/shares", params: { orgId, workspaceId } })} style={[styles.sharing, { backgroundColor: palette.raised }]}><Text style={[styles.role, { color: palette.ink }]}>Sharing</Text></Pressable> : null}
    </View>
    {presence ? <Text accessibilityLabel={presence} style={[styles.presence, { color: palette.muted }]}>{presence}</Text> : null}
    {snapshot.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}
    {snapshot.tabs.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>{snapshot.tabs.map((entry, index) => <Pressable key={entry.tabId} accessibilityRole="tab" accessibilityState={{ selected: entry.tabId === tabId }} onPress={() => setChosen(entry.tabId)} style={[styles.tab, { backgroundColor: entry.tabId === tabId ? palette.selected : palette.raised }]}><Text numberOfLines={1} style={[styles.tabText, { color: palette.ink }]}>{entry.title ?? `Agent ${index + 1}`}</Text></Pressable>)}</ScrollView> : null}
    {snapshot.role === "none" ? <EmptyState title={accessText("not-shared").title} detail={accessText("not-shared").detail} /> : tab ? <Conversation key={tab.tabId} catalog={catalog} session={session} scope={`${orgId}/${workspaceId}`} tabId={tab.tabId} live={live} listedState={listedState} /> : <EmptyState title={live ? "No agent tabs" : "Nothing saved yet"} detail={live ? "This workspace has no agent conversation." : "There is no saved conversation for this workspace to show while it is not running."} />}
  </>;
}

function Conversation({ catalog, session, scope, tabId, live, listedState }: { catalog: CloudCatalog; session: CloudWorkspaceSession; scope: string; tabId: string; live: boolean; listedState: string | null }) {
  const { palette } = useTheme();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const tab = snapshot.tabs.find((entry) => entry.tabId === tabId);
  const [draft, setDraft] = useConversationState(`cloud:${scope}:${tabId}:draft`, "");
  const [sending, setSending] = useState(false);
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
  const transcript = useMemo(() => buildTranscript(events ?? [], live), [events, live]);
  const outbox = snapshot.outbox.filter((entry) => entry.tabId === tabId);
  const pending = outbox.filter((entry) => entry.kind !== "permission-decision" && outboxLine(entry, listedState === "suspended", nameOf));

  const mayWrite = snapshot.role === "manager" || snapshot.role === "driver";
  const stopped = listedState === "suspended";
  // Written earlier and still on the phone, for a workspace that is stopped now: held until the person says to start it.
  const held = stopped ? outbox.filter((entry) => entry.state === "unsent") : [];
  const working = tab?.status === "in_progress";

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

  const decide = (ask: PendingAsk, optionId: string) => void run(() => session.decide(tabId, { requestId: ask.requestId, optionId }));

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
      <ScrollView style={styles.notesList}>{notes.length ? notes.map((entry) => <Text key={entry.id} selectable style={[styles.noteLine, { color: palette.ink }]}><Text style={{ color: palette.accent, fontWeight: "700" }}>{entry.authorId === snapshot.collab.userId ? "You" : nameOf(entry.authorId)}</Text>{`  ${entry.text}`}</Text>) : <Text style={[styles.notesHint, { color: palette.muted }]}>No notes yet.</Text>}</ScrollView>
      <View style={styles.composeLine}>
        <TextInput value={note} onChangeText={setNote} multiline maxLength={NOTE_MAX_CHARS} placeholder="Add a note for people here" placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink }]} />
        <Button label="Add note" kind="secondary" disabled={!note.trim() || sending} onPress={addNote} />
      </View>
    </View> : null}
    <FlatList data={transcript.turns} keyExtractor={(turn) => turn.key} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.transcript} keyboardDismissMode="interactive"
      ListHeaderComponent={tab?.truncated ? <Text style={[styles.notice, { color: palette.muted }]}>Earlier messages are not in the saved conversation.</Text> : null}
      ListEmptyComponent={tab?.noKey ? <EmptyState title="Not readable on this phone yet" detail={codeText("no-key")!} /> : <EmptyState title="No conversation yet" detail={live ? "This tab has not published any turns." : "Nothing has been saved for this tab."} />}
      renderItem={({ item }) => <TurnCard turn={item} />}
      ListFooterComponent={<>
        {transcript.pendingAsks.map((ask) => snapshot.canApprove
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
    {mayWrite && listedState !== "archived" && listedState !== null
      ? <View style={[styles.composer, { backgroundColor: palette.card, borderTopColor: palette.border }]}>
        {!snapshot.hasKey ? <Text style={[styles.notice, { color: palette.muted }]}>{codeText("no-key")}</Text> : null}
        {wheel.heldByOther ? <Text style={[styles.notice, { color: palette.warning }]}>{`${nameOf(lease?.holderId)} is driving this tab. ${wheel.canTakeOver ? "Take over to send." : "You can send when they release it."}`}</Text> : null}
        <View style={styles.composeLine}>
          <TextInput accessibilityLabel={stopped ? "Message for the agent. Sending starts the workspace." : "Message for the agent"} value={draft} onChangeText={(value) => { setDraft(value); if (value) session.typingIn(tabId); }} multiline editable={snapshot.hasKey && !wheel.heldByOther} placeholder={stopped ? "Message (starts the workspace)" : "Message the agent"} placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink }]} />
          {working && !stopped && (!wheel.heldByOther || snapshot.role === "manager") ? <Pressable accessibilityRole="button" accessibilityLabel="Stop the agent" disabled={sending} onPress={() => void run(() => session.stop(tabId))} style={[styles.round, { backgroundColor: palette.raised }]}><Square size={16} color={palette.ink} /></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!draft.trim() || sending || !snapshot.hasKey || wheel.heldByOther} onPress={() => void send()} style={[styles.round, { backgroundColor: palette.accent }, (!draft.trim() || sending || !snapshot.hasKey || wheel.heldByOther) && styles.disabled]}><Send size={17} color={palette.accentInk} /></Pressable>
        </View>
      </View>
      : <View style={[styles.composer, { backgroundColor: palette.card, borderTopColor: palette.border }]}><Text style={[styles.notice, { color: palette.muted }]}>{listedState === "archived" ? "This workspace is archived. Its conversation can be read." : listedState === null ? codeText("cloud_workspace_not_found") : codeText("read-only")}</Text></View>}
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  banner: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  role: { fontSize: 12, fontWeight: "600" },
  sharing: { minHeight: 32, paddingHorizontal: 11, borderRadius: 9, justifyContent: "center" },
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
  transcript: { padding: 16, paddingBottom: 24, gap: 16 },
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
