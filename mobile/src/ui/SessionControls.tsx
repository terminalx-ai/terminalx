import { useCallback, useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BYPASS_MODE, PERMISSION_MODES, bypassEffect, effortChoices, EFFORT_LABEL, modelForTab, type ModelInfo } from "@terminalx/portable/agentSettings";
import type { ContextMode } from "@terminalx/portable/continuation";
import type { AgentEvent } from "@terminalx/portable/events";
import type { NewTabSettings, TabControls } from "../data/host-api";
import { continueHere, continueInNewTab, recoveryState, retrySafely, settingsView } from "../data/session-controls";
import { useApp } from "../state/AppProvider";
import { Button, Card } from "./primitives";
import { useTheme } from "./theme";

interface Choice { key: string; label: string; hint?: string; current?: boolean; pending?: boolean; onSelect(): void }

/**
 * Stop, Interrupt, the recovery banner's actions, the model, effort and mode
 * pickers, and Continue in new session: what the desktop offers for a tab,
 * for a Mac that takes them (`sessionControls`).
 */
export function SessionControls({ sessionId, tabId, events, asks, connected, onOpenTab }: {
  sessionId: string;
  tabId: string;
  events: AgentEvent[];
  /** Requests waiting for an answer; their cards are drawn by the transcript. */
  asks: number;
  connected: boolean;
  onOpenTab(tabId: string): void;
}) {
  const app = useApp();
  const { palette } = useTheme();
  const [supported, setSupported] = useState(false);
  const [tab, setTab] = useState<TabControls | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [picker, setPicker] = useState<{ title: string; choices: Choice[] } | null>(null);
  const [continuing, setContinuing] = useState(false);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    void app.api.sessionControls().then((value) => { if (active) setSupported(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [app.api, connected]);
  const refresh = useCallback(async () => {
    const next = await app.api.tabControls(sessionId, tabId).catch(() => null);
    setTab(next);
  }, [app.api, sessionId, tabId]);
  // A setting applied, a turn begun or ended: each arrives as an event.
  useEffect(() => { if (supported && connected) void refresh(); }, [connected, events.length, refresh, supported]);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void app.api.models().then((list) => { if (active) setModels(list); }).catch(() => undefined);
    return () => { active = false; };
  }, [app.api, supported]);

  if (!supported || !tab || !connected) return null;
  const view = settingsView(tab, models);
  const { kind, offer } = recoveryState(events, asks);
  const busy = tab.status === "in_progress";

  /** One action at a time; its error, or its outcome when that is news, is said under the controls. */
  const act = async (action: () => Promise<string | null>, success?: string) => {
    setWorking(true);
    setFeedback(null);
    try {
      const error = await action();
      setFeedback(error ? { error: true, text: error } : success ? { error: false, text: success } : null);
    } catch (cause) {
      setFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setWorking(false);
      void refresh();
    }
  };
  const done = (result: { done: true } | { done: false; message: string }) => result.done ? null : result.message;
  const sent = (result: { sent: true; queued: boolean } | { sent: false; message: string }) => result.sent ? null : result.message;
  // Models the Mac re-reads as a picker opens, as the desktop's does.
  const freshModels = () => { void app.api.models(true).then((list) => { if (list.length) setModels(list); }).catch(() => undefined); };
  const modelChoices = (select: (model: ModelInfo) => void): Choice[] => view.groups.flatMap((group) => group.models.map((model) => {
    const option = view.modelOption(model);
    return { key: model.id, label: option.label, hint: group.title ?? undefined, current: model.id === view.model?.id, pending: option.pending, onSelect: () => select(model) };
  }));
  const chooseMode = (mode: string) => {
    const apply = () => void act(async () => done(await app.api.setMode(sessionId, tabId, mode)));
    if (mode !== BYPASS_MODE) return apply();
    const { flag, effect } = bypassEffect(tab.harness);
    Alert.alert("Bypass permissions?", `${effect}\n\n${flag}`, [{ text: "Cancel", style: "cancel" }, { text: "Bypass", style: "destructive", onPress: apply }]);
  };

  return <View style={styles.wrap}>
    {busy ? <View style={styles.row}>
      <Button label="Interrupt" kind="secondary" disabled={working} onPress={() => void act(async () => done(await app.api.interrupt(sessionId, tabId)))} style={styles.flex} />
      <Button label="Stop" kind="danger" disabled={working} onPress={() => void act(async () => done(await app.api.stop(sessionId, tabId)))} style={styles.flex} />
    </View> : null}
    <View style={styles.row}>
      <Chip label={view.modelName} disabled={working} onPress={() => { freshModels(); setPicker({ title: "Model", choices: modelChoices((model) => void act(async () => done(await app.api.setModel(sessionId, tabId, model.id)))) }); }} />
      {view.efforts.length ? <Chip label={view.effortName ?? "Effort"} disabled={working} onPress={() => setPicker({ title: "Effort", choices: view.efforts.map((effort) => ({ key: effort.id, label: effort.label, current: effort.id === tab.effort, pending: effort.pending, onSelect: () => void act(async () => done(await app.api.setEffort(sessionId, tabId, effort.id))) })) })} /> : null}
      <Chip label={view.modeName} disabled={working} onPress={() => setPicker({ title: "Permission mode", choices: view.modes.map((mode) => ({ key: mode.id, label: mode.label, hint: mode.hint, current: mode.current, pending: mode.pending, onSelect: () => chooseMode(mode.id) })) })} />
    </View>
    {view.note ? <Text accessibilityLiveRegion="polite" style={[styles.note, { color: palette.muted }]}>{view.note}</Text> : null}
    {kind ? <Card style={[styles.recovery, { borderColor: palette.warning }]}>
      <Text style={[styles.title, { color: palette.ink }]}>{offer.title}</Text>
      <Text style={[styles.message, { color: palette.muted }]}>{offer.message}</Text>
      <View style={styles.actions}>
        {offer.resend ? <Button label="Resend last prompt" disabled={working} onPress={() => void act(async () => sent(await app.api.resendUnsent(sessionId, tabId)))} /> : null}
        {offer.retry ? <Button label={offer.retry} kind={kind === "signed_out" ? "secondary" : "primary"} disabled={working} onPress={() => void act(async () => sent(await retrySafely(app.api, sessionId, tabId)))} /> : null}
        {offer.sendContinue ? <Button label="Continue here" kind="secondary" disabled={working} onPress={() => void act(async () => sent(await continueHere(app.api, tabId)))} /> : null}
        {offer.chooseModel ? <Button label="Choose another model" kind="secondary" disabled={working} onPress={() => { freshModels(); setPicker({ title: "Retry on another model", choices: modelChoices((model) => void act(async () => sent(await retrySafely(app.api, sessionId, tabId, model.id)))) }); }} /> : null}
        <Button label="Stop session" kind="secondary" disabled={working} onPress={() => void act(async () => done(await app.api.stop(sessionId, tabId)))} />
        {offer.continueInNewSession ? <Button label="Continue in new session" kind="secondary" disabled={working} onPress={() => setContinuing(true)} /> : null}
      </View>
    </Card> : null}
    {feedback ? <Text accessibilityLiveRegion="polite" style={[styles.note, { color: feedback.error ? palette.danger : palette.success }]}>{feedback.text}</Text> : null}
    <ChoiceSheet picker={picker} onClose={() => setPicker(null)} />
    {continuing ? <ContinueSheet tab={tab} models={models} onClose={() => setContinuing(false)} onStart={(settings, mode) => {
      setContinuing(false);
      void act(async () => {
        const result = await continueInNewTab(app.api, sessionId, tabId, settings, mode);
        if (!result.started) return result.message;
        await app.refreshSessions();
        onOpenTab(result.tabId);
        return result.delivered ? null : result.inInput
          ? "The handoff is in the new conversation's input but has not been sent yet."
          : `The new conversation opened, but the handoff could not be confirmed. ${result.message ?? ""}`.trim();
      }, "Continued in a new conversation.");
    }} /> : null}
  </View>;
}

