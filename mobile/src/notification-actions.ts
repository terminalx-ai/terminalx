import * as Notifications from "expo-notifications";
import type { NotificationPresentation } from "./notifications/filter";

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
  if (!subtitle || data.detailsHidden || !data.requestId) return null;
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
  | { type: "question"; hostId: string; sessionId: string; tabId: string; requestId: string; answers: Record<string, string> };

/**
 * A notification response as an intent: a button answers, anything else
 * opens the session. `body` is the question exactly (the Mac sends
 * `question` only then), the key `questions.respond` takes the answer by.
 */
export function intentOf(actionIdentifier: string, data: Record<string, unknown> | undefined, body: string | null): NotificationIntent | null {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  const tabId = typeof data?.tabId === "string" ? data.tabId : "";
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
}

/** Answers on the Mac. Resolves the Mac's refusal in words, or null once answered. */
export async function answer(intent: Extract<NotificationIntent, { type: "permission" | "question" }>, target: AnswerTarget): Promise<string | null> {
  if (!(await target.reach(intent.hostId))) return "The Mac this came from is not connected. Answer it in the session.";
  try {
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
