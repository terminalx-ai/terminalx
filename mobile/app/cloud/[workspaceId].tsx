import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Send, Square } from "lucide-react-native";
import { buildTranscript, type PendingAsk } from "@terminalx/portable/transcript";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { codeText, connectionLine, outboxLine, roleLabel } from "@mobile/cloud/words";
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
  // Leaving lets go of the connection; nothing keeps a phone attached unseen.
  useEffect(() => (catalog && orgId ? catalog.retain(orgId, params.workspaceId) : undefined), [catalog, orgId, params.workspaceId]);
  const session = catalog && orgId ? catalog.opened(orgId, params.workspaceId) : null;

  const listed = catalog && orgId ? catalog.workspace(orgId, params.workspaceId) : null;
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: listed?.name ?? params.title ?? "Workspace" }} />
    {catalog && session ? <Workspace key={`${orgId}/${params.workspaceId}`} catalog={catalog} session={session} listedState={listed?.state ?? null} initialTabId={params.tabId ?? null} /> : <EmptyState title="Workspace unavailable" detail="Sign in, then open it again from the Cloud tab." />}
  </View>;
}

function Workspace({ catalog, session, listedState, initialTabId }: { catalog: CloudCatalog; session: CloudWorkspaceSession; listedState: string | null; initialTabId: string | null }) {
  const { palette } = useTheme();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [chosen, setChosen] = useState<string | null>(initialTabId);
  const tab = snapshot.tabs.find((entry) => entry.tabId === chosen) ?? snapshot.tabs[0] ?? null;
  const tabId = tab?.tabId ?? null;
  const live = snapshot.connection.state === "connected";
  const banner = connectionLine(snapshot.connection, listedState, snapshot.problem);
  const role = roleLabel(snapshot.role);

  useEffect(() => (tabId ? session.view(tabId) : undefined), [session, tabId]);

  return <>
    <View accessibilityRole="summary" style={[styles.banner, { backgroundColor: banner.tone === "live" ? `${palette.success}16` : banner.tone === "warn" ? `${palette.warning}18` : palette.raised }]}>
      <StatusDot color={banner.tone === "live" ? palette.success : banner.tone === "warn" ? palette.warning : palette.faint} />
      <Text style={[styles.bannerText, { color: palette.ink }]}>{banner.text}</Text>
      {role ? <Text style={[styles.role, { color: palette.muted }]}>{role}</Text> : null}
    </View>
    {snapshot.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}
    {snapshot.tabs.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>{snapshot.tabs.map((entry, index) => <Pressable key={entry.tabId} accessibilityRole="tab" accessibilityState={{ selected: entry.tabId === tabId }} onPress={() => setChosen(entry.tabId)} style={[styles.tab, { backgroundColor: entry.tabId === tabId ? palette.selected : palette.raised }]}><Text numberOfLines={1} style={[styles.tabText, { color: palette.ink }]}>{entry.title ?? `Agent ${index + 1}`}</Text></Pressable>)}</ScrollView> : null}
    {tab ? <Conversation key={tab.tabId} catalog={catalog} session={session} tabId={tab.tabId} live={live} listedState={listedState} /> : <EmptyState title={live ? "No agent tabs" : "Nothing saved yet"} detail={live ? "This workspace has no agent conversation." : "There is no saved conversation for this workspace to show while it is not running."} />}
  </>;
}

