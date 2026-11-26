import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File as ExpoFile } from "expo-file-system";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUp, CornerDownLeft, FileText, Keyboard as KeyboardIcon, Mic, Plus, TextCursorInput, Shield, ShieldAlert, Square, StickyNote, WifiOff, X } from "lucide-react-native";
import { buildTranscript, type PendingAsk } from "@terminalx/portable/transcript";
import type { AgentEvent } from "@terminalx/portable/events";
import { mergeEvents, type AttachmentInput, type ChatNote } from "@mobile/data/host-api";
import { draftContent, draftIdFor, readDraftId, type DraftId } from "@mobile/data/draft-id";
import { retryHaltedTranscript, TranscriptHaltedError, watchTranscript } from "@mobile/data/transcript-sync";
import { useApp } from "@mobile/state/AppProvider";
import { useHostWords, type HostWords } from "@mobile/state/host-words";
import { connectionWords, useConnectionState, type ConnectionState } from "@mobile/state/connection-view";
import { useMachines } from "@mobile/state/useMachines";
import { hostDisplayName } from "@mobile/store/host-name";
import { canRetry, connectionProblem, isTransportError, mayHaveArrived, problemText, screenMessage } from "@mobile/transport/connection-errors";
import { Button, Card, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";
import { useKeyboardShown, keyboardAvoidingBehavior } from "@mobile/ui/keyboard";
import { showChoices } from "@mobile/ui/choices";
import { Glass } from "@mobile/ui/glass";
import { EdgeFade } from "@mobile/ui/EdgeFade";
import { useDictation } from "@mobile/ui/useDictation";
import { Waveform } from "@mobile/ui/Waveform";
import { conversationKey, providerName } from "@mobile/data/conversations";
import { agentConversations } from "@mobile/data/session-navigation";
import { rowName } from "@mobile/data/session-list";
import { ChatTabs, NewChatSheet, SessionHeader } from "@mobile/ui/SessionChrome";
import { SessionNotificationsSheet, useSessionOverride } from "@mobile/ui/notifications/SessionNotifications";
import { LinkedText } from "@mobile/ui/LinkedText";
import { CompactingLine, PermissionCard, QuestionCard, TranscriptRow } from "@mobile/ui/transcript";
import { SessionControls } from "@mobile/ui/SessionControls";
import { StatusLine, statusLineState } from "@mobile/ui/StatusLine";
import { conversationItems } from "@mobile/ui/conversation-items";
import { TranscriptList } from "@mobile/ui/TranscriptList";
import { holdSend, releaseSend, showConversation, takeHeldSend, useConversationState } from "@mobile/state/conversation-state";
import { addPasteImageListener } from "../../modules/paste-image";
import { PromptImageContext } from "@mobile/ui/PromptImages";
import { useHostFeatures } from "@mobile/state/host-features";
import { BotQuestionOver } from "@mobile/ui/BotQuestionSheet";
import { FOREGROUND as TERMINAL_FOREGROUND, TerminalScreen, type Row as ScreenRow } from "@mobile/terminal/screen";
import { controlSequence, keySequence, pasteSequence, type TerminalKey } from "@mobile/terminal/keys";
import { ScreenHistory } from "@mobile/terminal/history";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 8;

interface MobileAttachment extends AttachmentInput {
  id: string;
  uri: string;
  size: number;
}

/** The one slim line above the conversation (#983): only for a real failure, with the one action that can help. */
interface TranscriptNotice { text: string; action: string; onPress(): void }

export default function SessionScreen() {
  const words = useHostWords();
  // `botId` and `item`: a bot's question to show as a sheet over this chat, its home chat (PRO-479).
  const params = useLocalSearchParams<{ sessionId: string; tabId?: string; hostId?: string; title?: string; botId?: string; item?: string }>();
  const router = useRouter();
  const sessionId = params.sessionId;
  const app = useApp();
  const { palette } = useTheme();
  const summary = app.sessions.find((item) => item.id === sessionId);
  const tabId = params.tabId ?? summary?.tabs[0]?.id ?? "";
  const [view, setView] = useState<"chat" | "terminal">("chat");
  // An older Mac, or one whose runtime is older than its app (#730), neither
  // sizes its terminal output nor opens a tab's terminal: it gets no Terminal
  // view. One that gains it while this is open offers it then.
  const features = useHostFeatures(app.api, app.activeHost?.id);
  const state = useConnectionState(app);
  // The machine it runs on, by the name it has on this phone (#987).
  const machineName = useMachines().paired.find((machine) => machine.active)?.name;
  const terminalOffered = features?.terminal === 1;
  const terminal = terminalOffered && view === "terminal";
  const linked = app.connectionStage === "connected";
  // Another chat in this branch, through the Mac's "continue in a new tab", where it takes that.
  // Offered by what the Mac offers, not by the connection: while it is down they stay, dimmed (#983).
  const canAdd = features?.sessionControls === 1;
  const canClose = features?.closeTab === 1;
  // Whether this Mac takes an answer to an agent's question from a phone (#979): null until it has said.
  const answersQuestions = features ? features.questions === 1 : null;
  const [adding, setAdding] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const override = useSessionOverride(app.activeHost?.id ?? "", sessionId);

  if (!app.activeHost || !tabId || (params.hostId && params.hostId !== app.activeHost.id)) return <View style={[styles.center, { backgroundColor: palette.page }]}><EmptyState title="Session unavailable" detail={`Reconnect to ${words.your} and open this session again.`} /></View>;
  const key = conversationKey(app.activeHost.id, sessionId, tabId);
  const conversation = summary ? agentConversations(summary).find((item) => item.id === tabId) : undefined;
  const available = !summary || !!conversation;
  const label = conversation?.label ?? params.title ?? "Session";
  // Named as the session list names it: its branch, else its title; its project beneath.
  const named = summary ? rowName(summary, summary.title?.trim() || label).name : label;
  const hostId = app.activeHost.id;
  const machine = hostDisplayName(app.activeHost);
  const select = (next: string) => router.setParams({ sessionId, tabId: next, hostId, title: label });
  // Closing stops that chat's agent, as on the Mac; its history stays there. The neighbour opens in its place.
  const close = (closing: string) => {
    const tabs = summary?.tabs ?? [];
    const at = tabs.findIndex((tab) => tab.id === closing);
    const next = tabs[at + 1] ?? tabs[at - 1];
    const name = tabs[at]?.title?.trim() || "this chat";
    Alert.alert(`Close ${name}?`, `Its agent stops. The conversation stays on ${words.your}.`, [{ text: "Cancel", style: "cancel" }, { text: "Close", style: "destructive", onPress: () => void app.api.closeTab(sessionId, closing).then(async (result) => {
      if (!result.done) return Alert.alert("Could not close the chat", result.message);
      if (next) select(next.id);
      await app.refreshSessions();
    }).catch((cause: unknown) => Alert.alert("Could not close the chat", screenMessage(cause, `Couldn’t reach ${machine}. Try again once it is connected.`))) }]);
  };
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: label, headerShown: false }} />
    {params.botId && params.item && Number.isSafeInteger(Number(params.item)) ? <BotQuestionOver botId={params.botId} number={Number(params.item)} onClose={() => router.setParams({ botId: undefined, item: undefined })} /> : null}
    <SessionHeader title={named} subtitle={[summary && summary.kind !== "quick" ? summary.project : null, machineName ?? hostDisplayName(app.activeHost)].filter(Boolean).join(" · ")} connection={state} onBack={() => router.back()} view={terminalOffered ? view : undefined} onView={setView} muted={override === "mute"} onNotifications={() => setNotifying(true)} />
    {/* Named by the session's own title, as its notifications name it (22.07), not by the branch the header shows. */}
    <SessionNotificationsSheet visible={notifying} hostId={hostId} sessionId={sessionId} name={summary?.title?.trim() || named} onClose={() => setNotifying(false)} />
    {summary && (summary.tabs.length > 1 || canAdd) ? <ChatTabs key={JSON.stringify([hostId, sessionId])} session={summary} selectedTabId={tabId} onSelect={select} onAdd={canAdd ? () => setAdding(true) : undefined} onClose={canClose ? close : undefined} actionsDisabled={!linked} /> : null}
    <NewChatSheet visible={adding} sessionId={sessionId} tabId={tabId} onClose={() => setAdding(false)} onStarted={(next) => { setAdding(false); select(next); }} />
    {!available ? <Text style={{ color: palette.warning, paddingHorizontal: 16 }}>This conversation is no longer available on {words.the}.</Text> : null}
    {!terminal ? <ChatPane key={key} hostId={app.activeHost.id} sessionId={sessionId} tabId={tabId} available={available} connected={available && linked} state={state} machine={machine} epoch={app.connectionEpoch ?? 0} answersQuestions={answersQuestions} /> : <TerminalPane key={key} hostId={app.activeHost.id} sessionId={sessionId} tabId={tabId} connected={available && linked} state={state} />}
  </View>;
}


