import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, MessageSquare, Plus, SquareTerminal, X } from "lucide-react-native";
import { providerName } from "@mobile/data/conversations";
import type { NewTabSettings, SessionSummary } from "@mobile/data/host-api";
import { branchChats } from "@mobile/data/session-list";
import { useApp } from "@mobile/state/AppProvider";
import { AgentMark } from "./AgentMark";
import { GlassIconButton } from "./glass";
import { StateMark } from "./MacIcon";
import { Button } from "./primitives";
import { useTheme } from "./theme";

/**
 * The session's bar, drawn here rather than by the navigator: a glass back
 * button, what the session is (its branch, else its title) over its project,
 * and on the right one glass button to the other view: Terminal from the
 * chat, Chat from the terminal.
 */
export function SessionHeader({ title, subtitle, onBack, view, onView }: {
  title: string;
  subtitle?: string;
  onBack(): void;
  /** Absent when the Mac offers no terminal view. */
  view?: "chat" | "terminal";
  onView(view: "chat" | "terminal"): void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
    <GlassIconButton label="Back" size={40} icon={<ChevronLeft size={24} color={palette.ink} strokeWidth={2.2} style={styles.chevron} />} onPress={onBack} />
    <View style={styles.titles}>
      <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
      {subtitle ? <Text numberOfLines={1} style={[styles.subtitle, { color: palette.muted }]}>{subtitle}</Text> : null}
    </View>
    {view ? <GlassIconButton label={view === "chat" ? "Terminal" : "Chat"} size={40} icon={view === "chat" ? <SquareTerminal size={19} color={palette.ink} strokeWidth={1.9} /> : <MessageSquare size={19} color={palette.ink} strokeWidth={1.9} />} onPress={() => onView(view === "chat" ? "terminal" : "chat")} /> : null}
  </View>;
}

/**
 * The chats this branch holds, as tabs, as the Mac's tab strip shows them:
 * each by its agent's mark and its own title, the open one underlined, and
 * `+` for another chat in the same branch.
 */
export function ChatTabs({ session, selectedTabId, onSelect, onAdd, onClose }: { session: SessionSummary; selectedTabId: string; onSelect(tabId: string): void; onAdd?(): void; onClose?(tabId: string): void }) {
  const { palette } = useTheme();
  const chats = branchChats(session);
  const scroll = useRef<ScrollViewInstance>(null);
  const offsets = useRef<Record<string, number>>({});
  useEffect(() => { scroll.current?.scrollTo({ x: Math.max(0, (offsets.current[selectedTabId] ?? 0) - 16), animated: true }); }, [selectedTabId]);
  return <View style={[styles.strip, { borderBottomColor: palette.border }]}>
    <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
      {chats.map((chat) => {
        const selected = chat.id === selectedTabId;
        return <Pressable key={chat.id} accessibilityRole="tab" accessibilityLabel={selected ? `${chat.name}, open` : `Open ${chat.name}`} accessibilityState={{ selected }} onLayout={({ nativeEvent }) => { offsets.current[chat.id] = nativeEvent.layout.x; }} onPress={() => { if (!selected) onSelect(chat.id); }} style={styles.tab}>
          <View style={styles.tabLabel}>
            <AgentMark id={chat.harness} size={14} color={selected ? palette.ink : palette.muted} />
            <Text numberOfLines={1} style={[styles.tabName, { color: selected ? palette.ink : palette.muted, fontWeight: selected ? "600" : "400" }]}>{chat.name}</Text>
            <StateMark state={chat.state} info={palette.info} warning={palette.warning} />
            {/* As on the Mac, a tab closes from its own ×: here the open one's, so a scroll is never a close. */}
            {selected && onClose && chats.length > 1 ? <Pressable accessibilityRole="button" accessibilityLabel={`Close ${chat.name}`} hitSlop={10} onPress={() => onClose(chat.id)} style={({ pressed }) => [styles.close, { backgroundColor: pressed ? palette.selected : palette.raised }]}>
              <X size={11} color={palette.muted} strokeWidth={2.4} />
            </Pressable> : null}
          </View>
          <View style={[styles.underline, { backgroundColor: selected ? palette.ink : "transparent" }]} />
        </Pressable>;
      })}
      {onAdd ? <Pressable accessibilityRole="button" accessibilityLabel="New chat in this branch" hitSlop={8} onPress={onAdd} style={({ pressed }) => [styles.add, pressed && { opacity: 0.5 }]}>
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
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
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
  tabLabel: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 },
  tabName: { flexShrink: 1, fontSize: 15, letterSpacing: -0.2 },
  underline: { height: 2, borderRadius: 1, marginTop: 8 },
  add: { width: 40, alignItems: "center", justifyContent: "center", paddingBottom: 2 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 10, gap: 14 },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3 },
  sheetTitle: { fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  agents: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  agent: { flexDirection: "row", alignItems: "center", gap: 7, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
  agentName: { fontSize: 15 },
  prompt: { minHeight: 96, maxHeight: 180, borderRadius: 14, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontSize: 16, textAlignVertical: "top" },
  error: { fontSize: 13, lineHeight: 18 },
});
