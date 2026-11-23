import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { answerCloudBot, cloudBotQuestions, type BotsClient, type CloudBotQuestion } from "../cloud/bots";
import { screenMessage } from "../transport/connection-errors";
import { Asker, BotQuestionCard } from "./bots";
import { useTheme } from "./theme";

/** How often the questions are read again while the workspace is connected. */
const REFRESH_MS = 30_000;

/**
 * The questions the person's bots on this cloud workspace ask (PRO-482), over
 * the phone's own connection: answered here, an answer goes straight to the
 * bot there, with the Mac off. Nothing shows for a runtime without `bots/1`
 * or with no question open.
 */
export function CloudBotQuestions({ client, live }: { client: BotsClient; live: boolean }) {
  const { palette } = useTheme();
  const [questions, setQuestions] = useState<CloudBotQuestion[]>([]);
  const [answering, setAnswering] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<string[]>([]);

  const read = useCallback(async () => {
    try {
      setQuestions(await cloudBotQuestions(client));
    } catch {
      // Not shown: the workspace's own line says when it cannot be reached.
    }
  }, [client]);

  useEffect(() => {
    if (!live) return;
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, read]);

  const answer = async (question: CloudBotQuestion, reply: { answer: number } | { text: string }) => {
    const key = `${question.bot.id}:${question.item.number}`;
    setAnswering(key);
    setErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    try {
      const result = await answerCloudBot(client, question, reply);
      if (result.delivery && !result.delivery.sent) setNotes((current) => [...current, `Saved. ${question.bot.name} gets it when its chat next starts.`]);
      await read();
    } catch (cause) {
      setErrors((current) => ({ ...current, [key]: screenMessage(cause, "Couldn’t reach the workspace. Try again once it is connected.") }));
    } finally {
      setAnswering(null);
    }
  };

  if (!questions.length && !notes.length) return null;
  return <ScrollView testID="cloud-bot-questions" style={styles.list} contentContainerStyle={styles.content}>
    {questions.map((question) => {
      const key = `${question.bot.id}:${question.item.number}`;
      return <BotQuestionCard key={key} bot={question.bot} item={question.item} asker={<Asker bot={question.bot} />}
        busy={answering === key} disabled={!live || (answering !== null && answering !== key)} error={errors[key]}
        onAnswer={(index) => void answer(question, { answer: index })} onOpen={() => undefined} />;
    })}
    {notes.map((note, index) => <Text key={index} accessibilityLiveRegion="polite" style={[styles.note, { color: palette.muted }]}>{note}</Text>)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  list: { maxHeight: 320, flexGrow: 0 },
  content: { paddingHorizontal: 16, paddingVertical: 8, gap: 10 },
  note: { fontSize: 13 },
});