function Conversation({ catalog, session, tabId, live, listedState }: { catalog: CloudCatalog; session: CloudWorkspaceSession; tabId: string; live: boolean; listedState: string | null }) {
  const { palette } = useTheme();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const tab = snapshot.tabs.find((entry) => entry.tabId === tabId);
  const [draft, setDraft] = useConversationState(`cloud:${tabId}:draft`, "");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const events = tab?.events;
  const transcript = useMemo(() => buildTranscript(events ?? [], live), [events, live]);
  const outbox = snapshot.outbox.filter((entry) => entry.tabId === tabId);
  const pending = outbox.filter((entry) => entry.kind !== "permission-decision" && outboxLine(entry));
  const mayWrite = snapshot.role === "manager" || snapshot.role === "driver";
  const stopped = listedState === "suspended";
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
      setFailure(codeText(typeof code === "string" ? code : null) ?? "That did not work.");
    } finally {
      setSending(false);
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (!stopped) return void run(() => session.send(tabId, text), () => setDraft(""));
    // The one thing on this screen that starts a stopped workspace, and never without asking.
    Alert.alert("Start this workspace?", "It is stopped. Sending this message starts it, and it is billed to the organization while it runs.", [
      { text: "Cancel", style: "cancel" },
      { text: "Start and send", onPress: () => void run(() => session.send(tabId, text, { allowWake: true }), () => setDraft("")) },
    ]);
  };

  const decide = (ask: PendingAsk, optionId: string) => void run(() => session.decide(tabId, { requestId: ask.requestId, optionId }));

  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={92}>
    <FlatList data={transcript.turns} keyExtractor={(turn) => turn.key} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.transcript} keyboardDismissMode="interactive"
      ListHeaderComponent={tab?.truncated ? <Text style={[styles.notice, { color: palette.muted }]}>Earlier messages are not in the saved conversation.</Text> : null}
      ListEmptyComponent={tab?.noKey ? <EmptyState title="Not readable on this phone yet" detail={codeText("no-key")!} /> : <EmptyState title="No conversation yet" detail={live ? "This tab has not published any turns." : "Nothing has been saved for this tab."} />}
      renderItem={({ item }) => <TurnCard turn={item} />}
      ListFooterComponent={<>
        {transcript.pendingAsks.map((ask) => snapshot.canApprove
          ? <PermissionCard key={ask.requestId} ask={ask} connected={!stopped} answering={sending || session.outbox.isDeciding(ask.requestId)} onRespond={(optionId) => decide(ask, optionId)} />
          : <Text key={ask.requestId} style={[styles.notice, { color: palette.warning }]}>The agent is waiting for a permission ({ask.title ?? ask.toolName ?? "request"}). {codeText("cannot-approve")}</Text>)}
        {pending.map((entry) => { const line = outboxLine(entry)!; return <View key={entry.clientCommandId} style={styles.pending}>
          {entry.text ? <Text numberOfLines={3} style={[styles.pendingText, { color: palette.ink, backgroundColor: palette.selected }]}>{entry.text}</Text> : null}
          <Text style={[styles.pendingState, { color: line.tone === "warn" ? palette.warning : palette.muted }]}>{entry.kind === "stop" ? "Stop: " : ""}{line.text}</Text>
          {entry.state === "unsent" || entry.state === "queued" ? <Pressable accessibilityRole="button" onPress={() => void run(() => session.cancel(entry.clientCommandId))}><Text style={[styles.pendingState, { color: palette.accent }]}>Cancel</Text></Pressable> : null}
        </View>; })}
      </>} />
    {failure ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.danger }]}>{failure}</Text> : null}
    {mayWrite && listedState !== "archived" && listedState !== null
      ? <View style={[styles.composer, { backgroundColor: palette.card, borderTopColor: palette.border }]}>
        {!snapshot.hasKey ? <Text style={[styles.notice, { color: palette.muted }]}>{codeText("no-key")}</Text> : null}
        <View style={styles.composeLine}>
          <TextInput value={draft} onChangeText={setDraft} multiline editable={snapshot.hasKey} placeholder={stopped ? "Message (starts the workspace)" : "Message the agent"} placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink }]} />
          {working && !stopped ? <Pressable accessibilityRole="button" accessibilityLabel="Stop the agent" disabled={sending} onPress={() => void run(() => session.stop(tabId))} style={[styles.round, { backgroundColor: palette.raised }]}><Square size={16} color={palette.ink} /></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!draft.trim() || sending || !snapshot.hasKey} onPress={send} style={[styles.round, { backgroundColor: palette.accent }, (!draft.trim() || sending || !snapshot.hasKey) && styles.disabled]}><Send size={17} color={palette.accentInk} /></Pressable>
        </View>
      </View>
      : <View style={[styles.composer, { backgroundColor: palette.card, borderTopColor: palette.border }]}><Text style={[styles.notice, { color: palette.muted }]}>{listedState === "archived" ? "This workspace is archived. Its conversation can be read." : listedState === null ? codeText("cloud_workspace_not_found") : codeText("read-only")}</Text></View>}
    {mayWrite && snapshot.connection.state === "stopped" && listedState === "ready" ? <Button label="Try again" kind="secondary" onPress={() => void catalog.refresh()} style={styles.retry} /> : null}
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  banner: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  role: { fontSize: 12, fontWeight: "600" },
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
  retry: { margin: 10 },
});
