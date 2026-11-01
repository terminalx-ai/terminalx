import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile } from "expo-file-system";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronUp, FileText, Paperclip, Radio, Send, X } from "lucide-react-native";
import { buildTranscript, type PendingAsk } from "@terminalx/portable/transcript";
import type { AgentEvent } from "@terminalx/portable/events";
import { mergeEvents, type AttachmentInput, type ChatNote } from "@mobile/data/host-api";
import { draftContent, draftIdFor, readDraftId, type DraftId } from "@mobile/data/draft-id";
import { retryHaltedTranscript, TranscriptHaltedError, watchTranscript } from "@mobile/data/transcript-sync";
import { useApp } from "@mobile/state/AppProvider";
import type { ConnectionStage } from "@mobile/transport/connection";
import { canRetry, connectionProblem, mayHaveArrived, problemText } from "@mobile/transport/connection-errors";
import { Button, Card, EmptyState } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";
import { conversationKey } from "@mobile/data/conversations";
import { agentConversations } from "@mobile/data/session-navigation";
import { ConversationPicker } from "@mobile/ui/ConversationPicker";
import { LinkedText } from "@mobile/ui/LinkedText";
import { PermissionCard, TranscriptRow } from "@mobile/ui/transcript";
import { conversationItems } from "@mobile/ui/conversation-items";
import { TranscriptList } from "@mobile/ui/TranscriptList";
import { useConversationState } from "@mobile/state/conversation-state";
import { FOREGROUND as TERMINAL_FOREGROUND, TerminalScreen, type Row as ScreenRow } from "@mobile/terminal/screen";
import { controlSequence, keySequence, pasteSequence, type TerminalKey } from "@mobile/terminal/keys";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 8;
/** Failed reconnect attempts before the transcript card stops saying "Reconnecting" and says the Mac isn't reachable. */
const UNREACHABLE_AFTER_ATTEMPTS = 5;

interface MobileAttachment extends AttachmentInput {
  id: string;
  uri: string;
  size: number;
}

/** What the transcript card says, and whether its Retry can help. */
interface TranscriptNotice { title: string; detail: string; retry: boolean }

export default function SessionScreen() {
  const params = useLocalSearchParams<{ sessionId: string; tabId?: string; hostId?: string; title?: string }>();
  const router = useRouter();
  const sessionId = params.sessionId;
  const app = useApp();
  const { palette } = useTheme();
  const summary = app.sessions.find((item) => item.id === sessionId);
  const tabId = params.tabId ?? summary?.tabs[0]?.id ?? "";
  const [view, setView] = useState<"chat" | "terminal">("chat");
  // An older Mac neither sizes its terminal output nor opens a tab's terminal: it gets no Terminal view.
  const [terminalOffered, setTerminalOffered] = useState(false);
  useEffect(() => {
    let active = true;
    setTerminalOffered(false);
    void app.api?.features().then((features) => { if (active) setTerminalOffered(features.terminal === 1); }).catch(() => undefined);
    return () => { active = false; };
  }, [app.api, app.activeHost?.id]);
  const terminal = terminalOffered && view === "terminal";

  if (!app.activeHost || !tabId || (params.hostId && params.hostId !== app.activeHost.id)) return <View style={[styles.center, { backgroundColor: palette.page }]}><EmptyState title="Session unavailable" detail="Reconnect to its Mac and open this session again." /></View>;
  const key = conversationKey(app.activeHost.id, sessionId, tabId);
  const conversation = summary ? agentConversations(summary).find((item) => item.id === tabId) : undefined;
  const available = !summary || !!conversation;
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: conversation?.label ?? params.title ?? "Session" }} />
    {summary ? <>
      <Text numberOfLines={1} style={[styles.sessionContext, { color: palette.muted }]}>{summary.title}</Text>
      {summary.tabs.length > 1 ? <ConversationPicker key={JSON.stringify([app.activeHost.id, sessionId])} session={summary} selectedTabId={tabId} horizontal onSelect={({ href }) => router.setParams({ ...href.params, hostId: app.activeHost!.id })} /> : null}
    </> : null}
    {!available ? <Text style={{ color: palette.warning, paddingHorizontal: 16 }}>This conversation is no longer available on the Mac.</Text> : null}
    {terminalOffered ? <View style={[styles.segment, { backgroundColor: palette.raised }]}><Segment label="Chat" selected={view === "chat"} onPress={() => setView("chat")} /><Segment label="Terminal" selected={view === "terminal"} onPress={() => setView("terminal")} /></View> : null}
    {!terminal ? <ChatPane key={key} hostId={app.activeHost.id} sessionId={sessionId} tabId={tabId} available={available} connected={available && app.connectionStage === "connected"} epoch={app.connectionEpoch ?? 0} /> : <TerminalPane key={key} hostId={app.activeHost.id} sessionId={sessionId} tabId={tabId} connected={available && app.connectionStage === "connected"} />}
  </View>;
}

