import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { errorMessage, localRuntime, type LocalRuntimeState } from "@/lib/api";
import { checkpointDraftsForRecovery } from "@/lib/drafts";
import { RECOVERY_DELAYS, recoveryAttempts, recordRecoveryAttempt } from "@/lib/localRuntimeRecovery";
import { getSessionStore } from "@/lib/sessions";
import { cloudDraftsReadyForRecovery } from "@/lib/cloudAgents";

const reloadWindow = () => window.location.reload();

/** Recover readers only: connection health never implies an agent stopped. */
export function LocalRuntimeNotice({ reload = reloadWindow }: { reload?: () => void }) {
  const [state, setState] = useState<LocalRuntimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const reconnect = useRef(() => {});
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    let cancelled = false;
    let reloaded = false;
    let revision = 0;
    let running = false;
    let pending = false;
    let pendingRetry = false;
    let reloadRequired = false;
    let attempts = recoveryAttempts();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten: (() => void)[] = [];
    const recovered = () => {
      if (cancelled || reloaded) return;
      const local = getSessionStore();
      // On a fresh document, wait for the authoritative local index rather
      // than treating unknown (possibly restored) drafts as local or empty.
      if (!local.loaded) throw new Error("Waiting for local sessions before restoring live views. Unsent drafts have been kept.");
      if (!cloudDraftsReadyForRecovery()) throw new Error("Waiting for cloud drafts to be saved before restoring live views. Unsent text has been kept in this window.");
      checkpointDraftsForRecovery(local.sessions.flatMap((session) => session.tabs.map((tab) => tab.id)));
      reloaded = true;
      clearTimeout(timer);
      setState(null);
      setBusy(false);
      reloadRef.current();
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(attempts < RECOVERY_DELAYS.length), RECOVERY_DELAYS[attempts] ?? 5_000);
    };
    async function check(retry = false) {
      if (cancelled || reloaded) return;
      if (running) {
        pending = true;
        pendingRetry ||= retry;
        if (retry) setBusy(true);
        return;
      }
      clearTimeout(timer);
      running = true;
      const requested = revision;
      try {
        // Events are hints, not authoritative state: a queued old disconnect
        // or another window's failed view must not mark this window offline.
        const found: LocalRuntimeState = await localRuntime.status().catch((error: unknown) => ({
          state: "unavailable" as const, message: errorMessage(error),
        }));
        if (cancelled || reloaded) return;
        if (requested !== revision) { pendingRetry ||= retry; return; }
        setState(found);
        if (found.state !== "unavailable") {
          if (reloadRequired && found.state === "connected") recovered();
          return;
        }
        if (retry) {
          attempts = recordRecoveryAttempt();
          setBusy(true);
          const attached = await localRuntime.reconnect();
          if (cancelled || reloaded) return;
          if (attached.state === "connected") {
            // Reader release is an instruction to rebuild taps, not proof of
            // replacement health. Check again, including any newer disconnect.
            reloadRequired = true;
            pending = true;
            return;
          }
          if (requested !== revision) return;
          setState(attached.state === "unavailable" ? attached : { state: "unavailable", message: "The background runtime is not available. Reopen TerminalX to try again." });
        }
        schedule();
      } catch (error) {
        if (!cancelled && !reloaded && requested === revision) {
          setState({ state: "unavailable", message: errorMessage(error) });
          schedule();
        }
      } finally {
        running = false;
        if (!cancelled && !reloaded) setBusy(false);
        if (pending) {
          const retryNext = pendingRetry;
          pending = false;
          pendingRetry = false;
          void check(retryNext);
        }
      }
    }
    // Manual recovery grants one attempt, without replenishing the auto budget.
    reconnect.current = () => { void check(true); };
    const disconnected = () => {
      revision++;
      void check();
    };
    const reattached = () => {
      reloadRequired = true;
      disconnected();
    };
    void (async () => {
      for (const event of ["local_runtime_disconnected", "local_runtime_view_disconnected", "local_runtime_reattached"]) {
        const stop = await listen(event, event === "local_runtime_reattached" ? reattached : disconnected);
        if (cancelled) { stop(); return; }
        unlisten.push(stop);
      }
      await check();
    })().catch((error: unknown) => {
      if (!cancelled) setState({ state: "unavailable", message: errorMessage(error) });
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unlisten.forEach((stop) => stop());
      reconnect.current = () => {};
    };
  }, []);

  if (state?.state !== "unavailable") return null;
  return (
    <aside aria-label="Local runtime connection" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">Live connection unavailable</div>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => reconnect.current()}>{busy ? "Reconnecting…" : "Reconnect"}</Button>
    </aside>
  );
}
