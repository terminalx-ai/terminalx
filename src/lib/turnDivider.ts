import { messageTime } from "@terminalx/portable/transcript";
import type { Turn } from "@/lib/transcript";

/** A pause this long between two turns earns a time line between them. */
export const DIVIDER_GAP_MS = 30 * 60 * 1000;

/** When the reader sent the turn's prompt, if that is known (legacy imports carry no such time). */
function sentAt(turn: Turn): number | null {
  const time = messageTime(turn.prompt?.messageTs);
  return time ? Date.parse(time.iso) : null;
}

/** The last moment a turn is known to have been active: its answer, else its prompt. */
function lastActive(turn: Turn): number | null {
  for (let i = turn.work.length - 1; i >= 0; i--) {
    const item = turn.work[i];
    if ("messageTs" in item) {
      const time = messageTime(item.messageTs);
      if (time) return Date.parse(time.iso);
    }
  }
  return sentAt(turn);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The time line drawn above `turn`, or null. The first turn gets one, as
 * does a turn sent on another day than the one before it or after a long
 * pause, so a long session reads as sittings rather than a wall of times.
 * Without a known send time there is nothing true to say: no line.
 */
export function turnDivider(prev: Turn | undefined, turn: Turn, now = new Date(), locales?: string): string | null {
  const sent = sentAt(turn);
  if (sent == null) return null;
  const before = prev ? lastActive(prev) : null;
  if (prev && before != null && sent - before < DIVIDER_GAP_MS && sameDay(new Date(before), new Date(sent))) return null;
  return dividerLabel(new Date(sent), now, locales);
}

/** "Today, 10:54 PM", "Yesterday, …", "Friday, …" within the week, then "Oct 26, …" (with the year when it is not this one). */
export function dividerLabel(at: Date, now = new Date(), locales?: string): string {
  const time = new Intl.DateTimeFormat(locales, { timeStyle: "short" }).format(at);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 6);
  weekAgo.setHours(0, 0, 0, 0);
  let day: string;
  if (sameDay(at, now)) day = "Today";
  else if (sameDay(at, yesterday)) day = "Yesterday";
  else if (at >= weekAgo && at <= now) day = new Intl.DateTimeFormat(locales, { weekday: "long" }).format(at);
  else day = new Intl.DateTimeFormat(locales, at.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(at);
  return `${day}, ${time}`;
}
