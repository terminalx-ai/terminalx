import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { machineConnection, useMachineConnections } from "@/lib/machineConnections";
import { selectCloudWorkspace, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import { machineSectionKey } from "@/types/target";
import type { MachineConnectionState, PairedMachine } from "@/types/machines";
import { MachineIcon, MachineStateMark, machineStateHint, machineStateLabel, useTick } from "./connectionStatus";

/**
 * The sidebar's machines (PRO-345, screen 21.01): one section per paired
 * machine, its header the machine's name with its live state (`Direct`,
 * `Relay`, `Offline · seen 14:02`). Choosing it opens the machine's view.
 * Shown only with Experimental → Machines on; PRO-346 adds its projects and
 * sessions under each header.
 */
export function MachinesSection() {
  const on = useExperimentalSettings()?.machines === true;
  const store = useMachineConnections();
  const sessions = useSessionStore();
  if (!on || !store.machines.length) return null;
  return (
    <div role="group" aria-label="Machines" className="min-w-0" data-testid="machines-section">
      {store.machines.map((machine) => {
        const { state, attachError } = machineConnection(store, machine.machineId);
        return (
          <MachineHeader
            key={machine.machineId}
            machine={machine}
            state={state}
            attachError={attachError}
            selected={sessions.selectedCloudWorkspace === machineSectionKey(machine.machineId)}
          />
        );
      })}
    </div>
  );
}

function MachineHeader({ machine, state, attachError, selected }: { machine: PairedMachine; state: MachineConnectionState; attachError: string | null; selected: boolean }) {
  const now = useTick(state.state === "reconnecting");
  const label = machineStateLabel(state, machine, { seen: true });
  const hint = attachError ? `Could not connect: ${attachError}` : machineStateHint(state, machine.name, now);
  return (
    <section aria-label={machine.name} className="mb-5 min-w-0" data-testid="machine-section" data-machine={machine.machineId} data-state={state.state}>
      <button
        type="button"
        onClick={() => selectCloudWorkspace(machineSectionKey(machine.machineId))}
        aria-current={selected ? "page" : undefined}
        title={hint}
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          selected ? "bg-selected" : "hover:bg-selected/40",
        )}
      >
        <MachineIcon machine={machine} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{machine.name}</span>
        <MachineStateMark state={state} className="ml-0.5" />
        <span className="min-w-0 shrink truncate text-[12px] text-faint" data-testid="machine-state-label">
          {label}
        </span>
      </button>
      {attachError && (
        <p className="truncate px-2 pt-0.5 text-[12px] text-destructive" role="alert" title={attachError}>
          Could not connect: {attachError}
        </p>
      )}
    </section>
  );
}
