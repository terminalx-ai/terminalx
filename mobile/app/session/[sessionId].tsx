import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile } from "expo-file-system";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronUp, FileText, Paperclip, Radio, Send, Terminal as TerminalIcon, X } from "lucide-react-native";
import { buildTranscript, type PendingAsk, type Turn, type WorkItem } from "@terminalx/portable/transcript";
import type { AgentEvent } from "@terminalx/portable/events";
import { mergeEvents, readTranscriptCache, writeTranscriptCache, type AttachmentInput, type ChatNote } from "@mobile/data/host-api";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";
import { conversationKey, conversationLabel, statusLabel, type ConversationTab } from "@mobile/data/conversations";
import { useConversationState } from "@mobile/state/conversation-state";

// Keep the mobile terminal unavailable until its rendering and input are ready.
const MOBILE_TERMINAL_ENABLED = false;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 8;

interface MobileAttachment extends AttachmentInput {
  id: string;
  uri: string;
  size: number;
}

export default function SessionScreen() {
  const params = useLocalSearchParams<{ sessionId: string; tabId?: string; hostId?: string; title?: string }>();
  const router = useRouter();
  const sessionId = params.sessionId;
  const app = useApp();
  const { palette } = useTheme();
  const summary = app.sessions.find((item) => item.id === sessionId);
  const tabId = params.tabId ?? summary?.tabs[0]?.id ?? "";
  const [view, setView] = useState<"chat" | "terminal">("chat");

  if (!app.activeHost || !tabId || (params.hostId && params.hostId !== app.activeHost.id)) return <View style={[styles.center, { backgroundColor: palette.page }]}><EmptyState title="Session unavailable" detail="Reconnect to its Mac and open this session again." /></View>;
  const key = conversationKey(app.activeHost.id, sessionId, tabId);
  const available = !summary || summary.tabs.some((tab) => tab.id === tabId);
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <ConversationSelector key={JSON.stringify([app.activeHost.id, sessionId])} tabs={summary?.tabs ?? []} tabId={tabId} onSelect={(tabId) => router.setParams({ tabId, hostId: app.activeHost!.id })} />
    {!available ? <Text style={{ color: palette.warning, paddingHorizontal: 16 }}>This conversation is no longer available on the Mac.</Text> : null}
    {MOBILE_TERMINAL_ENABLED ? <View style={[styles.segment, { backgroundColor: palette.raised }]}><Segment label="Chat" selected={view === "chat"} onPress={() => setView("chat")} /><Segment label="Terminal" selected={view === "terminal"} onPress={() => setView("terminal")} /></View> : null}
    {!MOBILE_TERMINAL_ENABLED || view === "chat" ? <ChatPane key={key} hostId={app.activeHost.id} sessionId={sessionId} tabId={tabId} connected={available && app.connectionStage === "connected"} /> : <TerminalPane key={key} hostId={app.activeHost.id} sessionId={sessionId} tabId={tabId} connected={available && app.connectionStage === "connected"} />}
  </View>;
}

function ConversationSelector({ tabs, tabId, onSelect }: { tabs: ConversationTab[]; tabId: string; onSelect(tabId: string): void }) {
  const { palette } = useTheme();
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});
  useEffect(() => { scroll.current?.scrollTo({ x: offsets.current[tabId] ?? 0, animated: false }); }, [tabId]);
  return <ScrollView ref={scroll} horizontal style={styles.agentSelector} contentContainerStyle={styles.agentChoices}>
    {tabs.map((tab) => <Pressable key={tab.id} accessibilityRole="button" accessibilityState={{ selected: tab.id === tabId }} onPress={() => onSelect(tab.id)} onLayout={({ nativeEvent }) => {
      offsets.current[tab.id] = nativeEvent.layout.x;
      if (tab.id === tabId) scroll.current?.scrollTo({ x: nativeEvent.layout.x, animated: false });
    }} style={[styles.agentChoice, { backgroundColor: tab.id === tabId ? palette.selected : palette.raised }]}>
      <Text numberOfLines={2} style={{ color: palette.ink, fontWeight: "600" }}>{conversationLabel(tab, tabs)}</Text>
      <Text style={{ color: palette.muted, fontSize: 12 }}>{statusLabel(tab.status)}</Text>
    </Pressable>)}
  </ScrollView>;
}

