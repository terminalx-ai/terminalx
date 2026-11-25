import { createContext, memo, useContext, useEffect, useRef, useState, type ComponentRef } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Check, CheckCheck } from "lucide-react-native";
import { askAgentNote, COMPACTING_LINE, compactionStatus, messageTime, questionAnswers, questionsLabel, toggleQuestionChoice } from "@terminalx/portable/transcript";
import type { PendingAsk, QuestionChoices, Turn, WorkItem } from "@terminalx/portable/transcript";
import { useConversationState } from "../state/conversation-state";
import { useTranscriptReveal } from "./TranscriptList";
import { Button, Card } from "./primitives";
import { useTheme } from "./theme";
import { Markdown, MarkdownBlock } from "./Markdown";
import { LinkedText, linkedText } from "./LinkedText";
import { deliveryNote, messageDelivery, turnRows, type MessageDelivery, type TurnRow } from "./transcript-rows";
import { WorkGroup } from "./WorkGroup";
import { ShellBlock } from "./ShellBlock";
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
    {options.length ? <View style={styles.permissionActions}>{options.map((option) => <Button key={option.id} label={option.label} kind={option.kind === "deny" ? "danger" : option.kind === "allow_once" ? "primary" : "secondary"} disabled={!connected || answering} onPress={() => onRespond(option.id)} style={styles.permissionAction} />)}</View> : <Text style={[styles.body, { color: palette.muted }]}>Answer this request from your computer.</Text>}
    {!connected ? <Text style={[styles.permissionHint, { color: palette.warning }]}>Reconnect before answering.</Text> : null}
    {error ? <LinkedText style={[styles.permissionHint, { color: palette.danger }]}>{`${error} The request may have lapsed; check your computer.`}</LinkedText> : null}
  </Card>;
}

/** What a reader has chosen and typed on a question card, before answering. */
interface QuestionDraft { chosen: QuestionChoices; typed: Readonly<Record<number, string>> }
const NO_ANSWERS: QuestionDraft = { chosen: {}, typed: {} };

/**
 * A refusal as a sentence for the card: the Mac's own words ("that question
 * is no longer open") without the code the runtime puts in front of them.
 */
