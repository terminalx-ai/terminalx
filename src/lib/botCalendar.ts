import { invoke } from "@/lib/api";
import { CRON_WEEKDAYS, cronWeekdayCode, describeSchedule } from "@/lib/automationSchedule";
import { newDutyInput } from "@/lib/botDuties";
import type { AutomationSchedule } from "@/types/automations";
import type { CalendarBlock, DayCount, DutyLog, DutyWeek } from "@/types/botCalendar";
import type { DutyInput } from "@/types/botDuties";

/**
 * A week of duties (PRO-473, design 23.13). The runtime reads it from the run logs and the schedules, in the owner's
 * time zone (`bots::calendar`), so the calendar agrees with both. A read: it carries no person's proof, and a process
 * in a bot's session may read its own bot's week only.
 */
export const calendarApi = {
  /** Bot `id`'s week, or every bot's; `week` is any day in it, `YYYY-MM-DD` (this week when null). */
  week: (id: string | null, week: string | null) => invoke<DutyWeek>("bot_duty_week", { id, week }),
};

/** How tall an hour is on the grid, in pixels. */
export const HOUR_PX = 46;
/** A block's height, in pixels: about half an hour. */
export const BLOCK_PX = 22;
/** A drag moves a block in steps of this many minutes. */
export const SNAP_MINUTES = 15;

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` plus `days`. */
/** The Mondays of the first and last weeks the runtime shows (`bots::calendar`); the arrows stop there. */
export const FIRST_WEEK = "2000-01-03";
export const LAST_WEEK = "2199-12-30";

/** Whether the week starting `monday` may be asked for. */
export function weekShown(monday: string): boolean {
  return monday >= FIRST_WEEK && monday <= LAST_WEEK;
}

export function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day + days));
  return at.toISOString().slice(0, 10);
}

function dayOf(ymd: string): { day: number; month: string } {
  const [, month, day] = ymd.split("-").map(Number);
  return { day, month: MONTHS[month - 1] ?? "" };
}

/**
 * `16–22 Nov`, or `30 Nov – 6 Dec` across a month. A week of another year than `todayYmd`'s says its year
 * (`16–22 Nov 2025`), and one across a new year both (`28 Dec 2026 – 3 Jan 2027`).
 */
export function weekLabel(days: readonly string[], todayYmd?: string): string {
  if (days.length < 7) return "";
  const first = dayOf(days[0]);
  const last = dayOf(days[6]);
  const [firstYear, lastYear] = [days[0].slice(0, 4), days[6].slice(0, 4)];
  if (firstYear !== lastYear) return `${first.day} ${first.month} ${firstYear} – ${last.day} ${last.month} ${lastYear}`;
  const year = todayYmd && todayYmd.slice(0, 4) !== firstYear ? ` ${firstYear}` : "";
  return first.month === last.month ? `${first.day}–${last.day} ${last.month}${year}` : `${first.day} ${first.month} – ${last.day} ${last.month}${year}`;
}

/** The day of the month, for a column's head. */
export function dayNumber(ymd: string): number {
  return dayOf(ymd).day;
}

/** `HH:MM` from minutes after midnight. */
export function clock(minute: number): string {
  const value = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/** Today's date and the minutes after midnight in `timezone`, on this computer's clock. */
export function wallClock(timezone: string, at = new Date()): { ymd: string; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "00";
    return { ymd: `${part("year")}-${part("month")}-${part("day")}`, minute: Number(part("hour")) * 60 + Number(part("minute")) };
  } catch {
    return { ymd: at.toISOString().slice(0, 10), minute: at.getUTCHours() * 60 + at.getUTCMinutes() };
  }
}

/** Where a day of the shown week stands against today: before it, today, or still to come. */
export type DayPhase = "past" | "today" | "future";

export function dayPhase(days: readonly string[], day: number, todayYmd: string): DayPhase {
  const ymd = days[day] ?? "";
  return ymd < todayYmd ? "past" : ymd === todayYmd ? "today" : "future";
}

function reportsText(count: DayCount): string {
  if (count.reports) return count.reports === 1 ? "1 report" : `${count.reports} reports`;
  if (count.failed) return `${count.failed} failed`;
  return "quiet";
}

/** Whether a counted cell has something for the owner: a report or a failure. */
export function countWarns(count: DayCount): boolean {
  return count.reports > 0 || count.failed > 0;
}

/**
 * A day's cell of the "Often" row: what ran and what it found, or what is still to come. As in the design, only the
 * week's first day names the unit (`78 checks · quiet`); the others are `78 · 1 report`.
 */
export function oftenText(count: DayCount, phase: DayPhase, any: boolean, first = true): string {
  if (!any && !count.ran) return "–";
  if (phase === "future") return count.planned ? `${count.capped ? "at least " : ""}${count.planned} to come` : count.scheduled ? "none to come" : "off that day";
  // A day the logs no longer reach back over: what is kept is a floor, and none kept is not none run.
  const floor = count.notKept > 0 ? "at least " : "";
  if (count.notKept > 0 && !count.ran) return "history not kept";
  if (phase === "today") return count.ran ? `${floor}${count.ran} so far · ${reportsText(count)}` : count.planned ? `${count.planned} to come` : "none today";
  if (!count.ran) return count.scheduled ? "none ran" : "off that day";
  return `${floor}${count.ran}${first ? " checks" : ""} · ${reportsText(count)}`;
}

/** A day's cell of the "Events" row. */
export function eventsText(count: DayCount, phase: DayPhase, any: boolean, first = true): string {
  if (phase === "future") return any ? "as they arrive" : "–";
  if (count.notKept > 0 && !count.ran) return "history not kept";
  if (!count.ran) return any ? (phase === "today" ? "none so far" : "none") : "–";
  const unit = phase === "today" ? " so far" : first ? (count.ran === 1 ? " event" : " events") : "";
  return `${count.notKept > 0 ? "at least " : ""}${count.ran}${unit} · ${reportsText(count)}`;
}

/** The minutes a block covers on the grid: its run's length, or at least a block's height; never past midnight. */
export function blockSpan(block: Pick<CalendarBlock, "minute" | "minutes">): number {
  const least = (BLOCK_PX / HOUR_PX) * 60;
  return Math.max(least, Math.min(block.minutes ?? 0, 1440 - block.minute));
}

/**
 * Where a block is drawn in its day's column, in pixels: from its time, as tall as its span, and moved up so that one
 * near midnight ends inside the day rather than below it.
 */
export function blockBox(block: Pick<CalendarBlock, "minute" | "minutes">): { top: number; height: number } {
  const day = 24 * HOUR_PX;
  const height = Math.max(BLOCK_PX, Math.round((blockSpan(block) / 60) * HOUR_PX) - 2);
  return { top: Math.max(0, Math.min((block.minute / 60) * HOUR_PX + 1, day - height - 1)), height };
}

/** An older runtime that does not know the week of duties answers this way: only restarting it helps. */
export function weekUnknown(error: string | null): boolean {
  return !!error && /Unknown bots operation dutyWeek\b/.test(error);
}

/**
 * Side-by-side places for blocks that would cover each other: blocks of a day whose spans (a run's length, or half an
 * hour) meet share the column's width. Keyed by the block's index in `blocks`.
 */
export function lanes(blocks: readonly CalendarBlock[]): Map<number, { lane: number; of: number }> {
  const placed = new Map<number, { lane: number; of: number }>();
  // Where each is drawn: one moved up from midnight covers the minutes it is drawn over.
  const from = (block: CalendarBlock) => (blockBox(block).top / HOUR_PX) * 60;
  for (let day = 0; day < 7; day++) {
    const ofDay = blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.day === day).sort((a, b) => from(a.block) - from(b.block));
    let group: { index: number; lane: number }[] = [];
    let ends: number[] = [];
    const close = () => {
      for (const member of group) placed.set(member.index, { lane: member.lane, of: Math.max(1, ends.length) });
      group = [];
      ends = [];
    };
    for (const { block, index } of ofDay) {
      if (group.length && ends.every((end) => end <= from(block))) close();
      let lane = ends.findIndex((end) => end <= from(block));
      if (lane < 0) {
        lane = ends.length;
        ends.push(0);
      }
      ends[lane] = from(block) + blockSpan(block);
      group.push({ index, lane });
    }
    close();
  }
  return placed;
}

/** A new duty at a clicked hour: weekly, on that day, at that time, in the week's time zone. */
export function dutyAt(day: number, minute: number, timezone: string): DutyInput {
  const input = newDutyInput();
  return {
    ...input,
    schedule: { ...input.schedule, kind: "preset", preset: "weekly", cron: undefined, weekdays: [CODES[day] ?? "MO"], hour: Math.floor(minute / 60), minute: minute % 60, timezone },
  };
}

/** What a duty's log notice says: unreadable, cut back to its oldest run, or with more times than were looked at. */
export function logWords(log: DutyLog, name: string, timezone: string | undefined): string {
  if (log.unreadable) return `${name}: its run log could not be read, so its past runs are not shown. ${log.unreadable}`;
  if (log.keptFrom) {
    const at = new Date(log.keptFrom);
    const when = Number.isNaN(at.getTime()) ? log.keptFrom : at.toLocaleString("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    return `${name}: history not kept before ${when}. Its log keeps its newest 100 runs, so the counts are at least these.`;
  }
  return `${name}: wakes more often than the week can show; its runs still to come are at least the counts shown.`;
}

/** A schedule in a few words, for saying what a move changed: a cron schedule by its expression. */
export function scheduleWords(schedule: AutomationSchedule): string {
  return schedule.kind === "cron" ? `cron ${schedule.cron ?? ""}`.trim() : describeSchedule(schedule);
}

/**
 * Where a dragged block lands: on the day under the pointer, moved from its own time by whole steps of the pointer's
 * travel. Less than a full step leaves its time as it is, so a click that wobbles moves nothing.
 */
export function dragTarget(block: { day: number; minute: number }, day: number, travelPx: number): { day: number; minute: number } {
  const step = (HOUR_PX * SNAP_MINUTES) / 60;
  const steps = Math.trunc(travelPx / step);
  const minute = Math.min(1440 - SNAP_MINUTES, Math.max(0, block.minute + steps * SNAP_MINUTES));
  return { day, minute };
}

/** Why a block cannot be moved by dragging, or the schedule it moves to. */
export type Moved = { schedule: AutomationSchedule } | { reason: string };

const CRON_HINT = "Change its cron schedule on the duty's page.";

/**
 * The schedule a duty has once one of its blocks is dragged from `from` to `to` (day 0–6, minutes after midnight in
 * the week's time zone). The move is applied to the schedule as a shift, so a schedule kept in another time zone moves
 * by the same amount. Daily and weekday schedules change their time only; a weekly one its day too; a cron schedule
 * only when its minute and hour are plain numbers (one hour, or a list where the block's hour is found).
 */
export function movedSchedule(schedule: AutomationSchedule, from: { day: number; minute: number }, to: { day: number; minute: number }, weekTimezone: string): Moved {
  const shift = to.minute - from.minute;
  const days = to.day - from.day;
  if (!shift && !days) return { schedule };
  const wrap = (value: number) => ((value % 1440) + 1440) % 1440;
  if (schedule.kind === "preset") {
    const at = (schedule.hour ?? 9) * 60 + (schedule.minute ?? 0);
    switch (schedule.preset) {
      case "daily":
      case "weekdays": {
        const next = wrap(at + shift);
        return { schedule: { ...schedule, hour: Math.floor(next / 60), minute: next % 60 } };
      }
      case "weekly": {
        const total = at + shift + days * 1440;
        const carry = Math.floor(total / 1440);
        const index = CODES.indexOf(schedule.weekdays[0] ?? "MO");
        const weekday = CODES[(((index < 0 ? 0 : index) + carry) % 7 + 7) % 7];
        const next = wrap(total);
        return { schedule: { ...schedule, weekdays: [weekday], hour: Math.floor(next / 60), minute: next % 60 } };
      }
      default:
        return { reason: "A duty that wakes every hour is counted, not drawn." };
    }
  }
  const fields = (schedule.cron ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return { reason: CRON_HINT };
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  if (!/^\d{1,2}$/.test(minuteField) || !/^\d{1,2}(,\d{1,2})*$/.test(hourField) || dayOfMonth !== "*" || month !== "*") return { reason: CRON_HINT };
  const minute = Number(minuteField);
  const hours = hourField.split(",").map(Number);
  // The hour the block stands for: the one at the block's time, or the only one.
  const index = schedule.timezone === weekTimezone ? hours.findIndex((hour) => hour * 60 + minute === from.minute) : hours.length === 1 ? 0 : -1;
  if (index < 0) return { reason: CRON_HINT };
  const next = hours[index] * 60 + minute + shift;
  if (next < 0 || next >= 1440) return { reason: "Move it within the same day, or change its schedule on the duty's page." };
  if (hours.length > 1 && next % 60 !== minute) return { reason: "Its other times share the minute: move it by whole hours, or change its schedule on the duty's page." };
  const moved = hours.map((hour, at) => (at === index ? Math.floor(next / 60) : hour));
  if (new Set(moved).size !== moved.length) return { reason: "It already wakes at that hour." };
  let weekday = dayOfWeek;
  if (days) {
    // The scheduler's numbers (1 = Sunday … 7 = Saturday), never 0.
    const code = /^\d$/.test(dayOfWeek) ? cronWeekdayCode(Number(dayOfWeek)) : null;
    if (!code) return { reason: dayOfWeek === "*" ? "It wakes every day: only its time moves. Drop it on the same day." : CRON_HINT };
    weekday = String(CRON_WEEKDAYS[CODES[(((CODES.indexOf(code) + days) % 7) + 7) % 7]]);
  }
  return { schedule: { ...schedule, cron: [String(next % 60), moved.sort((a, b) => a - b).join(","), dayOfMonth, month, weekday].join(" ") } };
}
