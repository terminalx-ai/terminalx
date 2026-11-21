/**
 * Slack and Telegram as a bot's channels (PRO-481), as the runtime shows them: each service's account (never its
 * tokens), how its connector is doing, the chats linked, a link code waiting, "Also sends to", and the newest
 * messages without their text. A value a newer app wrote arrives as its own string and is shown as it is.
 */

export type ChatAppService = "slack" | "telegram";

export type ChatAppState = "off" | "connecting" | "connected" | "failing" | (string & {});

export interface ChatAppLink {
  chat: string;
  /** "Direct chat", a group's title, `#channel`. */
  name: string;
  direct: boolean;
  /** Who sent the code: the owner there. */
  by: string;
  linked: string;
}

/** That a link code waits, and until when: never the code, which only the person who asked for it is given. */
export interface ChatAppCode {
  expires: string | null;
}

/** A new link code, as only `chatAppLink` (a person's call) answers with it. */
export interface ChatAppMadeCode {
  service: string;
  code: string;
  expires: string | null;
  /** Telegram: the `t.me` link that sends the code. */
  link: string | null;
}

export interface ChatAppServiceView {
  service: ChatAppService | (string & {});
  connected: boolean;
  state: ChatAppState;
  why: string;
  /** Telegram: the bot's `@username`. Slack: the workspace's name. */
  account: { name: string } | null;
  links: ChatAppLink[];
  code: ChatAppCode | null;
}

export interface ChatAppMessage {
  service: string;
  chat: string;
  direct: boolean;
  by: string;
  from: string;
  at: string;
  state: "waiting" | "delivered" | "notAccepted" | "failed" | (string & {});
  why: string;
  session?: string | null;
}

export interface BotChatAppsView {
  services: ChatAppServiceView[];
  /** Only in the answer to `chatAppLink`. */
  made?: ChatAppMadeCode;
  alsoSendsTo: string[];
  activity: ChatAppMessage[];
}
