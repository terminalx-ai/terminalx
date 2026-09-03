import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ChevronUp, Radio, Send, Terminal as TerminalIcon } from "lucide-react-native";
import { buildTranscript, type PendingAsk, type Turn, type WorkItem } from "@terminalx/portable/transcript";
import type { AgentEvent } from "@terminalx/portable/events";
import { mergeEvents, readTranscriptCache, writeTranscriptCache, type ChatNote } from "@mobile/data/host-api";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

const terminalModes = new Map<string, "direct" | "buffered">();

export default function SessionScreen() {
  const params = useLocalSearchParams<{ sessionId: string; tabId?: string; title?: string }>();
  const sessionId = params.sessionId;
  const app = useApp();
  const { palette } = useTheme();
  const summary = app.sessions.find((item) => item.id === sessionId);
  const tabId = params.tabId ?? summary?.tabs[0]?.id ?? "";
  const [view, setView] = useState<"chat" | "terminal">("chat");

  if (!app.activeHost || !tabId) return <View style={[styles.center, { backgroundColor: palette.page }]}><EmptyState title="Session unavailable" detail="Reconnect to its Mac and open this session again." /></View>;
  return <View style={[styles.page, { backgroundColor: palette.page }]}><View style={[styles.segment, { backgroundColor: palette.raised }]}><Segment label="Chat" selected={view === "chat"} onPress={() => setView("chat")} /><Segment label="Terminal" selected={view === "terminal"} onPress={() => setView("terminal")} /></View>{view === "chat" ? <ChatPane hostId={app.activeHost.id} sessionId={sessionId} tabId={tabId} connected={app.connectionStage === "connected"} /> : <TerminalPane sessionId={sessionId} tabId={tabId} connected={app.connectionStage === "connected"} />}</View>;
}

function Segment({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.segmentItem, selected && { backgroundColor: palette.card }]}><Text style={{ color: selected ? palette.ink : palette.muted, fontWeight: selected ? "600" : "500" }}>{label}</Text></Pressable>;
}

