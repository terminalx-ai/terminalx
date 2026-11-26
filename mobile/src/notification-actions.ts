import * as Notifications from "expo-notifications";
import { answerOrder } from "./data/bots";
import { BOT_QUESTION, type NotificationPresentation } from "./notifications/filter";

/**
 * Answering from the notification (#990, design 22.07 frame 6): a question's
 * options, or Allow / Deny for an approval, as the notification's buttons.
 * A button opens TerminalX (after Face ID or the passcode, from the lock
 * screen), answers on the Mac through the same paths as the session's cards
 * (#979), and shows the session.
 */

/** How many of a question's options become buttons; with more, the notification only opens the app. */
export const MAX_QUESTION_ACTIONS = 4;
/** The option ids `permission.respond` takes for the approval buttons (the Mac offers `approval` only for these). */
export const APPROVAL_OPTIONS = { allow: "allow", deny: "deny" } as const;

const ALLOW = "approval.allow";
const DENY = "approval.deny";
const OPTION = "question.option.";
/** A bot's answer by its index on the Mac (PRO-479). */
const BOT_ANSWER = "bot.answer.";
const APPROVAL_CATEGORY = "terminalx.approval";

export interface NotificationCategory {
  identifier: string;
  actions: Notifications.NotificationAction[];
}

const action = (identifier: string, buttonTitle: string, destructive = false): Notifications.NotificationAction => ({
  identifier,
  buttonTitle,
  options: { opensAppToForeground: true, isAuthenticationRequired: true, ...(destructive ? { isDestructive: true } : {}) },
});

/**
 * The buttons a notification gets, or null for none. None unless the lock
 * screen shows everything: with "Session name only" or "Nothing" the
 * question and request are not shown, so they are not answered there either.
 */
export function categoryFor(shown: NotificationPresentation): NotificationCategory | null {
  const { data, subtitle } = shown;
  // `subtitle` is set only at the "Show: Everything" level; `detailsHidden` at "Nothing".
  if (!subtitle || data.detailsHidden) return null;
  // A bot's question: its answers, the recommended one first, each answering by its index on the Mac (PRO-479).
  if (data.kind === BOT_QUESTION) {
    const answers = data.answers ?? [];
    if (!data.botId || !data.question || !answers.length || answers.length > MAX_QUESTION_ACTIONS) return null;
    const ordered = answerOrder({ answers, recommended: data.recommended });
    return { identifier: `terminalx.bot.${categoryKey(ordered.map((answer) => `${answer.index}:${answer.label}`))}`, actions: ordered.map((answer) => action(`${BOT_ANSWER}${answer.index}`, answer.label)) };
  }
  if (!data.requestId) return null;
  if (data.kind === "approval") return { identifier: APPROVAL_CATEGORY, actions: [action(ALLOW, "Allow"), action(DENY, "Deny", true)] };
  if (data.kind === "question") {
    const options = data.options ?? [];
    if (!options.length || options.length > MAX_QUESTION_ACTIONS) return null;
    // iOS keeps a category by id: one per set of labels, so another question's buttons never show.
    return { identifier: `terminalx.question.${categoryKey(options.map((option) => option.label))}`, actions: options.map((option, index) => action(`${OPTION}${index}`, option.label)) };
  }
  return null;
}

const registered = new Set<string>();

/** Registers the notification's buttons with iOS (once per set) and gives the id to schedule it with. */
export async function prepareCategory(shown: NotificationPresentation): Promise<string | null> {
  const category = categoryFor(shown);
  if (!category) return null;
  if (!registered.has(category.identifier)) {
    try {
      await Notifications.setNotificationCategoryAsync(category.identifier, category.actions);
      registered.add(category.identifier);
    } catch {
      // Not registered: the notification still shows, and a tap opens the session.
      return null;
    }
  }
  return category.identifier;
}

/** What a tap on a notification asks for. */
export type NotificationIntent =
  | { type: "open"; hostId: string | null; sessionId: string; tabId: string }
  | { type: "permission"; hostId: string; sessionId: string; tabId: string; requestId: string; optionId: string }
  | { type: "question"; hostId: string; sessionId: string; tabId: string; requestId: string; answers: Record<string, string> }
  /** A bot's question: open it as a sheet over its home chat, or on the bot's page when that chat is not known. */
  | { type: "botQuestion"; hostId: string | null; botId: string; number: number; sessionId: string | null; tabId: string | null }
  /** A bot's answer button: the owner's answer, through `bots.answer` as the app answers it. */
  | { type: "botAnswer"; hostId: string; botId: string; number: number; question: string; answer: number; sessionId: string | null; tabId: string | null };

