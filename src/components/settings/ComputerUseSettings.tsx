import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/ui/controls";
import { api, errorMessage, type ComputerPermissionId, type ComputerPermissionStatus } from "@/lib/api";

const COMPUTER_PERMISSIONS: { id: ComputerPermissionId; label: string; description: string }[] = [
  {
    id: "accessibility",
    label: "Accessibility",
    description: "Lets agents read app windows as accessibility trees and press, type, scroll, and drag in them.",
  },
  {
    id: "screenshots",
    label: "Screen Recording",
    description: "Lets agents capture a screenshot of the window they are working in.",
  },
];

/**
 * Computer use permissions belong to the bundled "TerminalX Computer Use"
 * helper app, not to TerminalX itself, so an agent shell needs no grants of
 * its own. Each Grant button opens the macOS prompt through that helper; the
 * status re-polls while a prompt is open so the row flips without a restart.
 */
export function ComputerUseRows() {
  const [status, setStatus] = useState<ComputerPermissionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ComputerPermissionId | "reset" | null>(null);
  const [polling, setPolling] = useState(false);
  const refresh = async () => {
    try {
      const next = await api.computerPermissionStatus();
      setStatus(next);
      setError(null);
      return next;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!polling) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      const next = await refresh();
      const done = next?.permissions.every((p) => p.status === "granted") ?? false;
      if (done || Date.now() - started > 5 * 60_000) setPolling(false);
    }, 2000);
    return () => clearInterval(timer);
  }, [polling]);
  const grant = async (id: ComputerPermissionId) => {
    setBusy(id);
    setError(null);
    try {
      await api.computerOpenPermission(id);
      setPolling(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    setBusy("reset");
    setError(null);
    try {
      setStatus(await api.computerResetPermissions());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  if (status && status.platform !== "macos") return null;
  const unavailable = status?.helperUnavailableReason ?? null;
  const allGranted = status?.permissions.every((p) => p.status === "granted") ?? false;
  return (
    <div className="flex flex-col" data-testid="computer-use-settings">
      <SettingRow
        label="Computer use"
        stacked
        description={
          unavailable
            ? `The TerminalX Computer Use helper app is missing (${unavailable}). Reinstall TerminalX to restore desktop automation for agents.`
            : "Agents drive desktop apps through terminalx computer … using the bundled TerminalX Computer Use helper, which holds these permissions so shells never need them."
        }
        control={
          !unavailable && status ? (
            <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void reset()}>
              {busy === "reset" ? <Loader2 className="animate-spin" /> : null}
              Reset permissions
            </Button>
          ) : null
        }
      />
      {!unavailable &&
        COMPUTER_PERMISSIONS.map((permission) => {
          const state = status?.permissions.find((p) => p.id === permission.id)?.status ?? null;
          const granted = state === "granted";
          return (
            <div key={permission.id} className="ml-3 flex items-center justify-between gap-4 border-l border-hairline py-1.5 pl-3">
              <div className="min-w-0">
                <div className="text-[13px]">{permission.label}</div>
                <div className="text-xs leading-relaxed text-muted-foreground">{permission.description}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={granted || busy !== null || !status}
                onClick={() => void grant(permission.id)}
                aria-label={granted ? `${permission.label} granted` : `Grant ${permission.label}`}
              >
                {busy === permission.id ? <Loader2 className="animate-spin" /> : granted ? <Check /> : null}
                {granted ? "Granted" : state === null ? "Checking…" : "Grant…"}
              </Button>
            </div>
          );
        })}
      {polling && !allGranted && (
        <div className="ml-6 mt-1 text-xs text-muted-foreground">Waiting for the macOS prompt… allow "TerminalX Computer Use" in System Settings.</div>
      )}
      {error && <div className="mt-1 text-xs text-destructive">{error}</div>}
    </div>
  );
}