function ChatPane({ hostId, sessionId, tabId, connected }: { hostId: string; sessionId: string; tabId: string; connected: boolean }) {
  const app = useApp();
  const { palette } = useTheme();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [notes, setNotes] = useState<ChatNote[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sendToAgent, setSendToAgent] = useState(true);
  const [sending, setSending] = useState(false);
  const [answeringPermission, setAnsweringPermission] = useState<string | null>(null);
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({});
  const cacheKey = `terminalx:draft:${hostId}:${sessionId}:${tabId}`;
  const transcript = useMemo(() => buildTranscript(events, connected), [connected, events]);

  const load = useCallback(async () => {
    const cached = await readTranscriptCache(hostId, sessionId, tabId);
    setEvents(cached);
    setLoading(cached.length === 0);
    if (!connected) return;
    const page = await app.api.tail(sessionId, tabId);
    if (page) {
      setEvents((existing) => mergeEvents(existing, page.events));
      setHasMore(page.hasMore);
    }
    setNotes(await app.api.listNotes(sessionId));
    setLoading(false);
  }, [app.api, connected, hostId, sessionId, tabId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    void AsyncStorage.getItem(cacheKey).then((value) => { if (value) setDraft(value); });
    return () => clearTimeout(timer);
  }, [cacheKey, load]);
  useEffect(() => { if (events.length) void writeTranscriptCache(hostId, sessionId, tabId, events); }, [events, hostId, sessionId, tabId]);
  useEffect(() => {
    const stream = app.api.subscribeSession(tabId, (event) => setEvents((existing) => mergeEvents(existing, [event])));
    const events = app.connection.onEvent((message) => {
    if (message.method === "session.event") {
      const event = (message.params as { event?: unknown } | null)?.event;
      if (isAgentEvent(event) && event.tabId === tabId) setEvents((existing) => mergeEvents(existing, [event]));
    }
    if (message.method === "chat.changed") void app.api.listNotes(sessionId).then(setNotes);
    });
    return () => { stream(); events(); };
  }, [app.api, app.connection, sessionId, tabId]);

  const loadEarlier = async () => {
    const before = events[0]?.seq;
    if (before === undefined || !connected) return;
    const page = await app.api.tail(sessionId, tabId, before);
    if (page) {
      setEvents((existing) => mergeEvents(existing, page.events));
      setHasMore(page.hasMore);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !connected || sending) return;
    setSending(true);
    try {
      const beforeIds = new Set(notes.map((note) => note.id));
      if (!(await app.api.postNote(sessionId, text))) return;
      const nextNotes = await app.api.listNotes(sessionId);
      setNotes(nextNotes);
      if (sendToAgent) {
        const created = [...nextNotes].reverse().find((note) => !beforeIds.has(note.id));
        if (!created || !(await app.api.promoteNote(sessionId, tabId, created.id))) return;
      }
      setDraft("");
      await AsyncStorage.removeItem(cacheKey);
    } finally {
      setSending(false);
    }
  };

  const items: ({ kind: "turn"; turn: Turn } | { kind: "note"; note: ChatNote })[] = [
    ...transcript.turns.map((turn) => ({ kind: "turn" as const, turn })),
    ...notes.map((note) => ({ kind: "note" as const, note })),
  ].sort((left, right) => itemTime(left) - itemTime(right));

  const respondPermission = async (ask: PendingAsk, optionId: string) => {
    if (!connected || answeringPermission) return;
    setAnsweringPermission(ask.requestId);
    setPermissionErrors((current) => { const next = { ...current }; delete next[ask.requestId]; return next; });
    try {
      const result = await app.api.respondPermission(sessionId, tabId, ask.requestId, optionId);
      if (!result.answered) setPermissionErrors((current) => ({ ...current, [ask.requestId]: result.message }));
    } catch (error) {
      setPermissionErrors((current) => ({ ...current, [ask.requestId]: error instanceof Error ? error.message : "The host could not answer this request." }));
    } finally {
      setAnsweringPermission(null);
    }
  };

  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={92}><FlatList data={items} keyExtractor={(item) => item.kind === "turn" ? item.turn.key : `note-${item.note.id}`} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.transcript} keyboardDismissMode="interactive" ListHeaderComponent={hasMore ? <Button label="Load earlier" kind="secondary" disabled={!connected} onPress={() => void loadEarlier()} /> : null} ListEmptyComponent={loading ? <EmptyState title="Loading transcript" detail="Reading the latest turns from your Mac." busy /> : <EmptyState title="No transcript yet" detail="This tab has not published any turns." />} renderItem={({ item }) => item.kind === "turn" ? <TurnCard turn={item.turn} /> : <NoteCard note={item.note} />} ListFooterComponent={<>{transcript.pendingAsks.map((ask) => <PermissionCard key={ask.requestId} ask={ask} connected={connected} answering={answeringPermission === ask.requestId} error={permissionErrors[ask.requestId]} onRespond={(optionId) => void respondPermission(ask, optionId)} />)}</>} /><View style={[styles.composer, { backgroundColor: palette.card, borderColor: palette.border }]}><View style={styles.modeLine}><Pressable onPress={() => setSendToAgent(true)} style={[styles.modeChoice, sendToAgent && { backgroundColor: palette.selected }]}><Radio size={15} color={sendToAgent ? palette.accent : palette.muted} /><Text style={{ color: sendToAgent ? palette.ink : palette.muted, fontSize: 12 }}>Send to agent</Text></Pressable><Pressable onPress={() => setSendToAgent(false)} style={[styles.modeChoice, !sendToAgent && { backgroundColor: palette.selected }]}><Text style={{ color: !sendToAgent ? palette.ink : palette.muted, fontSize: 12 }}>Add note</Text></Pressable></View><View style={styles.composeLine}><TextInput value={draft} onChangeText={(value) => { setDraft(value); void AsyncStorage.setItem(cacheKey, value); }} multiline placeholder={connected ? "Message this session" : "Draft kept while offline"} placeholderTextColor={palette.faint} style={[styles.composeInput, { color: palette.ink }]} /><Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!connected || !draft.trim() || sending} onPress={() => void send()} style={[styles.send, { backgroundColor: palette.accent, opacity: !connected || !draft.trim() || sending ? 0.38 : 1 }]}><Send size={18} color={palette.accentInk} /></Pressable></View></View></KeyboardAvoidingView>;
}