function Chip({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.chip, { borderColor: palette.border, backgroundColor: palette.raised }, disabled && styles.disabled]}>
    <Text numberOfLines={1} style={{ color: palette.ink, fontSize: 12 }}>{label}</Text>
  </Pressable>;
}

function ChoiceSheet({ picker, onClose }: { picker: { title: string; choices: Choice[] } | null; onClose(): void }) {
  const { palette } = useTheme();
  return <Modal visible={!!picker} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
    <View style={[styles.sheet, { backgroundColor: palette.card }]}>
      <Text style={[styles.title, { color: palette.ink }]}>{picker?.title}</Text>
      <ScrollView style={styles.list}>
        {picker?.choices.map((choice) => <Pressable key={choice.key} accessibilityRole="button" accessibilityLabel={choice.label} accessibilityState={{ selected: !!choice.current }} onPress={() => { onClose(); choice.onSelect(); }} style={[styles.choice, choice.current && { backgroundColor: palette.selected }]}>
          <Text style={{ color: palette.ink, fontWeight: choice.current ? "600" : "400" }}>{choice.label}{choice.pending ? "  · switching…" : ""}</Text>
          {choice.hint ? <Text style={[styles.message, { color: palette.muted }]}>{choice.hint}</Text> : null}
        </Pressable>)}
      </ScrollView>
    </View>
  </Modal>;
}

