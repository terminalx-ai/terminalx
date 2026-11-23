import { useEffect, useState } from "react";

/**
 * Milliseconds left until `until`, read again every second while any are
 * left. Zero once it has passed, and when there is nothing to wait for.
 */
export function useRemaining(until: number | null | undefined): number {
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    if (until == null) return;
    const read = () => setAt(Date.now());
    // A new deadline is measured from now, not from the last tick of the one before it.
    const first = setTimeout(read, 0);
    const timer = setInterval(() => { read(); if (Date.now() >= until) clearInterval(timer); }, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [until]);
  return until == null ? 0 : Math.max(0, until - at);
}

/** Time left as the boards write it: 4:38, 14:52, 0:07. */
export function clockText(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
