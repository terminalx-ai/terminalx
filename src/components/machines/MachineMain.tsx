import { useEffect, useState } from "react";
import { PanelLeft, RotateCw } from "@/icons";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { WorkspaceView } from "@/components/cloud/CloudWorkspaceView";
import { workspaceTargetKey } from "@/lib/api";
import { machineConnection, reconnectMachine, useMachineConnections } from "@/lib/machineConnections";
import { parseMachineKey } from "@/types/target";
import { MachineChip, MachineLocation, machineViewStatus } from "./connectionStatus";

/**
 * A paired machine in the main slot (PRO-345, screen 21.08): the header chip
 * with its live state, the strip saying commands run there, and its
 * terminals, agent, files and git over the machine's connection. The sidebar
 * stays beside it.
 */
export function MachineMain({ machineKey, sidebarOpen, onToggleSidebar }: { machineKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const machineId = parseMachineKey(machineKey)?.machineId ?? "";
  const store = useMachineConnections();
  const { machine, state, connection, attachError } = machineConnection(store, machineId);
  const name = machine?.name ?? "Machine";
  const [clientState, setClientState] = useState<WorkspaceConnectionState>({ state: "idle" });
  useEffect(() => {
    if (!connection) return;
    setClientState({ state: "idle" });
    return connection.client.onState(setClientState);
  }, [connection]);

  let body;
  if (connection && machine) {
    body = <WorkspaceView key={workspaceTargetKey(connection.target)} opened={{ connection, name, provider: null, workspaceState: null, machine: { record: machine, status: machineViewStatus(state, name) } }} state={clientState} />;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted-foreground" data-testid="machine-main-empty">
        {!store.ready ? (
          <span>Reading your machines…</span>
        ) : !machine ? (
          <span>This machine is no longer paired with this Mac.</span>
        ) : attachError ? (
          <>
            <span role="alert">
              Could not connect to {name}: {attachError}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void reconnectMachine(machineId)}>
              <RotateCw /> Try again
            </Button>
          </>
        ) : (
          <span>Connecting to {name}…</span>
        )}
      </div>
    );
  }

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip" data-testid="machine-main" data-machine={machineId}>
      <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-hairline px-2" style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}>
        {!sidebarOpen && (
          <WithTooltip label="Show sidebar" shortcut="app.toggleSidebar">
            <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
              <PanelLeft />
            </Button>
          </WithTooltip>
        )}
        <MachineChip machine={machine} name={name} state={state} />
      </header>
      {machine && <MachineLocation machine={machine} name={name} state={state} />}
      {body}
    </main>
  );
}
