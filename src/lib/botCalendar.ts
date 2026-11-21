import { invoke } from "@/lib/api";
import { newDutyInput } from "@/lib/botDuties";
import type { AutomationSchedule } from "@/types/automations";
import type { CalendarBlock, DayCount, DutyWeek } from "@/types/botCalendar";
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
const CRON_DAYS = [1, 2, 3, 4, 5, 6, 0];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` plus `days`. */
export function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day + days));
  return at.toISOString().slice(0, 10);
}

function dayOf(ymd: string): { day: number; month: string } {
  const [, month, day] = ymd.split("-").map(Number);
  return { day, month: MONTHS[month - 1] ?? "" };
}

/** `16–22 Nov`, or `30 Nov – 6 Dec` across a month. */
export function weekLabel(days: readonly string[]): string {
  if (days.length < 7) return "";
  const first = dayOf(days[0]);
  const last = dayOf(days[6]);
  return first.month === last.month ? `${first.day}–${last.day} ${last.month}` : `${first.day} ${first.month} – ${last.day} ${last.month}`;
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
  if (phase === "future") return count.planned ? `${count.planned} to come` : count.scheduled ? "none to come" : "off that day";
  if (phase === "today") return count.ran ? `${count.ran} so far · ${reportsText(count)}` : count.planned ? `${count.planned} to come` : "none today";
  if (!count.ran) return count.scheduled ? "none ran" : "off that day";
  return `${count.ran}${first ? " checks" : ""} · ${reportsText(count)}`;
}

/** A day's cell of the "Events" row. */
export function eventsText(count: DayCount, phase: DayPhase, any: boolean, first = true): string {
  if (phase === "future") return any ? "as they arrive" : "–";
  if (!count.ran) return any ? (phase === "today" ? "none so far" : "none") : "–";
  const unit = phase === "today" ? " so far" : first ? (count.ran === 1 ? " event" : " events") : "";
  return `${count.ran}${unit} · ${reportsText(count)}`;
}

/**
 * Side-by-side places for blocks that would cover each other: blocks of a day that start within half an hour of one
 * another share the column's width. Keyed by the block's index in `blocks`.
 */
export function lanes(blocks: readonly CalendarBlock[]): Map<number, { lane: number; of: number }> {
  const placed = new Map<number, { lane: number; of: number }>();
  const span = (BLOCK_PX / HOUR_PX) * 60;
  for (let day = 0; day < 7; day++) {
    const ofDay = blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.day === day).sort((a, b) => a.block.minute - b.block.minute);
    let group: { index: number; lane: number }[] = [];
    let ends: number[] = [];
    const close = () => {
      for (const member of group) placed.set(member.index, { lane: member.lane, of: Math.max(1, ends.length) });
      group = [];
      ends = [];
    };
    for (const { block, index } of ofDay) {
      if (group.length && ends.every((end) => end <= block.minute)) close();
      let lane = ends.findIndex((end) => end <= block.minute);
      if (lane < 0) {
        lane = ends.length;
        ends.push(0);
      }
      ends[lane] = block.minute + span;
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
    if (!/^[0-7]$/.test(dayOfWeek)) return { reason: dayOfWeek === "*" ? "It wakes every day: only its time moves. Drop it on the same day." : CRON_HINT };
    const current = CRON_DAYS.indexOf(Number(dayOfWeek) % 7);
    weekday = String(CRON_DAYS[(((current + days) % 7) + 7) % 7]);
  }
  return { schedule: { ...schedule, cron: [String(next % 60), moved.sort((a, b) => a - b).join(","), dayOfMonth, month, weekday].join(" ") } };
}
