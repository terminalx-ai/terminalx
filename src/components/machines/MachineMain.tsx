import { useEffect, useMemo, useState } from "react";
import { PanelLeft, RotateCw } from "@/icons";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { WorkspaceView } from "@/components/cloud/CloudWorkspaceView";
import { workspaceTargetKey } from "@/lib/api";
import { machineConnection, reconnectMachine, useMachineConnections } from "@/lib/machineConnections";
import { machineSessionTab, useMachineProjects } from "@/lib/machineCatalog";
import type { AgentFocus, AgentProjects } from "@/components/cloud/CloudAgents";
import { selectCloudSession } from "@/lib/sessions";
import { takeMachineNewSession, useMachineNewSession } from "./machineNewSession";
import { machineVersionView, useThisVersion } from "@/lib/machineUpdate";
import { machineSessionKey, parseMachineKey } from "@/types/target";
import { MachineChip, MachineLocation, machineViewLabel, machineViewStatus } from "./connectionStatus";
import { MachineHiddenFeatures } from "./MachineFeatureNotice";
import { openMachinePage } from "@/lib/machinePage";

/**
 * A paired machine in the main slot (PRO-345, screen 21.08): the header chip
 * with its live state, the strip saying commands run there, and its
 * terminals, agent, files and git over the machine's connection. The sidebar
 * stays beside it.
 */
export function MachineMain({ machineKey, sidebarOpen, onToggleSidebar }: { machineKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const parsed = parseMachineKey(machineKey);
  const machineId = parsed?.machineId ?? "";
  const store = useMachineConnections();
  // A session key (`machine:<m>:<p>:<s>`) opens the machine's view on that session's agent tab (PRO-346).
  const { sessions, projects } = useMachineProjects(machineId);
  const row = parsed?.sessionId ? (sessions.find((session) => session.key === machineKey) ?? null) : null;
  const focusSession = parsed?.sessionId ?? null;
  const focusTab = row ? machineSessionTab(row) : null;
  const focusAgent = useMemo<AgentFocus | null>(() => (focusSession ? { sessionId: focusSession, tabId: focusTab } : null), [focusSession, focusTab]);
  // A new agent tab on a machine is created in one of its projects (`session.create` needs one): the
  // sidebar's + chooses it, else the form starts on the focused session's project.
  const request = useMachineNewSession(machineId);
  const listed = useMemo(() => projects.filter((node) => !node.project.archived).map((node) => ({ projectId: node.project.projectId, name: node.project.name })), [projects]);
  const preferred = parsed?.projectId ?? null;
  const { machine, state, connection, attachError } = machineConnection(store, machineId);
  const name = machine?.name ?? "Machine";
  const machineName = name;
  const agentProjects = useMemo<AgentProjects>(
    () => ({
      projects: listed,
      preferred,
      request: request ? { projectId: request.projectId, nonce: request.nonce } : null,
      onRequestTaken: () => request && takeMachineNewSession(request),
      onCreated: (sessionId, projectId) => selectCloudSession(machineSessionKey(machineId, projectId, sessionId)),
      machine: { name: machineName, openPage: () => openMachinePage(machineId) },
    }),
    [listed, preferred, request, machineId, machineName],
  );
  const [clientState, setClientState] = useState<WorkspaceConnectionState>({ state: "idle" });
  // "Needs update" also when the machine is connected but hides a feature this desktop uses (PRO-354).
  const version = machineVersionView(machine, state, connection?.client ?? null, clientState, useThisVersion());
  const shown = version.shownState;
  useEffect(() => {
    if (!connection) return;
    setClientState({ state: "idle" });
    return connection.client.onState(setClientState);
  }, [connection]);

  let body;
  if (connection && machine) {
    body = (
      <WorkspaceView
        key={workspaceTargetKey(connection.target)}
        opened={{ connection, name, provider: null, workspaceState: null, machine: { record: machine, status: machineViewStatus(state, name), label: machineViewLabel(state) } }}
        state={clientState}
        initialAgent={!!focusAgent || !!request}
        focusAgent={focusAgent}
        agentProjects={agentProjects}
      />
    );
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
        <MachineChip machine={machine} name={name} state={shown} />
      </header>
      {machine && <MachineLocation machine={machine} name={name} state={state} />}
      {machine && <MachineHiddenFeatures machineId={machineId} view={version} />}
      {body}
    </main>
  );
}
