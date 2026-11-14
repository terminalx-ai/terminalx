import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { bootLocalRuntime, reconnectLocalRuntime, useLocalRuntime } from "@/lib/localRuntime";

/** A short gap says nothing: most reconnect before anyone would notice. */
export const QUIET_MS = 3_000;
/** Past this a failure is no blip, and asking for an attempt now may help. */
export const STALLED_MS = 2 * 60_000;

/** Connection health only: a gap never means an agent stopped (#643). The
 * desktop reconnects by itself; this says so, and asks for nothing unless
 * retrying cannot help or has not helped for minutes. */
export function LocalRuntimeNotice() {
  const { state, readAt } = useLocalRuntime();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => { void bootLocalRuntime(); }, []);
  const down = state?.state === "connecting" ? state.downMs + Math.max(0, now - readAt) : 0;
  // Shown again as the gap crosses each threshold, without asking again.
  useEffect(() => {
    if (state?.state !== "connecting") return;
    const next = [QUIET_MS, STALLED_MS].find((threshold) => threshold > down);
    if (next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), next - down);
    return () => clearTimeout(timer);
  }, [state, readAt, down]);

  if (state?.state !== "connecting" && state?.state !== "unavailable") return null;
  if (state.state === "connecting" && down < QUIET_MS) return null;
  const retry = async () => {
    setBusy(true);
    try { await reconnectLocalRuntime(); } finally { setBusy(false); }
  };
  const reconnecting = state.state === "connecting" && down < STALLED_MS
    ? `${state.terminal ? "Reconnecting terminal output" : "Reconnecting"}… (attempt ${state.attempt})`
    : null;
  return (
    <aside aria-label="Local runtime connection" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">{reconnecting ?? "Live connection unavailable"}</div>
        <p className="mt-1 text-muted-foreground">{reconnecting ? "Agents and terminal commands keep running." : state.message}</p>
      </div>
      {!reconnecting && <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>{busy ? "Reconnecting…" : "Try again"}</Button>}
    </aside>
  );
}
