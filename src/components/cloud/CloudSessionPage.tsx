import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Cloud, FolderTree, GitBranch, Loader2, Plug, Plus, TerminalSquare, X } from "lucide-react";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { TerminalView, createTerminal } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { CloudAgentsView } from "./CloudAgents";
import { CloudFilesView } from "./CloudFiles";
import { CloudGitView } from "./CloudGit";
import {
  api,
  devWorkspaceConnection,
  workspaceConnection,
  workspaceTargetKey,
  type CloudWorkspaceConnection,
  type CloudWorkspaceListItem,
} from "@/lib/api";
import {
  closeCloudTerminal,
  cloudTerminalFactory,
  createCloudTerminal,
  detachCloudTerminals,
  errorCode,
  selectCloudTerminal,
  syncCloudTerminals,
  takeControl,
  useCloudTerminals,
  type CloudTerminal,
} from "@/lib/cloudTerminals";
import { getInstance } from "@/lib/terminal";
import { useTheme } from "@/lib/theme";

/** Where an open session's commands run, as the page labels it. */
interface OpenedWorkspace {
  connection: CloudWorkspaceConnection;
  name: string;
  provider: string | null;
  /** The API state when it was opened (ready, suspended, provisioning); null for a development runtime. */
  workspaceState: string | null;
}

const PROVIDER_NAMES: Record<string, string> = { box: "Boat", machine0: "Machine0", "local-docker": "Local Docker" };

export function providerName(provider: string | null): string {
  if (!provider) return "Development runtime";
  return PROVIDER_NAMES[provider] ?? provider;
}

/**
 * A session in a cloud workspace: the desktop attaches to the workspace's
 * remote runtime (PRO-13) and drives its shell tabs (PRO-26) and an agent
 * tab over the relay. Every shell here runs in the cloud workspace, and the
 * page says so; the full agent tab experience is PRO-22.
 */
