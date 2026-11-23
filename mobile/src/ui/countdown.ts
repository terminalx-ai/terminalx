import { useEffect, useRef, useState } from "react";

/**
 * Milliseconds left until `until`, read again every second while any are
 * left. Zero once it has passed, and when there is nothing to wait for.
 *
 * `now` is the clock the deadline was set on. A deadline the server set is
 * measured on the server's clock (the cloud client's `serverNow`), never the
 * phone's own: a phone that runs fast or slow would otherwise end it early
 * or keep it past its end.
 */
export function useRemaining(until: number | null | undefined, now: () => number = Date.now): number {
  const [at, setAt] = useState(() => now());
  const clock = useRef(now);
  useEffect(() => { clock.current = now; });
  useEffect(() => {
    if (until == null) return;
    const read = () => { const time = clock.current(); setAt(time); return time; };
    // A new deadline is measured from now, not from the last tick of the one before it.
    const first = setTimeout(read, 0);
    const timer = setInterval(() => { if (read() >= until) clearInterval(timer); }, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [until]);
  return until == null ? 0 : Math.max(0, until - at);
}

/** Time left as the boards write it: 4:38, 14:52, 0:07. */
export function clockText(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
