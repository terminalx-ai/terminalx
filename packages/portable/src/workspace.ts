// `terminalx-workspace-rpc/1`: the versioned pty/fs/git/session surface a
// cloud workspace runtime serves (terminalx-saas
// `apps/api/docs/cloud-workspace-remote-runtime-contract.md`). The same
// portable RPC envelope the phone uses carries it; this client adds what a
// connection that drops and comes back needs:
// - mutations carry a `clientRequestId` that is kept across resends, so the
//   runtime answers a resend from its idempotency cache instead of writing
//   or prompting twice;
// - terminal input is queued per terminal and sent one numbered write at a
//   time (`writerId` + `seq`), so it arrives once and in order across drops,
//   and a refusal is reported rather than dropped;
// - terminals belong to one runtime process (`epoch`): after a restart or
//   replacement nothing is sent to them and their views are told they ended;
// - subscriptions resume from their last offset or cursor after a
//   reconnect, and resync from a snapshot when the runtime generation moved.
import { PortableRpcClient, type RpcCallResult, type RpcErrorData, type RpcResponse, type RpcWireRequest } from "./rpc";

export const WORKSPACE_PROTOCOL = "terminalx-workspace-rpc/1";
/** PRO-212: sample lifecycle.resources only while the details card is open and
 * this runtime is connected. Reuse runtimeResources in workspaceGit: v1 memory
 * and storage are bytes, observedAt is epoch ms, absent samples stay unavailable.
 * v1 has no CPU field. Discard samples on disconnect/runtime generation change.
 */
export const WORKSPACE_DETAILS_RESOURCE_INTERVAL_MS = 10_000;

/**
 * Namespace versions, as `src-tauri/src/remote/protocol.rs` `CAPABILITIES`.
 * A newer version only adds to its namespace (CS-12):
 * - `session/2`: `session.update`, `session.addTab`, `session.delete` and the
 *   `session.sessions` notification;
 * - `session/3` (#427): `session.interrupt`, Escape for an agent tab's
 *   running turn. Live only, never queued or resent;
 * - `pty/2`: `pty.create` takes a `sessionId`, and `pty.list` returns it;
 * - `agents/1`: `runtime.agents`;
 * - `environment/1`: bounded installed-tool versions (`environment.report`)
 *   and attachment-scoped cancellation (`environment.cancel`);
 * - `agent-pty/1` (PRO-86): the terminal an agent tab's CLI runs in answers
 *   the `pty.*` methods as `agentPtyId(tabId)`. It adds no method;
 * - `composer/1` (PRO-22): `session.commands`, the slash commands an agent
 *   tab's composer offers this person;
 * - `composer/2`: `session.files`, the session's files by name, for the
 *   composer's `@` list;
 * - `composer/3`: `session.attach`, an image uploaded in parts for the
 *   message that then names it;
 * - `ports/1` (PRO-28): streams to TCP ports on the workspace's loopback, for
 *   private previews (docs/CLOUD-PREVIEWS.md): `listPorts` here; the streams
 *   themselves are carried by the desktop's native forwarder;
 * - `mirror/1` (PRO-25): `mirror.manifest`, the files a desktop may copy
 *   into its local mirror of the workspace;
 * - `cleanup/1`: the bulk worktree clean-up. The runtime inspects and removes
 *   its own worktrees; this client only names them. While `cleanup.remove`
 *   runs, its caller is sent `cleanup.progress` notifications; a runtime
 *   from before them sends none, and the answer is the same either way;
 * - `workspace/1`: one session's worktree, for the removal dialog:
 *   `workspace.disposition` and `workspace.remove`. The worktree is named by
 *   its session, never by a path;
 * - `workspace/2`: the removal that follows a merged pull request. The
 *   runtime looks at its own worktrees, removes the ones that are safe and
 *   due, and records them; this client only says that it is on;
 * - `pipeline/1` (#433): the issue pipelines the runtime carries.
 *   `pipeline.list` and the `pipeline.changed` notification; `pipeline.act`,
 *   `pipeline.noteMerge` and `pipeline.noteTracker` for a manager. A runtime
 *   never merges and holds no Linear key: the desktop merges with its
 *   reader's own `gh` and moves a Linear issue to review with their key, and
 *   says so. `session.create` takes an issue only where it is granted.
 * `pipeline/2` adds paginated persistent reviewer identities (`pipeline.reviewers`).
 * `agent-commands/1` (PRO-343): `session.steer`, `session.stop` and
 * `session.decide`, and `session.send` held to the same rules, as live calls
 * answered once per `clientRequestId` from the runtime's durable receipts.
 * Only a runtime with no cloud mailbox (a machine) grants it; a cloud
 * workspace's commands keep going through the mailbox.
 * An older runtime grants none of them; check `hasCapability` before offering
 * the matching action.
 */
export const WORKSPACE_CAPABILITIES = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "session/3", "session-status/1", "session-repository/1", "session-base/1", "keys/1", "lifecycle/1", "agents/1", "collab/1", "agent-pty/1", "composer/1", "composer/2", "composer/3", "composer/4", "ports/1", "mirror/1", "cleanup/1", "workspace/1", "workspace/2", "pipeline/1", "pipeline/2", "agent-commands/1", "environment/1"] as const;
/**
 * Offered only by a runtime that serves every project of its machine (docs/MACHINES.md).
 * `machine/3` (PRO-354): `machine.updateStatus`, `machine.update` and the
 * `machine.updateChanged` notification.
 * `machine/4` (PRO-350): `machine.agentSetup` and `machine.agentSetupRunning`,
 * an agent's install or sign-in in a terminal on the machine.
 * `machine/5` (PRO-357): `machine.rotateCredential`, a fresh device token
 * for the paired computer.
 * `machine/6` (PRO-351): browse the machine's folders, add, clone and remove
 * its projects (docs/MACHINES.md "As built (PRO-351)").
 * `machine/7` (PRO-403): a session's Setup and Run on the machine: its
 * project's saved actions, preview URLs and setup script as the machine has
 * them, and runs started there (docs/MACHINES.md "As built (PRO-403)").
 * `machine/8` (PRO-408): `session.usage`, `session.prepareContinuation` and
 * `session.checkFailures`, a machine session's cost chip, Continue in a new
 * tab and Fix check errors read and done on the machine.
 */
export const MACHINE_CAPABILITIES = ["machine/1", "machine/2", "machine/3", "machine/4", "machine/5", "machine/6", "machine/7", "machine/8"] as const;
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number] | (typeof MACHINE_CAPABILITIES)[number];

/**
 * Methods served only under a specific namespace version. Every other method
 * needs any version of the namespace it is named after.
 */
export const METHOD_CAPABILITIES: Readonly<Record<string, WorkspaceCapability>> = {
  "machine.relayAccess": "machine/2",
  "machine.updateStatus": "machine/3",
  "machine.update": "machine/3",
  "machine.agentSetup": "machine/4",
  "machine.agentSetupRunning": "machine/4",
  "machine.rotateCredential": "machine/5",
  "machine.browse": "machine/6",
  "machine.addProject": "machine/6",
  "machine.removeProject": "machine/6",
  "machine.cloneProject": "machine/6",
  "machine.cloneStatus": "machine/6",
  "machine.cloneCancel": "machine/6",
  "machine.sessionActions": "machine/7",
  "machine.runAction": "machine/7",
  "machine.setupRerun": "machine/7",
  "machine.setupStop": "machine/7",
  "session.usage": "machine/8",
  "session.prepareContinuation": "machine/8",
  "session.checkFailures": "machine/8",
  "pipeline.list": "pipeline/1",
  "pipeline.act": "pipeline/1",
  "pipeline.resolveConflicts": "pipeline/1",
  "pipeline.noteMerge": "pipeline/1",
  "pipeline.noteTracker": "pipeline/1",
  "pipeline.reviewers": "pipeline/2",
  "session.update": "session/2",
  "session.addTab": "session/2",
  "session.delete": "session/2",
  "session.interrupt": "session/3",
  "session.toTerminal": "session/3",
  "runtime.agents": "agents/1",
  "environment.report": "environment/1",
  "environment.cancel": "environment/1",
  "session.commands": "composer/1",
  "session.files": "composer/2",
  "session.attach": "composer/3",
  // `collab/1` (PRO-30, docs/CLOUD-SHARING.md) also grants presence, notes
  // and tab leases, which are not named after it.
  "presence.update": "collab/1",
  "notes.list": "collab/1",
  "notes.post": "collab/1",
  "lease.acquire": "collab/1",
  "lease.release": "collab/1",
  "lease.takeOver": "collab/1",
  "workspace.sweepMerged": "workspace/2",
  "workspace.holdMerged": "workspace/2",
  "workspace.removedRecords": "workspace/2",
  "workspace.restoreRemoved": "workspace/2",
  "session.steer": "agent-commands/1",
  "session.stop": "agent-commands/1",
  "session.decide": "agent-commands/1",
};

/**
 * The terminal an agent tab's own CLI runs in, on a runtime that granted
 * `agent-pty/1`. It is attached, typed into, sized and controlled like a
 * shell (`attachPty`, `write`, `resizePty`, `controlPty`), is never in
 * `pty.list`, and cannot be killed: it closes with its tab. Typing and sizing
 * also need the tab's lease to be free or this person's.
 */
export function agentPtyId(tabId: string): string {
  return `tab:${tabId}`;
}

/** Methods a machine serves per project: they name the project (docs/MACHINES.md "Project scoping"). */
const PROJECT_SCOPED = /^(fs|git)\./;

/** How much a caller may cost: only an interactive action may wake compute. */
export type Activation = "cache-only" | "sync" | "connect" | "wake";

export const MUTATING_METHODS = new Set([
  "session.create",
  "session.close",
  "session.send",
  "session.steer",
  "session.stop",
  "session.decide",
  "session.configure",
  "session.update",
  "session.addTab",
  "session.delete",
  "session.toTerminal",
  "cleanup.remove",
  "workspace.remove",
  "workspace.sweepMerged",
  "workspace.holdMerged",
  "workspace.restoreRemoved",
  "pipeline.act",
  "pipeline.resolveConflicts",
  "pipeline.noteMerge",
  "pipeline.noteTracker",
  "pty.create",
  "fs.write",
  "fs.writePart",
  "fs.rename",
  "fs.delete",
  "fs.mkdir",
  "git.checkout",
  "git.commit",
  "git.stage",
  "git.unstage",
  "git.push",
  "git.pull",
  "git.fetch",
  "git.prCreate",
  "git.prCreateForSession",
  "git.prLinkBranch",
  "git.prUnlink",
  "git.prConversationAction",
  "git.prReady",
  "git.prMerge",
  "notes.post",
]);

/** A person's collaboration role on a shared workspace (saas contract §21.1). */
export type CollaborationRole = "manager" | "driver" | "viewer" | "none";

/** Who this connection is, from `rpc.hello` when `collab/1` is granted. */
export interface WorkspaceYou {
  userId: string;
  role: CollaborationRole;
  canApprove: boolean;
  /** False while the runtime has no member list yet (then `role` says nothing about sharing). */
  listed?: boolean;
}

