import type { AutomationEventSource, AutomationPrecheck, AutomationSchedule } from "@/types/automations";

/**
 * Where a duty's result goes (PRO-471): a note in the bot's home chat and a notification, or a note in its lead's
 * home chat. A target a newer app wrote (Slack, Telegram, a pull request, with the channel tickets) arrives as its own
 * string: it is shown and kept, and reported to TerminalX here.
 */
export type DutyReportsTo = "terminalx" | "lead" | (string & {});

/** The bot a duty belongs to, as its automation records it. */
export interface DutyOwner {
  /** The bot's id: the one stable reference. */
  id: string;
  reportsTo: DutyReportsTo;
  /** The role template's duty it was made from at hire, if it was. */
  template?: string | null;
}

/** What a message from one bot to another is (PRO-472). */
export type BotMessageKind = "handoff" | "question" | "status";

/** The kinds of event only a bot's duty wakes on (PRO-472, `bots/wakes.rs`). */
export type BotWakeKind = "githubMention" | "githubSecurityAlert" | "githubBranchCheck" | "linearMention" | "botMessage" | "watch";

/** A source only a bot's duty has. Each kind reads the fields it needs; fields a newer app wrote are kept. */
export interface BotWakeSource {
  kind: BotWakeKind;
  /** `owner/name`, for the GitHub kinds. */
  repo?: string | null;
  /** What people write after `@` to mention the bot. */
  handle?: string | null;
  branch?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  /** The bots (by id) whose messages wake it; any of yours when empty. */
  from?: string[];
  /** The kinds of message that wake it; every kind when empty. */
  kinds?: BotMessageKind[];
  target?: "url" | "file" | "command" | null;
  /** The URL, the file's full path, or the command. */
  value?: string | null;
  timeoutSeconds?: number | null;
  [unknown: string]: unknown;
}

/** What a duty wakes on besides a schedule: a pull request or Linear issue source (PRO-485) or one of a bot's own. */
export type DutyWakeSource = AutomationEventSource | BotWakeSource;

export interface DutyWake {
  source: DutyWakeSource;
  pollIntervalMinutes: number;
  maxRunsPerTick: number;
}

/** A new or changed duty. Its agent, model, access and folder are its bot's. */
export interface DutyInput {
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  precheck: AutomationPrecheck | null;
  reportsTo: DutyReportsTo;
  enabled: boolean;
  /** What wakes it instead of its schedule; `null` for a duty on a schedule. */
  wake: DutyWake | null;
}

/** A bot's quiet hours, local wall time `HH:MM`; across midnight when `to` is earlier. */
export interface QuietHours {
  from: string;
  to: string;
}

/** A duty's note from earlier runs, `duties/<id>.md` in the bot's home: absent, read (capped), or unreadable. */
export type DutyNote = null | { text: string; cut: boolean } | { unreadable: string };

/** What the window reads beside the duties: the bot's quiet hours, each duty's note, the home its checks run in. */
export interface DutyState {
  quietHours: QuietHours | null;
  notes: Record<string, DutyNote>;
  home: string | null;
}

/** What a duty's run reported. `reportedTo` is `owner`, the lead bot's id, or `nobody` for nothing new. */
export interface DutyRunReport {
  reportedTo?: string;
  nothingNew?: boolean;
  urgent?: boolean;
  quiet?: boolean;
  notified?: boolean;
  /** The home chat the note went in. */
  note?: string | null;
}

/** A report the owner is notified of (`bot_duty_report`). */
export interface DutyReportEvent {
  botId: string;
  botName: string;
  dutyId: string;
  dutyName: string;
  runId: string;
  sessionId?: string | null;
  tabId?: string | null;
  text: string;
  urgent: boolean;
}
