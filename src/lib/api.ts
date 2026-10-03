import { Channel, invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  WorkspaceRpcClient,
  type Activation,
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
  TabEntry,
  WorkStatus,
  WorktreeDisposition,
  DeleteSessionReport,
  SettleReport,
  WorkspaceDeleteReport,
} from "@/types/session";
import type { DiscoveredSkill, SkillDetail } from "@/types/skills";
import type { Automation, AutomationInput, AutomationIssueState, AutomationRun, AutomationRef } from "@/types/automations";
import type { PairingConnectionMode, PairingStatus } from "@/types/pairing";
import type { CloudDiagnostics, ConnectionClose } from "@/lib/cloudDiagnostics";
import { noteCallFailure } from "@/lib/accountRoles";
import { assertLocal } from "@/types/target";

/**
 * Arguments that name a place on this computer, or a local session. A cloud
 * key or root (`cloud:`…) in one of them is a bug: it would run a local
 * command against a path that only exists on a VM (PRO-23 rule 3).
 */
const LOCAL_PATH_ARGS = ["cwd", "path", "root", "projectPath", "sessionId", "from", "to", "dir", "file"] as const;

/** Every Tauri call made here goes through this: local paths pass unchanged, cloud ones throw. */
function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (args && typeof args === "object" && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array)) {
    const record = args as Record<string, unknown>;
    try {
      for (const key of LOCAL_PATH_ARGS) {
        const value = record[key];
        if (typeof value === "string") assertLocal(value, `${command}.${key}`);
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

export interface NewTab {
  harness: string;
  model?: string;
  effort?: string | null;
  permissionMode?: string | null;
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
}

export interface StatsUsageState {
  scope: string;
  generation: number;
  snapshot: StatsUsageSnapshot | null;
  activity?: AppStats | null;
  refreshing: boolean;
  error: string | null;
}

export interface NewSession {
  projectPath: string;
  /** Run in this existing workspace instead of creating a worktree. */
  cwd?: string | null;
  title?: string | null;
  useWorktree: boolean;
  baseRef?: string | null;
  /** A requested worktree name (an issue slug); sanitised and made unique. */
  worktreeName?: string | null;
  /** Explicit acknowledgement that a requested worktree should be skipped. */
  onMain?: boolean;
  issue?: IssueRef | null;
  automation?: AutomationRef | null;
  /** The first agent conversation. Omit to open the checkout by itself. */
  tab?: NewTab;
}

export interface WorkspaceRename {
  name: string;
  path: string;
  branch: string;
  sessions: SessionEntry[];
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
  accountSignOut: () => invoke<AccountStatus>("account_sign_out"),
  /** `selected: false`: created, but selecting it failed. Select it by id; never create again. */
  organizationCreate: (name: string, idempotencyKey: string) =>
    invoke<OrganizationSummary & { selected?: boolean }>("organization_create", { name, idempotencyKey }),
  organizationSelect: (organizationId: string, contextRevision: string) =>
    invoke<AccountStatus>("organization_select", { organizationId, contextRevision }),

  // provider-aware Cloud Workspaces; authentication and Organization scope
  // are resolved natively, so account tokens never cross this boundary.
  cloudProviders: () => invoke<CloudProviderSummaryResponse>("cloud_providers"),
  cloudProvider: (provider: CloudWorkspaceProviderId) => invoke<CloudProviderConnection>("cloud_provider", { provider }),
  cloudProviderDisconnect: (provider: CloudWorkspaceProviderId, contextRevision: string, disposition: "retain" | "destroy") =>
    invoke<CloudProviderConnection>("cloud_provider_disconnect", { provider, contextRevision, disposition }),
  /** Allow or stop new machines on a provider (owners and admins); saved keys and running workspaces are untouched. */
  cloudProviderSetCreationEnabled: (provider: CloudWorkspaceProviderId, contextRevision: string, enabled: boolean) =>
    invoke<CloudProviderSummary>("cloud_provider_set_creation_enabled", { provider, contextRevision, enabled }),
  /** Check the saved key against the provider again, without entering it. */
  cloudProviderRevalidate: (provider: CloudWorkspaceProviderId, contextRevision: string) =>
    invoke<CloudProviderConnection>("cloud_provider_revalidate", { provider, contextRevision }),
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
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_create", { input, orgId: orgId ?? null }),
  cloudWorkspacePreflight: (repositories: CloudWorkspaceRepositoryInput[], orgId?: string | null) =>
    invoke<CloudWorkspacePreflight>("cloud_workspace_preflight", { repositories, orgId: orgId ?? null }),
  cloudWorkspaceRepositories: (orgId?: string | null) => invoke<CloudSelectedRepositories>("cloud_workspace_repositories", { orgId: orgId ?? null }),
  cloudWorkspaces: (orgId?: string | null) => invoke<CloudWorkspaceList>("cloud_workspaces", { orgId: orgId ?? null }),
  /** Every member organization's list in one request, for a server that offers it; `cursor` is the last answer's. */
  cloudCatalogFeed: (cursor?: string | null) => invoke<CloudCatalogFeed>("cloud_catalog_feed", { cursor: cursor ?? null }),
  cloudWorkspaceSuspend: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_suspend", { workspaceId, orgId: orgId ?? null }),
  cloudWorkspaceResume: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_resume", { workspaceId, orgId: orgId ?? null }),
  cloudWorkspaceRelease: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_release", { workspaceId, orgId: orgId ?? null }),
  /** Archive (30-day trash). `force` only after the person confirmed stopping running agent work. */
  cloudWorkspaceArchive: (workspaceId: string, force: boolean, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_archive", { workspaceId, force, orgId: orgId ?? null }),
  /** Permanent delete, a resumable cleanup job; retrying resumes the same operation. */
  cloudWorkspaceDelete: (workspaceId: string, force: boolean, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_delete", { workspaceId, force, orgId: orgId ?? null }),
  /** Out of the archive; it stays suspended until the next interactive action. */
  cloudWorkspaceUnarchive: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_unarchive", { workspaceId, orgId: orgId ?? null }),
  cloudWorkspaceDisposition: (workspaceId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceDisposition>("cloud_workspace_disposition", { workspaceId, orgId: orgId ?? null }),
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
  /** The saved cloud catalog (PRO-57) of the signed-in user; refused once `revision` is not the current account. */
  cloudCatalogLoad: (revision: string) => invoke<unknown>("cloud_catalog_load", { revision }),
  cloudCatalogSave: (revision: string, catalog: unknown) => invoke<void>("cloud_catalog_save", { revision, catalog }),
  /** Drop the agent outbox, transcript cache and keys this Mac kept for a deleted workspace. */
  cloudAgentPurgeWorkspace: (organizationId: string, workspaceId: string) =>
    invoke<{ removed: boolean; unsentCommands: number; cachedTabs: number }>("cloud_agent_purge_workspace", { organizationId, workspaceId }),
  cloudWorkspaceOperation: (operationId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_operation", { operationId, orgId: orgId ?? null }),
  cloudWorkspaceOperationCancel: (operationId: string, orgId?: string | null) =>
    invoke<CloudWorkspaceSnapshot>("cloud_workspace_operation_cancel", { operationId, orgId: orgId ?? null }),
  // Remote runtime connections (PRO-13); relay credentials and E2EE keys stay native.
  cloudRemoteAttach: (target: CloudWorkspaceTarget, activation: Activation) =>
    invoke<string>("cloud_remote_attach", { target, activation }),
  cloudRemoteAttachDev: (pairingCode: string) => invoke<string>("cloud_remote_attach_dev", { pairingCode, ticket: null }),
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
  pairingGenerate: (connectionMode: PairingConnectionMode) => invoke<PairingStatus>("pairing_generate", { connectionMode }),
  pairingRevoke: (deviceId: string) => invoke<PairingStatus>("pairing_revoke", { deviceId }),
  pairingSetHostName: (displayName: string) => invoke<PairingStatus>("pairing_set_host_name", { displayName }),

  // projects
  listProjects: () => invoke<{ projects: Project[]; lastSelected: string | null }>("list_projects"),
  addProject: (path: string) => invoke<Project>("add_project", { path }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  selectProject: (path: string) => invoke<void>("select_project", { path }),
  updateProject: (path: string, patch: ProjectPatch) => invoke<Project>("update_project", { path, patch }),
  setProjectLogo: (path: string, source: string | null) => invoke<Project>("set_project_logo", { path, source }),
  listWorkspaces: (projectPath: string) => invoke<Workspace[]>("list_workspaces", { projectPath }),
  previewWorkspaceName: (projectPath: string, requested?: string | null) =>
    invoke<string>("preview_workspace_name", { projectPath, requested: requested ?? null }),
  renameWorkspace: (projectPath: string, path: string, name: string) =>
    invoke<WorkspaceRename>("rename_workspace", { projectPath, path, name }),
  workspaceDisposition: (projectPath: string, path: string) => invoke<WorkspaceDisposition>("workspace_disposition", { projectPath, path }),
  deleteWorkspace: (projectPath: string, path: string, deleteBranch: boolean) =>
    invoke<WorkspaceDeleteReport>("delete_workspace", { projectPath, path, deleteBranch }),

  // sessions
  listSessions: () => invoke<SessionEntry[]>("list_sessions"),
  /** Card snippets for the agent dashboard; every session when no ids are given. */
  sessionSummaries: (sessionIds?: string[]) => invoke<SessionSummary[]>("session_summaries", { sessionIds: sessionIds ?? null }),
  statsUsageSnapshot: () => invoke<StatsUsageState>("stats_usage_snapshot"),
  statsUsageRefresh: (scope: string, generation: number) => invoke<StatsUsageState>("stats_usage_refresh", { scope, generation }),
  appActivitySummary: () => invoke<AppStats>("app_activity_summary"),
  createSession: (req: NewSession) => invoke<SessionEntry>("create_session", { req }),
  addTab: (sessionId: string, tab: NewTab) => invoke<TabEntry>("add_tab", { sessionId, tab }),
  removeTab: (sessionId: string, tabId: string) => invoke<void>("remove_tab", { sessionId, tabId }),
  renameSession: (sessionId: string, title: string) => invoke<void>("rename_session", { sessionId, title }),
  setSessionArchived: (sessionId: string, archived: boolean) =>
    invoke<void>("set_session_archived", { sessionId, archived }),
  setSessionPinned: (sessionId: string, pinned: boolean) => invoke<void>("set_session_pinned", { sessionId, pinned }),
  setActiveTab: (sessionId: string, tabId: string) => invoke<void>("set_active_tab", { sessionId, tabId }),
  deleteSession: (sessionId: string, removeWorktree: boolean) =>
    invoke<DeleteSessionReport>("delete_session", { sessionId, removeWorktree }),
  worktreeDisposition: (sessionId: string) => invoke<WorktreeDisposition>("worktree_disposition", { sessionId }),
  sessionsSharingWorktree: (sessionId: string) => invoke<string[]>("sessions_sharing_worktree", { sessionId }),
  removeSessionWorktree: (sessionId: string) => invoke<SessionEntry>("remove_session_worktree", { sessionId }),
  settleSession: (sessionId: string, action: "delete" | "relocate") => invoke<SettleReport>("settle_session", { sessionId, action }),
  forkSession: (sessionId: string, tabId: string) => invoke<SessionEntry>("fork_session", { sessionId, tabId }),

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
  /** The person's global Git identity; it authors their commits in cloud workspaces. */
  gitIdentity: () => invoke<{ name: string; email: string } | null>("git_identity"),
  listBranches: (cwd: string) => invoke<BranchInfo[]>("list_branches", { cwd }),
  snapshotTree: (cwd: string) => invoke<string>("snapshot_tree", { cwd }),
  headTree: (cwd: string) => invoke<string | null>("head_tree", { cwd }),
  changesBetween: (cwd: string, base: string, head: string | null) =>
    invoke<ChangedFile[]>("changes_between", { cwd, base, head }),
  fileContentsAt: (cwd: string, path: string, base: string, head: string | null) =>
    invoke<{ before: string | null; after: string | null }>("file_contents_at", { cwd, path, base, head }),
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
}

export interface AccountIdentity {
  name: string | null;
  email: string;
  organization: string | null;
  /** The active (default) organization's id. */
  organizationId?: string | null;
}

export interface AccountStatus {
  state: "signed-out" | "signing-in" | "signed-in";
  identity: AccountIdentity | null;
  expiresAt: number | null;
  lastError: string | null;
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
}

/** One organization of the catalog feed: its list, or why it was not listed (the others are unaffected). */
export interface CloudCatalogOrganization {
  orgId: string;
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
  changed: boolean;
  cursor: string | null;
  reset: boolean;
  organizations: CloudCatalogOrganization[];
  deletedWorkspaceIds: string[];
}

/** `local-docker` is offered by debug builds only (terminalx-saas `cloud:e2e:local --serve`). */
export type CloudWorkspaceProviderId = "machine0" | "box" | "local-docker";
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
  resources?: CloudProviderResource[] | null;
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
  allowedIdleSuspendMinutes: number[];
  allowedRetentionDays: number[];
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
  lastActivityAt?: number | null;
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
  providerCapabilities: { permanentDelete: boolean; releaseDisposition: string };
  archiveRetentionDays: number;
  blockers: ("active-turns" | "pending-approvals" | "operation-in-progress" | (string & {}))[];
  removedOnDelete: string[];
  runtimeFacts: { available: boolean };
}

/** What a share grants (contract §21.2). */
export type CloudShareRole = "viewer" | "driver";
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
}

export interface CloudWorkspaceSnapshot {
  workspace: CloudWorkspace;
  operation: CloudWorkspaceOperation;
}

export interface CloudWorkspaceListItem {
  workspace: CloudWorkspace;
  latestOperation: CloudWorkspaceOperation | null;
}

export interface CloudWorkspaceList {
  workspaces: CloudWorkspaceListItem[];
  tombstones?: CloudWorkspaceTombstone[];
  /** Non-archived workspaces against the organization's limit (S1); absent from older servers. */
  quota?: CloudWorkspaceQuota | null;
}

/** The organization's workspace slots (§20.1); `used`/`limit` mirror `running` since PRO-76. */
export interface CloudWorkspaceQuota {
  used: number;
  limit: number;
  running?: { used: number; limit: number };
  total?: { used: number; limit: number };
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
}

export interface CloudWorkspacePreflight {
  ready: boolean;
  checks: {
    kind: string;
    cloneUrl: string | null;
    status: "verified" | "failed";
    errorCode: string | null;
    retryable: boolean;
  }[];
}

export interface CloudSelectedRepository {
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

export interface CloudWorkspaceClientError {
  code: CloudWorkspaceSafeErrorCode;
  status: number | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
  retryWithSameIdempotencyKey: boolean;
  requiresOriginalAccountContext: boolean;
}

export type CloudWorkspaceSafeErrorCode =
  | "invalid_access_token"
  | "organization_admin_required"
  | "active_organization_required"
  | "cloud_workspace_not_found"
  | "cloud_workspace_operation_not_found"
  | "machine0_connection_required"
  | "cloud_provider_not_found"
  | "cloud_provider_connection_required"
  | "cloud_provider_connection_attention_required"
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
  | "cloud_workspace_device_auth_unavailable"
  | "cloud_workspace_operation_in_progress"
  | "cloud_workspace_active_work"
  | "cloud_workspace_archived"
  | "cloud_teardown_in_progress"
  | "cloud_workspace_quota_exceeded"
  | "cloud_workspace_concurrency_exceeded"
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
  create: (input: AutomationInput) => invoke<Automation>("automation_create", { input }),
  update: (id: string, input: AutomationInput) => invoke<Automation>("automation_update", { id, input }),
  remove: (id: string) => invoke<void>("automation_delete", { id }),
  runNow: (id: string) => invoke<AutomationRun>("automation_run_now", { id }),
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
}

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

export interface UsageSnapshot {
  revision?: number;
  claudeAccount?: string | null;
  claude?: { retryAt: number | null; revalidateAt: number | null; error: string | null };
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
  killRule: "none" | "idle" | "confirm";
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
import type { AgentEvent } from "@/types/events";

export interface ImageInput {
  mediaType: string;
  data: string;
  name?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  images: [string, string][];
}

export interface SendOutcome {
  queued: boolean;
  events: AgentEvent[];
}

export interface ModelInfo {
  id: string;
  label: string;
  harness: string;
  efforts: string[];
  defaultEffort: string | null;
  acceptsImages: boolean;
  isDefault: boolean;
  /** The model that replaces this one when the provider is retiring it. */
  upgrade: string | null;
  description: string | null;
  /** A family alias (`opus`): it follows the latest release rather than staying on one version. */
  alias?: boolean;
  /** The full model id an alias runs now, per the CLI on the machine that listed it. */
  resolved?: string | null;
}

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
}

export const agent = {
  prepareContinuation: (sessionId: string, tabId: string) => invoke<import("@/lib/continuation").ContinuationContext>("prepare_continuation", { sessionId, tabId }),
  loadEvents: (sessionId: string, tabId: string) => invoke<AgentEvent[]>("load_tab_events", { sessionId, tabId }),
  send: (sessionId: string, tabId: string, text: string, images?: ImageInput[], confirmDelivery = false) =>
    invoke<SendOutcome>("send_message", { sessionId, tabId, text, images: images ?? null, confirmDelivery }),
  interrupt: (sessionId: string, tabId: string) => invoke<void>("interrupt_turn", { sessionId, tabId }),
  tabHandoff: (sessionId: string, tabId: string) => invoke<HandoffInfo>("tab_handoff", { sessionId, tabId }),
  /** Start a tab's own CLI. Idempotent, and a no-op for headless harnesses. */
  ensureStarted: (sessionId: string, tabId: string) => invoke<void>("ensure_tab_started", { sessionId, tabId }),
  /** The pane a tab's CLI is running in, for a window that missed the event. */
  tabPane: (sessionId: string, tabId: string) => invoke<TabPtyEvent | null>("tab_pane", { sessionId, tabId }),
  stop: (sessionId: string, tabId: string) => invoke<void>("stop_tab", { sessionId, tabId }),
  cancelQueued: (sessionId: string, tabId: string, messageId: string) =>
    invoke<QueuedMessage | null>("cancel_queued", { sessionId, tabId, messageId }),
  listQueued: (sessionId: string, tabId: string) => invoke<QueuedMessage[]>("list_queued", { sessionId, tabId }),
  respondPermission: (sessionId: string, tabId: string, requestId: string, optionId: string) =>
    invoke<void>("respond_permission", { sessionId, tabId, requestId, optionId }),
  answerQuestions: (sessionId: string, tabId: string, requestId: string, answers: Record<string, string>) =>
    invoke<void>("answer_questions", { sessionId, tabId, requestId, answers }),
  setModel: (sessionId: string, tabId: string, model: string) => invoke<void>("set_tab_model", { sessionId, tabId, model }),
  setPermissionMode: (sessionId: string, tabId: string, mode: string) =>
    invoke<void>("set_tab_permission_mode", { sessionId, tabId, mode }),
  setEffort: (sessionId: string, tabId: string, effort: string | null) =>
    invoke<void>("set_tab_effort", { sessionId, tabId, effort }),
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

export const files = {
  search: (cwd: string, query: string, limit = 40) => invoke<FileHit[]>("search_files", { cwd, query, limit }),
  invalidate: (cwd: string) => invoke<void>("invalidate_file_index", { cwd }),
  readImage: (path: string) => invoke<{ mediaType: string; data: string; name: string } | null>("read_image_file", { path }),
  /** The plain text of the drag that just ended on the window: the drop event itself carries only file paths. */
  droppedText: () => invoke<string | null>("dropped_text"),
  slashCommands: (cwd: string, harness: string) => invoke<SlashCommand[]>("list_slash_commands", { cwd, harness }),
};

export const skills = {
  list: (projectPath?: string | null, refresh = false) =>
    invoke<DiscoveredSkill[]>("list_skills", { projectPath: projectPath ?? null, refresh }),
  detail: (dirPath: string) => invoke<SkillDetail>("skill_detail", { dirPath }),
};

// ---- git actions & pull requests
export interface PrCheck {
  name: string;
  state: string;
  url?: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: string | null;
  checks: PrCheck[];
  body: string;
  author: string;
}

export const git = {
  commit: (cwd: string, message: string, paths?: string[]) => invoke<string>("git_commit", { cwd, message, paths: paths ?? null }),
  push: (cwd: string) => invoke<string>("git_push", { cwd }),
  pull: (cwd: string) => invoke<string>("git_pull", { cwd }),
  discard: (cwd: string, path: string) => invoke<void>("git_discard", { cwd, path }),
  checkout: (cwd: string, name: string, create: boolean) => invoke<void>("git_checkout", { cwd, name, create }),
  workingChanges: (cwd: string) => invoke<[string, ChangedFile[]]>("working_changes", { cwd }),
};

export const gh = {
  available: () => invoke<boolean>("gh_available"),
  list: (cwd: string, branch: string) => invoke<PullRequest[]>("pr_list", { cwd, branch }),
  details: (cwd: string, number: number) => invoke<PullRequest>("pr_details", { cwd, number }),
  create: (cwd: string, title: string, body: string, base: string | null, draft: boolean) =>
    invoke<string>("pr_create", { cwd, title, body, base, draft }),
  merge: (cwd: string, number: number, method: "merge" | "squash" | "rebase") => invoke<void>("pr_merge", { cwd, number, method }),
  ready: (cwd: string, number: number) => invoke<void>("pr_ready", { cwd, number }),
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

// ---- terminals
export const pty = {
  spawn: (id: string, cwd: string, cols: number, rows: number, command?: string) => invoke<void>("pty_spawn", { id, cwd, cols, rows, command: command ?? null }),
  write: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  /**
   * Receive pane `id`'s output as raw bytes, starting with what it has
   * printed so far. One attachment per pane: a later one replaces it.
   * `token` names this attachment; its acknowledgements and its detach carry
   * it, so they cannot act on an attachment that has replaced it.
   */
  attach: (id: string, token: string, onData: (bytes: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (message) => onData(new Uint8Array(message));
    return invoke<void>("pty_attach", { id, token, channel });
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
  mtime: (path: string) => invoke<number | null>("file_mtime", { path }),
  inspectPath: (base: string, path: string) => invoke<LocalPathInfo>("inspect_local_path", { base, path }),
  /** Native default-app opening, restricted to existing local files/folders. */
  openPath: (path: string) => invoke<void>("open_local_path", { path }),
  searchText: (root: string, query: string, regex: boolean, caseSensitive: boolean, limit = 500, replacement?: string) =>
    invoke<TextSearch>("search_text", { root, query, regex, caseSensitive, limit, replacement: replacement ?? null }),
  /**
   * Rewrite matches on disk. Without `targets` every searchable file under
   * the root is a candidate except those in `skip`.
   */
  replaceText: (root: string, query: string, replacement: string, regex: boolean, caseSensitive: boolean, targets: ReplaceTarget[] | null, skip: string[] = []) =>
    invoke<ReplaceReport>("replace_text", { root, query, replacement, regex, caseSensitive, targets, skip }),
};

// ---- issues (GitHub through gh, Linear through its API)
export interface IssueLabel {
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
  labels: IssueLabel[];
  assignee?: IssueAssignee | null;
  updatedAt: string;
  body?: string | null;
  team?: IssueTeam | null;
}
export interface IssueFilter {
  assignedToMe?: boolean;
  teamId?: string | null;
  search?: string | null;
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
  installed: boolean;
  downloading: boolean;
  progress?: DownloadProgress;
  page: string;
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
 * runtime over the relay (`terminalx-workspace-rpc/1`), never by forwarding
 * desktop IPC.
 */
export type WorkspaceTarget = { kind: "local" } | CloudWorkspaceTarget;

export interface CloudWorkspaceTarget {
  kind: "cloud";
  organizationId: string;
  workspaceId: string;
  /** The generation last seen, if any; the attach ticket decides which runtime is current. */
  runtimeGeneration?: number;
}

export const LOCAL_WORKSPACE: WorkspaceTarget = { kind: "local" };

export function workspaceTargetKey(target: WorkspaceTarget): string {
  return target.kind === "local" ? "local" : `cloud:${target.organizationId}:${target.workspaceId}`;
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

  /** Listen first, so nothing the native side emits right after attaching is missed. */
  async listen(): Promise<void> {
    const unlisten = await listen<RemoteEvent>("cloud_remote_event", ({ payload }) => this.route(payload));
    if (this.closed) unlisten();
    else this.unlisten = unlisten;
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
  /** Raise the activation; only `wake` (an interactive action) resumes suspended compute. */
  activate(activation: Activation): Promise<void>;
  close(): void;
}

const connections = new Map<string, Promise<CloudWorkspaceConnection>>();

/**
 * The transport for a workspace target: null for a local workspace (use the
 * Tauri commands), a supervised remote connection for a cloud one. One
 * connection per target, even for concurrent callers; `connect` never wakes
 * suspended compute.
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
  const pending = adopt(key, target, (transport) => api.cloudRemoteAttach(target, activation).then((id) => (transport.bind(id), id)));
  connections.set(key, pending);
  pending.catch(() => {
    if (connections.get(key) === pending) connections.delete(key);
  });
  return pending;
}

/** Debug builds: a cloud session from a local runtime's pairing code. */
export async function devWorkspaceConnection(pairingCode: string): Promise<CloudWorkspaceConnection> {
  const key = `dev:${crypto.randomUUID()}`;
  const pending = adopt(key, { kind: "cloud", organizationId: "dev", workspaceId: key }, (transport) =>
    api.cloudRemoteAttachDev(pairingCode).then((id) => (transport.bind(id), id)),
  );
  connections.set(key, pending);
  pending.catch(() => connections.delete(key));
  return pending;
}

async function adopt(
  key: string,
  target: WorkspaceTarget,
  attach: (transport: NativeWorkspaceTransport) => Promise<string>,
): Promise<CloudWorkspaceConnection> {
  const transport = new NativeWorkspaceTransport();
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
    activate: (next) => transport.activate(next),
    close: () => {
      if (connections.get(key) === self) connections.delete(key);
      client.close();
    },
  };
  self = connections.get(key);
  client.onState((state) => {
    // Stopped for an identity change: drop it so nothing reuses the old one.
    if (state.state === "stopped") connection.close();
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

/** Drop every cloud connection and what it cached, e.g. on sign-out or an organization switch. */
export function closeWorkspaceConnections(): void {
  const all = [...connections.values()];
  connections.clear();
  for (const pending of all) void pending.then((connection) => connection.close()).catch(() => undefined);
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
