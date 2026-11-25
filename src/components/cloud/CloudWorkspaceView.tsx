import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Cloud, FolderTree, GitBranch, Globe, Plus, TerminalSquare, UserPlus, X } from "@/icons";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { createTerminal } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { type AgentProjects, CloudAgentSessions } from "./CloudAgents";
import { CloudTerminalPane } from "./CloudTerminalPane";
import { CloudFilesView } from "./CloudFiles";
import { CloudGitView } from "./CloudGit";
import { CloudPortsView } from "./CloudPorts";
import { NotSharedNotice, ParticipantsBar } from "./CloudCollab";
import { CloudShareDialog } from "./CloudShareDialog";
import { PHASES, phaseOf, runtimeNotPickedUp, settled } from "@/lib/cloudCreate";
import { resolveCloudAttention } from "@/lib/cloudAttention";
import { archiving, deletion, isOpen } from "@/lib/cloudLifecycle";
import { api, workspaceTargetKey, type CloudWorkspaceConnection, type CloudWorkspaceListItem } from "@/lib/api";
import {
  closeCloudTerminal,
  createCloudTerminal,
  errorCode,
  followCloudTerminals,
  selectCloudTerminal,
  setCloudTerminalShown,
  syncCloudTerminals,
  useCloudTerminals,
  type CloudTerminal,
} from "@/lib/cloudTerminals";
import { canTypeInTerminals, mayUsePreviews, sharingKnown, effectiveYou, notShared, presenceTab, rememberYou, startCollab, useCollab } from "@/lib/cloudCollab";
import { rememberPeople } from "@/lib/cloudPeople";
import { getCloudAgents } from "@/lib/cloudAgents";
import { useTheme } from "@/lib/theme";
import { cloudProviderName } from "@/lib/cloudSession";
import { useCloudProviderDescriptors } from "@/lib/cloudProviders";
import { MachineIcon } from "@/components/machines/connectionStatus";
import type { PairedMachine } from "@/types/machines";
import { WorkspacePlaceProvider, type MachinePlace } from "./workspacePlace";

/**
 * The view of one cloud workspace (its terminals, agent tab, files and Git)
 * and the words for its state. `CloudWorkspaceMain` shows it in the main
 * slot beside the sidebar.
 */

/** Where an open workspace's commands run, as its header labels it. */
export interface OpenedWorkspace {
  connection: CloudWorkspaceConnection;
  name: string;
  provider: string | null;
  /** The API state when it was opened (ready, suspended, provisioning); null for a paired machine. */
  workspaceState: string | null;
  /**
   * Set for a paired machine: its record, and what its own connection says
   * while the view is not connected (a sentence, and a word for a chip). Every
   * tab then names the machine and never shows the transport's words for a
   * cloud workspace.
   */
  machine?: { record: PairedMachine; status: string; label: string };
}

/** A cloud provider's display name. */
export const providerName = cloudProviderName;

export function archivingText(item: CloudWorkspaceListItem): string {
  return item.latestOperation?.errorCode === "runtime_checkpoint_pending"
    ? "Archiving: waiting for the runtime to save its conversations (up to a minute)…"
    : "Archiving…";
}

const STATE_TEXT: Record<string, string> = {
  provisioning: "Starting",
  ready: "Ready",
  suspended: "Stopped",
  archived: "Archived",
  "attention-required": "Needs attention",
  destroyed: "Deleted",
};

/**
 * The list's one line of state; the work branch has a line of its own. What
 * is happening to the workspace itself (deleting, archiving, stopping,
 * resuming, stopped, needing attention) comes first; the startup phase of its
 * first task only while it is otherwise ready or starting.
 */
export function describeWorkspace(item: CloudWorkspaceListItem, now = Date.now(), agentRan = false): string {
  const { state, launch } = item.workspace;
  const operation = item.latestOperation;
  // A delete that stopped says why on its own line below; the row keeps its state.
  if (deletion(item) === "running") return "Deleting…";
  if (archiving(item)) return archivingText(item);
  if (isOpen(operation) && operation?.action === "suspend") return "Stopping…";
  if (isOpen(operation) && operation?.action === "resume") return "Resuming…";
  const phase = phaseOf(item);
  const attention = resolveCloudAttention(item, { agentRan });
  if (attention) return `${state === "ready" && launch ? "The agent did not start" : "Needs attention"}: ${attention.message}`;
  if (state === "attention-required") return "Ready";
  if (state === "suspended" || state === "archived" || state === "destroyed") return STATE_TEXT[state];
  if (runtimeNotPickedUp(item, now) !== null) return "Ready · the runtime has not picked up the first task";
  if (state === "provisioning" || (launch && !settled(phase))) return PHASES.find((p) => p.id === phase)?.label ?? phase;
  return STATE_TEXT[state] ?? state;
}