/** A round button in the composer, on a quiet disc as the best chat apps draw theirs. */
/** A bare icon in the composer's row, as the boards draw it, with a full-size place to tap. */
function IconButton({ label, icon, disabled, onPress }: { label: string; icon: React.ReactNode; disabled?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.icon, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>{icon}</Pressable>;
}


/**
 * The composer's model, effort and permission mark are small words and an
 * 18 pt icon, as 22.03 draws them; each is tapped through a 44 pt place.
 * The strip they scroll in reaches past the 32 pt row (`chipStrip`) so a
 * ScrollView, which clips touches to its frame, does not cut those places
 * short. Side by side, the places split the gaps between them instead of
 * overlapping: model and effort share their 5 pt gap, effort and the mark
 * their 12 pt one, and the mark takes the room to its right.
 */
const CHIP_SLOP = {
  model: { top: 13, bottom: 13, left: 8, right: 2 },
  effort: { top: 13, bottom: 13, left: 3, right: 10 },
  mode: { top: 13, bottom: 13, left: 2, right: 24 },
};

/** What a question's card says on a phone paired with a computer that takes no answer from it (#979). */
const answerThere = (words: HostWords) => `Answer this question from ${words.your}.`;

function ChatPane({ hostId, sessionId, tabId, available, connected, state, machine, epoch, answersQuestions }: { hostId: string; sessionId: string; tabId: string; available: boolean; connected: boolean; state: ConnectionState; machine: string; epoch: number; answersQuestions: boolean | null }) {
  const app = useApp();
  const words = useHostWords();
  const router = useRouter();
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
  // Sent while not connected: held here, and sent once the phone connects (#983).
  const [held, setHeld] = useConversationState(`${stateKey}:held`, false);
  // In flight as a ref too: the held send and a tap can land in the same render.
  const sendInFlight = useRef(false);
  // A send that failed, said for this visit only: a sent message shows in the
  // transcript itself, and nothing about a send outlives leaving the screen.
  // `resend`: the send failed with the connection, and sending the same draft again can help.
  const [sendFailure, setSendFailure] = useState<{ message: string; resend?: boolean } | null>(null);
  const [attachments, setAttachments] = useConversationState<MobileAttachment[]>(`${stateKey}:attachments`, []);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [answeringPermission, setAnsweringPermission] = useConversationState<string | null>(`${stateKey}:answeringPermission`, null);
  const [permissionErrors, setPermissionErrors] = useConversationState<Record<string, string>>(`${stateKey}:permissionErrors`, {});
  // In flight as a ref too: a second tap lands before the first one's render.
  const answeringAsk = useRef(false);
  const draftEdited = useRef(false);
  const cacheKey = `terminalx:draft:${hostId}:${sessionId}:${tabId}`;
  useEffect(() => {
    if (connected) void app.api.markRead(sessionId, tabId).catch(() => {});
  }, [app.api, connected, sessionId, tabId]);
  const draftIdKey = `terminalx:draft-id:${hostId}:${sessionId}:${tabId}`;
  // Whether this connection's watcher read the Mac's history to its end: only then is a compaction shown as running (#644).
  const [caughtUp, setCaughtUp] = useState(false);
  const continuous = connected && caughtUp;
  const transcript = useMemo(() => buildTranscript(events, connected, { compactionContinuityKnown: continuous }), [connected, events, continuous]);

  useEffect(() => {
    let receivedPage = false;
    // A new watcher (another connection, or none) has caught up with nothing yet.
    setCaughtUp(false);
    setLoading(true);
    setLoadingEarlier(false);
    setEarlierError(null);
    // While disconnected the subtitle says so instead (`transcriptNotice`).
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
    }, setCaughtUp);
    return () => { stop(); earlierRequest.current = null; };
  }, [app.api, app.connection, connected, epoch, hostId, sessionId, tabId, retry, setEvents, setHasMore, setBefore]);

  // Catching up with the Mac is "Updating…", in the subtitle and everywhere else the connection is shown.
  const beginUpdate = app.beginUpdate;
  useEffect(() => {
    if (!connected || !loading || !beginUpdate) return;
    return beginUpdate();
  }, [beginUpdate, connected, loading]);

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
      if (earlierRequest.current === request) setEarlierError(screenMessage(error, "Could not load earlier turns. Try again."));
    } finally {
      if (earlierRequest.current === request) {
        earlierRequest.current = null;
        setLoadingEarlier(false);
      }
    }
  };

  /** `released`: the held message, now that the phone is connected (from this screen or from the app, if it was left). */
  const send = async (released = false) => {
    const text = draft.trim();
    if (!text && !attachments.length) return;
    // What was heard is in the draft already: a result still on its way would come after the send.
    if (dictation.listening) dictation.cancel();
    if (!connected && !released) {
      // Held, and sent once the phone connects, even if this chat is left: the box keeps it meanwhile, and editing it takes it back.
      draftEdited.current = true;
      setHeld(true);
      holdSend(stateKey, hostId, () => sendLatest.current(true));
      setSendFailure(null);
      return;
    }
    if (sending || sendInFlight.current) return;
    sendInFlight.current = true;
    setHeld(false);
    draftEdited.current = true;
    setSending(true);
    setSendFailure(null);
    const showError = (message: string) => {
      setSendFailure({ message: `Message not sent: ${message}` });
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
      } else {
        const posted = await app.api.postNote(sessionId, text, sendId.id);
        if (!posted.sent) return showError(posted.message);
        setNotes((current) => [...current.filter((note) => note.id !== posted.note.id), posted.note].sort((left, right) => left.createdAt - right.createdAt));
      }
      setDraft("");
      setDraftId(null);
      setAttachments([]);
      setAttachmentError(null);
      await Promise.all([AsyncStorage.removeItem(cacheKey), AsyncStorage.removeItem(draftIdKey)]);
    } catch (error) {
      // The connection's own failures are said in plain words, never in their raw text (#983).
      const problem = connectionProblem(error) ?? (isTransportError(error) ? "dropped" : null);
      if (!problem) return showError(screenMessage(error, "The host could not send this message."));
      // The connection failed, not the Mac: say so in plain words, and offer
      // the same draft again for when it is back (#670). The code is logged.
      app.connection.reportError("Session message failed", error);
      // A Mac that never answered most likely has it: sending it again could
      // give the agent the same prompt twice, or add the note twice (#675).
      if (mayHaveArrived(problem)) {
        return setSendFailure({ message: sendToAgent
          ? `Not confirmed: ${problemText(problem)}, so the message may have reached the agent. Check the conversation before sending it again.`
          : `Not confirmed: ${problemText(problem)}, so the note may have been added. Check the notes before adding it again.` });
      }
      setSendFailure({ message: `Not sent: ${problemText(problem)}. Your message is still in the box.`, resend: canRetry(problem) });
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  };
  // A held message goes once, as soon as the phone is connected: from here while this chat is open
  // (it knows the conversation is still on the Mac), else from the app (#983). The latest render's
  // send is kept for that, with what is in the box.
  const sendLatest = useRef(send);
  sendLatest.current = send;
  useEffect(() => showConversation(stateKey), [stateKey]);
  useEffect(() => {
    if (!held) releaseSend(stateKey);
    else if (connected) void takeHeldSend(stateKey)?.();
  }, [connected, held, stateKey]);

  /** Adds picked files within the limits: at most eight, 5 MB together. */
  const addPicked = async (assets: { uri: string; name: string; mimeType?: string | null; size?: number | null; base64?: string | null; id: string }[]) => {
    const picked: MobileAttachment[] = [];
    let totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    for (const asset of assets) {
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
      const actualSize = base64Size(data) || size;
      if (totalBytes + actualSize > MAX_ATTACHMENT_BYTES) {
        setAttachmentError("Attachments may total up to 5 MB.");
        continue;
      }
      totalBytes += actualSize;
      picked.push({ id: asset.id, uri: asset.uri, name: asset.name, mediaType, data, size: actualSize });
    }
    if (picked.length) setAttachments((current) => [...current, ...picked]);
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
      await addPicked(result.assets.map((asset, index) => ({ ...asset, id: `${asset.uri}:${asset.lastModified}:${index}` })));
    } catch {
      setAttachmentError("This file could not be attached. Please try another file.");
    }
  };

  /** Photos from the library, through the system's picker: it asks for no access to the whole library. */
  const pickPhotos = async () => {
    setAttachmentError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, MAX_ATTACHMENT_COUNT - attachments.length),
        // Sent as JPEG, compressed, so a few photos fit in a message.
        quality: 0.7,
        base64: true,
      });
      if (result.canceled) return;
      await addPicked(result.assets.map((asset, index) => ({
        id: `${asset.assetId ?? asset.uri}:${index}`,
        uri: asset.uri,
        name: asset.fileName?.replace(/\.(heic|heif|png)$/i, ".jpg") ?? `Photo ${index + 1}.jpg`,
        // With `base64` the picker hands back JPEG data, whatever the original was.
        mimeType: asset.base64 ? "image/jpeg" : asset.mimeType,
        size: null,
        base64: asset.base64,
      })));
    } catch {
      setAttachmentError("This photo could not be attached. Please try another one.");
    }
  };

  // An image pasted into the message field becomes an attachment, as a chat app's does.
  const composerFocused = useRef(false);
  const onPastedImage = useRef<(data: string) => void>(() => undefined);
  onPastedImage.current = (data) => {
    if (!sendToAgent) return setAttachmentError("Images go to the agent: switch back from the worktree note to attach one.");
    setAttachmentError(null);
    const id = `paste:${Date.now()}`;
    void addPicked([{ id, uri: `data:image/jpeg;base64,${data}`, name: "Pasted image.jpg", mimeType: "image/jpeg", size: null, base64: data }]);
  };
  useEffect(() => addPasteImageListener((image) => { if (composerFocused.current) onPastedImage.current(image.data); }), []);

  // A prompt's images live on the Mac: it hands each over, where it can (`promptImages`).
  const imagesServed = useHostFeatures(app.api, hostId)?.promptImages === 1;
  const imageSource = useMemo(() => imagesServed ? { scope: `${hostId}:${sessionId}`, load: (url: string) => app.api.promptImage(sessionId, tabId, url) } : null, [app.api, hostId, imagesServed, sessionId, tabId]);

  const harness = app.sessions.find((item) => item.id === sessionId)?.tabs.find((tab) => tab.id === tabId)?.harness;
  // Once the wait is a real one, the box says a message waits for the connection.
  const placeholder = state === "waiting" || state === "offline" ? "Message sends when connected" : harness ? `Message ${providerName(harness)}` : "Message this session";

  // Opening a conversation shows it, not the keyboard: one still up from the
  // screen before (a new session's first message) goes, and the composer
  // takes focus only when tapped.
  useEffect(() => { Keyboard.dismiss(); }, []);
  // Over the keyboard the composer needs no room for the home indicator.
  const keyboardShown = useKeyboardShown();

  // Speaking into the composer: what is said goes after what was already typed.
  const [composerHeight, setComposerHeight] = useState(0);
  const typedBefore = useRef("");
  const dictation = useDictation((said) => {
    draftEdited.current = true;
    setHeld(false);
    const next = typedBefore.current ? `${typedBefore.current} ${said}` : said;
    setDraft(next);
    setSendFailure(null);
    void AsyncStorage.setItem(cacheKey, next);
  });
  const beginDictation = async () => { typedBefore.current = draft.trimEnd(); await dictation.start(); };
  // Cancelled, what was said goes: the draft is what it was before.
  const cancelDictation = () => {
    dictation.cancel();
    setDraft(typedBefore.current);
    void AsyncStorage.setItem(cacheKey, typedBefore.current);
  };

  /** The + button: photos or files, from the system's own chooser. */
  const chooseAttachment = () => {
    // A note takes no attachments: offered only while there are none.
    showChoices("Add attachment", ["Photo Library", "Choose File", ...(attachments.length ? [] : ["Worktree note"])], (choice) => {
      if (choice === "Photo Library") void pickPhotos();
      else if (choice === "Choose File") void pickAttachments();
      else if (choice === "Worktree note") { setSendToAgent(false); setSendFailure(null); }
    });
  };

  const items = useMemo(() => conversationItems(transcript.turns, notes, tabId), [notes, tabId, transcript.turns]);
  const tabStatus = app.sessions.find((item) => item.id === sessionId)?.tabs.find((tab) => tab.id === tabId)?.status;
  const status = useMemo(() => statusLineState({ transcript, events, tabStatus }), [events, tabStatus, transcript]);

  // One answer at a time, to a permission request or a question: the card it
  // was for goes when the Mac's decision event arrives, and a refusal (the
  // Mac or another device answered first) is said on that card.
  const answerAsk = async (ask: PendingAsk, send: () => Promise<{ answered: true } | { answered: false; message: string }>, failed: string) => {
    if (!connected || answeringAsk.current) return;
    answeringAsk.current = true;
    setAnsweringPermission(ask.requestId);
    setPermissionErrors((current) => { const next = { ...current }; delete next[ask.requestId]; return next; });
    try {
      const result = await send();
      if (!result.answered) setPermissionErrors((current) => ({ ...current, [ask.requestId]: result.message }));
    } catch (error) {
      setPermissionErrors((current) => ({ ...current, [ask.requestId]: screenMessage(error, failed) }));
    } finally {
      answeringAsk.current = false;
      setAnsweringPermission(null);
    }
  };
  const respondPermission = (ask: PendingAsk, optionId: string) => answerAsk(ask, () => app.api.respondPermission(sessionId, tabId, ask.requestId, optionId), "The host could not answer this request.");
  const answerQuestions = (ask: PendingAsk, answers: Record<string, string>) => answerAsk(ask, () => app.api.answerQuestions(sessionId, tabId, ask.requestId, answers), "The answer could not be sent.");

  const retryTranscript = () => {
    // One more read, even of a page that halted after breaking the connection.
    retryHaltedTranscript(hostId, sessionId, tabId);
    if (connected) setRetry((value) => value + 1);
    // Not connected: try now rather than after the delay. The connection, once made, reads the transcript.
    else if (app.retryConnection) app.retryConnection();
    else app.connection.retryNow();
  };
  const reconnect = () => app.retryConnection ? app.retryConnection() : app.connection.retryNow();
  const notice = transcriptNotice({ state, connected, available, loadError, saved: events.length > 0, machine, retry: retryTranscript, reconnect });
  const noticeLine = notice ? <Card style={styles.noticeLine}>
    <WifiOff size={18} color={palette.warning} />
    <Text accessibilityLiveRegion="polite" style={[styles.noticeText, { color: palette.ink }]}>{notice.text}</Text>
    <Button label={notice.action} kind="secondary" disabled={sending} onPress={notice.onPress} style={styles.noticeAction} />
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
  // The subtitle shows the one spinner; an empty conversation only says what it is waiting for.
  const emptyTranscript = !connected
    ? loading ? undefined : <EmptyState title="No saved messages" detail={`This conversation shows once the phone connects to ${words.your}.`} />
    // A failed read is said by the line above; "no transcript" would not be true.
    : loadError ? undefined
    : loading ? <EmptyState title="Loading transcript" detail={`Reading the latest turns from ${machine}.`} />
      : hasMore ? <EmptyState title="Earlier turns available" detail="Load earlier to see the context for these updates." />
        : <EmptyState title="No transcript yet" detail="This tab has not published any turns." />;

  // Not connected, a message can still be sent: it is held, and goes once the phone connects.
  const sendDisabled = (!draft.trim() && !attachments.length) || sending || held;
  // The model, effort and mode stay in place while not connected, dimmed (#983).
  const dimmed = connected ? undefined : styles.dimmed;
  // The bar is drawn in this screen, so the view starts where the screen does: no offset.
  // The view makes room for the keyboard with padding, which a floating composer ignores: the inner view is what shrinks, and the composer floats at its foot.
  return <PromptImageContext.Provider value={imageSource}><KeyboardAvoidingView style={styles.flex} behavior={keyboardAvoidingBehavior()}><View style={styles.flex}>{noticeLine}<TranscriptList inset={composerHeight} data={items} keyExtractor={(item) => item.key} contentContainerStyle={styles.transcriptRows} earlier={transcriptHeader} ListEmptyComponent={emptyTranscript} renderItem={({ item }) => item.kind === "turn" ? <TranscriptRow row={item.row} /> : <NoteCard note={item.note} first={item.first} />} latest={<>{transcript.compacting ? <CompactingLine /> : null}{transcript.pendingAsks.map((ask) => ask.kind === "questions"
  // Until the Mac has said what it takes, nothing can be sent; one that takes no answer shows the question to be answered there.
  ? <QuestionCard key={ask.requestId} ask={ask} stateKey={stateKey} connected={connected} answering={answeringPermission !== null || (connected && answersQuestions === null)} readOnly={answersQuestions === false ? answerThere(words) : null} error={permissionErrors[ask.requestId]} onAnswer={(answers) => void answerQuestions(ask, answers)} />
  : <PermissionCard key={ask.requestId} ask={ask} connected={connected} answering={answeringPermission !== null} error={permissionErrors[ask.requestId]} onRespond={(optionId) => void respondPermission(ask, optionId)} />)}</>} /><SessionControls sessionId={sessionId} tabId={tabId} events={events} asks={transcript.pendingAsks.length} connected={connected} onOpenTab={(next) => router.setParams({ tabId: next, hostId })}>{(controls) => {
    // Send stays Send while the agent works; the turn is stopped from the status line (22.03).
    const ready = !sendDisabled;
    const action = <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={sendDisabled} hitSlop={6} onPress={() => void send()} style={[styles.send, { backgroundColor: ready ? palette.ink : palette.raised, borderColor: ready ? palette.ink : palette.border }]}><ArrowUp size={16} color={ready ? palette.page : palette.ink} strokeWidth={2.4} /></Pressable>;
    // A long press on the line's Stop stops the whole session, after asking.
    const stopSession = controls ? () => Alert.alert("Stop this session?", "The agent stops, and its conversation stays.", [{ text: "Cancel", style: "cancel" }, { text: "Stop", style: "destructive", onPress: controls.stop }]) : undefined;
    // Floating over the conversation, which fades and blurs away under it.
    return <View onLayout={({ nativeEvent }) => setComposerHeight(nativeEvent.layout.height)} style={[styles.composer, styles.dock, { paddingBottom: (keyboardShown ? 0 : insets.bottom) + 8 }]}>
      <EdgeFade edge="bottom" height={composerHeight + 32} />
      {controls?.panel}
      {attachments.length ? <View style={styles.attachments}>{attachments.map((attachment) => <View key={attachment.id} style={styles.attachment}>{attachment.mediaType.startsWith("image/") ? <Image source={{ uri: attachment.uri }} accessibilityLabel={attachment.name} style={styles.attachmentImage} /> : <View accessibilityLabel={attachment.name} style={[styles.attachmentImage, styles.fileAttachment, { backgroundColor: palette.raised }]}><FileText size={22} color={palette.muted} /><Text numberOfLines={1} style={[styles.fileAttachmentName, { color: palette.muted }]}>{attachment.name}</Text></View>}<Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} style={styles.removeAttachment}><X size={13} color="#fff" /></Pressable></View>)}</View> : null}
      {attachmentError ? <Text style={[styles.attachmentError, { color: palette.danger }]}>{attachmentError}</Text> : null}
      {dictation.error ? <Text accessibilityLiveRegion="polite" style={[styles.attachmentError, { color: palette.danger }]}>{dictation.error}</Text> : null}
      {/* What the agent is doing now, right under the latest card and over the composer (22.03). Not connected, the line would only repeat what was true when the phone last heard: it goes, and the connection says why (22.01). */}
      {connected ? <StatusLine state={status} onStop={controls ? controls.interrupt : undefined} onStopSession={stopSession} stopping={!!controls?.working} /> : null}
      {/* A held message is still to go, so the line says so until it does (#983); nothing else about a send is kept. */}
      {held && !sendFailure ? <View style={styles.feedbackLine}><Text accessibilityLiveRegion="polite" style={[styles.sendFeedback, { color: palette.muted }]}>Sends when connected.</Text></View> : null}
      {sendFailure ? <View style={styles.feedbackLine}><Text accessibilityLiveRegion="polite" style={[styles.sendFeedback, { color: palette.danger }]}>{sendFailure.message}</Text>{sendFailure.resend ? <Button label="Resend" kind="secondary" disabled={sendDisabled} onPress={() => void send()} style={styles.resend} /> : null}</View> : null}
      {/* As 22.01 and 22.03 draw it: the message on top, and beneath it what to send it with. */}
      <Glass style={styles.inputGlass}>
        {!sendToAgent ? <View style={styles.noteBanner}><StickyNote size={14} color={palette.warning} /><Text style={[styles.noteBannerText, { color: palette.muted }]}>Worktree note · not sent to the agent</Text><Pressable accessibilityRole="button" accessibilityLabel="Send to agent" hitSlop={10} onPress={() => { setSendToAgent(true); setSendFailure(null); }}><X size={15} color={palette.muted} /></Pressable></View> : null}
        <TextInput value={draft} autoFocus={false} onFocus={() => { composerFocused.current = true; }} onBlur={() => { composerFocused.current = false; }} onChangeText={(value) => { draftEdited.current = true; setDraft(value); setHeld(false); setSendFailure(null); void AsyncStorage.setItem(cacheKey, value); }} multiline placeholder={dictation.listening ? "Listening…" : placeholder} placeholderTextColor={palette.faint} style={[styles.composeInput, { color: palette.ink }]} />
        {dictation.listening ? <View style={styles.toolbar}>
          {/* Listening, as the best chat apps show it: cancel, the voice as it is heard, stop and keep, or send. */}
          <IconButton label="Cancel dictation" icon={<X size={20} color={palette.ink} strokeWidth={2.2} />} onPress={cancelDictation} />
          <Waveform levels={dictation.levels} />
          <IconButton label="Stop dictation" icon={<Square size={14} color={palette.ink} fill={palette.ink} />} onPress={dictation.stop} />
          {action}
        </View> : <View style={styles.toolbar}>
          {sendToAgent ? <IconButton label="Add attachment" icon={<Plus size={20} color={palette.ink} strokeWidth={2} />} disabled={sending} onPress={chooseAttachment} /> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={[styles.flex, styles.chipStrip]} contentContainerStyle={styles.chips}>
            {controls ? <>
              {/* The model and its effort in one line, the model bold; each opens its own picker. */}
              <View style={[styles.model, dimmed]}>
                <Pressable accessibilityRole="button" accessibilityLabel={controls.settings.model.label} disabled={controls.settings.model.disabled} hitSlop={CHIP_SLOP.model} onPress={controls.settings.model.open}><Text numberOfLines={1} style={[styles.modelText, { color: palette.ink }]}>{controls.settings.model.label}</Text></Pressable>
                {controls.settings.effort ? <Pressable accessibilityRole="button" accessibilityLabel={controls.settings.effort.label} disabled={controls.settings.effort.disabled} hitSlop={CHIP_SLOP.effort} onPress={controls.settings.effort.open}><Text numberOfLines={1} style={[styles.effortText, { color: palette.muted }]}>{controls.settings.effort.label}</Text></Pressable> : null}
              </View>
              {/* The permission mode as a mark alone, named for assistive technology; Bypass by its own shape, not a colour. */}
              <Pressable accessibilityRole="button" accessibilityLabel={`Permission mode: ${controls.settings.mode.label}`} disabled={controls.settings.mode.disabled} hitSlop={CHIP_SLOP.mode} onPress={controls.settings.mode.open} style={dimmed}>
                {controls.settings.mode.bypass ? <ShieldAlert size={18} color={palette.muted} /> : <Shield size={18} color={palette.muted} />}
              </Pressable>
            </> : null}
          </ScrollView>
          <IconButton label="Dictate" icon={<Mic size={20} color={palette.muted} />} onPress={() => void beginDictation()} />
          {action}
        </View>}
      </Glass>
    </View>;
  }}</SessionControls></View></KeyboardAvoidingView></PromptImageContext.Provider>;
}

