import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BYPASS_MODE, PERMISSION_MODES, bypassEffect, effortChoices, EFFORT_LABEL, modelForTab, type ModelInfo } from "@terminalx/portable/agentSettings";
import type { ContextMode } from "@terminalx/portable/continuation";
import type { AgentEvent } from "@terminalx/portable/events";
import type { NewTabSettings, TabControls } from "../data/host-api";
import { continueHere, continueInNewTab, oneAtATime, recoveryState, resendLast, resumeLogDetail, retrySafely, settingsView, type ResumeFailure, type ResumeResult } from "../data/session-controls";
import { cacheEpoch, readSaved, writeSaved } from "../data/transcript-cache";
import { useApp } from "../state/AppProvider";
import { useHostFeatures } from "../state/host-features";
import { Button, Card } from "./primitives";
import { useTheme } from "./theme";

const CONTROL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_started",
  "turn_completed",
  "settings_changed",
  "error",
  "recovery",
  "conversation",
]);

function controlEventSignature(events: readonly AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (CONTROL_EVENT_TYPES.has(event.payload.type)) {
      return `${event.seq}:${event.id}:${event.payload.type}`;
    }
  }
  return "";
}

function sameTabControls(left: TabControls | null, right: TabControls | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.harness === right.harness
    && left.model === right.model
    && (left.effort ?? null) === (right.effort ?? null)
    && left.permissionMode === right.permissionMode
    && (left.requestedModel ?? null) === (right.requestedModel ?? null)
    && (left.requestedEffort ?? null) === (right.requestedEffort ?? null)
    && (left.requestedPermissionMode ?? null) === (right.requestedPermissionMode ?? null)
    && left.status === right.status
    && left.transport === right.transport;
}