/** The agent, settings and context a new conversation in this session starts with. */
function ContinueSheet({ tab, models, onClose, onStart }: { tab: TabControls; models: ModelInfo[]; onClose(): void; onStart(settings: NewTabSettings, mode: ContextMode): void }) {
  const { palette } = useTheme();
  const harnesses = [...new Set([tab.harness, ...models.map((model) => model.harness)])];
  const [settings, setSettings] = useState<NewTabSettings>({ harness: tab.harness, model: tab.model, effort: tab.effort ?? null, permissionMode: tab.permissionMode });
  const [mode, setMode] = useState<ContextMode>("focused");
  const own = models.filter((model) => model.harness === settings.harness);
  const model = modelForTab(own, settings.model);
  const efforts = effortChoices(model, settings.effort);
  const row = (label: string, options: { key: string; label: string; selected: boolean; onPress(): void }[]) => <View style={styles.field}>
    <Text style={[styles.message, { color: palette.muted }]}>{label}</Text>
    <View style={styles.actions}>{options.map((option) => <Pressable key={option.key} accessibilityRole="button" accessibilityState={{ selected: option.selected }} onPress={option.onPress} style={[styles.chip, { borderColor: palette.border }, option.selected && { backgroundColor: palette.selected }]}>
      <Text style={{ color: palette.ink, fontSize: 12 }}>{option.label}</Text>
    </Pressable>)}</View>
  </View>;
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
    <View style={[styles.sheet, { backgroundColor: palette.card }]}>
      <Text style={[styles.title, { color: palette.ink }]}>Continue in new session</Text>
      <ScrollView style={styles.list}>
        {row("Agent", harnesses.map((harness) => ({ key: harness, label: harness, selected: harness === settings.harness, onPress: () => setSettings({ harness, model: harness === tab.harness ? tab.model : "", effort: null, permissionMode: settings.permissionMode }) })))}
        {own.length ? row("Model", own.map((choice) => ({ key: choice.id, label: choice.label, selected: choice.id === model?.id, onPress: () => setSettings({ ...settings, model: choice.id, effort: null }) }))) : null}
        {efforts.length ? row("Effort", efforts.map((effort) => ({ key: effort, label: EFFORT_LABEL[effort] ?? effort, selected: effort === settings.effort, onPress: () => setSettings({ ...settings, effort }) }))) : null}
        {row("Permission mode", PERMISSION_MODES.map((choice) => ({ key: choice.id, label: choice.label, selected: choice.id === settings.permissionMode, onPress: () => setSettings({ ...settings, permissionMode: choice.id }) })))}
        {row("Context", [{ key: "focused", label: "Focused", selected: mode === "focused", onPress: () => setMode("focused") }, { key: "full", label: "Complete history", selected: mode === "full", onPress: () => setMode("full") }])}
      </ScrollView>
      <Button label="Start" onPress={() => onStart(settings, mode)} />
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 6, gap: 6 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  flex: { flex: 1 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, maxWidth: 180 },
  disabled: { opacity: 0.4 },
  note: { fontSize: 12, lineHeight: 16 },
  recovery: { borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  title: { fontSize: 14, fontWeight: "600" },
  message: { fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.3)" },
  sheet: { padding: 16, gap: 10, maxHeight: "70%", borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  list: { flexGrow: 0 },
  choice: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8 },
  field: { gap: 4, marginBottom: 8 },
});