function PermissionCard({ ask, connected, answering, error, onRespond }: { ask: PendingAsk; connected: boolean; answering: boolean; error?: string; onRespond(optionId: string): void }) {
  const { palette } = useTheme();
  const options = ask.kind === "permission" ? ask.options ?? [] : [];
  return <Card style={[styles.permission, { borderColor: `${palette.warning}66` }]}><Text style={[styles.permissionLabel, { color: palette.warning }]}>Permission waiting</Text><Text style={[styles.cardTitle, { color: palette.ink }]}>{ask.title ?? ask.toolName ?? "Permission request"}</Text>{ask.description ? <Text style={[styles.body, { color: palette.muted }]}>{ask.description}</Text> : null}{ask.input !== undefined ? <Text selectable style={[styles.monoSmall, { color: palette.muted }]}>{safeJson(ask.input)}</Text> : null}{options.length ? <View style={styles.permissionActions}>{options.map((option) => <Button key={option.id} label={option.label} kind={option.kind === "deny" ? "danger" : option.kind === "allow_once" ? "primary" : "secondary"} disabled={!connected || answering} onPress={() => onRespond(option.id)} style={styles.permissionAction} />)}</View> : <Text style={[styles.body, { color: palette.muted }]}>Answer this request from the terminal view or your Mac.</Text>}{!connected ? <Text style={[styles.permissionHint, { color: palette.warning }]}>Reconnect before answering.</Text> : null}{error ? <Text style={[styles.permissionHint, { color: palette.danger }]}>{error} The request may have lapsed; check the terminal view.</Text> : null}</Card>;
}

function TurnCard({ turn }: { turn: Turn }) {
  const { palette } = useTheme();
  return <View style={styles.turn}>{turn.prompt ? <View style={[styles.promptBubble, { backgroundColor: palette.selected }]}><Text selectable style={[styles.body, { color: palette.ink }]}>{turn.prompt.text}</Text></View> : null}<View style={styles.work}>{turn.work.map((item) => <WorkRow key={item.key} item={item} />)}{turn.finalText ? <Text selectable style={[styles.body, { color: palette.ink }]}>{turn.finalText}</Text> : null}</View></View>;
}

function WorkRow({ item }: { item: WorkItem }) {
  const { palette } = useTheme();
  if (item.kind === "text") return <Text selectable style={[styles.body, { color: palette.ink }]}>{item.text}</Text>;
  if (item.kind === "reasoning") return <Text selectable style={[styles.reasoning, { color: palette.muted }]}>{item.text}</Text>;
  if (item.kind === "tool") return <View style={[styles.tool, { backgroundColor: palette.raised }]}><TerminalIcon size={14} color={palette.muted} /><Text numberOfLines={2} style={[styles.toolText, { color: palette.muted }]}>{item.call.title ?? item.call.name}{item.call.abandoned ? " · stopped" : ""}</Text></View>;
  if (item.kind === "tool_group") return <View style={[styles.tool, { backgroundColor: palette.raised }]}><TerminalIcon size={14} color={palette.muted} /><Text style={[styles.toolText, { color: palette.muted }]}>{item.name} · {item.calls.length} calls</Text></View>;
  if (item.kind === "error") return <Text selectable style={[styles.body, { color: palette.danger }]}>{item.text}</Text>;
  if (item.kind === "queued") return <Text style={[styles.reasoning, { color: palette.muted }]}>Queued · {item.text}</Text>;
  if (item.kind === "decision") return <Text style={[styles.reasoning, { color: item.allowed ? palette.success : palette.danger }]}>{item.label}</Text>;
  if (item.kind === "subagent") return <Text style={[styles.reasoning, { color: palette.muted }]}>{item.label ?? "Background agent"} · {item.done ? "done" : "working"}</Text>;
  if (item.kind === "compaction") return <Text style={[styles.reasoning, { color: palette.muted }]}>Context compacted</Text>;
  if (item.kind === "retry") return <Text style={[styles.reasoning, { color: palette.warning }]}>Retrying · {item.attempt}/{item.maxRetries}</Text>;
  return <Text style={[styles.reasoning, { color: palette.muted }]}>{item.text}</Text>;
}