/**
 * The slim line above the conversation (#983), shown only when something has
 * really failed: the phone has not reached the Mac for 15 seconds, the Mac
 * disconnected this phone, or a read failed while connected. Connecting and
 * catching up are said by the subtitle alone, and what this phone saved stays
 * on screen throughout. No address and no transport message is ever shown.
 */
function transcriptNotice({ state, connected, available, loadError, saved, machine, retry, reconnect }: {
  state: ConnectionState; connected: boolean; available: boolean; loadError: { cause: unknown } | null; saved: boolean; machine: string; retry(): void; reconnect(): void;
}): TranscriptNotice | null {
  // The page above already says this conversation is gone from the Mac.
  if (!available) return null;
  const shown = saved ? "Showing saved messages." : "Messages show once it connects.";
  // Reconnecting would only ask for the same read again.
  if (loadError?.cause instanceof TranscriptHaltedError) return { text: loadError.cause.message, action: "Try again", onPress: retry };
  if (state === "held") return { text: `${connectionWords("held")}. ${shown}`, action: "Reconnect", onPress: reconnect };
  if (state === "waiting") return { text: `Can’t reach ${machine}. ${shown}`, action: "Try again", onPress: retry };
  if (!connected || !loadError) return null;
  const text = isTransportError(loadError.cause) ? `Couldn’t load new messages from ${machine}.` : screenMessage(loadError.cause, "Could not load the transcript.");
  return { text, action: "Try again", onPress: retry };
}

