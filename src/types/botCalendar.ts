import type { QuietHours } from "@/types/botDuties";

/**
 * What a block on the week's grid says (PRO-473): the four states of the design (ran and did its work, ran and
 * reported, ran and found nothing new, still to come), and the run log's others as they are.
 */
export type BlockState = "done" | "reported" | "quiet" | "next" | "running" | "failed" | "skipped";

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
  totals: { checks: number; nothingNew: number; reports: number };
  quietHours: Record<string, QuietHours>;
}
