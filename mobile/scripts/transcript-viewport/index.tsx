// Standalone native fixture: build with ENTRY_FILE=scripts/transcript-viewport/index.tsx.
// No pairing, account access, network transcript, or private data is used.
import { registerRootComponent } from "expo";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { TranscriptList } from "../../src/ui/TranscriptList";
import { ThemeProvider, useTheme } from "../../src/ui/theme";
import { TranscriptRow } from "../../src/ui/transcript";
import { turnRows } from "../../src/ui/transcript-rows";
import { ConversationPicker } from "../../src/ui/ConversationPicker";
import { buildTranscript } from "@terminalx/portable/transcript";
import type { AgentEvent } from "@terminalx/portable/events";

type Row = { id: number; text: string; image?: boolean; assistant?: boolean; messages?: number };
const markdownExample = "# Markdown on mobile\n\n**Bold**, *italic*, and `inline code`.\n\n[Documentation](https://example.com/docs?q=a%20b#section) and `https://example.com/code`.\n\n[Copyable host file](file:///workspace/example%20file.md#L12)\n\n- First item\n- Second item\n  - Nested item\n\n```ts\nconst url = 'https://example.com/output';\n```\n\n| Name | Count | Status | Detail |\n| --- | ---: | --- | --- |\n| **Answer** | 42 | Ready | `value` |\n| Other | 1 | Working | Scroll sideways |";
const rows = (start: number, count: number): Row[] => Array.from({ length: count }, (_, i) => ({
  id: start + i,
  text: `Synthetic turn ${start + i}\n${"Variable height conversation content. ".repeat(1 + (i % 7) * 3)}\nEND ${start + i}`,
}));
const endpoint = `http://127.0.0.1:${process.env.EXPO_PUBLIC_VIEWPORT_PORT ?? 18746}`;

