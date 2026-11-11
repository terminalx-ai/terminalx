import { memo, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Terminal as TerminalIcon } from "lucide-react-native";
import { askAgentNote, COMPACTING_LINE, compactionStatus, messageTime } from "@terminalx/portable/transcript";
import type { PendingAsk, Turn, WorkItem } from "@terminalx/portable/transcript";
import { Button, Card } from "./primitives";
import { useTheme } from "./theme";
import { Markdown, MarkdownBlock } from "./Markdown";
import { LinkedText, linkedText } from "./LinkedText";
import { deliveryNote, type TurnRow } from "./transcript-rows";
import { PromptImages } from "./PromptImages";

// How a conversation is drawn: the same cards for a session on a paired Mac
// and for a tab of a cloud workspace.

export function PermissionCard({ ask, connected, answering, error, onRespond }: { ask: PendingAsk; connected: boolean; answering: boolean; error?: string; onRespond(optionId: string): void }) {
  const { palette } = useTheme();
  const options = ask.kind === "permission" ? ask.options ?? [] : [];
  const agentNote = askAgentNote(ask);
  return <Card style={[styles.permission, { borderColor: `${palette.warning}66` }]}>
    <Text style={[styles.permissionLabel, { color: palette.warning }]}>Permission waiting</Text>
    <LinkedText style={[styles.cardTitle, { color: palette.ink }]}>{ask.title ?? ask.toolName ?? "Permission request"}</LinkedText>
    {/* Why the card is up, in the desktop card's words (#775), apart from what the agent says of the call. */}
    {ask.reason ? <Text testID="permission-reason" style={[styles.body, { color: palette.ink }]}>{ask.reason}</Text> : null}
    {agentNote ? <Text testID="permission-agent-note" selectable style={[styles.body, { color: palette.muted }]}><Text style={styles.agentLabel}>Agent: </Text>{linkedText(agentNote)}</Text>
      : ask.description ? <LinkedText style={[styles.body, { color: palette.muted }]}>{ask.description}</LinkedText> : null}
    {ask.input !== undefined ? <LinkedText style={[styles.monoSmall, { color: palette.muted }]}>{safeJson(ask.input)}</LinkedText> : null}
    {options.length ? <View style={styles.permissionActions}>{options.map((option) => <Button key={option.id} label={option.label} kind={option.kind === "deny" ? "danger" : option.kind === "allow_once" ? "primary" : "secondary"} disabled={!connected || answering} onPress={() => onRespond(option.id)} style={styles.permissionAction} />)}</View> : <Text style={[styles.body, { color: palette.muted }]}>Answer this request from your Mac.</Text>}
    {!connected ? <Text style={[styles.permissionHint, { color: palette.warning }]}>Reconnect before answering.</Text> : null}
    {error ? <LinkedText style={[styles.permissionHint, { color: palette.danger }]}>{`${error} The request may have lapsed; check your Mac.`}</LinkedText> : null}
  </Card>;
}

/** A compaction is running (`Transcript.compacting`): said at the newest edge of the conversation, as the desktop's chat does. */
export function CompactingLine() {
  const { palette } = useTheme();
  return <Text accessibilityLiveRegion="polite" style={[styles.compacting, { color: palette.muted }]}>{COMPACTING_LINE}</Text>;
}

/** The reader's own words: a turn's prompt, or a message the agent took while the turn ran. */
function ReaderBubble({ text, ts, note, images }: { text: string; ts?: string; note?: string; images?: { url: string; name?: string }[] }) {
  const { palette } = useTheme();
  return <View style={styles.reader}>
    {images?.length ? <PromptImages images={images} /> : null}
    {text.trim() || !images?.length ? <View style={[styles.promptBubble, { backgroundColor: palette.selected }]}><LinkedText style={[styles.body, { color: palette.ink }]}>{text}</LinkedText></View> : null}
    {note ? <Text style={[styles.deliveryNote, { color: palette.warning }]}>{note}</Text> : null}
    <MessageTime ts={ts} align="right" />
  </View>;
}

export function TurnCard({ turn }: { turn: Turn }) {
  return <View style={styles.turn}>{turn.prompt ? <ReaderBubble text={turn.prompt.text} ts={turn.prompt.messageTs} note={deliveryNote(turn.prompt)} images={turn.prompt.images} /> : null}<View style={styles.work}>{turn.work.map((item) => <WorkRow key={item.key} item={item} />)}{turn.finalText ? <Markdown text={turn.finalText} /> : null}</View></View>;
}

export const TranscriptRow = memo(function TranscriptRow({ row }: { row: TurnRow }) {
  return <View style={row.startsTurn ? styles.turnStart : styles.row}>
    {row.kind === "prompt" ? <ReaderBubble text={row.text} ts={row.ts} note={row.note} images={row.images} />
      : <View style={styles.work}>{row.kind === "markdown" ? <View><MarkdownBlock token={row.token} /><MessageTime ts={row.ts} /></View> : <WorkRow item={row.item} />}</View>}
  </View>;
});

