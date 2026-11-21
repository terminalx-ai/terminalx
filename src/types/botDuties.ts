import type { AutomationPrecheck, AutomationSchedule } from "@/types/automations";

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

/** A new or changed duty. Its agent, model, access and folder are its bot's. */
export interface DutyInput {
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  precheck: AutomationPrecheck | null;
  reportsTo: DutyReportsTo;
  enabled: boolean;
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