function Segment({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.segmentItem, selected && { backgroundColor: palette.card }]}><Text style={{ color: selected ? palette.ink : palette.muted, fontWeight: selected ? "600" : "500" }}>{label}</Text></Pressable>;
}

function ChatPane({ hostId, sessionId, tabId, available, connected, epoch }: { hostId: string; sessionId: string; tabId: string; available: boolean; connected: boolean; epoch: number }) {
  const app = useApp();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const stateKey = conversationKey(hostId, sessionId, tabId);
  const [events, setEvents] = useConversationState<AgentEvent[]>(`${stateKey}:events`, []);
  const [notes, setNotes] = useConversationState<ChatNote[]>(`${stateKey}:notes`, []);
  const [hasMore, setHasMore] = useConversationState(`${stateKey}:hasMore`, false);
  const [before, setBefore] = useConversationState<number | undefined>(`${stateKey}:before`, undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ cause: unknown } | null>(null);
  const [retry, setRetry] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const earlierRequest = useRef<object | null>(null);
  const [draft, setDraft] = useConversationState(`${stateKey}:draft`, "");
  // The id the draft was last sent under, kept until a send under it succeeds (#675).
  const [draftId, setDraftId] = useConversationState<DraftId | null>(`${stateKey}:draftId`, null);
  const [sendToAgent, setSendToAgent] = useConversationState(`${stateKey}:sendToAgent`, true);
  const [sending, setSending] = useConversationState(`${stateKey}:sending`, false);
  // `resend`: the send failed with the connection, and sending the same draft again can help.
  const [sendFeedback, setSendFeedback] = useConversationState<{ kind: "error" | "success"; message: string; resend?: boolean } | null>(`${stateKey}:sendFeedback`, null);
  const [attachments, setAttachments] = useConversationState<MobileAttachment[]>(`${stateKey}:attachments`, []);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [answeringPermission, setAnsweringPermission] = useConversationState<string | null>(`${stateKey}:answeringPermission`, null);
  const [permissionErrors, setPermissionErrors] = useConversationState<Record<string, string>>(`${stateKey}:permissionErrors`, {});
  const draftEdited = useRef(false);
  const cacheKey = `terminalx:draft:${hostId}:${sessionId}:${tabId}`;
  const draftIdKey = `terminalx:draft-id:${hostId}:${sessionId}:${tabId}`;
  const transcript = useMemo(() => buildTranscript(events, connected), [connected, events]);

  useEffect(() => {
    let receivedPage = false;
    setLoading(true);
    setLoadingEarlier(false);
    setEarlierError(null);
    // While disconnected the card follows the connection stage instead (`transcriptNotice`).
    setLoadError(null);
    const stop = watchTranscript(app.api, hostId, sessionId, tabId, connected, (cache, replace, source) => {
      setEvents((existing) => replace ? cache.events : source === "cache" ? mergeEvents(cache.events, existing) : mergeEvents(existing, cache.events));
      if (source === "page") {
        // Only an authoritative page establishes the backward cursor. Live
        // events and cache eviction must not move it past unrequested history.
        if (!receivedPage || replace) {
          setBefore(cache.events[0]?.seq);
          setHasMore(cache.hasEarlier);
          earlierRequest.current = null;
          setLoadingEarlier(false);
          setEarlierError(null);
        }
        receivedPage = true;
        setLoadError(null);
        setLoading(false);
      } else if (!connected) {
        setLoading(false);
      }
    }, (cause) => {
      setLoading(false);
      setLoadError({ cause });
      app.connection.reportError("Transcript sync failed", cause);
    });
    return () => { stop(); earlierRequest.current = null; };
  }, [app.api, app.connection, connected, epoch, hostId, sessionId, tabId, retry, setEvents, setHasMore, setBefore]);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(cacheKey).then((value) => {
      if (active && !draftEdited.current && value) setDraft((current) => current || value);
    });
    // A draft whose send failed goes again under the same id after the app
    // was closed (#675). Not once the person has typed or sent: a send that
    // succeeded retired the id.
    void AsyncStorage.getItem(draftIdKey).then((value) => {
      const saved = readDraftId(value);
      if (active && !draftEdited.current && saved) setDraftId((current) => current ?? saved);
    });
    return () => { active = false; };
  }, [cacheKey, draftIdKey, setDraft, setDraftId]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = false;
    const refresh = async () => {
      if (!active || !connected) return;
      dirty = true;
      if (running) return;
      running = true;
      try {
        while (dirty && active) {
          dirty = false;
          const notes = await app.api.listNotes(sessionId);
          if (active) setNotes(notes);
        }
      } catch (cause) { app.connection.reportError("Notes refresh failed", cause); }
      finally { running = false; }
    };
    void refresh();
    const detach = app.connection.onEvent((message) => {
      if (message.method !== "chat.changed") return;
      const worktreeId = (message.params as { worktreeId?: string } | null)?.worktreeId;
      if (worktreeId && worktreeId !== sessionId) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    });
    return () => { active = false; clearTimeout(timer); detach(); };
  }, [app.api, app.connection, connected, epoch, sessionId, setNotes]);

  const loadEarlier = async () => {
    if (before === undefined || !connected || loading || earlierRequest.current) return;
    const request = {};
    earlierRequest.current = request;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const page = await app.api.tail(sessionId, tabId, before);
      if (earlierRequest.current !== request) return;
      setEvents((existing) => mergeEvents(existing, page.events));
      setHasMore(page.hasMore);
      setBefore(page.events[0]?.seq);
    } catch (error) {
      if (earlierRequest.current === request) setEarlierError(error instanceof Error ? error.message : "Could not load earlier turns. Try again.");
    } finally {
      if (earlierRequest.current === request) {
        earlierRequest.current = null;
        setLoadingEarlier(false);
      }
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
      // The reply can be lost after the Mac has the message. Sending the same
      // draft again goes under the same id, and a Mac that has it answers as
      // it did the first time instead of taking it twice (#675).
      const sendId = draftIdFor(draftId, draftContent(sendToAgent ? "agent" : "note", text, attachments.map(({ id }) => id)));
      if (sendId !== draftId) {
        setDraftId(sendId);
        // Saved before the message can reach the Mac, for a retry after the app is closed.
        await AsyncStorage.setItem(draftIdKey, JSON.stringify(sendId)).catch(() => undefined);
      }
      // A message for the agent is one request, and the transcript shows it
      // as the turn's prompt. Saving it as a note first showed it twice, and
      // a failed promotion left a note behind for every retry (#541).
      // A failed send leaves the draft and its attachments where they are.
      if (sendToAgent) {
        const inputs = attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
        const sent = await app.api.sendSession(tabId, text, inputs, sendId.id);
        if (!sent.sent) return showError(sent.message);
        setSendFeedback({ kind: "success", message: sent.queued ? "Queued for the agent." : "Sent to the agent." });
      } else {
        const posted = await app.api.postNote(sessionId, text, sendId.id);
        if (!posted.sent) return showError(posted.message);
        setNotes((current) => [...current.filter((note) => note.id !== posted.note.id), posted.note].sort((left, right) => left.createdAt - right.createdAt));
        setSendFeedback({ kind: "success", message: "Note added." });
      }
      setDraft("");
      setDraftId(null);
      setAttachments([]);
      setAttachmentError(null);
      await Promise.all([AsyncStorage.removeItem(cacheKey), AsyncStorage.removeItem(draftIdKey)]);
    } catch (error) {
      const problem = connectionProblem(error);
      if (!problem) return showError(error instanceof Error ? error.message : "The host could not send this message.");
      // The connection failed, not the Mac: say so in plain words, and offer
      // the same draft again for when it is back (#670). The code is logged.
      app.connection.reportError("Session message failed", error);
      // A Mac that never answered most likely has it: sending it again could
      // give the agent the same prompt twice, or add the note twice (#675).
      if (mayHaveArrived(problem)) {
        return setSendFeedback({ kind: "error", message: sendToAgent
          ? `Not confirmed: ${problemText(problem)}, so the message may have reached the agent. Check the conversation before sending it again.`
          : `Not confirmed: ${problemText(problem)}, so the note may have been added. Check the notes before adding it again.` });
      }
      setSendFeedback({ kind: "error", message: `Not sent: ${problemText(problem)}. Your message is still in the box.`, resend: canRetry(problem) });
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

  const items = useMemo(() => conversationItems(transcript.turns, notes, tabId), [notes, tabId, transcript.turns]);

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

  const notice = transcriptNotice(app.connectionStage, app.connectionAttempt, epoch > 0, available, loadError, events.length > 0, loading);
  const retryTranscript = () => {
    // One more read, even of a page that halted after breaking the connection.
    retryHaltedTranscript(hostId, sessionId, tabId);
    if (connected) setRetry((value) => value + 1);
    // Reconnecting: try now rather than after the delay. The reconnect reads the transcript.
    else app.connection.retryNow();
  };
  const noticeCard = notice ? <Card style={styles.notice}>
    <Text accessibilityLiveRegion="polite" style={[styles.noticeTitle, { color: palette.ink }]}>{notice.title}</Text>
    <Text style={[styles.noticeDetail, { color: palette.muted }]}>{notice.detail}</Text>
    <Button label="Retry loading transcript" kind="secondary" disabled={!notice.retry} onPress={retryTranscript} />
  </Card> : null;
  const transcriptHeader = <>
    {earlierError ? <EmptyState title="Could not load earlier turns" detail={earlierError} /> : null}
    {hasMore ? <Button
      label={loadingEarlier ? "Loading earlier…" : earlierError ? "Retry loading earlier" : "Load earlier"}
      kind="secondary"
      disabled={!connected || loading || loadingEarlier || !!loadError}
      onPress={() => void loadEarlier()}
    /> : null}
  </>;
  // With turns on screen the card sits at the latest edge, where the reader is; with none it takes the empty space.
  const emptyTranscript = noticeCard ?? (loading
    ? <EmptyState title="Loading transcript" detail="Reading the latest turns from your Mac." busy />
    : hasMore ? <EmptyState title="Earlier turns available" detail="Load earlier to see the context for these updates." />
      : <EmptyState title="No transcript yet" detail="This tab has not published any turns." />);

  const sendDisabled = !connected || (!draft.trim() && !attachments.length) || sending;
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={92}><TranscriptList data={items} keyExtractor={(item) => item.key} contentContainerStyle={styles.transcriptRows} earlier={transcriptHeader} ListEmptyComponent={emptyTranscript} renderItem={({ item }) => item.kind === "turn" ? <TranscriptRow row={item.row} /> : <NoteCard note={item.note} first={item.first} />} latest={<>{items.length ? noticeCard : null}{transcript.pendingAsks.map((ask) => <PermissionCard key={ask.requestId} ask={ask} connected={connected} answering={answeringPermission === ask.requestId} error={permissionErrors[ask.requestId]} onRespond={(optionId) => void respondPermission(ask, optionId)} />)}</>} /><View style={[styles.composer, { backgroundColor: palette.card, borderColor: palette.border, paddingBottom: insets.bottom + 12 }]}><View style={styles.modeLine}><Pressable onPress={() => { setSendToAgent(true); setSendFeedback(null); }} style={[styles.modeChoice, sendToAgent && { backgroundColor: palette.selected }]}><Radio size={15} color={sendToAgent ? palette.accent : palette.muted} /><Text style={{ color: sendToAgent ? palette.ink : palette.muted, fontSize: 12 }}>Send to agent</Text></Pressable><Pressable accessibilityState={{ disabled: attachments.length > 0 }} disabled={attachments.length > 0} onPress={() => { setSendToAgent(false); setSendFeedback(null); }} style={[styles.modeChoice, !sendToAgent && { backgroundColor: palette.selected }, attachments.length > 0 && styles.disabled]}><Text style={{ color: !sendToAgent ? palette.ink : palette.muted, fontSize: 12 }}>Add worktree note</Text></Pressable></View>{attachments.length ? <View style={styles.attachments}>{attachments.map((attachment) => <View key={attachment.id} style={styles.attachment}>{attachment.mediaType.startsWith("image/") ? <Image source={{ uri: attachment.uri }} accessibilityLabel={attachment.name} style={styles.attachmentImage} /> : <View accessibilityLabel={attachment.name} style={[styles.attachmentImage, styles.fileAttachment, { backgroundColor: palette.raised }]}><FileText size={22} color={palette.muted} /><Text numberOfLines={1} style={[styles.fileAttachmentName, { color: palette.muted }]}>{attachment.name}</Text></View>}<Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} style={styles.removeAttachment}><X size={13} color="#fff" /></Pressable></View>)}</View> : null}{attachmentError ? <Text style={[styles.attachmentError, { color: palette.danger }]}>{attachmentError}</Text> : null}{sendFeedback ? <View style={styles.feedbackLine}><Text accessibilityLiveRegion="polite" style={[styles.sendFeedback, { color: sendFeedback.kind === "error" ? palette.danger : palette.success }]}>{sendFeedback.message}</Text>{sendFeedback.resend ? <Button label="Send again" kind="secondary" disabled={sendDisabled} onPress={() => void send()} style={styles.resend} /> : null}</View> : null}<View style={styles.composeLine}>{sendToAgent ? <Pressable accessibilityRole="button" accessibilityLabel="Attach file" disabled={sending} onPress={() => void pickAttachments()} style={[styles.attach, { backgroundColor: palette.raised }, sending && styles.disabled]}><Paperclip size={19} color={palette.muted} /></Pressable> : null}<TextInput value={draft} onChangeText={(value) => { draftEdited.current = true; setDraft(value); setSendFeedback(null); void AsyncStorage.setItem(cacheKey, value); }} multiline placeholder="Message this session" placeholderTextColor={palette.faint} style={[styles.composeInput, { color: palette.ink }]} /><Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={sendDisabled} onPress={() => void send()} style={[styles.send, { backgroundColor: palette.accent, opacity: sendDisabled ? 0.38 : 1 }]}><Send size={18} color={palette.accentInk} /></Pressable></View></View></KeyboardAvoidingView>;
}

