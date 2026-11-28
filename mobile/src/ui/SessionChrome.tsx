import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bell, BellOff, ChevronLeft, MessageSquare, Plus, SquareTerminal, X } from "lucide-react-native";
import { providerName } from "@mobile/data/conversations";
import type { NewTabSettings, SessionSummary } from "@mobile/data/host-api";
import { branchChats } from "@mobile/data/session-list";
import { useApp } from "@mobile/state/AppProvider";
import type { ConnectionState } from "@mobile/state/connection-view";
import { ConnectionLine } from "./ConnectionLine";
import { AgentMark } from "./AgentMark";
import { GlassIconButton } from "./glass";
import { StateMark } from "./MacIcon";
import { Button } from "./primitives";
import { useTheme } from "./theme";
import { keyboardAvoidingBehavior } from "@mobile/ui/keyboard";

/**
 * The session's bar, drawn here rather than by the navigator: a glass back
 * button, what the session is (its branch, else its title) over its project,
 * and on the right one glass button to the other view: Terminal from the
 * chat, Chat from the terminal.
 */
export function SessionHeader({ title, subtitle, connection, onBack, view, onView, muted, onNotifications }: {
  title: string;
  subtitle?: string;
  /** While not simply connected, the connection takes the subtitle's place, in the shared words (#983); connected says nothing. */
  connection?: ConnectionState;
  onBack(): void;
  /** Absent when the Mac offers no terminal view. */
  view?: "chat" | "terminal";
  onView(view: "chat" | "terminal"): void;
  /** This session is muted on this phone (#990): its bell is struck through. */
  muted?: boolean;
  /** Opens "Notifications for this session"; absent, no bell. */
  onNotifications?(): void;
}) {
  const { palette } = useTheme();
  // The session's bell (22.07 frame 5) beside the view switch.
  const bell = onNotifications ? <GlassIconButton label="Notifications for this session" size={40} icon={muted ? <BellOff size={18} color={palette.ink} strokeWidth={1.9} /> : <Bell size={18} color={palette.ink} strokeWidth={1.9} />} onPress={onNotifications} /> : null;
  return <ScreenHeader title={title} onBack={onBack}
    subtitle={connection && connection !== "connected" && connection !== "none" ? <ConnectionLine state={connection} /> : subtitle}
    trailing={<>{bell}{view ? <GlassIconButton label={view === "chat" ? "Terminal" : "Chat"} size={40} icon={view === "chat" ? <SquareTerminal size={19} color={palette.ink} strokeWidth={1.9} /> : <MessageSquare size={19} color={palette.ink} strokeWidth={1.9} />} onPress={() => onView(view === "chat" ? "terminal" : "chat")} /> : null}</>} />;
}

/**
 * A conversation's bar (22.03, 22.06): a glass back button, the title over one
 * quiet line, and at most one glass button on the right. A string subtitle is
 * drawn as that line; anything else is drawn as it is.
 */
export function ScreenHeader({ title, subtitle, onBack, trailing }: { title: string; subtitle?: ReactNode; onBack(): void; trailing?: ReactNode }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
    <GlassIconButton label="Back" size={40} icon={<ChevronLeft size={24} color={palette.ink} strokeWidth={2.2} style={styles.chevron} />} onPress={onBack} />
    <View style={styles.titles}>
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
      {typeof subtitle === "string" ? subtitle ? <Text numberOfLines={1} style={[styles.subtitle, { color: palette.muted }]}>{subtitle}</Text> : null : subtitle}
    </View>
    {trailing}
  </View>;
}

/** The quiet line under a `ScreenHeader` title, for a subtitle that needs its own label or test id. */
export function HeaderLine({ text, label, testID }: { text: string; label?: string; testID?: string }) {
  const { palette } = useTheme();
  return <Text testID={testID} accessibilityLabel={label} numberOfLines={1} style={[styles.subtitle, { color: palette.muted }]}>{text}</Text>;
}

/**
 * The chats this branch holds, as tabs, as the Mac's tab strip shows them:
 * each by its agent's mark and the name made for it, else its own title
 * (`branchChats`), the open one underlined, and
 * `+` for another chat in the same branch.
 */
/**
 * `actionsDisabled`: + and × stay where they are, dimmed, while the Mac cannot
 * act on them (not connected), so the strip does not change with the connection (#983).
 */
