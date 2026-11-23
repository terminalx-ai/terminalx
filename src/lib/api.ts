import { privacyBlocksCommand, PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { rememberCloudProviders } from "@/lib/cloudProviders";
import type { OrchestratorLimits, OrchestratorPatch, OrchestratorSettings, Run, RunLimits, RunPlan, RunStart, RunStop, TierModels } from "@/types/orchestration";
import type { PrConversationAccess } from "@terminalx/portable/workspaceGit";
import { Channel, invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentAccountUsage } from "@/lib/agentAccounts";
import {
  WorkspaceRpcClient,
  type Activation,
  type CleanupProgress,
  type CleanupProject,
  type CleanupRemoveItem,
  type CleanupResult,
  type MergedRemovalView,
  type MergedRestored,
  type MergedSwept,
  type WorkspaceConnectionState,
  type WorkspaceTransport,
} from "@terminalx/portable/workspace";
import type {
  BranchInfo,
  IssueRef,
  ChangedFile,
  CommitInfo,
  HarnessInfo,
  Project,
  ProjectPatch,
  SessionEntry,
  Workspace,
  WorkspaceDisposition,
  WorkspaceRestorePreview,
  TabEntry,
  TabStatus,
  UnfinishedMerge,
  ConflictChoice,
  ConflictFile,
  WorkStatus,
  WorkspaceRemoveReport,
  Leftover,
  LeftoverProgress,
  LeftoverRemoval,
} from "@/types/session";
import type { DiscoveredSkill, SkillDetail } from "@/types/skills";
import type { AgentConfigChange, AgentConfigComparison, AgentConfigPreview, AgentConfigWritten } from "@/types/agentConfigs";
import type { Automation, AutomationInput, AutomationIssueState, AutomationRun, AutomationRef, AutomationEventSource, PrecheckTrial, PrecheckTryInput, SourceMatch } from "@/types/automations";
import type { Bot, BotList, BotPatch, BotPauseFrom, BotRoleTemplate, PauseHeld } from "@/types/bots";
import type { CloudMerge, IssuePipeline, IssuePipelineSettings, PipelineAction, StartedIssuePipeline } from "@/types/issuePipeline";
import type { MachineName, PairingConnectionMode, PairingStatus } from "@/types/pairing";
import type { RepositoryFilesPreview } from "@/types/repositorySettings";
import type { RepositoryFolders } from "@/types/repositoryFolders";
import type { CloudDiagnostics, ConnectionClose } from "@/lib/cloudDiagnostics";
import type { IssueUser } from "@/lib/issueOps";
import { noteCallFailure } from "@/lib/accountRoles";
import { assertLocal } from "@/types/target";

/**
 * Arguments that name a place on this computer, or a local session. A cloud
 * key or root (`cloud:`…) in one of them is a bug: it would run a local
 * command against a path that only exists on a VM (PRO-23 rule 3).
 */
const LOCAL_PATH_ARGS = ["cwd", "path", "root", "projectPath", "sessionId", "from", "to", "dir", "file"] as const;

/**
 * The calls on a project's issues (#433). A cloud project's issues are its
 * GitHub repository's, so these also take a cloud project's key as their
 * `projectPath`: the native side reads the repository from it and runs `gh`
 * outside any checkout (`issues::cloud_project_repo`). Never a cloud
 * workspace or session key, nor a path on a VM.
 */
const ISSUE_COMMANDS = new Set([
  "github_repo",
  "issues_list",
  "issue_details",
  "issue_comments",
  "issue_options",
  "issue_viewer",
  "issue_comment_add",
  "issue_comment_edit",
  "issue_comment_delete",
  "issue_set_state",
  "issue_set_assignees",
  "issue_set_labels",
  "issue_set_priority",
  "issue_set_title",
  "issue_set_description",
  "issue_create",
  "issue_templates",
  // Who works on the issues listed (#441): the claims are read by the issues' repository.
  "work_claims_list",
]);

/** `cloud:<orgId>:github.com/<owner>/<name>`: a cloud project with a GitHub repository. */
export function isCloudRepositoryKey(value: string): boolean {
  return /^cloud:[^:/]+:github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value);
}