export type WorkspaceConnectionState =
  | { state: "idle" | "opening" | "waitingForRuntime" | "suspended" | "updateRequired" | "stopped" }
  | { state: "connecting"; attempt: number }
  | { state: "reconnecting"; attempt: number; reason: string; retryInMs: number }
  | {
      state: "connected";
      runtimeGeneration: number;
      /** The runtime process; absent from a runtime older than PRO-26. */
      runtimeEpoch?: string;
      runtimeVersion: string;
      capabilities: string[];
      authority: "manage" | "participate";
      /** The person behind this connection; only from a runtime that granted `collab/1`. */
      you?: WorkspaceYou | null;
      /**
       * Which link carries the connection (a machine, docs/MACHINES.md "As built
       * (PRO-345)"). A new number while connected is a new E2EE session, e.g.
       * the relay handed over to a direct route: every subscription resumes from
       * its cursor, and requests already sent are still answered on the old one.
       */
      link?: number;
    };

/**
 * A machine's update (PRO-354, docs/MACHINES.md "Versions and updates"):
 * `machine.updateStatus`, `machine.update` and `machine.updateChanged`.
 * `src/types/machines.ts` re-exports these for the desktop.
 */
export type MachineUpdateMethod = "installer" | "app" | "unmanaged";

/** Work a handover cannot carry: it stops if the person goes ahead. */
export interface MachineUpdateBlocker {
  id: string;
  kind: string;
  title: string;
}

/** Another paired computer operating the machine right now. */
export interface MachineUpdateOtherComputer {
  id: string;
  label: string;
}

export type MachineUpdatePhase = "downloading" | "verifying" | "trial" | "handingOver" | "cleaningUp";

export type MachineUpdateProgress =
  | { phase: "idle" }
  | { phase: MachineUpdatePhase; version: string; since: number }
  | { phase: "appUpdating"; version: string | null; since: number; step: string | null }
  | { phase: "updated"; from: string; to: string; at: number }
  | {
      phase: "failed";
      version: string;
      at: number;
      message: string;
      /** The version the machine runs now. */
      running: string;
      /** The new version was started and the old one put back. */
      rolledBack: boolean;
    };

export interface MachineUpdateStatus {
  method: MachineUpdateMethod;
  current: string;
  /** The newest release this machine could update to; null when none is newer or it has not checked. */
  available: { version: string } | null;
  checkedAt: number | null;
  blockers: MachineUpdateBlocker[];
  otherComputers: MachineUpdateOtherComputer[];
  /** Versions on disk, newest first (at most three). */
  kept: string[];
  progress: MachineUpdateProgress;
}

/** `machine.update`'s params. */
export interface MachineUpdateRequest {
  version: string;
  /** Blocker ids the person agreed to stop. */
  stop?: string[];
  /** The other computers (ids) the person was told are connected; one not named refuses the update with `update_confirm`. */
  confirmedOthers?: string[];
}

const UPDATE_METHODS: readonly string[] = ["installer", "app", "unmanaged"];

/** A `MachineUpdateStatus` as the runtime sent it, or null when it is not one. Lists default to empty. */
export function machineUpdateStatus(value: unknown): MachineUpdateStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.method !== "string" || !UPDATE_METHODS.includes(raw.method) || typeof raw.current !== "string") return null;
  const progress = raw.progress && typeof raw.progress === "object" && typeof (raw.progress as { phase?: unknown }).phase === "string" ? (raw.progress as MachineUpdateProgress) : { phase: "idle" as const };
  const available = raw.available && typeof raw.available === "object" && typeof (raw.available as { version?: unknown }).version === "string" ? { version: (raw.available as { version: string }).version } : null;
  const list = <T,>(items: unknown, valid: (item: Record<string, unknown>) => boolean): T[] => (Array.isArray(items) ? items.filter((item): item is T => !!item && typeof item === "object" && valid(item as Record<string, unknown>)) : []);
  return {
    method: raw.method as MachineUpdateMethod,
    current: raw.current,
    available,
    checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : null,
    blockers: list<MachineUpdateBlocker>(raw.blockers, (item) => typeof item.id === "string" && typeof item.title === "string"),
    otherComputers: list<MachineUpdateOtherComputer>(raw.otherComputers, (item) => typeof item.id === "string" && typeof item.label === "string"),
    kept: Array.isArray(raw.kept) ? raw.kept.filter((entry): entry is string => typeof entry === "string") : [],
    progress,
  };
}

/** Who drives a terminal's input and size: this client, another device, or nobody. */
export type PtyControl = "you" | "other" | "none";

/** The most ports or streams `listPorts` returns, whatever the runtime sent. */
export const MAX_LISTED_PORTS = 256;

/**
 * The program listening on a port, as `ports.list` names it (PRO-355). `name`
 * is a short label for the command (`vite`, `redis-server`); `cwd` is its
 * working directory on the runtime's computer, absent where it cannot be read.
 */
export interface ListedProcess {
  name: string;
  pid?: number;
  cwd?: string;
}

/** A listening port; `process` is absent on a runtime that does not name it. */
export interface ListedPort {
  port: number;
  process?: ListedProcess;
}

/** The longest process name or directory kept from `ports.list`. */
const MAX_PROCESS_TEXT = 512;

/** A `ports.list` entry's `process`, or nothing: the runtime is not trusted for the shape. */
export function listedProcess(value: unknown): ListedProcess | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field.trim() && field.length <= MAX_PROCESS_TEXT ? field : undefined);
  const name = text(record.name);
  if (!name) return undefined;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
  const cwd = text(record.cwd);
  return { name, ...(pid !== undefined ? { pid } : {}), ...(cwd !== undefined ? { cwd } : {}) };
}

/** An agent process on the runtime. A tab whose process ended keeps its saved conversation. */
export type AgentProcessState = "running" | "exited" | "not-started";
export type AgentTabStatus = "idle" | "in_progress" | "waiting" | "completed";

/** An agent tab as `session.tabs` and `session.configure` describe it (docs/CLOUD-AGENT-TABS.md). */
export interface AgentTabInfo {
  sessionCreated?: string | null;
  sessionLastMessageAt?: string | null;
  sessionHasMessages?: boolean;
  sessionId: string;
  tabId: string;
  title: string | null;
  harness: string;
  /** Native Codex (#644): absent for an agent run in the tab's terminal. Its terminal view moves it there (`moveAgentTabToTerminal`). */
  transport?: "experimentalCodexStdio";
  /** What the agent is running. */
  model: string;
  effort: string | null;
  /** Asked for and not confirmed by the agent yet; absent from a runtime that does not track it. */
  requestedModel?: string | null;
  requestedEffort?: string | null;
  permissionMode: string;
  requestedPermissionMode?: string | null;
  status: AgentTabStatus;
  process: AgentProcessState;
  pendingPermissions: { requestId: string; toolName: string; input: unknown; options: unknown[] }[];
  /** `actorId`: who queued it, on a runtime with `collab/1`. */
  followUps: { clientCommandId: string; text: string; actorId?: string | null }[];
  /** Who holds the tab's input lease, on a runtime with `collab/1`. */
  lease?: { tabId: string; holderId: string; acquiredAt: number; expiresAt: number } | null;
  /**
   * Set when the tab's agent has no way to sign in (PRO-78): `state` is
   * `not-connected` when the organization has no login for `provider`, else
   * the server's state for the one it has (`revoked`, `disconnected`,
   * `unavailable`, with a `reason` such as `token-expired`).
   */
  signIn?: { provider: string; state: string; reason?: string | null } | null;
  lastSeq: number;
  created: string;
  modified: string;
  /** Latest verified user/assistant message time; absent for unverified history. */
  lastMessageAt?: string | null;
  hasMessages?: boolean;
}

/** An agent tab as the runtime's session index stores it. */
export interface RuntimeSessionTab {
  id: string;
  harness: string;
  title?: string | null;
  model: string;
  effort?: string | null;
  permissionMode: string;
  status: AgentTabStatus;
  created: string;
  modified: string;
  /** Latest verified user/assistant message time; absent for unverified history. */
  lastMessageAt?: string | null;
  hasMessages?: boolean;
  /** Tokens and estimated cost by model as of its last turn end (PRO-273); absent until one is read. */
  usage?: RuntimeTabUsage | null;
  /** On a machine (`machine/8`): the account the tab runs on, only when its agent has several there. */
  accountLabel?: string | null;
}

/** One model's tokens in a tab or session. `costUsd` is the API list price; `null` when the model has no price. */
export interface RuntimeModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface RuntimeTabUsage {
  models: RuntimeModelUsage[];
  updated: string;
}

