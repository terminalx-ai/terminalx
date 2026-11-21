import type { AutomationSchedule } from "@/types/automations";

function clock(hour = 9, minute = 0): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const DAYS: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

/**
 * The scheduler's cron numbers for the days of the week (`automations::next_run_after`, the `cron` crate): 1 = Sunday
 * … 7 = Saturday; 0 is not a day there. Keyed by the presets' day codes.
 */
export const CRON_WEEKDAYS: Record<string, number> = { SU: 1, MO: 2, TU: 3, WE: 4, TH: 5, FR: 6, SA: 7 };

/** The preset day code of a cron day number, or `null` for one the scheduler does not take. */
export function cronWeekdayCode(number: number): string | null {
  return Object.keys(CRON_WEEKDAYS).find((code) => CRON_WEEKDAYS[code] === number) ?? null;
}

export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "cron") {
    const cron = schedule.cron?.trim() ?? "";
    const everyMinutes = cron.match(/^\*\/(\d+) \* \* \* \*$/);
    if (everyMinutes) return `Every ${everyMinutes[1]} minutes`;
    const hourly = cron.match(/^(\d{1,2}) \* \* \* \*$/);
    if (hourly) return `Every hour at :${hourly[1].padStart(2, "0")}`;
    return "Custom schedule";
  }

  switch (schedule.preset) {
    case "hourly":
      return schedule.minute ? `Every hour at :${String(schedule.minute).padStart(2, "0")}` : "Hourly";
    case "daily":
      return `Daily at ${clock(schedule.hour, schedule.minute)}`;
    case "weekdays":
      return `Weekdays at ${clock(schedule.hour, schedule.minute)}`;
    case "weekly": {
      const day = DAYS[schedule.weekdays[0] ?? ""] ?? "Weekly";
      return day === "Weekly" ? `${day} at ${clock(schedule.hour, schedule.minute)}` : `${day}s at ${clock(schedule.hour, schedule.minute)}`;
    }
    default:
      return "Schedule";
  }
}

export function relativeNext(iso: string, now = Date.now()): string {
  const distance = Date.parse(iso) - now;
  if (!Number.isFinite(distance)) return "";
  if (distance <= 30_000) return "now";
  const minutes = Math.ceil(distance / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

export function nextWallTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
}