/**
 * What the transcript card says (#670): what is happening, in plain words.
 * Reconnecting keeps whatever this phone saved on screen, and Retry stays
 * available whenever it can help.
 */
function transcriptNotice(stage: ConnectionStage, attempt: number, everConnected: boolean, available: boolean, loadError: { cause: unknown } | null, saved: boolean, loading: boolean): TranscriptNotice | null {
  // The page above already says this conversation is gone from the Mac.
  if (!available) return null;
  // Reconnecting would only ask for the same read again.
  if (loadError?.cause instanceof TranscriptHaltedError) return { title: "Could not load transcript", detail: loadError.cause.message, retry: true };
  if (stage !== "connected") {
    const shown = saved ? "Showing the transcript saved on this phone." : "The transcript loads once the phone is connected.";
    if (attempt >= UNREACHABLE_AFTER_ATTEMPTS) return { title: "Your Mac isn't reachable", detail: `Check that your Mac is awake and TerminalX is open; the phone keeps trying. ${shown}`, retry: true };
    return { title: everConnected ? "Reconnecting to your Mac…" : "Connecting to your Mac…", detail: shown, retry: true };
  }
  if (!loadError) return null;
  const problem = connectionProblem(loadError.cause);
  const detail = problem ? `${capitalize(problemText(problem))}.` : loadError.cause instanceof Error ? loadError.cause.message : "Could not load the transcript. Try again.";
  return { title: "Could not load transcript", detail, retry: !loading && (!problem || canRetry(problem)) };
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function base64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function NoteCard({ note, first }: { note: ChatNote; first: boolean }) {
  const { palette } = useTheme();
  return <Card style={styles.note}>{first ? <Text style={[styles.noteAuthor, { color: palette.accent }]}>{note.author.displayName ?? "Participant"} · note</Text> : null}<LinkedText style={[styles.body, { color: palette.ink }]}>{note.body}</LinkedText></Card>;
}

/** The keys a phone keyboard lacks, in the order a terminal user reaches for them. */
const TERMINAL_KEYS: { key: TerminalKey; label: string; name: string }[] = [
  { key: "escape", label: "esc", name: "Escape" }, { key: "tab", label: "tab", name: "Tab" },
  { key: "up", label: "↑", name: "Up" }, { key: "down", label: "↓", name: "Down" }, { key: "left", label: "←", name: "Left" }, { key: "right", label: "→", name: "Right" },
  { key: "enter", label: "⏎", name: "Enter" },
];

/**
 * The tab's terminal, as on the desktop: the agent's own screen, emulated
 * here from the pane's output at the pane's size, and typing that holds the
 * tab's driver lease (the desktop cannot type into it meanwhile) until this
 * view goes away. Opening it starts the tab's agent in its terminal, and moves
 * a native Codex tab to Codex's own terminal for good, as the desktop does.
 */
function TerminalPane({ hostId, sessionId, tabId, connected }: { hostId: string; sessionId: string; tabId: string; connected: boolean }) {
  const app = useApp();
  const { palette } = useTheme();
  const stateKey = conversationKey(hostId, sessionId, tabId);
  const [mode, setMode] = useConversationState<"direct" | "buffered">(`${stateKey}:mode`, "direct");
  const [input, setInput] = useConversationState(`${stateKey}:input`, "");
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const [opening, setOpening] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const screen = useRef<TerminalScreen | null>(null);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    let unsubscribe = () => {};
    let frame: ReturnType<typeof setTimeout> | null = null;
    // Output is parsed in order, and drawn at most every 50 ms however fast it comes.
    let parsed = Promise.resolve();
    const draw = () => { if (!frame) frame = setTimeout(() => { frame = null; if (active && screen.current) setRows(screen.current.lines()); }, 50); };
    const apply = (step: (current: TerminalScreen) => void | Promise<void>) => {
      parsed = parsed.then(async () => { if (active && screen.current) await step(screen.current); }).then(draw, draw);
    };
    setOpening(true);
    setProblem(null);
    const ended = app.connection.onEvent((message) => {
      if (active && message.method === "terminal.closed") setProblem((message.params as { message?: string } | null)?.message ?? "The Mac ended the terminal view.");
    });
    void app.api.openTerminal(sessionId, tabId).then((opened) => {
      if (!active) return;
      setOpening(false);
      if (!opened.opened) { setProblem(opened.message); return; }
      unsubscribe = app.api.subscribeTerminal(sessionId, tabId, (packet) => {
        if (!active) return;
        if (packet.type === "error") setProblem(packet.message ?? "The Mac ended the terminal view.");
        else if (packet.type === "scrollback") {
          // A new subscription (also after a reconnect) starts from the retained output.
          screen.current?.dispose();
          screen.current = new TerminalScreen(packet.cols ?? 80, packet.rows ?? 24);
          setProblem(null);
          apply((current) => current.write(packet.serialized ?? ""));
        } else if (packet.type === "resized" && packet.cols && packet.rows) apply((current) => current.resize(packet.cols!, packet.rows!));
        else if (packet.type === "data" && packet.chunk) apply((current) => current.write(packet.chunk!));
      });
    }, (cause: unknown) => { if (active) { setOpening(false); setProblem(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { active = false; if (frame) clearTimeout(frame); ended(); unsubscribe(); screen.current?.dispose(); screen.current = null; };
  }, [app.api, app.connection, connected, sessionId, tabId, attempt]);

  useEffect(() => () => { void app.api.releaseInput(sessionId, tabId); }, [app.api, sessionId, tabId]);

  const modes = () => screen.current?.modes() ?? { bracketedPaste: false, applicationCursorKeys: false };
  const live = connected && !opening && !problem;
  const write = async (text: string) => {
    if (!live || !text) return false;
    const result = await app.api.queueInput(sessionId, tabId, text);
    setRefusal(result.accepted ? null : result.message);
    return result.accepted;
  };
  /** What was typed in direct mode: a character, or with Ctrl held its control code. */
  const typed = (text: string) => {
    if (control && text.length === 1) {
      setControl(false);
      const code = controlSequence(text);
      if (code) return void write(code);
    }
    void write(text);
  };

  const status = !connected ? "Offline · input kept" : opening ? "Opening the terminal…" : problem ? "Unavailable" : refusal ? "Input refused" : "Live · typing here pauses desktop typing";
  return <View style={styles.flex}>
    <View style={[styles.terminalHeader, { borderColor: palette.border }]}><View style={styles.flex}><Text style={[styles.cardTitle, { color: palette.ink }]}>Terminal</Text><Text style={[styles.detail, { color: live && !refusal ? palette.success : palette.warning }]}>{status}</Text></View><View style={[styles.segment, { backgroundColor: palette.raised, marginHorizontal: 0, marginTop: 0 }]}><Segment label="Direct" selected={mode === "direct"} onPress={() => setMode("direct")} /><Segment label="Buffered" selected={mode === "buffered"} onPress={() => setMode("buffered")} /></View></View>
    {problem ? <Card style={styles.notice}><Text style={[styles.noticeTitle, { color: palette.ink }]}>The terminal isn't available</Text><Text style={[styles.noticeDetail, { color: palette.muted }]}>{problem}</Text><Button label="Try again" kind="secondary" disabled={!connected} onPress={() => setAttempt((n) => n + 1)} style={styles.resend} /></Card> : null}
    {refusal ? <Text style={[styles.sendFeedback, { color: palette.danger, flex: 0, paddingHorizontal: 16, paddingVertical: 6 }]}>{refusal}</Text> : null}
    <ScrollView horizontal style={{ flex: 1, backgroundColor: palette.terminal }} contentContainerStyle={{ flexGrow: 1 }}>
      <FlatList inverted data={[...rows].reverse()} keyExtractor={(row) => row.key} renderItem={({ item }) => <TerminalLine row={item} />} contentContainerStyle={styles.terminalOutput} />
    </ScrollView>
    <View style={[styles.terminalKeys, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Control" accessibilityState={{ selected: control }} disabled={!live} onPress={() => setControl((held) => !held)} style={[styles.terminalKey, { backgroundColor: control ? palette.accent : palette.raised }]}><Text style={[styles.terminalKeyText, { color: control ? palette.accentInk : palette.ink }]}>ctrl</Text></Pressable>
      {TERMINAL_KEYS.map(({ key, label, name }) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={name} disabled={!live} onPress={() => void write(keySequence(key, modes()))} style={[styles.terminalKey, { backgroundColor: palette.raised }]}><Text style={[styles.terminalKeyText, { color: palette.ink }]}>{label}</Text></Pressable>)}
    </View>
    <View style={[styles.terminalInputBar, { backgroundColor: palette.card, borderColor: palette.border }]}><TextInput value={input} onChangeText={(value) => { if (mode === "direct" && live) { const addition = value.startsWith(input) ? value.slice(input.length) : value; setInput(""); typed(addition); } else setInput(value); }} onKeyPress={({ nativeEvent }) => { if (mode === "direct" && live && nativeEvent.key === "Backspace" && input.length === 0) void write(keySequence("backspace", modes())); }} onSubmitEditing={() => { if (mode === "direct") void write(keySequence("enter", modes())); }} multiline={mode === "buffered"} autoCapitalize="none" autoCorrect={false} spellCheck={false} smartInsertDelete={false} autoComplete="off" placeholder={mode === "direct" ? "Tap to type directly" : "Text to send, then ⏎"} placeholderTextColor={palette.faint} style={[styles.terminalInput, { color: palette.ink, borderColor: palette.border }]} />{mode === "buffered" || input.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="Send terminal input" disabled={!live || !input} onPress={() => void write(pasteSequence(input, modes())).then((accepted) => { if (accepted) setInput(""); })} style={[styles.send, { backgroundColor: palette.accent, opacity: !live || !input ? 0.38 : 1 }]}><ChevronUp size={19} color={palette.accentInk} /></Pressable> : null}</View>
  </View>;
}

function TerminalLine({ row }: { row: ScreenRow }) {
  // Dim is the colour at 60%: nested text takes a colour, not an opacity.
  return <Text selectable style={[styles.terminalText, { color: TERMINAL_FOREGROUND }]}>{row.spans.map((span, index) => <Text key={index} style={{
    color: span.dim ? `${span.fg ?? TERMINAL_FOREGROUND}99` : span.fg, backgroundColor: span.bg, fontWeight: span.bold ? "700" : undefined,
    fontStyle: span.italic ? "italic" : undefined, textDecorationLine: span.underline ? "underline" : undefined,
  }}>{span.text}</Text>)}</Text>;
}

const styles = StyleSheet.create({
  transcriptRows: { gap: 0 },
  page: { flex: 1 },
  sessionContext: { fontSize: 13, marginHorizontal: 16, marginTop: 4 },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: "center" },
  segment: { flexDirection: "row", padding: 3, borderRadius: 10, marginHorizontal: 16, marginTop: 8 },
  segmentItem: { minHeight: 36, minWidth: 76, flex: 1, borderRadius: 8, alignItems: "center", justifyContent: "center" },
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
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  modeLine: { flexDirection: "row", gap: 6 },
  modeChoice: { minHeight: 30, paddingHorizontal: 9, borderRadius: 8, flexDirection: "row", gap: 5, alignItems: "center" },
  sendFeedback: { flex: 1, fontSize: 12, lineHeight: 17, paddingHorizontal: 3 },
  feedbackLine: { flexDirection: "row", alignItems: "center", gap: 9 },
  resend: { minHeight: 36, paddingHorizontal: 12 },
  notice: { padding: 15, gap: 8 },
  noticeTitle: { fontSize: 15, fontWeight: "700" },
  noticeDetail: { fontSize: 13, lineHeight: 19 },
  composeLine: { flexDirection: "row", alignItems: "flex-end", gap: 9 },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  attachment: { width: 58, height: 58 },
  attachmentImage: { width: 58, height: 58, borderRadius: 9 },
  fileAttachment: { alignItems: "center", justifyContent: "center", padding: 5, gap: 2 },
  fileAttachmentName: { width: 48, fontSize: 8, textAlign: "center" },
  removeAttachment: { position: "absolute", right: -4, top: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: "#252525dd", alignItems: "center", justifyContent: "center" },
  attachmentError: { fontSize: 12, lineHeight: 17 },
  attach: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  composeInput: { flex: 1, maxHeight: 120, minHeight: 42, paddingHorizontal: 10, paddingVertical: 9, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  terminalHeader: { padding: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  detail: { fontSize: 12, marginTop: 2 },
  terminalOutput: { paddingHorizontal: 11, paddingVertical: 13 },
  terminalText: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
  terminalInputBar: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, flexDirection: "row", gap: 8, alignItems: "flex-end" },
  terminalKeys: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8, flexDirection: "row", gap: 6 },
  terminalKey: { minHeight: 34, minWidth: 34, flexGrow: 1, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  terminalKeyText: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13 },
  terminalInput: { flex: 1, minHeight: 42, maxHeight: 100, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
});