function Segment({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.segmentItem, selected && { backgroundColor: palette.card }]}><Text style={{ color: selected ? palette.ink : palette.muted, fontWeight: selected ? "600" : "500" }}>{label}</Text></Pressable>;
}

function ChatPane({ hostId, sessionId, tabId, connected }: { hostId: string; sessionId: string; tabId: string; connected: boolean }) {
  const app = useApp();
  const { palette } = useTheme();
  const stateKey = conversationKey(hostId, sessionId, tabId);
  const [events, setEvents] = useConversationState<AgentEvent[]>(`${stateKey}:events`, []);
  const [notes, setNotes] = useConversationState<ChatNote[]>(`${stateKey}:notes`, []);
  const [hasMore, setHasMore] = useConversationState(`${stateKey}:hasMore`, false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useConversationState(`${stateKey}:draft`, "");
  const [sendToAgent, setSendToAgent] = useConversationState(`${stateKey}:sendToAgent`, true);
  const [sending, setSending] = useConversationState(`${stateKey}:sending`, false);
  const [sendFeedback, setSendFeedback] = useConversationState<{ kind: "error" | "success"; message: string } | null>(`${stateKey}:sendFeedback`, null);
  const [attachments, setAttachments] = useConversationState<MobileAttachment[]>(`${stateKey}:attachments`, []);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [answeringPermission, setAnsweringPermission] = useConversationState<string | null>(`${stateKey}:answeringPermission`, null);
  const [permissionErrors, setPermissionErrors] = useConversationState<Record<string, string>>(`${stateKey}:permissionErrors`, {});
  const draftEdited = useRef(false);
  const cacheKey = `terminalx:draft:${hostId}:${sessionId}:${tabId}`;
  const transcript = useMemo(() => buildTranscript(events, connected), [connected, events]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const cached = await readTranscriptCache(hostId, sessionId, tabId);
      if (!active) return;
      setEvents((existing) => mergeEvents(cached, existing));
      if (connected) {
        const page = await app.api.tail(sessionId, tabId);
        if (!active) return;
        if (page) {
          setEvents((existing) => mergeEvents(existing, page.events));
          setHasMore(page.hasMore);
        }
        const notes = await app.api.listNotes(sessionId);
        if (!active) return;
        setNotes(notes);
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [app.api, connected, hostId, sessionId, tabId, setEvents, setHasMore, setNotes]);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(cacheKey).then((value) => {
      if (active && !draftEdited.current && value) setDraft((current) => current || value);
    });
    return () => { active = false; };
  }, [cacheKey, setDraft]);
  useEffect(() => { if (events.length) void writeTranscriptCache(hostId, sessionId, tabId, events); }, [events, hostId, sessionId, tabId]);
  useEffect(() => {
    let active = true;
    const stream = app.api.subscribeSession(tabId, (event) => { if (active) setEvents((existing) => mergeEvents(existing, [event])); });
    const events = app.connection.onEvent((message) => {
    if (!active) return;
    if (message.method === "session.event") {
      const event = (message.params as { event?: unknown } | null)?.event;
      if (isAgentEvent(event) && event.tabId === tabId) setEvents((existing) => mergeEvents(existing, [event]));
    }
    if (message.method === "chat.changed") void app.api.listNotes(sessionId).then((notes) => { if (active) setNotes(notes); });
    });
    return () => { active = false; stream(); events(); };
  }, [app.api, app.connection, sessionId, tabId, setEvents, setNotes]);

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
    if ((!text && !attachments.length) || !connected || sending) return;
    draftEdited.current = true;
    setSending(true);
    setSendFeedback(null);
    const showError = (message: string) => {
      setSendFeedback({ kind: "error", message: `Message not sent: ${message}` });
      app.connection.reportError("Session message failed", message);
    };
    try {
      const inputs = attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
      if (sendToAgent && !text) {
        const sent = await app.api.sendSession(tabId, "", inputs);
        if (!sent.sent) return showError(sent.message);
        setSendFeedback({ kind: "success", message: sent.queued ? "Queued for the agent." : "Sent to the agent." });
        setDraft("");
        setAttachments([]);
        setAttachmentError(null);
        await AsyncStorage.removeItem(cacheKey);
        return;
      }
      const posted = await app.api.postNote(sessionId, text);
      if (!posted.sent) return showError(posted.message);
      setNotes((current) => [...current.filter((note) => note.id !== posted.note.id), posted.note].sort((left, right) => left.createdAt - right.createdAt));
      if (sendToAgent) {
        const promoted = await app.api.promoteNote(sessionId, tabId, posted.note.id, inputs);
        if (!promoted.sent) return showError(promoted.message);
        setSendFeedback({ kind: "success", message: promoted.queued ? "Queued for the agent." : "Sent to the agent." });
      } else {
        setSendFeedback({ kind: "success", message: "Note added." });
      }
      setDraft("");
      setAttachments([]);
      setAttachmentError(null);
      await AsyncStorage.removeItem(cacheKey);
    } catch (error) {
      showError(error instanceof Error ? error.message : "The host could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const pickAttachments = async () => {
    setAttachmentError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: true,
        copyToCacheDirectory: true,
        base64: true,
      });
      if (result.canceled) return;
      const picked: MobileAttachment[] = [];
      let totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
      for (const [index, asset] of result.assets.entries()) {
        if (attachments.length + picked.length >= MAX_ATTACHMENT_COUNT) {
          setAttachmentError(`You can attach up to ${MAX_ATTACHMENT_COUNT} files.`);
          break;
        }
        const mediaType = asset.mimeType?.toLowerCase() || "application/octet-stream";
        const size = asset.size ?? 0;
        if (size && totalBytes + size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError("Attachments may total up to 5 MB.");
          continue;
        }
        const data = asset.base64 ?? await new ExpoFile(asset.uri).base64();
        const actualSize = size || base64Size(data);
        if (totalBytes + actualSize > MAX_ATTACHMENT_BYTES) {
          setAttachmentError("Attachments may total up to 5 MB.");
          continue;
        }
        totalBytes += actualSize;
        picked.push({
          id: `${asset.uri}:${asset.lastModified}:${index}`,
          uri: asset.uri,
          name: asset.name,
          mediaType,
          data,
          size: actualSize,
        });
      }
      if (picked.length) setAttachments((current) => [...current, ...picked]);
    } catch {
      setAttachmentError("This file could not be attached. Please try another file.");
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

  const sendDisabled = !connected || (!draft.trim() && !attachments.length) || sending;
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={92}><FlatList data={items} keyExtractor={(item) => item.kind === "turn" ? item.turn.key : `note-${item.note.id}`} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.transcript} keyboardDismissMode="interactive" ListHeaderComponent={hasMore ? <Button label="Load earlier" kind="secondary" disabled={!connected} onPress={() => void loadEarlier()} /> : null} ListEmptyComponent={loading ? <EmptyState title="Loading transcript" detail="Reading the latest turns from your Mac." busy /> : <EmptyState title="No transcript yet" detail="This tab has not published any turns." />} renderItem={({ item }) => item.kind === "turn" ? <TurnCard turn={item.turn} /> : <NoteCard note={item.note} />} ListFooterComponent={<>{transcript.pendingAsks.map((ask) => <PermissionCard key={ask.requestId} ask={ask} connected={connected} answering={answeringPermission === ask.requestId} error={permissionErrors[ask.requestId]} onRespond={(optionId) => void respondPermission(ask, optionId)} />)}</>} /><View style={[styles.composer, { backgroundColor: palette.card, borderColor: palette.border }]}><View style={styles.modeLine}><Pressable onPress={() => { setSendToAgent(true); setSendFeedback(null); }} style={[styles.modeChoice, sendToAgent && { backgroundColor: palette.selected }]}><Radio size={15} color={sendToAgent ? palette.accent : palette.muted} /><Text style={{ color: sendToAgent ? palette.ink : palette.muted, fontSize: 12 }}>Send to agent</Text></Pressable><Pressable accessibilityState={{ disabled: attachments.length > 0 }} disabled={attachments.length > 0} onPress={() => { setSendToAgent(false); setSendFeedback(null); }} style={[styles.modeChoice, !sendToAgent && { backgroundColor: palette.selected }, attachments.length > 0 && styles.disabled]}><Text style={{ color: !sendToAgent ? palette.ink : palette.muted, fontSize: 12 }}>Add worktree note</Text></Pressable></View>{attachments.length ? <View style={styles.attachments}>{attachments.map((attachment) => <View key={attachment.id} style={styles.attachment}>{attachment.mediaType.startsWith("image/") ? <Image source={{ uri: attachment.uri }} accessibilityLabel={attachment.name} style={styles.attachmentImage} /> : <View accessibilityLabel={attachment.name} style={[styles.attachmentImage, styles.fileAttachment, { backgroundColor: palette.raised }]}><FileText size={22} color={palette.muted} /><Text numberOfLines={1} style={[styles.fileAttachmentName, { color: palette.muted }]}>{attachment.name}</Text></View>}<Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} style={styles.removeAttachment}><X size={13} color="#fff" /></Pressable></View>)}</View> : null}{attachmentError ? <Text style={[styles.attachmentError, { color: palette.danger }]}>{attachmentError}</Text> : null}{sendFeedback ? <Text accessibilityLiveRegion="polite" style={[styles.sendFeedback, { color: sendFeedback.kind === "error" ? palette.danger : palette.success }]}>{sendFeedback.message}</Text> : null}<View style={styles.composeLine}>{sendToAgent ? <Pressable accessibilityRole="button" accessibilityLabel="Attach file" disabled={sending} onPress={() => void pickAttachments()} style={[styles.attach, { backgroundColor: palette.raised }, sending && styles.disabled]}><Paperclip size={19} color={palette.muted} /></Pressable> : null}<TextInput value={draft} onChangeText={(value) => { draftEdited.current = true; setDraft(value); setSendFeedback(null); void AsyncStorage.setItem(cacheKey, value); }} multiline placeholder={connected ? "Message this session" : "Draft kept while offline"} placeholderTextColor={palette.faint} style={[styles.composeInput, { color: palette.ink }]} /><Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={sendDisabled} onPress={() => void send()} style={[styles.send, { backgroundColor: palette.accent, opacity: sendDisabled ? 0.38 : 1 }]}><Send size={18} color={palette.accentInk} /></Pressable></View></View></KeyboardAvoidingView>;
}

