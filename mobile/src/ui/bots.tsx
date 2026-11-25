import { useCallback, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BookOpen, Bot as BotGlyph, Bug, CircleQuestionMark, ClipboardList, Compass, Eye, PenTool, Rocket, ShieldCheck } from "lucide-react-native";
import { answerOrder, questionKey, type Bot, type BotItem } from "../data/bots";
import type { HostApi } from "../data/host-api";
import { screenMessage } from "../transport/connection-errors";
import { Button, Card } from "./primitives";
import { useTheme, type Palette } from "./theme";

/** Each role template's mark (23.08 draws a compass for the CTO, a pen for the designer); a role it does not know, a bot. */
const MARKS: Record<string, typeof Compass> = {
  cto: Compass,
  "ux-designer": PenTool,
  "security-auditor": ShieldCheck,
  watcher: Eye,
  "qa-engineer": Bug,
  "release-manager": Rocket,
  "docs-writer": BookOpen,
  "chief-of-staff": ClipboardList,
};

/** The colour a bot's mark is drawn in: the same for a role everywhere it shows. */
function markColor(roleTemplateId: string, palette: Palette): string {
  switch (roleTemplateId) {
    case "ux-designer": return "#a78bfa";
    case "security-auditor": case "qa-engineer": return palette.success;
    case "watcher": case "docs-writer": return palette.info;
    default: return palette.warning;
  }
}

/** A bot's mark on a tinted square, with a dot when it is working or paused. */
export function BotAvatar({ bot, size = 40, dot }: { bot: Pick<Bot, "roleTemplateId" | "name">; size?: number; dot?: "working" | "paused" | null }) {
  const { palette } = useTheme();
  const Mark = MARKS[bot.roleTemplateId] ?? BotGlyph;
  const color = markColor(bot.roleTemplateId, palette);
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.avatar, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: `${color}26` }]}>
    <Mark size={size * 0.5} color={color} strokeWidth={1.8} />
    {dot ? <View style={[styles.dot, { borderColor: palette.card, backgroundColor: dot === "working" ? palette.accent : palette.muted }]} /> : null}
  </View>;
}

/** "NEEDS YOU · 3", in the warning colour with a question mark, as the board heads the section. */
export function NeedsYouHeading({ count }: { count: number }) {
  const { palette } = useTheme();
  return <View accessibilityRole="header" accessibilityLabel={`Needs you, ${count}`} style={styles.heading}>
    <CircleQuestionMark size={14} color={palette.warning} strokeWidth={2} />
    <Text style={[styles.headingText, { color: palette.warning }]}>{`NEEDS YOU · ${count}`}</Text>
  </View>;
}

/** A section's name, quiet and in small capitals ("IN PROGRESS · 3", "TEAM · 4 BOTS"). */
export function BotSection({ children }: { children: string }) {
  const { palette } = useTheme();
  return <Text accessibilityRole="header" style={[styles.section, { color: palette.muted }]}>{children.toUpperCase()}</Text>;
}

/** How an answer from the phone went, in words: null once the bot has it. */
export type AnswerOutcome = { ok: true; note: string | null } | { ok: false; message: string };

/**
 * Answering a bot's question from the phone (PRO-479): through `bots.answer`,
 * the Mac's record of the owner's answer, as the window answers it. One at a
 * time; `answering` names the item under way.
 */
export function useBotAnswer(api: HostApi, onAnswered?: () => void) {
  const [answering, setAnswering] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const answer = useCallback(async (bot: Pick<Bot, "id" | "name">, item: BotItem, reply: { answer: number } | { text: string }): Promise<AnswerOutcome> => {
    const question = item.question;
    const key = `${bot.id}:${item.number}`;
    if (!question) return { ok: false, message: `${bot.name} no longer asks this.` };
    setAnswering(key);
    setErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    try {
      const result = await api.answerBot(bot.id, item.number, reply, questionKey(question));
      onAnswered?.();
      // Recorded either way; one that did not reach the chat yet goes when it next starts.
      const note = result.delivery && !result.delivery.sent ? `Saved. ${bot.name} gets it when its chat next starts.` : null;
      return { ok: true, note };
    } catch (cause) {
      const message = screenMessage(cause, "Couldn’t reach the computer. Try again once it is connected.");
      setErrors((current) => ({ ...current, [key]: message }));
      return { ok: false, message };
    } finally {
      setAnswering(null);
    }
  }, [api, onAnswered]);
  return { answering, errors, answer };
}

