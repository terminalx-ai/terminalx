import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Plus, X } from "lucide-react";
import type { AgentTabInfo, WorkspaceConnectionState, WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import { Chat } from "@/components/chat/Chat";
import { Composer } from "@/components/chat/Composer";
import { sentMessages } from "@/components/chat/useComposerHistory";
import { Button } from "@/components/ui/button";
import { runningLimitReached } from "@/lib/runningLimit";
import { useAccount } from "@/lib/account";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { AGENT_LOGIN_PLACE } from "@/lib/cloudCreate";
import { mayStartCloudSessions } from "@/lib/multiOrg";
import { useTabLog } from "@/lib/agentEvents";
import { buildTranscript } from "@/lib/transcript";
import { DEFAULT_PERMISSION_MODE, EFFORT_LABEL, PERMISSION_MODES, modelOptionText, offeredOn, useModels } from "@/lib/models";
import {
  attachCloudAgentTab,
  closeCloudAgentTab,
  configureCloudAgentTab,
  discardPendingConfig,
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
import { SETTINGS_IGNORED_REASON, SETTINGS_LOCKED_REASON, SETTINGS_WITH_NEXT_MESSAGE, sharingKnown, effectiveYou, knownYou, notShared, presenceTab, presenceTyping, tabGate, useCollab } from "@/lib/cloudCollab";
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
  waking = false,
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
  /** This window asked for the workspace to be woken (it was opened with a resume, or a command went out). */
  waking?: boolean;
  /** Where this workspace's presence, notes and leases are kept (cloudCollab); defaults to its target key. */
  collabKey?: string;
  /** The agent view is the one on screen (presence reports its tab). */
  active?: boolean;
}) {
  const snapshot = useCloudAgents(scope);
  const { status: account } = useAccount();
  const mayManage = mayStartCloudSessions(account, scope.organizationId);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = state.state === "connected";
  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}` : null;
  const key = collabKey ?? `cloud:${scope.organizationId}:${scope.workspaceId}`;
  const collab = useCollab(key);
  const you = effectiveYou(state, collab);
  // New tabs are a manager's; a demoted admin's manage attachment is not.
  const manage = connected && state.authority === "manage" && (!collab.available || !sharingKnown(you) || you.role === "manager");
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
      <StatusBar state={state} tab={active} snapshot={snapshot} workspaceState={workspaceState} orgId={scope.organizationId} waking={waking} />
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
              {tab.info.status === "in_progress" && tab.info.process !== "exited" && !tab.info.signIn && <Loader2 className="size-3 animate-spin" aria-label="working" />}
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
      {active?.info.signIn && (
        <p className="border-b border-hairline px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400" role="status" data-testid="cloud-agent-sign-in">
          {signInMessage(active.info, mayManage)}
        </p>
      )}
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
          you={knownYou(state, collab)}
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
  orgId,
  waking,
}: {
  state: WorkspaceConnectionState;
  tab: CloudAgentTab | null;
  snapshot: CloudAgentsSnapshot;
  workspaceState: string | null;
  orgId: string;
  waking: boolean;
}) {
  // Somebody is waking it: this window, or a command the server woke it for. A wake the server refused is not one.
  const wakingNow = snapshot.wake !== "unavailable" && (waking || snapshot.wake === "queued" || snapshot.wake === "in-progress");
  const asleep = stoppedAndStaying(state, workspaceState, wakingNow);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1 text-[11px] text-muted-foreground">
      <Chip label="Connection" value={connectionLabel(state, asleep ? (workspaceState === "archived" ? "archived" : "asleep") : false)} testId="cloud-agent-connection" />
      <Chip label="Agent" value={tab ? turnLabel(tab) : "No tab"} testId="cloud-agent-turn" />
      <Chip
        label="Workspace"
        value={provisioningLabel(workspaceState, snapshot.wake, state, snapshot.wake === "unavailable" && runningLimitReached(orgId), wakingNow)}
        testId="cloud-agent-provisioning"
      />
    </div>
  );
}

/** The connection is still trying to attach (each try reads "opening", then "waitingForRuntime" again). */
function attaching(state: WorkspaceConnectionState): boolean {
  return state.state === "opening" || state.state === "waitingForRuntime";
}

/**
 * The workspace is stopped and nothing is waking it. The connection keeps
 * trying in the background, which used to flip both chips every few seconds
 * ("Asleep"/"Starting", "Checking"/"Waiting for runtime"); a stopped
 * workspace reads one way until someone resumes it. An archived workspace
 * opened to read is stopped the same way.
 */
export function stoppedAndStaying(state: WorkspaceConnectionState, workspaceState: string | null, waking: boolean): boolean {
  if (waking || state.state === "connected") return false;
  const stopped = workspaceState === "suspended" || workspaceState === "archived";
  return state.state === "suspended" || (stopped && (attaching(state) || state.state === "idle"));
}

function Chip({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5" data-testid={testId}>
      <span className="text-faint">{label}:</span> <span className="text-foreground">{value}</span>
    </span>
  );
}

export function connectionLabel(state: WorkspaceConnectionState, stopped: false | "asleep" | "archived" = false): string {
  if (stopped) return stopped === "archived" ? "Offline (workspace archived)" : "Offline (workspace asleep)";
  switch (state.state) {
    case "connected":
      return "Live";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    // One wait, however many times the connection asks again.
    case "opening":
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

/**
 * What to tell someone whose agent has no way to sign in (PRO-78): what is
 * wrong and who can fix it where. `mayManage` is the viewer's owner-or-admin
 * role in the organization, null while it is not known.
 */
export function signInMessage(info: Pick<AgentTabInfo, "harness" | "signIn">, mayManage: boolean | null): string | null {
  const signIn = info.signIn;
  if (!signIn) return null;
  const agent = cloudAgentLabel(info.harness);
  const what =
    signIn.reason === "token-expired"
      ? `The organization's ${agent} login has expired`
      : signIn.reason === "shared-use-policy"
        ? `The organization's ${agent} login is limited to workspaces its owners and admins create`
        : signIn.state === "not-connected"
          ? `${agent} isn't connected for this organization`
          : `The organization's ${agent} login is ${signIn.state === "unavailable" ? "not available" : signIn.state}`;
  const fix =
    signIn.reason === "shared-use-policy"
      ? mayManage
        ? `Allow it for the whole organization in ${AGENT_LOGIN_PLACE}.`
        : "An owner or admin can allow it for the whole organization."
      : mayManage
        ? `Connect it in ${AGENT_LOGIN_PLACE}, then send again.`
        : "Ask an owner or admin to connect it, then send again.";
  return `Needs sign-in: ${what}, so it can't take prompts here. ${fix}`;
}