/** Says, wherever a cloud shell is shown, that it runs in the cloud workspace and not on this Mac. */
export function ExecutionLocation({ provider, name }: { provider: string | null; name: string }) {
  // Provider names come from the descriptors the app has read (PRO-415): re-render when a list brings new ones.
  useCloudProviderDescriptors();
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5 text-[11px] text-muted-foreground"
      data-testid="cloud-execution-location"
      title={`Commands run in the cloud workspace ${name} (${providerName(provider)}), not on this computer.`}
    >
      <Cloud className="size-3" /> Cloud · {providerName(provider)}
    </span>
  );
}

type View = { kind: "terminal" } | { kind: "agent" } | { kind: "files" } | { kind: "git" } | { kind: "ports" };

type WorkspaceViewProps = {
  opened: OpenedWorkspace;
  state: WorkspaceConnectionState;
  agentRequest?: number;
  initialAgent?: boolean;
  /** A paired machine's projects, which a new agent session is created in (PRO-346). */
  agentProjects?: AgentProjects | null;
  /** Open one of the workspace's agent sessions in the shared session view (#1289). */
  onOpenSession: (sessionId: string, tabId: string | null) => void;
};

/** The view, with the machine it runs on (if it is one) known to every tab. */
export function WorkspaceView(props: WorkspaceViewProps) {
  const { name } = props.opened;
  const status = props.opened.machine?.status;
  const label = props.opened.machine?.label;
  const place = useMemo<MachinePlace | null>(() => (status === undefined || label === undefined ? null : { name, status, label }), [name, status, label]);
  return (
    <WorkspacePlaceProvider value={place}>
      <WorkspaceViewBody {...props} />
    </WorkspacePlaceProvider>
  );
}

