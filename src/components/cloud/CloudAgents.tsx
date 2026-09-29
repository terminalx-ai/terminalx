import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Plus, X } from "lucide-react";
import type { WorkspaceConnectionState, WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import { leaseLive } from "@terminalx/portable/workspaceCollab";
import { Chat } from "@/components/chat/Chat";
import { Composer } from "@/components/chat/Composer";
import { Button } from "@/components/ui/button";
import { useTabLog } from "@/lib/agentEvents";
import { buildTranscript } from "@/lib/transcript";
import { EFFORT_LABEL, PERMISSION_MODES, useModels } from "@/lib/models";
import {
  attachCloudAgentTab,
  closeCloudAgentTab,
  configureCloudAgentTab,
  createCloudAgentTab,
  decideCloudAgent,
  DEV_SCOPE_NOTICE,
  errorText,
  isDevScope,
  flushCloudAgentCache,
  loadCloudAgents,
  markCloudAgentRead,
  outboxFor,
  refreshFromCheckpoint,
  sendAgain,
  sendToCloudAgent,
  setViewing,
  startOutboxPolling,
  steerCloudAgent,
  stopCloudAgent,
  syncLiveTabs,
  useCloudAgents,
  watchLiveTabs,
  type CloudAgentTab,
  type CloudAgentsSnapshot,
} from "@/lib/cloudAgents";
import { TERMINAL_OUTBOX_STATES, type CloudAgentScope, type OutboxEntry, type WakeResult } from "@/lib/cloudAgentApi";
import type { ImageInput } from "@/lib/api";
import type { TabEntry } from "@/types/session";
import { cn } from "@/lib/cn";
import { canApprove, canDrive, effectiveYou, notShared, presenceTab, presenceTyping, useCollab } from "@/lib/cloudCollab";
import { usePeople } from "@/lib/cloudPeople";
import { LeaseBar, NotesPanel, NotSharedNotice, useNowUntil } from "./CloudCollab";

/**
 * The agent tabs of a cloud workspace (PRO-22). Tabs and transcripts show
 * from the local cache and checkpoints even while the workspace sleeps;
 * the live stream attaches only while the runtime is online; commands go
 * through the mailbox and are the only thing that may wake compute.
 */
export function CloudAgentsView({
  scope,
  client,
  state,
  workspaceState,
  wakeWorkspace,
  collabKey,
  active: shown = true,
}: {
  scope: CloudAgentScope;
  client: WorkspaceRpcClient;
  state: WorkspaceConnectionState;
  /** The API's workspace state (ready, suspended, provisioning, …), when known. */
  workspaceState: string | null;
  /** Raise the connection to `wake` after an interactive command. */
  wakeWorkspace?: () => void;
  /** Where this workspace's presence, notes and leases are kept (cloudCollab); defaults to its target key. */
  collabKey?: string;
  /** The agent view is the one on screen (presence reports its tab). */
  active?: boolean;
}) {
  const snapshot = useCloudAgents(scope);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = state.state === "connected";
  const manage = connected && state.authority === "manage";
  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}` : null;
  const key = collabKey ?? `cloud:${scope.organizationId}:${scope.workspaceId}`;
  const collab = useCollab(key);
  const you = effectiveYou(state, collab);
  const hidden = notShared(state, you);

  useEffect(() => {
    void loadCloudAgents(scope);
    return () => void flushCloudAgentCache(scope);
  }, [scope.organizationId, scope.workspaceId]);

  // The runtime's tab list, once per connection; then its broadcasts.
  useEffect(() => {
    if (!generation) return;
    let cancelled = false;
    const stop = watchLiveTabs(scope, client);
    void syncLiveTabs(scope, client).catch((e: unknown) => !cancelled && setError(errorText(e)));
    // Commands that waited for the runtime: learn their outcome now.
    startOutboxPolling(scope);
    return () => {
      cancelled = true;
      stop();
    };
  }, [generation, client, scope.organizationId, scope.workspaceId]);

  const tabs = snapshot.tabs;
  const active = tabs.find((tab) => tab.tabId === selected) ?? tabs[0] ?? null;

  // Others see which agent tab this person is on.
  const activeTabId = active?.tabId ?? null;
  useEffect(() => {
    if (shown && collab.available) presenceTab(key, activeTabId);
  }, [shown, collab.available, key, activeTabId]);

  if (hidden) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-agents">
        <NotSharedNotice />
      </div>
    );
  }

  const close = async (tab: CloudAgentTab) => {
    setError(null);
    try {
      await closeCloudAgentTab(scope, tab.tabId, client);
      if (selected === tab.tabId) setSelected(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-agents">
      <StatusBar state={state} tab={active} snapshot={snapshot} workspaceState={workspaceState} />
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline px-3 py-1" role="tablist" aria-label="Agent tabs">
        {tabs.map((tab, index) => (
          <div key={tab.tabId} className="flex items-center" data-testid="cloud-agent-tab">
            <Button
              size="sm"
              role="tab"
              aria-selected={tab.tabId === active?.tabId}
              variant={tab.tabId === active?.tabId ? "secondary" : "ghost"}
              onClick={() => setSelected(tab.tabId)}
            >
              <Bot className="size-3.5" /> {tabTitle(tab, index)}
              {tab.info.status === "in_progress" && tab.info.process !== "exited" && <Loader2 className="size-3 animate-spin" aria-label="working" />}
              {tab.unread && <span className="size-1.5 rounded-full bg-accent" data-testid="cloud-agent-unread" aria-label="unread" />}
            </Button>
            {manage && (
              <Button size="icon" variant="ghost" className="size-6" aria-label={`Close ${tabTitle(tab, index)}`} onClick={() => void close(tab)}>
                <X className="size-3" />
              </Button>
            )}
          </div>
        ))}
        {manage && (
          <Button size="sm" variant="ghost" aria-label="New agent tab" onClick={() => setCreating((open) => !open)}>
            <Plus className="size-3.5" /> Agent
          </Button>
        )}
      </div>
      {creating && manage && (
        <NewAgentForm
          onCancel={() => setCreating(false)}
          onCreate={async (params) => {
            setError(null);
            try {
              const tabId = await createCloudAgentTab(scope, client, params);
              setSelected(tabId);
              setCreating(false);
            } catch (e) {
              setError(errorText(e));
            }
          }}
        />
      )}
      {error && <p className="px-4 py-1 text-xs text-red-500">Agent: {error}</p>}
      {active ? (
        <CloudAgentPane
          key={active.tabId}
          scope={scope}
          tab={active}
          client={client}
          connected={connected}
          snapshot={snapshot}
          wakeWorkspace={wakeWorkspace}
          sleeping={!connected && (workspaceState === "suspended" || state.state === "suspended")}
          collabKey={key}
          you={connected && collab.available ? you : null}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {!snapshot.loaded ? (
            <Loader2 className="size-4 animate-spin" />
          ) : manage ? (
            "No agent tabs in this workspace yet. Start one with + Agent."
          ) : connected ? (
            "No agent tabs in this workspace."
          ) : (
            "Agent tabs appear here once the workspace is connected or has saved conversations."
          )}
        </div>
      )}
    </div>
  );
}

function tabTitle(tab: CloudAgentTab, index: number): string {
  if (tab.info.title) return tab.info.title;
  if (tab.placeholder) return `Saved chat ${index + 1}`;
  const name = tab.info.harness === "codex" ? "Codex" : tab.info.harness === "claude" ? "Claude" : tab.info.harness;
  return `${name} ${index + 1}`;
}

/** Connection, agent turn and provisioning, each on its own. */
function StatusBar({
  state,
  tab,
  snapshot,
  workspaceState,
}: {
  state: WorkspaceConnectionState;
  tab: CloudAgentTab | null;
  snapshot: CloudAgentsSnapshot;
  workspaceState: string | null;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1 text-[11px] text-muted-foreground">
      <Chip label="Connection" value={connectionLabel(state)} testId="cloud-agent-connection" />
      <Chip label="Agent" value={tab ? turnLabel(tab) : "No tab"} testId="cloud-agent-turn" />
      <Chip label="Workspace" value={provisioningLabel(workspaceState, snapshot.wake, state)} testId="cloud-agent-provisioning" />
    </div>
  );
}

function Chip({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5" data-testid={testId}>
      <span className="text-faint">{label}:</span> <span className="text-foreground">{value}</span>
    </span>
  );
}

export function connectionLabel(state: WorkspaceConnectionState): string {
  switch (state.state) {
    case "connected":
      return "Live";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "opening":
      return "Checking";
    case "waitingForRuntime":
      return "Waiting for runtime";
    case "suspended":
      return "Offline (workspace asleep)";
    case "updateRequired":
      return "Update required";
    case "stopped":
      return "Disconnected";
    default:
      return "Not connected";
  }
}

export function turnLabel(tab: CloudAgentTab): string {
  const { status, process } = tab.info;
  if (process === "exited" && (status === "in_progress" || status === "waiting")) return "Process ended mid-turn";
  if (process === "exited") return "Process ended";
  switch (status) {
    case "in_progress":
      return "Working";
    case "waiting":
      return "Needs your decision";
    case "completed":
      return "Finished";
    default:
      return process === "not-started" ? "Not started" : "Idle";
  }
}

export function provisioningLabel(workspaceState: string | null, wake: WakeResult | null, state: WorkspaceConnectionState): string {
  if (wake === "queued") return "Waking";
  if (wake === "in-progress" && state.state !== "connected") return "Starting";
  if (wake === "unavailable") return "Cannot wake (commands stay queued)";
  if (state.state === "waitingForRuntime") return "Starting";
  if (state.state === "connected") return "Ready";
  switch (workspaceState) {
    case "suspended":
      return "Asleep";
    case "archived":
      return "Archived (unarchive it to resume)";
    case "provisioning":
      return "Provisioning";
    case "ready":
      return "Ready";
    case null:
    case undefined:
      return "Unknown";
    default:
      return workspaceState;
  }
}

function NewAgentForm({
  onCreate,
  onCancel,
}: {
  onCreate: (params: { agent: string; model?: string; effort?: string | null; mode?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [agent, setAgent] = useState("claude");
  const models = useModels(agent);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState("manual");
  const [busy, setBusy] = useState(false);
  const chosen = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault);
  const select = "rounded-md border border-hairline bg-transparent px-2 py-1 text-xs";
  return (
    <form
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2 text-xs"
      data-testid="cloud-agent-new"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onCreate({ agent, model: model || undefined, effort: effort || undefined, mode }).finally(() => setBusy(false));
      }}
    >
      <select aria-label="Agent" className={select} value={agent} onChange={(e) => (setAgent(e.target.value), setModel(""), setEffort(""))}>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <select aria-label="Model" className={select} value={model} onChange={(e) => setModel(e.target.value)}>
        <option value="">Default model</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {!!chosen?.efforts.length && (
        <select aria-label="Effort" className={select} value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">Default effort</option>
          {chosen.efforts.map((e) => (
            <option key={e} value={e}>
              {EFFORT_LABEL[e] ?? e}
            </option>
          ))}
        </select>
      )}
      <select aria-label="Permission mode" className={select} value={mode} onChange={(e) => setMode(e.target.value)}>
        {PERMISSION_MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <Button size="sm" type="submit" disabled={busy}>
        Start agent
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

const KEY_MISSING = "cloud_agent_key_missing";

function commandError(e: unknown): string {
  const code = errorText(e);
  if (code === KEY_MISSING) return "Connect to this workspace once so this device can encrypt commands for it.";
  if (code === DEV_SCOPE_NOTICE) return DEV_SCOPE_NOTICE;
  if (code === "cloud_workspace_collaboration_forbidden") return "Your access to this workspace does not allow this. Ask an admin for driver or approver access.";
  return `Could not queue the command (${code}).`;
}

function CloudAgentPane({
  scope,
  tab,
  client,
  connected,
  snapshot,
  sleeping,
  wakeWorkspace,
  collabKey,
  you,
}: {
  scope: CloudAgentScope;
  tab: CloudAgentTab;
  client: WorkspaceRpcClient;
  connected: boolean;
  snapshot: CloudAgentsSnapshot;
  sleeping: boolean;
  wakeWorkspace?: () => void;
  collabKey: string;
  /** Set only while connected to a runtime with `collab/1`: sharing rules apply. */
  you: WorkspaceYou | null;
}) {
  const { info } = tab;
  const collab = useCollab(collabKey);
  const nameOf = usePeople();
  const [notesOpen, setNotesOpen] = useState(false);
  const lease = tab.tabId in collab.leases ? (collab.leases[tab.tabId] ?? null) : (info.lease ?? null);
  const now = useNowUntil(lease?.expiresAt);
  const turnRunning = (info.status === "in_progress" || info.status === "waiting") && info.process === "running";
  // The runtime keeps the holder's lease for as long as their turn runs.
  const liveLease = leaseLive(lease, now) || (lease && turnRunning) ? lease : null;
  const heldByOther = !!you && !!liveLease && liveLease.holderId !== you.userId;
  let blocked: string | null = null;
  if (you && !canDrive(you)) blocked = "You can view this workspace; ask an admin for driver access";
  else if (you && heldByOther)
    blocked =
      you.role === "manager"
        ? `${nameOf(liveLease!.holderId)} is driving this tab. Take over to send.`
        : `${nameOf(liveLease!.holderId)} is driving this tab. You can send once they release it.`;
  const mayStop = !you || you.role === "manager" || (!!liveLease && liveLease.holderId === you.userId) || (!liveLease && canDrive(you));
  const approveBlocked = you && !canApprove(you) ? "Waiting for someone who can approve" : null;
  const noteCount = collab.notes[tab.tabId]?.notes.length ?? 0;
  const log = useTabLog(info.sessionId, tab.tabId);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingCheckpoint, setLoadingCheckpoint] = useState(false);
  const exited = info.process === "exited";
  const live = (info.status === "in_progress" || info.status === "waiting") && !exited;
  const transcript = useMemo(() => buildTranscript(log.events, live), [log.events, log.version, live]);
  const entries = outboxFor(snapshot, tab.tabId);
  const turnOpen = transcript.turns.length > 0 && !transcript.turns[transcript.turns.length - 1]!.completed;
  const endedMidTurn = exited && (info.status === "in_progress" || info.status === "waiting" || turnOpen);
  const deciding = entries.some((entry) => entry.kind === "permission-decision" && !TERMINAL_OUTBOX_STATES.has(entry.state));
  const sessionKnown = !!info.sessionId;

  // Cache first (already loaded), then the checkpoint when it is newer.
  // Once the tab streams live the checkpoint is skipped.
  useEffect(() => {
    let cancelled = false;
    setLoadingCheckpoint(true);
    void refreshFromCheckpoint(scope, tab.tabId)
      .catch(() => undefined)
      .finally(() => !cancelled && setLoadingCheckpoint(false));
    return () => {
      cancelled = true;
    };
  }, [scope.organizationId, scope.workspaceId, tab.tabId]);

  // Live only while the runtime is already online: reading never wakes it.
  useEffect(() => {
    if (!connected || !sessionKnown) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void attachCloudAgentTab(scope, tab.tabId, client)
      .then((unsubscribe) => (cancelled ? unsubscribe() : (stop = unsubscribe)))
      .catch((e: unknown) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [connected, sessionKnown, client, scope.organizationId, scope.workspaceId, tab.tabId]);

  useEffect(() => {
    setViewing(scope, tab.tabId, true);
    return () => setViewing(scope, tab.tabId, false);
  }, [scope.organizationId, scope.workspaceId, tab.tabId]);

  // Looking at a finished tab reads it.
  useEffect(() => {
    if (tab.unread || info.status === "completed") void markCloudAgentRead(scope, tab.tabId, connected ? client : null);
  }, [tab.unread, info.status, connected, client, scope.organizationId, scope.workspaceId, tab.tabId]);

  const interactive = useCallback(
    async (run: () => Promise<unknown>) => {
      setError(null);
      try {
        await run();
        // The API already woke the workspace for this command; follow it so
        // the live stream attaches as soon as the runtime is back.
        if (sleeping) wakeWorkspace?.();
      } catch (e) {
        setError(commandError(e));
        throw e;
      }
    },
    [sleeping, wakeWorkspace],
  );

  const send = async (text: string, images: ImageInput[]) => {
    if (images.length) {
      setError("Images cannot be sent to cloud agent tabs yet.");
      throw new Error("images unsupported");
    }
    await interactive(() => sendToCloudAgent(scope, tab.tabId, text, connected ? client : null));
  };

  const steer = async () => {
    const text = draft.trim();
    if (!text) return;
    await interactive(() => steerCloudAgent(scope, tab.tabId, text, connected ? client : null)).then(() => setDraft(""), () => undefined);
  };

  const stop = () => {
    if (!mayStop) {
      setError("Only the person driving this tab or an admin can stop the agent.");
      return;
    }
    void interactive(() => stopCloudAgent(scope, tab.tabId, connected ? client : null)).catch(() => undefined);
  };

  const decide = (decision: { requestId: string; optionId: string } | { requestId: string; answers: Record<string, string> }) => {
    if (approveBlocked) return;
    void interactive(() => decideCloudAgent(scope, tab.tabId, decision, connected ? client : null)).catch(() => undefined);
  };

  const changeDraft = (text: string) => {
    setDraft(text);
    if (you && text) presenceTyping(collabKey);
  };

  const configure = (patch: { model?: string; effort?: string | null; mode?: string }) => {
    setError(null);
    void configureCloudAgentTab(scope, tab.tabId, patch, connected ? client : null).catch((e: unknown) => setError(errorText(e)));
  };

  const entry: TabEntry = {
    id: tab.tabId,
    harness: info.harness,
    title: info.title,
    model: info.model,
    effort: info.effort,
    permissionMode: info.permissionMode,
    status: info.status,
    created: info.created,
    modified: info.modified,
  };

  if (!sessionKnown) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" data-testid="cloud-agent-pane">
        {loadingCheckpoint ? "Loading the saved conversation…" : "This tab's saved conversation is not available on this device yet."}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1" data-testid="cloud-agent-pane">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {you && (
          <LeaseBar
            collabKey={collabKey}
            client={client}
            tabId={tab.tabId}
            lease={lease}
            turnRunning={turnRunning}
            you={you}
            notesOpen={notesOpen}
            onToggleNotes={() => setNotesOpen((open) => !open)}
            noteCount={noteCount}
          />
        )}
        {isDevScope(scope) && (
          <p className="border-b border-hairline px-3 py-1.5 text-xs text-muted-foreground" data-testid="cloud-agent-dev-notice">
            {DEV_SCOPE_NOTICE}
          </p>
        )}
        {endedMidTurn && (
          <p className="border-b border-hairline bg-warning/10 px-3 py-1.5 text-xs" data-testid="cloud-agent-exited">
            Agent process ended — the saved conversation resumes on your next message.
          </p>
        )}
        <Outbox
          entries={entries}
          followUps={info.followUps}
          nameOf={nameOf}
          onSendAgain={(e) => void interactive(() => sendAgain(scope, e, connected ? client : null)).catch(() => undefined)}
        />
        <div className="min-h-0 flex-1">
          <Chat
            sessionId={info.sessionId}
            transcript={transcript}
            stream={log.stream}
            live={live}
            progressing={live && !transcript.pendingAsks.length}
            answering={deciding}
            answerBlockedReason={approveBlocked}
            onAnswerPermission={(requestId, optionId) => decide({ requestId, optionId })}
            onAnswerQuestions={(requestId, answers) => decide({ requestId, answers })}
            footer={
              <div className="flex flex-col">
                {live && draft.trim() && !isDevScope(scope) && !blocked && (
                  <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 text-xs text-muted-foreground">
                    <span>Send now queues it for when the agent pauses.</span>
                    <Button size="xs" variant="outline" onClick={() => void steer()}>
                      Steer now
                    </Button>
                  </div>
                )}
                <Composer
                  tab={entry}
                  busy={live}
                  draft={draft}
                  onDraftChange={changeDraft}
                  onSend={send}
                  onStop={stop}
                  onSetModel={(model) => configure({ model })}
                  onSetEffort={(effort) => configure({ effort })}
                  onSetMode={(mode) => configure({ mode })}
                  disabled={!!blocked}
                  disabledReason={blocked ?? error}
                />
                {blocked && error && <p className="mx-auto w-full max-w-3xl px-4 pb-2 text-xs text-destructive">{error}</p>}
              </div>
            }
          />
        </div>
      </div>
      {you && notesOpen && <NotesPanel collabKey={collabKey} client={client} tabId={tab.tabId} onClose={() => setNotesOpen(false)} />}
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  unsent: "Not sent yet — will retry",
  queued: "Queued for the workspace",
  leased: "Delivering to the agent",
  applied: "Delivered",
  rejected: "Not delivered",
  cancelled: "Cancelled",
  "outcome-unknown": "May not have been sent",
};

const KIND_TEXT: Record<string, string> = { send: "Message", steer: "Steer", stop: "Stop", "permission-decision": "Decision" };

/** Commands on their way, and the ones whose fate needs the reader. */
function Outbox({
  entries,
  followUps,
  nameOf,
  onSendAgain,
}: {
  entries: OutboxEntry[];
  followUps: { clientCommandId: string; text: string; actorId?: string | null }[];
  nameOf: (userId: string | null | undefined) => string;
  onSendAgain: (entry: OutboxEntry) => void;
}) {
  const queuedIds = new Set(followUps.map((f) => f.clientCommandId));
  // Settled commands the transcript already shows are not repeated here.
  const shown = entries.filter(
    (entry) => !TERMINAL_OUTBOX_STATES.has(entry.state) || entry.state === "rejected" || entry.state === "outcome-unknown",
  );
  if (!shown.length && !followUps.length) return null;
  return (
    <ul className="flex shrink-0 flex-col gap-1 border-b border-hairline px-3 py-1.5 text-xs" data-testid="cloud-agent-outbox">
      {followUps.map((f) => (
        <li key={`f-${f.clientCommandId}`} className="flex items-center gap-2" data-testid="cloud-agent-followup">
          <span className="text-muted-foreground">Queued follow-up{f.actorId ? ` from ${nameOf(f.actorId)}` : ""}:</span>
          <span className="min-w-0 truncate">{f.text}</span>
          <span className="ml-auto text-faint">sends when the agent finishes its turn</span>
        </li>
      ))}
      {shown
        .filter((entry) => !queuedIds.has(entry.clientCommandId))
        .map((entry) => (
          <li
            key={entry.clientCommandId}
            className={cn("flex items-center gap-2", entry.state === "outcome-unknown" && "text-warning")}
            data-testid="cloud-agent-command"
            data-state={entry.state}
          >
            <span className="text-muted-foreground">{KIND_TEXT[entry.kind] ?? entry.kind}:</span>
            {entry.text && <span className="min-w-0 truncate">{entry.text}</span>}
            <span className="ml-auto shrink-0">{outboxStateText(entry, nameOf)}</span>
            {entry.state === "outcome-unknown" && entry.kind !== "permission-decision" && (
              <Button size="xs" variant="outline" onClick={() => onSendAgain(entry)}>
                Send again
              </Button>
            )}
          </li>
        ))}
    </ul>
  );
}

/** A command's state, in words; a refusal because of sharing says whose turn it is. */
function outboxStateText(entry: OutboxEntry, nameOf: (userId: string | null | undefined) => string): string {
  if (entry.state === "rejected" && entry.category === "lease-held") {
    const holder = entry.receipt?.holderId;
    return `${typeof holder === "string" ? nameOf(holder) : "Someone else"} is driving — your message was not sent`;
  }
  if (entry.state === "rejected" && entry.category === "access-revoked") return "Not sent: your access changed";
  const text = STATE_TEXT[entry.state] ?? entry.state;
  return entry.state === "rejected" && entry.category ? `${text} (${entry.category})` : text;
}