function NoteCard({ note }: { note: ChatNote }) {
  const { palette } = useTheme();
  return <Card style={styles.note}><Text style={[styles.noteAuthor, { color: palette.accent }]}>{note.author.displayName ?? "Participant"} · note</Text><Text selectable style={[styles.body, { color: palette.ink }]}>{note.body}</Text></Card>;
}

function TerminalPane({ sessionId, tabId, connected }: { sessionId: string; tabId: string; connected: boolean }) {
  const app = useApp();
  const { palette } = useTheme();
  const [output, setOutput] = useState("");
  const [mode, setModeState] = useState<"direct" | "buffered">(() => terminalModes.get(tabId) ?? "direct");
  const [input, setInput] = useState("");
  const [inputEnabled, setInputEnabled] = useState(true);
  const outputRef = useRef("");
  const setMode = (next: "direct" | "buffered") => { terminalModes.set(tabId, next); setModeState(next); };

  useEffect(() => {
    if (!connected) return;
    void app.api.readTerminal(sessionId, tabId).then((text) => { if (text !== null) { outputRef.current = text; setOutput(text); } });
    const stream = app.api.subscribeTerminal(sessionId, tabId, (value) => {
      const next = value.type === "scrollback" || value.type === "resized" ? value.serialized : value.type === "data" ? value.chunk : undefined;
      if (typeof next !== "string") return;
      outputRef.current = value.type === "data" ? `${outputRef.current}${next}`.slice(-100_000) : next.slice(-100_000);
      setOutput(outputRef.current);
    });
    const events = app.connection.onEvent((message) => {
      if (message.method !== "terminal.output") return;
      const params = message.params as { tabId?: unknown; text?: unknown } | null;
      if (params?.tabId === tabId && typeof params.text === "string") {
        outputRef.current = `${outputRef.current}${params.text}`.slice(-100_000);
        setOutput(outputRef.current);
      }
    });
    return () => { stream(); events(); };
  }, [app.api, app.connection, connected, sessionId, tabId]);

  useEffect(() => () => { void app.api.releaseInput(sessionId, tabId); }, [app.api, sessionId, tabId]);

  const write = async (text: string) => {
    if (!connected || !text) return false;
    const accepted = await app.api.queueInput(sessionId, tabId, text);
    if (!accepted) setInputEnabled(false);
    return accepted;
  };

  return <View style={styles.flex}><View style={[styles.terminalHeader, { borderColor: palette.border }]}><View><Text style={[styles.cardTitle, { color: palette.ink }]}>Live terminal</Text><Text style={[styles.detail, { color: connected ? palette.success : palette.warning }]}>{connected ? inputEnabled ? "Input available · mobile driving" : "Read-only · write refused" : "Offline · input retained"}</Text></View><View style={[styles.segment, { backgroundColor: palette.raised, marginHorizontal: 0, marginTop: 0 }]}><Segment label="Direct" selected={mode === "direct"} onPress={() => setMode("direct")} /><Segment label="Buffered" selected={mode === "buffered"} onPress={() => setMode("buffered")} /></View></View><FlatList data={output.split("\n")} keyExtractor={(_, index) => String(index)} renderItem={({ item }) => <Text selectable style={[styles.terminalText, { color: "#e6e3df" }]}>{item || " "}</Text>} style={{ backgroundColor: palette.terminal }} contentContainerStyle={styles.terminalOutput} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" />
    <View style={[styles.terminalInputBar, { backgroundColor: palette.card, borderColor: palette.border }]}><TextInput value={input} onChangeText={(value) => { if (mode === "direct" && connected && inputEnabled) { const addition = value.startsWith(input) ? value.slice(input.length) : value; setInput(""); void write(addition); } else setInput(value); }} onKeyPress={({ nativeEvent }) => { if (mode === "direct" && connected && inputEnabled && nativeEvent.key === "Backspace" && input.length === 0) void write("\x7f"); }} onSubmitEditing={() => { if (mode === "direct") void write("\r"); }} multiline={mode === "buffered"} autoCapitalize="none" autoCorrect={false} placeholder={mode === "direct" ? "Tap to type directly" : "Command"} placeholderTextColor={palette.faint} style={[styles.terminalInput, { color: palette.ink, borderColor: palette.border }]} />{mode === "buffered" || input.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="Send terminal input" disabled={!connected || !inputEnabled || !input} onPress={() => void write(input).then((accepted) => { if (accepted) setInput(""); })} style={[styles.send, { backgroundColor: palette.accent, opacity: !connected || !inputEnabled || !input ? 0.38 : 1 }]}><ChevronUp size={19} color={palette.accentInk} /></Pressable> : null}</View>
  </View>;
}

