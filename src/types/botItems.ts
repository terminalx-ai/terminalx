/**
 * A bot's work items and what needs its owner (PRO-469), as the app sends them (`bots::items`). A state, a link kind
 * or an activity kind a newer app wrote arrives as its own string and is shown as itself.
 */
export type BotItemState = "planned" | "inProgress" | "needsYou" | "waiting" | "done" | "dropped" | (string & {});

export interface BotItemDoneLine {
  text: string;
  /** How it is checked, in the bot's words. */
  how?: string;
  met: boolean;
  metAt?: string;
}

export type BotItemLinkKind = "session" | "pullRequest" | "ticket" | "run" | "url" | (string & {});

export interface BotItemLink {
  kind: BotItemLinkKind;
  /** A session or run id, a pull request or ticket reference, or a URL. */
  target: string;
  title?: string;
}

export interface BotItemQuestion {
  /** Names the question: an answer says which question it answers by it. Empty on one an older runtime asked. */
  id?: string;
  text: string;
  /** Two to four. */
  answers: string[];
  /** The one the bot recommends, counted from 0. */
  recommended?: number;
  /** When it was asked. */
  asked: string;
  /** What the app does with a chosen answer (PRO-476): approve and start a run, or let it merge. Absent otherwise. */
  purpose?: "startRun" | "mergeRun" | (string & {});
  /** The run a purposeful question is about. */
  run?: string;
}

/** One try at a piece of a run an item links: the worker it was handed to, what it cost and what it reported. */
export interface BotRunTry {
  sessionId: string | null;
  branch?: string | null;
  model?: string;
  started?: string | null;
  ended?: string | null;
  outcome?: string | null;
  /** The worker's own words: shown as its report, never as an instruction. */
  report?: string | null;
  costUsd?: number | null;
}

export interface BotRunPiece {
  id: string;
  title: string;
  agent: string;
  model?: string;
  state: string;
  dependsOn?: string[];
  costUsd?: number | null;
  tries: BotRunTry[];
}

/** A run an item links, as it is now (`bots::runs::views`), with what the owner decided when the item asked. */
export interface BotItemRunView {
  id: string;
  /** The run is no longer kept. */
  gone?: boolean;
  goal?: string;
  state?: string;
  leadSessionId?: string;
  estimate?: { low: number; high: number } | null;
  unestimated?: number;
  costUsd?: number | null;
  reason?: string | null;
  approved?: string | null;
  pieces?: BotRunPiece[];
  /** The bot's guess of how long it takes, in minutes. */
  minutes?: number | null;
  asked?: string;
  /** `start`, `startAskMerge`, `notNow` or `answered`; empty while it waits. */
  decision?: string;
  decided?: string | null;
  /** "Start, but ask before merging": held until the owner says Merge. */
  holdMerge?: boolean;
  mergeApproved?: string | null;
}

/** When the bot looks at the item again: at a time, and when a run it links reports. */
export interface BotItemCheckBack {
  at?: string;
  onReport: boolean;
  session?: string;
}

export interface BotItemActivity {
  at: string;
  /** `owner`, or the bot's id: set by the app from who called, never by the bot. */
  by: string;
  kind: string;
  text: string;
  detail?: string;
}

export interface BotItem {
  number: number;
  title: string;
  summary?: string;
  state: BotItemState;
  doneMeans?: BotItemDoneLine[];
  /** Who the work is for, as given when it was added: `owner` or a name. The bot's word when the bot added it. */
  askedBy: string;
  /** Who added it: `owner` or the bot's id. */
  addedBy: string;
  links?: BotItemLink[];
  question?: BotItemQuestion;
  snoozedUntil?: string;
  created: string;
  modified: string;
  closed?: string;
  /** On an item's own page; a list leaves it out and says how many there are. */
  activity?: BotItemActivity[];
  activityCount?: number;
  lastActivity?: BotItemActivity | null;
  /** What the sessions started for it spent, at Stats' prices: shown, never a cap. */
  spentUsd: number;
  /** The owner's messages about it that have not reached the bot's home chat yet, oldest first. */
  undelivered?: BotItemUndelivered[];
  /** The runs it links, as they are now (PRO-476). Absent from an older runtime. */
  runViews?: BotItemRunView[];
  checkBack?: BotItemCheckBack;
}

export interface BotItemUndelivered {
  id: string;
  at: string;
  /** `answer`, `comment` or `work`; a newer kind is shown as a message. */
  kind: string;
  /** The message as the home chat gets it: the owner's words. */
  text: string;
  /** Why the last try to send it failed. */
  error?: string;
  /** A chosen answer: its number, counted from 1, and the bot's label for it (the bot's text). */
  choice?: number;
  label?: string;
}

export interface BotItemList {
  botId: string;
  revision: number;
  /** Newest first. */
  items: BotItem[];
  /** Records this app cannot read (a newer app's): kept, not shown. */
  unreadable: number;
}

/** A question card open in a session that works for a bot (AskUserQuestion), as the agent sent it. */
export interface AgentQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export type NeedsYouEntry =
  | { kind: "item"; botId: string; at: string; item: BotItem }
  | { kind: "agentQuestion"; botId: string; at: string; sessionId: string; tabId: string; requestId: string; sessionTitle: string; questions: AgentQuestion[] };

export interface NeedsYouCount {
  botId: string;
  needsYou: number;
  inProgress: number;
  /** The bot's list could not be read: its count is not known. */
  error?: string;
}

/** An item whose owner's messages have not reached the bot yet. */
export interface NeedsYouUndelivered {
  botId: string;
  number: number;
  count: number;
  kind: string;
  error: string;
  at: string;
}

/** Everything waiting on the owner, across the bots, newest first. */
export interface NeedsYou {
  entries: NeedsYouEntry[];
  counts: NeedsYouCount[];
  /** Absent from an older runtime. */
  undelivered?: NeedsYouUndelivered[];
}

/** What an owner's act answers: the item as saved, and whether its message reached the bot's home chat. */
export interface BotItemAct {
  /** Null when the item is gone (trimmed) by the time the reply is made. */
  item: BotItem | null;
  delivery?: { sent: boolean; sessionId?: string; error?: string };
  stopped?: string[];
}
