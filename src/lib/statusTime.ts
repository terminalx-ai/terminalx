import { useEffect, useState } from "react";

const MINUTE = 60_000;

export function formatResetCountdown(resetsAt: number | null, now: number, fallback: string): string {
  if (resetsAt == null) return fallback;
  const remaining = resetsAt - now;
  if (remaining <= 0) return "now";
  if (remaining < MINUTE) return "<1m";
  const minutes = Math.floor(remaining / MINUTE);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function nextCountdownDelay(resets: Array<number | null>, now: number): number | null {
  let next: number | null = null;
  for (const reset of resets) {
    if (reset == null || reset <= now) continue;
    const remaining = reset - now;
    const delay = remaining < MINUTE ? remaining + 1 : (remaining % MINUTE || MINUTE) + 1;
    next = next == null ? delay : Math.min(next, delay);
  }
  return next;
}

/** One timer for every countdown in the bar, scheduled to the next label boundary. */
export function useCountdownNow(resets: Array<number | null>): number {
  const [now, setNow] = useState(Date.now);
  const key = resets.join(",");
  useEffect(() => {
    const current = Date.now();
    const delay = nextCountdownDelay(resets, current);
    if (delay == null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
    // A primitive key avoids a new array retriggering the effect on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, now]);
  return now;
}
