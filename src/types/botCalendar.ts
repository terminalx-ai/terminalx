import type { QuietHours } from "@/types/botDuties";

/**
 * What a block on the week's grid says (PRO-473): the four states of the design (ran and did its work, ran and
 * reported, ran and found nothing new, still to come), and the run log's others as they are.
 */
export type BlockState = "done" | "reported" | "quiet" | "next" | "running" | "failed" | "stopped" | "skipped";

/** One run, or a time still to come, of a duty drawn on the grid (`bots::calendar::Block`). */
export interface CalendarBlock {
  dutyId: string;
  botId: string;
  /** 0 for Monday … 6 for Sunday. */
  day: number;
  /** Minutes after midnight, in the owner's time zone. */
  minute: number;
  at: string;
  state: BlockState;
  /** The runs it stands for: more than one only for repeats the log keeps no time of. */
  count: number;
  /** How long its run went on (to now while it runs), when the log says; absent from an older runtime. */
  minutes?: number;
  runId?: string;
  sessionId?: string;
  note?: string;
}

/** One day of a counted row. */
export interface DayCount {
  ran: number;
  reports: number;
  failed: number;
  planned: number;
  scheduled: number;
  /** How many duties counted here have a log that no longer reaches back over this day, or could not be read. */
  notKept: number;
  /** Some schedule counted here had more times than were looked at: `planned` is a floor. */
  capped: boolean;
}

/** A drawn duty whose log does not reach back over a day: nothing is kept from midnight to `untilMinute`. */
export interface NotKept {
  dutyId: string;
  untilMinute: number;
}

/** A duty whose log does not tell the whole week. */
export interface DutyLog {
  dutyId: string;
  botId: string;
  /** The oldest instant its log still covers. */
  keptFrom?: string;
  /** Why its log could not be read. */
  unreadable?: string;
  capped?: boolean;
}

export interface NextRun {
  dutyId: string;
  botId: string;
  minute: number;
  at: string;
}

/** A week of duties, as `dutyWeek` reads it from the run logs and the schedules. */
export interface DutyWeek {
  timezone: string;
  /** Monday first, `YYYY-MM-DD`. */
  days: string[];
  today: number | null;
  nowMinute: number | null;
  blocks: CalendarBlock[];
  often: DayCount[];
  oftenDuties: string[];
  events: DayCount[];
  eventDuties: string[];
  nextToday: NextRun[];
  /** `atLeast`: some log does not reach back over the week so far, or could not be read; these are floors. */
  totals: { checks: number; nothingNew: number; reports: number; atLeast: boolean };
  quietHours: Record<string, QuietHours>;
  /** Per day, the drawn duties whose log does not reach back over it. */
  notKept: NotKept[][];
  /** The duties whose log is cut, unreadable or capped this week. */
  logs: DutyLog[];
}
