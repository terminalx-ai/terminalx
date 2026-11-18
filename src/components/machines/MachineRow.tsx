import { ChevronRight } from "@/icons";
import { cn } from "@/lib/cn";
import { useMachineVersion, type MachineVersionView } from "@/lib/machineUpdate";
import type { PairedMachine } from "@/types/machines";
import { MachineIcon, MachineStateMark, machineTone, toneText } from "./connectionStatus";
import { pageStateLabel } from "./MachinePage";
import { UpdateButton, useUpdateAction } from "./MachineUpdate";
import { machineSummary, shortDate } from "./machineText";

const row = "flex min-h-14 items-center gap-3 border-b border-hairline px-4 py-2 last:border-b-0";

/** "TerminalX 0.2.27 · some features are hidden until it is updated" (21.02). */
export function needsUpdateLine(view: MachineVersionView): string {
  const version = view.gap?.version ?? view.version;
  const runs = version ? `TerminalX ${version}` : "An older TerminalX";
  if (view.gap?.side === "thisMac") return `${runs} · this Mac needs an update to use all of it`;
  return view.gap?.hidden.length ? `${runs} · some features are hidden until it is updated` : `${runs} · it needs an update before this Mac can operate it`;
}

/**
 * One of Your machines in Settings → Machines (21.02): its state beside the
 * name, "Needs update" with Update when anything it uses is missing, and the
 * way to its page.
 */
export function MachineRow({ machine, onOpen }: { machine: PairedMachine; onOpen: (machineId: string) => void }) {
  const view = useMachineVersion(machine.machineId);
  const action = useUpdateAction(machine.machineId, view);
  const needsUpdate = !!view.gap;
  const tone = machineTone(view.shownState);
  return (
    <li className={row} data-testid="paired-machine" data-needs-update={needsUpdate || undefined}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-well">
        <MachineIcon machine={machine} className="size-4 text-muted-foreground" />
      </span>
      <button type="button" className="min-w-0 flex-1 text-left leading-5" onClick={() => onOpen(machine.machineId)} aria-label={`Open ${machine.name}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] text-foreground">{machine.name}</span>
          {needsUpdate ? (
            <span className="shrink-0 rounded bg-warning/15 px-1.5 text-[12px] font-medium text-warning" data-testid="machine-needs-update">
              Needs update
            </span>
          ) : view.state.state !== "idle" ? (
            <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px]", toneText(tone))}>
              <MachineStateMark state={view.shownState} />
              {pageStateLabel(view)}
            </span>
          ) : null}
        </div>
        <div className="truncate text-[12px] text-muted-foreground" data-testid="paired-machine-line">
          {needsUpdate
            ? needsUpdateLine(view)
            : `${machineSummary(machine.os, view.version ?? machine.version)} · ${machine.route === "thisNetwork" ? "Only this network" : "Relay and nearby"} · paired ${shortDate(machine.pairedAt)}`}
        </div>
        {needsUpdate && action.note && <div className="truncate text-[12px] text-muted-foreground">{action.note}</div>}
      </button>
      {needsUpdate ? (
        <UpdateButton action={action} variant="outline" />
      ) : (
        <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
      )}
    </li>
  );
}
