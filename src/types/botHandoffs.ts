/**
 * Hand-offs between bots and the team brief (PRO-475), as the app sends them (`bots::handoffs`, `bots::brief`). A
 * state a newer app wrote arrives as its own string, is shown as itself and counts as open.
 */
export type HandoffState = "waiting" | "working" | "answered" | "failed" | "stopped" | (string & {});

export interface HandoffReply {
  at: string;
  /** The receiving bot's words, or what TerminalX said when it could not start or reach it (`by` is `terminalx`). */
  text: string;
  failed?: boolean;
  by: string;
}

export interface Handoff {
  number: number;
  /** Bot ids: the one that handed the work on, and the one it went to. */
  from: string;
  to: string;
  /** The sending bot's id, or `owner` when the owner handed one of its items on. */
  by: string;
  /** The sender's words (the item's, when the owner handed one). */
  title: string;
  scope?: string;
  due?: string;
  /** The owner's own note, when they handed it. */
  note?: string;
  state: HandoffState;
  depth: number;
  retryOf?: number;
  attempt?: number;
  /**
   * The hand-off this one was handed on from (PRO-540), recorded when it was made and only where that was known. One
   * without it may still have a `depth` above 1: `depth` is what the limit counts, not where it sits in a chain.
   */
  parent?: number;
  fromSession?: string;
  fromItem?: number;
  toSession?: string;
  item?: number;
  created: string;
  modified: string;
  started?: string;
  answer?: HandoffReply;
  closed?: string;
  stoppedBy?: string;
  /** Messages about it that have not reached their chat yet. */
  waitingMessages: number;
}

/** A message or answer between bots that did not reach its chat yet: shown with Resend, never its text. */
export interface UndeliveredMessage {
  id: string;
  at: string;
  from: string;
  to: string;
  kind: string;
  handoff?: number | null;
  tries: number;
  error: string;
  /** Out of automatic tries: it goes after one of its bot's chats starts, or on Resend. */
  held: boolean;
}

export interface HandoffList {
  revision: number;
  handoffs: Handoff[];
  /** Messages waiting for the bot asked about. */
  waitingMessages: number;
  /** To or from the bot, and not delivered after at least one try. */
  undelivered?: UndeliveredMessage[];
  /** Every record this build cannot read: hand-offs and messages together. */
  unreadable: number;
  /** How many of those are hand-offs, and how many are messages (PRO-540). A runtime from before it sends neither. */
  unreadableHandoffs?: number;
  unreadableMessages?: number;
  /** How deep a chain may grow, and how often a failed hand-off may be handed again: what `depth` and `attempt` are counted against. */
  maxDepth?: number;
  maxRetries?: number;
}

export interface TeamBrief {
  text: string;
  /** What an edit started from: a brief changed since is not written over. */
  hash: string;
  lines: number;
  /** When the owner last saved it in TerminalX. */
  modified: string;
  /** Changed outside TerminalX since: bots are given it as information only. */
  outside: boolean;
  cut: boolean;
  unreadable?: string | null;
  limit: number;
}

export const CLOSED_HANDOFF_STATES: readonly string[] = ["answered", "failed", "stopped"];
