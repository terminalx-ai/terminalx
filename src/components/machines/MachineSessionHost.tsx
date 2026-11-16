import { SessionView } from "@/components/session/SessionView";
import { useMachineSession } from "@/lib/machineSession";

/**
 * A session on a paired machine (`machine:<m>:<p>:<s>`, PRO-347, screens
 * 21.08 and 21.09) in the same SessionView as a local or cloud session, fed
 * by the machine's connection (docs/MACHINES.md decision 1).
 */
export function MachineSessionHost({ sessionKey, sidebarOpen, onToggleSidebar }: { sessionKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const machine = useMachineSession(sessionKey);
  if (!machine) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">This machine session link is not valid.</div>;
  }
  return <SessionView session={machine.session} cloud={machine} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />;
}
