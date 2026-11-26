import { useState } from "react";
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUp } from "lucide-react-native";
import { answerOrder, type Bot, type BotItem } from "../data/bots";
import { useApp } from "../state/AppProvider";
import { useBotHome } from "../state/bots";
import { connectionUsable, useConnectionState } from "../state/connection-view";
import { Asker, useBotAnswer, type AnswerOutcome } from "./bots";
import { Button } from "./primitives";
import { useTheme } from "./theme";
import { keyboardAvoidingBehavior } from "@mobile/ui/keyboard";

/**
 * A bot's question as a sheet (23.08, "A question from a push"): over the
 * chat it came from, the bot's words, its answers with the recommended one on
 * top, and room to type a reply. Answered, it closes; refused, it says why and
 * stays. `item` null: the question is no longer asked (answered elsewhere).
 */
export function BotQuestionSheet({ bot, item, connected, busy, error, onAnswer, onClose }: {
  bot: Pick<Bot, "id" | "name" | "roleTemplateId">;
  item: BotItem | null;
  connected: boolean;
  busy: boolean;
  error?: string;
  onAnswer(reply: { answer: number } | { text: string }): Promise<AnswerOutcome>;
  onClose(): void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const question = item?.question;
  const send = async (reply: { answer: number } | { text: string }) => {
    const outcome = await onAnswer(reply);
    if (!outcome.ok) return;
    if (outcome.note) { setNote(outcome.note); return; }
    onClose();
  };
  const blocked = !connected || busy;
  const reply = typed.trim();
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.fill} behavior={keyboardAvoidingBehavior()}>
      {/* The chat it came from stays in sight behind, dimmed: a tap there closes the sheet. */}
      <Pressable testID="bot-question-backdrop" accessibilityRole="button" accessibilityLabel="Close the question" onPress={onClose} style={[styles.fill, styles.backdrop]} />
      <View testID="bot-question-sheet" accessibilityViewIsModal style={[styles.sheet, { backgroundColor: palette.card, borderColor: palette.border, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.handle, { backgroundColor: palette.faint }]} />
        <Asker bot={bot} />
        {question ? <>
          <Text accessibilityRole="header" style={[styles.question, { color: palette.ink }]}>{question.text}</Text>
          {item?.summary ? <Text style={[styles.summary, { color: palette.muted }]}>{item.summary}</Text> : <Text style={[styles.summary, { color: palette.muted }]}>{`#${item?.number} · ${item?.title}`}</Text>}
          {note ? <Text accessibilityLiveRegion="polite" style={[styles.note, { color: palette.muted }]}>{note}</Text> : <>
            <View style={styles.answers}>
              {answerOrder(question).map((answer) => <Button key={answer.index} testID={`bot-answer-${answer.index}`} label={answer.recommended ? `${answer.label} · recommended` : answer.label} kind={answer.recommended ? "primary" : "secondary"} disabled={blocked} accessibilityState={{ disabled: blocked, busy }} onPress={() => void send({ answer: answer.index })} />)}
            </View>
            <View style={[styles.reply, { backgroundColor: palette.raised, borderColor: palette.border }]}>
              <TextInput value={typed} onChangeText={setTyped} placeholder="Or type a reply" placeholderTextColor={palette.faint} accessibilityLabel={`Your own reply to ${bot.name}`} multiline editable={!busy} style={[styles.input, { color: palette.ink }]} />
              <Pressable accessibilityRole="button" accessibilityLabel="Send reply" accessibilityState={{ disabled: blocked || !reply }} disabled={blocked || !reply} onPress={() => void send({ text: reply })} style={[styles.send, { backgroundColor: reply && !blocked ? palette.accent : palette.selected }]}>
                <ArrowUp size={18} color={reply && !blocked ? palette.accentInk : palette.faint} strokeWidth={2.2} />
              </Pressable>
            </View>
          </>}
          {!connected ? <Text style={[styles.hint, { color: palette.warning }]}>Reconnect before answering.</Text> : null}
          {error ? <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: palette.danger }]}>{error}</Text> : null}
          {note ? <Button label="Done" kind="secondary" onPress={onClose} /> : null}
        </> : <>
          <Text style={[styles.question, { color: palette.ink }]}>{`${bot.name} no longer asks this.`}</Text>
          <Text style={[styles.summary, { color: palette.muted }]}>It was answered, or the bot moved on.</Text>
          <Button label="Close" kind="secondary" onPress={onClose} />
        </>}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { backgroundColor: "#00000080" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18, paddingTop: 10, gap: 12 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, marginBottom: 4, opacity: 0.6 },
  question: { fontSize: 18, fontWeight: "700", lineHeight: 24 },
  summary: { fontSize: 14, lineHeight: 20 },
  answers: { gap: 8, marginTop: 2 },
  reply: { flexDirection: "row", alignItems: "flex-end", gap: 8, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 14, paddingRight: 6, paddingVertical: 6 },
  input: { flex: 1, fontSize: 16, maxHeight: 120, paddingVertical: 6 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  note: { fontSize: 15, lineHeight: 21 },
  hint: { fontSize: 13, lineHeight: 18 },
});

/**
 * A bot's question over the chat it came from, opened from a notification or
 * a link with the bot and item (PRO-479): read from the bot's home, answered
 * as the Bots tab answers it.
 */
export function BotQuestionOver({ botId, number, onClose }: { botId: string; number: number; onClose(): void }) {
  const app = useApp();
  const home = useBotHome(app.api, app.activeHost?.id, botId, app.connectionEpoch, app.sessions);
  const connected = connectionUsable(useConnectionState(app));
  const answers = useBotAnswer(app.api, () => void home.refresh());
  const bot = home.value?.bot;
  // Until the home is read there is nothing to show; a Mac without bots shows nothing at all.
  if (!bot || home.offered !== true) return null;
  const item = home.value?.items.items.find((each) => each.number === number && each.state === "needsYou" && each.question) ?? null;
  const key = `${bot.id}:${number}`;
  return <BotQuestionSheet bot={bot} item={item} connected={connected} busy={answers.answering === key} error={answers.errors[key]}
    onAnswer={(reply) => item ? answers.answer(bot, item, reply) : Promise.resolve({ ok: false, message: `${bot.name} no longer asks this.` })} onClose={onClose} />;
}