function WorkspaceViewBody({ opened, state, agentRequest = 0, initialAgent = false, agentProjects = null, onOpenSession }: WorkspaceViewProps) {
  const { connection } = opened;
  const client = connection.client;
  const key = workspaceTargetKey(connection.target);
  const agentScope = connection.target.kind === "cloud" ? connection.target : { organizationId: "", workspaceId: key };
  const { terminals, selected } = useCloudTerminals(key);
  const [view, setView] = useState<View>({ kind: initialAgent ? "agent" : "terminal" });
  useEffect(() => { if (agentRequest > 0) setView({ kind: "agent" }); }, [agentRequest]);
  // The sidebar's + on a machine: the agent view, with its new-agent form open.
  useEffect(() => { if (agentProjects?.request) setView({ kind: "agent" }); }, [agentProjects?.request?.nonce]);
  // The sidebar marks the terminal's row only while the terminal is what shows.
  const terminalShown = view.kind === "terminal";
  useEffect(() => {
    setCloudTerminalShown(key, terminalShown);
    return () => setCloudTerminalShown(key, false);
  }, [key, terminalShown]);
  const [filesShown, setFilesShown] = useState(false);
  if (view.kind === "files" && !filesShown) setFilesShown(true);
  const [gitShown, setGitShown] = useState(false);
  if (view.kind === "git" && !gitShown) setGitShown(true);
  const [error, setError] = useState<string | null>(null);
  const { resolvedMode } = useTheme();
  const mode = useRef(resolvedMode);
  mode.current = resolvedMode;
  const autoCreated = useRef(false);
  const connected = state.state === "connected";
  const base = useCallback(() => createTerminal(mode.current), []);
  const collab = useCollab(key);
  const you = effectiveYou(state, collab);
  const shared = connected && collab.available ? you : null;
  // A demoted admin's manage attachment is not a manager's any more.
  const manage = connected && state.authority === "manage" && (!sharingKnown(shared) || shared.role === "manager");
  // Managers and approving drivers of a shared workspace may take a terminal over; viewers and plain drivers never.
  const mayControl = manage || canTypeInTerminals(shared);
  // PRO-28: Ports is left out for someone the live runtime says may not use previews.
  const portsOffered = !connected || mayUsePreviews(manage, shared);
  useEffect(() => {
    if (!portsOffered) setView((current) => (current.kind === "ports" ? { kind: "terminal" } : current));
  }, [portsOffered]);
  const [sharing, setSharing] = useState(false);
  const cloudTarget = connection.target.kind === "cloud" ? connection.target : null;

  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}` : null;

  // Presence, notes and leases, once per connection (only with collab/1).
  useEffect(() => {
    if (!generation) return;
    return startCollab(key, client);
  }, [generation, key, client]);

  // Names for the people the runtime reports, from the share list.
  useEffect(() => {
    if (!cloudTarget) return;
    let cancelled = false;
    void api
      .cloudWorkspaceShares(cloudTarget.workspaceId, cloudTarget.organizationId)
      .then((listed) => {
        if (cancelled) return;
        rememberPeople(listed.shares);
        rememberYou(key, listed.you);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cloudTarget?.workspaceId, cloudTarget?.organizationId]);
  // Terminals are listed again when this person's access changes: a
  // participant shared with mid-connection sees them without reconnecting.
  const hidden = notShared(state, you);
  const role = shared?.role ?? null;
  useEffect(() => {
    if (!generation || hidden) return;
    let cancelled = false;
    void (async () => {
      try {
        const live = await syncCloudTerminals(key, client, base);
        if (!cancelled) setError(null);
        // A workspace with no shell gets one on the first connect only; after
        // that tabs are the user's, and a restarted runtime's ended tabs are
        // never quietly replaced by new shells.
        if (cancelled) return;
        const first = !autoCreated.current;
        autoCreated.current = true;
        if (first && live.length === 0 && manage) {
          await createCloudTerminal(key, client, { cols: 100, rows: 30 }, base);
        }
      } catch (e) {
        if (!cancelled) setError(errorCode(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generation, key, client, base, manage, hidden, role]);
  // Terminals other people open or close, while connected.
  useEffect(() => {
    if (!generation || hidden) return;
    return followCloudTerminals(key, client, base);
  }, [generation, key, client, base, hidden]);

  const newTerminal = async () => {
    setError(null);
    try {
      await createCloudTerminal(key, client, { cols: 100, rows: 30 }, base);
      setView({ kind: "terminal" });
    } catch (e) {
      setError(errorCode(e));
    }
  };

  const close = async (terminal: CloudTerminal) => {
    setError(null);
    try {
      await closeCloudTerminal(key, connected ? client : null, terminal.id);
    } catch (e) {
      setError(errorCode(e));
    }
  };

  const active = terminals.find((terminal) => terminal.id === selected) ?? null;

  // Others see which terminal this person is on; the agent view reports its own tab.
  const presenceTerminal = view.kind === "terminal" ? (active?.ptyId ?? null) : null;
  useEffect(() => {
    if (view.kind === "terminal" && collab.available) presenceTab(key, presenceTerminal);
  }, [view.kind, presenceTerminal, collab.available, key]);

  const tabLabel = useCallback(
    (tabId: string) => {
      const terminal = terminals.find((item) => item.ptyId === tabId);
      if (terminal) return terminal.title;
      const agent = getCloudAgents({ organizationId: agentScope.organizationId, workspaceId: agentScope.workspaceId }).tabs.find((tab) => tab.tabId === tabId);
      return agent ? (agent.info.title ?? "an agent tab") : null;
    },
    [terminals, agentScope.organizationId, agentScope.workspaceId],
  );

  if (hidden) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {cloudTarget && (
          <div className="flex shrink-0 items-center justify-end border-b border-hairline px-3 py-1">
            <Button size="sm" variant="ghost" onClick={() => setSharing(true)}>
              <UserPlus className="size-3.5" /> People
            </Button>
          </div>
        )}
        <NotSharedNotice />
        {sharing && cloudTarget && <CloudShareDialog orgId={cloudTarget.organizationId} workspaceId={cloudTarget.workspaceId} name={opened.name} onClose={() => setSharing(false)} />}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(cloudTarget || collab.available) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1" data-testid="cloud-collab-bar">
          <ParticipantsBar collabKey={key} you={shared} tabLabel={tabLabel} />
          {cloudTarget && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSharing(true)}>
              <UserPlus className="size-3.5" /> Share
            </Button>
          )}
        </div>
      )}
      {sharing && cloudTarget && <CloudShareDialog orgId={cloudTarget.organizationId} workspaceId={cloudTarget.workspaceId} name={opened.name} onClose={() => setSharing(false)} />}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline px-3 py-1" role="tablist">
        {terminals.map((terminal) => (
          <div key={terminal.id} className="flex items-center" data-testid="cloud-terminal-tab">
            <Button
              size="sm"
              role="tab"
              aria-selected={view.kind === "terminal" && terminal.id === selected}
              variant={view.kind === "terminal" && terminal.id === selected ? "secondary" : "ghost"}
              title={opened.machine ? `${terminal.title} runs on ${opened.name}` : `${terminal.title} runs in the cloud workspace ${opened.name}`}
              onClick={() => {
                selectCloudTerminal(key, terminal.id);
                setView({ kind: "terminal" });
              }}
            >
              {opened.machine ? <MachineIcon machine={opened.machine.record} className="size-3.5" /> : <Cloud className="size-3.5" />} {terminal.title}
              {terminal.gone ? " (ended)" : terminal.exited ? " (exited)" : ""}
            </Button>
            {(manage || terminal.gone) && (
              <Button size="icon" variant="ghost" className="size-6" aria-label={`Close ${terminal.title}`} onClick={() => void close(terminal)}>
                <X className="size-3" />
              </Button>
            )}
          </div>
        ))}
        {manage && (
          <Button size="icon" variant="ghost" className="size-7" aria-label={opened.machine ? `New terminal on ${opened.name}` : "New cloud terminal"} onClick={() => void newTerminal()}>
            <Plus className="size-3.5" />
          </Button>
        )}
        <Button
          size="sm"
          role="tab"
          aria-selected={view.kind === "agent"}
          variant={view.kind === "agent" ? "secondary" : "ghost"}
          onClick={() => setView({ kind: "agent" })}
        >
          <Bot className="size-3.5" /> Agent
        </Button>
        <Button
          size="sm"
          role="tab"
          aria-selected={view.kind === "files"}
          variant={view.kind === "files" ? "secondary" : "ghost"}
          onClick={() => setView({ kind: "files" })}
        >
          <FolderTree className="size-3.5" /> Files
        </Button>
        <Button
          size="sm"
          role="tab"
          aria-selected={view.kind === "git"}
          variant={view.kind === "git" ? "secondary" : "ghost"}
          onClick={() => setView({ kind: "git" })}
        >
          <GitBranch className="size-3.5" /> Git
        </Button>
        {portsOffered && (
          <Button
            size="sm"
            role="tab"
            aria-selected={view.kind === "ports"}
            variant={view.kind === "ports" ? "secondary" : "ghost"}
            onClick={() => setView({ kind: "ports" })}
          >
            <Globe className="size-3.5" /> Ports
          </Button>
        )}
      </div>
      {!connected && (
        <div className="px-4 py-1 text-xs text-muted-foreground" data-testid="workspace-connection-status">
          {opened.machine ? opened.machine.status : describe(state)}
        </div>
      )}
      {error && <p className="px-4 py-1 text-xs text-red-500">Terminal: {error}</p>}
      {/* Terminal views stay mounted across reconnects and view switches:
          they live on the runtime, and their streams resume from the last byte. */}
      <div className={view.kind === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {active ? (
          <CloudTerminalPane
            key={active.id}
            workspace={key}
            terminal={active}
            client={client}
            connected={connected}
            manage={manage}
            mayControl={mayControl}
            you={shared}
            base={base}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" data-testid="workspace-no-terminals">
            <TerminalSquare className="mr-2 size-4" />
            {opened.machine
              ? connected
                ? `No terminals on ${opened.name}.`
                : `Terminals appear once ${opened.name} is connected.`
              : connected
                ? "No terminals in this workspace."
                : "Terminals appear once the workspace is connected."}
          </div>
        )}
      </div>
      {/* The workspace's agent sessions; each opens in the same session view as a local one (#1289). */}
      {view.kind === "agent" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <CloudAgentSessions
            scope={{ organizationId: agentScope.organizationId, workspaceId: agentScope.workspaceId }}
            client={client}
            state={state}
            workspaceState={opened.workspaceState}
            collabKey={key}
            projects={agentProjects}
            onOpenSession={onOpenSession}
          />
        </div>
      )}
      {/* Mounted once first shown, then kept: open files and unsaved text stay. */}
      {filesShown && (
        <div className={view.kind === "files" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <CloudFilesView workspaceKey={key} name={opened.name} client={client} state={state} active={view.kind === "files"} />
        </div>
      )}
      {gitShown && (
        <div className={view.kind === "git" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <CloudGitView workspaceKey={key} client={client} state={state} active={view.kind === "git"} />
        </div>
      )}
      {/* Only while shown: it reads the workspace's ports on a timer. */}
      {view.kind === "ports" && portsOffered && (
        <div className="flex min-h-0 flex-1 flex-col">
          <CloudPortsView workspaceKey={key} client={client} state={state} connectionId={connection.connectionId?.() ?? null} mayOpen={mayControl} active />
        </div>
      )}
    </div>
  );
}

export function describe(state: WorkspaceConnectionState): string {
  switch (state.state) {
    case "connected":
      return `Connected · runtime ${state.runtimeVersion} · generation ${state.runtimeGeneration} · ${state.authority}`;
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return `Reconnecting (attempt ${state.attempt})…`;
    case "opening":
      return "Checking the workspace…";
    case "waitingForRuntime":
      return "Waiting for the workspace runtime…";
    case "suspended":
      return "Suspended";
    case "updateRequired":
      return "Update TerminalX to connect to this workspace";
    case "unavailable":
      return "Can't be reached";
    case "stopped":
      return "Disconnected";
    default:
      return "Not connected";
  }
}

