import { useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WifiOff } from "lucide-react-native";
import { BYPASS_NOT_FROM_PHONE, phoneModes } from "@mobile/cloud/agent-settings";
import {
  chooseAgent, chooseModel, conversationTitle, effortChoices, initialStartChoices, keepsRequest, modelChoices, PROVEN_BY_LIVE_CHECK,
  NO_ANSWER_MS, START_WORDS, startFailure, startParams, startRows, type StartAgent, type StartChoices, type StartFailure, type TabSettings,
} from "@mobile/cloud/start-tab";
import type { CloudWorkspaceSession, CloudWorkspaceSnapshot } from "@mobile/cloud/workspace";
import { ChoiceSheet, type Choice } from "./ChoiceSheet";
import { Notice } from "./Notice";
import { AgentSettingsRows } from "./PickRow";
import { Button, Card } from "./primitives";
import { Spinner } from "./Spinner";
import { TextField } from "./TextField";
import { useTheme } from "./theme";

/** What became of a start: the tab it opened, and whether its first message may not have reached the agent. */
export interface StartedTab { tabId: string; promptNotSent: boolean; text: string }

type Reading = { state: "reading" } | { state: "read"; agents: StartAgent[] } | { state: "unread" };
type Picker = "agent" | "model" | "effort" | "mode" | null;

