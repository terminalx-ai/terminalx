import type { WorkspaceConnectionState, WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import { agent, type ImageInput } from "@/lib/api";
import { loadTab, setTabStatus } from "@/lib/agentEvents";
import { patchTab } from "@/lib/sessions";
import {
  attachCloudAgentTab,
  configureCloudAgentTab,
  decideCloudAgent,
  discardPendingConfig,
  isDeciding,
  markCloudAgentRead,
  refreshFromCheckpoint,
  sendAgain,
  sendToCloudAgent,
  setViewing,
  steerCloudAgent,
  stopCloudAgent,
} from "@/lib/cloudAgents";
import type { CloudAgentScope, OutboxEntry } from "@/lib/cloudAgentApi";
import { APPROVE_BLOCKED_REASON, canApprove, mayConfigure, roleBlockReason } from "@/lib/cloudCollab";
import type { AgentEvent } from "@/types/events";
import type { TabEntry, TabStatus } from "@/types/session";

/**
 * What one session can do, wherever it runs (PRO-23 CS-10). SessionView,
 * TabView and the tab strip call a backend instead of `agent.*`, and gate
 * what they show on its capability flags:
 *
 * - `localSessionBackend` is today's Tauri calls, unchanged.
 * - `cloudSessionBackend` is a session in a cloud workspace: its agent tabs
 *   through the cloud agents store (the API mailbox, live RPC when the
 *   runtime is online), its terminals, and the workspace's Git and files.
 */
export interface SessionBackendCaps {
  /** Its tabs and paths are on this computer: terminal view, browser tabs, continuation, worktree rename, slash commands and @-mentions. */
  local: boolean;
  /** Send, steer, stop, answer, configure, add tabs and open terminals. False for a view-only attachment. */
  write: boolean;
  /** A separate "steer into the running turn" command. */
  steer: boolean;
  /** Images go with a prompt. */
  images: boolean;
  /** The local recovery flows (retry safely, resume after a stop). */
  recovery: boolean;
}

export interface SendResult {
  events: AgentEvent[];
  queued: boolean;
}

export interface SessionBackend {
  kind: "local" | "cloud";
  /** The selection key: a local `SessionEntry.id`, or `cloud:<orgId>:<workspaceId>:<sessionId>`. */
  key: string;
  /** Changes whenever what a tab should attach to changes (a cloud connection's runtime generation). */
  generation: string;
  caps: SessionBackendCaps;
  /** Why writes are off, shown wherever they would be. Null while they are allowed. */
  readOnlyReason: string | null;
  /** The session id the agent event logs are keyed by (the runtime's own id for a cloud session). */
  logSessionId: string;
  /** Start showing a tab: load its log (local), or its checkpoint and live stream (cloud). Returns the cleanup. */
  openTab(tabId: string, onError: (error: unknown) => void): (() => void) | void;
  send(tabId: string, text: string, images: ImageInput[]): Promise<SendResult>;
  steer(tabId: string, text: string): Promise<void>;
  stop(tabId: string): Promise<void>;
  respondPermission(tabId: string, requestId: string, optionId: string): Promise<void>;
  answerQuestions(tabId: string, requestId: string, answers: Record<string, string>): Promise<void>;
  setModel(tabId: string, model: string): Promise<void>;
  setEffort(tabId: string, effort: string | null): Promise<void>;
  setPermissionMode(tabId: string, mode: string): Promise<void>;
  markRead(tabId: string): Promise<void>;
  /** The UI's copy of a tab. A cloud tab's store updates itself, so this is local only. */
  patchTab(tabId: string, patch: Partial<TabEntry>): void;
  setTabStatus(tabId: string, status: TabStatus): void;
  /**
   * Cloud only: what happened to a model, effort or mode chosen here.
   * `pending`: it has not reached the agent yet and rides with the next
   * message (an approver's connection cannot configure a tab live, and
   * nobody's can while offline). `ignored`: it was dropped, because this
   * person may no longer change settings (the receipt's `settingsIgnored`).
   */
  settingsNotice?(tabId: string): "pending" | "ignored" | null;
  /** Why this person may not answer permission requests (a shared workspace's non-approver), or null. */
  approveBlockedReason?: string | null;
  /**
   * Cloud only, PRO-30: where the workspace's presence, notes and tab leases
   * live, who this person is there (null when sharing does not apply, as on
   * an older runtime), and the connection while it is live with `collab/1`.
   */
  collab?: { key: string; you: WorkspaceYou | null; client: WorkspaceRpcClient | null };
  /** Cloud only: commands on their way for a tab, the runtime's queued follow-ups, and resending an unconfirmed one. */
  outbox?: {
    entries(tabId: string): OutboxEntry[];
    followUps(tabId: string): { clientCommandId: string; text: string }[];
    deciding(requestId: string): boolean;
    sendAgain(entry: OutboxEntry): Promise<void>;
  };
}

const LOCAL_CAPS: SessionBackendCaps = { local: true, write: true, steer: false, images: true, recovery: true };

const localBackends = new Map<string, SessionBackend>();

/** A local session: every call goes to the existing Tauri commands, exactly as before. */
export function localSessionBackend(sessionId: string): SessionBackend {
  const known = localBackends.get(sessionId);
  if (known) return known;
  const backend: SessionBackend = {
    kind: "local",
    key: sessionId,
    generation: "local",
    caps: LOCAL_CAPS,
    readOnlyReason: null,
    logSessionId: sessionId,
    openTab: (tabId, onError) => {
      void loadTab(sessionId, tabId).catch(onError);
    },
    send: (tabId, text, images) => agent.send(sessionId, tabId, text, images),
    steer: (tabId, text) => agent.send(sessionId, tabId, text, []).then(() => undefined),
    stop: (tabId) => agent.stop(sessionId, tabId),
    respondPermission: (tabId, requestId, optionId) => agent.respondPermission(sessionId, tabId, requestId, optionId),
    answerQuestions: (tabId, requestId, answers) => agent.answerQuestions(sessionId, tabId, requestId, answers),
    setModel: (tabId, model) => agent.setModel(sessionId, tabId, model),
    setEffort: (tabId, effort) => agent.setEffort(sessionId, tabId, effort),
    setPermissionMode: (tabId, mode) => agent.setPermissionMode(sessionId, tabId, mode),
    markRead: (tabId) => agent.markRead(sessionId, tabId),
    patchTab: (tabId, patch) => patchTab(sessionId, tabId, patch),
    setTabStatus: (tabId, status) => setTabStatus(sessionId, tabId, status),
  };
  if (localBackends.size > 256) localBackends.clear();
  localBackends.set(sessionId, backend);
  return backend;
}

// ---- cloud

export const CLOUD_IMAGES_UNSUPPORTED = "Images cannot be sent to cloud agent tabs yet.";

/**
 * Why a cloud session is view-only, or null when this person may drive it.
 * On a shared workspace (PRO-30) the collaboration role decides: a driver's
 * participate attachment may send to agents, a viewer's may not. `you` null
 * (an older server or runtime, or no member list yet) keeps the attachment
 * rule: only `manage` drives.
 */
export function cloudReadOnlyReason(
  authority: string | null | undefined,
  workspaceState: string | null | undefined,
  you: WorkspaceYou | null = null,
): string | null {
  if (workspaceState === "archived") return "Archived: unarchive the workspace to send messages or run anything in it.";
  if (workspaceState === "destroyed") return "This workspace was deleted.";
  if (you && you.listed !== false) return roleBlockReason(you);
  if (authority === "participate") return "View only: you can read this workspace, but only someone with manage access can send, stop, answer or change anything in it.";
  return null;
}

/**
 * Wake requests in flight, per workspace: several sends, or several surfaces,
 * while a stopped workspace resumes still wake it once.
 */
const waking = new Map<string, Promise<void>>();

/** Wake a workspace at most once until its runtime is back (`clearCloudWake`). */
export function wakeCloudWorkspaceOnce(workspaceKey: string, wake: () => Promise<void>): Promise<void> {
  const pending = waking.get(workspaceKey);
  if (pending) return pending;
  const next = wake().catch((error: unknown) => {
    // A wake that failed may be asked for again.
    waking.delete(workspaceKey);
    throw error;
  });
  waking.set(workspaceKey, next);
  return next;
}

/** The workspace is connected again (or was deleted): a later stop needs a new wake. */
export function clearCloudWake(workspaceKey: string) {
  waking.delete(workspaceKey);
}

/** Tests only. */
export function resetCloudWakes() {
  waking.clear();
}

export interface CloudSessionContext {
  key: string;
  /** `cloud:<orgId>:<workspaceId>`. */
  workspaceKey: string;
  scope: CloudAgentScope;
  /** The runtime's id for this session. */
  sessionId: string;
  state: WorkspaceConnectionState;
  /** Null until the connection exists. */
  client: WorkspaceRpcClient | null;
  /** The API's workspace state (ready, suspended, archived, …), when known. */
  workspaceState: string | null;
  /** What the connection granted, else what the list says opening would grant. */
  authority: string | null;
  outbox: OutboxEntry[];
  followUps: (tabId: string) => { clientCommandId: string; text: string }[];
  /** Raise the connection to `wake`: only called for an interactive command on a stopped workspace. */
  wake: () => Promise<void>;
  /** What became of a tab's last setting change (see `SessionBackend.settingsNotice`). */
  settingsNotice?: (tabId: string) => "pending" | "ignored" | null;
  /** PRO-30: this person's access (live, last known or from the list); null when sharing does not apply. */
  you?: WorkspaceYou | null;
  /** The connection, when it was granted `collab/1`. */
  collabClient?: WorkspaceRpcClient | null;
  /** How many times the connection connected: a tab attaches again after each (a reconnect, a new attachment). */
  connects?: number;
}

/** Whether a cloud workspace's compute is asleep as far as this client knows. */
export function cloudAsleep(state: WorkspaceConnectionState, workspaceState: string | null): boolean {
  if (state.state === "connected") return false;
  return state.state === "suspended" || workspaceState === "suspended";
}

/**
 * A session in a cloud workspace. Reading never wakes compute; a prompt, a
 * steer or a decision goes through the mailbox (which may wake it on the
 * server), and the connection follows with one `wake` so the live stream
 * attaches as soon as the runtime is back.
 */
export function cloudSessionBackend(ctx: CloudSessionContext): SessionBackend {
  const { scope } = ctx;
  const live = ctx.state.state === "connected" ? ctx.state : null;
  const connected = !!live;
  const client = connected ? ctx.client : null;
  const you = ctx.you ?? null;
  const readOnlyReason = cloudReadOnlyReason(ctx.authority, ctx.workspaceState, you);
  const approveBlockedReason = you && !canApprove(you) ? APPROVE_BLOCKED_REASON : null;
  const write = readOnlyReason === null;
  const guard = () => {
    if (readOnlyReason) throw new Error(readOnlyReason);
  };
  const followWake = () => {
    if (!cloudAsleep(ctx.state, ctx.workspaceState)) return;
    void wakeCloudWorkspaceOnce(ctx.workspaceKey, ctx.wake).catch(() => undefined);
  };
  const interactive = async (run: () => Promise<unknown>) => {
    guard();
    await run();
    followWake();
  };
  return {
    kind: "cloud",
    key: ctx.key,
    generation: live ? `${live.runtimeGeneration}:${live.runtimeEpoch ?? ""}:${ctx.connects ?? 0}` : `offline:${ctx.client ? "client" : "none"}`,
    caps: { local: false, write, steer: true, images: false, recovery: false },
    readOnlyReason,
    approveBlockedReason,
    collab: { key: ctx.workspaceKey, you, client: ctx.collabClient ?? null },
    logSessionId: ctx.sessionId,
    openTab: (tabId, onError) => {
      setViewing(scope, tabId, true);
      let cancelled = false;
      let stop: (() => void) | null = null;
      // Cache first (already loaded), then the checkpoint when it is newer;
      // live only while the runtime is already online.
      void refreshFromCheckpoint(scope, tabId).catch(() => undefined);
      if (client) {
        void attachCloudAgentTab(scope, tabId, client)
          .then((unsubscribe) => (cancelled ? unsubscribe() : (stop = unsubscribe)))
          .catch((error: unknown) => !cancelled && onError(error));
      }
      return () => {
        cancelled = true;
        stop?.();
        setViewing(scope, tabId, false);
      };
    },
    send: async (tabId, text, images) => {
      if (images.length) throw new Error(CLOUD_IMAGES_UNSUPPORTED);
      // Settings chosen while this person could approve are not sent once they cannot: the runtime would ignore them.
      if (!mayConfigure(you)) discardPendingConfig(scope, tabId);
      await interactive(() => sendToCloudAgent(scope, tabId, text, client));
      return { events: [], queued: true };
    },
    steer: (tabId, text) => interactive(() => steerCloudAgent(scope, tabId, text, client)),
    // Stopping needs no compute: a sleeping workspace runs nothing to stop.
    stop: async (tabId) => {
      guard();
      await stopCloudAgent(scope, tabId, client);
    },
    respondPermission: (tabId, requestId, optionId) => {
      if (approveBlockedReason) return Promise.reject(new Error(approveBlockedReason));
      return interactive(() => decideCloudAgent(scope, tabId, { requestId, optionId }, client));
    },
    answerQuestions: (tabId, requestId, answers) => {
      if (approveBlockedReason) return Promise.reject(new Error(approveBlockedReason));
      return interactive(() => decideCloudAgent(scope, tabId, { requestId, answers }, client));
    },
    setModel: async (tabId, model) => {
      guard();
      await configureCloudAgentTab(scope, tabId, { model }, client);
    },
    setEffort: async (tabId, effort) => {
      guard();
      await configureCloudAgentTab(scope, tabId, { effort }, client);
    },
    setPermissionMode: async (tabId, mode) => {
      guard();
      await configureCloudAgentTab(scope, tabId, { mode }, client);
    },
    settingsNotice: (tabId) => {
      const notice = ctx.settingsNotice?.(tabId) ?? null;
      // Someone who may no longer configure is not told their change "applies with the next message".
      return notice === "pending" && !mayConfigure(you) ? null : notice;
    },
    markRead: (tabId) => markCloudAgentRead(scope, tabId, client),
    patchTab: () => undefined,
    setTabStatus: () => undefined,
    outbox: {
      entries: (tabId) => ctx.outbox.filter((entry) => entry.tabId === tabId),
      followUps: ctx.followUps,
      deciding: (requestId) => isDeciding(scope, requestId),
      sendAgain: (entry) => interactive(() => sendAgain(scope, entry, client)),
    },
  };
}
