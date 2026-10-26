import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { errorMessage, localRuntime, type LocalRuntimeState } from "@/lib/api";

const reloadWindow = () => window.location.reload();
const RETRY_DELAYS = [250, 500, 1000, 2000];

/** Connection state is separate from session state: losing a view says nothing
 * about whether its agent stopped. Retry the view attachment, never its input. */
export function LocalRuntimeNotice({ reload = reloadWindow }: { reload?: () => void }) {
  const [state, setState] = useState<LocalRuntimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const revision = useRef(0);
  const reloaded = useRef(false);
  const retry = useRef(() => {});
  const reloadOnce = useRef(() => {});
  reloadOnce.current = () => {
    if (reloaded.current) return;
    reloaded.current = true;
    reload();
  };

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let exhausted = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten: (() => void)[] = [];
    const attached = () => {
      if (cancelled) return;
      clearTimeout(timer);
      reloadOnce.current();
    };
    const attempt = async () => {
      if (cancelled || reloaded.current) return;
      attempts++;
      let found: LocalRuntimeState;
      try {
        found = await localRuntime.reconnect();
      } catch (error) {
        found = { state: "unavailable", message: errorMessage(error) };
      }
      if (cancelled || reloaded.current) return;
      if (found.state === "connected") { attached(); return; }
      setState(found.state === "unavailable" ? found : { state: "unavailable", message: "The background runtime is not available. Reopen TerminalX to try again." });
      const delay = RETRY_DELAYS[attempts - 1];
      if (delay !== undefined) {
        timer = setTimeout(() => void attempt(), delay);
      } else {
        running = false;
        exhausted = true;
        setBusy(false);
        setShowRecovery(true);
      }
    };
    const reconnect = () => {
      if (cancelled || running || reloaded.current) return;
      running = true;
      exhausted = false;
      attempts = 0;
      revision.current++;
      setBusy(true);
      void attempt();
    };
    retry.current = reconnect;
    const disconnected = () => {
      revision.current++;
      if (!cancelled && !running && !exhausted) reconnect();
    };
    void (async () => {
      for (const event of ["local_runtime_disconnected", "local_runtime_view_disconnected", "local_runtime_reattached"]) {
        const stop = await listen(event, event === "local_runtime_reattached" ? attached : disconnected);
        if (cancelled) { stop(); return; }
        unlisten.push(stop);
      }
      const requested = revision.current;
      let found: LocalRuntimeState;
      try {
        found = await localRuntime.status();
      } catch (error) {
        found = { state: "unavailable", message: errorMessage(error) };
      }
      if (!cancelled && revision.current === requested) {
        setState(found);
        if (found.state === "unavailable") reconnect();
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        setState({ state: "unavailable", message: errorMessage(error) });
        reconnect();
      }
    });
    return () => { cancelled = true; clearTimeout(timer); unlisten.forEach((stop) => stop()); };
  }, []);

  if (!showRecovery || state?.state !== "unavailable") return null;
  return (
    <aside aria-label="Local runtime connection" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">Live connection unavailable</div>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => retry.current()}>{busy ? "Reconnecting…" : "Reconnect"}</Button>
    </aside>
  );
}