const newRequestId = () => `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * New conversation and Add agent tab (25.10): the agent and its settings
 * read from the workspace's runtime, and for a conversation its first
 * message. Opened from the workspace's ••• or its empty state. While the
 * workspace starts (`waking`) the message can be written, and the choices
 * appear once it runs.
 */
export function StartAgentSheet({ kind, session, snapshot, sessionId, from, text, onText, waking, wakeFailure, onRetryWake, onStarted, onClose }: {
  kind: "conversation" | "tab";
  session: CloudWorkspaceSession;
  snapshot: CloudWorkspaceSnapshot;
  /** The conversation an added tab joins (the tab on screen's). */
  sessionId?: string | null;
  /** What the tab on screen runs: the choices start there. */
  from?: TabSettings | null;
  /** The first message, held by the screen: closing the sheet keeps it for the next time it opens. */
  text: string;
  onText(text: string): void;
  /** Stopped when the sheet was asked for, and starting now. */
  waking?: boolean;
  /** The start's own sentence, when the workspace did not start. */
  wakeFailure?: string | null;
  onRetryWake?(): void;
  onStarted(started: StartedTab): void;
  onClose(): void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [reading, setReading] = useState<Reading>({ state: "reading" });
  const [choices, setChoices] = useState<StartChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [typing, setTyping] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // One request per start: asked again after no answer, it is the same request, so nothing is started twice.
  const request = useRef(newRequestId());
  // Still on screen, and told no answer came: a late answer then opens the tab.
  const shown = useRef(true);
  const toldNoAnswer = useRef(false);
  useEffect(() => () => { shown.current = false; }, []);

  const connected = snapshot.connection.state === "connected";
  const offer = snapshot.startOffer;

  useEffect(() => {
    if (!connected || offer !== "yes") return;
    let current = true;
    session.startAgents().then((agents) => {
      if (!current) return;
      setReading({ state: "read", agents });
      setChoices((held) => held ?? initialStartChoices(agents, from));
    }, () => { if (current) setReading({ state: "unread" }); });
    return () => { current = false; };
    // `from` is read once, when the agents are: what the person picks after that stays theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, offer, session, attempt]);

  useEffect(() => {
    const shown = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setTyping(true));
    const hidden = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setTyping(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  const agents = reading.state === "read" ? reading.agents : [];
  const agent = agents.find((candidate) => candidate.id === choices?.agent) ?? null;
  const model = agent?.models.find((candidate) => candidate.id === choices?.model) ?? null;
  const rows = choices ? startRows(agents, choices) : null;
  const conversation = kind === "conversation";
  const emptyAllowed = PROVEN_BY_LIVE_CHECK.emptyFirstMessageStartsAgent;

  // What stands in the way before anything is asked, in the order the board draws it.
  const blocker: { tone: "warning" | "danger" | "info"; text: string; offline?: boolean; retry?(): void } | null =
    wakeFailure ? { tone: "danger", text: wakeFailure, retry: onRetryWake }
    : waking && !connected ? null
    : !connected ? { tone: "warning", text: START_WORDS.offline, offline: true }
    : offer === "old" ? { tone: "info", text: START_WORDS.old }
    : offer === "no" ? { tone: "warning", text: START_WORDS.refused }
    : reading.state === "unread" ? { tone: "danger", text: START_WORDS.unread, retry: () => { setReading({ state: "reading" }); setAttempt((value) => value + 1); } }
    : null;
  const ready = !blocker && connected && offer === "yes" && reading.state === "read" && !!agent && !agent.blocked;
  const canSend = ready && !busy && (!conversation || emptyAllowed || text.trim() !== "") && (conversation || !!sessionId);

  const start = async () => {
    if (!canSend || !choices) return;
    setBusy(true);
    setFailure(null);
    toldNoAnswer.current = false;
    const sent = text;
    const params = startParams(agents, choices);
    const asked = conversation
      ? session.startConversation(params, { title: conversationTitle(sent, snapshot.tabs.length), prompt: sent }, request.current)
      : session.addAgentTab(sessionId!, params, request.current).then((added) => ({ ...added, promptNotSent: false }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("No answer yet")), NO_ANSWER_MS); });
    // Said to have no answer, it may still come: it then opens the tab, as an answer in time would.
    asked.then((late) => { if (shown.current && toldNoAnswer.current) onStarted({ tabId: late.tabId, promptNotSent: late.promptNotSent, text: sent }); }, () => undefined);
    try {
      const started = await Promise.race([asked, silence]);
      request.current = newRequestId();
      onStarted({ tabId: started.tabId, promptNotSent: started.promptNotSent, text: sent });
    } catch (error) {
      const failed = startFailure(error, session.client.connection.state === "connected");
      if (!keepsRequest(failed)) request.current = newRequestId();
      toldNoAnswer.current = failed.kind === "no-answer";
      setFailure(failed);
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };

  const label = busy ? (conversation ? START_WORDS.starting : START_WORDS.adding)
    : failure && keepsRequest(failure) ? START_WORDS.tryAgain
    : conversation ? START_WORDS.startButton : START_WORDS.addButton;
  const spinnerLine = !blocker && (waking && !connected ? START_WORDS.waking : connected && offer === "yes" && reading.state === "reading" ? START_WORDS.reading : null);
  const showRows = !typing || !conversation;

  const pickerSheet = (() => {
    if (!picker || !choices || !agent) return null;
    const close = () => setPicker(null);
    if (picker === "agent") {
      const list: Choice[] = agents.map((entry) => ({ id: entry.id, label: entry.name, detail: entry.detail ?? undefined, disabled: !!entry.blocked }));
      return <ChoiceSheet title="Agent" subtitle={START_WORDS.agentsSubtitle} choices={list} chosen={choices.agent} onChoose={(id) => setChoices(chooseAgent(agents, choices, id))} onClose={close} />;
    }
    if (picker === "model") return <ChoiceSheet title="Model" subtitle={agent.name} choices={modelChoices(agent)} chosen={choices.model} onChoose={(id) => setChoices(chooseModel(agents, choices, id))} onClose={close} />;
    if (picker === "effort" && model) return <ChoiceSheet title="Effort" subtitle={model.label} choices={effortChoices(model)} chosen={choices.effort} onChoose={(id) => setChoices({ ...choices, effort: id })} onClose={close} />;
    if (picker === "mode") {
      const list: Choice[] = phoneModes(agent.modes).map((mode) => ({ id: mode.id, label: mode.label, detail: mode.hint }));
      return <ChoiceSheet title="Permission mode" choices={list} chosen={choices.mode} help={BYPASS_NOT_FROM_PHONE} onChoose={(id) => setChoices({ ...choices, mode: id as StartChoices["mode"] })} onClose={close} />;
    }
    return null;
  })();

  const locked = busy;
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <Pressable testID="start-sheet-backdrop" accessibilityRole="button" accessibilityLabel="Close" onPress={busy ? undefined : onClose} style={styles.backdrop} />
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View testID="start-sheet" accessibilityViewIsModal style={[styles.sheet, { backgroundColor: palette.page, borderColor: palette.border, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.handle, { backgroundColor: palette.faint }]} />
        <Text accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>{conversation ? START_WORDS.newConversation : START_WORDS.addTab}</Text>
        {conversation ? null : <Text style={[styles.subtitle, { color: palette.muted }]}>{START_WORDS.addTabUnder}</Text>}
        <View style={styles.body}>
          {blocker ? <Notice testID="start-blocker" tone={blocker.tone} text={blocker.text} icon={blocker.offline ? (color) => <WifiOff size={16} color={color} /> : undefined} action={blocker.retry ? { label: START_WORDS.tryAgain, onPress: blocker.retry } : undefined} /> : null}
          {spinnerLine ? <View testID="start-reading" style={styles.spinnerLine}><Spinner size={14} color={palette.muted} /><Text style={[styles.spinnerText, { color: palette.muted }]}>{spinnerLine}</Text></View> : null}
          {!showRows ? null
            : ready && rows ? <AgentSettingsRows testID="start-rows" agent={rows.agent} model={rows.model} effort={rows.effort} mode={rows.mode}
              onAgent={locked ? undefined : () => setPicker("agent")}
              onModel={locked || !agent || agent.models.length < 2 ? undefined : () => setPicker("model")}
              onEffort={locked || !model || model.efforts.length < 2 ? undefined : () => setPicker("effort")}
              onMode={locked || !agent || agent.modes.length < 2 ? undefined : () => setPicker("mode")} />
            : spinnerLine ? <Skeleton /> : null}
          {conversation && !(wakeFailure || reading.state === "unread") ? <TextField testID="start-message" multiline accessibilityLabel="First message" placeholder={START_WORDS.placeholder} value={text} onChangeText={onText} disabled={locked}
            helper={emptyAllowed && !text.trim() && !failure ? START_WORDS.noMessage : undefined} /> : null}
          {failure ? <Notice testID="start-failure" tone={failure.kind === "no-answer" || failure.kind === "offline" ? "warning" : failure.kind === "refused" ? "warning" : "danger"} text={failure.text} icon={failure.kind === "no-answer" || failure.kind === "offline" ? (color) => <WifiOff size={16} color={color} /> : undefined} /> : null}
          <Button testID="start-submit" label={label} disabled={!canSend} onPress={() => void start()} style={styles.submit} />
        </View>
      </View>
    </KeyboardAvoidingView>
    {pickerSheet}
  </Modal>;
}

/** Where the four rows go while the workspace starts or its agents are read: their outline, nothing to read. */
function Skeleton() {
  const { palette } = useTheme();
  return <Card testID="start-skeleton">
    {[0, 1, 2, 3].map((index) => <View key={index} style={[styles.skeletonRow, index ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null]}>
      <View style={[styles.bar, { width: 84, backgroundColor: palette.raised }]} />
      <View style={[styles.bar, { width: 112, backgroundColor: palette.raised }]} />
    </View>)}
  </Card>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#00000080" },
  sheet: { maxHeight: "92%", borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, marginBottom: 12, opacity: 0.6 },
  title: { fontSize: 17, fontWeight: "600", lineHeight: 22, paddingHorizontal: 4 },
  subtitle: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4, paddingTop: 2 },
  body: { marginTop: 12, gap: 12 },
  spinnerLine: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  spinnerText: { fontSize: 13, lineHeight: 18, flex: 1 },
  skeletonRow: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14 },
  bar: { height: 12, borderRadius: 6 },
  submit: { marginTop: 2 },
});
