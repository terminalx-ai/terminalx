import { usePipelineLaunch, pipelineSettings } from "@/lib/pipelineLaunch";
import { useCallback, useEffect, useState, useRef } from "react";
import { Bot, ChevronDown, Folder, Loader2, Plus, X } from "@/icons";
import type { AgentTabInfo, WorkspaceConnectionState, WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import { Chat } from "@/components/chat/Chat";
import { CloudPendingMessages, outboxStateText, usePendingCloudMessages } from "./CloudPendingMessages";
import { isMessageCommand } from "@/lib/cloudPendingMessages";
import { Composer } from "@/components/chat/Composer";
import { goalCommand } from "@/lib/goalCommand";
import { sentMessages } from "@/components/chat/useComposerHistory";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { runningLimitReached } from "@/lib/runningLimit";
import { useAccount } from "@/lib/account";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { AGENT_LOGIN_PLACE } from "@/lib/cloudCreate";
import { AgentLoginsLink } from "./AgentLoginsLink";
import { managesOrganization } from "@/lib/multiOrg";
import { openAgentLogins } from "@/lib/settingsLinks";
import type { AgentLoginProvider } from "@/lib/api";
import { lastSeq, useTabLog } from "@/lib/agentEvents";
import { hasArrived, useComposerSend } from "@/lib/composerSends";
import { setDraft as setTabDraft, useDraft } from "@/lib/drafts";
import { useConversationView } from "@/lib/conversationView";
import { SessionAgentControls } from "@/components/session/SessionAgentControls";
import { useSessionStore } from "@/lib/sessions";
import { machineAgentSignInReason, useRuntimeModels } from "@/lib/cloudModels";
import { launchDefaults, useSessionAgent } from "@/lib/useSessionAgent";
import {
  attachCloudAgentTab,
  closeCloudAgentTab,
  configureCloudAgentTab,
  discardPendingConfig,
  createCloudAgentTab,
  getCloudAgents,
  decideCloudAgent,
  DEV_SCOPE_NOTICE,
  errorText,
  isDevScope,
  takesLiveCommands,
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
import { useMachinePlace } from "./workspacePlace";
import { CLOUD_IMAGES_NEED_RUNNING, CloudImageError, cloudComposerCommands, cloudComposerFiles, cloudImagesBlocked } from "@/lib/cloudComposer";
import { LeaseBar, NotesPanel, NotSharedNotice, useNowUntil } from "./CloudCollab";

/** A session to bring to the front of the agent view: its tab, or (null) the session's first tab. */
export interface AgentFocus {
  sessionId: string;
  tabId: string | null;
}

/**
 * The projects a new agent tab may be created in: a paired machine's
 * (PRO-346), where `session.create` needs a `projectId`. A cloud workspace has
 * none and passes nothing.
 */
export interface AgentProjects {
  projects: { projectId: string; name: string }[];
  /** The project the form starts on when opened with + Agent: the focused session's. */
  preferred: string | null;
  /** Open the form on this project (the sidebar's +); spent once the form has opened. */
  request: { projectId: string; nonce: number } | null;
  onRequestTaken: () => void;
  /** A session was created in a project: the machine selects its row. */
  onCreated: (sessionId: string, projectId: string) => void;
  /** The machine, to name an agent not signed in there and open its page (PRO-350). */
  machine?: { name: string; openPage: () => void } | null;
}

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
  focus = null,
  projects = null,
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
  /** Bring this session's tab to the front once it is listed; a later change of focus does it again. */
  focus?: AgentFocus | null;
  /** A machine's projects: the new-agent form picks one. */
  projects?: AgentProjects | null;
}) {
  const snapshot = useCloudAgents(scope);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = state.state === "connected";
  const machine = useMachinePlace();
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

  // The sidebar's + on a machine opens the form on the project it chose.
  const [formProject, setFormProject] = useState<string | null>(null);
  const requestNonce = projects?.request?.nonce ?? null;
  useEffect(() => {
    if (!projects?.request) return;
    setFormProject(projects.request.projectId);
    setCreating(true);
    projects.onRequestTaken();
  }, [requestNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = snapshot.tabs;
  // Applied once per focus, when its tab is listed: choosing another tab afterwards is not undone by later updates.
  const focused = useRef<string | null>(null);
  const focusKey = focus ? `${focus.sessionId}/${focus.tabId ?? ""}` : null;
  useEffect(() => {
    if (!focus || focused.current === focusKey) return;
    const tab = (focus.tabId ? tabs.find((item) => item.tabId === focus.tabId) : undefined) ?? tabs.find((item) => item.info.sessionId === focus.sessionId);
    if (!tab) return;
    focused.current = focusKey;
    setSelected(tab.tabId);
  }, [focusKey, tabs]);
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
          <Button
            size="sm"
            variant="ghost"
            aria-label="New agent tab"
            onClick={() => {
              if (!creating) setFormProject(projects?.preferred ?? null);
              setCreating((open) => !open);
            }}
          >
            <Plus className="size-3.5" /> Agent
          </Button>
        )}
      </div>
      {creating && manage && (
        <NewAgentForm
          client={workspaceState === "suspended" || workspaceState === "archived" ? null : client}
          projects={projects?.projects ?? null}
          machine={projects?.machine ?? null}
          project={formProject}
          onProject={setFormProject}
          onCancel={() => setCreating(false)}
          onCreate={async (params) => {
            setError(null);
            try {
              const tabId = await createCloudAgentTab(scope, client, params);
              setSelected(tabId);
              setCreating(false);
              const sessionId = getCloudAgents(scope).tabs.find((tab) => tab.tabId === tabId)?.info.sessionId;
              if (params.projectId && sessionId) projects?.onCreated(sessionId, params.projectId);
            } catch (e) {
              setError(errorText(e));
            }
          }}
        />
      )}
      {error && <p className="px-4 py-1 text-xs text-red-500">Agent: {error}</p>}
      {active && <SignInNotice info={active.info} organizationId={scope.organizationId} />}
      {active ? (
        <CloudAgentPane
          key={active.tabId}
          active={shown}
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
            machine ? `No agent tabs on ${machine.name} yet. Start one with + Agent.` : "No agent tabs in this workspace yet. Start one with + Agent."
          ) : connected ? (
            machine ? `No agent tabs on ${machine.name}.` : "No agent tabs in this workspace."
          ) : machine ? (
            `Agent tabs appear here once ${machine.name} is connected or has saved conversations.`
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
  // On a paired machine the chip follows the machine's own state: Offline, not the transport's Reconnecting.
  const machine = useMachinePlace();
  const connection = machine && state.state !== "connected" ? machine.label : connectionLabel(state, asleep ? (workspaceState === "archived" ? "archived" : "asleep") : false);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1 text-[11px] text-muted-foreground">
      <Chip label="Connection" value={connection} testId="cloud-agent-connection" />
      <Chip label="Agent" value={tab ? turnLabel(tab) : "No tab"} testId="cloud-agent-turn" />
      {/* A paired machine is not provisioned, woken or put to sleep from here: it has no such state to show. */}
      {!machine && (
        <Chip
          label="Workspace"
          value={provisioningLabel(workspaceState, snapshot.wake, state, snapshot.wake === "unavailable" && runningLimitReached(orgId), wakingNow)}
          testId="cloud-agent-provisioning"
        />
      )}
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
/** The server's words for a login it will not hand out. A word this app does not know is never shown as is. */
const SIGN_IN_STATES: Record<string, string> = {
  revoked: "was revoked",
  disconnected: "was disconnected",
  unavailable: "is not available",
};

/** Why a creator's own route (PRO-18) gives this tab's agent nothing: never replaced by the organization's login. */
const ROUTE_REASONS: Record<string, string> = {
  "route-shared-workspace":
    "its route's stored credential is personal and is never sent to a workspace others can drive. The workspace's creator can switch it to a credential helper or back to the organization login",
  "route-runtime-unsupported": "this workspace's TerminalX is too old for its route. Restart the workspace to update it",
  "route-template-unsupported": "this workspace's TerminalX does not apply its route's endpoint type. Restart the workspace to update it, or set the route up again",
  "route-unavailable": "its route's stored credential could not be read. Its creator can enter it again",
  "route-creator-left": "its route belongs to someone who is no longer a member",
};

/**
 * The login the provider no longer accepts (#667): the server's `sign-in-required` (terminalx-saas #241), or the
 * runtime's own word for a grant an agent here was refused with.
 */
export const SIGN_IN_REQUIRED = "sign-in-required";

/** The agents whose organization login is signed in again (rather than replaced with a key): Settings opens their sign-in. */
const SIGNS_IN_AGAIN: Record<string, AgentLoginProvider> = { claude: "claude", codex: "codex" };

/** The agent `info`'s tab may be signed in again for, by someone who may: null when it is not a refused login. */
export function signInAgain(info: Pick<AgentTabInfo, "signIn">, mayManage: boolean | null): AgentLoginProvider | null {
  return info.signIn?.state === SIGN_IN_REQUIRED && mayManage ? (SIGNS_IN_AGAIN[info.signIn.provider] ?? null) : null;
}

export function signInMessage(info: Pick<AgentTabInfo, "harness" | "signIn">, mayManage: boolean | null, organization?: string | null): string | null {
  const signIn = info.signIn;
  if (!signIn) return null;
  const agent = cloudAgentLabel(info.harness);
  const route = signIn.reason ? ROUTE_REASONS[signIn.reason] : undefined;
  if (route) return `Needs sign-in: ${agent} uses its own route in this workspace, and ${route} (Settings → Organizations → Your model access).`;
  if (signIn.state === SIGN_IN_REQUIRED) {
    const what = `${agent} sign-in for ${organization?.trim() || "this organization"} was revoked or expired`;
    const fix = !mayManage
      ? "Ask an owner or admin to sign it in again, then send again."
      : SIGNS_IN_AGAIN[signIn.provider]
        ? "Sign in again, then start the agent or send again."
        : `Connect it again in ${AGENT_LOGIN_PLACE}, then send again.`;
    return `${what}, so it can't take prompts here. ${fix}`;
  }
  const what =
    signIn.reason === "token-expired"
      ? `The organization's ${agent} login has expired`
      : signIn.reason === "shared-use-policy"
        ? `The organization's ${agent} login is limited to its owners and admins`
        : signIn.state === "not-connected"
          ? `${agent} isn't connected for this organization`
          : `The organization's ${agent} login ${SIGN_IN_STATES[signIn.state] ?? "is not available"}`;
  const fix =
    signIn.reason === "shared-use-policy"
      ? mayManage
        ? "Allow it for the whole organization in the web console under Compute setup → Agent logins."
        : "An owner or admin can allow it for the whole organization."
      : mayManage
        ? `Connect it in ${AGENT_LOGIN_PLACE}, then send again.`
        : "Ask an owner or admin to connect it, then send again.";
  return `Needs sign-in: ${what}, so it can't take prompts here. ${fix}`;
}

/**
 * The notice over a cloud agent tab whose agent has no way to sign in
 * (PRO-78), with the way to `organizationId`'s Agent logins for someone who
 * may connect one. Nothing for a tab whose agent can sign in.
 */
export function SignInNotice({ info, organizationId }: { info: Pick<AgentTabInfo, "harness" | "signIn">; organizationId: string }) {
  const { status: account } = useAccount();
  // Who connects a login is an owner or admin, which is not who may start a session (any member, PRO-73).
  const mayManage = managesOrganization(account, organizationId);
  const organization = account.state === "signed-in" ? account.organizations?.find((org) => org.id === organizationId)?.name : null;
  const message = signInMessage(info, mayManage, organization);
  if (!message) return null;
  // A login the provider refused is signed in again where its organization's logins are, at that agent's sign-in (#667).
  const again = signInAgain(info, mayManage);
  return (
    <p className="border-b border-hairline px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400" role="status" data-testid="cloud-agent-sign-in">
      {message}{" "}
      {again ? (
        <Button type="button" size="xs" className="ml-1 align-baseline" data-testid="cloud-agent-sign-in-again" onClick={() => openAgentLogins(organizationId, again)}>
          Sign in again
        </Button>
      ) : (
        <AgentLoginsLink message={message} organizationId={organizationId} className="ml-1 align-baseline" />
      )}
    </p>
  );
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

/** Another agent in this workspace, with the same launch settings New Session offers for the cloud. */
function NewAgentForm({
  client,
  projects = null,
  machine = null,
  project = null,
  onProject,
  onCreate,
  onCancel,
}: {
  client: WorkspaceRpcClient | null;
  /** A machine's projects: one must be chosen before the agent can start. */
  projects?: AgentProjects["projects"] | null;
  /** The machine it starts on: an agent not signed in there is named, with a way to its page. */
  machine?: AgentProjects["machine"];
  project?: string | null;
  onProject?: (projectId: string) => void;
  onCreate: (params: { agent: string; model?: string; effort?: string | null; mode?: string; projectId?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { harnesses } = useSessionStore();
  const [launch, setLaunch] = useState(launchDefaults);
  // The workspace's own models once it answers; until then the cloud's aliases.
  const selection = useSessionAgent(harnesses, false, client, { value: launch, onChange: setLaunch });
  const pipelineLaunch = usePipelineLaunch(null, pipelineSettings(null), "This session starts on the base checkout. Start a worktree session from the cloud project to automate conflicts.", "Cloud workspaces require a person to merge.");
  const { harness, modelId, effort, mode } = selection;
  const [busy, setBusy] = useState(false);
  // A project the machine no longer lists is no choice.
  const chosen = projects ? (projects.find((entry) => entry.projectId === project) ?? (projects.length === 1 ? projects[0] : null)) : null;
  const missingProject = !!projects && !chosen;
  // The machine's own word on the chosen agent's sign-in; a cloud workspace has none to give here.
  const runtime = useRuntimeModels(machine ? client : null);
  const signInReason = machine ? machineAgentSignInReason(runtime?.agents, harness?.id, machine.name) : null;
  return (
    <form
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-hairline px-3 py-2 text-xs"
      data-testid="cloud-agent-new"
      data-project={chosen?.projectId}
      onSubmit={(event) => {
        event.preventDefault();
        if (!harness || missingProject) return;
        setBusy(true);
        void onCreate({ agent: harness.id, model: modelId || undefined, effort, mode, ...(chosen ? { projectId: chosen.projectId } : {}) }).finally(() => setBusy(false));
      }}
    >
      {projects && <ProjectPicker projects={projects} chosen={chosen} onProject={(id) => onProject?.(id)} />}
      <SessionAgentControls selection={selection} pipeline={pipelineLaunch} />
      <Button size="sm" type="submit" disabled={busy || !harness || missingProject} title={missingProject ? "Choose a project first" : undefined}>
        Start agent
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {signInReason && machine && (
        <p className="flex w-full flex-wrap items-center gap-x-2 text-[12px] text-warning" role="status" data-testid="agent-sign-in-reason">
          <span>{signInReason}</span>
          <Button size="xs" type="button" variant="link" className="h-auto px-0 text-[12px]" onClick={machine.openPage}>
            Open machine page
          </Button>
        </p>
      )}
    </form>
  );
}

/** Which of a machine's projects the new agent starts in. */
function ProjectPicker({ projects, chosen, onProject }: { projects: AgentProjects["projects"]; chosen: AgentProjects["projects"][number] | null; onProject: (projectId: string) => void }) {
  const menu = useRowMenu();
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <Button variant="secondary" size="sm" className="min-w-0 max-w-full shrink gap-1.5" title="Project" aria-label={chosen ? `Project: ${chosen.name}` : "Choose a project"} data-testid="agent-project">
          <Folder className="size-3.5 text-faint" />
          <span className="truncate">{chosen?.name ?? "Choose a project"}</span>
          <ChevronDown className="text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        {projects.length === 0 && <DropdownMenuLabel className="font-normal text-faint">This machine lists no projects.</DropdownMenuLabel>}
        <DropdownMenuRadioGroup value={chosen?.projectId ?? ""} onValueChange={onProject}>
          {projects.map((entry) => (
            <DropdownMenuRadioItem key={entry.projectId} value={entry.projectId}>
              <span className="truncate">{entry.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const KEY_MISSING = "cloud_agent_key_missing";
const KEY_STORE_UNAVAILABLE = "cloud_agent_key_store_unavailable";

export function commandError(e: unknown): string {
  // Why a message's images did not go, already in words.
  if (e instanceof CloudImageError) return e.message;
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
  active,
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
  active: boolean;
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
  // The tab's draft, the session view's too; kept with the tab's cache across a relaunch.
  const draft = useDraft(tab.tabId);
  const setDraft = (text: string) => setTabDraft(tab.tabId, text);
  const [error, setError] = useState<string | null>(null);
  const [loadingCheckpoint, setLoadingCheckpoint] = useState(false);
  const exited = info.process === "exited";
  const live = (info.status === "in_progress" || info.status === "waiting") && !exited;
  // Built on as the log grows, not again for every event (#727).
  const conversation = useConversationView(log, undefined);
  const transcript = conversation.transcript(live);
  // The composer's message on its way, drawn in the chat as sending (#727). Its scope is the tab's id.
  const pendingMessage = useComposerSend(tab.tabId).pending?.message ?? null;
  const sending = pendingMessage && !hasArrived(conversation.events(), pendingMessage) ? pendingMessage : null;
  const entries = outboxFor(snapshot, tab.tabId);
  // #1291: messages on their way, drawn at the transcript's end as Queued cards until the conversation has them.
  const pendingMessages = usePendingCloudMessages(entries, info.followUps, conversation.events());
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
  const resend = (entry: OutboxEntry) => void interactive(() => sendAgain(scope, entry, connected ? client : null)).catch(() => undefined);

  const send = async (text: string, images: ImageInput[]) => {
    // Images are uploaded straight to the runtime: a stopped workspace is started for them and the message stays here.
    const imagesBlocked = images.length ? cloudImagesBlocked(connected ? client : null, sleeping) : null;
    if (imagesBlocked) {
      setError(imagesBlocked);
      if (imagesBlocked === CLOUD_IMAGES_NEED_RUNNING && sleeping) wakeWorkspace?.();
      throw new CloudImageError(imagesBlocked);
    }
    // Settings chosen while this person could approve are not sent once they cannot.
    if (!mayConfigure) discardPendingConfig(scope, tab.tabId);
    await interactive(() => sendToCloudAgent(scope, tab.tabId, text, connected ? client : null, images));
  };

  const steer = async () => {
    const text = draft.trim();
    // A /goal is checked as it is sent (PRO-380): never steered past that check.
    if (!text || goalCommand(text) !== null) return;
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
    requestedModel: info.requestedModel,
    requestedEffort: info.requestedEffort,
    permissionMode: info.permissionMode,
    requestedPermissionMode: info.requestedPermissionMode,
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
        {isDevScope(scope) && connected && !takesLiveCommands(scope, client) && (
          <p className="border-b border-hairline px-3 py-1.5 text-xs text-muted-foreground" data-testid="cloud-agent-dev-notice">
            {DEV_SCOPE_NOTICE}
          </p>
        )}
        {endedMidTurn && (
          <p className="border-b border-hairline bg-warning/10 px-3 py-1.5 text-xs" data-testid="cloud-agent-exited">
            Agent process ended — the saved conversation resumes on your next message.
          </p>
        )}
        <CloudOutbox entries={entries} nameOf={nameOf} onSendAgain={resend} />
        <div className="flex min-h-0 flex-1 flex-col">
          <Chat
            active={active}
            sessionId={info.sessionId}
            tabId={tab.tabId}
            transcript={transcript}
            stream={log.stream}
            live={live}
            progressing={live && !transcript.pendingAsks.length}
            answering={deciding}
            answerBlockedReason={approveBlocked}
            askDetail={!!you}
            onAnswerPermission={(requestId, optionId) => decide({ requestId, optionId })}
            onAnswerQuestions={(requestId, answers) => decide({ requestId, answers })}
            sending={sending}
            pending={
              pendingMessages.length > 0 && <CloudPendingMessages
                messages={pendingMessages}
                // This pane has no header chip: connected is live; else the mailbox says whether the machine is starting.
                workspace={connected ? "live" : sleeping ? "stopped" : "connecting"}
                nameOf={nameOf}
                onSendAgain={blocked ? undefined : resend}
              />
            }
            footer={
              <div className="flex flex-col">
                {live && draft.trim() && goalCommand(draft) === null && (!isDevScope(scope) || takesLiveCommands(scope, connected ? client : null)) && !blocked && (
                  <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 text-xs text-muted-foreground">
                    <span>Send now queues it for when the agent pauses.</span>
                    <Button size="xs" variant="outline" onClick={() => void steer()}>
                      Steer now
                    </Button>
                  </div>
                )}
                <Composer
                  tab={entry}
                  commands={
                    info.sessionId && !blocked
                      ? cloudComposerCommands({ workspaceKey: collabKey, sessionId: info.sessionId, tabId: tab.tabId, harness: entry.harness, client: connected ? client : null, you })
                      : null
                  }
                  files={info.sessionId && !blocked ? cloudComposerFiles({ workspaceKey: collabKey, sessionId: info.sessionId, client: connected ? client : null }) : null}
                  remote
                  busy={live}
                  draft={draft}
                  onDraftChange={changeDraft}
                  onSend={send}
                  sentAfter={() => lastSeq(info.sessionId, tab.tabId)}
                  history={sentMessages(transcript, { entries, followUps: info.followUps })}
                  onStop={stop}
                  onSetModel={(model) => configure({ model })}
                  onSetEffort={(effort) => configure({ effort })}
                  onSetMode={(mode) => configure({ mode })}
                  reportedModel={transcript.model}
                  turns={transcript.turns}
                  compacting={transcript.compacting}
                  contextUsed={transcript.contextUsed}
                  contextMax={transcript.contextMax}
                  modelsAreLocal={false}
                  modelClient={sleeping || !connected ? null : client}
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

const KIND_TEXT: Record<string, string> = { stop: "Stop", "permission-decision": "Decision" };

/**
 * Commands other than messages on their way, and the ones whose fate needs
 * the reader: a stop, a decision. Messages are Queued cards in the
 * transcript (#1291), never rows here too.
 */
export function CloudOutbox({
  entries,
  nameOf,
  onSendAgain,
}: {
  entries: OutboxEntry[];
  nameOf: (userId: string | null | undefined) => string;
  onSendAgain: (entry: OutboxEntry) => void;
}) {
  // Settled commands the transcript already shows are not repeated here.
  const shown = entries.filter(
    (entry) => !isMessageCommand(entry) && (!TERMINAL_OUTBOX_STATES.has(entry.state) || entry.state === "rejected" || entry.state === "outcome-unknown"),
  );
  if (!shown.length) return null;
  return (
    // A bar of its own above the transcript: its own background, a bounded height
    // that scrolls, and rows whose reasons wrap rather than run off the pane.
    <ul className="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto border-b border-hairline bg-veil-raised px-3 py-1.5 text-xs" data-testid="cloud-agent-outbox">
      {shown.map((entry) => (
        <li
          key={entry.clientCommandId}
          className={cn("flex items-baseline gap-2", entry.state === "outcome-unknown" && "text-warning")}
          data-testid="cloud-agent-command"
          data-state={entry.state}
        >
          <span className="shrink-0 text-muted-foreground">{KIND_TEXT[entry.kind] ?? entry.kind}:</span>
          <span className="min-w-0 flex-1 break-words">{outboxStateText(entry, nameOf)}</span>
          {entry.state === "outcome-unknown" && entry.kind !== "permission-decision" && (
            <Button size="xs" variant="outline" className="shrink-0 self-center" onClick={() => onSendAgain(entry)}>
              Send again
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

