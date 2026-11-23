/**
 * GitHub and Linear as a bot's channels (PRO-480): where a mention was made, what became of it, and what the bot
 * posted on its owner's behalf. A value a newer app wrote arrives as its own string and is shown as it is.
 */

/** Where a mention was made, or where a post went. */
export interface BotChannelThread {
  kind: "github" | "linear" | (string & {});
  /** GitHub: `owner/name` and the pull request's or issue's number. */
  repo?: string;
  number?: number;
  /** Linear: the issue's identifier. */
  issue?: string;
  title?: string;
  url: string;
  review?: boolean;
}

export type BotMentionState = "waiting" | "delivered" | "notAccepted" | "failed" | (string & {});

export interface BotMention {
  id: string;
  thread: BotChannelThread;
  /** Who wrote it, as the service shows them. */
  by: string;
  /** `owner` or `person`; empty for one not accepted. */
  from: string;
  at: string;
  state: BotMentionState;
  why: string;
  /** The chat it went to. */
  session?: string | null;
}

export interface BotPost {
  bot: string;
  kind: "review" | "changesRequested" | "comment" | "reply" | (string & {});
  thread: BotChannelThread;
  at: string;
  url: string;
}

/** The newest of each, newest first, and the handle people mention the bot by. */
export interface BotChannelsView {
  mentions: BotMention[];
  posts: BotPost[];
  handle: string;
}

/** Where a chat that a mention started came from, as its session entry carries it. */
export interface SessionBotChannel {
  kind: "github" | "linear" | "slack" | "telegram" | (string & {});
  /** `owner/name#12` or `PRO-123`. */
  label: string;
  url: string;
  title?: string;
}
