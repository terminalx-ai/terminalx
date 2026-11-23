import { useMemo } from "react";
import { WorkspacePlaceProvider, type MachinePlace } from "@/components/cloud/workspacePlace";
import { SessionView } from "@/components/session/SessionView";
import { machineConnection, useMachineConnections } from "@/lib/machineConnections";
import { useMachineSession } from "@/lib/machineSession";
import { parseMachineKey } from "@/types/target";
import { machineViewLabel, machineViewStatus } from "./connectionStatus";

/**
 * A session on a paired machine (`machine:<m>:<p>:<s>`, PRO-347, screens
 * 21.08 and 21.09) in the same SessionView as a local or cloud session, fed
 * by the machine's connection (docs/MACHINES.md decision 1).
 *
 * The session's tabs are the cloud workspace's, so they are told the machine
 * they run on, as the machine's own view tells them (MachineMain): without
 * it the Ports tab and its popover speak of a cloud workspace (PRO-355).
 */
export function MachineSessionHost({ sessionKey, sidebarOpen, onToggleSidebar }: { sessionKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const machine = useMachineSession(sessionKey);
  const { machine: record, state } = machineConnection(useMachineConnections(), parseMachineKey(sessionKey)?.machineId ?? "");
  const name = record?.name ?? "Machine";
  const status = machineViewStatus(state, name);
  const label = machineViewLabel(state);
  const place = useMemo<MachinePlace>(() => ({ name, status, label }), [name, status, label]);
  if (!machine) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">This machine session link is not valid.</div>;
  }
  return <WorkspacePlaceProvider value={place}>
    <SessionView session={machine.session} cloud={machine} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />
  </WorkspacePlaceProvider>;
}