/** A usage window of an agent's login, as the runtime reads it. */
export interface RuntimeUsageWindow {
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

/** `session.usage` (`machine/8`): what `terminalx sessions usage` reports there, how each agent signs in there, and its usage windows. */
export interface RuntimeSessionUsage {
  usage: {
    sessionId: string;
    title: string;
    tabs: { tabId: string; title?: string | null; agent: string; models: RuntimeModelUsage[]; updated: string }[];
    models: RuntimeModelUsage[];
    estimate: true;
  };
  /** By agent: "Claude account", "ChatGPT account", "API key", or `null` when not known or mixed. */
  loginMethods: Record<string, string | null>;
  windows: RuntimeUsageWindow[];
}

/** `workspace.remove`: the sessions that went with the worktree, and what became of its branch. */
export interface RuntimeWorkspaceRemoved {
  deleted: string[];
  keptBranch?: string | null;
  rescuedBranch?: string | null;
}

/** An issue a session is started from, as the runtime keeps it with the session. */
export interface RuntimeIssueRef {
  provider: "github" | "linear";
  id: string;
  identifier: string;
  title: string;
  url: string;
}

/**
 * An issue's pipeline as the runtime reports it (`issue_pipeline::Pipeline`,
 * camelCase). The desktop reads it with its own type; here it is only
 * carried.
 */
export interface RuntimeIssuePipeline {
  id: string;
  cloud?: boolean;
  [field: string]: unknown;
}

/** A pull request that merged, with the commit that was merged: its head. */
export interface MergedPr {
  number: number;
  title: string;
  url: string;
  head: string;
}

/** What became of a branch when its workspace was removed after its pull request merged. */
export type MergedBranchFate =
  | { outcome: "deleted" }
  /** It was not there any more: GitHub deletes a merged branch itself when the repository is set to. */
  | { outcome: "alreadyGone" }
  /** The remote branch points at another commit than the one that was merged, so it was kept. */
  | { outcome: "moved"; at: string }
  | { outcome: "kept"; reason: string };

/** One workspace removed after its pull request merged (`merged_cleanup.rs`). Its paths are its host's. */
export interface MergedRemoval {
  id: string;
  removedAt: string;
  projectPath: string;
  path: string;
  name: string;
  branch: string;
  /** The commit the workspace was at. */
  commit: string;
  pr: MergedPr;
  localBranch: MergedBranchFate;
  remoteBranch: MergedBranchFate;
  /** The sessions whose conversations were kept and filed under the project. */
  sessionsKept: string[];
  sessionsDeleted: string[];
  restoredAt?: string | null;
}

/** A removal with why it cannot be brought back; `blocked` is null when it can. */
export interface MergedRemovalView extends MergedRemoval {
  blocked: string | null;
}

export type MergedPhase = "scheduled" | "kept" | "held" | "removed";

/** Where one workspace whose pull request merged stands after a pass. */
export interface MergedStatus {
  archiveBlocked?: boolean;
  projectPath: string;
  path: string;
  name: string;
  branch: string;
  pr: MergedPr;
  phase: MergedPhase;
  /** Why it stays, in a few words ("2 uncommitted files"). Only when kept. */
  reason: string | null;
  /** The same in full. */
  detail: string | null;
  /** When it goes if nothing changes. Only when scheduled. */
  due: string | null;
  /** The merge was first seen in this pass. */
  fresh: boolean;
  /** The sessions in it. */
  sessions: string[];
  /** What was removed. Only when removed. */
  record: MergedRemoval | null;
}

/** One pass: where each workspace whose pull request merged stands, and the projects whose pull requests could not be read. */
export interface MergedSwept {
  statuses: MergedStatus[];
  /** GitHub could not be asked about these projects, so nothing in them was looked at. */
  unreadable: { projectPath: string; reason: string }[];
}

/** What an undo did; `notes` says what could not be put back. */
export interface MergedRestored {
  record: MergedRemoval;
  notes: string[];
}

/** What the clean-up decided about one worktree (`worktree_cleanup.rs`). */
export type CleanupVerdict = "eligible" | "ignoredData" | "protected" | "active" | "inProgress" | "dirty" | "unpushed" | "unverifiable";

export interface CleanupSession {
  id: string;
  title: string;
  modified: string;
  /** What it is doing now, when it is doing anything. */
  live: string | null;
}

/** One worktree on the host that was scanned. Its paths are that host's. */
export interface CleanupCandidate {
  projectPath: string;
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  managed: boolean;
  verdict: CleanupVerdict;
  /** Why it is not eligible; null when it is. */
  reason: string | null;
  lastActivity: string | null;
  sessions: CleanupSession[];
  /** Ignored build and dependency output that goes with it. */
  disposable: string[];
  /** Ignored entries that may be local data. */
  ignoredData: string[];
  /** Stands for what was shown; a removal is refused when it no longer holds. */
  token: string;
}

export interface CleanupProject {
  path: string;
  name: string;
  note: string | null;
  candidates: CleanupCandidate[];
}

export interface ArchiveFailure {
  log?: string | null;
  sessionsStopped?: boolean;
  /** The script's last line of output. Absent from older hosts and from a run that printed nothing. */
  detail?: string | null;
  /** The run's timeout. Absent from older hosts, whose timeout was 5 minutes. */
  timeoutMinutes?: number | null;
  token: string;
  pane: string;
  code: number | null;
  timedOut: boolean;
}

export interface CleanupRemoveItem {
  archiveFailure?: string;
  projectPath: string;
  path: string;
  token: string;
  /** Also delete the conversations of the sessions in it. */
  deleteSessions?: boolean;
  /** Remove it although it holds ignored local files. */
  acceptIgnored?: boolean;
  /** What the review measured it at. When given it is not measured again, and the result reports this as an estimate. */
  estimatedBytes?: number;
}

export interface CleanupResult {
  archiveFailure?: ArchiveFailure;
  projectPath: string;
  path: string;
  outcome: "removed" | "alreadyRemoved" | "skipped" | "failed";
  reason: string | null;
  freedBytes: number;
  /** `freedBytes` is the review's estimate, not a measurement made just before the removal. Absent from an older host, which always measures. */
  freedEstimated?: boolean;
  keptBranch: string | null;
  sessionsKept: string[];
  sessionsDeleted: string[];
}

/** What a removal is doing to the worktree it is on. */
export type CleanupStep = "measuring" | "checking" | "archiving" | "removing" | "sessions";

/**
 * How far one removal call is, as its host reports it while it runs
 * (`cleanup.progress` from a runtime, `worktree_cleanup_progress` from the
 * desktop). `index` counts from 0 over the `total` worktrees of that call. A
 * worktree that was not attempted is only ever `finished`. The call's answer
 * is what happened; this is how it gets there.
 */
export type CleanupProgress =
  | { kind: "started"; index: number; total: number; projectPath: string; path: string }
  | { kind: "step"; index: number; total: number; path: string; step: CleanupStep }
  | { kind: "finished"; index: number; total: number; result: CleanupResult };

/**
 * A session in the runtime's own index (`session.list`, `session.sessions`).
 * `cwd` and `projectPath` are paths on the VM: never hand them to a local command.
 */
export interface RuntimeSession {
  /** The machine project it belongs to (`machine/1`, docs/MACHINES.md "Project scoping"); absent elsewhere. */
  projectId?: string | null;
  rowStatus?: import("./sessionStatus").SessionStatusInput;
  manualStatus?: import("./manualStatus").ManualStatus;
  automation?: { id: string } | null;
  id: string;
  projectPath: string;
  cwd: string;
  /** Machine fs/1 path of the checkout. Null means unavailable. */
  fileRoot?: string | null;
  /** Exact Git checkout for fileRoot. Null for a folder or unavailable checkout, absent on older runtimes. */
  fileRepository?: string | null;
  worktreeName?: string | null;
  /** The ref used when the runtime cut the worktree. */
  worktreeBase?: { from?: string | null } | null;
  branch?: string | null;
  title: string;
  created: string;
  modified: string;
  /** Latest verified user/assistant message time; absent for unverified history. */
  lastMessageAt?: string | null;
  hasMessages?: boolean;
  archived: boolean;
  pinned: boolean;
  tabs: RuntimeSessionTab[];
  activeTab?: string | null;
  /** The issue it was started from (`pipeline/1` runtimes). */
  issue?: RuntimeIssueRef | null;
}

/** A project on a paired machine (`machine.projects`, `machine.changed`; docs/MACHINES.md "machine/1"). */
export interface MachineProject {
  /** Derived from the project's path on the machine: 16 base64url characters, no `:` or `/`. */
  projectId: string;
  name: string;
  /** A path on the machine: display only, never a local path. */
  path: string;
  kind: "git" | "folder" | string;
  defaultBranch: string | null;
  archived: boolean;
}

/** `session.update`: `undefined` leaves a field as it is. Archiving only hides the session. */
export interface RuntimeSessionPatch {
  manualStatus?: import("./manualStatus").ManualStatus;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

/** One model of an agent (`runtime.agents`). */
export interface RuntimeAgentModel {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  acceptsImages: boolean;
  isDefault: boolean;
  upgrade: string | null;
  description: string | null;
  /** A family alias (`opus`): it follows the latest release rather than staying on one version. */
  alias?: boolean;
  /** The full model id an alias runs now, per the runtime's own CLI. */
  resolved?: string | null;
}

/**
 * Whether an agent's own login on the runtime's computer is in place
 * (PRO-350): `unknown` when its CLI could not tell. A login is evidence of
 * configuration, not of provider access.
 */
export type RuntimeAgentSignIn = "signedIn" | "signedOut" | "unknown";

/** An agent installed on the runtime (`runtime.agents`, `agents/1`). */
export interface RuntimeAgent {
  id: string;
  name: string;
  caps: Record<string, boolean>;
  models: RuntimeAgentModel[];
  /** Launch modes it takes; empty when it has none. */
  modes: string[];
  defaultMode: string;
  /** Its CLI's version (PRO-350); null when it did not say, absent from an older runtime. */
  version?: string | null;
  /** Its login on that computer (PRO-350); absent from an older runtime, which shows the agent without a state. */
  signIn?: RuntimeAgentSignIn;
  /** When `signIn` was read, ms since the epoch (PRO-350). */
  signInCheckedAt?: number;
}

/** An agent the runtime knows and has no CLI for (`runtime.agents`, PRO-350). */
export interface RuntimeMissingAgent {
  id: string;
  name: string;
  /** Whether `machine.agentSetup` can install it there (its provider has an official installer). */
  installable: boolean;
}

/** `runtime.agents` in full (PRO-350). `missing` is null from an older runtime, which does not list them. */
export interface RuntimeAgentsReport {
  agents: RuntimeAgent[];
  missing: RuntimeMissingAgent[] | null;
}

/** A folder `machine.browse` lists (`machine/6`): a name and where it is, never what it holds. */
export interface MachineFolder {
  name: string;
  /** Absolute, on the machine: display only, never a local path. */
  path: string;
  /** Set for a Git repository: its branch from `HEAD` (null when detached), and whether `origin` is on github.com. */
  git: { branch: string | null; github: boolean } | null;
  /** Set when the folder already is a project of the machine (archived ones too). */
  projectId: string | null;
}

/** `machine.browse` (`machine/6`): the folders directly inside `path`, under the runtime user's home. */
export interface MachineFolderListing {
  home: string;
  path: string;
  /** The folder above `path`; null at `home`. */
  parent: string | null;
  entries: MachineFolder[];
  /** Some folders were left out: at most 500 are listed. */
  truncated: boolean;
}

/** A clone on a machine (`machine/6`), from `machine.cloneProject`, `machine.cloneStatus` or `machine.cloneCancel`. */
export interface MachineClone {
  cloneId: string;
  repository: string;
  /** Where it lands on the machine: `<parent>/<name>`. */
  path: string;
  state: "cloning" | "done" | "failed" | "canceled";
  /** Git's progress while cloning (`Receiving objects`), as it names it. */
  stage: string | null;
  percent: number | null;
  /** The project it was added as, once `done`. */
  project: MachineProject | null;
  /** Why it failed: the local clone's codes (`access-denied`, `destination-exists`, `network`, …). */
  error: { code: string; message: string } | null;
}

/** A step of an agent's setup on a machine (`machine/4`), as on this Mac (`src/lib/agentSetupFlow.ts`). */
export type MachineAgentSetupStep = "install" | "login";

/** The setup step of an agent running on the machine now (`machine.agentSetupRunning`). */
export interface MachineAgentSetupRun {
  ptyId: string;
  step: MachineAgentSetupStep;
}

/** `session.status`: a subscribed tab's turn or process state changed. */
export interface AgentTabStatusChange {
  sessionId: string;
  tabId: string;
  status: AgentTabStatus;
  /** Not sent by the runtime with a status change (it arrives with `session.tabs`). */
  process?: AgentProcessState;
}

export interface SessionSubscribeOptions {
  /** Resume after this cursor instead of replaying the whole transcript. */
  sinceCursor?: string;
  /** The cursor after each event or replay, to keep for the next subscription. */
  onCursor?(cursor: string | undefined): void;
  onStatus?(change: AgentTabStatusChange): void;
  /**
   * The runtime's replay was handed to `onEvent`: everything its history
   * holds after the cursor is here now. Again after each resume (a
   * reconnect, a new runtime generation).
   */
  onReplayed?(): void;
}

/** A terminal as `pty.create`, `pty.list` and `pty.attach` describe it. */
export interface PtyInfo {
  ptyId: string;
  number: number;
  /** The runtime process the terminal runs in. */
  epoch: string;
  pid: number | null;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** Bytes the terminal has written so far. */
  offset: number;
  exited: boolean;
  exitCode: number | null;
  control: PtyControl;
  /** The person controlling the terminal (PRO-30); null when nobody does, absent from older runtimes. */
  controllerId?: string | null;
  /** The session the terminal was opened for (`pty/2`); absent otherwise and from older runtimes. */
  sessionId?: string;
  /** An agent tab's own terminal (`agent-pty/1`): the tab, and whether its CLI runs now. */
  tabId?: string;
  running?: boolean;
  /** An agent's install or sign-in (`machine/4`); such a terminal is never in `pty.list`. */
  setup?: { harness: string; step: MachineAgentSetupStep };
  /** One of its session's script runs on a machine (`machine/7`): a saved action, or the workspace's setup. */
  run?: PtyRun;
}

/** What a session's script-run terminal is (`machine/7`). */
export type PtyRun = { kind: "action"; actionId: string; name: string } | { kind: "setup" };

/** A saved action as a machine's project has it (`machine/7`). */
export interface MachineAction {
  id: string;
  name: string;
  icon: string;
  command: string;
  runAfterSetup: boolean;
  concurrent: boolean;
  hidden: boolean;
}

/** A workspace setup attempt on a machine (`machine/7`); its pane is the terminal `pty.list` lists with `run.kind` "setup" while it is kept. */
export interface MachineSetupRun {
  paneId: string;
  command: string;
  status: "pending" | "running" | "stopping" | "stopped" | "succeeded" | "failed";
  exitCode: number | null;
  error: string | null;
  hasPane: boolean;
}

/** `machine.sessionActions`: what a machine session's Run menu, Open button and Setup and Run tabs show, read on the machine. */
export interface MachineSessionActions {
  actions: MachineAction[];
  previewUrls: { id: string; name: string; url: string }[];
  /** The setup script the machine would run now; null when none is saved there. */
  setupScript: string | null;
  /** The session has a workspace checkout of its own, where setup runs. */
  setupApplies: boolean;
  /** False once its worktree is removed: nothing can run in it. */
  available: boolean;
  /** What $PORT and $PORT_1..$PORT_9 are on the machine; null when not known. */
  ports: number[] | null;
  setup: MachineSetupRun | null;
}

/** `machine.runAction`: the run started, or (`started` false) the running one of a non-concurrent action. */
export interface MachineActionOutcome {
  started: boolean;
  run: { actionId: string; name: string; ptyId: string; state: "running" | "exited"; exitCode: number | null };
  /** The run's terminal as `pty.list` lists it. */
  terminal: PtyInfo | null;
}

/** Where a terminal view left off, to resume without replaying what it shows. */
export interface PtyCursor {
  offset: number;
  epoch: string;
}

export interface PtyHandlers {
  /**
   * `replay`: the bytes were written before this attach (the ring's replay,
   * or what was missed while away). A terminal emulator must not answer the
   * queries it finds in them: the program that asked is long past them.
   */
  onData(bytes: Uint8Array, offset: number, replay: boolean, size?: { cols: number; rows: number }): void;
  onExit?(code: number | null): void;
  onControl?(control: PtyControl, controllerId?: string | null): void;
  /** The controller resized the terminal; a viewer should match it. */
  onResize?(cols: number, rows: number): void;
  /** Output older than the runtime's ring was lost while away. */
  onTruncated?(): void;
  /** The terminal is gone: closed, or its runtime restarted or was replaced. */
  onGone?(reason: "closed" | "runtime-restarted"): void;
  /** Resume after this point instead of replaying the whole ring. */
  since?: PtyCursor;
}

export interface PtyAttachment {
  /** Where the view is now; keep it to resume on a later connection. */
  cursor(): PtyCursor | undefined;
  detach(): void;
}

/** UTF-16 units per `pty.write`; at most 4 UTF-8 bytes each keeps it under the runtime's 64 KiB. */
const WRITE_CHUNK = 16 * 1024;
const BACKPRESSURE_RETRY_MS = 200;

/** Frames in and out of one supervised connection (the desktop's Rust supervisor). */
export interface WorkspaceTransport {
  send(frame: RpcWireRequest): boolean;
  onMessage(listener: (message: unknown) => void): () => void;
  onState(listener: (state: WorkspaceConnectionState) => void): () => void;
  close(): void;
}

export interface WorkspaceNotification {
  event: string;
  params: Record<string, unknown> & { subscriptionId?: string };
}

export class WorkspaceRpcError extends Error {
  constructor(readonly code: string, message: string, readonly method: string, readonly data?: unknown) {
    super(message);
  }
}

type Subscription = {
  method: "pty.attach" | "session.subscribe" | "fs.watch";
  /** Re-sent on reconnect, with the resume point updated. */
  params: Record<string, unknown>;
  listener: (notification: WorkspaceNotification) => void;
  onReplay?: (result: Record<string, unknown>) => void;
  serverId?: string;
};

class PtyInput {
  writerId = randomRequestId();
  /** Last seq the runtime accepted from this writer. */
  seq = 0;
  running = false;
  pending: { data: string; report: boolean; resolve: () => void; reject: (error: unknown) => void }[] = [];

