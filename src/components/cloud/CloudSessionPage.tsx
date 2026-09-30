import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowLeft, Bot, Cloud, FolderTree, GitBranch, Loader2, Pause, Plug, Plus, TerminalSquare, Trash2, X } from "lucide-react";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { createTerminal } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { CloudAgentsView } from "./CloudAgents";
import { CloudTerminalPane } from "./CloudTerminalPane";
import { CloudFilesView } from "./CloudFiles";
import { CloudGitView } from "./CloudGit";
import { CloudCreateWorkspace } from "./CloudCreateWorkspace";
import { actionsFor, archiveLine, CloudWorkspaceLifecycleDialog, DeletionProgress, type LifecycleAction } from "./CloudWorkspaceLifecycle";
import { useAccount } from "@/lib/account";
import { applyCloudSnapshot, ingestCloudList, unarchiveCloudWorkspace } from "@/lib/cloudCatalog";
import { failureMessage, PHASES, phaseOf, runtimeNotPickedUp, settled } from "@/lib/cloudCreate";
import {
  archiving,
  checkpointText,
  deletion,
  isArchived,
  isOpen,
  lifecycleErrorMessage,
  operationFailureText,
  purgeNoticeText,
  type PurgeNotice,
} from "@/lib/cloudLifecycle";
import {
  api,
  devWorkspaceConnection,
  workspaceConnection,
  workspaceTargetKey,
  type CloudWorkspaceConnection,
  type CloudWorkspaceListItem,
  type CloudWorkspaceSnapshot,
} from "@/lib/api";
import {
  closeCloudTerminal,
  createCloudTerminal,
  detachCloudTerminals,
  errorCode,
  selectCloudTerminal,
  syncCloudTerminals,
  useCloudTerminals,
  type CloudTerminal,
} from "@/lib/cloudTerminals";
import { useTheme } from "@/lib/theme";
import { cloudProviderName } from "@/lib/cloudSession";

/** Where an open session's commands run, as the page labels it. */
export interface OpenedWorkspace {
  connection: CloudWorkspaceConnection;
  name: string;
  provider: string | null;
  /** The API state when it was opened (ready, suspended, provisioning); null for a development runtime. */
  workspaceState: string | null;
}

