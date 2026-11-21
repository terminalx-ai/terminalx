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
  text: string;
  /** Two to four. */
  answers: string[];
  /** The one the bot recommends, counted from 0. */
  recommended?: number;
  /** When it was asked: an answer names the question it answers by this. */
  asked: string;
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
}

/** Everything waiting on the owner, across the bots, newest first. */
export interface NeedsYou {
  entries: NeedsYouEntry[];
  counts: NeedsYouCount[];
}

/** What an owner's act answers: the item as saved, and whether its message reached the bot's home chat. */
export interface BotItemAct {
  item: BotItem;
  delivery?: { sent: boolean; sessionId?: string; error?: string };
  stopped?: string[];
}