/**
 * A bot's question on one of its items, as 23.08 draws it on a bot's Home:
 * the question, the item's summary under it, the recommended answer first
 * and wide, the rest side by side. `compact` is the Bots tab's newest
 * question: the recommended answer, and Open for the rest.
 */
export function BotQuestionCard({ bot, item, asker, busy, disabled, error, compact, time, onAnswer, onOpen }: {
  bot: Pick<Bot, "id" | "name">;
  item: BotItem;
  /** "Atlas asks", over the question on the Bots tab. */
  asker?: ReactNode;
  busy: boolean;
  disabled: boolean;
  error?: string;
  compact?: boolean;
  time?: string;
  onAnswer(index: number): void;
  onOpen(): void;
}) {
  const { palette } = useTheme();
  const question = item.question;
  if (!question) return null;
  const answers = answerOrder(question);
  const first = answers[0];
  const rest = answers.slice(1);
  const recommended = first?.recommended ? first : null;
  return <Card testID="bot-question-card" style={[styles.card, { borderColor: `${palette.warning}66` }]}>
    {asker ? <View style={styles.askerRow}>{asker}{time ? <Text style={[styles.time, { color: palette.muted }]}>{time}</Text> : null}</View> : null}
    <Pressable accessibilityRole="button" accessibilityHint="Opens the question with every answer and room to reply" onPress={onOpen}>
      <Text style={[styles.question, { color: palette.ink }]}>{question.text}</Text>
      {!compact && item.summary ? <Text style={[styles.summary, { color: palette.muted }]}>{item.summary}</Text> : null}
    </Pressable>
    {compact ? <View style={styles.row}>
      {recommended ? <Button label={recommended.label} disabled={disabled || busy} accessibilityHint={`Answers ${bot.name} with its recommended answer`} accessibilityState={{ busy }} onPress={() => onAnswer(recommended.index)} style={styles.grow} /> : null}
      <Button label="Open" kind="secondary" onPress={onOpen} style={recommended ? undefined : styles.grow} />
    </View> : <>
      {first ? <Button label={first.recommended ? `${first.label} · recommended` : first.label} kind={first.recommended ? "primary" : "secondary"} disabled={disabled || busy} accessibilityState={{ busy }} onPress={() => onAnswer(first.index)} /> : null}
      {rest.length ? <View style={styles.row}>{rest.map((answer) => <Button key={answer.index} label={answer.label} kind="secondary" disabled={disabled || busy} onPress={() => onAnswer(answer.index)} style={styles.grow} />)}</View> : null}
    </>}
    {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
  </Card>;
}

/** "Atlas asks", with its mark, over a question. */
export function Asker({ bot }: { bot: Pick<Bot, "roleTemplateId" | "name"> }) {
  const { palette } = useTheme();
  return <View style={styles.asker}>
    <BotAvatar bot={bot} size={22} />
    <Text numberOfLines={1} style={[styles.askerText, { color: palette.muted }]}>{`${bot.name} asks`}</Text>
  </View>;
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center" },
  dot: { position: "absolute", right: -2, bottom: -2, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  heading: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 4, marginTop: 8 },
  headingText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.8 },
  section: { fontSize: 12, fontWeight: "600", letterSpacing: 0.8, marginLeft: 4, marginTop: 8 },
  card: { padding: 14, gap: 10 },
  askerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  asker: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  askerText: { flexShrink: 1, fontSize: 13 },
  time: { fontSize: 13, fontVariant: ["tabular-nums"] },
  question: { fontSize: 16, fontWeight: "600", lineHeight: 22 },
  summary: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  row: { flexDirection: "row", gap: 8 },
  grow: { flex: 1 },
  error: { fontSize: 13, lineHeight: 18 },
});
