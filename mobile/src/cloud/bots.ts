/**
 * The bots that live on a cloud workspace (PRO-482), as this phone reads them
 * over its own workspace connection (`bots/1`): no Mac is needed, so a bot's
 * question reaches the phone, and its answer reaches the bot, while the Mac
 * is off. The runtime lists only the bots of the person connected.
 */
import { questionKey, readAnswer, readOverview, type Bot, type BotAnswerResult, type BotItem } from "../data/bots";

export const BOTS_CAPABILITY = "bots/1";

/** The calls this needs of a workspace client. */
export interface BotsClient {
  hasCapability(capability: string): boolean;
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** A bot's open question, with the bot that asks it. */
export interface CloudBotQuestion {
  bot: Bot;
  item: BotItem;
  at: string;
}

/** The questions the workspace's bots ask the person connected, newest first; none from a runtime without `bots/1`. */
export async function cloudBotQuestions(client: BotsClient): Promise<CloudBotQuestion[]> {
  if (!client.hasCapability(BOTS_CAPABILITY)) return [];
  const overview = readOverview(await client.call("bots.list"));
  if (!overview) return [];
  const bots = new Map(overview.bots.bots.map((bot) => [bot.id, bot]));
  const questions: CloudBotQuestion[] = [];
  for (const entry of overview.needsYou.entries) {
    if (entry.kind !== "item" || !entry.item.question) continue;
    const bot = bots.get(entry.botId);
    if (bot) questions.push({ bot, item: entry.item, at: entry.at });
  }
  return questions.sort((a, b) => b.at.localeCompare(a.at));
}

/** Answer one, as the Mac's window would: by an answer's index or in words, naming the question as it was shown. */
export async function answerCloudBot(client: BotsClient, question: CloudBotQuestion, reply: { answer: number } | { text: string }): Promise<BotAnswerResult> {
  const asked = question.item.question;
  if (!asked) throw new Error(`${question.bot.name} no longer asks this.`);
  const answered = readAnswer(await client.call("bots.answer", { id: question.bot.id, number: question.item.number, ...reply, question: questionKey(asked) }));
  if (!answered) throw new Error("The workspace did not say how the answer went.");
  return answered;
}