  reset(): void {
    this.writerId = randomRequestId();
    this.seq = 0;
  }
}

const RESEND_WAIT_MS = 15_000;

export class WorkspaceRpcClient {
  private readonly rpc: PortableRpcClient;
  private readonly responseListeners = new Set<(response: RpcResponse) => void>();
  private readonly stateListeners = new Set<(state: WorkspaceConnectionState) => void>();
  private readonly notificationListeners = new Set<(notification: WorkspaceNotification) => void>();
  private readonly detach: (() => void)[] = [];
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly inputs = new Map<string, PtyInput>();
  /** Notifications for a subscription whose id is not known yet (its answer is still being handled). */
  private unrouted: WorkspaceNotification[] = [];
  /** Subscribe requests awaiting their answer. */
  private resuming = 0;
  /** The runtime process each known terminal belongs to. */
  private readonly ptyEpochs = new Map<string, string>();
  private state: WorkspaceConnectionState = { state: "idle" };
  private nextLocal = 0;
  private closed = false;
  private readonly dropWaiters = new Set<() => void>();
  /** One view per project, so a project's client keeps its identity across renders. */
  private readonly projectViews = new Map<string, WorkspaceRpcClient>();

  constructor(private readonly transport: WorkspaceTransport, private readonly newRequestId: () => string = randomRequestId, timeoutMs = 30_000) {
    this.rpc = new PortableRpcClient(
      {
        send: (request) => transport.send(request),
        subscribe: (listener) => {
          this.responseListeners.add(listener);
          return () => this.responseListeners.delete(listener);
        },
      },
      timeoutMs,
    );
    this.detach.push(transport.onMessage((message) => this.receive(message)));
    this.detach.push(transport.onState((state) => this.changeState(state)));
  }

  get connection(): WorkspaceConnectionState {
    return this.state;
  }