function base64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function NoteCard({ note, first }: { note: ChatNote; first: boolean }) {
  const { palette } = useTheme();
  return <Card style={styles.note}>{first ? <Text style={[styles.noteAuthor, { color: palette.accent }]}>{note.author.displayName ?? "Participant"} · note</Text> : null}<LinkedText style={[styles.body, { color: palette.ink }]}>{note.body}</LinkedText></Card>;
}

/** How much of the retained output is replayed at a time, so the history in it is seen as it scrolls by. */
const REPLAY_PIECE = 2048;

/** What a shell is typed with that a phone keyboard hides a page away. */
const TERMINAL_SYMBOLS = ["/", "-", "|", "~", ":", "*", "$"];

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
function TerminalPane({ hostId, sessionId, tabId, connected, state }: { hostId: string; sessionId: string; tabId: string; connected: boolean; state: ConnectionState }) {
  const app = useApp();
  const words = useHostWords();
  const endedText = `${words.The} ended the terminal view.`;
  const { palette } = useTheme();
  const stateKey = conversationKey(hostId, sessionId, tabId);
  const [mode, setMode] = useConversationState<"direct" | "buffered">(`${stateKey}:mode`, "direct");
  const [input, setInput] = useConversationState(`${stateKey}:input`, "");
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const insets = useSafeAreaInsets();
  const keyboardShown = useKeyboardShown();
  const [opening, setOpening] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const screen = useRef<TerminalScreen | null>(null);
  const request = useMemo(() => ({ api: app.api, connection: app.connection, connected, sessionId, tabId, attempt }), [app.api, app.connection, connected, sessionId, tabId, attempt]);
  const [previousRequest, setPreviousRequest] = useState(request);
  if (previousRequest !== request) {
    setPreviousRequest(request);
    if (connected) {
      setOpening(true);
      setProblem(null);
    }
  }

  useEffect(() => {
    if (!connected) return;
    let active = true;
    let unsubscribe = () => {};
    let frame: ReturnType<typeof setTimeout> | null = null;
    // Output is parsed in order, and drawn at most every 50 ms however fast it comes.
    let parsed = Promise.resolve();
    // A program that redraws its screen in place (Claude Code) leaves the terminal no history: the phone keeps it.
    let history = new ScreenHistory();
    const draw = () => { if (!frame) frame = setTimeout(() => { frame = null; const current = screen.current; if (active && current) setRows([...history.rows, ...(current.hasHistory() ? current.lines() : current.viewport())]); }, 50); };
    /** Output parsed, then the screen looked at, so what moved off its top is kept. */
    // Only a normal screen with no history of its own: a terminal's own scrollback, or a full-screen program's moves, are not kept twice.
    const feed = (text: string) => apply(async (current) => { await current.write(text); if (!current.hasHistory() && !current.modes().alternate) history.observe(current.viewport()); });
    const apply = (step: (current: TerminalScreen) => void | Promise<void>) => {
      parsed = parsed.then(async () => { if (active && screen.current) await step(screen.current); }).then(draw, draw);
    };
    const ended = app.connection.onEvent((message) => {
      if (active && message.method === "terminal.closed") setProblem((message.params as { message?: string } | null)?.message ?? endedText);
    });
    void app.api.openTerminal(sessionId, tabId).then((opened) => {
      if (!active) return;
      setOpening(false);
      if (!opened.opened) { setProblem(opened.message); return; }
      unsubscribe = app.api.subscribeTerminal(sessionId, tabId, (packet) => {
        if (!active) return;
        if (packet.type === "error") setProblem(packet.message ?? endedText);
        else if (packet.type === "scrollback") {
          // A new subscription (also after a reconnect) starts from the retained output.
          screen.current?.dispose();
          screen.current = new TerminalScreen(packet.cols ?? 80, packet.rows ?? 24);
          history = new ScreenHistory();
          setProblem(null);
          // The retained output, a piece at a time, so the history it held is kept as it is replayed.
          const retained = packet.serialized ?? "";
          for (let at = 0; at < retained.length; at += REPLAY_PIECE) feed(retained.slice(at, at + REPLAY_PIECE));
        } else if (packet.type === "resized" && packet.cols && packet.rows) apply((current) => current.resize(packet.cols!, packet.rows!));
        else if (packet.type === "data" && packet.chunk) feed(packet.chunk);
      });
    // The connection's own failure is the connection state's to say; the Mac's refusal is said as it is.
    }, (cause: unknown) => { if (active) { setOpening(false); setProblem(isTransportError(cause) ? null : screenMessage(cause, endedText)); } });
    return () => { active = false; if (frame) clearTimeout(frame); ended(); unsubscribe(); screen.current?.dispose(); screen.current = null; };
  }, [app.api, app.connection, connected, sessionId, tabId, attempt]);

  useEffect(() => () => { void app.api.releaseInput(sessionId, tabId); }, [app.api, sessionId, tabId]);

  const modes = () => screen.current?.modes() ?? { bracketedPaste: false, applicationCursorKeys: false, mouse: false, alternate: false };
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

  const offline = connectionWords(state === "connected" || state === "updating" ? "connecting" : state) ?? "Connecting…";
  const status = !connected ? offline : opening ? "Opening…" : problem ? "Unavailable" : refusal ? "Refused" : "Live";
  const statusDetail = !connected ? `${offline} · what you type is kept` : opening ? "Opening the terminal…" : problem ? "The terminal isn't available" : refusal ? "Input refused" : `Live · typing here pauses typing on ${words.the}`;
  // Enter is the key most pressed: the big button at the thumb. Writing first, it sends the text and then Enter.
  const enter = () => {
    if (mode === "buffered" && input) return void write(pasteSequence(input, modes()) + keySequence("enter", modes())).then((accepted) => { if (accepted) setInput(""); });
    void write(keySequence("enter", modes()));
  };
  const sendsText = mode === "buffered" && input.length > 0;
  return <KeyboardAvoidingView style={styles.flex} behavior={keyboardAvoidingBehavior()}>
    {/* The agent's screen, edge to edge on the terminal's own black, with how the link is doing in a corner. */}
    <View style={[styles.flex, { backgroundColor: palette.terminal }]}>
      {/* The screen and its history, scrolled as any list; a line wider than the screen wraps onto the next. */}
      <FlatList inverted data={[...rows].reverse()} keyExtractor={(row) => row.key} renderItem={({ item }) => <TerminalLine row={item} />} contentContainerStyle={styles.terminalOutput} />
      <View accessibilityLabel={statusDetail} style={[styles.terminalStatus, { backgroundColor: `${palette.page}cc`, borderColor: palette.border }]}>
        <StatusDot color={live && !refusal ? palette.success : palette.warning} />
        <Text style={[styles.terminalStatusText, { color: palette.muted }]}>{status}</Text>
      </View>
      {problem ? <Card style={[styles.notice, styles.terminalProblem]}><Text style={[styles.noticeTitle, { color: palette.ink }]}>The terminal isn&apos;t available</Text><Text style={[styles.noticeDetail, { color: palette.muted }]}>{problem}</Text><Button label="Try again" kind="secondary" disabled={!connected} onPress={() => setAttempt((n) => n + 1)} style={styles.resend} /></Card> : null}
    </View>
    {refusal ? <Text style={[styles.terminalRefusal, { color: palette.danger }]}>{refusal}</Text> : null}
    {/* The keys a phone keyboard lacks, and the symbols a shell wants most, a thumb's reach above the keyboard. */}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.terminalKeysBar} contentContainerStyle={styles.terminalKeys}>
      <KeyCap label="ctrl" name="Control" live={live} selected={control} onPress={() => setControl((held) => !held)} />
      {TERMINAL_KEYS.filter(({ key: id }) => id !== "enter").map(({ key: id, label, name }) => <KeyCap key={name} label={label} name={name} live={live} onPress={() => void write(keySequence(id, modes()))} />)}
      {TERMINAL_SYMBOLS.map((symbol) => <KeyCap key={symbol} label={symbol} name={`Type ${symbol}`} live={live} onPress={() => typed(symbol)} />)}
    </ScrollView>
    {/* Clear of the home indicator, until the keyboard covers it. */}
    <View style={[styles.terminalInputBar, { paddingBottom: (keyboardShown ? 0 : insets.bottom) + 8 }]}>
      <Glass style={styles.terminalInputGlass}>
        <TextInput value={input} onChangeText={(value) => { if (mode === "direct" && live) { const addition = value.startsWith(input) ? value.slice(input.length) : value; setInput(""); typed(addition); } else setInput(value); }} onKeyPress={({ nativeEvent }) => { if (mode === "direct" && live && nativeEvent.key === "Backspace" && input.length === 0) void write(keySequence("backspace", modes())); }} onSubmitEditing={() => { if (mode === "direct") void write(keySequence("enter", modes())); }} multiline={mode === "buffered"} autoCapitalize="none" autoCorrect={false} spellCheck={false} smartInsertDelete={false} autoComplete="off" placeholder={mode === "direct" ? "Type to the terminal" : "Write, then send"} placeholderTextColor={palette.faint} style={[styles.terminalInput, { color: palette.ink }]} />
        {/* Typing straight in, or writing first and sending it whole: one tap between them. */}
        <Pressable accessibilityRole="button" accessibilityLabel={mode === "direct" ? "Buffered" : "Direct"} accessibilityHint={mode === "direct" ? "Write first, then send it whole" : "Type straight into the terminal"} hitSlop={6} onPress={() => setMode(mode === "direct" ? "buffered" : "direct")} style={[styles.terminalMode, { backgroundColor: mode === "buffered" ? palette.selected : "transparent" }]}>
          {mode === "direct" ? <KeyboardIcon size={19} color={palette.muted} /> : <TextCursorInput size={19} color={palette.ink} />}
        </Pressable>
      </Glass>
      <Pressable accessibilityRole="button" accessibilityLabel={sendsText ? "Send terminal input" : "Enter"} disabled={!live} onPress={enter} style={({ pressed }) => [styles.terminalEnter, { backgroundColor: palette.ink, opacity: !live ? 0.35 : pressed ? 0.8 : 1 }]}>
        {sendsText ? <ArrowUp size={22} color={palette.page} strokeWidth={2.6} /> : <CornerDownLeft size={22} color={palette.page} strokeWidth={2.4} />}
      </Pressable>
    </View>
  </KeyboardAvoidingView>;
}