function Fixture() {
  const { palette } = useTheme();
  const [items, setItems] = useState<Row[]>([]);
  const [conversation, setConversation] = useState(0);
  const [footer, setFooter] = useState(false);
  const [imageHeight, setImageHeight] = useState(32);
  const [label, setLabel] = useState("Empty");
  const viewport = useRef<View>(null);
  const scroll = useRef({ offset: 0, height: 0, contentHeight: 0 });
  const markers = useRef(new Map<number, View>());
  const mountedRows = useRef(new Map<string, View>());
  const footerMarker = useRef<View>(null);
  const state = useRef({ items, conversation, footer, label });
  state.current = { items, conversation, footer, label };

  useEffect(() => {
    let active = true;
    let busy = false;
    const measure = (node: View | null | undefined) => new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
      if (!node) return resolve(null);
      node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
    });
    const tick = async () => {
      if (busy || !active) return;
      busy = true;
      try {
        const response = await fetch(`${endpoint}/command`);
        const command = await response.json();
        if (!active) return;
        if (command.action) {
          const current = state.current.items;
          switch (command.action) {
            case "dismiss": Keyboard.dismiss(); break;
            case "cold": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems([]); setFooter(false); setTimeout(() => setItems(rows(100, 60)), 500); break;
            case "cached": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems(rows(100, 40)); setFooter(false); break;
            case "host": setItems((data) => [...data, ...rows(160, 12)]); break;
            case "live": setItems((data) => [...data, ...rows((data.at(-1)?.id ?? 0) + 1, 1)]); break;
            case "reconnect": setItems((data) => [...data.map((row) => ({ ...row })), ...rows((data.at(-1)?.id ?? 0) + 1, 3)]); break;
            case "earlier": setItems((data) => [...rows((data[0]?.id ?? 100) - 30, 30), ...data]); break;
            case "switch": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems(rows(300, 80)); setFooter(false); break;
            case "long": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems([{ id: 1, text: `${"Long synthetic response.\n".repeat(180)}END 1` }]); setFooter(false); break;
            case "heavy": case "massive": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems(rows(1, command.action === "massive" ? 200 : 20).map((row) => ({ ...row, messages: 10, text: "Synthetic paragraph with enough text to wrap on a phone.\n\n".repeat(16) }))); setFooter(false); break;
            case "grow": setItems(current.map((row, i) => i === current.length - 1 ? { ...row, text: `${row.text}\n${"Streaming output.\n".repeat(35)}GROWN END` } : row)); break;
            case "image": setImageHeight(32); setItems((data) => [...data, { id: (data.at(-1)?.id ?? 0) + 1, text: "Synthetic image", image: true }]); setTimeout(() => setImageHeight(600), 800); break;
            case "permission": setFooter(true); break;
            case "empty": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems([]); setFooter(false); break;
            case "short": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems(rows(1, 1)); setFooter(false); break;
            case "markdown": setConversation((c) => c + 1); scroll.current = { offset: 0, height: 0, contentHeight: 0 }; setItems([{ id: 1, text: markdownExample, assistant: true }]); setFooter(false); break;
          }
          setLabel(command.action);
        }
        const bounds = await measure(viewport.current);
        const measured = await Promise.all([...markers.current].map(async ([id, node]) => ({ id, rect: await measure(node) })));
        const mounted = await Promise.all([...mountedRows.current].map(async ([id, node]) => ({ id, rect: await measure(node) })));
        const latest = measured.find((row) => row.id === state.current.items.at(-1)?.id)?.rect;
        await fetch(`${endpoint}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          ...state.current, scroll: scroll.current, items: state.current.items.map((row) => row.id), bounds, latest, footer: await measure(footerMarker.current),
          mounted, visible: measured.filter(({ rect }) => rect && bounds && rect.y >= bounds.y && rect.y + rect.height <= bounds.y + bounds.height),
        }) });
      } catch { /* The fixture remains usable when the measurement server is stopped. */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => void tick(), 250);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const displayRows = useMemo(() => items.flatMap((item) => {
    const event: AgentEvent = { id: String(item.id), tabId: "synthetic", sessionId: "synthetic", seq: item.id * 1000, ts: new Date(item.id * 1000).toISOString(), harness: "codex", payload: { type: "user_message", text: item.assistant ? "Show a markdown example." : item.text, queued: false } };
    const events: AgentEvent[] = item.messages ? [event, ...Array.from({ length: item.messages }, (_, i): AgentEvent => ({ ...event, id: `${item.id}-reply-${i}`, seq: item.id * 1000 + i + 1, payload: { type: "assistant_text", text: item.text } }))] : item.assistant ? [event, { ...event, id: "harness", seq: item.id * 1000 + 1, payload: { type: "user_message", queued: false, text: "<task-notification><task-id>hidden-fixture-id</task-id></task-notification>\n<system-reminder>hidden fixture reminder</system-reminder>" } }, { ...event, id: "reply", seq: item.id * 1000 + 2, payload: { type: "assistant_text", text: item.text } }] : [event];
    const blocks = turnRows(buildTranscript(events, false).turns[0]);
    return blocks.map((row, index) => ({ ...item, key: row.key, row, last: index === blocks.length - 1 }));
  }), [items]);

  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Text style={[styles.title, { color: palette.ink }]}>Synthetic viewport · {label} · Agent {conversation}</Text>
    {label === "markdown" ? <ConversationPicker horizontal selectedTabId="claude" onSelect={() => {}} session={{ id: "synthetic", title: "Markdown fixture", project: "Synthetic", worktree: "fixture", modified: "today", tabs: [{ id: "claude", harness: "claude", status: "waiting" }, { id: "codex", harness: "codex", status: "in_progress" }] }} /> : null}
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
      <View ref={viewport} collapsable={false} style={styles.flex}>
        <TranscriptList onScroll={({ nativeEvent: e }) => { scroll.current = { offset: e.contentOffset.y, height: e.layoutMeasurement.height, contentHeight: e.contentSize.height }; }} key={conversation} data={displayRows} keyExtractor={(row) => row.key} contentContainerStyle={styles.transcriptRows}
          ListEmptyComponent={<Text style={{ color: palette.ink }}>No transcript yet</Text>}
          earlier={items.length ? <Pressable accessibilityRole="button" onPress={() => setItems((data) => [...rows(data[0].id - 30, 30), ...data])}><Text style={{ color: palette.ink }}>Load earlier</Text></Pressable> : null}
          latest={footer ? <View style={{ padding: 16, backgroundColor: palette.raised }}><Text style={{ color: palette.ink }}>{"Dynamic permission card\n".repeat(12)}</Text><View ref={footerMarker} collapsable={false}><Text style={{ color: palette.ink }}>PERMISSION END</Text></View></View> : null}
          renderItem={({ item }) => {
            return <View collapsable={false} ref={(node) => { if (node) mountedRows.current.set(item.key, node); else mountedRows.current.delete(item.key); }}><TranscriptRow row={item.row} />
              {item.last && item.image ? <Image source={{ uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }} style={{ height: imageHeight, backgroundColor: palette.accent }} /> : null}
              {item.last ? <View collapsable={false} ref={(node) => { if (node) markers.current.set(item.id, node); else markers.current.delete(item.id); }}><Text style={{ color: palette.accent }}>MARKER {item.id}</Text></View> : null}
            </View>;
          }} />
      </View>
      <TextInput accessibilityLabel="Synthetic composer" placeholder="Message this synthetic session" placeholderTextColor={palette.muted} style={[styles.composer, { color: palette.ink, backgroundColor: palette.card }]} />
    </KeyboardAvoidingView>
  </View>;
}
const styles = StyleSheet.create({ transcriptRows: { gap: 0 }, page: { flex: 1, paddingTop: 64, paddingBottom: 34 }, flex: { flex: 1 }, title: { padding: 12, fontSize: 14 }, composer: { minHeight: 54, padding: 12, fontSize: 16 } });
registerRootComponent(() => <ThemeProvider><Fixture /></ThemeProvider>);
