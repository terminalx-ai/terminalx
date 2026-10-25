import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { errorMessage, localRuntime, type LocalRuntimeState } from "@/lib/api";

const reloadWindow = () => window.location.reload();

/** Connection state is separate from session state: losing a view says nothing
 * about whether its agent stopped. Reattachment is an explicit reader action. */
export function LocalRuntimeNotice({ reload = reloadWindow }: { reload?: () => void }) {
  const [state, setState] = useState<LocalRuntimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const reloaded = useRef(false);
  const reloadOnce = useRef(() => {});
  reloadOnce.current = () => {
    if (reloaded.current) return;
    reloaded.current = true;
    reload();
  };

  useEffect(() => {
    let cancelled = false;
    const unlisten: (() => void)[] = [];
    const disconnected = () => {
      revision.current++;
      if (!cancelled) setState({ state: "unavailable", message: "Live output is disconnected. Agents and terminal commands may still be running." });
    };
    void (async () => {
      for (const event of ["local_runtime_disconnected", "local_runtime_view_disconnected", "local_runtime_reattached"]) {
        const stop = await listen(event, event === "local_runtime_reattached" ? () => { if (!cancelled) reloadOnce.current(); } : disconnected);
        if (cancelled) { stop(); return; }
        unlisten.push(stop);
      }
      const requested = revision.current;
      const found = await localRuntime.status();
      if (!cancelled && revision.current === requested) setState(found);
    })().catch((error: unknown) => {
      if (!cancelled) setState({ state: "unavailable", message: errorMessage(error) });
    });
    return () => { cancelled = true; unlisten.forEach((stop) => stop()); };
  }, []);

  async function reconnect() {
    if (busy) return;
    setBusy(true);
    revision.current++;
    try {
      const found = await localRuntime.reconnect();
      if (found.state === "connected") reloadOnce.current();
      else setState(found.state === "unavailable" ? found : { state: "unavailable", message: "The background runtime is not available. Reopen TerminalX to try again." });
    } catch (error) {
      setState({ state: "unavailable", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  if (state?.state !== "unavailable") return null;
  return (
    <aside aria-label="Local runtime connection" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">Live connection unavailable</div>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void reconnect()}>{busy ? "Reconnecting…" : "Reconnect"}</Button>
    </aside>
  );
}