/** A key the phone keyboard lacks, in the row above it; `selected` for one held, as ctrl is. */
function KeyCap({ label, name, live, selected = false, onPress }: { label: string; name: string; live: boolean; selected?: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={name} accessibilityState={selected ? { selected } : undefined} disabled={!live} onPress={onPress} style={({ pressed }) => [styles.terminalKey, { backgroundColor: selected ? palette.ink : pressed ? palette.selected : palette.raised, opacity: live ? 1 : 0.4 }]}>
    <Text style={[styles.terminalKeyText, { color: selected ? palette.page : palette.ink }]}>{label}</Text>
  </Pressable>;
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
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: "center" },
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
  composer: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  inputGlass: { borderRadius: 22, borderCurve: "continuous", paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, gap: 12 },
  icon: { minWidth: 28, height: 32, alignItems: "center", justifyContent: "center" },
  model: { flexDirection: "row", alignItems: "center", gap: 5 },
  modelText: { fontSize: 14, fontWeight: "600" },
  effortText: { fontSize: 14 },
  noteBanner: { flexDirection: "row", alignItems: "center", gap: 7 },
  noteBannerText: { flex: 1, fontSize: 13 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 12 },
  // 6 pt above and below the 32 pt row, and 8 pt at each end, given back by the margins: the strip's frame is 44 pt tall, nothing moves.
  chipStrip: { marginVertical: -6, marginHorizontal: -8 },
  chips: { alignItems: "center", gap: 12, minHeight: 44, paddingLeft: 8, paddingRight: 24 },
  sendFeedback: { flex: 1, fontSize: 13, lineHeight: 18, paddingHorizontal: 6 },
  feedbackLine: { flexDirection: "row", alignItems: "center", gap: 9 },
  resend: { minHeight: 36, paddingHorizontal: 12 },
  notice: { padding: 15, gap: 8 },
  noticeTitle: { fontSize: 15, fontWeight: "700" },
  noticeDetail: { fontSize: 13, lineHeight: 19 },
  // As the design's banner: one row, an icon, the words, and the one action.
  noticeLine: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, marginHorizontal: 12, marginTop: 8 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 19 },
  noticeAction: { minHeight: 32, paddingHorizontal: 12 },
  dimmed: { opacity: 0.45 },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 6 },
  attachment: { width: 58, height: 58 },
  attachmentImage: { width: 58, height: 58, borderRadius: 12 },
  fileAttachment: { alignItems: "center", justifyContent: "center", padding: 5, gap: 2 },
  fileAttachmentName: { width: 48, fontSize: 8, textAlign: "center" },
  removeAttachment: { position: "absolute", right: -4, top: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: "#252525dd", alignItems: "center", justifyContent: "center" },
  attachmentError: { fontSize: 13, lineHeight: 18, paddingHorizontal: 6 },
  disabled: { opacity: 0.4 },
  composeInput: { minHeight: 22, maxHeight: 150, padding: 0, fontSize: 16, lineHeight: 21 },
  send: { width: 32, height: 32, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  detail: { fontSize: 12, marginTop: 2 },
  terminalOutput: { paddingHorizontal: 11, paddingVertical: 13 },
  terminalText: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
  terminalStatus: { position: "absolute", top: 10, right: 12, flexDirection: "row", alignItems: "center", gap: 6, height: 26, borderRadius: 13, paddingHorizontal: 10, borderWidth: StyleSheet.hairlineWidth },
  terminalStatusText: { fontSize: 12, fontWeight: "500" },
  terminalProblem: { position: "absolute", left: 16, right: 16, top: 48 },
  terminalRefusal: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingTop: 6 },
  terminalKeysBar: { flexGrow: 0 },
  terminalKeys: { gap: 6, paddingHorizontal: 10, paddingTop: 8 },
  terminalKey: { minWidth: 40, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  terminalKeyText: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 14 },
  terminalInputBar: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingTop: 8 },
  terminalInputGlass: { flex: 1, flexDirection: "row", alignItems: "flex-end", gap: 4, minHeight: 52, borderRadius: 26, paddingLeft: 6, paddingRight: 5, paddingVertical: 5 },
  terminalMode: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  terminalEnter: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  terminalInput: { flex: 1, minHeight: 42, maxHeight: 110, paddingHorizontal: 10, paddingTop: 11, paddingBottom: 9, fontSize: 15, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
});