function itemTime(item: { kind: "turn"; turn: Turn } | { kind: "note"; note: ChatNote }) { return item.kind === "turn" ? Date.parse(item.turn.prompt?.ts ?? item.turn.completed?.ts ?? "") || item.turn.seq : item.note.createdAt; }
function isAgentEvent(value: unknown): value is AgentEvent { return !!value && typeof value === "object" && Number.isSafeInteger((value as AgentEvent).seq) && typeof (value as AgentEvent).tabId === "string"; }
function safeJson(value: unknown) { try { return JSON.stringify(value, null, 2).slice(0, 2_000); } catch { return "Input unavailable"; } }

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: "center" },
  segment: { flexDirection: "row", padding: 3, borderRadius: 10, marginHorizontal: 16, marginTop: 8 },
  segmentItem: { minHeight: 36, minWidth: 76, flex: 1, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  transcript: { padding: 16, paddingBottom: 24, gap: 16 },
  turn: { gap: 11 },
  promptBubble: { alignSelf: "flex-end", maxWidth: "88%", borderRadius: 17, borderBottomRightRadius: 5, paddingHorizontal: 14, paddingVertical: 11 },
  work: { gap: 10, paddingHorizontal: 3 },
  body: { fontSize: 15, lineHeight: 22 },
  reasoning: { fontSize: 13, fontStyle: "italic", lineHeight: 19 },
  tool: { minHeight: 38, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 11, paddingVertical: 8 },
  toolText: { flex: 1, fontSize: 13 },
  note: { padding: 13, gap: 6 },
  noteAuthor: { fontSize: 12, fontWeight: "700" },
  permission: { padding: 15, gap: 7, marginTop: 10 },
  permissionLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  permissionActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  permissionAction: { minHeight: 40, flexGrow: 1 },
  permissionHint: { fontSize: 12, lineHeight: 17 },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  monoSmall: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, paddingBottom: 12, gap: 8 },
  modeLine: { flexDirection: "row", gap: 6 },
  modeChoice: { minHeight: 30, paddingHorizontal: 9, borderRadius: 8, flexDirection: "row", gap: 5, alignItems: "center" },
  composeLine: { flexDirection: "row", alignItems: "flex-end", gap: 9 },
  composeInput: { flex: 1, maxHeight: 120, minHeight: 42, paddingHorizontal: 10, paddingVertical: 9, fontSize: 16 },
  send: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  terminalHeader: { padding: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  detail: { fontSize: 12, marginTop: 2 },
  terminalOutput: { paddingHorizontal: 11, paddingVertical: 13 },
  terminalText: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
  terminalInputBar: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, flexDirection: "row", gap: 8, alignItems: "flex-end" },
  terminalInput: { flex: 1, minHeight: 42, maxHeight: 100, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
});