function base64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function PermissionCard({ ask, connected, answering, error, onRespond }: { ask: PendingAsk; connected: boolean; answering: boolean; error?: string; onRespond(optionId: string): void }) {
  const { palette } = useTheme();
  const options = ask.kind === "permission" ? ask.options ?? [] : [];
  return <Card style={[styles.permission, { borderColor: `${palette.warning}66` }]}><Text style={[styles.permissionLabel, { color: palette.warning }]}>Permission waiting</Text><Text style={[styles.cardTitle, { color: palette.ink }]}>{ask.title ?? ask.toolName ?? "Permission request"}</Text>{ask.description ? <Text style={[styles.body, { color: palette.muted }]}>{ask.description}</Text> : null}{ask.input !== undefined ? <Text selectable style={[styles.monoSmall, { color: palette.muted }]}>{safeJson(ask.input)}</Text> : null}{options.length ? <View style={styles.permissionActions}>{options.map((option) => <Button key={option.id} label={option.label} kind={option.kind === "deny" ? "danger" : option.kind === "allow_once" ? "primary" : "secondary"} disabled={!connected || answering} onPress={() => onRespond(option.id)} style={styles.permissionAction} />)}</View> : <Text style={[styles.body, { color: palette.muted }]}>Answer this request from your Mac.</Text>}{!connected ? <Text style={[styles.permissionHint, { color: palette.warning }]}>Reconnect before answering.</Text> : null}{error ? <Text style={[styles.permissionHint, { color: palette.danger }]}>{error} The request may have lapsed; check your Mac.</Text> : null}</Card>;
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

function TerminalPane({ hostId, sessionId, tabId, connected }: { hostId: string; sessionId: string; tabId: string; connected: boolean }) {
  const app = useApp();
  const { palette } = useTheme();
  const stateKey = conversationKey(hostId, sessionId, tabId);
  const [output, setOutput] = useConversationState(`${stateKey}:output`, "");
  const [mode, setMode] = useConversationState<"direct" | "buffered">(`${stateKey}:mode`, "direct");
  const [input, setInput] = useConversationState(`${stateKey}:input`, "");
  const [inputEnabled, setInputEnabled] = useState(true);
  const outputRef = useRef(output);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    let streamed = false;
    void app.api.readTerminal(sessionId, tabId).then((text) => { if (active && !streamed && text !== null) { outputRef.current = text.slice(-100_000); setOutput(outputRef.current); } });
    const stream = app.api.subscribeTerminal(sessionId, tabId, (value) => {
      if (!active) return;
      const next = value.type === "scrollback" || value.type === "resized" ? value.serialized : value.type === "data" ? value.chunk : undefined;
      if (typeof next !== "string") return;
      streamed = true;
      outputRef.current = value.type === "data" ? `${outputRef.current}${next}`.slice(-100_000) : next.slice(-100_000);
      setOutput(outputRef.current);
    });
    const events = app.connection.onEvent((message) => {
      if (!active || message.method !== "terminal.output") return;
      const params = message.params as { tabId?: unknown; text?: unknown } | null;
      if (params?.tabId === tabId && typeof params.text === "string") {
        streamed = true;
        outputRef.current = `${outputRef.current}${params.text}`.slice(-100_000);
        setOutput(outputRef.current);
      }
    });
    return () => { active = false; stream(); events(); };
  }, [app.api, app.connection, connected, sessionId, tabId, setOutput]);

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
  agentSelector: { flexGrow: 0, flexShrink: 0 },
  agentChoices: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  agentChoice: { maxWidth: 280, padding: 10, borderRadius: 10, gap: 3 },
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
  sendFeedback: { fontSize: 12, lineHeight: 17, paddingHorizontal: 3 },
  composeLine: { flexDirection: "row", alignItems: "flex-end", gap: 9 },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  attachment: { width: 58, height: 58 },
  attachmentImage: { width: 58, height: 58, borderRadius: 9 },
  fileAttachment: { alignItems: "center", justifyContent: "center", padding: 5, gap: 2 },
  fileAttachmentName: { width: 48, fontSize: 8, textAlign: "center" },
  removeAttachment: { position: "absolute", right: -4, top: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: "#252525dd", alignItems: "center", justifyContent: "center" },
  attachmentError: { fontSize: 12, lineHeight: 17 },
  attach: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  composeInput: { flex: 1, maxHeight: 120, minHeight: 42, paddingHorizontal: 10, paddingVertical: 9, fontSize: 16 },
  send: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  terminalHeader: { padding: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  detail: { fontSize: 12, marginTop: 2 },
  terminalOutput: { paddingHorizontal: 11, paddingVertical: 13 },
  terminalText: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
  terminalInputBar: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, flexDirection: "row", gap: 8, alignItems: "flex-end" },
  terminalInput: { flex: 1, minHeight: 42, maxHeight: 100, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
});