  /**
   * This connection as one project of a machine sees it (`machine/1`,
   * docs/MACHINES.md "Project scoping"): every `fs.*` and `git.*` call, a
   * file watch and a terminal opened outside a session carry `projectId`.
   * Everything else (sessions, tabs, terminals, ports) is the machine's and
   * goes as it is. The same object for the same project, so it can be a
   * React dependency. A call that already names a project keeps it.
   */
  forProject(projectId: string): WorkspaceRpcClient {
    const known = this.projectViews.get(projectId);
    if (known) return known;
    const scoped = (method: string, params: Record<string, unknown> = {}) =>
      PROJECT_SCOPED.test(method) && params.projectId === undefined ? { ...params, projectId } : params;
    const view = new Proxy(this, {
      get: (target, property) => {
        if (property === "call") return <T>(method: string, params?: Record<string, unknown>) => target.call<T>(method, scoped(method, params));
        if (property === "mutate") return <T>(method: string, params: Record<string, unknown>, id?: string) => target.mutate<T>(method, scoped(method, params), id);
        if (property === "watchFiles") return (path: string, onChange: (paths: string[] | null) => void) => target.watchFiles(path, onChange, { projectId });
        if (property === "createPty")
          return (params: Parameters<WorkspaceRpcClient["createPty"]>[0]) => target.createPty(params.sessionId === undefined && params.projectId === undefined ? { ...params, projectId } : params);
        if (property === "forProject") return (other: string) => target.forProject(other);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.projectViews.set(projectId, view);
    return view;
  }

  get generation(): number | null {
    return this.state.state === "connected" ? this.state.runtimeGeneration : null;
  }

  onState(listener: (state: WorkspaceConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  /** A read, or a mutation with an explicit `clientRequestId`. */
  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertGranted(method);
    if (MUTATING_METHODS.has(method) && typeof params.clientRequestId !== "string") {
      return this.mutate<T>(method, params);
    }
    const result = await this.rpc.request<T>(method, params);
    return unwrap(method, result);
  }

  /**
   * A mutation. The id is fixed before the first send, so a resend after a
   * dropped connection is the same request to the runtime.
   */
  async mutate<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, clientRequestId = this.newRequestId()): Promise<T> {
    this.assertGranted(method);
    const request = { ...params, clientRequestId };
    return this.resending(() => this.untilDropped(this.rpc.request<T>(method, request)).then((result) => unwrap(method, result)));
  }

  /**
   * Terminal input. Queued per terminal and sent one numbered write at a
   * time, so it is typed once and in order even across reconnects. Resolves
   * once the runtime accepted it; rejects (never silently drops) when the
   * runtime refuses it, e.g. `not_controller`, an exited terminal, or one
   * whose runtime restarted.
   */
  write(ptyId: string, data: string, options: { report?: boolean } = {}): Promise<void> {
    let input = this.inputs.get(ptyId);
    if (!input) this.inputs.set(ptyId, (input = new PtyInput()));
    // `report`: bytes the terminal emulator produced by itself (a focus
    // report, the answer to a query), not typed by a person. The runtime
    // delivers the controller's, and counts them neither as use of the
    // workspace nor as driving an agent tab.
    const report = options.report === true;
    return new Promise<void>((resolve, reject) => {
      input.pending.push({ data, report, resolve, reject });
      if (!input.running) void this.pumpInput(ptyId, input);
    });
  }

  private async pumpInput(ptyId: string, input: PtyInput): Promise<void> {
    input.running = true;
    try {
      while (input.pending.length && !this.closed) {
        // One write carries input of one kind: what was typed is never sent as a report, nor the other way round.
        const report = input.pending[0]!.report;
        const run = input.pending.findIndex((entry) => entry.report !== report);
        const batch = input.pending.splice(0, run < 0 ? input.pending.length : run);
        try {
          const text = batch.map((entry) => entry.data).join("");
          for (let start = 0; start < text.length; ) {
            let end = Math.min(text.length, start + WRITE_CHUNK);
            // Never split a surrogate pair across two writes.
            if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
            await this.sendInput(ptyId, input, text.slice(start, end), report);
            start = end;
          }
          for (const entry of batch) entry.resolve();
        } catch (error) {
          // Input typed after a refusal was meant for the same state; report it too.
          for (const entry of [...batch, ...input.pending.splice(0)]) entry.reject(error);
        }
      }
    } finally {
      input.running = false;
    }
  }

  private async sendInput(ptyId: string, input: PtyInput, data: string, report: boolean): Promise<void> {
    let seq = input.seq + 1;
    /** This input was started over under a new writer once already. */
    let restarted = false;
    for (;;) {
      const epoch = this.ptyEpochs.get(ptyId);
      if (epoch && this.state.state === "connected" && this.state.runtimeEpoch && this.state.runtimeEpoch !== epoch) {
        throw new WorkspaceRpcError("not_found", "the terminal's runtime restarted", "pty.write");
      }
      /** How many times this write went out: more than once means an earlier copy may have been applied. */
      let sends = 0;
      try {
        const params = { ptyId, data, seq, writerId: input.writerId, ...(epoch ? { epoch } : {}), ...(report ? { report: true } : {}) };
        await this.resending(() => {
          sends++;
          return this.untilDropped(this.rpc.request("pty.write", params)).then((value) => unwrap("pty.write", value));
        });
        input.seq = seq;
        return;
      } catch (error) {
        if (error instanceof WorkspaceRpcError && error.code === "backpressure" && !this.closed) {
          // The program is not reading yet: the runtime kept nothing, try the same seq again.
          await new Promise((resolve) => setTimeout(resolve, BACKPRESSURE_RETRY_MS));
          continue;
        }
        if (error instanceof WorkspaceRpcError && error.code === "conflict" && !this.closed) {
          // The runtime does not know this writer at this number. A workspace
          // that stopped and woke gives this client a new device, and the
          // runtime counts each writer per device. This writer can never be
          // right again, so later input goes under a new one, from 1.
          input.reset();
          // This write was refused, so it was not applied. Sent once, that is
          // certain and it is typed under the new writer. Resent after a
          // drop, an earlier copy may have landed: it is reported, never
          // typed a second time.
          if (sends === 1 && !restarted) {
            restarted = true;
            seq = 1;
            continue;
          }
        }
        if (!(error instanceof WorkspaceRpcError)) {
          // Unknown whether it landed; a fresh writer keeps later input from
          // being held behind (or merged with) it.
          input.reset();
        }
        throw error;
      }
    }
  }

  /** `sessionId` needs `pty/2`; an older runtime would open a terminal that belongs to no session. */
  async createPty(params: { cols: number; rows: number; cwd?: string; sessionId?: string; projectId?: string }): Promise<PtyInfo> {
    if (params.sessionId !== undefined) this.assertCapability("pty/2", "pty.create");
    const info = await this.mutate<PtyInfo>("pty.create", params);
    this.ptyEpochs.set(info.ptyId, info.epoch);
    return info;
  }

  /**
   * The workspace's listening ports and this connection's open streams
   * (`ports/1`, docs/CLOUD-PREVIEWS.md). `detected: false` where the runtime
   * cannot tell which ports listen. Refused unless the person may open a
   * port: a manager, or a driver who may approve.
   */
  async listPorts(): Promise<{ detected: boolean; ports: ListedPort[]; streams: { streamId: string; port: number }[] }> {
    const listed = await this.call<{ detected?: unknown; ports?: unknown; streams?: unknown }>("ports.list");
    // The runtime is not trusted for the shape: whole port numbers only, and a bounded list.
    const port = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null);
    const entries = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object") : []);
    // One entry per port; the first entry that names a process for it stands.
    const byPort = new Map<number, ListedPort>();
    for (const entry of entries(listed.ports)) {
      const value = port(entry.port);
      if (value === null) continue;
      const process = listedProcess(entry.process);
      const known = byPort.get(value);
      if (!known) byPort.set(value, process ? { port: value, process } : { port: value });
      else if (!known.process && process) known.process = process;
    }
    const ports = [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, MAX_LISTED_PORTS);
    const streams = entries(listed.streams)
      .flatMap((entry) => {
        const value = port(entry.port);
        return typeof entry.streamId === "string" && value !== null ? [{ streamId: entry.streamId, port: value }] : [];
      })
      .slice(0, MAX_LISTED_PORTS);
    return { detected: listed.detected === true, ports, streams };
  }

  async listPtys(): Promise<{ epoch: string; terminals: PtyInfo[] }> {
    const listed = await this.call<{ epoch: string; terminals: PtyInfo[] }>("pty.list");
    for (const info of listed.terminals) this.ptyEpochs.set(info.ptyId, info.epoch);
    return listed;
  }

  /** Only the controller's size is applied; a viewer gets `not_controller`. */
  resizePty(ptyId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    return this.call("pty.resize", this.withEpoch(ptyId, { ptyId, cols, rows }));
  }

  /**
   * Take over a terminal's input and size explicitly, at this view's size.
   * `start` (an agent tab's terminal only) also starts the tab's CLI when it
   * is not running; without it nothing is ever started.
   */
  controlPty(ptyId: string, cols?: number, rows?: number, options: { start?: boolean } = {}): Promise<PtyInfo> {
    return this.call<PtyInfo>("pty.control", this.withEpoch(ptyId, { ptyId, ...(cols && rows ? { cols, rows } : {}), ...(options.start ? { start: true } : {}) }));
  }

  async killPty(ptyId: string): Promise<void> {
    await this.call("pty.kill", this.withEpoch(ptyId, { ptyId }));
    this.forgetPty(ptyId);
  }

  private withEpoch(ptyId: string, params: Record<string, unknown>): Record<string, unknown> {
    const epoch = this.ptyEpochs.get(ptyId);
    return epoch ? { ...params, epoch } : params;
  }

  private forgetPty(ptyId: string): void {
    this.ptyEpochs.delete(ptyId);
    this.inputs.delete(ptyId);
  }

  /**
   * Send, and if the connection drops before the answer, send the same
   * request again once it is back. A refusal from the runtime is final.
   */
  private async resending<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof WorkspaceRpcError || this.closed || tries >= 5) throw error;
        await this.connected(RESEND_WAIT_MS);
      }
    }
  }

  /** Reject as soon as the connection drops, instead of waiting for the timeout. */
  private untilDropped<T>(request: Promise<T>): Promise<T> {
    if (this.state.state !== "connected") return request;
    return new Promise<T>((resolve, reject) => {
      const dropped = () => reject(new Error("Workspace connection dropped"));
      this.dropWaiters.add(dropped);
      request.then(resolve, reject).finally(() => this.dropWaiters.delete(dropped));
    });
  }

  /**
   * Stream a terminal: replay from the runtime's ring (after `since`, when
   * given), then live output, resuming from the last byte seen after every
   * reconnect or `pty.lagged`. A terminal whose runtime process is no longer
   * the connected one is reported gone, never re-attached by id elsewhere.
   */
  async attachPty(ptyId: string, handlers: PtyHandlers): Promise<PtyAttachment> {
    let cursor: PtyCursor | undefined = handlers.since;
    if (cursor && !this.ptyEpochs.has(ptyId)) this.ptyEpochs.set(ptyId, cursor.epoch);
    let gone = false;
    /** Output before this offset was written before the attach. */
    let replayUntil = 0;
    const markGone = (reason: "closed" | "runtime-restarted") => {
      if (gone) return;
      gone = true;
      this.forgetPty(ptyId);
      handlers.onGone?.(reason);
    };
    const emit = (dataB64: string, offset: number, size?: { cols: number; rows: number }) => {
      const bytes = decodeBase64(dataB64);
      // Replay and live output can overlap by a chunk around a reconnect.
      const skip = cursor === undefined ? 0 : Math.max(0, cursor.offset - offset);
      // A zero-byte sized batch completes a resize at this stream position.
      // It changes no byte cursor and must not be dropped as duplicate data.
      if (skip < bytes.length || (size && bytes.length === 0 && offset >= (cursor?.offset ?? 0))) {
        const args = [bytes.subarray(skip), offset + skip, offset + skip < replayUntil] as const;
        if (size) handlers.onData(...args, size);
        else handlers.onData(...args);
      }
      cursor = { offset: bytes.length ? Math.max(cursor?.offset ?? 0, offset + bytes.length) : cursor?.offset ?? 0, epoch: this.ptyEpochs.get(ptyId) ?? cursor?.epoch ?? "" };
    };
    const stop = await this.subscribe({
      method: "pty.attach",
      params: { ptyId },
      resumeParams: () => {
        const epoch = this.ptyEpochs.get(ptyId);
        return cursor === undefined || !epoch || this.generation === null
          ? {}
          : { sinceOffset: cursor.offset, runtimeGeneration: this.generation, epoch };
      },
      beforeResume: () => {
        if (gone) return false;
        const epoch = this.ptyEpochs.get(ptyId);
        const runtimeEpoch = this.state.state === "connected" ? this.state.runtimeEpoch : undefined;
        if (epoch && runtimeEpoch && epoch !== runtimeEpoch) {
          markGone("runtime-restarted");
          return false;
        }
        return true;
      },
      onRefused: (error) => {
        if (error.code !== "not_found") return false;
        markGone("closed");
        return true;
      },
      onCursorExpired: () => {
        cursor = undefined;
      },
      onReplay: (result) => {
        const info = result as Partial<PtyInfo> & { data?: string; truncated?: boolean; end?: number; replayEnd?: number };
        if (typeof info.epoch === "string") this.ptyEpochs.set(ptyId, info.epoch);
        // An older runtime does not say where the replay ends: then it is the slice in the answer.
        const sliceEnd = Number(info.offset ?? 0) + decodeBase64(String(info.data ?? "")).length;
        replayUntil = Math.max(Number(info.replayEnd ?? 0), Number(info.end ?? 0), sliceEnd);
        if (info.truncated === true) handlers.onTruncated?.();
        emit(String(info.data ?? ""), Number(info.offset ?? 0));
        if (info.control) handlers.onControl?.(info.control, info.controllerId);
        if (info.cols && info.rows) handlers.onResize?.(info.cols, info.rows);
        if (info.exited === true) handlers.onExit?.(info.exitCode ?? null);
      },
      listener: (notification, resubscribe) => {
        const params = notification.params;
        switch (notification.event) {
          case "pty.output":
            emit(String(params.data), Number(params.offset), outputSize(params.size));
            break;
          case "pty.resize-complete":
            emit("", Number(params.offset), outputSize(params.size));
            break;
          case "pty.exit":
            handlers.onExit?.((params.code as number | null | undefined) ?? null);
            break;
          case "pty.control":
            handlers.onControl?.(params.control as PtyControl, params.controllerId as string | null | undefined);
            break;
          case "pty.resized":
            handlers.onResize?.(Number(params.cols), Number(params.rows));
            break;
          case "pty.closed":
            // Closed by another client, or dropped from the exited-terminal limit.
            markGone("closed");
            break;
          case "pty.lagged":
            // The runtime ended this stream because the link fell behind;
            // pick it up again from the last byte shown.
            resubscribe();
            break;
        }
      },
    });
    return { cursor: () => cursor, detach: stop };
  }