export function ChatTabs({ session, selectedTabId, onSelect, onAdd, onClose, actionsDisabled = false }: { session: SessionSummary; selectedTabId: string; onSelect(tabId: string): void; onAdd?(): void; onClose?(tabId: string): void; actionsDisabled?: boolean }) {
  const { palette } = useTheme();
  const chats = branchChats(session);
  const scroll = useRef<ScrollViewInstance>(null);
  const offsets = useRef<Record<string, number>>({});
  useEffect(() => { scroll.current?.scrollTo({ x: Math.max(0, (offsets.current[selectedTabId] ?? 0) - 16), animated: true }); }, [selectedTabId]);
  return <View accessibilityRole="tablist" style={[styles.strip, { borderBottomColor: palette.border }]}>
    <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
      {chats.map((chat) => {
        const selected = chat.id === selectedTabId;
        return <View key={chat.id} onLayout={({ nativeEvent }) => { offsets.current[chat.id] = nativeEvent.layout.x; }} style={styles.tab}>
          <View style={styles.tabLabel}>
            <Pressable accessibilityRole="tab" accessibilityLabel={selected ? `${chat.name}, open` : `Open ${chat.name}`} accessibilityState={{ selected }} onPress={() => { if (!selected) onSelect(chat.id); }} style={styles.tabMain}>
              <AgentMark id={chat.harness} size={14} color={selected ? palette.ink : palette.muted} />
              <Text numberOfLines={1} style={[styles.tabName, { color: selected ? palette.ink : palette.muted, fontWeight: selected ? "600" : "400" }]}>{chat.name}</Text>
              <StateMark state={chat.state} info={palette.info} warning={palette.warning} />
            </Pressable>
            {/* Sibling of the tab Pressable so VoiceOver/TalkBack can reach it directly. */}
            {selected && onClose && chats.length > 1 ? <Pressable accessibilityRole="button" accessibilityLabel={`Close ${chat.name}`} accessibilityState={{ disabled: actionsDisabled }} disabled={actionsDisabled} hitSlop={13} onPress={() => onClose(chat.id)} style={({ pressed }) => [styles.close, { backgroundColor: pressed ? palette.selected : palette.raised, opacity: actionsDisabled ? 0.4 : 1 }]}>
              <X size={11} color={palette.muted} strokeWidth={2.4} />
            </Pressable> : null}
          </View>
          <View style={[styles.underline, { backgroundColor: selected ? palette.ink : "transparent" }]} />
        </View>;
      })}
      {onAdd ? <Pressable accessibilityRole="button" accessibilityLabel="New chat in this branch" accessibilityState={{ disabled: actionsDisabled }} disabled={actionsDisabled} hitSlop={8} onPress={onAdd} style={({ pressed }) => [styles.add, { opacity: actionsDisabled ? 0.4 : pressed ? 0.5 : 1 }]}>
        <Plus size={18} color={palette.muted} strokeWidth={2} />
      </Pressable> : null}
    </ScrollView>
  </View>;
}

/**
 * Another chat in the same branch: which agent, and what to ask it. The Mac
 * opens it as a new tab, with this tab's model, effort and permissions when
 * the agent is the same.
 */
export function NewChatSheet({ visible, sessionId, tabId, onClose, onStarted }: { visible: boolean; sessionId: string; tabId: string; onClose(): void; onStarted(tabId: string): void }) {
  const app = useApp();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [base, setBase] = useState<NewTabSettings | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [harness, setHarness] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    void Promise.all([app.api.tabControls(sessionId, tabId).catch(() => null), app.api.models().catch(() => [])]).then(([tab, models]) => {
      if (!active) return;
      const own = tab ? { harness: tab.harness, model: tab.model, effort: tab.effort ?? null, permissionMode: tab.permissionMode } : null;
      setBase(own);
      const harnesses = [...new Set([...(own ? [own.harness] : []), ...models.map((model) => model.harness)])];
      setAgents(harnesses.length ? harnesses : ["claude", "codex"]);
      setHarness((current) => current ?? own?.harness ?? harnesses[0] ?? "claude");
    });
    return () => { active = false; };
  }, [app.api, sessionId, tabId, visible]);

  // Closed, the sheet forgets what was typed in it: the next opens empty.
  const close = () => { setText(""); setError(null); onClose(); };

  const start = async () => {
    const prompt = text.trim();
    if (!prompt || !harness || busy) return;
    setBusy(true); setError(null);
    try {
      const settings: NewTabSettings = base && base.harness === harness ? base : { harness, model: "", effort: null, permissionMode: base?.permissionMode ?? null };
      const result = await app.api.continueInNewTab(sessionId, tabId, settings, prompt);
      if (!result.started) return setError(result.message);
      await app.refreshSessions();
      setText("");
      onStarted(result.tabId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
    <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={close} />
    <KeyboardAvoidingView behavior={keyboardAvoidingBehavior()}>
      <View style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.grabber, { backgroundColor: palette.border }]} />
        <Text style={[styles.sheetTitle, { color: palette.ink }]}>New chat in this branch</Text>
        <View style={styles.agents}>{agents.map((id) => {
          const selected = id === harness;
          return <Pressable key={id} accessibilityRole="button" accessibilityLabel={providerName(id)} accessibilityState={{ selected }} onPress={() => setHarness(id)} style={[styles.agent, { borderColor: selected ? palette.ink : palette.border, backgroundColor: selected ? palette.selected : "transparent" }]}>
            <AgentMark id={id} size={15} color={selected ? palette.ink : palette.muted} />
            <Text style={[styles.agentName, { color: selected ? palette.ink : palette.muted }]}>{providerName(id)}</Text>
          </Pressable>;
        })}</View>
        <TextInput accessibilityLabel="First message" value={text} onChangeText={setText} autoFocus multiline placeholder="What should it do?" placeholderTextColor={palette.faint} style={[styles.prompt, { color: palette.ink, backgroundColor: palette.raised }]} />
        {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
        <Button label={busy ? "Starting…" : "Start chat"} disabled={!text.trim() || !harness || busy} onPress={() => void start()} />
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  chevron: { marginLeft: -2 },
  titles: { flex: 1, gap: 1, paddingLeft: 6 },
  title: { fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  subtitle: { fontSize: 13, letterSpacing: -0.1 },
  close: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", marginLeft: 2 },
  strip: { borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { paddingHorizontal: 12, alignItems: "stretch" },
  tab: { paddingHorizontal: 10, paddingTop: 8, justifyContent: "space-between", maxWidth: 220 },
  tabLabel: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 36 },
  tabMain: { flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1, minHeight: 36 },
  tabName: { flexShrink: 1, fontSize: 15, letterSpacing: -0.2 },
  underline: { height: 2, borderRadius: 1, marginTop: 8 },
  add: { width: 40, alignItems: "center", justifyContent: "center", paddingBottom: 2 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 10, gap: 14 },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3 },
  sheetTitle: { fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  agents: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  agent: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8 },
  agentName: { fontSize: 15 },
  prompt: { minHeight: 96, maxHeight: 180, borderRadius: 14, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontSize: 16, textAlignVertical: "top" },
  error: { fontSize: 13, lineHeight: 18 },
});
