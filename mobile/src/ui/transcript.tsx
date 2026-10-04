import { Platform, StyleSheet, Text, View } from "react-native";
import { Terminal as TerminalIcon } from "lucide-react-native";
import type { PendingAsk, Turn, WorkItem } from "@terminalx/portable/transcript";
import { Button, Card } from "./primitives";
import { useTheme } from "./theme";

// How a conversation is drawn: the same cards for a session on a paired Mac
// and for a tab of a cloud workspace.

export function PermissionCard({ ask, connected, answering, error, onRespond }: { ask: PendingAsk; connected: boolean; answering: boolean; error?: string; onRespond(optionId: string): void }) {
  const { palette } = useTheme();
  const options = ask.kind === "permission" ? ask.options ?? [] : [];
  return <Card style={[styles.permission, { borderColor: `${palette.warning}66` }]}><Text style={[styles.permissionLabel, { color: palette.warning }]}>Permission waiting</Text><Text style={[styles.cardTitle, { color: palette.ink }]}>{ask.title ?? ask.toolName ?? "Permission request"}</Text>{ask.description ? <Text style={[styles.body, { color: palette.muted }]}>{ask.description}</Text> : null}{ask.input !== undefined ? <Text selectable style={[styles.monoSmall, { color: palette.muted }]}>{safeJson(ask.input)}</Text> : null}{options.length ? <View style={styles.permissionActions}>{options.map((option) => <Button key={option.id} label={option.label} kind={option.kind === "deny" ? "danger" : option.kind === "allow_once" ? "primary" : "secondary"} disabled={!connected || answering} onPress={() => onRespond(option.id)} style={styles.permissionAction} />)}</View> : <Text style={[styles.body, { color: palette.muted }]}>Answer this request from your Mac.</Text>}{!connected ? <Text style={[styles.permissionHint, { color: palette.warning }]}>Reconnect before answering.</Text> : null}{error ? <Text style={[styles.permissionHint, { color: palette.danger }]}>{error} The request may have lapsed; check your Mac.</Text> : null}</Card>;
}

export function TurnCard({ turn }: { turn: Turn }) {
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

function safeJson(value: unknown) { try { return JSON.stringify(value, null, 2).slice(0, 2_000); } catch { return "Input unavailable"; } }

const styles = StyleSheet.create({
  turn: { gap: 11 },
  promptBubble: { alignSelf: "flex-end", maxWidth: "88%", borderRadius: 17, borderBottomRightRadius: 5, paddingHorizontal: 14, paddingVertical: 11 },
  work: { gap: 10, paddingHorizontal: 3 },
  body: { fontSize: 15, lineHeight: 22 },
  reasoning: { fontSize: 13, fontStyle: "italic", lineHeight: 19 },
  tool: { minHeight: 38, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 11, paddingVertical: 8 },
  toolText: { flex: 1, fontSize: 13 },
  permission: { padding: 15, gap: 7, marginTop: 10 },
  permissionLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  permissionActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  permissionAction: { minHeight: 40, flexGrow: 1 },
  permissionHint: { fontSize: 12, lineHeight: 17 },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  monoSmall: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
});