/** Every Tauri call made here goes through this: local paths pass unchanged, cloud ones throw. */
export function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (privacyBlocksCommand(command)) return Promise.reject(new Error(PRIVACY_MESSAGE));
  if (args && typeof args === "object" && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array)) {
    const record = args as Record<string, unknown>;
    try {
      for (const key of LOCAL_PATH_ARGS) {
        const value = record[key];
        if (typeof value !== "string") continue;
        if (key === "projectPath" && ISSUE_COMMANDS.has(command) && isCloudRepositoryKey(value)) continue;
        assertLocal(value, `${command}.${key}`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const call = args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args);
  // A refusal for lack of role or membership means the roles held are stale: they are read again.
  if (call && typeof (call as Promise<T>).then === "function") call.then(undefined, noteCallFailure);
  return call;
}

/**
 * The progress the backend reports for the long call named `run`: `event`
 * carries every run's, each with its id. Resolves to the function that stops
 * listening.
 */
async function onRunProgress<T>(event: string, run: string, onProgress: (progress: T) => void): Promise<() => void> {
  try {
    return await listen<T & { run: string }>(event, ({ payload }) => {
      if (payload.run === run) onProgress(payload);
    });
  } catch {
    // Outside a webview there is no event stream; the call still answers.
    return () => {};
  }
}

export interface NewTab {
  harness: string;
  model?: string;
  effort?: string | null;
  permissionMode?: string | null;
}

/**
 * What a tab entry says of its agent account (#980, docs/AGENT-ACCOUNTS.md).
 * The native side keeps these on the tab entry beside its other fields; with
 * This Mac's login alone none of them is there.
 */
export interface TabAccount {
  /** The account the tab asked for: every start and restart of its agent uses it. */
  account?: string | null;
  /** The account its agent last started on, as the launch resolved it (absent while that is This Mac's login). */
  launchedAccount?: string | null;
  /**
   * In a create or add-tab reply only: the tab asked for an account and the background runtime
   * is older than accounts, so it starts on This Mac's login. The window says so.
   */
  accountFallback?: "olderRuntime";
}

/** The account `tab` runs on, or last ran on; `null` for This Mac's login or the defaults. */
export function tabAccount(tab: TabEntry): string | null {
  const fields = tab as TabEntry & TabAccount;
  return fields.launchedAccount ?? fields.account ?? null;
}

/** Whether `tab` asked for an account its runtime could not start it on. */
export function tabAccountFellBack(tab: TabEntry): boolean {
  return (tab as TabEntry & TabAccount).accountFallback === "olderRuntime";
}

/** The tail of one session's active tab, as the dashboard cards need it. */
export interface SessionSummary {
  sessionId: string;
  tabId: string;
  lastPrompt: string | null;
  lastReply: string | null;
  waitingOn: string | null;
  updatedAt: string;
}

export interface AppStats {
  agentsSpawned: number;
  agentTimeMs: number;
  prsCreated: number;
  trackingSince: string | null;
  accountingError?: string | null;
}

export interface UsageDay {
  day: string;
  totalTokens: number;
  claudeTokens: number;
  codexTokens: number;
}

export interface ProviderUsage {
  id: string;
  label: string;
  enabled: boolean;
  hasData: boolean;
  lastModel: string | null;
  lastProject: string | null;
  totalTokens: number;
  sessions: number;
  activityCount: number;
  activityLabel: string;
  estimatedCostUsd: number | null;
  hasPartialCost: boolean;
  unpricedModels?: string[];
}

export interface StatsUsageSnapshot {
  app: AppStats;
  totalTokens: number;
  estimatedCostUsd: number | null;
  hasPartialCost: boolean;
  activeDays: number;
  cacheShare: number | null;
  newInputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  reasoningTokens: number;
  daily: UsageDay[];
  providers: ProviderUsage[];
  updatedAt: number;
  discoveryWarnings?: string[];
  rangeStart?: string;
  rangeEnd?: string;
}

export interface StatsUsageState {
  scope: string;
  generation: number;
  snapshot: StatsUsageSnapshot | null;
  activity?: AppStats | null;
  activityError?: string | null;
  refreshing: boolean;
  error: string | null;
}

export interface NewSession {
  sectionId?: string | null;
  projectPath: string;
  /** Run in this existing workspace instead of creating a worktree. */
  cwd?: string | null;
  title?: string | null;
  useWorktree: boolean;
  baseRef?: string | null;
  /** A requested worktree name (an issue slug); sanitised and made unique. */
  worktreeName?: string | null;
  /** An existing branch to check out in the new worktree, instead of a new branch. */
  checkoutBranch?: string | null;
  checkoutPr?: number | null;
  /** Explicit acknowledgement that a requested worktree should be skipped. */
  onMain?: boolean;
  issue?: IssueRef | null;
  automation?: AutomationRef | null;
  /** The first agent conversation. Omit to open the checkout by itself. */
  tab?: NewTab;
  /** Started with Orchestrate (PRO-337): any run the session leads waits for the person's Approve. */
  orchestrate?: boolean;
  /** The agent account the first tab starts on (#980). Absent: the project's default, then the agent's. */
  account?: string | null;
}

export interface WorkspaceRename {
  name: string;
  path: string;
  branch: string;
  sessions: SessionEntry[];
}

export interface NewQuickChat {
  sectionId?: string | null;
  title?: string | null;
  cwd?: string | null;
  tab?: NewTab | null;
  /** The agent account the first tab starts on (#980). Absent: the agent's default. */
  account?: string | null;
}

export interface QuickChatScratch {
  path: string;
  /** Files in it, counted up to a limit. */
  files: number;
  /** The count stopped at the limit: there are at least `files`. */
  more: boolean;
  /** The session runs there now, rather than in a folder it was pointed at. */
  inUse: boolean;
}

/** The floating chat window's settings, and why its shortcut is not registered when it is not. */
export interface FloatingStatus {
  /** The system-wide shortcut, as the app writes bindings (`alt+shift+space`); null when turned off. */
  shortcut: string | null;
  alwaysOnTop: boolean;
  /** Days an idle quick chat is kept; 0 keeps them until deleted by hand. */
  retentionDays: number;
  shortcutError: string | null;
}

/** A session one window asks the other to show, and the tab of it when one is meant. */
export interface OpenTarget {
  sessionId: string;
  tabId?: string | null;
}

/** A shell tab as the backend lists it for every window. */
export interface ShellPane {
  id: string;
  sessionId: string;
  title: string | null;
  /** The reader named it; `title` is otherwise the name it was opened with. */
  renamed?: boolean;
  /** Explicit placement; absent for terminals opened by older runtimes. */
  docked?: boolean | null;
  cwd: string;
  exited: boolean;
  /** When it was opened, so every window lists it in the same place. */
  created?: string;
}

/** The agent in front of a pane's terminal (#437), or none once it has left. */
export interface PaneAgent {
  paneId: string;
  harness: string | null;
}

/**
 * How one workspace's tabs are arranged: one row for the checkout, whatever
 * session a tab belongs to. A tab is named `agent:<tab id>`,
 * `terminal:<pane id>` or `browser:<page id>` (`tabKey` in `@/lib/tabLayouts`).
 */
export interface TabPane {
  id: "left" | "right";
  tabs: string[];
  active: string | null;
}

export interface TabLayout {
  /** The tabs in the order the reader put them in; a tab not listed comes after these, oldest first. */
  order: string[];
  /** Kept at the left, drawn as an icon, and left open by the bulk closes. */
  pinned: string[];
  /** Tabs that raise no banner, notice or tone. */
  muted: string[];
  /** The reader's own title for a tab. */
  titles: Record<string, string>;
  /** Optional for layouts saved before split panes. Preserved by the backend's extension fields. */
  panes?: TabPane[];
  focusedPane?: TabPane["id"];
  splitRatio?: number;
}

/** An agent tab the reader closed, kept with its conversation so it can be reopened. */
export interface ClosedTab {
  sessionId: string;
  tab: TabEntry;
  closedAt: string;
}

/** What every window knows about tabs beyond the sessions: each workspace's layout, and the closed tabs. */
export interface TabState {
  workspaces: Record<string, TabLayout>;
  closed: ClosedTab[];
}

/** One local repository's mirror; source stays set when cleanup is needed. */
export interface RepoMirrorStatus {
  root: string;
  source: string | null;
  active: boolean;
  error: string | null;
}

/** How a workspace is removed. */
export interface WorkspaceRemoveOptions {
  /** Receipt for the failed archive run the person explicitly chose to bypass. */
  archiveFailure?: string;
  /** Receipt for the failed run the person explicitly chose to retry. */
  archiveRetry?: string;
  /** Settling: the conversations stay and move to the project. */
  keepSessions: boolean;
  deleteBranch: boolean;
  /**
   * The second confirmation, as the digest of the check the person saw when
   * they gave it. Null for a single confirmation, which is enough only for a
   * workspace found clean and merged.
   */
  confirmedDigest: string | null;
  /** The sessions the person was told are in the workspace; the removal is refused if that changed. */
  expectedSessions: string[];
}

/** Where the Local VM stands (`container_vm.rs`). */
export type LocalVmState = "no_runtime" | "runtime_down" | "not_created" | "stopped" | "running";
export interface LocalVmStatus {
  state: LocalVmState;
  /** `docker` or `podman`. */
  runtime: string | null;
  /** Colima is installed, so a stopped Docker can be started from the app. */
  colima: boolean;
  /** The noVNC server on loopback, while running. */
  viewer: { port: number; password: string } | null;
}

export const api = {
  // optional TerminalX account
  accountStatus: () => invoke<AccountStatus>("account_status"),
  /**
   * Read the organizations and the role in each again from the account
   * service (no token rotates). A routine call is throttled natively; `force`
   * asks at once. `fresh` says the server answered for this call.
   */
  accountRefreshRoles: (force: boolean) => invoke<{ status: AccountStatus; fresh: boolean }>("account_refresh_roles", { force }),
  accountSignIn: () => invoke<AccountStatus>("account_sign_in"),
  accountPasteCallback: (link: string) => invoke<void>("account_paste_callback", { link }),
  /** Opens the organization's page in the web console, in the system browser. */
  organizationConsoleOpen: (organizationId: string) => invoke<void>("organization_console_open", { organizationId }),
  accountSignOut: () => invoke<AccountStatus>("account_sign_out"),
  /** `selected: false`: created, but selecting it failed. Select it by id; never create again. */
  organizationCreate: (name: string, idempotencyKey: string) =>
    invoke<OrganizationSummary & { selected?: boolean }>("organization_create", { name, idempotencyKey }),
  organizationSelect: (organizationId: string, contextRevision: string) =>
    invoke<AccountStatus>("organization_select", { organizationId, contextRevision }),
  organizationDelete: (organizationId: string, contextRevision: string, confirmationName: string) =>
    invoke<{ status: AccountStatus; fresh: boolean }>("organization_delete", { organizationId, contextRevision, confirmationName }),

  // provider-aware Cloud Workspaces; authentication and Organization scope
  // are resolved natively, so account tokens never cross this boundary.
  cloudProviders: async () => {
    const response = await invoke<CloudProviderSummaryResponse>("cloud_providers");
    rememberCloudProviders(response.providers);
    return response;
  },
  cloudProvider: (provider: CloudWorkspaceProviderId) => invoke<CloudProviderConnection>("cloud_provider", { provider }),
  cloudProviderDisconnect: (provider: CloudWorkspaceProviderId, contextRevision: string, disposition: "retain" | "archive" | "destroy") =>
    invoke<CloudProviderConnection>("cloud_provider_disconnect", { provider, contextRevision, disposition }),
  /** The organization's cloud teardown, or null when none was ever asked for. Owners and admins only; the server decides. */
  cloudTeardownStatus: (orgId?: string | null) => invoke<CloudTeardown | null>("cloud_teardown_status", { orgId: orgId ?? null }),
  /** How many workspaces a teardown of `organizationId` would take, private ones the caller cannot list included. Refused if that is not the active organization. */
  cloudTeardownPreview: (organizationId: string) => invoke<CloudTeardownPreview>("cloud_teardown_preview", { organizationId }),
  /**
   * Archive or delete every cloud workspace of `organizationId`. It cannot be
   * cancelled; call it only after an explicit confirmation, with the
   * organization and the context revision that confirmation was given for,
   * and the preview it showed. Nothing is sent if the organization or context
   * is no longer current, or the workspaces are no longer the ones counted.
   */
  cloudTeardownRequest: (organizationId: string, contextRevision: string, disposition: "archive" | "destroy", confirmed: { expectedWorkspaces: number; previewToken: string }) =>
    invoke<CloudTeardown>("cloud_teardown_request", { organizationId, contextRevision, disposition, confirmed }),
  /** Allow or stop new machines on a provider (owners and admins); saved keys and running workspaces are untouched. */
  cloudProviderSetCreationEnabled: (provider: CloudWorkspaceProviderId, contextRevision: string, enabled: boolean) =>
    invoke<CloudProviderSummary>("cloud_provider_set_creation_enabled", { provider, contextRevision, enabled }),
  /** Check the saved key against the provider again, without entering it. */
  cloudProviderRevalidate: (provider: CloudWorkspaceProviderId, contextRevision: string) =>
    invoke<CloudProviderConnection>("cloud_provider_revalidate", { provider, contextRevision }),
  // Agent logins for an organization's cloud workspaces (PRO-79). The login itself is collected in Rust
  // (a native secure dialog, or this computer's own login) and never passes through the webview.
  // Each organization has its own (PRO-107): `orgId` (and a consent's `organizationId`) names any member
  // organization, whatever the active one is; null is the active one.
  cloudAgentLogins: (orgId?: string | null) => invoke<{ credentials: AgentLogin[] }>("cloud_agent_logins", { orgId: orgId ?? null }),
  cloudAgentLoginConnect: (provider: AgentLoginProvider, source: AgentLoginSource, consent: AgentLoginConsent) =>
    invoke<AgentLogin>("cloud_agent_login_connect", { provider, source, consent }),
  cloudAgentLoginRemove: (provider: AgentLoginProvider, contextRevision: string, orgId?: string | null) =>
    invoke<void>("cloud_agent_login_remove", { provider, contextRevision, orgId: orgId ?? null }),
  // A member's own model routes (PRO-18): how agents in the cloud workspaces they create reach their model
  // instead of the organization's login. Personal and per organization, any member organization by `orgId`.
  // A route's credential is entered in a native secure dialog and checked from this Mac in Rust, never here.
  cloudAgentRoutes: (orgId?: string | null) => invoke<AgentRoutes>("cloud_agent_routes", { orgId: orgId ?? null }),
  cloudAgentRouteSave: (save: AgentRouteSave) => invoke<AgentRouteSaved>("cloud_agent_route_save", { save }),
  cloudAgentRouteRemove: (agent: AgentRouteAgent, contextRevision: string, orgId?: string | null) =>
    invoke<AgentRoutes>("cloud_agent_route_remove", { agent, contextRevision, orgId: orgId ?? null }),
  // "Log in with Claude" (PRO-82): the account service runs the sign-in and keeps a login it can renew.
  // The page opens in the browser; the code it shows is entered in a native dialog, never here.
  cloudAgentClaudeLoginStart: (consent: AgentLoginConsent) => invoke<ClaudeLoginStarted>("cloud_agent_claude_login_start", { consent }),
  cloudAgentClaudeLoginOpen: (url: string) => invoke<void>("cloud_agent_claude_login_open", { url }),
  cloudAgentClaudeLoginComplete: (attemptId: string, consent: AgentLoginConsent) =>
    invoke<ClaudeLoginOutcome>("cloud_agent_claude_login_complete", { attemptId, consent }),
  cloudAgentClaudeLoginCancel: (attemptId: string, contextRevision: string, orgId?: string | null) =>
    invoke<void>("cloud_agent_claude_login_cancel", { attemptId, contextRevision, orgId: orgId ?? null }),
  // "Log in with ChatGPT" for Codex: Codex's own device-code login runs on this Mac in a throwaway home. The code
  // comes back to be shown in the sign-in dialog only; the login the CLI writes is stored by Rust and never comes here.
  cloudAgentCodexLoginStart: (consent: AgentLoginConsent) => invoke<CodexLoginStarted>("cloud_agent_codex_login_start", { consent }),
  cloudAgentCodexLoginOpen: (attemptId: string) => invoke<void>("cloud_agent_codex_login_open", { attemptId }),
  cloudAgentCodexLoginStatus: (attemptId: string, consent: AgentLoginConsent) =>
    invoke<CodexLoginStatus>("cloud_agent_codex_login_status", { attemptId, consent }),
  cloudAgentCodexLoginCancel: (attemptId: string) => invoke<void>("cloud_agent_codex_login_cancel", { attemptId }),
  cloudProviderConnect: (provider: CloudWorkspaceProviderId, input: CloudProviderConnectInput) =>
    invoke<CloudProviderConnection>("cloud_provider_connect", { provider, input }),
  // Cloud workspace routes take the Organization they act in (CS-18). None
  // (or null) means the active Organization, as before; a named one must be
  // the active one or, on a server that authorizes by membership, a member
  // Organization. The native side checks it against the membership list.
  cloudWorkspaceSetup: (provider: CloudWorkspaceProviderId, orgId?: string | null) =>
    invoke<CloudWorkspaceSetup>("cloud_workspace_setup", { provider, orgId: orgId ?? null }),
  cloudWorkspaceQuote: (input: CloudWorkspaceQuoteInput, orgId?: string | null) =>
    invoke<CloudWorkspaceQuote>("cloud_workspace_quote", { input, orgId: orgId ?? null }),
  cloudWorkspaceCreate: (input: CloudWorkspaceCreateInput, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_create", { input, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  /** `agent`: the one a first prompt would go to; the answer then says whether the organization has a login for it. */
  cloudWorkspacePreflight: (repositories: CloudWorkspaceRepositoryInput[], orgId?: string | null, agent?: string | null) =>
    invoke<CloudWorkspacePreflight>("cloud_workspace_preflight", { repositories, orgId: orgId ?? null, agent: agent ?? null }),
  cloudWorkspaceRepositories: (orgId?: string | null) => invoke<CloudSelectedRepositories>("cloud_workspace_repositories", { orgId: orgId ?? null }),
  cloudWorkspaces: (orgId?: string | null) => invoke<CloudWorkspaceListDto>("cloud_workspaces", { orgId: orgId ?? null }).then(projectCloudWorkspaceList),
  /** Every member organization's list in one request, for a server that offers it; `cursor` is the last answer's. */
  cloudCatalogFeed: (cursor?: string | null) => invoke<CloudCatalogFeedDto>("cloud_catalog_feed", { cursor: cursor ?? null }).then(projectCloudCatalogFeed),
  /** Held until SaaS integration/live readiness is explicitly confirmed. */
  phase2DesktopContractsAvailable: () => invoke<boolean>("phase2_desktop_contracts_available"),
  /** Internal PRO-133/137 transport; production refuses locally while phase 2 is held. */
  cloudWorkspaceFollow: (orgId: string, workspaceId: string) => invoke<WorkspaceFollowingResponse>("cloud_workspace_follow_put", { orgId, workspaceId, input: {} }),
  cloudWorkspaceUnfollow: (orgId: string, workspaceId: string) => invoke<WorkspaceFollowingResponse>("cloud_workspace_follow_delete", { orgId, workspaceId, input: {} }),
  cloudWorkspaceReassign: (orgId: string, workspaceId: string, input: WorkspaceReassignInput) => invoke<WorkspaceReassignResponse>("cloud_workspace_reassign", { orgId, workspaceId, input }),
  desktopPresencePut: (orgId: string, input: PresencePutInput) => invoke<PresencePutResponse>("desktop_presence_put", { orgId, input }),
  desktopPresenceRead: (orgId: string, input: PresenceReadInput) => invoke<PresenceReadResponse>("desktop_presence_read", { orgId, input }),
  desktopInbox: (after = "0", waitMs = 25000) => invoke<DesktopInboxPage>("desktop_inbox", { after, waitMs }),
  /** One SSE page through its checkpoint; apply/dedupe events before saving cursor. */
  desktopInboxStream: (after: string, lastEventId?: string | null) => invoke<DesktopInboxStreamPage>("desktop_inbox_stream", { after, lastEventId: lastEventId ?? null }),
  desktopInboxReceipts: (eventIds: string[]) => invoke<{ acknowledged: boolean }>("desktop_inbox_receipts", { eventIds }),
  cloudWorkspaceReadMarker: (orgId: string, workspaceId: string, readAt: string, sessionId?: string | null) =>
    invoke<DesktopReadMarker>("cloud_workspace_read_marker", { orgId, workspaceId, readAt, sessionId: sessionId ?? null }),
  cloudWorkspaceRestart: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_restart", { workspaceId, orgId: orgId ?? null }),
  cloudWorkspaceDetails: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceDetailsResponse>("cloud_workspace_details", { workspaceId, orgId: orgId ?? null }),
  cloudWorkspaceSuspend: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_suspend", { workspaceId, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  cloudWorkspaceResume: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_resume", { workspaceId, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  cloudWorkspaceRelease: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_release", { workspaceId, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  /**
   * Archive (30-day trash by default). `force` only after the person confirmed
   * stopping running agent work. `retentionDays` only when the person chose a
   * period the disposition facts offer; a server without the choice refuses it.
   */
  cloudWorkspaceArchive: (workspaceId: string, force: boolean, orgId?: string | null, retentionDays?: number | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_archive", { workspaceId, force, orgId: orgId ?? null, retentionDays: retentionDays ?? null }).then(projectCloudWorkspaceSnapshot),
  /** Permanent delete, a resumable cleanup job; retrying resumes the same operation. */
  cloudWorkspaceDelete: (workspaceId: string, force: boolean, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_delete", { workspaceId, force, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  /** Out of the archive; it stays suspended until the next interactive action. */
  cloudWorkspaceUnarchive: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_unarchive", { workspaceId, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  cloudWorkspaceDisposition: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceDisposition>("cloud_workspace_disposition", { workspaceId, orgId: orgId ?? null }),
  /** Scheduled tasks (PRO-37, saas contract §24): the organization's, or one workspace's. Owners and admins only; a server with the feature off answers 404. */
  cloudSchedules: (workspaceId?: string | null, orgId?: string | null) =>
    invoke<{ schedules: CloudAutomationDto[] }>("cloud_schedules", { workspaceId: workspaceId ?? null, orgId: orgId ?? null }).then(({ schedules }) => ({ schedules: schedules.map(projectLegacyCloudSchedule).filter((schedule): schedule is CloudSchedule => schedule !== null) })),
  /** One scheduled task and its newest runs. */
  cloudSchedule: (scheduleId: string, orgId?: string | null) => invoke<CloudAutomationDetailDto>("cloud_schedule", { scheduleId, orgId: orgId ?? null }).then((detail): CloudScheduleDetail => ({ ...detail, schedule: requireLegacyCloudSchedule(detail.schedule) })),
  /** What a schedule would cost and when it would first run, before it is saved. Writes nothing. */
  cloudScheduleEstimate: (input: CloudScheduleEstimateInput, orgId?: string | null) =>
    invoke<CloudScheduleQuote>("cloud_schedule_estimate", { input, orgId: orgId ?? null }),
  /** Make a scheduled task. Only after the person confirmed that it starts billed compute by itself. */
  cloudScheduleCreate: (input: CloudScheduleCreateInput, orgId?: string | null) => invoke<CloudAutomationDto>("cloud_schedule_create", { input, orgId: orgId ?? null }).then(requireLegacyCloudSchedule),
  /** Pause a scheduled task, or resume a paused one (which then runs for the person resuming it). */
  cloudScheduleSetActive: (scheduleId: string, active: boolean, orgId?: string | null) =>
    invoke<CloudAutomationDto>("cloud_schedule_set_active", { scheduleId, active, orgId: orgId ?? null }).then(requireLegacyCloudSchedule),
  /** Exact automation DTOs over existing native commands; no timer projection. */
  cloudAutomations: (workspaceId?: string | null, orgId?: string | null) =>
    invoke<{ schedules: CloudAutomationDto[] }>("cloud_schedules", { workspaceId: workspaceId ?? null, orgId: orgId ?? null }),
  cloudAutomation: (scheduleId: string, orgId?: string | null) =>
    invoke<CloudAutomationDetailDto>("cloud_schedule", { scheduleId, orgId: orgId ?? null }),
  cloudAutomationEstimate: (input: CloudAutomationEstimateInput, orgId?: string | null) =>
    invoke<CloudScheduleQuote>("cloud_schedule_estimate", { input, orgId: orgId ?? null }),
  cloudAutomationCreate: (input: CloudAutomationCreateInput, orgId?: string | null) =>
    invoke<CloudAutomationMutationDto>("cloud_schedule_create", { input, orgId: orgId ?? null }),
  cloudAutomationRotateWebhookSecret: (scheduleId: string, orgId: string) =>
    invoke<CloudAutomationMutationDto>("cloud_schedule_webhook_rotate", { scheduleId, orgId }),
  cloudAutomationSetActive: (scheduleId: string, active: boolean, orgId?: string | null) =>
    invoke<CloudAutomationDto>("cloud_schedule_set_active", { scheduleId, active, orgId: orgId ?? null }),
  cloudScheduleDelete: (scheduleId: string, orgId?: string | null) => invoke<void>("cloud_schedule_delete", { scheduleId, orgId: orgId ?? null }),
  /** Pause every active scheduled task of the organization. */
  cloudSchedulesPauseAll: (orgId?: string | null) => invoke<{ paused: number }>("cloud_schedules_pause_all", { orgId: orgId ?? null }),
  /** Who the workspace is shared with, and what the caller may do (PRO-30, docs/CLOUD-SHARING.md). */
  cloudWorkspaceShares: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceShares>("cloud_workspace_shares", { workspaceId, orgId: orgId ?? null }),
  /** Grant or change a member's share; only managers and the workspace's creator may. */
  cloudWorkspaceSharePut: (workspaceId: string, userId: string, role: CloudShareRole, canApprove: boolean, orgId?: string | null) =>
    invoke<{ share: CloudWorkspaceShare; created?: boolean }>("cloud_workspace_share_put", { workspaceId, userId, role, canApprove, orgId: orgId ?? null }),
  /** Revoke a member's share; their connections to the workspace close. */
  cloudWorkspaceShareRevoke: (workspaceId: string, userId: string, orgId?: string | null) =>
    invoke<{ share: CloudWorkspaceShare }>("cloud_workspace_share_revoke", { workspaceId, userId, orgId: orgId ?? null }),
  /**
   * Who may see the workspace: `organization` so it can be shared, `private` to
   * hide it from everyone but its creator (the server revokes every share with
   * it). Only an organization owner or admin may (`organization_admin_required`).
   */
  cloudWorkspaceSetAccess: (workspaceId: string, accessMode: "private" | "organization", orgId?: string | null) =>
    invoke<CloudWorkspace>("cloud_workspace_set_access", { workspaceId, accessMode, orgId: orgId ?? null }),
  /** The workspace's idle window and its choices (PRO-410), for whoever may manage it. */
  cloudWorkspaceIdleSuspend: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceIdleSuspend>("cloud_workspace_idle_suspend", { workspaceId, orgId: orgId ?? null }),
  /** Change how long the workspace may sit idle before it is stopped; 0 is never (PRO-410). */
  cloudWorkspaceSetIdleSuspend: (workspaceId: string, idleSuspendMinutes: number, orgId?: string | null) =>
    invoke<CloudWorkspace>("cloud_workspace_set_idle_suspend", { workspaceId, idleSuspendMinutes, orgId: orgId ?? null }),
  /** The saved cloud catalog (PRO-57) of the signed-in user; refused once `revision` is not the current account. */
  cloudCatalogLoad: (revision: string) => invoke<unknown>("cloud_catalog_load", { revision }),
  cloudCatalogSave: (revision: string, catalog: unknown) => invoke<void>("cloud_catalog_save", { revision, catalog }),
  /** Drop the agent outbox, transcript cache and keys this Mac kept for a deleted workspace. */
  cloudAgentPurgeWorkspace: (organizationId: string, workspaceId: string) =>
    invoke<{ removed: boolean; unsentCommands: number; cachedTabs: number }>("cloud_agent_purge_workspace", { organizationId, workspaceId }),
  cloudWorkspaceOperation: (operationId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_operation", { operationId, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  /** Exact transport action, including restart; uses the same existing polling endpoint. */
  cloudWorkspaceOperationDto: (operationId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_operation", { operationId, orgId: orgId ?? null }),
  cloudWorkspaceOperationCancel: (operationId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshotDto>("cloud_workspace_operation_cancel", { operationId, orgId: orgId ?? null }).then(projectCloudWorkspaceSnapshot),
  // Remote runtime connections (PRO-13); relay credentials and E2EE keys stay native.
  cloudRemoteAttach: (target: CloudWorkspaceTarget, activation: Activation) =>
    invoke<string>("cloud_remote_attach", { target, activation }),
  /**
   * A paired machine's connection (PRO-345, docs/MACHINES.md "As built
   * (PRO-345)"): one per machine, so a second call returns the same id. It is
   * used like a cloud one (`cloudRemoteSend`, `cloudRemoteDetach`, `cloud_remote_event`).
   * Refused with `machine_unknown` or `machine_token_missing`.
   */
  machineRemoteAttach: (machineId: string) => invoke<string>("machine_remote_attach", { machineId }),
  /**
   * Forward a port of the connection's workspace to this Mac's loopback (PRO-28,
   * docs/CLOUD-PREVIEWS.md), on a random free port unless `localPort` names one.
   * Never wakes the workspace: rejects with `cloud_port_not_connected` unless the
   * connection is live. `reassigned` says the named local port was taken; `exact`
   * refuses instead (`cloud_port_in_use`). The forward closes when the workspace
   * stops, access goes or the active organization changes.
   */
  cloudPortForward: (connectionId: string, port: number, options: { localPort?: number; exact?: boolean } = {}) =>
    invoke<CloudPortForward>("cloud_port_forward", { connectionId, port, localPort: options.localPort ?? null, exact: options.exact ?? false }),
  cloudPortUnforward: (connectionId: string, port: number) => invoke<boolean>("cloud_port_unforward", { connectionId, port }),
  cloudPortForwards: (connectionId: string) => invoke<CloudPortForward[]>("cloud_port_forwards", { connectionId }),
  /** The connection's forwarding switches (PRO-355). */
  cloudPortSettings: (connectionId: string) => invoke<CloudPortSettings>("cloud_port_settings", { connectionId }),
  /** Change either switch; answers the switches as they now are. */
  cloudPortSetSettings: (connectionId: string, settings: Partial<CloudPortSettings>) =>
    invoke<CloudPortSettings>("cloud_port_set_settings", { connectionId, enabled: settings.enabled ?? null, auto: settings.auto ?? null }),
  cloudRemoteSend: (connectionId: string, frame: { id: string; method: string; params?: unknown }) =>
    invoke<boolean>("cloud_remote_send", { connectionId, frame }),
  cloudRemoteActivate: (connectionId: string, activation: Activation) =>
    invoke<void>("cloud_remote_activate", { connectionId, activation }),
  cloudRemoteDetach: (connectionId: string) => invoke<void>("cloud_remote_detach", { connectionId }),
  // Cloud diagnostics (PRO-38): owners and administrators only, decided by the server.
  cloudDiagnostics: (windowDays: number, orgId?: string | null) => invoke<CloudDiagnostics>("cloud_diagnostics", { windowDays, orgId: orgId ?? null }),
  /** Local and in memory only: no account, no network. */
  cloudConnectionDiagnostics: (orgId?: string | null) => invoke<ConnectionClose[]>("cloud_connection_diagnostics", { orgId: orgId ?? null }),
  /** Writes the redacted export to a path the user chose. */
  cloudDiagnosticsExport: (path: string, windowDays: number, orgId?: string | null) =>
    invoke<void>("cloud_diagnostics_export", { path, windowDays, orgId: orgId ?? null }),

  // opt-in device pairing
  pairingStatus: () => invoke<PairingStatus>("pairing_status"),
  pairingRetryRelay: () => invoke<PairingStatus>("pairing_retry_relay"),
  pairingGenerate: (connectionMode: PairingConnectionMode) => invoke<PairingStatus>("pairing_generate", { connectionMode }),
  pairingRevoke: (deviceId: string) => invoke<PairingStatus>("pairing_revoke", { deviceId }),
  /** Let the phone waiting on this Mac finish pairing (docs/PAIRING-APPROVAL.md). */
  pairingApprove: (requestId: string) => invoke<PairingStatus>("pairing_approve", { requestId }),
  /** Refuse it: the unclaimed device, its token and the active code are discarded. */
  pairingDecline: (requestId: string) => invoke<PairingStatus>("pairing_decline", { requestId }),
  /** End a device's live connections and keep its pairing; the phone stops reconnecting. */
  pairingDisconnect: (deviceId: string) => invoke<PairingStatus>("pairing_disconnect", { deviceId }),
  /** Keep this Mac awake while a phone is connected. */
  pairingSetKeepAwake: (enabled: boolean) => invoke<PairingStatus>("pairing_set_keep_awake", { enabled }),
  /** This Mac's name as the user's other devices show it (#686). */
  machineName: () => invoke<MachineName>("machine_name"),
  /** Name this Mac; null lets it follow the computer's own name again. */
  setMachineName: (name: string | null) => invoke<MachineName>("set_machine_name", { name }),

  // projects
  repositoryFilesPreview: (path: string, patterns?: string[], snapshot?: string) => invoke<RepositoryFilesPreview>("repository_files_preview", { path, patterns, snapshot }),
  /** The repository's top-level folders (and one level down) for choosing a sparse checkout; `measure` also sums their sizes at HEAD, which takes longer. */
  repositoryFolders: (path: string, measure: boolean) => invoke<RepositoryFolders>("repository_folders", { path, measure }),
  listProjects: () => invoke<{ projects: Project[]; lastSelected: string | null }>("list_projects"),
  addProject: (path: string) => invoke<Project>("add_project", { path }),
  chatsDir: () => invoke<string>("chats_dir"),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  selectProject: (path: string) => invoke<void>("select_project", { path }),
  updateProject: (path: string, patch: ProjectPatch) => invoke<Project>("update_project", { path, patch }),
  setProjectLogo: (path: string, source: string | null) => invoke<Project>("set_project_logo", { path, source }),
  listWorkspaces: (projectPath: string) => invoke<Workspace[]>("list_workspaces", { projectPath }),
  repoMirrorStatus: (sessionId: string) => invoke<RepoMirrorStatus>("repo_mirror_status", { sessionId }),
  repoMirrorStart: (sessionId: string, confirmed: boolean) => invoke<RepoMirrorStatus>("repo_mirror_start", { sessionId, confirmed }),
  repoMirrorStop: (sessionId: string) => invoke<RepoMirrorStatus>("repo_mirror_stop", { sessionId }),
  previewWorkspaceName: (projectPath: string, requested?: string | null) =>
    invoke<string>("preview_workspace_name", { projectPath, requested: requested ?? null }),
  renameWorkspace: (projectPath: string, path: string, name: string) =>
    invoke<WorkspaceRename>("rename_workspace", { projectPath, path, name }),
  /** What earlier deletes left on disk. Reads only, apart from fetching each project's default branch. */
  scanLeftovers: () => invoke<Leftover[]>("scan_leftovers"),
  /** Delete the confirmed leftovers; each is checked again first. `run` names it in its progress events. */
  removeLeftovers: (ids: string[], run?: string) => invoke<LeftoverRemoval>("remove_leftovers", { ids, run: run ?? null }),
  /** How far the removal `run` is, until the returned function is called. */
  onLeftoverProgress: (run: string, onProgress: (progress: LeftoverProgress) => void) => onRunProgress("leftover_cleanup_progress", run, onProgress),
  /** Every worktree of the open local projects with what the clean-up may do with it. Reads only. */
  worktreeCleanupScan: (projectPaths?: string[]) => invoke<CleanupProject[]>("worktree_cleanup_scan", { projectPaths: projectPaths ?? null }),
  /** What removing one worktree would free; null when `job` was cancelled. */
  worktreeCleanupSize: (job: string, projectPath: string, path: string) => invoke<number | null>("worktree_cleanup_size", { job, projectPath, path }),
  worktreeCleanupCancelSizes: (prefix: string) => invoke<void>("worktree_cleanup_cancel_sizes", { prefix }),
  /** Remove the confirmed worktrees; each is checked again first. `run` names it in its progress events and to `worktreeCleanupStop`. */
  worktreeCleanupRemove: (items: CleanupRemoveItem[], run?: string) => invoke<CleanupResult[]>("worktree_cleanup_remove", { items, run: run ?? null }),
  /** How far the removal `run` is, until the returned function is called. */
  onWorktreeCleanupProgress: (run: string, onProgress: (progress: CleanupProgress) => void) => onRunProgress("worktree_cleanup_progress", run, onProgress),
  /** Leave the worktrees the removal `run` has not started. The one it is on is finished first. */
  worktreeCleanupStop: (run: string) => invoke<void>("worktree_cleanup_stop", { run }),
  /** Say what quitting now would cut short, so the app asks first; null when it is over. */
  setQuitWarning: (warning: string | null) => invoke<void>("set_quit_warning", { warning }),
  workspaceSize: (projectPath: string, path: string) => invoke<number>("workspace_size", { projectPath, path }),
  /**
   * What a workspace holds. With `fetch`, the default branch is fetched and
   * the clean-and-merged check is made too (`landed`); that is for the
   * dialog about to delete it. Without it, nothing touches the network.
   */
  workspaceDisposition: (projectPath: string, path: string, options: { fetch?: boolean } = {}) =>
    invoke<WorkspaceDisposition>("workspace_disposition", { projectPath, path, fetch: options.fetch ?? false }),
  /** Remove a workspace through the one checked path. */
  removeWorkspace: (projectPath: string, path: string, options: WorkspaceRemoveOptions) =>
    invoke<WorkspaceRemoveReport>("remove_workspace", { projectPath, path, ...options }),

  previewWorkspaceRestore: (sessionId: string) => invoke<WorkspaceRestorePreview>("preview_workspace_restore", { sessionId }),
  restoreWorkspace: (sessionId: string, expected: WorkspaceRestorePreview, newBranch: string | null, detached = false) =>
    invoke<SessionEntry[]>("restore_workspace", { sessionId, expected, newBranch, detached }),

  // sessions
  listSessions: () => invoke<SessionEntry[]>("list_sessions"),
  sessionRowStatuses: (ids: string[]) => invoke<Record<string, import("@terminalx/portable/sessionStatus").SessionStatusInput>>("session_row_statuses", { ids }),
  /** Card snippets for the agent dashboard; every session when no ids are given. */
  sessionSummaries: (sessionIds?: string[]) => invoke<SessionSummary[]>("session_summaries", { sessionIds: sessionIds ?? null }),
  statsUsageSnapshot: () => invoke<StatsUsageState>("stats_usage_snapshot"),
  statsUsageRefresh: (scope: string, generation: number) => invoke<StatsUsageState>("stats_usage_refresh", { scope, generation }),
  appActivitySummary: () => invoke<AppStats>("app_activity_summary"),
  createSession: (req: NewSession) => invoke<SessionEntry>("create_session", { req }),
  /** A session with no project, in a scratch directory of its own (or in `cwd`, which does not become a project). */
  createQuickChat: (req: NewQuickChat) => invoke<SessionEntry>("create_quick_chat", { req }),
  /** Run a quick chat in another folder; `null` returns it to its scratch directory. Its agents restart there. */
  setQuickChatCwd: (sessionId: string, cwd: string | null) => invoke<SessionEntry>("set_quick_chat_cwd", { sessionId, cwd }),
  /** Turn a quick chat into an ordinary session of a project (added if it is not attached yet), keeping its history. */
  moveQuickChatToProject: (sessionId: string, projectPath: string) => invoke<SessionEntry>("move_quick_chat_to_project", { sessionId, projectPath }),
  /** What a session's scratch directory holds, for the delete confirmation. */
  quickChatScratch: (sessionId: string) => invoke<QuickChatScratch>("quick_chat_scratch", { sessionId }),
  /** `account` (#980): the agent account it starts on; absent, the one its agent's tabs in the session asked for. */
  addTab: (sessionId: string, tab: NewTab, account?: string | null) =>
    invoke<TabEntry>("add_tab", account ? { sessionId, tab, account } : { sessionId, tab }),
  /** Close an agent tab. One that holds a conversation stays reopenable (`reopenTab`); nothing of it is deleted. */
  removeTab: (sessionId: string, tabId: string) => invoke<void>("remove_tab", { sessionId, tabId }),
  /** Bring a closed tab back into its session, with its conversation. */
  reopenTab: (sessionId: string, tabId: string) => invoke<TabEntry>("reopen_tab", { sessionId, tabId }),
  /** Give an agent tab the reader's own title. It stays the tab's name whatever runs in the tab (#437); `null` gives the naming back. */
  renameTab: (sessionId: string, tabId: string, title: string | null) => invoke<void>("rename_tab", { sessionId, tabId, title }),
  tabState: () => invoke<TabState>("tab_state"),
  /** Save one workspace's tab order, pins, mutes and titles for every window and device. */
  setTabLayout: (workspace: string, layout: TabLayout) => invoke<void>("set_tab_layout", { workspace, layout }),
  renameSession: (sessionId: string, title: string) => invoke<void>("rename_session", { sessionId, title }),
  renameBranch: (projectPath: string, from: string, to: string) =>
    invoke<{ branch: string; project: Project; sessions: SessionEntry[] }>("rename_branch", { projectPath, from, to }),
  localVm: {
    status: () => invoke<LocalVmStatus>("local_vm_status"),
    /** Pulls the desktop image the first time; agents started after it is up are offered it. */
    start: () => invoke<LocalVmStatus>("local_vm_start"),
    stop: () => invoke<LocalVmStatus>("local_vm_stop"),
    reset: () => invoke<LocalVmStatus>("local_vm_reset"),
    /** Start Colima, or open Docker Desktop. */
    startRuntime: () => invoke<LocalVmStatus>("local_vm_start_runtime"),
  },
  /** Take the agent's title for a conversation still named automatically; the change arrives as `session_updated`. */
  adoptAgentTitle: (sessionId: string) => invoke<void>("adopt_agent_title", { sessionId }),
  /** A project at a glance: branches, contributors, the newest commits and pull requests. */
  projectOverview: (projectPath: string) => invoke<ProjectOverview>("project_overview", { projectPath }),
  setSessionArchived: (sessionId: string, archived: boolean) =>
    invoke<void>("set_session_archived", { sessionId, archived }),
  /** Archive or bring back several sessions at once: all of them, or none when one is not a session (#718). */
  setSessionsArchived: (sessionIds: string[], archived: boolean) =>
    invoke<SessionEntry[]>("set_sessions_archived", { sessionIds, archived }),
  /** This window shows `sessionId` now (or none): the idle sweep leaves it in the list. */
  setShownSession: (sessionId: string | null) => invoke<void>("set_shown_session", { sessionId }),
  /**
   * Archive the sessions nobody has written in for the limit in Settings, in the runtime that knows what each is
   * doing (#718). `keep`: what this window shows. Resolves to the ids archived; the windows hear of each as usual.
   */
  archiveIdleSessions: (keep: string[]) => invoke<string[]>("archive_idle_sessions", { keep }),
  setSessionStatus: (sessionId: string, status: import("@/types/session").ManualStatus) => invoke<void>("set_session_status", { sessionId, status }),
  setSessionPinned: (sessionId: string, pinned: boolean) => invoke<void>("set_session_pinned", { sessionId, pinned }),
  setActiveTab: (sessionId: string, tabId: string) => invoke<void>("set_active_tab", { sessionId, tabId }),
  /** Delete one session; its workspace and every other session stay. */
  deleteSession: (sessionId: string) => invoke<void>("delete_session", { sessionId }),
  /** The workspace this session could take along: its worktree, when no other session runs there. */
  soleWorkspaceOf: (sessionId: string) => invoke<string | null>("sole_workspace_of", { sessionId }),
  /** Keep the worktree on disk but run the session in the project itself from now on. */
  relocateSession: (sessionId: string) => invoke<SessionEntry>("relocate_session", { sessionId }),
  forkSession: (sessionId: string, tabId: string) => invoke<SessionEntry>("fork_session", { sessionId, tabId }),
  /** Fork the conversation as it stood at the end of the turn `endSeq` (PRO-379), into a tab beside it or a session of its own. */
  forkTurn: (sessionId: string, tabId: string, endSeq: number, into: "tab" | "session") =>
    invoke<{ session: SessionEntry; tabId: string; note: string | null }>("fork_turn", { sessionId, tabId, endSeq, into }),

  // harnesses
  listHarnesses: () => invoke<HarnessInfo[]>("list_harnesses"),

  // first-party command line tool and discovery skill
  cliToolStatus: () => invoke<CliToolStatus>("cli_tool_status"),
  installCliTool: () => invoke<CliToolStatus>("install_cli_tool"),
  cliSkillStatus: () => invoke<SkillInstallStatus>("cli_skill_status"),
  installCliSkill: () => invoke<SkillInstallStatus>("install_cli_skill"),

  // computer use: the helper app's Accessibility and Screen Recording grants
  computerPermissionStatus: () => invoke<ComputerPermissionStatus>("computer_permission_status"),
  computerOpenPermission: (id: ComputerPermissionId | null) =>
    invoke<ComputerPermissionSetup>("computer_open_permission", { id }),
  computerResetPermissions: () => invoke<ComputerPermissionStatus>("computer_reset_permissions"),

  // built-in browser runtime (agent-browser + Chromium)
  browserRuntimeStatus: () => invoke<BrowserRuntimeStatus>("browser_runtime_status"),
  browserInstallBrowser: () => invoke<BrowserRuntimeStatus>("browser_install_browser"),

  // git
  workStatus: (cwd: string) => invoke<WorkStatus>("work_status", { cwd }),
  /** `base`: the ref the session's worktree was made from, read against instead of the default branch. */
  branchOverview: (cwd: string, base?: string | null, localOnly = false) => invoke<BranchOverview>("branch_overview", { cwd, base: base ?? null, localOnly }),
  projectForge: (cwd: string) => invoke<ProjectForge>("project_forge", { cwd }),
  /** Brings the remote's branches up to date; false when it could not (offline, no remote). */
  branchFetch: (cwd: string) => invoke<boolean>("branch_fetch", { cwd }),
  /** Retained for command clients; the Branch panel sends an agent prompt instead. */
  branchMergeInto: (cwd: string, into: string) => invoke<string>("branch_merge_into", { cwd, into }),
  // The local mirror of a cloud workspace (PRO-25, docs/CLOUD-MIRROR.md).
  // None of these takes a local path: the native side derives the mirror's
  // directory from the two ids and only reports it back (`root`).
  cloudMirrorStatus: (organizationId: string, workspaceId: string) => invoke<CloudMirrorStatus>("cloud_mirror_status", { organizationId, workspaceId }),
  /** `account` is who is signed in: the mirrors on this computer are recorded as theirs. */
  cloudMirrorEnable: (organizationId: string, workspaceId: string, account: string) =>
    invoke<CloudMirrorStatus>("cloud_mirror_enable", { organizationId, workspaceId, account }),
  cloudMirrorDisable: (organizationId: string, workspaceId: string, removeFiles: boolean) =>
    invoke<CloudMirrorStatus>("cloud_mirror_disable", { organizationId, workspaceId, removeFiles }),
  cloudMirrorCheck: (organizationId: string, workspaceId: string) =>
    invoke<{ diverged: CloudMirrorDivergence[]; divergedTotal: number; discarded: number }>("cloud_mirror_check", { organizationId, workspaceId }),
  cloudMirrorPlan: (organizationId: string, workspaceId: string, manifest: CloudMirrorManifestInput) =>
    invoke<CloudMirrorPlan>("cloud_mirror_plan", { organizationId, workspaceId, manifest }),
  cloudMirrorStage: (organizationId: string, workspaceId: string, relative: string, dataB64: string, size: number, etag: string) =>
    invoke<void>("cloud_mirror_stage", { organizationId, workspaceId, relative, dataB64, size, etag }),
  cloudMirrorList: () => invoke<{ organizationId: string; workspaceId: string }[]>("cloud_mirror_list"),
  /** Says who is using the app; mirrors made under another account are removed. Returns how many. */
  cloudMirrorClaimOwner: (account: string, legacyEmail: string | null) => invoke<number>("cloud_mirror_claim_owner", { account, legacyEmail }),
  /** The saved session could not be read at this launch: mirrors are kept for a bounded time, then removed. Returns how many were. */
  cloudMirrorNoteUnreadable: () => invoke<number>("cloud_mirror_note_unreadable"),
  /** Removes what the mirror wrote; files the person added and their exports stay. */
  cloudMirrorPurge: (organizationId: string, workspaceId: string) => invoke<number>("cloud_mirror_purge", { organizationId, workspaceId }),
  cloudMirrorPublish: (organizationId: string, workspaceId: string, manifest: CloudMirrorManifestInput, etags: Record<string, string>) =>
    invoke<CloudMirrorPublished>("cloud_mirror_publish", { organizationId, workspaceId, manifest, etags }),
  cloudMirrorResolve: (organizationId: string, workspaceId: string, manifest: CloudMirrorManifestInput, resolution: "discard" | "export") =>
    invoke<{ paths: number; exportedTo: string | null }>("cloud_mirror_resolve", { organizationId, workspaceId, manifest, resolution }),
  /** The person's global Git identity; it authors their commits in cloud workspaces. */
  gitIdentity: () => invoke<{ name: string; email: string } | null>("git_identity"),
  listBranches: (cwd: string) => invoke<BranchInfo[]>("list_branches", { cwd }),
  turnCheckpoint: (sessionId: string, tabId: string, seq: number) => invoke<TurnCheckpoint | null>("turn_checkpoint", { sessionId, tabId, seq }),
  keepTurn: (sessionId: string, tabId: string, seq: number) => invoke<void>("keep_turn", { sessionId, tabId, seq }),
  restoreUndo: (sessionId: string, tabId: string, seq: number, confirmed: string | null = null) => invoke<TurnUndoResult>("restore_undo", { sessionId, tabId, seq, confirmed }),
  undoTurn: (sessionId: string, tabId: string, seq: number, confirmed: string | null = null) => invoke<TurnUndoResult>("undo_turn", { sessionId, tabId, seq, confirmed }),
  snapshotTree: (cwd: string) => invoke<string>("snapshot_tree", { cwd }),
  headTree: (cwd: string) => invoke<string | null>("head_tree", { cwd }),
  reviewRange: (cwd: string, target: string | null, uncommitted: boolean) =>
    invoke<{ target: string; base: string; head: string }>("review_range", { cwd, target, uncommitted }),
  changesBetween: (cwd: string, base: string, head: string | null, hideWhitespace = false) =>
    invoke<ChangedFile[]>("changes_between", { cwd, base, head, hideWhitespace }),
  diffMediaContent: (cwd: string, path: string, tree: string | null) =>
    invoke<{ data: string; mime: string } | null>("diff_media_content", { cwd, path, tree }),
  fileContentsAt: (cwd: string, path: string, base: string, head: string | null) =>
    invoke<{ before: string | null; after: string | null; beforeSize?: number | null; afterSize?: number | null }>("file_contents_at", { cwd, path, base, head }),
  logCommits: (cwd: string, range?: string | null, limit?: number) =>
    invoke<CommitInfo[]>("log_commits", { cwd, range: range ?? null, limit: limit ?? 100 }),
};

export interface OrganizationSummary {
  id: string;
  name: string;
  role: string;
  /** The user's personal organization (PRO-69); absent from older servers. */
  isPersonal?: boolean;
  /** What the cloud offers in this organization (PRO-69); absent from older servers. */
  cloud?: { enabled: boolean; flags: Record<string, boolean> } | null;
  /** The organization's cloud computer name and colour (PRO-370); null or absent when not chosen. */
  computerName?: string | null;
  computerColor?: string | null;
}

export interface AccountIdentity {
  name: string | null;
  email: string;
  organization: string | null;
  /** The active (default) organization's id. */
  organizationId?: string | null;
  /** The person's picture from the sign-in service, an https: URL; absent when it sends none. */
  picture?: string | null;
}

export interface AccountStatus {
  state: "signed-out" | "signing-in" | "signed-in";
  identity: AccountIdentity | null;
  expiresAt: number | null;
  lastError: string | null;
  /** The saved session could not be read: signed-out because nothing loaded, not because anyone signed out. */
  sessionUnreadable?: boolean;
  /**
   * `scope` and `revision` include the active Organization; `account` is the
   * user and profile alone (CS-18), what cloud state belongs to when every
   * member Organization is live.
   */
  context?: { scope: string; revision: string; account?: string } | null;
  organizations?: OrganizationSummary[];
  /** The server authorizes desktop cloud routes by membership (`cloud.desktop.multi-org.v1`, CS-18). */
  multiOrg?: boolean;
  /** The server lists every member organization's cloud workspaces in one request (`cloud.desktop.catalog-feed.v1`, PRO-74). */
  catalogFeed?: boolean;
  /** The server lets any member create a cloud workspace and manage the ones they created (`cloud.workspaces.member-managed.v1`, PRO-73). */
  memberWorkspaces?: boolean;
  /** The server takes `wake: false` on an agent command and refuses a stopped workspace instead of starting it (`cloud.workspaces.agent-command-wake.v1`, PRO-89). */
  agentCommandWake?: boolean;
  /** True only when the account service reports account.work-claims.v1. */
  workClaims?: boolean;
}

/** One organization of the catalog feed: its list, or why it was not listed (the others are unaffected). */
export interface CloudCatalogOrganization {
  orgId: string;
  presence?: { activeMembers: PresencePerson[] };
  workspaces: CloudWorkspaceListItem[];
  tombstones: CloudWorkspaceTombstone[];
  quota?: CloudWorkspaceQuota | null;
  error?: string | null;
}

/**
 * `cloud_catalog_feed` (saas contract §23). `changed: false` is the server's
 * 304: the catalog `cursor` names is still current. `reset` means the answer
 * is the whole catalog; without it, only the workspaces that changed are
 * listed and `deletedWorkspaceIds` names the ones to drop.
 */
export interface CloudCatalogFeed {
  /** Native authenticated identity, never a selector supplied by the page. */
  viewerUserId?: string;
  changed: boolean;
  cursor: string | null;
  reset: boolean;
  organizations: CloudCatalogOrganization[];
  deletedWorkspaceIds: string[];
}

export interface CloudMirrorRepository {
  repo: string;
  branch: string | null;
  head: string | null;
}

/** The last sync that was published in full. */
export interface CloudMirrorRevision {
  manifestId: string;
  atMs: number;
  files: number;
  bytes: number;
  repositories: CloudMirrorRepository[];
}

export interface CloudMirrorStatus {
  enabled: boolean;
  /** Where the mirrored files are on this computer. For display and "show in folder" only. */
  root: string;
  revision: CloudMirrorRevision | null;
  files: number;
}

export interface CloudMirrorDivergence {
  path: string;
  reason: "modified" | "deleted" | "replaced" | "in-the-way";
}

export interface CloudMirrorManifestInput {
  manifestId: string;
  repositories: CloudMirrorRepository[];
  entries: { path: string; size: number; version: string; executable: boolean }[];
  truncated: boolean;
}

export interface CloudMirrorPlan {
  fetch: string[];
  fetchBytes: number;
  remove: number;
  unchanged: number;
  diverged: CloudMirrorDivergence[];
  divergedTotal: number;
  /** Listed by the workspace and left out on this computer, by reason. */
  refused: { secret: number; toolConfig: number; gitDirectory: number; collision: number; tooLong: number; invalid: number; onDisk: number };
  upToDate: boolean;
}

export interface CloudMirrorPublished {
  status: CloudMirrorStatus;
  diverged: CloudMirrorDivergence[];
  divergedTotal: number;
  written: number;
  removed: number;
  /** Written, then removed again: on the disk they turned out to be something a mirror never holds. */
  takenBack: number;
}

/**
 * A cloud provider's id. Which ones exist is the server's to say (PRO-415):
 * the app lists, names, draws and asks for them from their descriptors.
 */
export type CloudWorkspaceProviderId = string;
export type CloudWorkspaceReleaseDisposition = "destroyed" | "archived" | "terminalx-only";
export type CloudWorkspaceNetworkPolicy = "relay-only" | "provider-public-network";

export interface CloudProviderCapabilities {
  suspend: boolean;
  resume: boolean;
  releaseDisposition: CloudWorkspaceReleaseDisposition;
  locationSelection: "required" | "automatic";
  sourceSelection: "required" | "optional" | "none";
  pricing: "provider-rate" | "estimate" | "unavailable";
}

/** One input of a provider's credential, asked for in the app's secure dialog. */
export interface CloudProviderCredentialField {
  name: string;
  /** `secret` is never shown; `text` may be. */
  kind: "secret" | "text" | string;
  label: string;
  helpUrl: string | null;
}

/**
 * Whose credential a provider's machines run on. `organization`: a key the
 * organization connects. `platform`: TerminalX's own (PRO-452), so there is
 * nothing to connect, replace, check or disconnect.
 */
export type CloudProviderCredentialSource = "organization" | "platform";

/** Everything the app shows about a provider, as the server describes it (PRO-415). */
export interface CloudProviderDescriptor {
  id: CloudWorkspaceProviderId;
  label: string;
  /** A generic glyph word (`ship`, `server`, `cloud`, `container`); see `cloudProviderIcon`. */
  icon: string;
  order: number;
  description: string;
  billing: string;
  billedByProvider: boolean;
  /** False: hidden, listed only while the organization is still connected to it. */
  listed: boolean;
  /**
   * Absent from a server older than platform providers, and then
   * `organization`. Read it with `cloudProviderCredentialSource`, which also
   * takes a value this app does not know for `organization`.
   */
  credentialSource?: CloudProviderCredentialSource;
  /** Empty for a platform provider: nobody is asked for a credential. */
  credentialFields: CloudProviderCredentialField[];
  capabilities: {
    pauseResumeWithMemory: boolean;
    stopStart: boolean;
    snapshots: boolean;
    exec: boolean;
    computeRunsUntilStopped: boolean;
  };
  offering: {
    locations: string;
    sources: string;
    machineClasses: string;
    pricingSource: string;
    suspendedBilling: string;
  };
  allowedIdleSuspendMinutes: number[];
  allowedRetentionDays: number[];
}

export interface CloudProviderSummary {
  id: CloudWorkspaceProviderId;
  displayName: string;
  availability: "available" | "not-connected" | "attention-required" | "disabled-for-create";
  canManage: boolean;
  connection: {
    state: "connected" | "attention-required";
    connectedAt: number;
    lastValidatedAt: number | null;
    credentialFingerprint: string | null;
  } | null;
  capabilities: CloudProviderCapabilities;
  /** Null from a server older than described providers. */
  descriptor: CloudProviderDescriptor | null;
}

export type AgentLoginProvider = "codex" | "claude" | "cursor";

// ---- personal agent model routes (PRO-18)

/** The agents a route can be for: Cursor's CLI supports neither a custom endpoint nor a credential helper. */
export type AgentRouteAgent = "claude" | "codex";
export type AgentRouteMode = "custom-endpoint" | "user-managed";
export type AgentRouteFieldKey = "baseUrl" | "authScheme" | "model" | "helperPath";

export interface AgentRouteField {
  key: AgentRouteFieldKey;
  kind: "url" | "choice" | "model" | "path";
  required: boolean;
  label: string;
  help: string;
  choices?: { value: string; label: string }[];
  default?: string;
}

/** One provider template of the service's catalog, which is versioned on its own. */
export interface AgentRouteTemplate {
  id: string;
  version: number;
  provider: AgentRouteAgent;
  mode: AgentRouteMode;
  label: string;
  description: string;
  fields: AgentRouteField[];
  /** What a custom endpoint stores; null for a helper, whose credential never reaches the app. */
  credential: { label: string; help: string } | null;
  capabilities: { modelList: "anthropic" | "openai"; defaultBaseUrl?: string; modelPicker: boolean };
  docs: string;
}

export type AgentRouteSettings = Partial<Record<AgentRouteFieldKey, string>>;

/** A check of a route: codes and model ids only, never what the endpoint or helper said. */
export interface AgentRouteCheckResult {
  outcome: "ok" | "unverified" | "failed";
  code?: string;
  httpStatus?: number;
  models?: string[];
}

/** A workspace's check of a route version. */
export interface AgentRouteCheck extends AgentRouteCheckResult {
  workspaceId: string;
  version: number;
  checkedAt: number;
}

export interface AgentRoute {
  id: string;
  provider: AgentRouteAgent;
  mode: AgentRouteMode;
  templateId: string;
  templateVersion: number;
  /** False when the catalog no longer offers this template version: it still works as saved. */
  templateCurrent: boolean;
  settings: AgentRouteSettings;
  credentialStored: boolean;
  credentialUpdatedAt?: number;
  version: number;
  updatedAt: number;
  /** The newest workspace check of this version. */
  status: "not-checked" | "connected" | "unverified" | "failed";
  lastCheck?: AgentRouteCheck;
}

export interface AgentRoutes {
  catalogVersion: number;
  agents: string[];
  templates: AgentRouteTemplate[];
  routes: AgentRoute[];
}

export interface AgentRouteSave {
  /** The organization the page names; null is the active one. */
  organizationId: string | null;
  contextRevision: string;
  agent: AgentRouteAgent;
  templateId: string;
  settings: AgentRouteSettings;
  /** 0 when no route is stored. */
  expectedVersion: number;
  /** Ask for a credential in the app's secure dialog; otherwise the stored one is kept where it may be. */
  enterCredential: boolean;
  /** Save even when this Mac's check of the endpoint fails. */
  saveUnchecked: boolean;
}

export interface AgentRouteSaved {
  saved: boolean;
  /** This Mac's check of the endpoint, when a credential was entered. */
  check: AgentRouteCheckResult | null;
  routes: AgentRoutes | null;
}
/** `api-key`: typed into a native secure dialog. `local-login`: the agent's own login on this computer. */
export type AgentLoginSource = "api-key" | "local-login";

/** What the service says about a stored agent login; never the login. */
export interface AgentLogin {
  provider: AgentLoginProvider;
  authKind: "api-key" | "oauth-credentials-json" | (string & {});
  fingerprint: string;
  displayIdentity?: string;
  version: number;
  updatedAt: number;
  state?: "connected" | "revoked" | "disconnected" | (string & {});
  sharedUse?: "organization" | "managers" | (string & {});
  /** In the list only: the person who connected this subscription login no longer owns or administers the organization. */
  configurerLeft?: boolean;
}

export interface ClaudeLoginStarted {
  attemptId: string;
  authorizeUrl: string;
  expiresInSeconds: number;
  /** The browser was asked to open the page. */
  opened: boolean;
}

export interface ClaudeLoginOutcome {
  status: "complete" | "code-invalid" | "unavailable" | "pending" | "expired" | "canceled" | "failed" | (string & {});
  credential?: AgentLogin;
  attemptsLeft?: number;
}

export interface CodexLoginStarted {
  attemptId: string;
  /** The one-time code to enter at OpenAI. Shown in the sign-in dialog and nowhere else. */
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
}

export interface CodexLoginStatus {
  status: "waiting" | "complete" | "expired" | "cancelled" | "failed" | "unconfirmed" | (string & {});
  credential?: AgentLogin;
  /** `unconfirmed`: why the service did not confirm storing it. */
  errorCode?: string;
}

export interface AgentLoginConsent {
  /** The page's account context (`status.context.revision`), whichever organization the login is for. */
  contextRevision: string;
  organizationSharing: boolean;
  machineInstallation: boolean;
  /** The login now stored for the agent may be replaced; required when there is one. */
  replaceExisting: boolean;
  /** The organization the login is for (PRO-107); absent or null is the active one. */
  organizationId?: string | null;
}

export interface CloudProviderSummaryResponse {
  providers: CloudProviderSummary[];
}

export interface CloudProviderConnection {
  provider: CloudWorkspaceProviderId;
  state: "not-connected" | "connected" | "attention-required";
  canManage: boolean;
  credentialFingerprint: string | null;
  connectedAt: number | null;
  lastValidatedAt: number | null;
  credentialVersion?: number | null;
  providerAccount?: string | null;
  operationsBlocked?: boolean | null;
  disconnectDisposition?: "retain" | "destroy" | null;
  /** `archive` while a disconnect that archives is under way; its workspaces are deleted at `retentionDeadline`. */
  disconnectRetention?: "archive" | (string & {}) | null;
  retentionDeadline?: number | null;
  resources?: CloudProviderResource[] | null;
}

/** One thing an organization still has at a provider, in a teardown's inventory (saas contract §10.7). */
export interface CloudTeardownResource {
  provider: string;
  id: string;
  kind: string;
  state: string;
  releaseDisposition: string | null;
  cleanupRequired: boolean;
  deleteAfter: number | null;
}

/** What a teardown would take, as counts (no names or ids). */
export interface CloudTeardownPreview {
  organizationId: string;
  workspaces: number;
  /** Private workspaces created by someone other than the caller. */
  othersPrivateWorkspaces: number;
  archivedWorkspaces: number;
  /** Names exactly the set counted; it goes back with the request. */
  token: string;
}

/** An organization-wide cloud teardown: what was asked, the deadline, and what still blocks completion. */
export interface CloudTeardown {
  organizationId: string;
  disposition: "archive" | "destroy" | (string & {});
  requestedAt: number;
  retentionDeadline: number;
  completedAt: number | null;
  resources: CloudTeardownResource[];
  remaining: CloudTeardownResource[];
}

export interface CloudProviderConnectInput {
  contextRevision: string;
  disclosure: {
    version: string;
    providerBillingAccepted: true;
    organizationUseAccepted: true;
  };
}


export interface CloudWorkspaceProviderSelection {
  sourceId: string;
  locationId: string;
  machineClassId: string;
  idleSuspendMinutes: number;
  retentionDays: number;
  networkPolicy: CloudWorkspaceNetworkPolicy;
}

export interface CloudWorkspaceSetup {
  provider: CloudWorkspaceProviderId;
  credentialFingerprint: string;
  currency: "USD" | "EUR";
  pricing: "provider-rate" | "estimate";
  pricingObservedAt: number;
  sources: { id: string; kind: "image" | "template" | "provider-default"; label: string; description: string | null }[];
  locations: { id: string; label: string; placement: "selected" | "automatic" }[];
  machineClasses: {
    id: string;
    label: string;
    vcpu: number;
    memoryMiB: number;
    diskGiB: number;
    activeHourlyMicros: number | null;
  }[];
  defaults: CloudWorkspaceProviderSelection;
  /** Already limited to the organization's idle cap; 0 is never. */
  allowedIdleSuspendMinutes: number[];
  allowedRetentionDays: number[];
  /** The organization's idle cap (PRO-410); null or absent with none, or from an older server. */
  maxIdleSuspendMinutes?: number | null;
}

/** A workspace's idle window and what it may be changed to (PRO-410). */
export interface CloudWorkspaceIdleSuspend {
  workspaceId: string;
  /** Minutes without activity before it is stopped, 0 for never. */
  idleSuspendMinutes: number | null;
  allowedIdleSuspendMinutes: number[];
  maxIdleSuspendMinutes: number | null;
}

export interface CloudWorkspaceQuoteInput extends CloudWorkspaceProviderSelection {
  provider: CloudWorkspaceProviderId;
}

export interface CloudWorkspaceQuote {
  id: string;
  provider: CloudWorkspaceProviderId;
  expiresAt: number;
  currency: "USD" | "EUR";
  pricing: "provider-rate" | "estimate";
  pricingObservedAt: number;
  activeHourlyMicros: number;
  alwaysOnThirtyDayMicros: number;
  estimatedSuspendedMonthlyMicros: number | null;
  configuration: CloudWorkspaceProviderSelection & {
    sourceLabel: string;
    locationLabel: string;
    machineClassLabel: string;
    vcpu: number;
    memoryMiB: number;
    diskGiB: number;
    architecture: "x86_64" | "arm64";
  };
}

export interface CloudWorkspace {
  id: string;
  orgId: string;
  name: string;
  provider: CloudWorkspaceProviderId;
  state: "provisioning" | "ready" | "suspended" | "archived" | "attention-required" | "destroyed";
  accessMode: "private" | "organization";
  createdAt: number;
  updatedAt: number;
  releaseDisposition: CloudWorkspaceReleaseDisposition | null;
  /** The launch intent it was created with (PRO-21, contract §19). */
  launch?: CloudWorkspaceLaunch | null;
  /** Set while archived, including an archive that failed (terminalx-saas contract §10.1). */
  archivedAt?: number | null;
  /** When an archived workspace is deleted for good. */
  deleteAfter?: number | null;
  deletedAt?: number | null;
  /**
   * S1 list enrichment (PRO-56), optional because older servers do not send it: the
   * repositories it was built from (primary first), and when anything last
   * happened in it.
   */
  repositories?: CloudWorkspaceRepository[] | null;
  createdBy?: string | null;
  creator?: PresencePerson | null;
  lastActivityAt?: number | null;
  /** Minutes without activity before TerminalX stops it, 0 for never (PRO-410); absent from older servers. */
  idleSuspendMinutes?: number | null;
  /** The runtime's own activity report (S1; named so it is not the runtime build). */
  runtimeActivity?: { online: boolean; reporting?: boolean; reportedAt: number | null; stale?: boolean; activeTurns: number; pendingApprovals: number } | null;
  /** Monotonic per workspace (S1). */
  revision?: number | null;
  /** What opening it would grant this caller (S1). */
  authority?: "manage" | "participate" | (string & {}) | null;
  /** This person's collaboration role (PRO-30, saas contract §21.2); absent from older servers. */
  you?: { role: CloudCollaborationRole; canApprove: boolean; canManageShares?: boolean } | null;
  /** How many members it is shared with; only reported to someone with a role. */
  sharedWith?: number | null;
  /**
   * The agent command kinds the API takes for it (terminalx-saas#289).
   * Absent from a server that takes only send, steer, stop and
   * permission-decision, and refuses any other.
   */
  agentCommandKinds?: string[] | null;
  /** A preparation workspace (PRO-20): when the server stops it for good. Absent on every other workspace. */
  preparation?: { stopAfter: number } | null;
  checkout?: { state: "ready" | "failed"; repositories: { repository: string; state: "ready" | "failed"; category?: string }[]; reportedAt: number } | null;
  runtime?: { sha256: string; protocol: number | null; installedAt: number } | null;
}

/** One repository checkout of a workspace, as the enriched list reports it (S1). */
export interface CloudWorkspaceRepository {
  identity: string | null;
  /** Null for a repository no longer selected for the organization. */
  fullName: string | null;
  cloneUrl: string | null;
  ref?: string | null;
  targetDirectory?: string | null;
  primary?: boolean;
}

/** A delete's cleanup report, until the provider confirms (§10.4). Unknown kinds and states are shown as they come. */
export interface CloudWorkspaceCleanup {
  complete: boolean;
  items: {
    kind: "runtime-credentials" | "client-attachments" | "provider-compute" | "provider-storage" | "workspace-content" | (string & {});
    state: "removed" | "pending" | "retained-by-provider" | "unconfirmed" | (string & {});
    providerStage: string | null;
    expectedBy: number | null;
    /** The provider's id for the deletion it accepted (admins only; absent from an older server). */
    providerOperationId?: string;
  }[];
}

/** A deleted workspace, content-free, listed for 30 days so this Mac purges what it kept (§10.5). */
export interface CloudWorkspaceTombstone {
  id: string;
  orgId: string;
  deletedAt: number;
  expiresAt: number;
}

/** What the server knows before an archive or delete (§10.2). */
export interface CloudWorkspaceDisposition {
  workspaceId: string;
  state: string;
  provider: string;
  archivedAt: number | null;
  deleteAfter: number | null;
  activeOperation: { id: string; action: string; state: string } | null;
  runtime: { reporting: boolean; reportedAt: number | null; stale: boolean; activeTurns: number; pendingApprovals: number };
  attachedClients: number;
  /** `preservesProcessesOnResume` is absent from an older server: then it is not known. */
  providerCapabilities: { permanentDelete: boolean; releaseDisposition: string; preservesProcessesOnResume?: boolean | null };
  archiveRetentionDays: number;
  /** The periods an archive may ask for instead; absent or empty from a server that takes no choice. */
  archiveRetentionChoices?: number[];
  blockers: ("active-turns" | "pending-approvals" | "operation-in-progress" | (string & {}))[];
  removedOnDelete: string[];
  runtimeFacts: { available: boolean };
}

/** What a share grants (contract §21.2). */
export type CloudShareRole = "viewer" | "driver" | "manager";
/** A person's effective role on a workspace (§21.1); `none` sees no content. */
export type CloudCollaborationRole = "manager" | "driver" | "viewer" | "none";

export interface CloudWorkspaceShare {
  userId: string;
  email: string;
  name: string | null;
  role: CloudShareRole;
  canApprove: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** When a scheduled task runs. `hour` is ignored for `hourly`; `weekdays` belong to `weekly`. */
export interface CloudScheduleTiming {
  preset: "hourly" | "daily" | "weekdays" | "weekly";
  hour: number;
  minute: number;
  weekdays: string[];
  /** IANA, e.g. `Europe/Berlin`. The local time holds across daylight-saving changes. */
  timezone: string;
}

/** Upper bounds on what a scheduled task costs and occupies, from the workspace's own rate. */
export interface CloudScheduleEstimate {
  currency: string;
  hourlyMicros: number;
  /** The longest a run can keep the workspace on: starting it, the time limit, and ending the run. Absent from a server that priced the time limit alone. */
  perRunMaxMinutes?: number;
  /** Fresh workspace admission allowance, included in perRunMaxMinutes. */
  createPerRunMinutes?: number;
  perRunMaxMicros: number;
  monthlyRuns: number;
  monthlyMaxMicros: number;
  /** The machine a run starts is left on afterwards. */
  keepsMachineRunning: boolean;
  runningSlots: number;
  /** The most runs the schedule starts in any 24 hours. */
  maxRunsPerDay: number;
}

export interface CloudScheduleRun {
  id: string;
  scheduledFor: number;
  trigger: string;
  /** Own workspace link target; unavailable before fresh allocation. Never substitute the template ID. */
  workspaceId?: string | null;
  workBranch?: string | null;
  archiveAt?: number | null;
  /** Archival was observed, not merely requested. */
  archivedAt?: number | null;
  /** queued | creating-workspace | provisioning | working | completed | failed | skipped | canceled | expired */
  state: string;
  category?: string;
  sessionId?: string;
  tabId?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** A scheduled task. Its prompt is never returned. */
export interface CloudSchedule {
  id: string;
  workspaceId: string;
  name: string;
  createdBy: string;
  agent: string;
  model?: string;
  effort?: string;
  mode?: string;
  promptBytes: number;
  schedule: CloudScheduleTiming;
  missedRunPolicy: "skip" | "run-once";
  completionPolicy: "suspend" | "keep";
  maxRunMinutes: number;
  state: "active" | "paused";
  pausedReason?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  estimate: CloudScheduleEstimate;
  lastRun?: CloudScheduleRun;
}

export interface CloudScheduleDetail {
  schedule: CloudSchedule;
  runs: CloudScheduleRun[];
}

export interface CloudScheduleQuote {
  estimate: CloudScheduleEstimate;
  nextRunAt?: number;
  /** The refusal a create would get now, whatever the form says. */
  refusal?: string;
  /** Whether the workspace's runtime can take a scheduled run. */
  supported: boolean;
}

export interface CloudScheduleEstimateInput {
  workspaceId: string;
  schedule: CloudScheduleTiming;
  completionPolicy: "suspend" | "keep";
  maxRunMinutes: number;
}

export interface CloudScheduleCreateInput extends CloudScheduleEstimateInput {
  name: string;
  agent: string;
  model?: string;
  effort?: string;
  /** Never `bypassPermissions`: nobody watches a scheduled run. */
  mode: string;
  prompt: string;
  missedRunPolicy: "skip" | "run-once";
}

export interface CloudScheduleGithubFilter {
  field: "label" | "author" | "baseBranch";
  operator: "is" | "is-not";
  value: string;
}

export interface CloudScheduleGithubTrigger {
  /** Selected organization repository row ID. */
  repositoryId: string;
  event: "opened" | "pushed" | "merged";
  /** At most five, ANDed by the service. */
  filters: CloudScheduleGithubFilter[];
  /** Defaults false and is persisted. UI label: Allow pull requests from forks. */
  allowForkPullRequests?: boolean;
}

export interface CloudScheduleWebhookTrigger {
  url: string;
  secretUpdatedAt: number | null;
}

/** Raw native response. Event-based automations have no timer. */
export interface CloudAutomationDto extends Omit<CloudSchedule, "schedule" | "nextRunAt" | "lastRun"> {
  schedule?: CloudScheduleTiming | null;
  githubTrigger?: CloudScheduleGithubTrigger | null;
  webhookTrigger?: CloudScheduleWebhookTrigger | null;
  workspaceMode?: "existing" | "fresh" | null;
  archiveAfterDays?: number | null;
  archiveOnPrMerge?: boolean | null;
  nextRunAt?: number | null;
  lastRun?: CloudScheduleRun | null;
}

export interface CloudAutomationMutationDto extends CloudAutomationDto {
  /** Only returned at creation or rotation. */
  webhookSecret?: string;
}

export interface CloudAutomationDetailDto {
  schedule: CloudAutomationDto;
  runs: CloudScheduleRun[];
}

export type CloudAutomationTriggerInput =
  | { schedule: CloudScheduleTiming; githubTrigger?: never; webhookTrigger?: never }
  | { schedule?: never; githubTrigger: CloudScheduleGithubTrigger; webhookTrigger?: never }
  | { schedule?: never; githubTrigger?: never; webhookTrigger: Record<string, never> };

export type CloudAutomationWorkspaceInput =
  | { workspaceMode?: "existing"; archiveAfterDays?: never; archiveOnPrMerge?: false }
  | { workspaceMode: "fresh"; archiveAfterDays?: number; archiveOnPrMerge?: boolean };

export type CloudAutomationEstimateInput = Omit<CloudScheduleEstimateInput, "schedule"> &
  CloudAutomationTriggerInput & { workspaceMode?: "existing" | "fresh" };
export type CloudAutomationCreateInput = Omit<CloudScheduleCreateInput, "schedule"> &
  CloudAutomationTriggerInput & CloudAutomationWorkspaceInput;

/** Existing timer UI only. No fabricated timer or fresh workspace identity. */
function projectLegacyCloudSchedule(value: CloudAutomationDto): CloudSchedule | null {
  if (value.schedule == null || value.githubTrigger != null || value.webhookTrigger != null || (value.workspaceMode != null && value.workspaceMode !== "existing")) return null;
  return { ...value, schedule: value.schedule, nextRunAt: value.nextRunAt ?? undefined, lastRun: value.lastRun ?? undefined };
}

function requireLegacyCloudSchedule(value: CloudAutomationDto): CloudSchedule {
  const schedule = projectLegacyCloudSchedule(value);
  if (schedule === null) throw new Error("This automation requires the automation API.");
  return schedule;
}

export interface CloudWorkspaceShares {
  shares: CloudWorkspaceShare[];
  you: { role: CloudCollaborationRole; canApprove: boolean; canManageShares: boolean };
}

export type CloudWorkspaceLaunchPhase =
  | "allocating"
  | "booting"
  | "authenticating-runtime"
  | "syncing-repository"
  | "starting-agent"
  | "running"
  | "failed"
  | "canceled";

export interface CloudWorkspaceLaunch {
  launchId: string;
  /** A newer server may add phases; unknown ones are shown as they come. */
  phase: CloudWorkspaceLaunchPhase | (string & {});
  state: string;
  workBranch: string;
  agent: string;
  model: string | null;
  effort: string | null;
  mode: string | null;
  hasPrompt: boolean;
  category: string | null;
  sessionId: string | null;
  tabId: string | null;
  timings: {
    requestedAt: number | null;
    bootingAt: number | null;
    authenticatingAt: number | null;
    syncingAt: number | null;
    startingAgentAt: number | null;
    runningAt: number | null;
    failedAt: number | null;
  };
}

export interface CloudWorkspaceOperation {
  id: string;
  workspaceId: string;
  type: "create";
  action: "suspend" | "resume" | "archive" | "delete" | null;
  /** Original wire action when projected to the compatible resume recovery path. */
  transportAction?: "restart";
  state: "queued" | "running" | "cancel-requested" | "succeeded" | "failed" | "canceled";
  stage: "queued" | "preflight" | "creating-machine" | "bootstrapping" | "connecting-relay" | "cleanup" | "ready";
  cancelable: boolean;
  createdAt: number;
  updatedAt: number;
  lastProviderContactAt: number | null;
  nextAttemptAt: number | null;
  retryReason: "rate-limited" | null;
  errorCode: CloudWorkspaceOperationErrorCode | null;
  /** The provider's own normalized error code for a failed operation, when the server reports one; never a message or body. */
  providerErrorCode?: string | null;
  /** The server's own detail for a failed operation, beside its error code (`box_deleted_sandbox_present`); absent from an older server. */
  detailCode?: string | null;
  progress: { phase: "allocating" | "starting" | "installing-runtime" | "connecting-relay" | "suspending" | "releasing"; retryAt: number | null } | null;
  events: {
    code: "operation-queued" | "provider-preflight-started" | "machine-allocation-started" | "runtime-installation-started" | "credentials-installing" | "credentials-ready" | "repository-cloning" | "repository-ready" | "repository-clone-failed" | "relay-connection-started" | "provider-cleanup-started" | "workspace-ready" | "operation-failed" | "operation-canceled";
    occurredAt: number;
  }[] | null;
  /** A stop's or an archive's final checkpoint (§10.3). */
  checkpoint?: "committed" | "failed" | "timed-out" | "skipped" | (string & {}) | null;
  /** When the runtime reported it; absent when it never answered. */
  checkpointAt?: number | null;
  cleanup?: CloudWorkspaceCleanup | null;
  logs?: { source: string; content: string; occurredAt: number }[];
  reason?: "idle" | "provider-stopped" | "attention-stopped";
  reasonDetail?: string;
}

/** Canonical decimal bigint strings, never converted to JS numbers. ISO event/marker timestamps. */
export interface DesktopReadMarker { sessionId: string; readAt: string }
export type DesktopInboxEvent =
  | { id: string; type: "workspace.share-removed"; workspaceId: string; createdAt: string }
  | { id: string; type: "workspace.share-added" | "workspace.presence-changed"; workspaceId: string; organizationId: string; payload: Record<string, never>; createdAt: string }
  | { id: string; type: "workspace.reassigned"; workspaceId: string; organizationId: string; payload: WorkspaceReassignedPayload; createdAt: string }
  | { id: string; type: "workspace.read-marker-changed"; workspaceId: string; organizationId: string; payload: DesktopReadMarker; createdAt: string };
export interface WorkspaceReassignedPayload { actorId: string; previousOwnerId: string; note?: string }
export interface DesktopInboxPage { v: 1; cursor: string; hasMore: boolean; events: DesktopInboxEvent[] }
export interface DesktopInboxStreamPage { cursor: string; events: DesktopInboxEvent[] }

export interface CloudWorkspaceDetailsResponse { workspace: CloudWorkspace; details: CloudWorkspaceDetails }
/** Original pinned setup. Timestamps here and on workspace are epoch milliseconds. */
export interface CloudWorkspaceDetails {
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  provider: string;
  repositories: { identity: string | null; fullName: string | null; cloneUrl: string; ref: string | null; targetDirectory: string | null; primary: boolean }[];
  machineId: string | null;
  environmentVersionId: string | null;
  environmentVersion: { id: string; versionNumber: number; toolchainVersion: number } | null;
  runtime: { sha256: string; protocol: number | null; installedAt: number } | null;
  /** Manager-only console organization entry link, not an expanded-row deep link. */
  provisioningLog: { url: string; operationId: string | null } | null;
}

/** Exact native/server DTO. Existing catalog recovery consumes the compatible projection below. */
export interface CloudWorkspaceOperationDto extends Omit<CloudWorkspaceOperation, "action" | "transportAction"> {
  action: CloudWorkspaceOperation["action"] | "restart";
}

export interface CloudWorkspaceSnapshotDto {
  workspace: CloudWorkspace;
  operation: CloudWorkspaceOperationDto;
}

export interface CloudWorkspaceListItemDto extends Omit<CloudWorkspaceListItem, "latestOperation"> {
  latestOperation: CloudWorkspaceOperationDto | null;
}

export interface CloudWorkspaceListDto extends Omit<CloudWorkspaceList, "workspaces"> {
  workspaces: CloudWorkspaceListItemDto[];
}

export interface CloudCatalogFeedDto extends Omit<CloudCatalogFeed, "organizations"> {
  organizations: (Omit<CloudCatalogOrganization, "workspaces"> & { workspaces: CloudWorkspaceListItemDto[] })[];
}

/** Failed restart recovers through resume on the same machine. Keep the wire action for display. */
export function projectCloudWorkspaceOperation(operation: CloudWorkspaceOperationDto): CloudWorkspaceOperation {
  const { action } = operation;
  return action === "restart" ? { ...operation, action: "resume", transportAction: "restart" } : { ...operation, action };
}

/** Use before inserting an exact restart/poll DTO into the existing catalog. */
export function projectCloudWorkspaceSnapshot(snapshot: CloudWorkspaceSnapshotDto): CloudWorkspaceSnapshot {
  return { ...snapshot, operation: projectCloudWorkspaceOperation(snapshot.operation) };
}

function projectCloudWorkspaceItem(item: CloudWorkspaceListItemDto): CloudWorkspaceListItem {
  return { ...item, latestOperation: item.latestOperation ? projectCloudWorkspaceOperation(item.latestOperation) : null };
}

function projectCloudWorkspaceList(list: CloudWorkspaceListDto): CloudWorkspaceList {
  return { ...list, workspaces: list.workspaces.map(projectCloudWorkspaceItem) };
}

function projectCloudCatalogFeed(feed: CloudCatalogFeedDto): CloudCatalogFeed {
  return { ...feed, organizations: feed.organizations.map((org) => ({ ...org, workspaces: org.workspaces.map(projectCloudWorkspaceItem) })) };
}

export interface CloudWorkspaceSnapshot {
  workspace: CloudWorkspace;
  operation: CloudWorkspaceOperation;
}

export interface CloudWorkspaceListItem {
  following?: boolean;
  workspace: CloudWorkspace;
  latestOperation: CloudWorkspaceOperation | null;
  readMarkers?: DesktopReadMarker[];
  presence?: { activeMembers: PresencePerson[] };
}

export interface CloudWorkspaceList {
  workspaces: CloudWorkspaceListItem[];
  tombstones?: CloudWorkspaceTombstone[];
  /** Non-archived workspaces against the organization's limit (S1); absent from older servers. */
  quota?: CloudWorkspaceQuota | null;
}

/**
 * A count against a limit. The organization has no limit where `limit` is
 * absent (PRO-371): the server leaves the key out, and a null means the same.
 * Read it with `limitOf` (runningLimit.ts), never by comparing: in JavaScript
 * `used >= null` is true.
 */
export interface CloudLimitUsage {
  used: number;
  limit?: number | null;
}

/** The organization's workspace slots (§20.1); `used`/`limit` mirror `running` since PRO-76. */
export interface CloudWorkspaceQuota extends CloudLimitUsage {
  running?: CloudLimitUsage;
  total?: CloudLimitUsage;
}

/** Retain this exact key when reconciling an ambiguous create response. */
export interface CloudWorkspaceCreateInput {
  name: string;
  quoteId: string;
  accessMode: "private" | "organization";
  confirmProviderSpend: true;
  idempotencyKey: string;
  /** The primary repository first, then additional ones (at most five). */
  repositories?: CloudWorkspaceRepositoryInput[];
  launch?: CloudWorkspaceLaunchInput | null;
  /** "Configure with an agent" (PRO-20): the server marks, isolates and time-limits the workspace. */
  preparation?: boolean;
}

export interface CloudWorkspaceRepositoryInput {
  cloneUrl: string;
  /** The base branch; the repository's default branch when absent. */
  ref?: string | null;
}

export interface CloudWorkspaceLaunchInput {
  agent: string;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
  prompt?: string | null;
  /** Settings → Experimental → Native Codex for a Codex launch (#745): the runtime starts the first tab on Codex's app server where it can. */
  nativeCodex?: boolean;
}

/** A workspace port reachable at `http://127.0.0.1:<localPort>` on this Mac. */
export interface CloudPortForward {
  port: number;
  localPort: number;
  reassigned: boolean;
  /**
   * `open`: listening on this Mac now. `waiting`: kept while the connection is
   * away or Forwarding is off, and opened again (same local port when free)
   * once it is back: a paired machine's forwards return when it reconnects,
   * a cloud workspace's do not (PRO-355). Absent from an older desktop: `open`.
   */
  state?: "open" | "waiting";
  /** Opened by "Forward new ports automatically", not by the person. */
  auto?: boolean;
}

/**
 * A connection's forwarding switches (14.10, 14.11), kept by the desktop for
 * as long as the connection is held. `enabled` is the master "Forwarding":
 * off closes every listener and keeps them as `waiting`; on opens them again.
 * `auto` forwards each port that starts listening after it was turned on,
 * outside 32768–60999 (`AUTO_FORWARD_SKIPPED`).
 */
export interface CloudPortSettings {
  enabled: boolean;
  auto: boolean;
}

/** Ports auto-forwarding leaves alone: the ephemeral range, where clients bind, not servers. */
export const AUTO_FORWARD_SKIPPED = { from: 32768, to: 60999 } as const;

/**
 * `cloud_port_forwards_changed`: a connection's forwards or switches changed,
 * whoever changed them. `opened` lists forwards that opened without a click
 * here (auto-forwarded, or returned after a reconnect), for the toast.
 */
export interface CloudPortForwardsChanged {
  connectionId: string;
  forwards: CloudPortForward[];
  settings: CloudPortSettings;
  opened: CloudPortForward[];
}
export const CLOUD_PORT_FORWARDS_CHANGED = "cloud_port_forwards_changed";

export interface CloudWorkspacePreflight {
  ready: boolean;
  checks: {
    kind: string;
    cloneUrl: string | null;
    /** On an `agent-credential` check from an API that answers per agent: the agent it is about. */
    agent?: string | null;
    status: "verified" | "failed";
    errorCode: string | null;
    retryable: boolean;
  }[];
}

export interface CloudSelectedRepository {
  /** Selected organization repository row ID, when returned by the server. */
  id?: string | null;
  fullName: string;
  cloneUrl: string | null;
  defaultBranch: string | null;
  private: boolean;
  state: "accessible" | "missing" | "installation-suspended" | "installation-revoked" | (string & {});
  reason: string | null;
}

export interface CloudSelectedRepositories {
  configured: boolean;
  repositories: CloudSelectedRepository[];
}

/** Held PRO-137 transport: UUID/payload ownership and retries belong to a future caller. */
export interface WorkspaceReassignInput { targetUserId: string; expectedOwnerId: string; requestId: string; confirmPrivate?: boolean; note?: string }
export interface WorkspaceFollowingResponse { workspaceId: string; following: boolean }
/** reassigned=false is a committed request receipt, not current ownership. */
export interface WorkspaceReassignResponse { workspaceId: string; ownerId: string; previousOwnerId: string; reassigned: boolean }

export interface PresencePutInput { deviceId: string; sequence: number; workspaceId: string | null }
export interface PresenceReadInput { workspaceIds: string[] }
export interface PresencePerson { userId: string; displayName: string | null; photoUrl: string | null }
/** Owner follows current created_by; identities never use an email fallback. */
export interface PresenceWorkspace { workspaceId: string; owner: PresencePerson; activeMembers: PresencePerson[] }
export interface PresencePutResponse { applied: boolean; ttlSeconds: 45 }
/** Workspaces are a requested-visible subset; activeMembers spans all visible workspaces. */
export interface PresenceReadResponse { ttlSeconds: 45; activeMembers: PresencePerson[]; workspaces: PresenceWorkspace[] }

export interface CloudWorkspaceClientError {
  code: CloudWorkspaceSafeErrorCode;
  status: number | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
  retryWithSameIdempotencyKey: boolean;
  requiresOriginalAccountContext: boolean;
}

export type CloudWorkspaceSafeErrorCode =
  | "workspace_owner_changed"
  | "workspace_reassign_same_owner"
  | "workspace_reassign_private_confirmation_required"
  | "workspace_reassign_target_not_visible"
  | "workspace_reassign_busy"
  | "workspace_reassign_personal_route_held"
  | "workspace_reassign_credential_restricted"
  | "workspace_reassign_runtime_unsupported"
  | "workspace_reassign_idempotency_conflict"
  | "cloud_workspace_last_admin"
  | "workspace_following_unavailable"
  | "presence_rate_limited"
  | "presence_device_limit"
  | "presence_capacity_exceeded"
  | "presence_unavailable"
  | "inbox_unavailable"
  | "invalid_access_token"
  | "organization_admin_required"
  | "active_organization_required"
  | "cloud_workspace_not_found"
  | "cloud_workspace_operation_not_found"
  | "machine0_connection_required"
  | "cloud_provider_not_found"
  | "cloud_provider_disabled"
  | "cloud_provider_connection_required"
  | "cloud_provider_connection_attention_required"
  | "cloud_provider_creation_disabled"
  | "cloud_provider_operation_in_progress"
  | "cloud_provider_credential_invalid"
  | "cloud_provider_permission_denied"
  | "cloud_provider_rate_limited"
  | "cloud_provider_invalid_response"
  | "cloud_provider_billing_required"
  | "cloud_provider_unavailable"
  | "cloud_workspace_provider_unsupported"
  | "cloud_workspace_credential_required"
  | "cloud_workspace_credential_in_use"
  | "cloud_workspace_credential_invalid"
  | "cloud_workspace_credential_verification_unavailable"
  | "cloud_workspace_repository_credential_required"
  | "cloud_workspace_repository_not_accessible"
  | "cloud_workspace_repository_ref_not_found"
  | "cloud_workspace_repository_verification_unavailable"
  | "cloud_workspace_agent_credential_required"
  | "cloud_agent_credential_reauth_required"
  | "cloud_workspace_device_auth_unavailable"
  | "cloud_workspace_operation_in_progress"
  | "cloud_workspace_active_work"
  | "cloud_workspace_archived"
  | "cloud_teardown_in_progress"
  | "cloud_workspace_quota_exceeded"
  | "cloud_workspace_concurrency_exceeded"
  | "cloud_workspace_manager_required"
  | "cloud_workspace_runtime_unsupported"
  | "cloud_workspace_runtime_not_ready"
  | "cloud_workspace_member_concurrency_exceeded"
  | "cloud_preparation_workspace_expired"
  | "idempotency_key_reused"
  | "cloud_workspace_quote_expired"
  | "cloud_workspace_request_invalid"
  | "cloud_workspace_rate_limited"
  | "machine0_invalid_response"
  | "machine0_unavailable"
  | "cloud_workspace_policy_denied"
  | "cloud_provisioning_paused"
  | "cloud_compute_policy_conflict"
  | "cloud_environment_changed"
  | "cloud_environment_repository_not_in_image"
  | "cloud_environment_version_missing"
  | "cloud_workspace_repository_invalid"
  | "cloud_workspace_github_installation_unavailable"
  | "github_app_not_configured"
  | "github_app_unavailable"
  | "github_repository_not_accessible"
  | "github_repository_not_authorized"
  | "github_repository_not_granted"
  | "github_repository_unavailable"
  | "github_installation_suspended"
  | "github_installation_revoked"
  | "organization_member_not_found"
  | "cloud_workspace_share_unavailable"
  | "cloud_workspace_share_not_found"
  | "cloud_workspace_share_redundant"
  | "cloud_workspace_share_requires_organization_access"
  | "cloud_workspace_share_limit"
  | "cloud_workspace_share_forbidden"
  | "cloud_workspace_collaboration_forbidden"
  | "cloud_workspace_name_invalid"
  | "cloud_workspace_repositories_too_many"
  | "cloud_workspace_repository_duplicate"
  | "cloud_workspace_repository_ref_invalid"
  | "cloud_workspace_launch_invalid"
  | "cloud_workspace_prompt_too_long"
  | "cloud_workspace_unknown_error"
  | "cloud_workspace_invalid_response"
  | "cloud_workspace_unavailable"
  | "cloud_workspace_request_outcome_unknown"
  | "cloud_workspace_create_outcome_unknown"
  | "cloud_workspace_client_invalid"
  | "cloud_workspace_client_unavailable"
  | "account_signed_out"
  | "account_organization_unavailable"
  | "account_context_changed";

export type CloudWorkspaceOperationErrorCode =
  | CloudWorkspaceSafeErrorCode
  | "provider_retry_exhausted"
  | "provider_reconciliation_required"
  | "provider_cleanup_pending"
  | "machine0_provisioning_failed"
  | "relay_attestation_pending"
  | "attachment_revocation_pending"
  | "cloud_provider_ambiguous_mutation"
  | "cloud_provider_quota_exhausted"
  | "cloud_provider_capacity_unavailable"
  | "cloud_provider_state_conflict"
  | "cloud_provider_idempotency_key_reused"
  | "cloud_provider_idempotency_window_expired"
  | "cloud_provider_unsupported"
  | "provider_permanent_delete_unavailable"
  | "runtime_checkpoint_pending"
  | "cloud_workspace_runtime_bootstrap_failed"
  | "cloud_workspace_provisioning_timeout"
  | "cloud_provider_permission_denied";

export interface CliToolStatus {
  installed: boolean;
  directory: string;
  commands: string[];
}

export interface SkillTargetStatus {
  path: string;
  installed: boolean;
}

export interface SkillInstallStatus {
  installed: boolean;
  targets: SkillTargetStatus[];
}

export type ComputerPermissionId = "accessibility" | "screenshots";

export interface ComputerPermissionState {
  id: ComputerPermissionId;
  status: "granted" | "not-granted" | "unsupported";
}

export interface ComputerPermissionStatus {
  platform: string;
  helperAppPath: string | null;
  helperUnavailableReason: string | null;
  /**
   * What this launch's removal of older computer-use helpers' permissions
   * reported (PRO-90); absent until it has run. `removed: false` means macOS
   * would not clear them and the person has to remove the old entry.
   */
  legacyHelper?: { removed: boolean; bundleIds: string[] } | null;
  permissions: ComputerPermissionState[];
}

export interface ComputerPermissionSetup extends ComputerPermissionStatus {
  permissionId?: ComputerPermissionId;
  openedSettings: boolean;
  launchedHelper: boolean;
  nextStep: string | null;
}

export const automationsApi = {
  list: () => invoke<Automation[]>("automations_list"),
  runs: (automationId: string) => invoke<AutomationRun[]>("automation_runs", { automationId }),
  issueStates: () => invoke<AutomationIssueState[]>("automation_issue_states"),
  issuePreview: (projectPath: string, repo: string, query: string) =>
    invoke<Issue[]>("automation_issue_preview", { projectPath, repo, query }),
  sourcePreview: (projectPath: string, source: AutomationEventSource) =>
    invoke<SourceMatch[]>("automation_source_preview", { projectPath, source }),
  create: (input: AutomationInput) => invoke<Automation>("automation_create", { input }),
  update: (id: string, input: AutomationInput) => invoke<Automation>("automation_update", { id, input }),
  remove: (id: string) => invoke<void>("automation_delete", { id }),
  runNow: (id: string) => invoke<AutomationRun>("automation_run_now", { id }),
  tryPrecheck: (input: PrecheckTryInput) => invoke<PrecheckTrial>("automation_precheck_try", { input }),
};

/** Bots (PRO-466). Every one of these is refused while Settings → Experimental → Bots is off. */
export const botsApi = {
  /** Every bot, with the revision they were read at (as `bots_changed` carries it). */
  list: () => invoke<BotList>("bot_list"),
  get: (id: string) => invoke<Bot>("bot_get", { id }),
  templates: () => invoke<BotRoleTemplate[]>("bot_templates"),
  /** Hire a bot: a role and a name, everything else on its default. */
  create: (roleTemplateId: string, name: string) => invoke<Bot>("bot_create", { roleTemplateId, name }),
  update: (id: string, patch: BotPatch) => invoke<Bot>("bot_update", { id, patch }),
  /** The bot's home folder goes to the app's trash. */
  remove: (id: string) => invoke<void>("bot_delete", { id }),
  /** `from`: where in the window it was paused, said on the pause (PRO-474). */
  pause: (id: string, from: BotPauseFrom = "app") => invoke<Bot>("bot_pause", { id, from }),
  resume: (id: string) => invoke<Bot>("bot_resume", { id }),
  pauseAll: (from: BotPauseFrom = "app") => invoke<BotList>("bots_pause_all", { from }),
  /** What the paused bots hold (23.12). */
  pauseHeld: () => invoke<PauseHeld>("bots_pause_held"),
  resumeAll: () => invoke<BotList>("bots_resume_all"),
  /** The bot's standing instructions, its `ROLE.md`. */
  roleRead: (id: string) => invoke<string>("bot_role_read", { id }),
  /** `expected` is the hash of the text the editor started from: a role changed since is not written over. */
  roleWrite: (id: string, text: string, expected?: string) => invoke<Bot>("bot_role_write", { id, text, expected: expected ?? null }),
  /** The bot's home chat (PRO-468), made again when it is missing. */
  homeChat: (id: string) => invoke<SessionEntry>("bot_home_chat", { id }),
  /** Another conversation with the bot, in its home folder. */
  newChat: (id: string) => invoke<SessionEntry>("bot_new_chat", { id }),
  /** Say no to a resume asked for from the `terminalx` CLI: the bot stays paused. */
  dismissResume: (id: string) => invoke<Bot>("bot_dismiss_resume", { id }),
  spentToday: (id: string) => invoke<{ usd: number; day: string }>("bot_spent_today", { id }),
  /** Its newest mentions on GitHub and Linear (none of their text) and what it posted there (PRO-480). */
  channels: (id: string) => invoke<import("@/types/botChannels").BotChannelsView>("bot_channels", { id }),
  /** Its Slack and Telegram connections, the chats linked and the newest messages, none of their text (PRO-481). */
  chatApps: (id: string) => invoke<import("@/types/botChatApps").BotChatAppsView>("bot_chat_apps", { id }),
  /** Check the tokens with the service and keep them with the bots' other logins: never in the bot's record. */
  chatAppConnect: (id: string, service: string, tokens: Record<string, string>) => invoke<{ service: string; account: { name: string } }>("bot_chat_app_connect", { id, service, tokens }),
  chatAppDisconnect: (id: string, service: string) => invoke<unknown>("bot_chat_app_disconnect", { id, service }),
  /** A one-time code: the chat it is sent from is linked. */
  chatAppLink: (id: string, service: string) => invoke<import("@/types/botChatApps").BotChatAppsView>("bot_chat_app_link", { id, service }),
  chatAppUnlink: (id: string, service: string, chat: string) => invoke<import("@/types/botChatApps").BotChatAppsView>("bot_chat_app_unlink", { id, service, chat }),
  chatAppAlsoSends: (id: string, services: string[]) => invoke<import("@/types/botChatApps").BotChatAppsView>("bot_chat_app_also_sends", { id, services }),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

// ---- status bar
export interface StatusBarSettings {
  visible: boolean;
  usage: boolean;
  resources: boolean;
  percent: "used" | "remaining";
  usageMode: "detailed" | "compact";
  /** Minutes between automatic usage refreshes; 0 turns the timer off. */
  usageRefreshMinutes: number;
}

/** What Settings offers for `usageRefreshMinutes`; the backend accepts no others. */
export const USAGE_REFRESH_MINUTES = [0, 1, 2, 5, 15] as const;

export interface UsageWindow {
  agent: "claude" | "codex";
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number | null;
  updatedAt: number;
  stale: boolean;
  source?: string;
}

/** Why a received window did not replace the one shown under its key. */
export type UsageRefusal = "earlierWindow" | "olderObservation" | "noDeadline" | "notYetStarted" | "endedWindow";

/** A manual refresh that did not reach the provider, and when the button will. */
export interface UsageRefreshSkip {
  at: number;
  reason: "inFlight" | "retryPending" | "recent" | "resetInFlight";
  nextAt: number | null;
}

/** Live usage from a Claude turn that was not used, newer than any that was. */
export interface LiveUsageRefused {
  at: number;
  reason: "unidentified" | "launchUnknown" | "launchMismatch" | "statuslineMismatch";
}

// The fields marked optional below are absent from a background runtime older than #729.
export interface UsageSnapshot {
  /** Counts within `runtime` alone: a runtime that replaced another counts from 1 again (#772). */
  revision?: number;
  /** The runtime's usage store this snapshot came from, new each time a runtime starts (#772). Absent before #772. */
  runtime?: string | null;
  claudeAccount?: string | null;
  claude?: {
    retryAt: number | null;
    revalidateAt: number | null;
    error: string | null;
    /** When the provider last answered. */
    lastSuccessAt?: number | null;
    /** When an answer last replaced a shown window; older than `lastSuccessAt` when the latest changed nothing. */
    lastUpdatedAt?: number | null;
    /** Windows in the latest answer that did not replace the shown ones. */
    refused?: Array<{ key: string; label: string; reason: UsageRefusal }>;
    skipped?: UsageRefreshSkip | null;
    liveRefused?: LiveUsageRefused | null;
  };
  codexRefresh?: { retryAt: number | null; error: string | null; lastSuccessAt: number | null; skipped?: UsageRefreshSkip | null };
  /**
   * Each agent account's usage windows (#980), under its label, for the usage popover and Stats. Absent from a
   * runtime older than accounts, and with This Mac's login alone.
   */
  accounts?: AgentAccountUsage[];
  windows: UsageWindow[];
  codex?: {
    credits?: {
      hasCredits: boolean;
      unlimited: boolean;
      balance?: string;
    };
    resetCredits?: {
      availableCount: number;
      nextExpiresAt?: number;
    };
  };
}

export interface ResourceOverview {
  agentCount: number;
  orphanCount: number;
  rssBytes: number | null;
  pressure: number | null;
}

export interface ProcSample {
  paneId: string;
  tabId: string | null;
  tabTitle: string;
  sessionId: string | null;
  sessionTitle: string | null;
  projectPath: string | null;
  projectName: string | null;
  cwd: string;
  kind: "agent" | "shell";
  harness: "claude" | "codex" | null;
  orphaned: boolean;
  pid: number | null;
  cpuPercent: number | null;
  rssBytes: number | null;
  childCount: number | null;
  /** `stop`: a tab's idle agent, stopped (its conversation kept) once confirmed. */
  killRule: "none" | "idle" | "confirm" | "stop";
}

export interface AppSample {
  mainPid: number;
  mainCpuPercent: number | null;
  mainRssBytes: number | null;
  webviewCpuPercent: number | null;
  webviewRssBytes: number | null;
  webviewProcessCount: number;
}

export interface HostSample {
  totalBytes: number | null;
  availableBytes: number | null;
  cores: number;
}

export interface ResourceSnapshot {
  processes: ProcSample[];
  app: AppSample;
  host: HostSample;
  totalCpuPercent: number | null;
  totalRssBytes: number | null;
  sampledAt: number;
}

export interface KillResult {
  killed: boolean;
  confirmation: string | null;
}

/**
 * Why the runtime cannot hold bots by this window's proof (PRO-489). `pinned`: it pinned the window's key and did not
 * take this app for its window, which could not prove it; Try again registers again with the proof. Otherwise it was
 * started without the key, and tells a person's commands from a bot's by where they come from alone until it restarts.
 */
export interface LocalRuntimeUnproven {
  why: string;
  pinned: boolean;
  /** The runtime pinned another key than the one this window's Keychain holds now: Try again cannot repair that, and
   * Restart runtime is offered instead, as `runtime_restart_required:<epoch>: <message>` (PRO-507). */
  restart?: string;
}

/**
 * One window's live connection to the local runtime (`supervisor.rs`). A new
 * `generation` is a new attachment; a new `view` is a new connection for this
 * window's terminal output alone. Either way the window attaches again.
 */
export type LocalRuntimeState =
  | { state: "inProcess" }
  /** `outdated`: the runtime is older than this app, and is replaced with the app's own (#730): handed over at once when it `keeps` what it runs (#765), otherwise once none of its agents is mid-turn. */
  /** `unproven`: while Bots is on, the runtime cannot hold bots by this window's proof (PRO-489), and why. */
  | { state: "connected"; epoch: string; generation: number; view: number; outdated?: LocalRuntimeOutdated; unproven?: LocalRuntimeUnproven }
  /** Re-establishing by itself. `terminal`: only this window's terminal output is down. */
  | { state: "connecting"; terminal: boolean; attempt: number; retryInMs: number; downMs: number; message: string }
  /** Retrying cannot help until something outside this window changes. `startFailed`: the runtime the desktop started exited before it attached (PRO-287). */
  | { state: "unavailable"; message: string; startFailed?: LocalRuntimeStartFailed }
  /** There, but not answering: reconnecting reaches the same wedged runtime (#661). `keeps`: restarting it hands what it runs to a fresh runtime first (#765). */
  | { state: "unresponsive"; message: string; epoch: string | null; keeps: boolean }
  /** The runtime is being replaced with the one bundled with this app (#730). `from`: its version, when it said. `keeping`: it is handed over, and its agents and terminals keep running (#765). */
  | { state: "updating"; from: string | null; to: string; keeping: boolean };

/**
 * A runtime older than this app, until it is replaced (#730): at once, keeping what it runs, when it can be handed over
 * (#765); otherwise once nothing it runs would be cut short, or as was chosen before the update (#766). The status bar
 * shows the wait; a switch that failed gets a notice of its own.
 */
export interface LocalRuntimeOutdated {
  /** Its version, when it said. */
  running: string | null;
  /** This app's, which the runtime that replaces it shares. */
  app: string;
  /** When it `keeps` what it runs: what its handover cannot carry, which is never stopped by itself and stops with Restart now. Otherwise what restarting it now would cut short (agents mid-turn or with prompts waiting, terminals, processes), which the switch waits for. Null until read. */
  work: string[] | null;
  /** Why that could not be read, or why the last switch failed. */
  problem: string | null;
  /** The last switch failed: it is tried again only when asked (Try again, or Restart now in the status bar). */
  failed: boolean;
  /** It is handed over to the app's own runtime, keeping its agents and terminals running (#765). */
  keeps: boolean;
  /** When it `keeps`: what `work` names, as the runtime names it. Restart now sends it back, so that only what was shown stops. */
  unkept: LocalRuntimeWorkItem[];
}

/** A runtime the desktop started that exited, or never ran, before it attached (PRO-287, `launch.rs`). */
export interface LocalRuntimeStartFailed {
  /** The executable that was started: "terminalx-serve". */
  process: string;
  /** Its exit code, when it exited. */
  code: number | null;
  /** The signal that ended it, when one did. With no code either, it never ran. */
  signal: number | null;
  /** How long it ran. */
  ranMs: number;
  /** The last error it logged while starting, or why it could not be started. */
  error: string | null;
  /** Where its log is, when it has one. */
  log: string | null;
  /** When it failed, in milliseconds since the Unix epoch. */
  at: number;
  /** This app's version. */
  app: string;
  /** "macOS 26.1 (25B78)", when it could be read. */
  os: string | null;
}

/** One thing a runtime runs, as it names it (`session::retire::Work`). Sent back as it came, never built here. */
export interface LocalRuntimeWorkItem { kind: string; sessionId?: string; tabId?: string; harness?: string; title?: string }

/** How a runtime that stopped answering is restarted (#765): keeping what it runs, stopping only what its handover cannot carry, or stopping all of it. */
export type LocalRuntimeRestart = "keeping" | "stoppingUnkept" | "stoppingAll";

/** Why a restart that would have kept what the runtime runs did not happen: nothing was stopped (#765). */
export interface LocalRuntimeRestartRefused {
  message: string;
  /** What its handover cannot carry, by name. */
  unkept: string[];
  /** The same, as the runtime names it: sent back with `stoppingUnkept`, which stops only that. */
  stop: LocalRuntimeWorkItem[];
}

/** What replacing the attached runtime now would cut short, read before an update installs (#766). */
export interface LocalRuntimeWork {
  /** The runtime it was read from. */
  epoch: string;
  /** By name; empty when nothing would be cut short. */
  work: string[];
  /** When the runtime can be handed over (#765): the same, as it names it. Update now sends it back, so that only what was listed stops. */
  unkept: LocalRuntimeWorkItem[];
  /** When it was read, in milliseconds since the Unix epoch. */
  readAt: number;
}

/** What the app an update relaunches into does with runtime `epoch` (#766, `update_plan.rs`). */
export interface LocalRuntimeUpdatePlan { epoch: string; forced: boolean; quietSince: number | null; madeAt: number; madeBy: number; stop: LocalRuntimeWorkItem[] }

export type QuitBehavior = "keepRunning" | "stopAll";
export interface LocalRuntimeSettings { quitBehavior: QuitBehavior | null }

export const localRuntime = {
  status: () => invoke<LocalRuntimeState>("local_runtime_status"),
  reconnect: () => invoke<LocalRuntimeState>("local_runtime_reconnect"),
  /** Register again with the window's proof, reading its Keychain key now (PRO-489). */
  proveWindow: () => invoke<LocalRuntimeState>("local_runtime_prove_window"),
  /** The end of the runtime's log, as it wrote it, for Copy logs (PRO-287). */
  log: () => invoke<string>("local_runtime_log"),
  /** Restart a runtime that stopped answering; the desktop attaches a fresh one. One that can be handed over keeps what it runs unless `how` says otherwise (#765); a refusal is a `LocalRuntimeRestartRefused`, with nothing stopped. */
  restart: (epoch: string | null, how: LocalRuntimeRestart = "keeping", stop: LocalRuntimeWorkItem[] = []) =>
    invoke<LocalRuntimeState>("local_runtime_restart", { epoch, how, stop }),
  /** Replace runtime `epoch`, older than this app, with the app's own now (#730): handed over, stopping only what of `stop` (what the window showed) it cannot carry (#765), or else stopping its agents and terminals. */
  replace: (epoch: string, stop: LocalRuntimeWorkItem[] = []) => invoke<LocalRuntimeState>("local_runtime_replace", { epoch, stop }),
  /** What replacing the attached runtime now would cut short; throws when it cannot tell. */
  work: () => invoke<LocalRuntimeWork>("local_runtime_work"),
  /**
   * Just before an update relaunches: replace runtime `epoch` at once (`forced`), or once nothing it runs would be
   * cut short. `quietSince` is when a reading found nothing under way; it counts only if nothing is under way now.
   * `stop`, with Update now, is what the card listed that a handover cannot carry: only that stops (#765).
   */
  planUpdate: (epoch: string, forced: boolean, quietSince: number | null, stop: LocalRuntimeWorkItem[] = []) =>
    invoke<LocalRuntimeUpdatePlan>("local_runtime_plan_update", { epoch, forced, quietSince, stop }),
  settings: () => invoke<LocalRuntimeSettings>("local_runtime_settings"),
  setQuitBehavior: (quitBehavior: QuitBehavior) => invoke<LocalRuntimeSettings>("set_local_runtime_quit_behavior", { quitBehavior }),
};

export const statusBar = {
  settings: () => invoke<StatusBarSettings>("status_bar_settings"),
  setSettings: (patch: Partial<StatusBarSettings>) =>
    invoke<StatusBarSettings>("set_status_bar_settings", { patch }),
  usage: () => invoke<UsageSnapshot>("status_usage_snapshot"),
  refreshUsage: (manual = false) => invoke<UsageSnapshot>("status_usage_refresh", { manual }),
  resetCodex: () => invoke<UsageSnapshot>("status_codex_reset"),
  resourceOverview: () => invoke<ResourceOverview>("status_resource_overview"),
  sampleResources: () => invoke<ResourceSnapshot>("status_resource_sample"),
  killResource: (paneId: string, confirmed = false) => invoke<KillResult>("status_resource_kill", { paneId, confirmed }),
};

// ---- agent tabs
import type { AgentEvent, FileRef } from "@/types/events";

export interface ImageInput {
  mediaType: string;
  data: string;
  name?: string;
}

/**
 * A file for a message before it is stored (PRO-290): a path on this computer
 * (picked, or dropped on the window), or the base64 bytes of a browser `File`
 * (pasted, or dropped on the DOM). Exactly one of `path` and `data` is set.
 */
export interface FileInput {
  name: string;
  path?: string;
  data?: string;
  mediaType?: string;
}

/** What `attachments.inspect` learns about a path before it is attached. */
export interface FileFacts {
  path: string;
  name: string;
  size: number;
  mediaType?: string;
  /** Not a regular file (a folder, a socket) or unreadable: never attached. */
  unreadable?: boolean;
}

/**
 * Files attached to a message (PRO-290). They are copied into the session's
 * attachments folder (`$TERMINALX_HOME/attachments/<session>/<folder>/<name>`,
 * removed with the session) before the message is sent, and the message
 * carries the stored `FileRef`s. The rules (10 files, reserved names, size)
 * are in `@/lib/attachmentRules`; the store enforces them again.
 */
export const attachments = {
  /** Size and media type of dropped or picked paths, in the order given. */
  inspect: (paths: string[]) => invoke<FileFacts[]>("inspect_attachments", { paths }),
  /** Copy the files into one new folder of the session's attachments folder. Refuses reserved names, files over the size limit, and more than 10. */
  store: (sessionId: string, files: FileInput[]) => invoke<FileRef[]>("store_attachments", { sessionId, files }),
  /** One part (at most 384 KiB, base64) of a file on this computer from `offset`, for an upload to a machine (PRO-407). */
  readPart: (path: string, offset: number) => invoke<{ data: string; bytes: number; size: number }>("read_attachment_part", { path, offset }),
  /** Write a copy of a stored attachment to `to` (the file tab's Download). `path` must be inside an attachments folder. */
  saveCopy: (path: string, to: string) => invoke<void>("save_attachment_copy", { path, to }),
};

export interface QueuedMessage {
  id: string;
  text: string;
  images: [string, string][];
}

export interface SendOutcome {
  queued: boolean;
  events: AgentEvent[];
  /** A continuation the agent has not taken, sitting in its input: one Enter sends it (#662). */
  inInput?: boolean;
}

/**
 * Where a continuation's delivery has got to, as the tab tells it (#662):
 * waiting on an input box that holds something else (input_occupied, #722),
 * typed, its Enter written, written again (nudged), held back because the
 * agent is not reading its input (stalled), and taken (delivered).
 */
export type DeliveryStage = "input_occupied" | "body_written" | "submit_written" | "nudged" | "stalled" | "delivered";

/**
 * Follow the deliveries of continuations into one tab. Resolves to the
 * function that stops listening.
 */
export async function onPromptDelivery(sessionId: string, tabId: string, onStage: (stage: DeliveryStage, seq: number) => void): Promise<() => void> {
  try {
    return await listen<{ sessionId: string; tabId: string; seq: number; stage: DeliveryStage }>("prompt_delivery", ({ payload }) => {
      if (payload.sessionId === sessionId && payload.tabId === tabId) onStage(payload.stage, payload.seq);
    });
  } catch {
    // Outside a webview there is no event stream; the send still answers.
    return () => {};
  }
}

import type { ModelInfo } from "@terminalx/portable/agentSettings";
export type { ModelInfo };

export interface HandoffInfo {
  command: string;
  providerSessionId?: string | null;
  harness: string;
}

/** A tab's own CLI got its terminal pane; the tab's terminal view shows it. */
export interface TabPtyEvent {
  sessionId: string;
  tabId: string;
  paneId: string;
  command: string;
  harness: string;
  /** The CLI in the pane was started by hand in it (#437). */
  byHand?: boolean;
  /** The pane holds a shell and no agent: the tab is a terminal (#437). */
  terminal?: boolean;
}

export const agent = {
  /** `portable`: for a session on another computer (PRO-348): no path of this Mac, the bounded recent capture instead. */
  prepareContinuation: (sessionId: string, tabId: string, portable = false) => invoke<import("@/lib/continuation").ContinuationContext>("prepare_continuation", portable ? { sessionId, tabId, portable } : { sessionId, tabId }),
  loadEvents: (sessionId: string, tabId: string) => invoke<AgentEvent[]>("load_tab_events", { sessionId, tabId }),
  /** `pressedAt`: when Send was pressed (ms since the epoch), for the tab's send timings (#727). */
  /** `files`: attachments already stored with `attachments.store` for this session (PRO-290). */
  send: (sessionId: string, tabId: string, text: string, images?: ImageInput[], confirmDelivery = false, pressedAt?: number, files?: FileRef[], promptRequestId?: string) =>
    invoke<SendOutcome>("send_message", { sessionId, tabId, text, images: images ?? null, confirmDelivery, ...(pressedAt === undefined ? {} : { pressedAt }), ...(files?.length ? { files } : {}), ...(promptRequestId === undefined ? {} : { promptRequestId }) }),
  /** The chat drew the message `seq` it sent: its timings join the runtime's in the tab's diagnostics (#727). */
  reportTerminalView: (sessionId: string, tabId: string, report: { transitionId: string; sequence: number; elapsedMs: number; surface: "window"; stage: "requested" | "waiting_for_turn" | "starting_terminal" | "attaching" | "opened" | "cancelled" | "failed"; errorCategory: "handoff" | "start" | "attach" | null }) =>
    invoke<void>("report_terminal_view", { sessionId, tabId, report }),
  reportSendShown: (sessionId: string, tabId: string, seq: number, timings: { pressedAt?: number; drawnAt?: number; answeredAt?: number; shownAt: number }) =>
    invoke<void>("report_send_shown", { sessionId, tabId, seq, timings }),
  /** Send the tab's last prompt again, images and all: the one its agent never received (#663). */
  resendUnsent: (sessionId: string, tabId: string) => invoke<SendOutcome>("resend_unsent", { sessionId, tabId }),
  resendMessage: (sessionId: string, tabId: string, seq: number) => invoke<SendOutcome>("resend_message", { sessionId, tabId, seq }),
  /** Press Enter in the tab's agent for the continuation `seq` left in its input. False when it is no longer waiting there. */
  submitWaiting: (sessionId: string, tabId: string, seq: number) => invoke<boolean>("submit_waiting_prompt", { sessionId, tabId, seq }),
  /** Escape for the tab's running turn; the agent's process stays. False when there was nothing running to interrupt. */
  interrupt: (sessionId: string, tabId: string) => invoke<boolean>("interrupt_turn", { sessionId, tabId }),
  tabHandoff: (sessionId: string, tabId: string) => invoke<HandoffInfo>("tab_handoff", { sessionId, tabId }),
  tabToTerminal: (sessionId: string, tabId: string, transitionId?: string) => invoke<boolean | void>("tab_to_terminal", { sessionId, tabId, transitionId }),
  /** Start a tab's own CLI. Idempotent, and a no-op for headless harnesses. */
  ensureStarted: (sessionId: string, tabId: string) => invoke<void>("ensure_tab_started", { sessionId, tabId }),
  /**
   * The tab was shown: its CLI starts as `ensureStarted` starts it, unless nobody is about to use it — its session is
   * archived or its workspace was removed, or its agent was stopped for sitting idle. Its next message starts it then (#696).
   */
  startOnOpen: (sessionId: string, tabId: string) => invoke<void>("ensure_tab_started", { sessionId, tabId, opened: true }),
  /** The pane a tab's CLI is running in, for a window that missed the event. */
  tabPane: (sessionId: string, tabId: string) => invoke<TabPtyEvent | null>("tab_pane", { sessionId, tabId }),
  /** Start a tab's agent again on one of the tab's own conversations: the one it holds, or one it held before (#437). */
  resumeConversation: (sessionId: string, tabId: string, harness: string, providerSessionId: string) =>
    invoke<void>("tab_resume_conversation", { sessionId, tabId, harness, providerSessionId }),
  /**
   * Switch account (#980): restart the tab's agent on `account` and resume its conversation; "Continue with …" at a
   * usage limit too. An agent that is not running starts on it with `providerSessionId`. The account stays the tab's.
   * Rejected while a turn runs, and by a background runtime older than accounts.
   */
  switchAccount: (sessionId: string, tabId: string, harness: string, providerSessionId: string, account: string) =>
    invoke<void>("tab_resume_conversation", { sessionId, tabId, harness, providerSessionId, account }),
  /** The person is typing in the tab's composer: automatic account switching (#981) leaves the tab alone meanwhile. */
  noteTyping: (sessionId: string, tabId: string) => invoke<void>("tab_note_typing", { sessionId, tabId }),
  /** The hard stop: ends the tab's agent process, keeping what it needs to resume. */
  stop: (sessionId: string, tabId: string) => invoke<void>("stop_tab", { sessionId, tabId }),
  /** `confirm`: the token from an overlap refusal, to go ahead with exactly the plan that was shown. */
  resetChat: (sessionId: string, tabId: string, endSeq: number | null, resetFiles: boolean, confirm?: string | null) =>
    invoke<string | null>("reset_chat", { sessionId, tabId, endSeq, resetFiles, confirm: confirm ?? null }),
  cancelQueued: (sessionId: string, tabId: string, messageId: string) =>
    invoke<QueuedMessage | null>("cancel_queued", { sessionId, tabId, messageId }),
  /** Send a message the CLI holds behind its running turn now: the turn is interrupted and the message typed again. */
  sendQueuedNow: (sessionId: string, tabId: string, seq: number) => invoke<void>("send_queued_now", { sessionId, tabId, seq }),
  changeHeldQueue: (sessionId: string, tabId: string, change: import("@/lib/heldQueue").HeldQueueChange) =>
    invoke<SendOutcome>("change_held_queue", { sessionId, tabId, change }),
  listQueued: (sessionId: string, tabId: string) => invoke<QueuedMessage[]>("list_queued", { sessionId, tabId }),
  respondPermission: (sessionId: string, tabId: string, requestId: string, optionId: string) =>
    invoke<void>("respond_permission", { sessionId, tabId, requestId, optionId }),
  answerQuestions: (sessionId: string, tabId: string, requestId: string, answers: Record<string, string>) =>
    invoke<void>("answer_questions", { sessionId, tabId, requestId, answers }),
  /** A question the agent's CLI drew in its own terminal (PRO-460): an option's index, or null for its Escape. */
  answerTerminalPrompt: (sessionId: string, tabId: string, promptId: string, choice: number | null) =>
    invoke<void>("answer_terminal_prompt", { sessionId, tabId, promptId, choice }),
  setModel: (sessionId: string, tabId: string, model: string) => invoke<void>("set_tab_model", { sessionId, tabId, model }),
  setPermissionMode: (sessionId: string, tabId: string, mode: string) =>
    invoke<void>("set_tab_permission_mode", { sessionId, tabId, mode }),
  setEffort: (sessionId: string, tabId: string, effort: string | null) =>
    invoke<void>("set_tab_effort", { sessionId, tabId, effort }),
  setUnread: (sessionId: string, tabId: string, unread: boolean) => invoke<void>("set_tab_unread", { sessionId, tabId, unread }),
  markRead: (sessionId: string, tabId: string) => invoke<void>("mark_tab_read", { sessionId, tabId }),
  listModels: (refresh?: boolean) => invoke<ModelInfo[]>("list_models", { refresh: refresh ?? false }),
};

// ---- files & commands
export interface FileHit {
  path: string;
  name: string;
  score: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  source: "builtin" | "plugin" | "user";
}

/** Every file the All files tree shows (hidden ones too, `.gitignore`d ones not), cut at `limit`. */
export interface FileCount {
  files: number;
  truncated: boolean;
}

export interface FileList {
  paths: string[];
  truncated: boolean;
}

export const files = {
  /** `includeIgnored` searches the files Git ignores as well. */
  search: (cwd: string, query: string, limit = 40, includeIgnored = false) =>
    invoke<FileHit[]>("search_files", includeIgnored ? { cwd, query, limit, includeIgnored } : { cwd, query, limit }),
  /** How many files `search` looks through; `truncated`: at least that many. */
  count: (cwd: string, includeIgnored = false) => invoke<FileCount>("count_files", { cwd, includeIgnored }),
  list: (cwd: string, limit?: number) => invoke<FileList>("list_files", { cwd, limit: limit ?? null }),
  invalidate: (cwd: string) => invoke<void>("invalidate_file_index", { cwd }),
  readImage: (path: string) => invoke<{ mediaType: string; data: string; name: string } | null>("read_image_file", { path }),
  /** The plain text of the drag that just ended on the window: the drop event itself carries only file paths. */
  droppedText: () => invoke<string | null>("dropped_text"),
  /** How a path dropped on a terminal is quoted: as the shell its terminals run reads it. */
  terminalQuoteStyle: () => invoke<"posix" | "powershell" | "cmd">("terminal_quote_style"),
  slashCommands: (cwd: string, harness: string) => invoke<SlashCommand[]>("list_slash_commands", { cwd, harness }),
};

export const skills = {
  list: (projectPath?: string | null, refresh = false) =>
    invoke<DiscoveredSkill[]>("list_skills", { projectPath: projectPath ?? null, refresh }),
  detail: (dirPath: string) => invoke<SkillDetail>("skill_detail", { dirPath }),
};

/** Copy MCP servers, slash commands and skills between Claude Code and Codex (PRO-153). */
export const agentConfigs = {
  compare: () => invoke<AgentConfigComparison>("agent_configs_compare"),
  preview: (changes: AgentConfigChange[]) => invoke<AgentConfigPreview>("agent_configs_preview", { changes }),
  apply: (changes: AgentConfigChange[], token: string) => invoke<AgentConfigWritten[]>("agent_configs_apply", { changes, token }),
};

// ---- git actions & pull requests
export interface PrCheck {
  name: string;
  state: string;
  url?: string | null;
  actions?: { runId: number; jobId: number | null } | null;
  /** When it started and finished, as GitHub gave them with the check (RFC 3339). */
  startedAt?: string | null;
  completedAt?: string | null;
  /** The line GitHub carries with it: a check run's output title, a status's description. */
  summary?: string | null;
}

export interface CheckLog {
  text: string;
  truncated: boolean;
}

export interface BranchContributor {
  name: string;
  email: string;
  commits: number;
  /** Their newest commit's author date. */
  last: string;
}

export type ProjectForge = "github" | "githubUnavailable" | "localOnly";

/** A checkout's branch against the branch it merges into, read from refs already here. */
export interface BranchOverview {
  /** Resolved by the same native function as the session header. */
  nextStep: "pull" | "reconcile" | "detached" | "conflicts" | "commit" | "empty" | "local" | "push" | null;
  branch: string | null;
  /** `origin/main`, else the local default branch; null outside a repository or without one. */
  base: string | null;
  onBase: boolean;
  /** Main checkout path reported by Git. */
  mainCheckout: string | null;
  /** Compared using canonical checkout roots, including sessions reached through symlinks. */
  inMainCheckout: boolean;
  forkPoint: CommitInfo | null;
  /** Commits only on the branch, and on the base since the fork. */
  ahead: number;
  behind: number;
  commits: CommitInfo[];
  baseCommits: CommitInfo[];
  contributors: BranchContributor[];
  baseContributors: BranchContributor[];
  upstream: string | null;
  unpushed: number;
  unpulled: number;
  /** The upstream's commits not pulled yet, newest first. */
  incoming: CommitInfo[];
  dirty: boolean;
  /** Files changed and not committed. */
  changed: number;
  /** Has a remote at all: without one there is no push and no pull request. */
  hasRemote: boolean;
  merge: { state: "clean" | "conflicts" | "merged" | "unknown"; conflicted: string[] };
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  base: string;
  head: string;
  /** The head commit GitHub has. Empty or absent on older workspace runtimes. */
  headSha?: string;
  additions: number;
  deletions: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Absent on older workspace runtimes. */
  mergeState?: string;
  mergeQueueEnabled?: boolean | null;
  mergeQueueEntry?: { position: number; state: string } | null;
  autoMergeEnabled?: boolean;
  requiredChecks?: string[] | null;
  deployments?: { name: string; state: string; url?: string | null }[];
  detailsError?: string | null;
  reviewDecision: string | null;
  checks: PrCheck[];
  body: string;
  author: string;
  /** `owner/name` of the fork its head is on; only a pull request search reads it. */
  headRepository?: string | null;
}

export const git = {
  hasRemote: (cwd: string) => invoke<boolean>("git_has_remote", { cwd }),
  addRemote: (cwd: string, url: string) => invoke<void>("git_add_remote", { cwd, url }),
  commit: (cwd: string, message: string, paths?: string[]) => invoke<string>("git_commit", { cwd, message, paths: paths ?? null }),
  push: (cwd: string) => invoke<string>("git_push", { cwd }),
  pull: (cwd: string) => invoke<string>("git_pull", { cwd }),
  discard: (cwd: string, path: string, base: string | null = null, oldPath: string | null = null) => invoke<void>("git_discard", { cwd, path, base, oldPath }),
  checkout: (cwd: string, name: string, create: boolean) => invoke<void>("git_checkout", { cwd, name, create }),
  /** On a detached HEAD, make a branch at the commit it is on, named from `name`, and check it out (PRO-295); returns the branch. */
  branchHere: (projectPath: string, cwd: string, name: string | null) => invoke<string>("git_branch_here", { projectPath, cwd, name }),
  workingChanges: (cwd: string, hideWhitespace = false) => invoke<[string, ChangedFile[]]>("working_changes", { cwd, hideWhitespace }),
  workingChangeSets: (cwd: string, hideWhitespace = false) => invoke<[string, string, ChangedFile[], ChangedFile[]]>("working_change_sets", { cwd, hideWhitespace }),
  stagePaths: (cwd: string, paths: string[]) => invoke<void>("git_stage_paths", { cwd, paths }),
  unstagePaths: (cwd: string, paths: string[]) => invoke<void>("git_unstage_paths", { cwd, paths }),
  unstageAll: (cwd: string) => invoke<void>("git_unstage_all", { cwd }),
  applyHunk: (cwd: string, path: string, oldPath: string | undefined, index: number, reverse: boolean) => invoke<void>("git_apply_hunk", { cwd, path, oldPath: oldPath ?? null, index, reverse }),
  hunkCount: (cwd: string, path: string, oldPath: string | undefined, staged: boolean) => invoke<number>("git_hunk_count", { cwd, path, oldPath: oldPath ?? null, staged }),
  generateCommitMessage: (cwd: string, agent: "claude" | "codex") => invoke<string>("generate_commit_message", { cwd, agent }),
  /** The merge left in progress in the checkout, with what each uncommitted file is; null when none is. */
  unfinishedMerge: (cwd: string) => invoke<UnfinishedMerge | null>("unfinished_merge", { cwd }),
  /** Commit the merge that was read; refused if the checkout moved on or a file is still conflicted. */
  commitMerge: (cwd: string, head: string, mergeHead: string) => invoke<string>("commit_merge", { cwd, head, mergeHead }),
  /** `git merge --abort` of the merge that was read, and no other. */
  abortMerge: (cwd: string, head: string, mergeHead: string) => invoke<void>("abort_merge", { cwd, head, mergeHead }),
  /** A conflicted file of the merge that was read, cut into its conflicts (PRO-293). */
  conflictFile: (cwd: string, head: string, mergeHead: string, path: string) =>
    invoke<ConflictFile>("merge_conflict_file", { cwd, head, mergeHead, path }),
  /** Replace one conflict with a side, or both, and return the file as written. Refused when the file changed since `version`. */
  resolveConflict: (cwd: string, head: string, mergeHead: string, path: string, version: string, index: number, choice: ConflictChoice) =>
    invoke<ConflictFile>("resolve_merge_conflict", { cwd, head, mergeHead, path, version, index, choice }),
  /** Stage a file with no conflict markers left (`git add`). Refused when it changed since `version` or still has markers. */
  markResolved: (cwd: string, head: string, mergeHead: string, path: string, version: string) =>
    invoke<void>("mark_conflict_resolved", { cwd, head, mergeHead, path, version }),
};

export type PrScope = { kind: "local"; cwd: string } | { kind: "cloud"; workspace: string; repo: string };
export interface PrAssociation {
  url: string;
  number: number;
  head: string;
  scope: PrScope;
  /** Chosen with "Link pull request…" (PRO-294), not opened from this session; only a link can be unlinked. */
  linked?: boolean;
}

/** An open pull request as "Link pull request…" lists it. */
export interface OpenPr extends PullRequest {
  /** `owner:branch` for a head on a fork, else the branch. */
  headLabel: string;
}

/** The repository's open pull requests, and which ones a session already shows. */
export interface PrLinkCandidates {
  /** `owner/name`. */
  repository: string;
  /** Every open pull request; `prs` holds at most the first 100. */
  total: number;
  prs: OpenPr[];
  /** Canonical URLs this session shows already. */
  here: string[];
  /** Canonical URLs another session shows. */
  elsewhere: string[];
}

/** Owner-issued privacy provenance for one Actions click, reused unchanged
 * across its IPC continuations. It holds no native lease or credentials. */
export type CheckAuthority = Readonly<{ owner: string; epoch: number | null }>;

export interface GitHubConnectionStatus {
  state: "missing" | "signed_out" | "connected" | "unavailable";
  details: string | null;
  hostname?: string;
}

export const gh = {
  checkAuthority: () => invoke<CheckAuthority>("pr_check_authority"),
  search: (cwd: string, query: string) => invoke<PullRequest[]>("pr_search", { cwd, query }),
  attach: (cwd: string, number: number) => invoke<string>("pr_attach", { cwd, number }),
  connectionStatus: (cwd?: string) => invoke<GitHubConnectionStatus>("gh_connection_status", { cwd: cwd ?? null }),
  loginStart: (id: string, hostname: string) => invoke<void>("gh_login_start", { id, hostname }),
  createRepository: (cwd: string, name: string, privateRepo: boolean) => invoke<void>("gh_create_repository", { cwd, name, private: privateRepo }),
  conversation: (url: string): PrConversationAccess => ({
    read: () => invoke("pr_conversation", { url }),
    act: (action) => invoke("pr_conversation_action", { url, action }),
    search: (query) => invoke("pr_reviewer_search", { url, query }),
  }),
  checkLog: (cwd: string, prUrl: string, checkUrl: string, failed: boolean) => invoke<CheckLog>("pr_check_log", { cwd, prUrl, checkUrl, failed }),
  rerunCheck: (cwd: string, prUrl: string, checkUrl: string, failed: boolean, authority: CheckAuthority) => invoke<void>("pr_check_rerun", { cwd, prUrl, checkUrl, failed, authority }),
  fixAttachment: (sessionId: string, tabId: string, prUrl: string, authority: CheckAuthority) => invoke<{ path: string; truncated: boolean }>("pr_check_fix_attachment", { sessionId, tabId, prUrl, authority }),
  reviewFiles: (url: string, head: string, base: string) => invoke<import("./reviewThreads").ReviewFile[]>("pr_review_files", { url, head, base }),
  reviewThreads: (url: string) => invoke<import("./reviewThreads").ReviewThreads>("pr_review_threads", { url }),
  resolveReview: (url: string, threadId: string, resolved: boolean) => invoke<void>("pr_review_resolve", { url, threadId, resolved }),
  replyReview: (url: string, threadId: string, body: string) => invoke<void>("pr_review_reply", { url, threadId, body }),
  landed: (cwd: string) => invoke<import("@/types/session").Landed>("pr_landed", { cwd }),
  available: () => invoke<boolean>("gh_available"),
  associationsBatch: (sessionIds: string[]) => invoke<Record<string, PrAssociation[]>>("pr_associations_batch", { sessionKeys: sessionIds }),
  associations: (sessionId: string, additions: PrAssociation[] = []) => invoke<PrAssociation[]>("pr_associations", { sessionKey: sessionId, additions }),
  linkCandidates: (cwd: string, sessionId: string) => invoke<PrLinkCandidates>("pr_link_candidates", { cwd, sessionKey: sessionId }),
  link: (sessionId: string, association: PrAssociation) => invoke<PrAssociation[]>("pr_link", { sessionKey: sessionId, association }),
  unlink: (sessionId: string, url: string) => invoke<PrAssociation[]>("pr_unlink", { sessionKey: sessionId, url }),
  list: (cwd: string, branch: string, authority?: CheckAuthority) => invoke<PullRequest[]>("pr_list", { cwd, branch, ...(authority ? { authority } : {}) }),
  details: (cwd: string, number: number, url?: string, authority?: CheckAuthority) => invoke<PullRequest>("pr_details", { cwd, number, ...(url ? { url } : {}), ...(authority ? { authority } : {}) }),
  create: (cwd: string, title: string, body: string, base: string | null, draft: boolean, sessionId?: string) =>
    invoke<string>("pr_create", { cwd, title, body, base, draft, ...(sessionId ? { sessionId } : {}) }),
  merge: (cwd: string, number: number, method: "merge" | "squash" | "rebase" | "queue", url?: string) => invoke<void>("pr_merge", { cwd, number, method, ...(url ? { url } : {}) }),
  /** After a merge: the head branch on GitHub, only when merged, in this repository and still at the merged head. */
  deleteBranch: (cwd: string, number: number, url?: string) => invoke<void>("pr_delete_branch", { cwd, number, ...(url ? { url } : {}) }),
  ready: (cwd: string, number: number, url?: string) => invoke<void>("pr_ready", { cwd, number, ...(url ? { url } : {}) }),
};

// ---- built-in browser pages
/** One tab of the app-managed Chromium, as the page store describes it. */
export interface BrowserPage {
  id: string;
  browserPageId: string;
  profileId: string;
  tabId: string;
  url: string;
  title: string;
  workspacePath: string | null;
  created: string;
  active: boolean;
  index: number;
}
export interface BrowserProfile {
  id: string;
  label: string;
  created: string;
}
export interface BrowserRuntimeStatus {
  binary: string | null;
  version: string | null;
  expectedVersion: string;
  browser: string | null;
  socketDir: string | null;
  ownsSocketDir: boolean;
  liveSessions: string[];
}
export interface BrowserNavigation {
  browserPageId: string;
  url?: string;
  title?: string;
}
export const browser = {
  pages: () => invoke<BrowserPage[]>("browser_pages"),
  openTab: (workspace: string, url?: string | null, profile?: string | null) =>
    invoke<{ browserPageId: string; url: string; title: string }>("browser_open_tab", { workspace, url: url ?? null, profile: profile ?? null }),
  closePage: (pageId: string) => invoke<void>("browser_close_page", { pageId }),
  activatePage: (pageId: string, focus: boolean) => invoke<void>("browser_activate_page", { pageId, focus }),
  navigate: (pageId: string, action: "goto" | "back" | "forward" | "reload", url?: string | null) =>
    invoke<BrowserNavigation>("browser_navigate", { pageId, action, url: url ?? null }),
  screencast: (pageId: string, live: boolean) => invoke<void>("browser_screencast", { pageId, live }),
  profiles: () => invoke<BrowserProfile[]>("browser_profiles"),
};

// ---- the floating chat window
/** Whether a workspace is removed by itself once its pull request has merged (`store/settings.rs`). */
export interface MergedCleanupSettings {
  /** The default for every project. */
  enabled: boolean;
  /** One project's own answer, by a local project's path or a cloud workspace's key. */
  projects: Record<string, boolean>;
  /** Delete the conversations of the sessions in the workspace too. */
  deleteConversations: boolean;
  /** Minutes between the merge being seen and the removal. */
  graceMinutes: number;
}

/** What Settings offers for `graceMinutes`; the backend accepts no others. */
export const MERGED_GRACE_MINUTES = [5, 10, 30, 60] as const;

/** GitHub's own "Automatically delete head branches" for a repository. */
export interface HeadBranchSetting {
  /** `owner/name`. */
  repository: string;
  /** Null when GitHub does not tell this reader. */
  enabled: boolean | null;
  /** The reader may change it. */
  admin: boolean;
}

export const mergedCleanup = {
  settings: () => invoke<MergedCleanupSettings>("merged_cleanup_settings"),
  /** `project.enabled: null` makes that project follow the default again. */
  setSettings: (patch: { enabled?: boolean; deleteConversations?: boolean; graceMinutes?: number; project?: { key: string; enabled: boolean | null } }) =>
    invoke<MergedCleanupSettings>("set_merged_cleanup_settings", { patch }),
  /**
   * One pass on this computer. Which projects it covers is read by the
   * backend from the settings, so with the setting off this removes nothing.
   */
  sweep: () => invoke<MergedSwept>("merged_cleanup_sweep"),
  hold: (path: string, held: boolean) => invoke<void>("merged_cleanup_hold", { path, held }),
  records: () => invoke<MergedRemovalView[]>("merged_cleanup_records"),
  restore: (id: string) => invoke<MergedRestored>("merged_cleanup_restore", { id }),
  headBranchSetting: (projectPath: string) => invoke<HeadBranchSetting>("github_head_branch_setting", { projectPath }),
  enableHeadBranchDeletion: (projectPath: string) => invoke<HeadBranchSetting>("github_enable_head_branch_deletion", { projectPath }),
};

export const floatingWindow = {
  status: () => invoke<FloatingStatus>("floating_status"),
  /** `shortcut: ""` turns the system-wide shortcut off. A binding the system cannot register is refused. */
  setSettings: (patch: { shortcut?: string; alwaysOnTop?: boolean; retentionDays?: number }) => invoke<FloatingStatus>("set_floating_settings", { patch }),
  /** Show the window (made on first use) and focus it; with a session, it opens on that one. */
  show: (sessionId?: string | null, tabId?: string | null) => invoke<void>("floating_show", { sessionId: sessionId ?? null, tabId: tabId ?? null }),
  /** Whether it is on screen now. */
  visible: () => invoke<boolean>("floating_visible"),
  /** Hide it. Nothing it shows is stopped. */
  hide: () => invoke<void>("floating_hide"),
  /** The session the window was asked to open on before its page had loaded, once. */
  takePending: () => invoke<OpenTarget | null>("floating_take_pending"),
  /** Show a session in the main window and hide the floating one. */
  openInMain: (sessionId: string, tabId?: string | null) => invoke<void>("floating_open_in_main", { sessionId, tabId: tabId ?? null }),
};

// ---- agent setup (PRO-152)
export type AgentSetupStep = "install" | "login";
export const agentSetup = {
  /**
   * Run an agent's official installer, or its own sign-in, in setup pane `id`
   * (`setup:<harness>:<run>`, a pane of no session). A pane whose step has
   * ended goes on with the next one, its output kept above. The pane's exit
   * code says how the step ended (`agentSetupFlow.ts`).
   */
  start: (id: string, harness: string, step: AgentSetupStep, cols: number, rows: number) =>
    invoke<void>("agent_setup_start", { id, harness, step, cols, rows }),
  /**
   * The agent's step that runs now, wherever it was started (another window,
   * or this one before a reload): the runtime runs one at a time per agent.
   */
  running: (harness: string) => invoke<{ pane: string; step: AgentSetupStep } | null>("agent_setup_running", { harness }),
};

// ---- terminals
export const pty = {
  localLinks: (id: string) => invoke<{ sessionId: string; cwd: string; urls: string[] } | null>("pty_local_links", { id }),
  /** `title` names a shell tab for every window that lists it. */
  spawn: (id: string, cwd: string, cols: number, rows: number, command?: string, title?: string) =>
    invoke<void>("pty_spawn", { id, cwd, cols, rows, command: command ?? null, title: title ?? null }),
  /** The shell tabs open in every session, for a window that was not there when they were opened. */
  shells: () => invoke<ShellPane[]>("pty_shells"),
  /** The agents in front of terminals right now (#437), for a window that loads after they were started. */
  agents: () => invoke<PaneAgent[]>("pane_agents"),
  rename: (id: string, title: string) => invoke<void>("pty_rename", { id, title }),
  /** Sessions with a TCP listener working in their checkout, including detached servers. */
  listeningSessions: (sessions: Pick<SessionEntry, "id" | "cwd">[]) => invoke<string[]>("listening_sessions", { sessions }),
  setDocked: (id: string, docked: boolean) => invoke<ShellPane>("pty_set_docked", { id, docked }),
  /** Which of these shell tabs are running a command now. */
  busy: (ids: string[]) => invoke<string[]>("pty_busy", { ids }),
  write: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  /**
   * Receive pane `id`'s output as raw bytes, starting with what it has
   * printed so far. One attachment per pane and window: a later one from the
   * same window replaces it, and another window's is left as it is.
   * `token` names this attachment; its acknowledgements and its detach carry
   * it, so they cannot act on an attachment that has replaced it.
   */
  attach: (id: string, token: string, onData: (bytes: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (message) => onData(new Uint8Array(message));
    return invoke<void>("pty_attach", { id, token, channel });
  },
  attachSized: (id: string, token: string, onData: (bytes: Uint8Array, size?: { cols: number; rows: number }) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (message) => {
      if (message.byteLength < 4) return;
      const header = new DataView(message);
      const cols = header.getUint16(0, true), rows = header.getUint16(2, true);
      onData(new Uint8Array(message, 4), cols > 0 && rows > 0 ? { cols, rows } : undefined);
    };
    return invoke<void>("pty_attach_sized", { id, token, channel });
  },
  /** This window has drawn `drawn` bytes of the pane's output since it attached; the backend holds a pane that gets too far ahead. */
  ack: (id: string, token: string, drawn: number) => invoke<void>("pty_ack", { id, token, drawn }),
  detach: (id: string, token: string) => invoke<void>("pty_detach", { id, token }),
  /** This page has attached nothing yet: drop what a page loaded before it in this window had attached. */
  detachAll: () => invoke<void>("pty_detach_all"),
  resize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
};

// ---- tree, text files, project search
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}
export interface TextFile {
  content: string;
  mtimeMs: number;
  size: number;
  binary: boolean;
  truncated: boolean;
}
export interface TextHit {
  path: string;
  line: number;
  /** Character column of the first match on the line. */
  col: number;
  text: string;
  /** Every match on the line as `[start, end)` character offsets into `text`. */
  matches: [number, number][];
  /** What each match becomes, in the same order, when the search carried a replacement. */
  replacements?: string[];
}
export interface TextSearch {
  hits: TextHit[];
  files: number;
  capped: boolean;
}
/** A file to rewrite, and the 1-based lines to touch in it (every line when absent). */
export interface ReplaceTarget {
  path: string;
  lines?: number[];
}
export interface ReplaceReport {
  files: number;
  replacements: number;
}
export interface MediaFile {
  token: string;
  url: string;
  mtimeMs: number;
}

export interface LocalPathInfo {
  path: string;
  root: string;
  rel: string;
  kind: "file" | "directory";
  /** A conservative content sniff; known media extensions are classified separately. */
  text: boolean;
}

export const fs = {
  openMedia: (root: string, rel: string) => invoke<MediaFile>("open_media_file", { root, rel }),
  closeMedia: (token: string) => invoke<void>("close_media_file", { token }),
  listDir: (root: string, rel: string) => invoke<DirEntry[]>("list_dir", { root, rel }),
  readText: (path: string) => invoke<TextFile>("read_text_file", { path }),
  writeText: (path: string, content: string) => invoke<number>("write_text_file", { path, content }),
  /** Exclusive create: rejects when the path already exists, leaving that file as it is. */
  createText: (path: string, content: string) => invoke<number>("create_text_file", { path, content }),
  /** A file's whole text, past the 4 MB the editor shows (the file tab's Copy file contents). */
  readWholeText: (path: string) => invoke<string>("read_whole_text_file", { path }),
  /** Save a copy at `to`: the exact bytes of the local file `from`, or `content`. */
  exportFile: (to: string, source: { from: string } | { content: string }) =>
    invoke<number>("export_file", { to, from: "from" in source ? source.from : null, content: "content" in source ? source.content : null }),
  mtime: (path: string) => invoke<number | null>("file_mtime", { path }),
  inspectPath: (base: string, path: string) => invoke<LocalPathInfo>("inspect_local_path", { base, path }),
  /** Native default-app opening, restricted to existing local files/folders. */
  openPath: (path: string) => invoke<void>("open_local_path", { path }),
  /** `wholeWord` skips matches inside a longer word, as the editor's find does. */
  searchText: (root: string, query: string, regex: boolean, caseSensitive: boolean, limit = 500, replacement?: string, wholeWord = false) =>
    invoke<TextSearch>("search_text", { root, query, regex, caseSensitive, wholeWord, limit, replacement: replacement ?? null }),
  /**
   * Rewrite matches on disk. Without `targets` every searchable file under
   * the root is a candidate except those in `skip`.
   */
  replaceText: (root: string, query: string, replacement: string, regex: boolean, caseSensitive: boolean, targets: ReplaceTarget[] | null, skip: string[] = [], wholeWord = false) =>
    invoke<ReplaceReport>("replace_text", { root, query, replacement, regex, caseSensitive, wholeWord, targets, skip }),
};

// ---- issues (GitHub through gh, Linear through its API)
export interface IssueLabel {
  /** What `issueOps.setLabels` takes: the id on Linear, the name on GitHub. Lists leave it out. */
  id?: string | null;
  name: string;
  color: string;
}
export interface IssueAssignee {
  name: string;
  avatarUrl?: string | null;
}
export interface IssueTeam {
  id: string;
  key: string;
  name: string;
}
export interface Issue {
  provider: "github" | "linear";
  id: string;
  nodeId?: string | null;
  identifier: string;
  number: number;
  title: string;
  url: string;
  state: string;
  stateType: "open" | "started" | "completed" | "canceled";
  /** Linear's own type for the workflow state (`triage`, `backlog`, `unstarted`, …), which `stateType` folds together. */
  workflowStateType?: string | null;
  labels: IssueLabel[];
  /** The first of `assignees`. */
  assignee?: IssueAssignee | null;
  /** Every assignee. Rows a pipeline remembers leave it out. */
  assignees?: IssueUser[];
  updatedAt: string;
  body?: string | null;
  team?: IssueTeam | null;
}
/** Who has the issue: the reader, nobody, or someone as assignees are named (the GitHub login, the Linear user id). */
export type AssigneeFilter = { kind: "me" } | { kind: "unassigned" } | { kind: "person"; id: string };
export interface IssueFilter {
  /** The older spelling of `assignee: {kind: "me"}`. */
  assignedToMe?: boolean;
  teamId?: string | null;
  search?: string | null;
  /** `open` (the default), `all`; `closed` on GitHub; a workflow state type on Linear. */
  state?: string | null;
  assignee?: AssigneeFilter | null;
  /** Names. GitHub: issues with all of them; Linear: with any of them. */
  labels?: string[];
  /** `updated` (the default), `created` (newest), `created_asc` (oldest), `priority` (Linear). */
  sort?: string | null;
}
export interface LinearStatus {
  connected: boolean;
  viewer?: string | null;
}
export const issues = {
  list: (projectPath: string, provider: string, filter: IssueFilter) => invoke<Issue[]>("issues_list", { projectPath, provider, filter }),
  details: (projectPath: string, provider: string, id: string) => invoke<Issue>("issue_details", { projectPath, provider, id }),
  linearStatus: () => invoke<LinearStatus>("linear_status"),
  linearSetApiKey: (key: string) => invoke<LinearStatus>("linear_set_api_key", { key }),
  linearTeams: () => invoke<IssueTeam[]>("linear_teams"),
  githubRepo: (projectPath: string) => invoke<string | null>("github_repo", { projectPath }),
  /** The GitHub account a project is connected to: the one its pushes land as, else the CLI's. */
  githubIdentity: (projectPath: string, refresh = false) => invoke<GithubIdentity>("github_identity", { projectPath, refresh }),
};

/** One claim as the account service shows it to this reader (#441). `device` and `sessionId` come only with the reader's own. */
export interface WorkClaim {
  /** Opaque: one person's one session, the same from each of their machines. Absent from an older server. */
  key?: string | null;
  scope: string;
  issue: { provider: "github" | "linear"; id: string; identifier: string };
  person: { name: string; you: boolean };
  device?: { id: string; label: string } | null;
  sessionId?: string | null;
  title: string;
  branch?: string | null;
  /** `working`, `waiting`, `idle` or `pull_request`; anything newer reads as idle. */
  state: string;
  cloud: boolean;
  /** Its machine refreshed it within `liveForSeconds`. */
  live: boolean;
  /** Epoch milliseconds on the server's clock. */
  since: number;
  lastActiveAt: number;
  refreshedAt: number;
}

export interface WorkClaimsAnswer {
  /** False when only this machine's sessions can be shown. */
  available: boolean;
  reason?: "signed_out" | "unsupported" | "offline" | "unavailable" | null;
  /** The server's clock, epoch milliseconds. */
  now: number;
  liveForSeconds: number;
  /** Every claim but this machine's own local ones. */
  claims: WorkClaim[];
}

/** A cloud session the window knows about, handed over for its work status. */
export interface WorkCloudSession {
  orgId: string;
  workspaceId: string;
  sessionId: string;
  createdBy: string | null;
  /** The workspace's primary repository, `owner/name`. */
  repository: string | null;
  title: string;
  branch: string | null;
  worktreeName: string | null;
  status: TabStatus;
  archived: boolean;
  modified: string;
}

/** When an agent nobody is using is stopped (#696). */
export interface AgentSettings {
  readOnlyCommands: boolean;
  /** Minutes an agent may sit idle before it is stopped; 0 is never. */
  idleStopMinutes: number;
}

/** The idle limits Settings → Agents offers, as the Rust side accepts them; 0 is never. */
export const IDLE_STOP_MINUTES = [0, 30, 60, 120, 240, 480, 1440] as const;

export const agentSettings = {
  get: () => invoke<AgentSettings>("agent_settings"),
  setReadOnlyCommands: (enabled: boolean) => invoke<AgentSettings>("set_read_only_commands", { enabled }),
  setIdleStopMinutes: (minutes: number) => invoke<AgentSettings>("set_agent_idle_stop_minutes", { minutes }),
};

/** The program an agent runs as (PRO-157): the one chosen in Settings, else the PATH's. */
export interface AgentExecutable {
  harness: string;
  /** The path the person chose; null uses the PATH. */
  chosen: string | null;
  /** What a new tab runs. */
  path: string | null;
  /** What the PATH has, whatever was chosen. */
  system: string | null;
  /** `--version` of `path`, when it answered. */
  version: string | null;
  /** Why the chosen program cannot be used now. */
  problem: string | null;
}

export const agentExecutables = {
  get: (harness: string) => invoke<AgentExecutable>("agent_executable", { harness }),
  /** Checked with `--version` first: a program that fails is refused, with why, and the old choice stays. */
  set: (harness: string, path: string) => invoke<AgentExecutable>("set_agent_executable", { harness, path }),
  /** Back to the one TerminalX finds on the PATH. */
  reset: (harness: string) => invoke<AgentExecutable>("set_agent_executable", { harness, path: null }),
  reveal: (harness: string) => invoke<void>("reveal_agent_path", { harness, what: "executable" }),
};

/** An agent's own settings file: ~/.claude/settings.json, ~/.codex/config.toml, OpenCode's opencode.json. */
export interface AgentConfigFile {
  path: string;
  displayPath: string;
  exists: boolean;
}

export const agentConfigFiles = {
  get: (harness: string) => invoke<AgentConfigFile>("agent_config_file", { harness }),
  /** In its default app, or one of the Open in editors; an empty file is made first when there is none. */
  open: (harness: string, editor: "cursor" | "vscode" | "zed" | null = null) => invoke<void>("open_agent_config_file", { harness, editor }),
  reveal: (harness: string) => invoke<void>("reveal_agent_path", { harness, what: "config" }),
};

/** A provider of OpenCode's catalogue (models.dev), plus Ollama on this Mac. */
export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  env: string[];
  api: string | null;
  doc: string | null;
  modelCount: number;
  local: boolean;
  /** The address set for it in OpenCode's config, kept while it is disconnected. */
  baseUrl: string | null;
}

/** A provider OpenCode can use now. */
export interface OpenCodeConnected {
  id: string;
  name: string;
  /** "api": a key in OpenCode's auth.json; "oauth"/"wellknown": a sign-in OpenCode made; "config": in its config file. */
  auth: "api" | "oauth" | "wellknown" | "config";
  maskedKey: string | null;
  baseUrl: string | null;
  /** The models the picker offers from it. */
  models: string[];
  /** No list in the config file yet: OpenCode offers every model, the picker none. */
  unlisted: boolean;
  catalogModels: number;
}

export interface OpenCodePickerModel {
  /** `provider/model`, as a tab stores it. */
  id: string;
  provider: string;
  providerName: string;
  model: string;
  name: string;
}

export interface OpenCodeOverview {
  configPath: string;
  configExists: boolean;
  /** Why TerminalX won't rewrite the config file now (comments, broken JSON). */
  configProblem: string | null;
  authPath: string;
  logDir: string;
  connected: OpenCodeConnected[];
  models: OpenCodePickerModel[];
  catalog: OpenCodeCatalogProvider[];
  catalogProblem: string | null;
  /** Why TerminalX won't change OpenCode's key file now (it can't be read). */
  authProblem: string | null;
}

export type OpenCodeKeyCheck = { result: "accepted" } | { result: "notChecked"; reason: string };

export const opencode = {
  overview: (fetch = true) => invoke<OpenCodeOverview>("opencode_overview", { fetch }),
  catalogModels: (provider: string) => invoke<{ id: string; name: string }[]>("opencode_catalog_models", { provider }),
  /** Checked with the provider first; a refused key is an error and nothing is saved. `baseUrl` "" clears one, undefined leaves it. */
  connect: (provider: string, key: string, baseUrl?: string) =>
    invoke<{ overview: OpenCodeOverview; check: OpenCodeKeyCheck }>("opencode_connect", { provider, key, baseUrl: baseUrl ?? null }),
  disconnect: (provider: string) => invoke<OpenCodeOverview>("opencode_disconnect", { provider }),
  addModel: (provider: string, model: string) => invoke<OpenCodeOverview>("opencode_add_model", { provider, model }),
  removeModel: (provider: string, model: string) => invoke<OpenCodeOverview>("opencode_remove_model", { provider, model }),
  openLogs: () => invoke<void>("opencode_open_logs"),
};

/** When a finished conversation is archived (#718). */
export interface ConversationSettings {
  /** Days a conversation may go without a message before it is archived; 0 is never. */
  archiveIdleDays: number;
}

/** The idle limits Settings offers for archiving, as the Rust side accepts them; 0 is never. */
export const ARCHIVE_IDLE_DAYS = [0, 1, 3, 7, 14, 30] as const;

export const conversationSettings = {
  get: () => invoke<ConversationSettings>("conversation_settings"),
  setArchiveIdleDays: (days: number) => invoke<ConversationSettings>("set_archive_idle_days", { days }),
};

export interface WorkStatusSettings {
  /** Teammates in an organization that connected the repository see what this person works on. */
  shareWithTeam: boolean;
}

/** Settings → Experimental: features that are on only when turned on. */
export interface ExperimentalSettings {
  /** New Codex sessions connect to Codex's app server instead of its terminal, where it can serve them (#644). */
  nativeCodex: boolean;
  /** The session header shows the session's estimated cost and its tokens by model (PRO-273). */
  sessionCost?: boolean;
  /** Show orchestration runs: a session's Run view and Settings → Orchestrator (PRO-274). */
  orchestratorRuns?: boolean;
  /** Show Local VM tasks and chosen computers: Settings → Local VMs, a tab's computer choice, its task cards (PRO-114). */
  localVmTasks?: boolean;
  /** Offer OpenCode: Settings → Agents with its providers and models, the agent pickers and the model picker (PRO-157). */
  opencode?: boolean;
  /** Bots, AI employees with standing roles (PRO-459). Off, the app shows nothing of them and `terminalx bots` says so. */
  bots?: boolean;
}

/** Read when a tab is made: a change applies to new sessions, not to existing ones. */
export const experimental = {
  settings: () => invoke<ExperimentalSettings>("experimental_settings"),
  setNativeCodex: (nativeCodex: boolean) => invoke<ExperimentalSettings>("set_experimental_settings", { nativeCodex }),
  setSessionCost: (sessionCost: boolean) => invoke<ExperimentalSettings>("set_experimental_settings", { sessionCost }),
  setOrchestratorRuns: (orchestratorRuns: boolean) => invoke<ExperimentalSettings>("set_experimental_settings", { orchestratorRuns }),
  setLocalVmTasks: (localVmTasks: boolean) => invoke<ExperimentalSettings>("set_experimental_settings", { localVmTasks }),
  setOpenCode: (opencode: boolean) => invoke<ExperimentalSettings>("set_experimental_settings", { opencode }),
  setBots: (bots: boolean) => invoke<ExperimentalSettings>("set_experimental_settings", { bots }),
  /** Whether a new `agent` tab in a cloud workspace should ask its runtime for native Codex: never when the setting cannot be read. */
  nativeCodexFor: async (agent: string): Promise<boolean> => {
    if (agent !== "codex") return false;
    try {
      return (await invoke<ExperimentalSettings>("experimental_settings"))?.nativeCodex === true;
    } catch {
      return false;
    }
  },
};

/** Orchestration runs (PRO-274). Approve, stop and edit are the person's: no `terminalx` command approves a run. */
export const orchestration = {
  /** The run a session leads, as it is now, or `null`. */
  runForSession: (sessionId: string) => invoke<Run | null>("orchestration_run_for_session", { sessionId }),
  runs: () => invoke<Run[]>("orchestration_runs"),
  /** Store a plan a person chose from a file as a run of `sessionId`; refused as `runs create` refuses. */
  create: (sessionId: string, plan: unknown) => invoke<Run>("orchestration_create", { sessionId, plan }),
  /** What holds for runs in one project: its own answers, the app's where it gave none. */
  limits: (projectPath: string) => invoke<OrchestratorLimits>("orchestrator_limits", { projectPath }),
  /** The model each tier of the routing table runs on today, per agent. */
  tierModels: (refresh = false) => invoke<TierModels>("orchestrator_tier_models", { refresh }),
  approve: (id: string) => invoke<RunStart>("orchestration_approve", { id }),
  /** Start a `planned` run, of a project that asks for no approval, as the person (PRO-365); the lead is told. */
  start: (id: string) => invoke<RunStart>("orchestration_start", { id }),
  /** Stop a run, or discard a plan nobody approved. */
  stop: (id: string) => invoke<RunStop>("orchestration_stop", { id }),
  updatePlan: (id: string, plan: RunPlan) => invoke<Run>("orchestration_update_plan", { id, plan }),
  /** Merge every accepted piece into the lead's branch, in dependency order; `skip` leaves pieces out of this pass.
   * Answers once the pass has begun: the run's events say how it goes. */
  merge: (id: string, options: { skip?: string[]; recheck?: boolean } = {}) => invoke<Run>("orchestration_merge", { id, skip: options.skip ?? [], recheck: options.recheck ?? false }),
  /** Give a piece whose accepted result could not be merged back to its worker, with the conflict as its brief. */
  sendBack: (id: string, piece: string) => invoke<Run>("orchestration_send_back", { id, piece }),
  /** Have the lead resolve a piece's conflict: it is sent both sides and the pieces' goals. */
  resolveInLead: (id: string, piece: string) => invoke<Run>("orchestration_resolve_in_lead", { id, piece }),
  /** A blocked piece (PRO-361, 18.03): the lead takes it over and finishes it in its own checkout. */
  takeOver: (id: string, piece: string) => invoke<Run>("orchestration_take_over", { id, piece }),
  /** Check what the lead committed for a piece it took over; done once its checks pass there. */
  finish: (id: string, piece: string, accept: string[] = []) => invoke<Run>("orchestration_finish", { id, piece, accept }),
  /** The files outside a held piece's own that its Check and finish would add to it: shown and confirmed first. */
  finishWidens: (id: string, piece: string) => invoke<string[]>("orchestration_finish_widens", { id, piece }),
  /** Give a blocked piece more files (its report's outside files when `own` is empty) and a fresh worker. */
  widen: (id: string, piece: string, own: string[] = []) => invoke<Run>("orchestration_widen", { id, piece, own }),
  /** Send a blocked piece's worker a note: its try opens again. */
  note: (id: string, piece: string, text: string) => invoke<Run>("orchestration_note", { id, piece, text }),
  /** Leave a blocked piece out, with the pieces that depend on it and have not started. */
  skip: (id: string, piece: string) => invoke<Run>("orchestration_skip", { id, piece }),
  /** One run's worker limit and budget, set by the person (PRO-280). */
  setLimits: (id: string, limits: RunLimits) => invoke<Run>("orchestration_set_limits", { id, limits }),
  /** Let a run that reached its budget go on: now, or once the window that stopped it resets. */
  resume: (id: string, afterReset: boolean) => invoke<RunStart>("orchestration_resume", { id, afterReset }),
  settings: () => invoke<OrchestratorSettings>("orchestrator_settings"),
  setSettings: (patch: OrchestratorPatch) => invoke<OrchestratorSettings>("set_orchestrator_settings", { patch }),
};

/** Settings → Storage: what is kept about the warnings tabs raise (#815). */
export interface DiagnosticsSettings {
  /** Record when a tab's warning was raised, shown, acted on and cleared: labels, counts and times only. */
  recoveryIncidents: boolean;
}

/**
 * The runtime's log of recovery incidents (#815, `recovery_log.rs`). A
 * window reports what it showed and what was pressed; every field is a label
 * or a number, refused otherwise at the boundary. Reports are best effort.
 */
export const recoveryIncidents = {
  report: (sessionId: string, tabId: string, report: import("@/lib/recoveryReports").UiReport) => invoke<void>("report_recovery_ui", { sessionId, tabId, report }),
  settings: () => invoke<DiagnosticsSettings>("diagnostics_settings"),
  setEnabled: (enabled: boolean) => invoke<DiagnosticsSettings>("set_recovery_incidents", { enabled }),
  summary: () => invoke<RecoveryIncidentSummary>("recovery_incidents_summary"),
  export: (path: string) => invoke<void>("recovery_incidents_export", { path }),
  clear: () => invoke<void>("clear_recovery_incidents"),
};

/** What `recovery_log::summarize` says, as far as the settings row reads it. */
export interface RecoveryIncidentSummary {
  lines: number;
  lines_lost: number;
  incidents: number;
  busy_refusals_while_turn_open: number;
  suspected_false_positives: { incident: string; reason: string; why: string }[];
  groups: { reason: string; runtime: string; transport: string; incidents: number; occurrences: number }[];
}

export interface OrganizationWorkStatus {
  shareWorkStatus: boolean;
  canManage: boolean;
  personal: boolean;
  /** The Linear workspaces (`linear.app/<key>`) whose issues members see each other's work on. */
  linearWorkspaces: string[];
}

/** A change to an organization's work status settings; what is left out stays. */
export interface OrganizationWorkStatusPatch {
  shareWorkStatus?: boolean;
  linearWorkspaces?: string[];
}

/** Who is working on an issue, across machines and teammates (#441). */
export const workStatus = {
  claims: (projectPath: string, provider: string, issueUrls: string[]) => invoke<WorkClaimsAnswer>("work_claims_list", { projectPath, provider, issueUrls }),
  setCloud: (sessions: WorkCloudSession[]) => invoke<void>("work_claims_set_cloud", { sessions }),
  settings: () => invoke<WorkStatusSettings>("work_status_settings"),
  setShareWithTeam: (shareWithTeam: boolean) => invoke<WorkStatusSettings>("set_work_status_settings", { shareWithTeam }),
  organization: (orgId: string) => invoke<OrganizationWorkStatus>("organization_work_status", { orgId }),
  setOrganization: (orgId: string, patch: OrganizationWorkStatusPatch) => invoke<OrganizationWorkStatus>("set_organization_work_status", { orgId, patch }),
  linkIssue: (sessionId: string, issue: IssueRef) => invoke<SessionEntry>("session_link_issue", { sessionId, issue }),
  unlinkIssue: (sessionId: string) => invoke<SessionEntry>("session_unlink_issue", { sessionId }),
  setPrivate: (sessionId: string, isPrivate: boolean) => invoke<SessionEntry>("session_set_work_private", { sessionId, private: isPrivate }),
};

export interface ProjectOverview {
  defaultBranch: string | null;
  /** Commits on the default branch in the last 30 days. */
  recentCommits: number;
  branches: { name: string; committedAt: string; author: string; subject: string; ahead: number; behind: number }[];
  /** Busiest first; `days` is commits a day over the last 14, today last. */
  contributors: { name: string; email: string; login: string | null; commits: number; days: number[] }[];
  latest: { sha: string; author: string; email: string; at: string; subject: string }[];
  pullRequests: { open: number; merged: number; recent: { number: number; title: string; url: string; state: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean; author: string; at: string }[] } | null;
  pullRequestNote: string | null;
}

export interface GithubIdentity {
  login: string | null;
  /** `ssh`: the folder's key, so pushes land as this account; `gh`: the CLI's active account. */
  source: "ssh" | "gh" | null;
  email: string | null;
  repo: string | null;
  /** Where the origin remote is hosted; `null` for a project with no remote, on this computer only. */
  remoteHost?: "github" | "gitlab" | "other" | null;
}
/** Sessions started from an issue, carried on to a pull request, a review and a merge. */
export const issuePipelines = {
  list: () => invoke<IssuePipeline[]>("issue_pipelines_list"),
  /** Rejects, with the reason, for a session the pipeline cannot serve (one on the default branch, a project that turned it off). */
  start: (sessionId: string, tabId: string, autoMerge: boolean | null) => invoke<StartedIssuePipeline>("issue_pipeline_start", { sessionId, tabId, autoMerge }),
  continue: (sessionId: string, tabId: string, options: { autoMerge: boolean; resolveConflicts: boolean }) => invoke<StartedIssuePipeline | null>("issue_pipeline_continue", { sessionId, tabId, options }),
  setResolveConflicts: (id: string, value: boolean) => invoke<IssuePipeline>("issue_pipeline_set_resolve_conflicts", { id, value }),
  setAutoMerge: (id: string, value: boolean) => invoke<IssuePipeline>("issue_pipeline_set_auto_merge", { id, value }),
  act: (id: string, action: PipelineAction) => invoke<IssuePipeline>("issue_pipeline_act", { id, action }),
  /** Merge a cloud workspace's pull request with the reader's own `gh`, pinned to the reviewed commit; `repository` is the cloud project's own. */
  mergeCloud: (pipeline: IssuePipeline, repository: string, settings: IssuePipelineSettings) => invoke<CloudMerge>("issue_pipeline_merge_cloud", { pipeline, repository, settings }),
  /** Move a cloud workspace's Linear issue to review with the reader's own Linear key; what it did, for the record. */
  linearToReview: (id: string, identifier: string) => invoke<string>("issue_pipeline_linear_to_review", { id, identifier }),
};

// ---- transcription models and dictation input
export interface TranscriptionModel {
  id: string;
  name: string;
  description: string;
  repo: string;
  filename: string;
  sizeBytes: number;
  languages: string;
  license: string;
  licenseUrl: string;
  speed: number;
  accuracy: number;
  recommended: boolean;
  /** These weights give words while the reader speaks. */
  liveWords: boolean;
  installed: boolean;
  downloading: boolean;
  progress?: DownloadProgress;
  page: string;
}
export interface TranscriptionDetector extends TranscriptionModel {
  readiness: "missing" | "invalid" | "verifiedFile" | "error";
}
export interface DownloadProgress {
  id: string;
  received: number;
  total: number;
  done: boolean;
  error?: string;
}
export interface InputDevice {
  id: string;
  name: string;
  isDefault: boolean;
}
export interface TranscriptionPreferences {
  model: string;
  inputDevice: string | null;
  muteWhileRecording: boolean;
}
export const transcription = {
  models: () => invoke<TranscriptionModel[]>("transcription_models"),
  download: (id: string) => invoke<void>("transcription_download", { id }),
  cancelDownload: (id: string) => invoke<void>("transcription_cancel_download", { id }),
  remove: (id: string) => invoke<void>("transcription_delete", { id }),
  setModel: (id: string) => invoke<void>("transcription_set_model", { id }),
  preferences: () => invoke<TranscriptionPreferences>("transcription_preferences"),
  inputs: () => invoke<InputDevice[]>("transcription_inputs"),
  setInput: (device: string | null) => invoke<void>("transcription_set_input", { device }),
  setMute: (mute: boolean) => invoke<void>("transcription_set_mute", { mute }),
};

export interface CloudProviderResource {
  id: string;
  name: string;
  state: string;
  releaseDisposition: string | null;
  activeHourlyMicros: number | null;
  suspendedMonthlyMicros: number | null;
  currency: string;
  operationState: string | null;
  cleanupRequired: boolean;
  kind: "workspace" | "runtime" | "build" | "legacy-operation";
}

/**
 * Where a workspace's operations run. Local workspaces keep using the Tauri
 * commands above unchanged; a cloud workspace is reached through its remote
 * runtime over the relay (`terminalx-workspace-rpc/1`), and a paired machine
 * through its own connection (direct first, relay fallback), never by
 * forwarding desktop IPC.
 */
export type WorkspaceTarget = { kind: "local" } | CloudWorkspaceTarget | MachineWorkspaceTarget;

export interface CloudWorkspaceTarget {
  kind: "cloud";
  organizationId: string;
  workspaceId: string;
  /** The generation last seen, if any; the attach ticket decides which runtime is current. */
  runtimeGeneration?: number;
}

/**
 * A machine paired by code (docs/MACHINES.md decision 1). One connection per
 * machine: `projectId` names a project there (PRO-346) but shares the
 * machine's connection, so it is not part of the key.
 */
export interface MachineWorkspaceTarget {
  kind: "machine";
  machineId: string;
  projectId?: string;
}

export const LOCAL_WORKSPACE: WorkspaceTarget = { kind: "local" };

export function workspaceTargetKey(target: WorkspaceTarget): string {
  switch (target.kind) {
    case "local":
      return "local";
    case "machine":
      return `machine:${target.machineId}`;
    default:
      return `cloud:${target.organizationId}:${target.workspaceId}`;
  }
}

type RemoteEvent =
  | { kind: "state"; connectionId: string; state: WorkspaceConnectionState }
  | { kind: "message"; connectionId: string; message: unknown }
  | { kind: "identityChanged"; connectionIds: string[] };

/** One supervised native connection, as the portable client's transport. */
class NativeWorkspaceTransport implements WorkspaceTransport {
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly states = new Set<(state: WorkspaceConnectionState) => void>();
  private unlisten: (() => void) | null = null;
  private closed = false;
  private connectionId: string | null = null;
  /** Events that arrive before the attach call returns our id. */
  private early: RemoteEvent[] = [];
  private current: WorkspaceConnectionState["state"] = "idle";

  constructor(private readonly machine = false) {}

  /** Listen first, so nothing the native side emits right after attaching is missed. */
  async listen(): Promise<void> {
    const unlisten = await listen<RemoteEvent>("cloud_remote_event", ({ payload }) => this.route(payload));
    if (this.closed) unlisten();
    else this.unlisten = unlisten;
  }

  get id(): string | null {
    return this.connectionId;
  }

  bind(connectionId: string): void {
    this.connectionId = connectionId;
    const early = this.early;
    this.early = [];
    for (const event of early) this.route(event);
  }

  send(frame: { id: string; method: string; params?: unknown }): boolean {
    // Refuse at once while not connected, so the caller resends after the
    // next connect instead of waiting out a timeout.
    if (this.closed || !this.connectionId || this.current !== "connected") return false;
    void api.cloudRemoteSend(this.connectionId, frame).catch(() => undefined);
    return true;
  }

  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }

  activate(activation: Activation): Promise<void> {
    // A machine has no compute to wake: its owner reconnects on its own.
    if (this.machine) return Promise.resolve();
    return this.connectionId ? api.cloudRemoteActivate(this.connectionId, activation) : Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten?.();
    if (this.connectionId) void api.cloudRemoteDetach(this.connectionId).catch(() => undefined);
  }

  private route(payload: RemoteEvent): void {
    if (payload.kind === "identityChanged") {
      if (this.connectionId && payload.connectionIds.includes(this.connectionId)) this.emitState({ state: "stopped" });
      return;
    }
    if (!this.connectionId) {
      if (this.early.length < 256) this.early.push(payload);
      return;
    }
    if (payload.connectionId !== this.connectionId) return;
    if (payload.kind === "state") this.emitState(payload.state);
    else for (const listener of this.messages) listener(payload.message);
  }

  private emitState(state: WorkspaceConnectionState): void {
    this.current = state.state;
    for (const listener of this.states) listener(state);
  }
}

export interface CloudWorkspaceConnection {
  target: WorkspaceTarget;
  client: WorkspaceRpcClient;
  /** The native connection's id, for calls that act on it (port forwards); null until attached. */
  connectionId?: () => string | null;
  /** Raise the activation; only `wake` (an interactive action) resumes suspended compute. */
  activate(activation: Activation): Promise<void>;
  close(): void;
}

const connections = new Map<string, Promise<CloudWorkspaceConnection>>();

/**
 * The transport for a workspace target: null for a local workspace (use the
 * Tauri commands), a supervised remote connection for a cloud workspace or a
 * paired machine. One connection per target (per machine, whatever its
 * project), even for concurrent callers; `connect` never wakes suspended compute.
 */
export async function workspaceConnection(target: WorkspaceTarget, activation: Activation = "connect"): Promise<CloudWorkspaceConnection | null> {
  if (target.kind === "local") return null;
  const key = workspaceTargetKey(target);
  const existing = connections.get(key);
  if (existing) {
    const connection = await existing;
    if (activation === "wake") await connection.activate("wake");
    return connection;
  }
  // A machine's connection is the machine's, whatever project asked for it;
  // it has no compute to wake, so `activation` means nothing to it.
  const pending =
    target.kind === "machine"
      ? adopt(key, { kind: "machine", machineId: target.machineId }, (transport) => api.machineRemoteAttach(target.machineId).then((id) => (transport.bind(id), id)), true)
      : adopt(key, target, (transport) => api.cloudRemoteAttach(target, activation).then((id) => (transport.bind(id), id)));
  connections.set(key, pending);
  pending.catch(() => {
    if (connections.get(key) === pending) connections.delete(key);
  });
  return pending;
}

async function adopt(
  key: string,
  target: WorkspaceTarget,
  attach: (transport: NativeWorkspaceTransport) => Promise<string>,
  machine = false,
): Promise<CloudWorkspaceConnection> {
  const transport = new NativeWorkspaceTransport(machine);
  await transport.listen();
  const client = new WorkspaceRpcClient(transport);
  try {
    await attach(transport);
  } catch (error) {
    client.close();
    throw error;
  }
  let self: Promise<CloudWorkspaceConnection> | undefined;
  const connection: CloudWorkspaceConnection = {
    target,
    client,
    connectionId: () => transport.id,
    activate: (next) => transport.activate(next),
    close: () => {
      if (connections.get(key) === self) connections.delete(key);
      client.close();
    },
  };
  self = connections.get(key);
  client.onState((state) => {
    // Stopped for an identity change: drop it so nothing reuses the old one.
    // A machine's stop is "access removed": its owner keeps the state and
    // "Try again" (`machines_reconnect`) resumes the same connection.
    if (state.state === "stopped" && !machine) connection.close();
  });
  return connection;
}

/** Whether something already holds a connection to this target. */
export function hasWorkspaceConnection(target: WorkspaceTarget): boolean {
  return connections.has(workspaceTargetKey(target));
}

/** Drop one workspace's connection, if any: it was deleted or archived. */
export function closeWorkspaceConnection(target: WorkspaceTarget): void {
  const key = workspaceTargetKey(target);
  const pending = connections.get(key);
  if (!pending) return;
  connections.delete(key);
  void pending.then((connection) => connection.close()).catch(() => undefined);
}

/**
 * Drop every cloud connection and what it cached, e.g. on sign-out or an
 * organization switch. A machine's connection stays: it belongs to the
 * pairing, not the account (the native side stops using the relay itself).
 */
export function closeWorkspaceConnections(): void {
  for (const [key, pending] of [...connections]) {
    if (key.startsWith("machine:")) continue;
    connections.delete(key);
    void pending.then((connection) => connection.close()).catch(() => undefined);
  }
}

/** Drop one Organization's cloud connections only: the user left it (CS-18). */
export function closeWorkspaceConnectionsIn(orgId: string): void {
  const prefix = `cloud:${orgId}:`;
  for (const [key, pending] of [...connections]) {
    if (!key.startsWith(prefix)) continue;
    connections.delete(key);
    void pending.then((connection) => connection.close()).catch(() => undefined);
  }
}

export interface TurnCheckpoint { number: number; reviewed: boolean; undone: boolean; files: ChangedFile[]; restored?: boolean; backupRef?: string | null; unavailableReason?: string | null }
export interface TurnUndoResult { overlap: string[]; token: string; undone: boolean; backupRef?: string | null }

/** A saved action's run in a terminal tab of a local session (PRO-363). */
export interface ActionRun {
  sessionId: string;
  actionId: string;
  name: string;
  /** The terminal tab's pane id: focus it to show the run. */
  paneId: string;
  state: "running" | "exited";
  /** The program's own exit code once it exited; null while it runs, when a signal ended it, or when its exit was not heard. */
  exitCode: number | null;
  started: string;
  ended: string | null;
}

export interface ActionRunOutcome {
  run: ActionRun;
  /** False when a non-concurrent action was already running: `run` is that tab and nothing new started. */
  started: boolean;
}

/** Saved project actions (PRO-363). Local sessions only. */
export const actions = {
  /** Start `actionId` in a new terminal tab of `sessionId`; `restart` replaces a running non-concurrent run. */
  run: (sessionId: string, actionId: string, restart = false) =>
    invoke<ActionRunOutcome>("action_run", { sessionId, actionId, restart }),
  /** The session's runs, oldest first: one per action tab still open, running or exited. */
  states: (sessionId: string) => invoke<ActionRun[]>("action_states", { sessionId }),
};