function sameModels(left: readonly ModelInfo[], right: readonly ModelInfo[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

interface Choice { key: string; label: string; hint?: string; current?: boolean; pending?: boolean; onSelect(): void }

/**
 * The controls in pieces, for a composer that places them itself: `chips` in
 * its bar, `panel` (recovery, notes, sheets) above it, and Interrupt on its
 * send button while the agent works.
 */
export interface SessionControlParts {
  chips: ReactNode;
  /** The pickers one by one, for a composer that draws them its own way: what each shows, and how it opens. */
  /** `bypass`: whether the mode in force lets the agent act without asking. */
  settings: { model: Setting; effort: Setting | null; mode: Setting & { bypass: boolean } };
  panel: ReactNode;
  busy: boolean;
  working: boolean;
  interrupt(): void;
  stop(): void;
}
export interface Setting { label: string; disabled: boolean; open(): void }

/**
 * Stop, Interrupt, the recovery banner's actions, the model, effort and mode
 * pickers, and Continue in new session: what the desktop offers for a tab,
 * for a Mac that takes them (`sessionControls`).
 */
export function SessionControls({ sessionId, tabId, events, asks, connected, onOpenTab, children }: {
  sessionId: string;
  tabId: string;
  events: AgentEvent[];
  /** Requests waiting for an answer; their cards are drawn by the transcript. */
  asks: number;
  connected: boolean;
  onOpenTab(tabId: string): void;
  /** Given, it lays the controls out; `null` when the Mac offers none. Without it they are drawn stacked. */
  children?: (parts: SessionControlParts | null) => ReactNode;
}) {
  const app = useApp();
  const { palette } = useTheme();
  const host = app.activeHost?.id;
  // Named by the Mac only while its runtime serves them (#730).
  const supported = useHostFeatures(app.api, host)?.sessionControls === 1;
  const [tab, setTab] = useState<TabControls | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Until the Mac answers, the tab's model and mode as they were last time: the row stays in place,
  // dimmed, instead of appearing once the phone connects (#983).
  const tabKey = `tab:${JSON.stringify([sessionId, tabId])}`;
  useEffect(() => {
    if (!host) return;
    let active = true;
    void readSaved(host, tabKey, isTabControls).then((saved) => { if (active && saved) setTab((current) => current ?? saved); });
    void readSaved(host, "models", isModelList).then((saved) => { if (active && saved) setModels((current) => current.length ? current : saved); });
    return () => { active = false; };
  }, [host, tabKey]);
  const [working, setWorking] = useState(false);
  // One action at a time, also between a tap and the render that disables the buttons: a resume is never sent twice.
  const [gate] = useState(oneAtATime);
  /** `tone`: an error, news, or a resume that may still be under way on the Mac. `reconnect`: offer to connect again. */
  const [feedback, setFeedback] = useState<{ tone: "error" | "success" | "pending"; text: string; reconnect?: boolean } | null>(null);
  const [picker, setPicker] = useState<{ title: string; choices: Choice[] } | null>(null);
  const [continuing, setContinuing] = useState(false);

  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const refreshScope = useRef(`${host ?? ""}:${sessionId}:${tabId}`);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    refreshScope.current = `${host ?? ""}:${sessionId}:${tabId}`;
    refreshInFlight.current = null;
    refreshQueued.current = false;
  }, [host, sessionId, tabId]);

  const refresh = useCallback(() => {
    const scope = `${host ?? ""}:${sessionId}:${tabId}`;
    if (refreshInFlight.current && refreshScope.current === scope) {
      refreshQueued.current = true;
      return refreshInFlight.current;
    }
    const run = (async () => {
      do {
        refreshQueued.current = false;
        // Taken before the request: a Mac forgotten while it is under way is not saved again.
        const epoch = host ? cacheEpoch(host) : 0;
        try {
          const next = await app.api.tabControls(sessionId, tabId);
          if (!mounted.current || refreshScope.current !== scope) return;
          setTab((current) => {
            if (sameTabControls(current, next)) return current;
            if (next && host) void writeSaved(host, tabKey, next, epoch);
            return next;
          });
        } catch {
          // The connection failed: what is shown stays, dimmed, until it is back.
        }
      } while (refreshQueued.current && mounted.current && refreshScope.current === scope);
    })().finally(() => {
      if (refreshInFlight.current === run) refreshInFlight.current = null;
    });
    refreshInFlight.current = run;
    return run;
  }, [app.api, host, sessionId, tabId, tabKey]);
  // Refresh only on control-affecting events, not every streamed delta/chunk.
  const controlSignal = useMemo(() => controlEventSignature(events), [events]);
  useEffect(() => { if (supported && connected) void refresh(); }, [connected, controlSignal, refresh, supported]);
  useEffect(() => {
    if (!supported || !connected) return;
    let active = true;
    const epoch = host ? cacheEpoch(host) : 0;
    void app.api.models().then((list) => {
      if (!active || !list.length) return;
      setModels((current) => {
        if (sameModels(current, list)) return current;
        if (host) void writeSaved(host, "models", list, epoch);
        return list;
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [app.api, connected, host, supported]);

  if (!supported || !tab) return children ? <>{children(null)}</> : null;
  const view = settingsView(tab, models);
  const { kind, offer } = recoveryState(events, asks, tab);
  // What was saved may be out of date: the agent's state is not claimed, and nothing is asked of the Mac, until it answers.
  const busy = connected && tab.status === "in_progress";
  const locked = working || !connected;
  // A resume may be asked for while the phone reconnects: it waits for the connection (#1290).
  const reconnecting = app.connectionStage === "connecting" || app.connectionStage === "reconnecting";
  const resumeLocked = working || !(connected || reconnecting);

  /** One action at a time; its error, or its outcome when that is news, is said under the controls. */
  const act = async (action: () => Promise<string | null>, success?: string) => {
    if (!gate.enter()) return;
    setWorking(true);
    setFeedback(null);
    try {
      const error = await action();
      setFeedback(error ? { tone: "error", text: error } : success ? { tone: "success", text: success } : null);
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      gate.leave();
      setWorking(false);
      void refresh();
    }
  };
  /** A resume: what failed is said with the next step, and written to the connection log with its step and code. */
  const resume = (action: () => Promise<ResumeResult & { tabId?: string }>, success: string | null, then?: (tabId: string) => Promise<void> | void) => {
    if (!gate.enter()) return;
    setWorking(true);
    setFeedback(null);
    void (async () => {
      try {
        const result = await action();
        if (!result.done) return report(result.failure);
        if (result.tabId && then) await then(result.tabId);
        setFeedback(result.note ? { tone: "error", text: result.note } : success ? { tone: "success", text: success } : null);
      } catch (cause) {
        // Nothing above throws; should anything, it is said and logged like any other failure.
        app.connection.note("error", "Session resume failed", cause instanceof Error ? cause.message : String(cause));
        setFeedback({ tone: "error", text: "Not resumed: something on this phone stopped the request. Try again." });
      } finally {
        gate.leave();
        setWorking(false);
        void refresh();
      }
    })();
  };
  const report = (failure: ResumeFailure) => {
    app.connection.note(failure.pending ? "warning" : "error", failure.pending ? "Session resume not confirmed" : "Session resume failed", resumeLogDetail(failure));
    setFeedback({ tone: failure.pending ? "pending" : "error", text: failure.text, reconnect: failure.next === "reconnect" });
  };
  const done = (result: { done: true } | { done: false; message: string }) => result.done ? null : result.message;
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

  const interrupt = () => void act(async () => done(await app.api.interrupt(sessionId, tabId)));
  const stop = () => void act(async () => done(await app.api.stop(sessionId, tabId)));
  const settings = {
    model: { label: view.modelName, disabled: locked, open: () => { freshModels(); setPicker({ title: "Model", choices: modelChoices((model) => void act(async () => done(await app.api.setModel(sessionId, tabId, model.id)))) }); } },
    effort: view.efforts.length ? { label: view.effortName ?? "Effort", disabled: locked, open: () => setPicker({ title: "Effort", choices: view.efforts.map((effort) => ({ key: effort.id, label: effort.label, current: effort.id === tab.effort, pending: effort.pending, onSelect: () => void act(async () => done(await app.api.setEffort(sessionId, tabId, effort.id))) })) }) } : null,
    mode: { label: view.modeName, bypass: (tab.requestedPermissionMode ?? tab.permissionMode) === BYPASS_MODE, disabled: locked, open: () => setPicker({ title: "Permission mode", choices: view.modes.map((mode) => ({ key: mode.id, label: mode.label, hint: mode.hint, current: mode.current, pending: mode.pending, onSelect: () => chooseMode(mode.id) })) }) },
  };
  const chips = <>
    <Chip label={settings.model.label} disabled={locked} onPress={settings.model.open} />
    {settings.effort ? <Chip label={settings.effort.label} disabled={locked} onPress={settings.effort.open} /> : null}
    <Chip label={settings.mode.label} disabled={locked} onPress={settings.mode.open} />
  </>;
  const panel = <>
    {view.note ? <Text accessibilityLiveRegion="polite" style={[styles.note, { color: palette.muted }]}>{view.note}</Text> : null}
    {kind ? <Card style={[styles.recovery, { borderColor: palette.warning }]}>
      <Text style={[styles.title, { color: palette.ink }]}>{offer.title}</Text>
      <Text style={[styles.message, { color: palette.muted }]}>{offer.message}</Text>
      <View style={styles.actions}>
        {offer.resend ? <Button label="Resend last prompt" disabled={resumeLocked} onPress={() => resume(() => resendLast(app.api, sessionId, tabId), null)} /> : null}
        {offer.retry ? <Button label={offer.retry} kind={kind === "signed_out" ? "secondary" : "primary"} disabled={resumeLocked} onPress={() => resume(() => retrySafely(app.api, sessionId, tabId), null)} /> : null}
        {offer.sendContinue ? <Button label="Continue here" kind="secondary" disabled={resumeLocked} onPress={() => resume(() => continueHere(app.api, tabId), null)} /> : null}
        {offer.chooseModel ? <Button label="Choose another model" kind="secondary" disabled={resumeLocked} onPress={() => { freshModels(); setPicker({ title: "Retry on another model", choices: modelChoices((model) => resume(() => retrySafely(app.api, sessionId, tabId, model.id), null)) }); }} /> : null}
        <Button label="Stop session" kind="secondary" disabled={locked} onPress={stop} />
        {offer.continueInNewSession ? <Button label="Continue in new session" kind="secondary" disabled={resumeLocked} onPress={() => setContinuing(true)} /> : null}
      </View>
    </Card> : null}
    {feedback ? <View style={styles.feedback}>
      <Text accessibilityLiveRegion="polite" style={[styles.note, styles.flex, { color: feedback.tone === "error" ? palette.danger : feedback.tone === "pending" ? palette.muted : palette.success }]}>{feedback.text}</Text>
      {feedback.reconnect && !connected ? <Button label="Reconnect" kind="secondary" size="small" onPress={() => app.retryConnection()} /> : null}
    </View> : null}
    <ChoiceSheet picker={picker} onClose={() => setPicker(null)} />
    {continuing ? <ContinueSheet tab={tab} models={models} onClose={() => setContinuing(false)} onStart={(settings, mode) => {
      setContinuing(false);
      resume(() => continueInNewTab(app.api, sessionId, tabId, settings, mode), "Continued in a new conversation.", async (next) => {
        await app.refreshSessions();
        onOpenTab(next);
      });
    }} /> : null}
  </>;

  if (children) return <>{children({ chips, settings, panel, busy, working, interrupt, stop })}</>;
  return <View style={styles.wrap}>
    {busy ? <View style={styles.row}>
      <Button label="Interrupt" kind="secondary" disabled={working} onPress={interrupt} style={styles.flex} />
      <Button label="Stop" kind="danger" disabled={working} onPress={stop} style={styles.flex} />
    </View> : null}
    <View style={styles.row}>{chips}</View>
    {panel}
  </View>;
}

function isTabControls(value: unknown): value is TabControls {
  const tab = value as TabControls | null;
  return !!tab && typeof tab === "object" && typeof tab.harness === "string" && typeof tab.model === "string" && typeof tab.permissionMode === "string" && typeof tab.status === "string";
}

function isModelList(value: unknown): value is ModelInfo[] {
  return Array.isArray(value) && value.every((model) => typeof model?.id === "string" && typeof model.harness === "string");
}

function Chip({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.chip, { backgroundColor: pressed ? palette.selected : "transparent" }, disabled && styles.disabled]}>
    <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 13, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
}

function ChoiceSheet({ picker, onClose }: { picker: { title: string; choices: Choice[] } | null; onClose(): void }) {
  const { palette } = useTheme();
  // The sheet’s foot clears the home indicator, and on Android the navigation bar drawn over the app.
  const insets = useSafeAreaInsets();
  return <Modal visible={!!picker} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
    <View style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 16 }]}>
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
  const insets = useSafeAreaInsets();
  const own = models.filter((model) => model.harness === settings.harness);
  const model = modelForTab(own, settings.model);
  const efforts = effortChoices(model, settings.effort);
  const row = (label: string, options: { key: string; label: string; selected: boolean; onPress(): void }[]) => <View style={styles.field}>
    <Text style={[styles.message, { color: palette.muted }]}>{label}</Text>
    <View style={styles.actions}>{options.map((option) => <Pressable key={option.key} accessibilityRole="button" accessibilityState={{ selected: option.selected }} onPress={option.onPress} style={[styles.chip, styles.outlined, { borderColor: palette.border }, option.selected && { backgroundColor: palette.selected }]}>
      <Text style={{ color: palette.ink, fontSize: 12 }}>{option.label}</Text>
    </Pressable>)}</View>
  </View>;
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
    <View style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 16 }]}>
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
  feedback: { flexDirection: "row", alignItems: "center", gap: 8 },
  chip: { borderRadius: 14, paddingHorizontal: 9, paddingVertical: 6, maxWidth: 180 },
  outlined: { borderWidth: StyleSheet.hairlineWidth },
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
