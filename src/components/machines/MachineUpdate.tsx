import { useState } from "react";
import { Loader2, Package } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { featureList } from "@/lib/machineFeatures";
import {
  confirmedRequest,
  loadMachineUpdate,
  needsConfirmation,
  requestMachineUpdate,
  updateTarget,
  useMachineUpdate,
  type MachineUpdateEntry,
  type MachineVersionView,
} from "@/lib/machineUpdate";
import { checkForUpdate, getUpdateState, installUpdate, useUpdate, type UpdateState } from "@/lib/updates";
import type { MachineUpdateProgress, MachineUpdateStatus } from "@/types/machines";
import { sectionLabel } from "./machineText";

/**
 * Updating a machine, or this Mac, from the machine's card and page
 * (PRO-354, screens 21.02 and 21.10). Which side updates comes from the
 * connection (`needsUpdate.side`) or the versions: the machine's own
 * `machine.update` (a headless machine updates itself, an app machine asks
 * its window to), or this Mac's updater.
 */

/** "Downloading 0.2.34", "Handing over to 0.2.34", … while a machine updates; null when nothing runs. */
export function progressText(progress: MachineUpdateProgress): string | null {
  switch (progress.phase) {
    case "downloading":
      return `Downloading TerminalX ${progress.version}`;
    case "verifying":
      return `Checking TerminalX ${progress.version}`;
    case "trial":
      return `Trying TerminalX ${progress.version}`;
    case "handingOver":
      return `Handing over to TerminalX ${progress.version}`;
    case "cleaningUp":
      return `Updated to ${progress.version}, cleaning up`;
    case "appUpdating":
      return progress.step ? `Its app is updating: ${progress.step}` : "Its app is updating";
    default:
      return null;
  }
}

/** This Mac's updater, as one line, while it is doing something the reader asked for. */
export function thisMacUpdateText(state: UpdateState): string | null {
  switch (state.kind) {
    case "checking":
      return "Checking for an update…";
    case "none":
      return "This Mac runs the newest TerminalX it can get.";
    case "installing":
      return `Installing TerminalX ${state.version}${state.pct ? ` · ${state.pct}%` : ""}`;
    case "choosing":
      return "Choose when to update in the update card.";
    case "error":
      return state.message;
    default:
      return null;
  }
}

export interface UpdateAction {
  /** "Update", "Update dev-server", "Update this Mac". */
  label: string;
  /** False when nothing can be done from here; `note` says why. */
  available: boolean;
  busy: boolean;
  /** A line under the action: progress, a refusal, or how to update it instead. */
  note: string | null;
  run: () => void;
  /** The confirmation, rendered beside the button. */
  dialog: React.ReactNode;
}

/**
 * The Update action for a machine's version view: the machine's own update
 * (with a confirmation listing what stops and who else is connected), or
 * this Mac's when the machine is the newer one.
 */
export function useUpdateAction(machineId: string, view: MachineVersionView, options: { long?: boolean } = {}): UpdateAction {
  const name = view.machine?.name ?? "this machine";
  const entry = useMachineUpdate(machineId, view.client);
  const thisMac = useUpdate().state;
  const [confirming, setConfirming] = useState<{ version: string; status: MachineUpdateStatus } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const side = view.gap?.side ?? (view.newer ? "thisMac" : "machine");

  if (side === "thisMac") {
    const busy = thisMac.kind === "checking" || thisMac.kind === "installing";
    return {
      label: "Update this Mac",
      available: true,
      busy,
      note: thisMacUpdateText(thisMac),
      dialog: null,
      run: () =>
        void (async () => {
          const state = getUpdateState().kind === "available" ? getUpdateState() : await checkForUpdate();
          if (state.kind === "available") await installUpdate();
        })(),
    };
  }

  const granted = view.granted?.includes("machine/3") ?? false;
  const status = entry.status;
  const running = status ? progressText(status.progress) : null;
  const label = options.long ? `Update ${name}` : "Update";
  if (!view.client || !granted) {
    return { label, available: false, busy: false, note: `${name} runs a TerminalX this Mac cannot update. Update it on ${name}.`, dialog: null, run: () => undefined };
  }
  if (status?.method === "unmanaged") {
    return { label, available: false, busy: false, note: `TerminalX on ${name} was not installed by TerminalX. Update it the way it was installed.`, dialog: null, run: () => undefined };
  }
  const client = view.client;
  const send = async (version: string, confirmed: MachineUpdateStatus | null) => {
    setNote(null);
    const outcome = await requestMachineUpdate(machineId, client, confirmed ? confirmedRequest(version, confirmed) : { version }, name);
    if (outcome.kind === "confirm") setConfirming({ version, status: outcome.status });
    else if (outcome.kind === "failed") setNote(outcome.message);
  };
  const run = () =>
    void (async () => {
      setNote(null);
      const fresh = (await loadMachineUpdate(machineId, client, true)) ?? status;
      const version = updateTarget(fresh, view.ours);
      if (!version) return setNote(`There is no newer TerminalX for ${name} yet.`);
      if (needsConfirmation(fresh) && fresh) return setConfirming({ version, status: fresh });
      await send(version, null);
    })();
  const failed = status?.progress.phase === "failed" ? status.progress : null;
  const failure = failed ? `The update to ${failed.version} did not finish: ${failed.message}. ${name} runs ${failed.running}${failed.rolledBack ? " again" : ""}.` : null;
  return {
    label,
    available: true,
    busy: entry.requesting || entry.loading || !!running,
    note: running ?? note ?? entry.error ?? failure,
    run,
    dialog: confirming ? (
      <MachineUpdateConfirm
        name={name}
        version={confirming.version}
        status={confirming.status}
        busy={entry.requesting}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const { version, status: confirmed } = confirming;
          setConfirming(null);
          void send(version, confirmed);
        }}
      />
    ) : null,
  };
}