/**
 * A notification response as an intent: a button answers, anything else
 * opens the session. `body` is the question exactly (the Mac sends
 * `question` only then), the key `questions.respond` takes the answer by.
 */
export function intentOf(actionIdentifier: string, data: Record<string, unknown> | undefined, body: string | null): NotificationIntent | null {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  const tabId = typeof data?.tabId === "string" ? data.tabId : "";
  if (data?.kind === BOT_QUESTION && typeof data.botId === "string" && data.botId && Number.isSafeInteger(data.number)) {
    const hostId = typeof data.hostId === "string" && data.hostId ? data.hostId : null;
    const where = { botId: data.botId, number: data.number as number, sessionId: sessionId && tabId ? sessionId : null, tabId: sessionId && tabId ? tabId : null };
    const open: NotificationIntent = { type: "botQuestion", hostId, ...where };
    if (!hostId || !actionIdentifier.startsWith(BOT_ANSWER) || typeof data.question !== "string") return open;
    const index = Number(actionIdentifier.slice(BOT_ANSWER.length));
    const answers = Array.isArray(data.answers) ? data.answers : [];
    if (!Number.isInteger(index) || index < 0 || index >= answers.length) return open;
    return { type: "botAnswer", hostId, question: data.question, answer: index, ...where };
  }
  if (!sessionId || !tabId) return null;
  const hostId = typeof data?.hostId === "string" && data.hostId ? data.hostId : null;
  const requestId = typeof data?.requestId === "string" ? data.requestId : "";
  const open: NotificationIntent = { type: "open", hostId, sessionId, tabId };
  if (!hostId || !requestId) return open;
  if (actionIdentifier === ALLOW || actionIdentifier === DENY) {
    if (data?.kind !== "approval") return open;
    return { type: "permission", hostId, sessionId, tabId, requestId, optionId: actionIdentifier === ALLOW ? APPROVAL_OPTIONS.allow : APPROVAL_OPTIONS.deny };
  }
  if (actionIdentifier.startsWith(OPTION) && data?.kind === "question" && body) {
    const index = Number(actionIdentifier.slice(OPTION.length));
    const options = Array.isArray(data.options) ? data.options as unknown[] : [];
    const label = (options[index] as { label?: unknown } | undefined)?.label;
    if (Number.isInteger(index) && typeof label === "string") return { type: "question", hostId, sessionId, tabId, requestId, answers: { [body]: label } };
  }
  return open;
}

/** What answering needs from the app: the Mac to answer on, connected. */
export interface AnswerTarget {
  /** Connects to `hostId` when it is not the active Mac; resolves whether it is now reachable. */
  reach(hostId: string): Promise<boolean>;
  respondPermission(sessionId: string, tabId: string, requestId: string, optionId: string): Promise<{ answered: true } | { answered: false; message: string }>;
  answerQuestions(sessionId: string, tabId: string, requestId: string, answers: Record<string, string>): Promise<{ answered: true } | { answered: false; message: string }>;
  /** A bot's question, answered as the app answers it (`bots.answer`); throws the Mac's refusal. */
  answerBot(botId: string, number: number, reply: { answer: number }, question: string): Promise<unknown>;
}

/** Answers on the Mac. Resolves the Mac's refusal in words, or null once answered. */
export async function answer(intent: Extract<NotificationIntent, { type: "permission" | "question" | "botAnswer" }>, target: AnswerTarget): Promise<string | null> {
  if (!(await target.reach(intent.hostId))) return intent.type === "botAnswer" ? "The computer this came from is not connected. Answer it in the app once it is." : "The computer this came from is not connected. Answer it in the session.";
  try {
    if (intent.type === "botAnswer") {
      await target.answerBot(intent.botId, intent.number, { answer: intent.answer }, intent.question);
      return null;
    }
    const result = intent.type === "permission"
      ? await target.respondPermission(intent.sessionId, intent.tabId, intent.requestId, intent.optionId)
      : await target.answerQuestions(intent.sessionId, intent.tabId, intent.requestId, intent.answers);
    return result.answered ? null : result.message;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** A short, stable key for a set of labels (FNV-1a), for a category id. */
function categoryKey(labels: string[]): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(labels)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