  /** An agent tab's events, replayed after the last cursor seen. */
  subscribeSession(sessionId: string, tabId: string, onEvent: (event: unknown) => void, options: SessionSubscribeOptions = {}): Promise<() => void> {
    let cursor: string | undefined = options.sinceCursor;
    const moved = (next: string | undefined) => {
      cursor = next;
      options.onCursor?.(next);
    };
    return this.subscribe({
      method: "session.subscribe",
      params: { sessionId, tabId },
      resumeParams: () => (cursor ? { sinceCursor: cursor } : {}),
      onReplay: (result) => {
        for (const entry of (result.events as { cursor: string; event: unknown }[] | undefined) ?? []) onEvent(entry.event);
        if (typeof result.cursor === "string") moved(result.cursor);
        options.onReplayed?.();
      },
      listener: (notification) => {
        if (notification.event === "session.status") {
          const params = notification.params as unknown as AgentTabStatusChange;
          options.onStatus?.({ sessionId: params.sessionId, tabId: params.tabId, status: params.status, process: params.process });
          return;
        }
        if (notification.event !== "session.event") return;
        moved(String(notification.params.cursor));
        onEvent(notification.params.event);
      },
      // Another runtime generation: the snapshot that follows starts over.
      onCursorExpired: () => moved(undefined),
    });
  }

  /** Every agent tab on the runtime, with its turn and process state. */
  async listAgentTabs(): Promise<AgentTabInfo[]> {
    const result = await this.call<{ tabs?: AgentTabInfo[] }>("session.tabs");
    return result.tabs ?? [];
  }

  /**
   * A new agent tab: one session with one agent process. `useWorktree` gives
   * the session its own worktree on the VM; `prompt` is sent as its first
   * message (both from `session/1`, read by the runtime's `session_ops`).
   * With `pipeline/1` it may be started from an issue: the worktree is named
   * after it (`worktreeName`), and unless `pipeline` is false the runtime
   * carries it on to a pull request and a review, adding its brief to the
   * prompt. `issueBody` is the issue as read here, for the reviewer.
   * If the first send fails, creation still returns the openable session:
   * `startError` explains the failure, also recorded in the tab's transcript.
   */
  createAgentTab(params: {
    agent: string;
    model?: string;
    effort?: string | null;
    mode?: string;
    title?: string;
    prompt?: string;
    useWorktree?: boolean;
    /** `session-repository/1`: advertised checkout, verified by the runtime before session creation. */
    repository?: { identity: string; directory: string };
    issue?: RuntimeIssueRef;
    issueBody?: string | null;
    pipeline?: boolean;
    pipelineOptions?: { autoMerge: boolean; resolveConflicts: boolean };
    pipelineSettings?: Record<string, unknown>;
    worktreeName?: string | null;
    /** The desktop's Native Codex setting (#644): a Codex tab goes through Codex's app server where it can. An older runtime ignores it. */
    nativeCodex?: boolean;
    /** `machine/1`: the machine project the session is created in (docs/MACHINES.md "Project scoping"); a machine refuses a session without one. */
    projectId?: string;
    /** `session-base/1` (PRO-348): the branch the new worktree is cut from; the project's default branch without it. */
    baseRef?: string | null;
    /**
     * The create's idempotency id, when the caller keeps it: pressing Create
     * again after the connection gave up is then the same request, and the
     * runtime answers it with the session it already made (PRO-348).
     */
    clientRequestId?: string;
  }): Promise<{ sessionId: string; tabId: string; tab?: AgentTabInfo; session?: RuntimeSession; pipeline?: RuntimeIssuePipeline | null; pipelineNote?: string | null; startError?: string | null }> {
    if (params.repository && !this.hasCapability("session-repository/1")) throw new Error("cloud_repository_session_runtime_update_required");
    if (params.baseRef && !this.hasCapability("session-base/1")) throw new WorkspaceRpcError("capability_not_granted", "This runtime cannot start a session from another branch.", "session.create");
    const { clientRequestId, ...rest } = params;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    return this.mutate("session.create", defined, clientRequestId);
  }

  /** A fresh idempotency id for a mutation whose caller keeps it across attempts (`createAgentTab`). */
  requestId(): string {
    return this.newRequestId();
  }

  /** Stop a tab's agent process; `remove` also drops the tab and its checkpoints. */
  closeAgentTab(sessionId: string, tabId?: string, remove = false): Promise<{ sessionId: string }> {
    return this.mutate("session.close", { sessionId, ...(tabId ? { tabId } : {}), ...(remove ? { remove: true } : {}) });
  }

  async configureAgentTab(params: { sessionId: string; tabId: string; model?: string; effort?: string | null; mode?: string }): Promise<AgentTabInfo> {
    const result = await this.mutate<{ tab: AgentTabInfo }>("session.configure", params);
    return result.tab;
  }

  async markAgentTabRead(sessionId: string, tabId: string): Promise<void> {
    await this.call("session.markRead", { sessionId, tabId });
  }

  /**
   * Escape for a tab's running turn (`session/3`): the turn is interrupted
   * and the agent's process stays. A plain call, sent once: if the connection
   * drops it is not sent again, because by then it could reach a later turn.
   * `interrupted` is false when the tab had nothing running.
   */
  async interruptAgentTab(params: { sessionId: string; tabId: string }): Promise<{ interrupted: boolean }> {
    const result = await this.call<{ interrupted?: boolean }>("session.interrupt", params);
    return { interrupted: result.interrupted === true };
  }

  /**
   * Native Codex's terminal view (#644): move the tab to Codex's own terminal
   * on the same thread, for good, and start it there. The runtime refuses it
   * to anyone who may not start the agent's terminal. Only a caller that
   * handles waitingForTurn and polls again may opt into deferred completion.
   */
  moveAgentTabToTerminal(sessionId: string, tabId: string, options: { transitionId?: string; deferUntilIdle?: boolean } = {}): Promise<{ sessionId: string; tabId: string; waitingForTurn?: boolean }> {
    return this.mutate("session.toTerminal", { sessionId, tabId, ...options });
  }

  /** A machine's projects (`machine/1`). */
  async machineProjects(): Promise<MachineProject[]> {
    const result = await this.call<{ projects?: MachineProject[] }>("machine.projects");
    return Array.isArray(result.projects) ? result.projects : [];
  }

  /** `machine.changed`: the machine's name or project set changed; `projects` is the whole new list when sent. */
  onMachineChanged(listener: (change: { projects: MachineProject[] | null }) => void): () => void {
    return this.onNotification((notification) => {
      if (notification.event !== "machine.changed") return;
      const projects = (notification.params as { projects?: unknown }).projects;
      listener({ projects: Array.isArray(projects) ? (projects as MachineProject[]) : null });
    });
  }

  /** The sessions this connection may see (`session.list`). */
  async listSessions(): Promise<RuntimeSession[]> {
    const result = await this.call<{ sessions?: RuntimeSession[] }>("session.list");
    return result.sessions ?? [];
  }

  /** Rename, pin or archive a session (`session/2`, manage only). */
  async updateSession(sessionId: string, patch: RuntimeSessionPatch): Promise<RuntimeSession> {
    if (patch.manualStatus !== undefined) this.assertCapability("session-status/1", "session.update");
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const result = await this.mutate<{ session: RuntimeSession }>("session.update", { sessionId, ...defined });
    return result.session;
  }

  /** Another agent tab in an existing session (`session/2`, manage only). */
  addSessionTab(
    sessionId: string,
    params: { agent: string; model?: string; effort?: string | null; mode?: string; nativeCodex?: boolean },
  ): Promise<{ sessionId: string; tabId: string; session: RuntimeSession; tab?: AgentTabInfo | null }> {
    const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    return this.mutate("session.addTab", { sessionId, ...defined });
  }

  /** `session.usage` (`machine/8`): the session's usage, read again on the machine. */
  sessionUsage(sessionId: string): Promise<RuntimeSessionUsage> {
    this.assertCapability("machine/8", "session.usage");
    return this.call("session.usage", { sessionId });
  }

  /** `session.prepareContinuation` (`machine/8`): a tab's context for Continue in a new tab, with the machine's own paths. */
  prepareContinuation(sessionId: string, tabId: string): Promise<import("./continuation").ContinuationContext> {
    this.assertCapability("machine/8", "session.prepareContinuation");
    return this.call("session.prepareContinuation", { sessionId, tabId });
  }

  /** `session.checkFailures` (`machine/8`, manage only): a pull request's failed check logs, saved on the machine for the tab's agent to read. */
  checkFailures(sessionId: string, tabId: string, prUrl: string): Promise<{ path: string; truncated: boolean }> {
    this.assertCapability("machine/8", "session.checkFailures");
    return this.call("session.checkFailures", { sessionId, tabId, prUrl });
  }

  /**
   * `session.delete`: delete one session and its transcripts (`session/2`).
   * With `removeWorktree`, its worktree goes too when no other session runs
   * in it; a runtime that enforces the clean-and-merged check refuses one
   * that is not safe unless `confirmedUnsafe` says the person confirmed a
   * second time. `deleted` names every session that went; `worktreeKept` is
   * set when the worktree stayed because other sessions use it.
   */
  deleteSession(
    sessionId: string,
    options: { removeWorktree?: boolean; confirmedUnsafe?: boolean } = {},
  ): Promise<{ sessionId: string; deleted: string[]; keptBranch?: string | null; worktreeKept?: boolean }> {
    return this.mutate("session.delete", {
      sessionId,
      ...(options.removeWorktree ? { removeWorktree: true } : {}),
      ...(options.confirmedUnsafe ? { confirmedUnsafe: true } : {}),
    });
  }

  /** `cleanup.scan`: the workspace's worktrees with what the clean-up may do with each (`cleanup/1`, manage only). Reads only. */
  async scanCleanup(): Promise<CleanupProject[]> {
    const result = await this.call<{ projects?: CleanupProject[] }>("cleanup.scan");
    return result.projects ?? [];
  }

  /** `cleanup.size`: what removing one worktree would free; null when cancelled. */
  async cleanupSize(job: string, projectPath: string, path: string): Promise<number | null> {
    const result = await this.call<{ bytes?: number | null }>("cleanup.size", { job, projectPath, path });
    return typeof result.bytes === "number" ? result.bytes : null;
  }

  /** `cleanup.cancel`: stop this connection's size estimates. */
  async cancelCleanupSizes(): Promise<void> {
    await this.call("cleanup.cancel", {});
  }

  /**
   * `cleanup.remove`: remove the named worktrees. The runtime inspects each
   * again and leaves alone whatever is not what its token stands for.
   *
   * `onProgress` hears the `cleanup.progress` notifications of this request
   * while it runs. An older runtime sends none, and neither does a resend
   * that is answered from what was already done: the answer never depends
   * on them.
   */
  async removeCleanup(items: CleanupRemoveItem[], onProgress?: (progress: CleanupProgress) => void): Promise<CleanupResult[]> {
    const requestId = this.newRequestId();
    const stop = onProgress
      ? this.onNotification((notification) => {
          if (notification.event !== "cleanup.progress" || notification.params.run !== requestId) return;
          onProgress(notification.params as unknown as CleanupProgress);
        })
      : () => undefined;
    try {
      const result = await this.mutate<{ results?: CleanupResult[] }>("cleanup.remove", { items }, requestId);
      return result.results ?? [];
    } finally {
      stop();
    }
  }

