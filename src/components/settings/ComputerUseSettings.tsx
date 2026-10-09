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

const LEGACY_ACK_KEY = "terminalx.computerUse.legacyHelperRemoved";

function legacyAcknowledged() {
  try {
    return globalThis.localStorage?.getItem(LEGACY_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Computer use permissions belong to the bundled "TerminalX Computer Use"
 * helper app, not to TerminalX itself, so an agent shell needs no grants of
 * its own. Each Grant button opens the macOS prompt through that helper; the
 * status re-polls while a prompt is open so the row flips without a restart.
 */
export function ComputerUseRows() {
  const [status, setStatus] = useState<ComputerPermissionStatus | null>(null);
  const [preconditions, setPreconditions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ComputerPermissionId | "reset" | null>(null);
  const [polling, setPolling] = useState(false);
  const [legacyAck, setLegacyAck] = useState(legacyAcknowledged);
  const refresh = async () => {
    try {
      const next = await api.computerPermissionStatus();
      if (next.platform !== "macos") {
        const setup = await api.computerOpenPermission(null);
        setPreconditions(setup.nextStep?.split("\n") ?? []);
      }
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
  if (status && status.platform !== "macos") return (
    <div className="flex flex-col" data-testid="computer-use-settings">
      <SettingRow label="Computer use" stacked description="Desktop requirements for agents on this platform." control={null} />
      <ul className="ml-6 list-disc space-y-1 text-xs leading-relaxed text-muted-foreground">
        {preconditions.map((item) => <li key={item}>{item}</li>)}
      </ul>
      {error && <div className="mt-1 text-xs text-destructive">{error}</div>}
    </div>
  );
  const unavailable = status?.helperUnavailableReason ?? null;
  const allGranted = status?.permissions.every((p) => p.status === "granted") ?? false;
  // Helpers from older versions trust whoever starts them (PRO-90). This
  // version's helper is a new app to macOS, so people are asked again, and an
  // old one that keeps its permission stays usable by any program: say both.
  const legacy = !unavailable ? status?.legacyHelper ?? null : null;
  const askedAgain = Boolean(legacy) && !allGranted;
  const removeOld = Boolean(legacy) && !legacy?.removed && !legacyAck;
  const acknowledgeLegacy = () => {
    try {
      globalThis.localStorage?.setItem(LEGACY_ACK_KEY, "1");
    } catch {
      // Private storage is a convenience; the notice simply shows again.
    }
    setLegacyAck(true);
  };
  return (
    <div className="flex flex-col" data-testid="computer-use-settings">
      <SettingRow
        label="Computer use"
        stacked
        description={
          unavailable
            ? `The TerminalX Computer Use helper app is missing (${unavailable}). Reinstall TerminalX to restore desktop automation for agents.`
            : "Agents drive desktop apps through terminalx computer … using the bundled TerminalX Computer Use helper, which holds these permissions so shells never need them. TerminalX itself should not be listed under Accessibility or Screen Recording in System Settings: remove it if it is, or every program an agent runs has those permissions too."
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
      {(askedAgain || removeOld) && (
        <div className="ml-3 mt-1 rounded-md border border-hairline bg-well px-3 py-2 text-xs leading-relaxed text-muted-foreground" role="note" data-testid="computer-use-upgrade-note">
          {askedAgain && (
            <p>
              <span className="font-medium text-foreground">Updated for security: grant once more.</span> The Computer Use helper was replaced by one that only answers TerminalX itself and never operates or reads TerminalX's own windows. macOS treats it as a new app, so Accessibility and Screen Recording need to be granted to it again.
              {legacy?.removed ? " The older helper's permissions have been removed." : ""}
            </p>
          )}
          {removeOld && (
            <>
              <p className={askedAgain ? "mt-1.5" : undefined}>
                <span className="font-medium text-foreground">Remove the older helper.</span> If you used computer use with an earlier TerminalX, macOS may still list that helper, and TerminalX could not remove it for you. Open System Settings → Privacy & Security, and under both Accessibility and Screen Recording remove every "TerminalX Computer Use" entry with the − button, then use Grant… here. While an older helper keeps its permission, any program on this Mac can use it to press TerminalX's buttons.
              </p>
              <Button className="mt-2" size="xs" variant="outline" onClick={acknowledgeLegacy}>
                I have removed it
              </Button>
            </>
          )}
        </div>
      )}
      {polling && !allGranted && (
        <div className="ml-6 mt-1 text-xs text-muted-foreground">Waiting for the macOS prompt… allow "TerminalX Computer Use" in System Settings.</div>
      )}
      {error && <div className="mt-1 text-xs text-destructive">{error}</div>}
    </div>
  );
}
