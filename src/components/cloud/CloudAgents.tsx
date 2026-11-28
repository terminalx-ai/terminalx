import { usePipelineLaunch, pipelineSettings } from "@/lib/pipelineLaunch";
import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Folder, Loader2, Plus } from "@/icons";
import type { AgentTabInfo, WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { outboxStateText } from "./CloudPendingMessages";
import { isMessageCommand } from "@/lib/cloudPendingMessages";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { useAccount } from "@/lib/account";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { AGENT_LOGIN_PLACE } from "@/lib/cloudCreate";
import { AgentLoginsLink } from "./AgentLoginsLink";
import { managesOrganization } from "@/lib/multiOrg";
import { openAgentLogins } from "@/lib/settingsLinks";
import type { AgentLoginProvider } from "@/lib/api";
import { SessionAgentControls } from "@/components/session/SessionAgentControls";
import { useSessionStore } from "@/lib/sessions";
import { machineAgentSignInReason, useRuntimeModels } from "@/lib/cloudModels";
import { launchDefaults, useSessionAgent } from "@/lib/useSessionAgent";
import {
  createCloudAgentTab,
  getCloudAgents,
  DEV_SCOPE_NOTICE,
  errorText,
  flushCloudAgentCache,
  loadCloudAgents,
  startOutboxPolling,
  syncLiveTabs,
  useCloudAgents,
  watchLiveTabs,
  type CloudAgentTab,
} from "@/lib/cloudAgents";
import { TERMINAL_OUTBOX_STATES, type CloudAgentScope, type OutboxEntry } from "@/lib/cloudAgentApi";
import { cn } from "@/lib/cn";
import { secretStoreShort } from "@/lib/platform";
import { effectiveYou, notShared, sharingKnown, useCollab } from "@/lib/cloudCollab";
import { useMachinePlace } from "./workspacePlace";
import { CloudImageError } from "@/lib/cloudComposer";
import { NotSharedNotice } from "./CloudCollab";

/**
 * The projects a new agent tab may be created in: a paired machine's
 * (PRO-346), where `session.create` needs a `projectId`. A cloud workspace has
 * none and passes nothing.
 */
export interface AgentProjects {
  projects: { projectId: string; name: string }[];
  /** The project the form starts on when opened with + Agent. */
  preferred: string | null;
  /** Open the form on this project (the sidebar's +); spent once the form has opened. */
  request: { projectId: string; nonce: number } | null;
  onRequestTaken: () => void;
  /** A session was created in a project: the machine selects its row. */
  onCreated: (sessionId: string, projectId: string) => void;
  /** The machine, to name an agent not signed in there and open its page (PRO-350). */
  machine?: { name: string; openPage: () => void } | null;
}

/** One agent session of a workspace, as its tabs make it up. */
export interface AgentSessionRow {
  sessionId: string;
  title: string;
  tabs: CloudAgentTab[];
  /** The tab that says how the session is doing: one needing a decision, else one working, else the newest. */
  lead: CloudAgentTab;
  unread: boolean;
  modified: string;
}

/** Group a workspace's agent tabs into its sessions, the most recently changed first. Tabs without a session yet are left out. */
export function agentSessionRows(tabs: CloudAgentTab[]): AgentSessionRow[] {
  const bySession = new Map<string, CloudAgentTab[]>();
  for (const tab of tabs) {
    const sessionId = tab.info.sessionId;
    if (!sessionId) continue;
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), tab]);
  }
  const rows = [...bySession.entries()].map(([sessionId, members]): AgentSessionRow => {
    const newest = [...members].sort((a, b) => (b.info.modified ?? "").localeCompare(a.info.modified ?? ""))[0]!;
    const lead =
      members.find((tab) => tab.info.status === "waiting" && tab.info.process !== "exited") ??
      members.find((tab) => tab.info.status === "in_progress" && tab.info.process !== "exited") ??
      newest;
    const titled = members.find((tab) => tab.info.title?.trim());
    return {
      sessionId,
      title: titled?.info.title?.trim() || cloudAgentLabel(members[0]!.info.harness),
      tabs: members,
      lead,
      unread: members.some((tab) => tab.unread),
      modified: newest.info.modified ?? "",
    };
  });
  return rows.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * The agent sessions of a cloud workspace or paired machine (PRO-22, #1289).
 * Each opens in the same session view as a local session, with every one of
 * its options; this list only finds them and starts new ones. Sessions show
 * from the local cache and checkpoints even while the workspace sleeps, and
 * the runtime's list is followed only while it is online: nothing here wakes
 * compute.
 */
export function CloudAgentSessions({
  scope,
  client,
  state,
  workspaceState,
  collabKey,
  projects = null,
  onOpenSession,
}: {
  scope: CloudAgentScope;
  client: WorkspaceRpcClient;
  state: WorkspaceConnectionState;
  /** The API's workspace state (ready, suspended, provisioning, …), when known. */
  workspaceState: string | null;
  /** Where this workspace's presence, notes and leases are kept (cloudCollab); defaults to its target key. */
  collabKey?: string;
  /** A machine's projects: the new-agent form picks one. */
  projects?: AgentProjects | null;
  /** Open a session (and, when known, one of its tabs) in the shared session view. */
  onOpenSession: (sessionId: string, tabId: string | null) => void;
}) {
  const snapshot = useCloudAgents(scope);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed read of the runtime’s tab list, apart from a failed action, so its Retry reads the list again.
  const [tabsError, setTabsError] = useState<string | null>(null);
  const [tabsAttempt, setTabsAttempt] = useState(0);
  const connected = state.state === "connected";
  const machine = useMachinePlace();
  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}` : null;
  const key = collabKey ?? `cloud:${scope.organizationId}:${scope.workspaceId}`;
  const collab = useCollab(key);
  const you = effectiveYou(state, collab);
  // New sessions are a manager's; a demoted admin's manage attachment is not.
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
    void syncLiveTabs(scope, client).then(() => !cancelled && setTabsError(null), (e: unknown) => !cancelled && setTabsError(errorText(e)));
    // Commands that waited for the runtime: learn their outcome now.
    startOutboxPolling(scope);
    return () => {
      cancelled = true;
      stop();
    };
  }, [generation, client, scope.organizationId, scope.workspaceId, tabsAttempt]);

  // The sidebar's + on a machine opens the form on the project it chose.
  const [formProject, setFormProject] = useState<string | null>(null);
  const requestNonce = projects?.request?.nonce ?? null;
  useEffect(() => {
    if (!projects?.request) return;
    setFormProject(projects.request.projectId);
    setCreating(true);
    projects.onRequestTaken();
  }, [requestNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => agentSessionRows(snapshot.tabs), [snapshot.tabs]);

  if (hidden) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-agents">
        <NotSharedNotice />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-agents">
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1">
        <span className="text-xs text-muted-foreground">
          {machine ? `Agent sessions on ${machine.name}` : "Agent sessions in this workspace"}
        </span>
        {manage && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            aria-label="New agent session"
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
              setCreating(false);
              const sessionId = getCloudAgents(scope).tabs.find((tab) => tab.tabId === tabId)?.info.sessionId;
              if (!sessionId) return;
              // A machine's session is selected by its project's row; a workspace's opens by its own key.
              if (params.projectId && projects) projects.onCreated(sessionId, params.projectId);
              else onOpenSession(sessionId, tabId);
            } catch (e) {
              setError(errorText(e));
            }
          }}
        />
      )}
      {error && <p role="alert" className="px-4 py-1 text-xs text-red-500">Agent: {error}</p>}
      {tabsError && <p role="alert" className="px-4 py-1 text-xs text-red-500">Couldn’t read this workspace’s agent tabs. {tabsError} <Button size="xs" variant="outline" onClick={() => { setTabsError(null); setTabsAttempt((n) => n + 1); }}>Retry</Button></p>}
      {rows.length ? (
        <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1" aria-label="Agent sessions">
          {rows.map((row) => (
            <li key={row.sessionId}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-veil-raised focus-visible:bg-veil-raised focus-visible:outline-none"
                onClick={() => onOpenSession(row.sessionId, row.lead.tabId)}
                data-testid="cloud-agent-session"
                data-session={row.sessionId}
                title="Open in the session view"
              >
                <Bot className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
                {row.tabs.length > 1 && <span className="shrink-0 text-xs text-faint">{row.tabs.length} tabs</span>}
                <span className={cn("shrink-0 text-xs", row.lead.info.signIn || row.lead.info.status === "waiting" ? "text-warning" : "text-muted-foreground")}>{turnLabel(row.lead)}</span>
                {row.lead.info.status === "in_progress" && row.lead.info.process !== "exited" && !row.lead.info.signIn && <Loader2 className="size-3 shrink-0 animate-spin" aria-label="working" />}
                {row.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" data-testid="cloud-agent-unread" aria-label="unread" />}
                <ChevronRight className="size-3.5 shrink-0 text-faint" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {!snapshot.loaded ? (
            <Loader2 className="size-4 animate-spin" />
          ) : manage ? (
            machine ? `No agent sessions on ${machine.name} yet. Start one with + Agent.` : "No agent sessions in this workspace yet. Start one with + Agent."
          ) : connected ? (
            machine ? `No agent sessions on ${machine.name}.` : "No agent sessions in this workspace."
          ) : machine ? (
            `Agent sessions appear here once ${machine.name} is connected or has saved conversations.`
          ) : (
            "Agent sessions appear here once the workspace is connected or has saved conversations."
          )}
        </div>
      )}
    </div>
  );
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

/** The runtime's reason for a sign-in an agent needs once the organization route it ran on stopped applying (PRO-310). */
export const ORGANIZATION_ROUTE_REMOVED = "organization-route-removed";

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
  // The organization route its sessions ran on no longer applies, with no other login in its place (PRO-310).
  if (signIn.reason === ORGANIZATION_ROUTE_REMOVED) {
    const fix = mayManage ? `Connect a ${agent} login in ${AGENT_LOGIN_PLACE}, then send again.` : `Ask an owner or admin to connect a ${agent} login, then send again.`;
    return `Sign in to continue: ${organization?.trim() || "the organization"}’s ${agent} route no longer applies to this workspace, and there is no other ${agent} login here. ${fix}`;
  }
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
    return `This device could not read its key for this workspace from ${secretStoreShort}, so the command was not sent. Unlock it or allow TerminalX to use it, then send again.`;
  }
  if (code === DEV_SCOPE_NOTICE) return DEV_SCOPE_NOTICE;
  if (code === "cloud_workspace_collaboration_forbidden") return "Your access to this workspace does not allow this. Ask an admin for driver or approver access.";
  return `Could not queue the command (${code}).`;
}

const KIND_TEXT: Record<string, string> = { stop: "Stop", "permission-decision": "Decision", "follow-up": "Held message" };

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
  // A change to a held message that went to the agent first has nothing left to say: the message is in the chat (#1328).
  const shown = entries.filter(
    (entry) => !isMessageCommand(entry) && !(entry.kind === "follow-up" && entry.category === "follow-up-gone")
      && (!TERMINAL_OUTBOX_STATES.has(entry.state) || entry.state === "rejected" || entry.state === "outcome-unknown"),
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
          data-category={entry.category ?? undefined}
        >
          <span className="shrink-0 text-muted-foreground">{KIND_TEXT[entry.kind] ?? entry.kind}:</span>
          <span className="min-w-0 flex-1 break-words">{outboxStateText(entry, nameOf)}</span>
          {entry.state === "outcome-unknown" && entry.kind !== "permission-decision" && entry.kind !== "follow-up" && (
            <Button size="xs" variant="outline" className="shrink-0 self-center" onClick={() => onSendAgain(entry)}>
              Send again
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