export function turnLabel(tab: CloudAgentTab): string {
  const { status, process } = tab.info;
  if (tab.info.signIn) return "Needs sign-in";
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

/**
 * `runningLimitReached`: the server does not say why a wake was unavailable,
 * but when the organization's last list shows its running limit reached,
 * that is the likely reason, and stopping a workspace is the way out.
 */
export function provisioningLabel(workspaceState: string | null, wake: WakeResult | null, state: WorkspaceConnectionState, runningLimitReached = false, waking = false): string {
  if (wake === "queued") return "Waking";
  if (wake === "in-progress" && state.state !== "connected") return "Starting";
  if (wake === "unavailable" && runningLimitReached) return "Cannot wake: the running limit is reached. Stop a workspace (commands stay queued)";
  if (wake === "unavailable") return "Cannot wake (commands stay queued)";
  // A running workspace this window is still attaching to is Ready, not starting,
  // and a stopped one nobody is waking stays Asleep.
  const stopped = workspaceState === "suspended" || workspaceState === "archived";
  if (attaching(state) && workspaceState !== "ready" && (!stopped || waking)) return "Starting";
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
  // Aliases only: this list is the desktop's, and the workspace's CLI may not run a version pinned from it.
  const models = offeredOn(useModels(agent), false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState(DEFAULT_PERMISSION_MODE);
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
            {modelOptionText(m, models, false)}
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
const KEY_STORE_UNAVAILABLE = "cloud_agent_key_store_unavailable";

export function commandError(e: unknown): string {
  const code = errorText(e);
  if (code === KEY_MISSING) return "Connect to this workspace once so this device can encrypt commands for it.";
  // The key is there but could not be read: connecting again would not help.
  if (code === KEY_STORE_UNAVAILABLE) {
    return "This device could not read its key for this workspace from the system key store (the Keychain on a Mac), so the command was not sent. Unlock the key store or allow TerminalX to use it, then send again.";
  }
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
  const { blocked, mayStop, approveBlocked, mayConfigure } = tabGate(you, lease, now, turnRunning, nameOf);
  // Presence, the lease bar and notes need the live runtime; `you` alone may
  // be the last known access of a sleeping workspace.
  const collabLive = connected && collab.available && !!you;
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
    // Settings chosen while this person could approve are not sent once they cannot.
    if (!mayConfigure) discardPendingConfig(scope, tab.tabId);
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
    if (collabLive && text) presenceTyping(collabKey);
  };

  const configure = (patch: { model?: string; effort?: string | null; mode?: string }) => {
    if (!mayConfigure) return;
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
        {collabLive && (
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
            unreadNotes={collab.unreadNotes[tab.tabId] ?? 0}
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
        <CloudOutbox
          entries={entries}
          followUps={info.followUps}
          nameOf={nameOf}
          onSendAgain={(e) => void interactive(() => sendAgain(scope, e, connected ? client : null)).catch(() => undefined)}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <Chat
            sessionId={info.sessionId}
            transcript={transcript}
            stream={log.stream}
            live={live}
            progressing={live && !transcript.pendingAsks.length}
            answering={deciding}
            answerBlockedReason={approveBlocked}
            askDetail={!!you}
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
                  history={sentMessages(transcript, { entries, followUps: info.followUps })}
                  onStop={stop}
                  onSetModel={(model) => configure({ model })}
                  onSetEffort={(effort) => configure({ effort })}
                  onSetMode={(mode) => configure({ mode })}
                  reportedModel={transcript.model}
                  modelsAreLocal={false}
                  disabled={!!blocked}
                  settingsLockedReason={mayConfigure ? null : SETTINGS_LOCKED_REASON}
                  settingsNote={tab.settingsIgnored ? SETTINGS_IGNORED_REASON : tab.pendingConfig && mayConfigure ? SETTINGS_WITH_NEXT_MESSAGE : null}
                  settingsNoteWarning={!!tab.settingsIgnored}
                  canStop={mayStop}
                  disabledReason={blocked ?? error}
                />
                {blocked && error && <p className="mx-auto w-full max-w-3xl px-4 pb-2 text-xs text-destructive">{error}</p>}
              </div>
            }
          />
        </div>
      </div>
      {collabLive && notesOpen && <NotesPanel collabKey={collabKey} client={client} tabId={tab.tabId} onClose={() => setNotesOpen(false)} />}
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
export function CloudOutbox({
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