  /**
   * `workspace.disposition`: where the checkout a session runs in stands
   * (`workspace/1`, manage only). `fetch` asks for the clean-and-merged
   * verdict the removal dialog shows; without it the read stays quick. The
   * answer is the desktop's `WorkspaceDisposition`, which this package only carries.
   */
  async workspaceDisposition<T = Record<string, unknown>>(sessionId: string, options: { fetch?: boolean } = {}): Promise<T> {
    const result = await this.call<{ disposition: T }>("workspace.disposition", { sessionId, ...(options.fetch ? { fetch: true } : {}) });
    return result.disposition;
  }

  /**
   * `workspace.remove`: remove the worktree a session runs in, with every
   * session in it. The runtime checks it again and removes one that is not
   * clean and merged only with the digest of the check that was shown.
   */
  async removeSessionWorkspace(sessionId: string, options: { deleteBranch: boolean; confirmedDigest: string | null; expectedSessions: string[] }): Promise<RuntimeWorkspaceRemoved> {
    return this.mutate<RuntimeWorkspaceRemoved>("workspace.remove", { sessionId, ...options });
  }

  /**
   * `workspace.sweepMerged`: one pass of the removal that follows a merged
   * pull request (`workspace/2`, manage only). The runtime says where each
   * such worktree stands, and removes the ones that are safe and whose grace
   * period has run. Calling it is what "on" means for a cloud workspace;
   * `enabled: false` tells the runtime it was turned off, and it then looks
   * at nothing and forgets what it had seen.
   */
  async sweepMergedWorkspaces(options: { enabled?: boolean; deleteSessions: boolean; graceSeconds: number }): Promise<MergedSwept> {
    const result = await this.mutate<Partial<MergedSwept>>("workspace.sweepMerged", { ...options });
    return { statuses: result.statuses ?? [], unreadable: result.unreadable ?? [] };
  }

  /** `workspace.holdMerged`: keep a worktree that is waiting to be removed, or let it go again. */
  async holdMergedWorkspace(path: string, held: boolean): Promise<void> {
    await this.mutate("workspace.holdMerged", { path, held });
  }

  /** `workspace.removedRecords`: what was removed there, newest first. */
  async removedWorkspaceRecords(): Promise<MergedRemovalView[]> {
    const result = await this.call<{ records?: MergedRemovalView[] }>("workspace.removedRecords");
    return result.records ?? [];
  }

  /** `workspace.restoreRemoved`: undo one recorded removal, where it was. */
  async restoreRemovedWorkspace(id: string): Promise<MergedRestored> {
    return this.mutate<MergedRestored>("workspace.restoreRemoved", { id });
  }

  /** The agents installed on the runtime, with their models, efforts and modes (`agents/1`). */
  async listRuntimeAgents(): Promise<RuntimeAgent[]> {
    const result = await this.call<{ agents?: RuntimeAgent[] }>("runtime.agents");
    return result.agents ?? [];
  }

  /**
   * `runtime.agents` with what PRO-350 adds: each agent's version and
   * sign-in, and the agents with no CLI there. `refresh` reads the sign-ins
   * again now, else the runtime answers from a check at most a minute old.
   */
  async runtimeAgentsReport(options: { refresh?: boolean } = {}): Promise<RuntimeAgentsReport> {
    const result = await this.call<{ agents?: RuntimeAgent[]; missing?: RuntimeMissingAgent[] }>("runtime.agents", options.refresh ? { refresh: true } : {});
    return { agents: result.agents ?? [], missing: result.missing ?? null };
  }

  /**
   * `machine/4`: start an agent's install or sign-in in a terminal on the
   * machine (PRO-350). The command is the runtime's own; the terminal is
   * attached and typed into as any other (`attachPty`, `write`), and ends
   * with `pty.exit`, whose code says how (`SETUP_EXIT` in
   * `src/lib/agentSetupFlow.ts`). Refused with `setup_busy` while a step of
   * that agent runs there; its data is that {@link MachineAgentSetupRun}
   * when the step runs in a terminal to attach to, absent when the machine's
   * own window runs it.
   */
  async startAgentSetup(params: { harness: string; step: MachineAgentSetupStep; cols: number; rows: number }): Promise<PtyInfo> {
    // Not resent after a drop: a second start would only be refused as busy.
    return this.call<PtyInfo>("machine.agentSetup", params);
  }

  /** `machine/6`: the folders directly inside `path` on the machine (its user's home when absent). Folder names only. */
  async browseMachineFolders(path?: string): Promise<MachineFolderListing> {
    return this.call<MachineFolderListing>("machine.browse", path === undefined ? {} : { path });
  }

  /** `machine/6`: make a folder on the machine one of its projects. A folder that already is one comes back as it is. */
  async addMachineProject(path: string): Promise<MachineProject> {
    const result = await this.call<{ project: MachineProject }>("machine.addProject", { path });
    return result.project;
  }

  /** `machine/6`: remove a project from the machine. Its folder and worktrees stay on disk. */
  async removeMachineProject(projectId: string): Promise<void> {
    await this.call("machine.removeProject", { projectId });
  }

  /**
   * `machine/6`: start cloning `repository` (`owner/name` or a URL) into
   * `<parent>/<name>` on the machine, with its git sign-in. Answers at once;
   * follow it with {@link cloneStatus} until it ends.
   */
  async cloneMachineProject(repository: string, parent: string): Promise<MachineClone> {
    const result = await this.call<{ clone: MachineClone }>("machine.cloneProject", { repository, parent });
    return result.clone;
  }

  /** `machine/6`: how a clone is going, or how it ended. */
  async cloneStatus(cloneId: string): Promise<MachineClone> {
    const result = await this.call<{ clone: MachineClone }>("machine.cloneStatus", { cloneId });
    return result.clone;
  }

  /** `machine/6`: stop a clone; it leaves nothing behind. */
  async cancelClone(cloneId: string): Promise<MachineClone> {
    const result = await this.call<{ clone: MachineClone }>("machine.cloneCancel", { cloneId });
    return result.clone;
  }

  /** `machine/7`: a session's saved actions, preview URLs, setup script, ports and setup run, as the machine has them. */
  async sessionActions(sessionId: string): Promise<MachineSessionActions> {
    return this.call<MachineSessionActions>("machine.sessionActions", { sessionId });
  }

  /**
   * `machine/7`: run a saved action in a terminal of the session on the
   * machine. A non-concurrent action already running is not started again
   * (`started` false) unless `restart`, which replaces that run. Not resent
   * after a drop: a resend of a concurrent action would start it twice.
   */
  async runAction(sessionId: string, actionId: string, restart = false): Promise<MachineActionOutcome> {
    return this.call<MachineActionOutcome>("machine.runAction", { sessionId, actionId, restart });
  }

  /** `machine/7`: run the session's setup script again on the machine. */
  async rerunSetup(sessionId: string): Promise<MachineSetupRun | null> {
    const result = await this.call<{ setup: MachineSetupRun | null }>("machine.setupRerun", { sessionId });
    return result.setup;
  }

  /** `machine/7`: stop the session's setup attempt `paneId` on the machine. */
  async stopSetup(sessionId: string, paneId: string): Promise<MachineSetupRun | null> {
    const result = await this.call<{ setup: MachineSetupRun | null }>("machine.setupStop", { sessionId, paneId });
    return result.setup;
  }

  /** `machine/4`: the setup step running there for `harness`, to follow it from another window or after a reload. */
  async agentSetupRunning(harness: string): Promise<MachineAgentSetupRun | null> {
    const result = await this.call<{ run?: MachineAgentSetupRun | null }>("machine.agentSetupRunning", { harness });
    return result.run ?? null;
  }

  /** `pipeline/1`: the issue pipelines the runtime carries, newest last. */
  async listPipelines(): Promise<RuntimeIssuePipeline[]> {
    const result = await this.call<{ pipelines?: RuntimeIssuePipeline[] }>("pipeline.list");
    return result.pipelines ?? [];
  }

