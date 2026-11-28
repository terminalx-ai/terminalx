const TIME_OF_DAY_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Minutes after local midnight as the phone writes a time of day, e.g. "10:00 PM". */
export function timeOfDay(minutes: number): string {
  const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return TIME_OF_DAY_FMT.format(date);
}

/** Quiet hours as the page's row says them: "10:00 PM to 7:00 AM". */
export function quietSpan(start: number, end: number): string {
  return `${timeOfDay(start)} to ${timeOfDay(end)}`;
}

/** The times offered for quiet hours: every quarter hour of the day. */
export const QUARTER_HOURS: number[] = Array.from({ length: 96 }, (_, index) => index * 15);