export function CloudSessionPage({ onBack }: { onBack: () => void }) {
  const [workspaces, setWorkspaces] = useState<CloudWorkspaceListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedWorkspace | null>(null);
  const connection = opened?.connection ?? null;
  const [state, setState] = useState<WorkspaceConnectionState>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState("");

  useEffect(() => {
    api
      .cloudWorkspaces()
      .then((list) => setWorkspaces(list.workspaces))
      .catch((e: unknown) => setListError(errorCode(e)));
  }, []);

  useEffect(() => {
    if (!connection) return;
    return connection.client.onState(setState);
  }, [connection]);

  useEffect(() => {
    if (!connection) return;
    const key = workspaceTargetKey(connection.target);
    return () => {
      // The shells keep running in the workspace; their views and offsets
      // stay here for the next time this workspace is opened.
      detachCloudTerminals(key);
      connection.close();
    };
  }, [connection]);

  const open = useCallback(async (item: CloudWorkspaceListItem, wake: boolean) => {
    setError(null);
    try {
      // Opening a session is interactive: it may wake suspended compute.
      const next = await workspaceConnection(
        { kind: "cloud", organizationId: item.workspace.orgId, workspaceId: item.workspace.id },
        wake ? "wake" : "connect",
      );
      if (next) setOpened({ connection: next, name: item.workspace.name, provider: item.workspace.provider, workspaceState: item.workspace.state });
    } catch (e) {
      setError(errorCode(e));
    }
  }, []);

  const openDev = useCallback(async () => {
    setError(null);
    try {
      setOpened({ connection: await devWorkspaceConnection(pairingCode.trim()), name: "Development runtime", provider: null, workspaceState: null });
    } catch (e) {
      setError(errorCode(e));
    }
  }, [pairingCode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-testid="cloud-session-page">
      <div className="flex h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-hairline pl-[78px] pr-3" data-tauri-drag-region>
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <Cloud className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{opened ? opened.name : "Cloud workspace session"}</span>
        {opened && <ExecutionLocation provider={opened.provider} name={opened.name} />}
        <span className="ml-auto text-xs text-muted-foreground" data-testid="cloud-connection-state">
          {describe(state)}
        </span>
      </div>
      {!connection ? (
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Workspaces in this organization</h2>
            {listError && <p className="text-xs text-muted-foreground">Cloud workspaces are unavailable ({listError}).</p>}
            {!workspaces && !listError && <Loader2 className="size-4 animate-spin" />}
            {workspaces?.length === 0 && <p className="text-xs text-muted-foreground">No cloud workspaces yet.</p>}
            {workspaces?.map((item) => (
              <div key={item.workspace.id} className="flex items-center gap-3 rounded-md border border-hairline px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{item.workspace.name}</span>
                  <span className="text-xs text-muted-foreground">{item.workspace.state}</span>
                </div>
                {item.workspace.state === "suspended" && (
                  <Button size="sm" variant="ghost" title="Read saved agent conversations without waking the workspace" onClick={() => void open(item, false)}>
                    Open without waking
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!["ready", "suspended"].includes(item.workspace.state)}
                  onClick={() => void open(item, item.workspace.state === "suspended")}
                >
                  {item.workspace.state === "suspended" ? "Resume and open" : "Open session"}
                </Button>
              </div>
            ))}
          </section>
          {import.meta.env.DEV && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Development: attach by pairing code</h2>
              <p className="text-xs text-muted-foreground">
                For a local <code>terminalx-serve --relay-link</code> runtime; debug builds only.
              </p>
              <div className="flex gap-2">
                <input
                  aria-label="Pairing code"
                  className="min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 py-1 font-mono text-xs"
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder="pairing code"
                />
                <Button size="sm" disabled={!pairingCode.trim()} onClick={() => void openDev()}>
                  <Plug className="size-3.5" /> Attach
                </Button>
              </div>
            </section>
          )}
          {error && <p className="text-xs text-red-500">Could not open: {error}</p>}
        </div>
      ) : (
        <WorkspaceView opened={opened!} state={state} />
      )}
    </div>
  );
}

/** Says, wherever a cloud shell is shown, that it runs in the cloud workspace and not on this Mac. */
function ExecutionLocation({ provider, name }: { provider: string | null; name: string }) {
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

type View = { kind: "terminal" } | { kind: "agent" } | { kind: "files" } | { kind: "git" };

function WorkspaceView({ opened, state }: { opened: OpenedWorkspace; state: WorkspaceConnectionState }) {
  const { connection } = opened;
  const client = connection.client;
  const key = workspaceTargetKey(connection.target);
  const agentScope = connection.target.kind === "cloud" ? connection.target : { organizationId: "", workspaceId: key };
  const { terminals, selected } = useCloudTerminals(key);
  const [view, setView] = useState<View>({ kind: "terminal" });
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
  const manage = connected && state.authority === "manage";
  const base = useCallback(() => createTerminal(mode.current), []);

  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}` : null;
  useEffect(() => {
    if (!generation) return;
    let cancelled = false;
    void (async () => {
      try {
        const live = await syncCloudTerminals(key, client, base);
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
  }, [generation, key, client, base, manage]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline px-3 py-1" role="tablist">
        {terminals.map((terminal) => (
          <div key={terminal.id} className="flex items-center" data-testid="cloud-terminal-tab">
            <Button
              size="sm"
              role="tab"
              aria-selected={view.kind === "terminal" && terminal.id === selected}
              variant={view.kind === "terminal" && terminal.id === selected ? "secondary" : "ghost"}
              title={`${terminal.title} runs in the cloud workspace ${opened.name}`}
              onClick={() => {
                selectCloudTerminal(key, terminal.id);
                setView({ kind: "terminal" });
              }}
            >
              <Cloud className="size-3.5" /> {terminal.title}
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
          <Button size="icon" variant="ghost" className="size-7" aria-label="New cloud terminal" onClick={() => void newTerminal()}>
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
      </div>
      {!connected && <div className="px-4 py-1 text-xs text-muted-foreground">{describe(state)}</div>}
      {error && <p className="px-4 py-1 text-xs text-red-500">Terminal: {error}</p>}
      {/* Terminal views and the agent tab stay mounted across reconnects and
          view switches: they live on the runtime, and their streams resume
          from the last byte or cursor. */}
      <div className={view.kind === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {active ? (
          <CloudTerminalPane
            key={active.id}
            workspace={key}
            terminal={active}
            client={client}
            connected={connected}
            manage={manage}
            base={base}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            <TerminalSquare className="mr-2 size-4" />
            {connected ? "No terminals in this workspace." : "Terminals appear once the workspace is connected."}
          </div>
        )}
      </div>
      <div className={view.kind === "agent" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <CloudAgentsView
          scope={{ organizationId: agentScope.organizationId, workspaceId: agentScope.workspaceId }}
          client={client}
          state={state}
          workspaceState={opened.workspaceState}
          wakeWorkspace={() => void connection.activate("wake").catch(() => undefined)}
        />
      </div>
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
    </div>
  );
}

function CloudTerminalPane({
  workspace,
  terminal,
  client,
  connected,
  manage,
  base,
}: {
  workspace: string;
  terminal: CloudTerminal;
  client: WorkspaceRpcClient;
  connected: boolean;
  manage: boolean;
  base: () => ReturnType<typeof createTerminal>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCallback(() => cloudTerminalFactory(workspace, terminal, base)(), [workspace, terminal.id]);
  const controlling = terminal.control === "you";

  const control = async () => {
    setBusy(true);
    setError(null);
    try {
      const instance = getInstance(terminal.id, create);
      const size = instance.fit.proposeDimensions();
      await takeControl(workspace, client, terminal.id, size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null);
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  let notice: string | null = null;
  if (terminal.gone === "runtime-restarted") notice = "This terminal ended when the workspace runtime restarted. Input is not sent anywhere.";
  else if (terminal.gone === "closed") notice = "This terminal was closed.";
  else if (terminal.exited) notice = `The shell exited${terminal.exitCode === null ? "" : ` with code ${terminal.exitCode}`}.`;
  else if (terminal.inputError) notice = `Input was not delivered: ${inputErrorText(terminal.inputError)}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-terminal">
      {!terminal.gone && !terminal.exited && !controlling && (
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-1 text-xs text-muted-foreground" data-testid="cloud-terminal-viewer">
          <span>
            {manage ? "Another device controls this terminal's input and size; you are watching." : "View only: this attachment cannot type into or resize terminals."}
          </span>
          {manage && (
            <Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => void control()}>
              Take control
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p className="border-b border-hairline px-3 py-1 text-xs text-muted-foreground" data-testid="cloud-terminal-notice">
          {notice}
        </p>
      )}
      {error && <p className="px-3 py-1 text-xs text-red-500">{error}</p>}
      <div className="min-h-0 flex-1">
        <TerminalView id={terminal.id} visible create={create} fit={controlling && !terminal.gone} />
      </div>
    </div>
  );
}

function inputErrorText(code: string): string {
  switch (code) {
    case "not_controller":
      return "another device controls this terminal. Take control to type.";
    case "unavailable":
      return "the shell has exited.";
    case "not_found":
      return "the terminal no longer exists.";
    case "not connected":
      return "not connected to the workspace.";
    default:
      return code;
  }
}

function describe(state: WorkspaceConnectionState): string {
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
    case "stopped":
      return "Disconnected";
    default:
      return "Not connected";
  }
}

