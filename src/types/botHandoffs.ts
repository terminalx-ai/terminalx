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
  unreadable: number;
  /** How deep a chain of hand-offs may go, and how many tries one gets: "2 of 3 in its chain", "try 2 of 3". Absent from an older runtime. */
  maxDepth?: number;
  maxTries?: number;
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