export function refusalSentence(message: string): string {
  const said = message.replace(/^[a-z][a-z_-]*:\s+/, "").trim();
  if (!said) return "The answer was not sent.";
  const sentence = said[0].toUpperCase() + said.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * An agent's question (`AskUserQuestion`) as a form, as the desktop's
 * `QuestionCard` draws it (#979): radio rows where one may be chosen, checkbox
 * rows where several may, a field for a typed answer, then Answer and Skip.
 * What Answer sends is `questionAnswers`, the desktop's own format; Skip
 * sends `{}`.
 *
 * - `stateKey` names the conversation. What is chosen and typed is kept under
 *   it per ask, as the composer's draft is, so it is still there after another
 *   tab was opened or the app went to the background.
 * - `readOnly` says why this reader may not answer at all (a viewer, or a Mac
 *   too old to take an answer): the question and its options are shown, with
 *   that reason and nothing to press.
 * - Not `connected`, the options can still be chosen, and Answer and Skip wait
 *   for the connection.
 */
export function QuestionCard({ ask, stateKey, connected, answering, readOnly = null, error, onAnswer }: { ask: PendingAsk; stateKey: string; connected: boolean; answering: boolean; readOnly?: string | null; error?: string; onAnswer(answers: Record<string, string>): void }) {
  const { palette } = useTheme();
  const [draft, setDraft] = useConversationState<QuestionDraft>(`${stateKey}:question:${ask.requestId}`, NO_ANSWERS);
  const questions = ask.questions ?? [];
  const blocked = !connected || answering;
  return <Card testID="question-card" style={[styles.permission, { borderColor: `${palette.info}66` }]}>
    <Text style={[styles.permissionLabel, { color: palette.info }]}>{questionsLabel(questions.length)}</Text>
    {questions.map((question, qi) => {
      const picked = draft.chosen[qi] ?? [];
      return <View key={qi} style={styles.question}>
        <Text style={[styles.cardTitle, { color: palette.ink }]}>{linkedText(question.question)}</Text>
        {question.multiSelect && question.options.length ? <Text style={[styles.permissionHint, { color: palette.faint }]}>Choose any that apply</Text> : null}
        {question.options.map((option, oi) => {
          const on = picked.includes(oi);
          // The row is the choice. A link in its text takes its own tap, so opening one chooses nothing.
          return <Pressable key={oi} testID={`question-${qi}-option-${oi}`} accessibilityRole={question.multiSelect ? "checkbox" : "radio"} accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label} accessibilityState={{ checked: on, disabled: !!readOnly }} disabled={!!readOnly}
            onPress={() => setDraft((current) => ({ ...current, chosen: toggleQuestionChoice(current.chosen, qi, oi, question.multiSelect) }))}
            style={[styles.choice, { borderColor: on ? palette.accent : palette.border, backgroundColor: on ? `${palette.accent}1c` : "transparent" }]}>
            <View style={[styles.choiceMark, question.multiSelect ? styles.choiceBox : styles.choiceRound, { borderColor: on ? palette.accent : palette.muted, backgroundColor: on ? palette.accent : "transparent" }]}>
              {on ? question.multiSelect ? <Check size={13} color={palette.accentInk} strokeWidth={3} /> : <View style={[styles.choiceDot, { backgroundColor: palette.accentInk }]} /> : null}
            </View>
            <View style={styles.choiceText}>
              <Text style={[styles.choiceLabel, { color: palette.ink }]}>{linkedText(option.label)}</Text>
              {option.description ? <Text style={[styles.choiceDescription, { color: palette.muted }]}>{linkedText(option.description)}</Text> : null}
            </View>
          </Pressable>;
        })}
        {/* A question with nothing to choose from can only be answered in words. */}
        {!readOnly && (question.freeText || !question.options.length) ? <AnswerField question={question.question} only={!question.options.length} value={draft.typed[qi] ?? ""} editable={!answering}
          onChangeText={(text) => setDraft((current) => ({ ...current, typed: { ...current.typed, [qi]: text } }))} /> : null}
      </View>;
    })}
    {readOnly ? <Text testID="question-read-only" style={[styles.body, { color: palette.muted }]}>{readOnly}</Text> : <View style={styles.permissionActions}>
      <Button label="Skip" kind="secondary" disabled={blocked} accessibilityHint="Lets the agent go on without an answer." onPress={() => onAnswer({})} style={styles.questionAction} />
      <Button label="Answer" disabled={blocked} accessibilityState={{ disabled: blocked, busy: answering }} onPress={() => onAnswer(questionAnswers(questions, draft.chosen, draft.typed))} style={styles.questionAction} />
    </View>}
    {!readOnly && !connected ? <Text style={[styles.permissionHint, { color: palette.warning }]}>Reconnect before answering.</Text> : null}
    {error ? <Text testID="question-error" accessibilityLiveRegion="polite" style={[styles.permissionHint, { color: palette.danger }]}>{linkedText(refusalSentence(error))}</Text> : null}
  </Card>;
}

/**
 * The typed answer. Focused, it asks the transcript to bring it into view
 * once the keyboard has taken its room: the keyboard shortens the list from
 * its latest edge, which can push a field higher in a tall card off the top.
 */
function AnswerField({ question, only, value, editable, onChangeText }: { question: string; only: boolean; value: string; editable: boolean; onChangeText(text: string): void }) {
  const { palette } = useTheme();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const reveal = useTranscriptReveal();
  const waiting = useRef<{ remove(): void } | null>(null);
  useEffect(() => () => waiting.current?.remove(), []);
  const bringIntoView = () => {
    waiting.current?.remove();
    waiting.current = null;
    const show = () => requestAnimationFrame(() => { if (input.current) reveal(input.current); });
    if (Keyboard.isVisible()) return void show();
    const shown = Keyboard.addListener("keyboardDidShow", () => { shown.remove(); waiting.current = null; show(); });
    waiting.current = shown;
  };
  return <TextInput ref={input} accessibilityLabel={`Your own answer to: ${question}`} value={value} onChangeText={onChangeText} onFocus={bringIntoView} editable={editable}
    placeholder={only ? "Type your answer" : "Or type your own answer"} placeholderTextColor={palette.faint} returnKeyType="done" autoCapitalize="sentences"
    style={[styles.answerField, { color: palette.ink, borderColor: palette.border, backgroundColor: palette.raised }]} />;
}

/** A compaction is running (`Transcript.compacting`): said at the newest edge of the conversation, as the desktop's chat does. */
export function CompactingLine() {
  const { palette } = useTheme();
  return <Text accessibilityLiveRegion="polite" style={[styles.compacting, { color: palette.muted }]}>{COMPACTING_LINE}</Text>;
}

/**
 * The reader's own words: a turn's prompt, a message the agent took while the
 * turn ran, or one still queued for it. Under it, its time and where it is
 * (design 22.03): a small tick once the Mac has it, "Queued" while it waits.
 */
function ReaderBubble({ text, ts, note, images, delivery }: { text: string; ts?: string; note?: string; images?: { url: string; name?: string }[]; delivery?: MessageDelivery }) {
  const { palette } = useTheme();
  return <View style={styles.reader}>
    {images?.length ? <PromptImages images={images} /> : null}
    {text.trim() || !images?.length ? <View style={[styles.promptBubble, { backgroundColor: palette.selected }]}><LinkedText style={[styles.body, { color: palette.ink }]}>{text}</LinkedText></View> : null}
    {note ? <Text style={[styles.deliveryNote, { color: palette.warning }]}>{note}</Text> : null}
    <View style={styles.readerFoot}>
      <MessageTime ts={ts} align="right" />
      {delivery ? <DeliveryMark delivery={delivery} /> : null}
    </View>
  </View>;
}

/** What took the reader's message: the paired Mac, or a cloud workspace, which has no Mac (PRO-570). */
export type MessagePlace = "mac" | "workspace";
const DELIVERED: Record<MessagePlace, string> = { mac: "Delivered to your computer", workspace: "Delivered to the workspace" };
const DeliveredTo = createContext<MessagePlace>("mac");

/** Where the reader's message is, in a word or a tick, beside its time. */
function DeliveryMark({ delivery }: { delivery: MessageDelivery }) {
  const { palette } = useTheme();
  const place = useContext(DeliveredTo);
  if (delivery === "queued") return <Text testID="message-queued" accessibilityLiveRegion="polite" style={[styles.deliveryMark, { color: palette.muted }]}>Queued</Text>;
  return <View testID="message-delivered" accessible accessibilityLabel={DELIVERED[place]} style={styles.tick}><CheckCheck size={14} color={palette.muted} /></View>;
}

/**
 * A whole turn, drawn row by row as the transcript list draws it: a cloud workspace's tab draws its turns this way.
 * `deliveredTo` is what a delivered message's tick says aloud took it.
 */
export function TurnCard({ turn, deliveredTo = "mac" }: { turn: Turn; deliveredTo?: MessagePlace }) {
  return <DeliveredTo.Provider value={deliveredTo}><View>{turnRows(turn).map((row) => <TranscriptRow key={row.key} row={row} />)}</View></DeliveredTo.Provider>;
}

export const TranscriptRow = memo(function TranscriptRow({ row }: { row: TurnRow }) {
  return <View style={row.startsTurn ? styles.turnStart : styles.row}>
    {row.kind === "prompt" ? <ReaderBubble text={row.text} ts={row.ts} note={row.note} images={row.images} delivery={row.delivery} />
      : <View style={styles.work}>{row.kind === "markdown" ? <View><MarkdownBlock token={row.token} /><MessageTime ts={row.ts} /></View> : row.kind === "calls" ? <WorkGroup calls={row.calls} /> : <WorkRow item={row.item} />}</View>}
  </View>;
});

function WorkRow({ item }: { item: WorkItem }) {
  const { palette } = useTheme();
  if (item.kind === "text") return <View><Markdown text={item.text} /><MessageTime ts={item.messageTs} /></View>;
  if (item.kind === "reasoning") return <View style={[styles.thought, { borderLeftColor: palette.border }]}><LinkedText style={[styles.thoughtText, { color: palette.muted }]}>{item.text}</LinkedText></View>;
  // `turnRows` folds calls into runs before they get here; a call drawn on its own is a run of one.
  if (item.kind === "tool") return <WorkGroup calls={[item.call]} />;
  if (item.kind === "tool_group") return <WorkGroup calls={item.calls} />;
  if (item.kind === "error") return <LinkedText style={[styles.body, { color: palette.danger }]}>{item.text}</LinkedText>;
  // `turnRows` draws these as the reader's rows; here for a work item drawn on its own.
  if (item.kind === "queued") return <ReaderBubble text={item.text} ts={item.messageTs} note={deliveryNote(item)} images={item.images} delivery={messageDelivery(item, true)} />;
  if (item.kind === "message") return <ReaderBubble text={item.text} ts={item.messageTs} note={deliveryNote(item)} images={item.images} delivery={messageDelivery(item, false)} />;
  if (item.kind === "shell") return <ShellBlock item={item} />;
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
  reader: { alignSelf: "flex-end", maxWidth: "85%", alignItems: "flex-end", gap: 4 },
  promptBubble: { borderRadius: 22, borderBottomRightRadius: 6, paddingHorizontal: 16, paddingVertical: 11 },
  deliveryNote: { fontSize: 13, lineHeight: 18, textAlign: "right" },
  readerFoot: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5 },
  deliveryMark: { fontSize: 13, lineHeight: 17, paddingTop: 2 },
  tick: { paddingTop: 2 },
  work: { gap: 8, paddingHorizontal: 2 },
  body: { fontSize: 16, lineHeight: 23 },
  reasoning: { fontSize: 13, lineHeight: 19 },
  thought: { borderLeftWidth: 2, paddingLeft: 10 },
  thoughtText: { fontSize: 13, lineHeight: 19 },
  compacting: { fontSize: 13, lineHeight: 19, paddingHorizontal: 3, paddingTop: 12 },
  time: { paddingTop: 2 },
  timeText: { fontSize: 11 },
  agentLabel: { fontWeight: "600" },
  permission: { padding: 15, gap: 7, marginTop: 10 },
  permissionLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  permissionActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  permissionAction: { minHeight: 40, flexGrow: 1 },
  permissionHint: { fontSize: 12, lineHeight: 17 },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  question: { gap: 8, marginTop: 4 },
  // A row is the whole touch target: 44 pt at least, taller with a description.
  choice: { minHeight: 44, flexDirection: "row", alignItems: "flex-start", gap: 11, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11 },
  choiceMark: { width: 20, height: 20, borderWidth: 1.5, alignItems: "center", justifyContent: "center", marginTop: 1 },
  choiceRound: { borderRadius: 10 },
  choiceBox: { borderRadius: 5 },
  choiceDot: { width: 8, height: 8, borderRadius: 4 },
  choiceText: { flex: 1, gap: 2 },
  choiceLabel: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  choiceDescription: { fontSize: 13, lineHeight: 18 },
  answerField: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  questionAction: { minHeight: 44, flexGrow: 1 },
  monoSmall: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 11, lineHeight: 16 },
});