  /** `pipeline/2`: all persistent reviewer IDs in this workspace, including evicted history. */
  async listPipelineReviewers(): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    do {
      const page: { sessionIds: string[]; next: string | null } = await this.call("pipeline.reviewers", after ? { after } : {});
      ids.push(...page.sessionIds);
      if (page.next && after && page.next <= after) throw new Error("Reviewer pagination did not advance");
      after = page.next;
    } while (after);
    return ids;
  }

  /** `pipeline/1`: stop, resume, carry on, review again or look again. Never a merge: a runtime makes none. */
  async setPipelineResolveConflicts(pipeline: string, value: boolean): Promise<RuntimeIssuePipeline> {
    const result = await this.mutate<{ pipeline: RuntimeIssuePipeline }>("pipeline.resolveConflicts", { pipeline, value });
    return result.pipeline;
  }

  async actOnPipeline(pipeline: string, action: "stop" | "resume" | "advance" | "review" | "refresh"): Promise<RuntimeIssuePipeline> {
    const result = await this.mutate<{ pipeline: RuntimeIssuePipeline }>("pipeline.act", { pipeline, action });
    return result.pipeline;
  }

  /** `pipeline/1`: this desktop merged the pipeline's pull request, pinned to `commit`; the runtime reads it back and records it. */
  async noteMerge(pipeline: string, commit: string): Promise<RuntimeIssuePipeline> {
    const result = await this.mutate<{ pipeline: RuntimeIssuePipeline }>("pipeline.noteMerge", { pipeline, commit });
    return result.pipeline;
  }

  /** `pipeline/1`: this desktop moved the pipeline's Linear issue to review; `message` says what it did, for the record. */
  async noteTracker(pipeline: string, message: string): Promise<RuntimeIssuePipeline> {
    const result = await this.mutate<{ pipeline: RuntimeIssuePipeline }>("pipeline.noteTracker", { pipeline, message });
    return result.pipeline;
  }

  /** `pipeline.changed`: one pipeline, whenever the runtime writes it (`pipeline/1`). */
  onPipeline(listener: (pipeline: RuntimeIssuePipeline) => void): () => void {
    return this.onNotification((notification) => {
      if (notification.event !== "pipeline.changed") return;
      const pipeline = notification.params.pipeline;
      if (pipeline && typeof pipeline === "object" && typeof (pipeline as { id?: unknown }).id === "string") listener(pipeline as RuntimeIssuePipeline);
    });
  }

  /** `machine.updateStatus` (`machine/3`): how the machine updates, what it could update to, and what an update would stop. `refresh` checks for a release now. */
  async machineUpdateStatus(refresh = false): Promise<MachineUpdateStatus> {
    const status = machineUpdateStatus(await this.call("machine.updateStatus", refresh ? { refresh: true } : {}));
    if (!status) throw new WorkspaceRpcError("invalid_response", "The machine answered machine.updateStatus with something else", "machine.updateStatus");
    return status;
  }

  /**
   * `machine.update` (`machine/3`, a manager): update the machine to
   * `version`. Refused with `update_confirm` (its data the status) unless
   * `stop` names every blocker and `confirmedOthers` names every other
   * computer connected; `update_busy` while one runs; `update_unavailable` when the
   * machine cannot update itself.
   */
  async updateMachine(request: MachineUpdateRequest): Promise<MachineUpdateStatus> {
    const params: Record<string, unknown> = { version: request.version };
    if (request.stop) params.stop = request.stop;
    if (request.confirmedOthers) params.confirmedOthers = request.confirmedOthers;
    const status = machineUpdateStatus(await this.call("machine.update", params));
    if (!status) throw new WorkspaceRpcError("invalid_response", "The machine answered machine.update with something else", "machine.update");
    return status;
  }

  /** `machine.updateChanged` (`machine/3`): the update status whenever any field changes. */
  onMachineUpdate(listener: (status: MachineUpdateStatus) => void): () => void {
    return this.onNotification((notification) => {
      if (notification.event !== "machine.updateChanged") return;
      const status = machineUpdateStatus(notification.params.status);
      if (status) listener(status);
    });
  }

  /** `session.sessions`: the whole visible session list, after any create, update or delete (`session/2`). */
  onSessions(listener: (sessions: RuntimeSession[]) => void): () => void {
    return this.onNotification((notification) => {
      if (notification.event !== "session.sessions") return;
      const sessions = notification.params.sessions;
      if (Array.isArray(sessions)) listener(sessions as RuntimeSession[]);
    });
  }

  /**
   * Whether the connected runtime granted `capability`. False while not
   * connected: an action that needs a newer runtime stays hidden until it is
   * known to be there.
   */
  hasCapability(capability: WorkspaceCapability): boolean {
    return this.state.state === "connected" && this.state.capabilities.includes(capability);
  }

  /** Ask the runtime to poll the command mailbox now rather than at its next interval. */
  async nudgeMailbox(): Promise<void> {
    await this.call("session.nudge", {});
  }

  /**
   * Changes under a workspace directory (`fs.watch`). `onChange` gets the
   * changed workspace-relative paths, or null when everything shown should
   * be re-read: after a reconnect (changes made while away were not seen)
   * or a burst too large to name.
   */
  watchFiles(path: string, onChange: (paths: string[] | null) => void, scope: { projectId?: string } = {}): Promise<() => void> {
    let resumed = false;
    return this.subscribe({
      method: "fs.watch",
      params: scope.projectId ? { path, projectId: scope.projectId } : { path },
      resumeParams: () => ({}),
      onReplay: () => {
        if (resumed) onChange(null);
        resumed = true;
      },
      listener: (notification) => {
        if (notification.event !== "fs.changed") return;
        // Too many to name (an install, a checkout): re-read everything.
        if (notification.params.overflow === true) return onChange(null);
        const paths = notification.params.paths;
        if (Array.isArray(paths)) onChange(paths.filter((entry): entry is string => typeof entry === "string"));
      },
    });
  }

  /** Every notification the runtime sends, including broadcasts such as `session.tabs`. */
  onNotification(listener: (notification: WorkspaceNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    for (const stop of this.detach) stop();
    this.rpc.close("Workspace connection closed");
    this.subscriptions.clear();
    this.notificationListeners.clear();
    for (const input of this.inputs.values()) for (const entry of input.pending.splice(0)) entry.reject(new Error("Workspace connection closed"));
    this.inputs.clear();
    this.transport.close();
  }

  private async subscribe(spec: {
    method: Subscription["method"];
    params: Record<string, unknown>;
    resumeParams: () => Record<string, unknown>;
    /** The runtime ended the stream; call this to resume it. */
    listener: (notification: WorkspaceNotification, resubscribe: () => void) => void;
    onReplay: (result: Record<string, unknown>) => void;
    onCursorExpired?: () => void;
    /** False: the subscription is over and is dropped instead of resumed. */
    beforeResume?: () => boolean;
    /** True: the refusal was handled and ends the subscription quietly. */
    onRefused?: (error: WorkspaceRpcError) => boolean;
  }): Promise<() => void> {
    const localId = `local-${++this.nextLocal}`;
    const subscription: Subscription & { resume: () => Promise<void> } = {
      method: spec.method,
      params: spec.params,
      listener: (notification) =>
        spec.listener(notification, () => {
          if (this.subscriptions.get(localId) !== subscription) return;
          subscription.serverId = undefined;
          // Keep trying while the link is up; a reconnect resumes it anyway.
          const retry = (attempt: number) => {
            if (this.closed || this.state.state !== "connected" || this.subscriptions.get(localId) !== subscription || subscription.serverId) return;
            subscription.resume().catch(() => setTimeout(() => retry(attempt + 1), Math.min(10_000, 250 * 2 ** attempt)));
          };
          retry(0);
        }),
      onReplay: spec.onReplay,
      resume: async () => {
        if (spec.beforeResume && !spec.beforeResume()) {
          this.subscriptions.delete(localId);
          return;
        }
        let result: RpcCallResult<Record<string, unknown>>;
        this.resuming++;
        try {
          result = await this.rpc.request(spec.method, { ...spec.params, ...spec.resumeParams() });
        } finally {
          this.resuming--;
        }
        if (!result.ok && result.refusal.code === "cursor_expired") {
          // Another runtime generation: resync from a full snapshot.
          spec.onCursorExpired?.();
          this.resuming++;
          try {
            result = await this.rpc.request(spec.method, spec.params);
          } finally {
            this.resuming--;
          }
        }
        if (!result.ok && spec.onRefused?.(refusalError(spec.method, result.refusal))) {
          this.subscriptions.delete(localId);
          return;
        }
        const value = unwrap(spec.method, result);
        subscription.serverId = String(value.subscriptionId);
        spec.onReplay(value);
        const early = this.unrouted.filter((notification) => notification.params.subscriptionId === subscription.serverId);
        if (early.length) {
          this.unrouted = this.unrouted.filter((notification) => notification.params.subscriptionId !== subscription.serverId);
          for (const notification of early) subscription.listener(notification);
        }
        if (this.resuming === 0) this.unrouted = [];
      },
    };
    this.assertGranted(spec.method);
    this.subscriptions.set(localId, subscription);
    // Not connected yet (or the link drops mid-call): the subscription is
    // registered and resumes on the next connect. A runtime refusal is final.
    if (this.state.state === "connected") {
      try {
        await subscription.resume();
      } catch (error) {
        if (error instanceof WorkspaceRpcError) {
          this.subscriptions.delete(localId);
          throw error;
        }
      }
    }
    return () => {
      const current = this.subscriptions.get(localId);
      this.subscriptions.delete(localId);
      const unsubscribe = spec.method === "pty.attach" ? "pty.detach" : spec.method === "fs.watch" ? "fs.unwatch" : "session.unsubscribe";
      if (current?.serverId && this.state.state === "connected") void this.rpc.request(unsubscribe, { subscriptionId: current.serverId }).catch(() => undefined);
    };
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.ok === "boolean") {
      for (const listener of this.responseListeners) listener(record as unknown as RpcResponse);
      return;
    }
    if (typeof record.event === "string" && record.params && typeof record.params === "object") {
      const notification = record as unknown as WorkspaceNotification;
      for (const listener of this.notificationListeners) listener(notification);
      const target = notification.params.subscriptionId;
      let routed = false;
      for (const subscription of this.subscriptions.values()) {
        if (subscription.serverId === target) {
          subscription.listener(notification);
          routed = true;
        }
      }
      // Only a subscription whose answer is still on its way can own it;
      // anything else is for a stream this client already ended.
      if (!routed && target && this.resuming > 0) {
        this.unrouted.push(notification);
        if (this.unrouted.length > 256) this.unrouted.shift();
      }
    }
  }

  private changeState(state: WorkspaceConnectionState): void {
    const previous = this.state;
    const wasConnected = previous.state === "connected";
    // Connected on another link: the old link's subscriptions are gone, but it
    // stays open a little to answer what was already sent on it.
    const newLink = wasConnected && state.state === "connected" && state.link !== undefined && state.link !== previous.link;
    this.state = state;
    if (wasConnected && state.state !== "connected") {
      this.unrouted = [];
      for (const dropped of [...this.dropWaiters]) dropped();
      this.dropWaiters.clear();
    }
    if (newLink) this.unrouted = [];
    if (state.state === "connected" && (!wasConnected || newLink)) {
      // A new E2EE session: every server-side subscription is gone.
      for (const subscription of this.subscriptions.values()) {
        subscription.serverId = undefined;
        void (subscription as Subscription & { resume: () => Promise<void> }).resume().catch(() => undefined);
      }
    }
    for (const listener of this.stateListeners) listener(state);
  }

  private connected(withinMs: number): Promise<void> {
    if (this.state.state === "connected") return new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing reconnects from these on its own; do not hold input for them.
    if (["suspended", "stopped", "updateRequired"].includes(this.state.state)) {
      return Promise.reject(new Error(`Workspace runtime is ${this.state.state}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Workspace runtime did not reconnect"));
      }, Math.max(0, withinMs));
      const stop = this.onState((state) => {
        // The drop turned out to be a stop (or an end): what was waiting to
        // be resent is refused now. It must never be sent when the workspace
        // is woken later, least of all terminal input typed before the stop.
        if (["suspended", "stopped", "updateRequired"].includes(state.state)) {
          clearTimeout(timer);
          queueMicrotask(stop);
          reject(new Error(`Workspace runtime is ${state.state}`));
          return;
        }
        if (state.state !== "connected") return;
        clearTimeout(timer);
        queueMicrotask(stop);
        resolve();
      });
    });
  }

  private assertGranted(method: string): void {
    if (this.state.state !== "connected") return;
    const required = METHOD_CAPABILITIES[method];
    if (required) return this.assertCapability(required, method);
    const namespace = method.split(".")[0];
    if (!this.state.capabilities.some((capability) => capability.startsWith(`${namespace}/`))) {
      throw new WorkspaceRpcError("capability_not_granted", `${namespace} is not available from this runtime`, method);
    }
  }

  /** Refuse before sending when the connected runtime did not grant `capability`. */
  private assertCapability(capability: WorkspaceCapability, method: string): void {
    if (this.state.state !== "connected") return;
    if (!this.state.capabilities.includes(capability)) {
      throw new WorkspaceRpcError("capability_not_granted", `${capability} is not available from this runtime`, method);
    }
  }
}

function unwrap<T>(method: string, result: RpcCallResult<T>): T {
  if (result.ok) return result.value;
  throw refusalError(method, result.refusal);
}

/** A runtime's refusal as an error. The refusal comes off the wire unchecked: a message that is not a string reads as the code. */
function refusalError(method: string, refusal: RpcErrorData): WorkspaceRpcError {
  const message: unknown = refusal.message;
  return new WorkspaceRpcError(refusal.code, typeof message === "string" ? message : String(refusal.code), method, refusal.data);
}

function randomRequestId(): string {
  return `req-${crypto.randomUUID().replace(/-/g, "")}`;
}

function outputSize(value: unknown): { cols: number; rows: number } | undefined {
  if (!value || typeof value !== "object") return;
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  if (typeof cols === "number" && typeof rows === "number" && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 1_000 && rows <= 1_000) return { cols, rows };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