function WorkRow({ item }: { item: WorkItem }) {
  const { palette } = useTheme();
  if (item.kind === "text") return <View><Markdown text={item.text} /><MessageTime ts={item.messageTs} /></View>;
  if (item.kind === "reasoning") return <View style={[styles.thought, { borderLeftColor: palette.border }]}><LinkedText style={[styles.thoughtText, { color: palette.muted }]}>{item.text}</LinkedText></View>;
  if (item.kind === "tool") return <View style={styles.tool}><TerminalIcon size={13} color={palette.faint} /><View style={styles.toolBody}><LinkedText numberOfLines={2} style={[styles.toolLine, { color: palette.muted }]}>{`${item.call.title ?? item.call.name}${item.call.abandoned ? " · stopped" : ""}`}</LinkedText>{item.call.result?.safetyCheck ? <Text testID="tool-safety-check" style={[styles.toolLine, { color: palette.warning }]}>{item.call.result.safetyCheck}</Text> : null}</View></View>;
  if (item.kind === "tool_group") return <View style={styles.tool}><TerminalIcon size={13} color={palette.faint} /><Text style={[styles.toolText, { color: palette.muted }]}>{item.name} · {item.calls.length} calls</Text></View>;
  if (item.kind === "error") return <LinkedText style={[styles.body, { color: palette.danger }]}>{item.text}</LinkedText>;
  if (item.kind === "queued") return <View><LinkedText style={[styles.reasoning, { color: palette.muted }]}>{`Queued · ${item.text}`}</LinkedText><MessageTime ts={item.messageTs} />{item.inputOccupied || item.withdrawn ? <Text style={[styles.reasoning, { color: palette.warning }]}>{deliveryNote(item)}</Text> : null}</View>;
  if (item.kind === "message") return <ReaderBubble text={item.text} ts={item.messageTs} note={deliveryNote(item)} images={item.images} />;
  if (item.kind === "decision") return <LinkedText style={[styles.reasoning, { color: item.allowed ? palette.success : palette.danger }]}>{item.label}</LinkedText>;
  if (item.kind === "subagent") return <LinkedText style={[styles.reasoning, { color: palette.muted }]}>{`${item.label ?? "Background agent"} · ${item.done ? "done" : "working"}`}</LinkedText>;
  // Running, it has no row: the conversation's `CompactingLine` says so (#644).
  if (item.kind === "compaction") { const status = compactionStatus(item); return status === null ? null : <Text style={[styles.reasoning, { color: palette.muted }]}>{status}</Text>; }
  if (item.kind === "retry") return <Text style={[styles.reasoning, { color: palette.warning }]}>Retrying · {item.attempt}/{item.maxRetries}</Text>;
  // The files are on the computer the agent ran on, not this phone: named, not drawn.
  if (item.kind === "media") return <Text style={[styles.reasoning, { color: palette.muted }]}>{`Made ${item.paths.map((path) => path.split(/[\\/]/).pop() || path).join(", ")}`}</Text>;
  return <LinkedText style={[styles.reasoning, { color: palette.muted }]}>{item.text}</LinkedText>;
}

function MessageTime({ ts, align = "left" }: { ts?: string; align?: "left" | "right" }) {
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  const time = messageTime(ts);
  if (!time) return null;
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`Message time: ${time.full}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }} style={[styles.time, { alignSelf: align === "right" ? "flex-end" : "flex-start" }]}>
      <Text style={[styles.timeText, { color: palette.faint }]}>{open ? time.full : time.short}</Text>
    </Pressable>
  </View>;
}

function safeJson(value: unknown) { try { return JSON.stringify(value, null, 2).slice(0, 2_000); } catch { return "Input unavailable"; } }

const styles = StyleSheet.create({
  row: { paddingTop: 8 },
  turnStart: { paddingTop: 22 },
  turn: { gap: 11 },
  reader: { alignSelf: "flex-end", maxWidth: "85%", alignItems: "flex-end", gap: 4 },
  promptBubble: { borderRadius: 22, borderBottomRightRadius: 6, paddingHorizontal: 16, paddingVertical: 11 },
  deliveryNote: { fontSize: 12, lineHeight: 17, textAlign: "right" },
  work: { gap: 8, paddingHorizontal: 2 },
  body: { fontSize: 16, lineHeight: 23 },
  reasoning: { fontSize: 13, lineHeight: 19 },
  thought: { borderLeftWidth: 2, paddingLeft: 10 },
  thoughtText: { fontSize: 13, lineHeight: 19 },
  compacting: { fontSize: 13, lineHeight: 19, paddingHorizontal: 3, paddingTop: 12 },
  tool: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 2 },
  toolText: { flex: 1, fontSize: 13 },
  toolBody: { flex: 1, gap: 2 },
  toolLine: { fontSize: 13 },
  time: { paddingTop: 2 },
  timeText: { fontSize: 11 },
  agentLabel: { fontWeight: "600" },
  permission: { padding: 15, gap: 7, marginTop: 10 },
  permissionLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  permissionActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  permissionAction: { minHeight: 40, flexGrow: 1 },
  permissionHint: { fontSize: 12, lineHeight: 17 },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  monoSmall: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
});