/** The Update button and what goes with it: its confirmation, and a busy spinner. */
export function UpdateButton({ action, className, variant = "default" }: { action: UpdateAction; className?: string; variant?: "default" | "outline" }) {
  if (!action.available) return null;
  return (
    <>
      <Button size="sm" variant={variant} className={cn("shrink-0", className)} disabled={action.busy} onClick={action.run} data-testid="machine-update-button">
        {action.busy ? <Loader2 className="animate-spin" /> : null}
        {action.label}
      </Button>
      {action.dialog}
    </>
  );
}

/**
 * Before `machine.update`: what the handover cannot carry (it stops), and the
 * other computers connected now (they lose the machine for under a minute).
 */
export function MachineUpdateConfirm({
  name,
  version,
  status,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  version: string;
  status: MachineUpdateStatus;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent width="max-w-[480px]" data-testid="machine-update-confirm">
        <DialogTitle className="text-[15px] font-semibold leading-6">Update {name} to TerminalX {version}?</DialogTitle>
        <DialogDescription className="mt-1 text-[12.5px] leading-[19px] text-muted-foreground">
          Running sessions and terminals carry over to the new version. {name} is back in under a minute.
        </DialogDescription>
        {status.blockers.length > 0 && (
          <section className="mt-4 grid gap-1.5" aria-label="These stop">
            <div className={sectionLabel}>These stop</div>
            <ul className="grid gap-1 text-[13px]" data-testid="machine-update-blockers">
              {status.blockers.map((blocker) => (
                <li key={blocker.id}>{blocker.title}</li>
              ))}
            </ul>
          </section>
        )}
        {status.otherComputers.length > 0 && (
          <section className="mt-4 grid gap-1.5" aria-label="Also connected">
            <div className={sectionLabel}>Also connected</div>
            <ul className="grid gap-1 text-[13px]" data-testid="machine-update-others">
              {status.otherComputers.map((computer) => (
                <li key={computer.id}>{computer.label}</li>
              ))}
            </ul>
            <p className="text-[12.5px] text-muted-foreground">They lose {name} while it updates, and reconnect by themselves.</p>
          </section>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="accent" disabled={busy} onClick={onConfirm}>
            {status.blockers.length ? `Stop ${status.blockers.length === 1 ? "it" : "them"} and update` : "Update"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Port forwarding and orchestration runs are hidden for this machine until it is updated." */
function bannerText(view: MachineVersionView): string {
  const gap = view.gap;
  if (!gap) return "Nothing is hidden. Update this Mac to use what is new there.";
  if (gap.hidden.length) {
    const hidden = `${featureList(gap.hidden)} ${gap.hidden.length === 1 ? "is" : "are"} hidden for this machine until ${gap.side === "thisMac" ? "this Mac" : "it"} is updated.`;
    return gap.side === "thisMac" ? hidden : `${hidden} Running sessions keep going through the update.`;
  }
  return gap.side === "thisMac" ? "This Mac is too old to operate it. Update this Mac to connect." : "It is too old to be operated from this Mac. Running sessions keep going through the update.";
}

/** "TerminalX 0.2.29 there, 0.2.33 here". */
export function versionsText(view: MachineVersionView): string {
  const there = view.version ? `TerminalX ${view.version} there` : "An older TerminalX there";
  return view.ours ? `${there}, ${view.ours} here` : there;
}

/** The machine page's version section (21.10): both versions, what is hidden, and Update. */
export function MachineVersionBanner({ machineId, view }: { machineId: string; view: MachineVersionView }) {
  const action = useUpdateAction(machineId, view, { long: true });
  if (!view.gap && !view.newer) return null;
  return (
    <section className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3" data-testid="machine-version-banner" data-side={view.gap?.side ?? "thisMac"}>
      <div className="flex items-center gap-3">
        <Package className="size-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1 leading-5">
          <div className="text-[13px] font-medium">{versionsText(view)}</div>
          <p className="text-[12.5px] leading-[19px] text-muted-foreground">{bannerText(view)}</p>
          {view.gap && view.gap.hidden.length > 0 && (
            <ul className="sr-only" aria-label="Hidden until updated" data-testid="machine-hidden-features">
              {view.gap.hidden.map((feature) => (
                <li key={feature.id}>{feature.label}</li>
              ))}
            </ul>
          )}
        </div>
        <UpdateButton action={action} />
      </div>
      {action.note && (
        <p role="status" className="mt-2 pl-7 text-[12.5px] text-muted-foreground" data-testid="machine-update-note">
          {action.note}
        </p>
      )}
    </section>
  );
}

/** The entry for tests: what the store holds for a machine. */
export type { MachineUpdateEntry };