/** A cloud provider's display name. */
export const providerName = cloudProviderName;

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
  const [creating, setCreating] = useState(false);
  const [lifecycle, setLifecycle] = useState<{ item: CloudWorkspaceListItem; action: LifecycleAction } | null>(null);
  const [notices, setNotices] = useState<PurgeNotice[]>([]);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const { status } = useAccount();
  const scope = status.state === "signed-in" ? (status.context?.scope ?? "signed-in") : "signed-out";

  const reload = useCallback(() => {
    api
      .cloudWorkspaces()
      .then(async (list) => {
        // The catalog drops tombstoned rows, purges what this Mac kept of
        // them, and keeps the sidebar's copy of the list current.
        const ingest = ingestCloudList(list);
        const deleted = new Set((list.tombstones ?? []).map((tombstone) => tombstone.id));
        setWorkspaces(list.workspaces.filter((item) => !deleted.has(item.workspace.id)));
        setListError(null);
        const { notices: purged } = await ingest;
        if (purged.length) setNotices((current) => [...current, ...purged]);
      })
      .catch((e: unknown) => setListError(errorCode(e)));
  }, []);

  useEffect(() => reload(), [reload]);

  // The create form polls the workspace it tracks; its snapshots keep that
  // row current while the list itself does not poll.
  const progress = useCallback((snapshot: CloudWorkspaceSnapshot) => {
    applyCloudSnapshot(snapshot);
    setWorkspaces((current) =>
      current?.map((item) => (item.workspace.id === snapshot.workspace.id ? { workspace: snapshot.workspace, latestOperation: snapshot.operation } : item)) ??
      current,
    );
  }, []);

  // Back from an opened session returns to the list; from the list, it leaves.
  // Opening a session unmounted the create form, so it is closed rather than
  // shown again empty; the list row carries the workspace's state.
  const back = useCallback(() => {
    if (opened) {
      setOpened(null);
      setState({ state: "idle" });
      setCreating(false);
      reload();
    } else onBack();
  }, [opened, onBack, reload]);

  // While any workspace is still starting (provisioning, or ready with its
  // agent not yet running) or has an action in progress (stop, resume,
  // archive, delete), keep the list current, also while the create form is
  // open: the form's own snapshots only cover the workspace it tracks.
  const starting =
    workspaces?.some(
      (item) =>
        ((item.workspace.state === "provisioning" || item.workspace.launch) && !settled(phaseOf(item))) ||
        isOpen(item.latestOperation),
    ) ?? false;
  useEffect(() => {
    if (!starting || connection) return;
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
  }, [starting, connection, reload]);

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

  const unarchive = useCallback(
    async (item: CloudWorkspaceListItem) => {
      setRowError(null);
      try {
        await unarchiveCloudWorkspace(item);
        reload();
      } catch (e) {
        setRowError({ id: item.workspace.id, message: lifecycleErrorMessage(errorCode(e)) });
      }
    },
    [reload],
  );

  const active = workspaces?.filter((item) => !isArchived(item.workspace)) ?? null;
  const archived = workspaces?.filter((item) => isArchived(item.workspace)) ?? [];

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
        <Button variant="ghost" size="sm" onClick={back} aria-label={opened ? "Back to workspaces" : "Back"}>
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
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4 overflow-y-auto p-6">
          <section className="flex flex-col gap-2" data-testid="cloud-create-section">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">New cloud workspace</h2>
              {!creating && (
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setCreating(true)}>
                  <Plus className="size-3.5" /> New workspace
                </Button>
              )}
              {creating && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="ml-auto size-6"
                  aria-label="Close the new workspace form"
                  onClick={() => {
                    setCreating(false);
                    reload();
                  }}
                >
                  <X className="size-3" />
                </Button>
              )}
            </div>
            {creating && (
              <CloudCreateWorkspace
                key={scope}
                organizationId={scope}
                onChanged={reload}
                onProgress={progress}
                onOpen={(item) => void open(item, false)}
              />
            )}
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Workspaces in this organization</h2>
            {listError && <p className="text-xs text-muted-foreground">Cloud workspaces are unavailable ({listError}).</p>}
            {!workspaces && !listError && <Loader2 className="size-4 animate-spin" />}
            {active?.length === 0 && (
              <p className="text-xs text-muted-foreground">{archived.length ? "No active cloud workspaces." : "No cloud workspaces yet."}</p>
            )}
            {notices.map((notice) => (
              <div key={notice.workspaceId} className="flex items-start gap-2 rounded-md bg-well px-3 py-2 text-xs" role="status" data-testid="cloud-tombstone-notice">
                <Trash2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">{purgeNoticeText(notice)}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss"
                  onClick={() => setNotices((current) => current.filter((other) => other !== notice))}
                >
                  <X />
                </Button>
              </div>
            ))}
            {active?.map((item) => {
              const deleting = deletion(item);
              return (
                <div key={item.workspace.id} className="flex flex-col gap-1.5 rounded-md border border-hairline px-3 py-2" data-testid="cloud-workspace-row">
                  <div className="flex items-center gap-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{item.workspace.name}</span>
                      <span className="text-xs text-muted-foreground" data-testid="cloud-workspace-state">
                        {describeWorkspace(item)}
                      </span>
                      {item.workspace.launch?.workBranch && (
                        <span
                          className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground"
                          title="This workspace's own branch"
                          data-testid="cloud-workspace-branch"
                        >
                          <GitBranch className="size-3 shrink-0" />
                          <span className="truncate">{item.workspace.launch.workBranch}</span>
                        </span>
                      )}
                    </div>
                    {!deleting && item.workspace.state === "suspended" && (
                      <Button size="sm" variant="ghost" title="Read saved agent conversations without waking the workspace" onClick={() => void open(item, false)}>
                        Open without waking
                      </Button>
                    )}
                    {!deleting && (
                      <Button
                        size="sm"
                        disabled={!["ready", "suspended"].includes(item.workspace.state) || archiving(item)}
                        onClick={() => void open(item, item.workspace.state === "suspended")}
                      >
                        {item.workspace.state === "suspended" ? "Resume and open" : "Open session"}
                      </Button>
                    )}
                    {deleting !== "running" && !archiving(item) && (
                      <LifecycleButtons item={item} onChoose={(action) => setLifecycle({ item, action })} />
                    )}
                  </div>
                  {deleting && (
                    <DeletionProgress item={item} onChanged={reload} onForceNeeded={() => setLifecycle({ item, action: "delete" })} />
                  )}
                  {rowError?.id === item.workspace.id && <p className="text-xs text-destructive">{rowError.message}</p>}
                </div>
              );
            })}
          </section>
          {archived.length > 0 && (
            <section className="flex flex-col gap-2" data-testid="cloud-archived-section">
              <h2 className="text-sm font-medium">Archived</h2>
              <p className="text-xs text-muted-foreground">
                Stopped and kept until their deadline, then deleted automatically. Storage keeps billing at the provider until then.
              </p>
              {archived.map((item) => {
                const deleting = deletion(item);
                const failed = item.workspace.state !== "archived" && !archiving(item) && !deleting;
                const saved = item.latestOperation?.action === "archive" ? checkpointText(item.latestOperation.checkpoint) : null;
                return (
                  <div key={item.workspace.id} className="flex flex-col gap-1.5 rounded-md border border-hairline px-3 py-2" data-testid="cloud-archived-row">
                    <div className="flex items-center gap-3">
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{item.workspace.name}</span>
                        <span className="text-xs text-muted-foreground" data-testid="cloud-archive-deadline">
                          {archiving(item)
                            ? archivingText(item)
                            : failed
                              ? `The archive did not finish: ${item.latestOperation ? operationFailureText(item.latestOperation) : lifecycleErrorMessage("cloud_workspace_unknown_error")}`
                              : archiveLine(item)}
                        </span>
                        {saved && !archiving(item) && <span className="text-xs text-muted-foreground">{saved}</span>}
                      </div>
                      {!deleting && !archiving(item) && (
                        <>
                          {item.workspace.state === "archived" && (
                            <Button size="sm" variant="ghost" title="Read saved agent conversations; nothing is started" onClick={() => void open(item, false)}>
                              Read conversations
                            </Button>
                          )}
                          {failed && (
                            <Button size="sm" variant="outline" onClick={() => setLifecycle({ item, action: "archive" })}>
                              <Archive className="size-3.5" /> Retry archive
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => void unarchive(item)} title="Keep it: it stays stopped until you open it">
                            <ArchiveRestore className="size-3.5" /> Unarchive
                          </Button>
                          <Button size="sm" variant="ghost" aria-label={`Delete ${item.workspace.name} now`} onClick={() => setLifecycle({ item, action: "delete" })}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                    {deleting && (
                      <DeletionProgress item={item} onChanged={reload} onForceNeeded={() => setLifecycle({ item, action: "delete" })} />
                    )}
                    {rowError?.id === item.workspace.id && <p className="text-xs text-destructive">{rowError.message}</p>}
                  </div>
                );
              })}
            </section>
          )}
          {lifecycle && (
            <CloudWorkspaceLifecycleDialog
              item={lifecycle.item}
              initial={lifecycle.action}
              onClose={() => setLifecycle(null)}
              onDone={() => {
                setLifecycle(null);
                reload();
              }}
              onExport={() => {
                const { item } = lifecycle;
                setLifecycle(null);
                void open(item, item.workspace.state === "suspended");
              }}
            />
          )}
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

/** Stop, archive and delete; each opens the dialog that tells them apart. */
function LifecycleButtons({ item, onChoose }: { item: CloudWorkspaceListItem; onChoose: (action: LifecycleAction) => void }) {
  const actions = actionsFor(item);
  const name = item.workspace.name;
  return (
    <div className="flex items-center">
      {actions.includes("stop") && (
        <Button size="icon-sm" variant="ghost" aria-label={`Stop ${name}`} title="Stop: keeps everything, resume any time" onClick={() => onChoose("stop")}>
          <Pause />
        </Button>
      )}
      {actions.includes("archive") && (
        <Button size="icon-sm" variant="ghost" aria-label={`Archive ${name}`} title="Archive: stopped and kept for 30 days" onClick={() => onChoose("archive")}>
          <Archive />
        </Button>
      )}
      {actions.includes("delete") && (
        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${name}`} title="Delete permanently" onClick={() => onChoose("delete")}>
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

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
export function describeWorkspace(item: CloudWorkspaceListItem, now = Date.now()): string {
  const { state, launch } = item.workspace;
  const operation = item.latestOperation;
  // A delete that stopped says why on its own line below; the row keeps its state.
  if (deletion(item) === "running") return "Deleting…";
  if (archiving(item)) return archivingText(item);
  if (isOpen(operation) && operation?.action === "suspend") return "Stopping…";
  if (isOpen(operation) && operation?.action === "resume") return "Resuming…";
  const phase = phaseOf(item);
  if (state === "attention-required") {
    if (phase === "failed" && launch) return `Needs attention: ${failureMessage(item)}`;
    if (operation?.state === "failed" && operation.errorCode) return `Needs attention: ${operationFailureText(operation)}`;
    return "Needs attention";
  }
  if (state === "suspended" || state === "archived" || state === "destroyed") return STATE_TEXT[state];
  if (phase === "failed" && launch) return `The agent did not start: ${failureMessage(item)}`;
  if (runtimeNotPickedUp(item, now) !== null) return "Ready · the runtime has not picked up the first task";
  if (state === "provisioning" || (launch && !settled(phase))) return PHASES.find((p) => p.id === phase)?.label ?? phase;
  return STATE_TEXT[state] ?? state;
}

/** Says, wherever a cloud shell is shown, that it runs in the cloud workspace and not on this Mac. */
export function ExecutionLocation({ provider, name }: { provider: string | null; name: string }) {
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

export function WorkspaceView({ opened, state }: { opened: OpenedWorkspace; state: WorkspaceConnectionState }) {
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
    case "stopped":
      return "Disconnected";
    default:
      return "Not connected";
  }
}

