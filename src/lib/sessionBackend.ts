import type { AgentProcessState, AgentTabInfo, WorkspaceConnectionState, WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import { agent, attachments, errorMessage, experimental, type FileInput, type ImageInput, type SendOutcome } from "@/lib/api";
import type { ContinuationContext } from "@terminalx/portable/continuation";
import type { FileRef } from "@/types/events";
import type { WorkspaceStatus } from "@/lib/cloudPendingMessages";
import { showError } from "@/lib/errorToasts";
import { applyEvent, getTabLog, loadTab, reloadTabHistory, setTabStatus, showFirstMessage } from "@/lib/agentEvents";
import { forkTurn, patchTab, refreshSessions, selectCloudSession } from "@/lib/sessions";
import {
  attachCloudAgentTab,
  configureCloudAgentTab,
  decideCloudAgent,
  discardPendingConfig,
  isDeciding,
  isDevScope,
  markCloudAgentRead,
  refreshFromCheckpoint,
  sendAgain,
  sendToCloudAgent,
  setViewing,
  steerCloudAgent,
  stopCloudAgent,
  applyLiveTab,
} from "@/lib/cloudAgents";
import type { CloudAgentScope, OutboxEntry } from "@/lib/cloudAgentApi";
import { APPROVE_BLOCKED_REASON, canApprove, mayConfigure, roleBlockReason } from "@/lib/cloudCollab";
import { CLOUD_FILES_REFUSED, MACHINE_FILES_OLD_RUNTIME, CLOUD_IMAGES_NEED_RUNNING, CloudImageError, cloudComposerCommands, cloudComposerFiles, cloudImagesBlocked, type ComposerCommands, type ComposerFiles } from "@/lib/cloudComposer";
import { isPtyFirst } from "@/lib/tabViews";
import { selectSessionTab, type TerminalInstance } from "@/lib/terminal";
import type { AgentEvent } from "@/types/events";
import type { TabEntry, TabStatus } from "@/types/session";
import { localTurnCheckpoints, type TurnCheckpointApi } from "@/lib/turnCheckpoints";

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
  /** Its tabs and paths are on this computer: terminal view, browser tabs, continuation and worktree rename. */
  local: boolean;
  /** Send, steer, stop, answer, configure, add tabs and open terminals. False for a view-only attachment. */
  write: boolean;
  /** A separate "steer into the running turn" command. */
  steer: boolean;
  /** Images go with a prompt. */
  images: boolean;
  /**
   * Files other than images go with a prompt: a local tab (PRO-290), and a
   * machine that serves `composer/4` (PRO-407). Never a cloud workspace's tab.
   * While a machine is away it is true: the send is held until it is back,
   * and a machine from before `composer/4` then says it needs an update.
   */
  files: boolean;
  /** The local recovery flows (retry safely, resume after a stop). */
  recovery: boolean;
  /**
   * `interrupt` reaches the agent: Escape in the chat does something. False
   * on a cloud tab while its runtime is not connected, or is one from before
   * `session/3`; there only the hard stop is offered.
   */
  interrupt: boolean;
}

/**
 * Why an option a local session has is off for this one (#1289). The control
 * is shown disabled with the reason where a local session has it, instead of
 * being left out. A key that is absent is either offered or does not apply.
 */
export interface SessionUnavailable {
  /** Turn menu: Fork to a new tab or session (PRO-379). */
  fork?: string;
  /** Turn menu: Reset chat to here. */
  reset?: string;
  /** Turn footer: a second opinion from another agent. */
  secondOpinion?: string;
  /** A failed turn: Retry in a new chat. */
  retryInNewChat?: string;
  /** Composer, Agent menu: hand the conversation off to another agent in a new tab (#1327). */
  agentHandoff?: string;
  /** Header: the project's saved actions and previews (PRO-363). */
  runMenu?: string;
}

/**
 * What a session that runs on a workspace runtime or a paired machine cannot
 * do, and why. Fork and Reset are its runtime's (#1326): see `TURNS_*`; a
 * second opinion, Retry in a new chat and the agent handoff too (#1327): see `HANDOFF_*`.
 */
export const REMOTE_UNAVAILABLE: Readonly<SessionUnavailable> = Object.freeze({
  runMenu: "Saved actions and previews run on this computer. A cloud workspace's ports and previews are in its workspace menu.",
});

/** Why Fork and Reset are off on a remote session that could offer them (#1326). */
export const TURNS_OFFLINE: Readonly<Pick<SessionUnavailable, "fork" | "reset">> = Object.freeze({
  fork: "Fork needs this session's runtime connected. It is offered once the workspace or machine is back.",
  reset: "Reset needs this session's runtime connected. It is offered once the workspace or machine is back.",
});
export const TURNS_OLD_RUNTIME: Readonly<Pick<SessionUnavailable, "fork" | "reset">> = Object.freeze({
  fork: "Fork needs a newer runtime. It is offered here once this session's runtime is updated.",
  reset: "Reset needs a newer runtime. It is offered here once this session's runtime is updated.",
});
export const TURNS_NEED_ADMIN: Readonly<Pick<SessionUnavailable, "fork" | "reset">> = Object.freeze({
  fork: "Forking a conversation changes the workspace's sessions, which needs a workspace admin.",
  reset: "Resetting a chat changes the workspace's files and conversation, which needs a workspace admin.",
});

type HandoffOff = Pick<SessionUnavailable, "secondOpinion" | "retryInNewChat" | "agentHandoff">;

/** Why a second opinion, Retry in a new chat and the agent handoff are off on a remote session that could offer them (#1327). */
export const HANDOFF_OFFLINE: Readonly<HandoffOff> = Object.freeze({
  secondOpinion: "A second opinion needs this session's runtime connected. It is offered once the workspace or machine is back.",
  retryInNewChat: "Retry in a new chat needs this session's runtime connected. Retry sends the prompt again in this chat.",
  agentHandoff: "Handing off to another agent needs this session's runtime connected. It is offered once the workspace or machine is back.",
});
export const HANDOFF_OLD_RUNTIME: Readonly<HandoffOff> = Object.freeze({
  secondOpinion: "A second opinion needs a newer runtime. It is offered here once this session's runtime is updated.",
  retryInNewChat: "Retry in a new chat needs a newer runtime. Retry sends the prompt again in this chat.",
  agentHandoff: "Handing off to another agent needs a newer runtime. It is offered here once this session's runtime is updated.",
});
export const HANDOFF_NEED_ADMIN: Readonly<HandoffOff> = Object.freeze({
  secondOpinion: "A second opinion opens a new tab in this session, which needs a workspace admin.",
  retryInNewChat: "Retry in a new chat opens a new tab in this session, which needs a workspace admin. Retry sends the prompt again in this chat.",
  agentHandoff: "Handing off opens a new tab in this session, which needs a workspace admin.",
});

/**
 * `REMOTE_UNAVAILABLE` with why Fork and Reset, and the handoffs, are off:
 * one object per pair of reasons, so a rebuilt backend keeps the same one.
 */
const remoteOff = new Map<string, Readonly<SessionUnavailable>>();
const TURNS_REASONS = [TURNS_OFFLINE, TURNS_OLD_RUNTIME, TURNS_NEED_ADMIN];
const HANDOFF_REASONS = [HANDOFF_OFFLINE, HANDOFF_OLD_RUNTIME, HANDOFF_NEED_ADMIN];
function remoteUnavailable(turns: object | null, handoff: object | null): Readonly<SessionUnavailable> {
  if (!turns && !handoff) return REMOTE_UNAVAILABLE;
  const key = `${turns ? TURNS_REASONS.indexOf(turns) : -1}:${handoff ? HANDOFF_REASONS.indexOf(handoff) : -1}`;
  let off = remoteOff.get(key);
  if (!off) remoteOff.set(key, off = Object.freeze({ ...REMOTE_UNAVAILABLE, ...turns, ...handoff }));
  return off;
}

/**
 * A second opinion, Retry in a new chat and the composer's agent handoff
 * (#1327) on a remote session: another agent's tab in it, opened with its
 * first prompt by the runtime in one call (`handoff/1`). A local session
 * takes them through `ContinuationDialog` on this computer.
 */
export interface HandoffActions {
  /**
   * Add a tab running `agent` with these settings, sent `prompt` as its first
   * message, and show it. `startError`: the tab was opened and its prompt
   * could not be sent; its chat says why, and it is never opened twice.
   * `requestId`: one id for every try of one handoff, so a try after an
   * unknown outcome gets the tab the first try made instead of a second.
   */
  open(params: { agent: string; model?: string; effort?: string | null; mode?: string; prompt: string; requestId?: string }): Promise<{ tabId: string; startError: string | null }>;
  /** What `tabId`'s conversation hands on, read on the runtime with its own transcript path. */
  context(tabId: string): Promise<ContinuationContext>;
}

/** A fork made (PRO-379): the session it is in, by its selection key, and its tab. */
export interface ForkedTab {
  key: string;
  tabId: string;
  /** Said beside the fork when its files are not the turn's. */
  note: string | null;
}

/**
 * Reset, Fork and the per-turn checkpoints a tab's turn cards review
 * (PRO-379, #1326), wherever the session runs: this computer's runtime for a
 * local session, the session's own runtime (`checkpoints/1`) for a cloud
 * workspace's or a machine's.
 */
export interface TurnActions {
  checkpoints: TurnCheckpointApi;
  /**
   * Reset the chat to the end of the turn `endSeq`, or with null undo the
   * last reset. Refused with `OVERLAP …` and a token when files would be
   * overwritten; sent again with that token as `confirm`, it goes ahead.
   * Resolves to a warning about what went wrong after the reset, or null.
   */
  reset(tabId: string, endSeq: number | null, resetFiles: boolean, confirm: string | null): Promise<string | null>;
  /** Fork the conversation as it stood at the end of the turn `endSeq`; the caller shows the fork. */
  fork(tabId: string, endSeq: number, into: "tab" | "session"): Promise<ForkedTab>;
}

/**
 * What a cloud workspace session leaves on this computer (#1325, as
 * MACHINES.md decision 7 does for a machine): browser tabs and orchestration
 * runs act on the computer a person sits at, and a runtime answers
 * `browser.*` with `unsupported`. A workspace's port opens in this computer's
 * browser from Ports and previews.
 */
export const REMOTE_LOCAL_ONLY = "Browser tabs and orchestration runs stay on this computer. A workspace's port opens in this computer's browser from Ports and previews.";

/** Why a message cannot be sent again from its place in the chat. */
export const RESEND_ATTACHMENTS = "This message had attachments, which are not kept to send again. Attach them again in the composer and send it from there.";
export const RESEND_MISSING = "That message is not in this tab's conversation any more.";

/** Whether a tab's terminal view is offered, and why not when it is not. */
export interface TerminalViewOffer {
  available: boolean;
  /** Shown on the switch instead of offering it. Null while it is offered. */
  reason: string | null;
}

/** An agent that has no terminal to show (it is driven headless on the VM). */
export const TERMINAL_VIEW_NO_TERMINAL = "This agent does not run in a terminal, so it has no terminal view.";
/** A runtime from before `agent-pty/1`. */
export const TERMINAL_VIEW_OLD_RUNTIME = "Terminal view needs a newer workspace runtime. It appears here once this workspace's runtime is updated.";

/**
 * What the terminal view of a cloud agent tab attaches to (PRO-86): the
 * terminal the tab's own CLI runs in on the VM, through the runtime
 * (`agent-pty/1`). Looking at it never wakes or starts anything.
 */
export interface AgentTerminalTarget {
  /** `cloud:<orgId>:<workspaceId>`: where the terminal's view and stream are kept. */
  workspaceKey: string;
  /** The live connection, while the runtime serves `agent-pty/1`; null while not connected. */
  client: WorkspaceRpcClient | null;
  /** Stopped as far as this client knows. */
  asleep: boolean;
  /** Makes the terminal's xterm, styled like every other terminal. */
  base: () => TerminalInstance;
  /** Whether the tab's CLI runs, as the runtime last said. */
  process(tabId: string): AgentProcessState | null;
  /** Typing on a stopped workspace: wake it, once, exactly as sending a message does. */
  wake(): void;
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
  /**
   * Why a send waits (a machine that is away, 21.09): the composer keeps what
   * is typed and sends nothing until it is null. Absent where sends never wait.
   */
  sendHeldReason?: string | null;
  /** The session id the agent event logs are keyed by (the runtime's own id for a cloud session). */
  logSessionId: string;
  /** Start showing a tab: load its log (local), or its checkpoint and live stream (cloud). Returns the cleanup. */
  openTab(tabId: string, onError: (error: unknown) => void): (() => void) | void;
  /**
   * `wake: false` (cloud only; the CLI, against a server that takes it): the
   * message starts nothing. A workspace that is not running refuses it and
   * nothing is kept, so the caller can ask the person and send again.
   */
  /** `pressedAt`: when Send was pressed, which a local runtime notes with its own timings of the send (#727). */
  /**
   * `files` (local only, PRO-290): attached files other than images. They are
   * stored in the session's attachments folder first and the message carries
   * their references; a failed store sends nothing. A cloud session refuses them.
   */
  send(tabId: string, text: string, images: ImageInput[], options?: { wake?: boolean; pressedAt?: number; files?: FileInput[] }): Promise<SendResult>;
  steer(tabId: string, text: string): Promise<void>;
  /** Local only: persist and control messages held until the turn ends. */
  changeHeldQueue?(tabId: string, change: import("@/lib/heldQueue").HeldQueueChange): Promise<SendResult>;
  /** Local only (PRO-290): store files in the session's attachments folder, for a follow-up that is held rather than sent. */
  storeFiles?(files: FileInput[]): Promise<FileRef[]>;
  /** Local only: interrupt so the CLI sends input it already holds. */
  sendQueuedNow?(tabId: string, seq: number): Promise<void>;
  /** Local only: send the last prompt the agent never received again, as it was sent (#663). */
  resendUnsent?(tabId: string): Promise<SendResult>;
  /**
   * Send the message at `seq` again as a new message: one the agent dropped
   * unanswered (#722), or a failed turn's prompt (Retry). A cloud tab sends
   * its text through the mailbox as any message (#1289); one with
   * attachments is refused, since they are not kept to send again.
   */
  resendMessage?(tabId: string, seq: number): Promise<SendResult>;
  /**
   * Escape, as the agent's own screen takes it (#427): the running turn is
   * interrupted and the agent's process stays. Nothing is queued or dropped
   * by it, and nothing is woken for it; with no turn running it does nothing.
   */
  interrupt(tabId: string): Promise<void>;
  /** The hard stop: the agent's process is ended, and the conversation resumes with the next message. */
  stop(tabId: string): Promise<void>;
  respondPermission(tabId: string, requestId: string, optionId: string): Promise<void>;
  answerQuestions(tabId: string, requestId: string, answers: Record<string, string>): Promise<void>;
  /**
   * Local only (PRO-460): answer a question the agent's CLI drew in its own
   * terminal, typed there as its keys: an option's index, or null for Escape.
   */
  answerTerminalPrompt?(tabId: string, promptId: string, choice: number | null): Promise<void>;
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
  /**
   * Cloud only (PRO-78): why the tab's agent has no way to sign in in its
   * workspace, as the runtime last said, and the organization whose Agent
   * logins fix it; on a machine (PRO-347) the machine's name instead, where
   * it is signed in. Null when it can sign in.
   */
  signIn?(tabId: string): { signIn: NonNullable<AgentTabInfo["signIn"]>; organizationId: string; machine?: string } | null;
  /** Options a local session has that this one cannot take, each with why (#1289). Absent on a local session. */
  unavailable?: Readonly<SessionUnavailable>;
  /** Reset, Fork and turn checkpoints (#1326). Absent where the session cannot take them; `unavailable` says why. */
  turns?: TurnActions;
  /**
   * Remote only (#1327): a second opinion, Retry in a new chat and the agent
   * handoff, on the session's runtime. Absent on a local session (it hands
   * off on this computer) and where the runtime cannot take them; `unavailable` says why.
   */
  handoff?: HandoffActions;
  /**
   * Where turn cards read what a turn changed when this person may not
   * review it (a viewer, #1326): `keep`, `undo` and `restore` refuse.
   * Absent where no checkpoint can be read; `turns.checkpoints` otherwise.
   */
  checkpoints?: TurnCheckpointApi;
  /** Why this person may not answer permission requests (a shared workspace's non-approver), or null. */
  approveBlockedReason?: string | null;
  /** The workspace client for model discovery, independent of collaboration capabilities. */
  modelClient?: WorkspaceRpcClient | null;
  /**
   * Cloud only, PRO-30: where the workspace's presence, notes and tab leases
   * live, who this person is there (null when sharing does not apply, as on
   * an older runtime), and the connection while it is live with `collab/1`.
   */
  collab?: { key: string; you: WorkspaceYou | null; client: WorkspaceRpcClient | null };
  /**
   * Whether `tab` can switch between its chat and its terminal view here.
   * Absent on a backend made before PRO-86: then only a local session can.
   */
  terminalView?(tab: Pick<TabEntry, "harness">): TerminalViewOffer;
  /** Cloud only: what a tab's terminal view attaches to. */
  agentTerminal?: AgentTerminalTarget;
  /**
   * Cloud only (#644): move a native Codex tab to Codex's own terminal on the
   * same thread, for good, and start it, as opening its terminal view does on
   * a Mac. Refused mid-turn and to anyone who may not start its terminal.
   */
  toTerminal?(tabId: string, transitionId?: string): Promise<boolean | void>;
  /**
   * Cloud only (PRO-22): the slash commands the composer of `tab` offers,
   * from the runtime, which lists a plain driver only what it will accept
   * from them (PRO-88). Null when nothing can list them (a view-only reader,
   * a runtime from before `composer/1`). A local tab's composer asks its CLI.
   */
  commands?(tab: Pick<TabEntry, "id" | "harness">): ComposerCommands | null;
  /**
   * Cloud only (PRO-22): the session's files for the composer's `@` list,
   * searched by the runtime. Null while it is not connected (a stopped
   * workspace is not woken to list files), for a view-only reader, and on a
   * runtime from before `composer/2`.
   */
  files?(): ComposerFiles | null;
  /** Cloud only: commands on their way for a tab, the runtime's queued follow-ups, and resending an unconfirmed one. */
  outbox?: {
    entries(tabId: string): OutboxEntry[];
    followUps(tabId: string): { clientCommandId: string; text: string; actorId?: string | null }[];
    /** Where the workspace stands, for the line under a queued message (#1291); null where nothing says (a machine). */
    workspaceStatus: WorkspaceStatus;
    deciding(requestId: string): boolean;
    sendAgain(entry: OutboxEntry): Promise<void>;
  };
}

const LOCAL_CAPS: SessionBackendCaps = { local: true, write: true, steer: false, images: true, files: true, recovery: true, interrupt: true };
const OFFERED: TerminalViewOffer = { available: true, reason: null };

/** The terminal view switch for `tab` on `backend`: every local tab has one. */
export function terminalViewOf(backend: SessionBackend, tab: Pick<TabEntry, "harness">): TerminalViewOffer {
  return backend.terminalView?.(tab) ?? (backend.caps.local ? OFFERED : { available: false, reason: TERMINAL_VIEW_OLD_RUNTIME });
}

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
    send: async (tabId, text, images, options) => {
      if (!options?.files?.length) return agent.send(sessionId, tabId, text, images, false, options?.pressedAt);
      const stored = await storeOnce(sessionId, options.files);
      return agent.send(sessionId, tabId, text, images, false, options.pressedAt, stored);
    },
    steer: (tabId, text) => agent.send(sessionId, tabId, text, []).then(() => undefined),
    changeHeldQueue: (tabId, change) => agent.changeHeldQueue(sessionId, tabId, change),
    storeFiles: (files) => storeOnce(sessionId, files),
    sendQueuedNow: (tabId, seq) => agent.sendQueuedNow(sessionId, tabId, seq),
    resendUnsent: (tabId) => agent.resendUnsent(sessionId, tabId),
    resendMessage: (tabId, seq) => agent.resendMessage(sessionId, tabId, seq),
    interrupt: (tabId) => agent.interrupt(sessionId, tabId).then(() => undefined),
    stop: (tabId) => agent.stop(sessionId, tabId),
    respondPermission: (tabId, requestId, optionId) => agent.respondPermission(sessionId, tabId, requestId, optionId),
    answerQuestions: (tabId, requestId, answers) => agent.answerQuestions(sessionId, tabId, requestId, answers),
    answerTerminalPrompt: (tabId, promptId, choice) => agent.answerTerminalPrompt(sessionId, tabId, promptId, choice),
    setModel: (tabId, model) => agent.setModel(sessionId, tabId, model),
    setEffort: (tabId, effort) => agent.setEffort(sessionId, tabId, effort),
    setPermissionMode: (tabId, mode) => agent.setPermissionMode(sessionId, tabId, mode),
    markRead: (tabId) => agent.markRead(sessionId, tabId),
    patchTab: (tabId, patch) => patchTab(sessionId, tabId, patch),
    setTabStatus: (tabId, status) => setTabStatus(sessionId, tabId, status),
    terminalView: () => OFFERED,
    turns: localTurnActions(sessionId),
  };
  if (localBackends.size > 256) localBackends.clear();
  localBackends.set(sessionId, backend);
  return backend;
}

/** A local session's Reset and Fork: this computer's runtime, then the window's copy of the tab and the session list. */
function localTurnActions(sessionId: string): TurnActions {
  return {
    checkpoints: localTurnCheckpoints,
    reset: async (tabId, endSeq, resetFiles, confirm) => {
      const warning = await agent.resetChat(sessionId, tabId, endSeq, resetFiles, confirm);
      // Also refresh directly: the window may have missed the owner event.
      const refreshed = await Promise.allSettled([reloadTabHistory(sessionId, tabId), refreshSessions()]);
      if (warning) return warning;
      return refreshed.some((result) => result.status === "rejected") ? "Chat reset. Reopen the tab if its history has not refreshed yet." : null;
    },
    fork: async (tabId, endSeq, into) => {
      const forked = await forkTurn(sessionId, tabId, endSeq, into);
      return { key: forked.session.id, tabId: forked.tabId, note: forked.note ?? null };
    },
  };
}

/**
 * Files already copied into a session's attachments folder, by the composer's
 * own `FileInput` object (PRO-290). A send or hold that fails after its files
 * were stored gives the composer the very same objects back, so trying again
 * reuses those copies instead of storing the files into another new folder.
 */
const storedFiles = new WeakMap<FileInput, { sessionId: string; ref: FileRef }>();

/** Store the files not stored for this session yet, in one new folder, and return every file's reference in order. */
export async function storeOnce(sessionId: string, files: FileInput[]): Promise<FileRef[]> {
  const fresh = files.filter((file) => storedFiles.get(file)?.sessionId !== sessionId);
  if (fresh.length) {
    const refs = await attachments.store(sessionId, fresh);
    if (refs.length !== fresh.length) throw new Error("The attachments folder did not take every file.");
    fresh.forEach((file, index) => storedFiles.set(file, { sessionId, ref: refs[index] }));
  }
  return files.map((file) => storedFiles.get(file)!.ref);
}

/**
 * The first message of a session just created from the new-session screen:
 * it had no session to store files in until now (PRO-290), so they are stored
 * here and go with the message by reference. Without files it is sent exactly
 * as any first prompt was.
 */
export async function sendFirstMessage(sessionId: string, tabId: string, text: string, images?: ImageInput[], files?: FileInput[], promptRequestId?: string): Promise<SendOutcome> {
  // Tell the reader which attachments could not be stored.
  const stored = files?.length ? await storeOnce(sessionId, files).catch((error) => {
    showError(`Couldn't attach ${files.length === 1 ? files[0].name : `${files.length} files`} to the first message`, error);
    throw error;
  }) : undefined;
  return agent.send(sessionId, tabId, text, images, false, undefined, stored, promptRequestId);
}

/** Show the local Create prompt immediately, using the same send and attachment storage as before. */
export async function sendHeldFirstMessage(sessionId: string, tabId: string, text: string, images?: ImageInput[], files?: FileInput[]): Promise<void> {
  const requestId = crypto.randomUUID();
  const finish = showFirstMessage(sessionId, tabId, {
    requestId,
    text,
    images: (images ?? []).map(({ mediaType, data, name }) => ({ url: `data:${mediaType};base64,${data}`, name })),
    files: (files ?? []).map(({ name }) => ({ name })),
    startedAt: Date.now(),
    error: null,
  });
  try {
    const { events } = await sendFirstMessage(sessionId, tabId, text, images, files, requestId);
    events.forEach(applyEvent);
    finish();
  } catch (error) {
    finish(errorMessage(error) || "The agent did not take the message.");
    throw error;
  }
}

// ---- cloud

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
  agentPtySeen.clear();
}

/**
 * Whether each workspace's runtime served `agent-pty/1` when this desktop
 * was last connected to it (PRO-86). A stopped workspace's terminal view
 * switch follows it; nothing is asked of the server to find out.
 */
const agentPtySeen = new Map<string, boolean>();

/** `served` when connected (and remembered); else the last word, or null when there is none. */
export function agentPtyServed(workspaceKey: string, served: boolean | null): boolean | null {
  if (served !== null) agentPtySeen.set(workspaceKey, served);
  return served ?? agentPtySeen.get(workspaceKey) ?? null;
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
  followUps: (tabId: string) => { clientCommandId: string; text: string; actorId?: string | null }[];
  /** The header chip's state, for the line under a queued message (#1291). */
  workspaceStatus?: WorkspaceStatus;
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
  /**
   * PRO-86: whether the runtime serves `agent-pty/1`. While not connected,
   * what it last said; null when it never said (a stopped workspace this
   * desktop has not been connected to): the switch is then offered, and the
   * terminal view only says Stopped.
   */
  agentPty?: boolean | null;
  /** Makes a terminal view's xterm. Without it no terminal view is offered. */
  terminalBase?: () => TerminalInstance;
  /** Whether a tab's CLI runs, as the runtime last said. */
  agentProcess?: (tabId: string) => AgentProcessState | null;
  /** Why a tab's agent cannot sign in, as the runtime last said (see `SessionBackend.signIn`). */
  signIn?: (tabId: string) => AgentTabInfo["signIn"];
}

/** Why reviewing a turn is refused to a reader who may only read it. */
export const REVIEW_NEEDS_ADMIN = "Keeping or undoing a turn's changes needs a workspace admin.";

/** A runtime's checkpoints of a tab's turns (`checkpoints/1`); `review: false` reads them only. */
function remoteTurnCheckpoints(client: WorkspaceRpcClient, review: boolean): TurnCheckpointApi {
  const refuse = () => Promise.reject(new Error(REVIEW_NEEDS_ADMIN));
  return {
    readOnly: !review,
    get: (sessionId, tabId, seq) => client.turnCheckpoint(sessionId, tabId, seq),
    keep: review ? (sessionId, tabId, seq) => client.keepTurn(sessionId, tabId, seq) : refuse,
    undo: review ? (sessionId, tabId, seq, confirmed) => client.undoTurn(sessionId, tabId, seq, confirmed) : refuse,
    restore: review ? (sessionId, tabId, seq, confirmed) => client.restoreUndo(sessionId, tabId, seq, confirmed) : refuse,
  };
}

/**
 * A cloud or machine session's Reset and Fork (#1326), on its runtime. The
 * new history a reset leaves reaches every reader through `session.tabs`
 * (`AgentTabInfo.history`), and a fork's tab or session through the
 * runtime's tab and session lists, as a tab added any other way does.
 */
function cloudTurnActions(ctx: CloudSessionContext, client: WorkspaceRpcClient): TurnActions {
  const sessionKey = (sessionId: string) => `${ctx.key.slice(0, ctx.key.length - ctx.sessionId.length)}${sessionId}`;
  return {
    checkpoints: remoteTurnCheckpoints(client, true),
    reset: async (tabId, endSeq, resetFiles, confirm) => {
      const { warning, tab } = await client.resetAgentTab({ sessionId: ctx.sessionId, tabId, endSeq, resetFiles, confirm });
      // The runtime's own account of the tab, at once: its new history replaces the turns that went.
      if (tab) applyLiveTab(ctx.scope, tab);
      return warning;
    },
    fork: async (tabId, endSeq, into) => {
      const forked = await client.forkAgentTab({ sessionId: ctx.sessionId, tabId, endSeq, into });
      if (forked.tab) applyLiveTab(ctx.scope, forked.tab);
      // Shown at once, as a local fork is: its session (when it is a new one) on its tab.
      const key = sessionKey(forked.sessionId);
      if (key !== ctx.key) selectCloudSession(key);
      selectSessionTab(key, { kind: "agent", id: forked.tabId });
      return { key, tabId: forked.tabId, note: forked.note };
    },
  };
}

/** A remote session's handoffs (#1327): the runtime adds the tab and sends its first prompt, and it is shown at once. */
function cloudHandoff(ctx: CloudSessionContext, client: WorkspaceRpcClient): HandoffActions {
  return {
    open: async ({ prompt, requestId, ...settings }) => {
      // The desktop's Native Codex setting, as a tab added from the "+" menu takes it.
      const nativeCodex = (await experimental.nativeCodexFor(settings.agent)) || undefined;
      const made = await client.handoffAgentTab(ctx.sessionId, { ...settings, nativeCodex, prompt }, requestId);
      if (made.tab) applyLiveTab(ctx.scope, made.tab);
      selectSessionTab(ctx.key, { kind: "agent", id: made.tabId });
      return { tabId: made.tabId, startError: made.startError };
    },
    context: (tabId) => client.handoffContext(ctx.sessionId, tabId),
  };
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
  const agentPty = ctx.agentPty ?? null;
  const terminalBase = ctx.terminalBase;
  // An interrupt is a live call: there is a turn to interrupt only on a runtime that is up.
  const interrupts = write && !!client?.hasCapability("session/3");
  // Reset and Fork (#1326): live calls to a runtime that keeps the turns' checkpoints, by a workspace admin.
  const turnsOff = !client ? TURNS_OFFLINE : !client.hasCapability("checkpoints/1") ? TURNS_OLD_RUNTIME : ctx.authority !== "manage" ? TURNS_NEED_ADMIN : null;
  const turns = !turnsOff && write && client ? cloudTurnActions(ctx, client) : undefined;
  // A second opinion, Retry in a new chat and the agent handoff (#1327): a new tab with its first prompt, by a workspace admin.
  const handoffOff = !client ? HANDOFF_OFFLINE : !client.hasCapability("handoff/1") ? HANDOFF_OLD_RUNTIME : ctx.authority !== "manage" ? HANDOFF_NEED_ADMIN : null;
  const handoff = !handoffOff && write && client ? cloudHandoff(ctx, client) : undefined;
  // Turn cards read what a turn changed while the runtime is up, whoever may read the chat.
  const readsCheckpoints = !!client?.hasCapability("checkpoints/1");
  return {
    kind: "cloud",
    key: ctx.key,
    generation: live ? `${live.runtimeGeneration}:${live.runtimeEpoch ?? ""}:${ctx.connects ?? 0}` : `offline:${ctx.client ? "client" : "none"}`,
    caps: { local: false, write, steer: true, images: !!client?.hasCapability("composer/3"), files: isDevScope(scope) && (!client || client.hasCapability("composer/4")), recovery: false, interrupt: interrupts },
    readOnlyReason,
    approveBlockedReason,
    unavailable: remoteUnavailable(turnsOff, handoffOff),
    turns,
    handoff,
    checkpoints: turns?.checkpoints ?? (readsCheckpoints && client ? remoteTurnCheckpoints(client, false) : undefined),
    collab: { key: ctx.workspaceKey, you, client: ctx.collabClient ?? null },
    logSessionId: ctx.sessionId,
    modelClient: cloudAsleep(ctx.state, ctx.workspaceState) ? null : client,
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
    send: async (tabId, text, images, options) => {
      guard();
      // Files other than images are stored on this computer (PRO-290); a cloud agent takes images only.
      // A machine takes them (PRO-407): they are uploaded to it and stored in the session's attachments folder there.
      const files = options?.files ?? [];
      if (files.length && !isDevScope(scope)) throw new CloudImageError(CLOUD_FILES_REFUSED);
      if (files.length && client?.connection.state === "connected" && !client.hasCapability("composer/4")) throw new CloudImageError(MACHINE_FILES_OLD_RUNTIME);
      // Images are uploaded straight to the runtime (PRO-22): a stopped workspace is started
      // for them, by the same single wake a message asks for, and the message stays in the composer.
      const blocked = images.length ? cloudImagesBlocked(client, cloudAsleep(ctx.state, ctx.workspaceState)) : null;
      if (blocked) {
        if (blocked === CLOUD_IMAGES_NEED_RUNNING) followWake();
        throw new CloudImageError(blocked);
      }
      // Settings chosen while this person could approve are not sent once they cannot: the runtime would ignore them.
      if (!mayConfigure(you)) discardPendingConfig(scope, tabId);
      // Told not to start anything: the server refuses a stopped workspace, and no wake follows from here either.
      if (options?.wake === false) await sendToCloudAgent(scope, tabId, text, client, images, { wake: false, files });
      else await interactive(() => sendToCloudAgent(scope, tabId, text, client, images, { files }));
      return { events: [], queued: true };
    },
    steer: (tabId, text) => interactive(() => steerCloudAgent(scope, tabId, text, client)),
    // Retry and Send again (#1289): the message's own text, as a new message through the mailbox.
    resendMessage: async (tabId, seq) => {
      guard();
      const event = getTabLog(ctx.sessionId, tabId).events.find((candidate) => candidate.seq === seq && candidate.payload.type === "user_message");
      if (!event || event.payload.type !== "user_message") throw new Error(RESEND_MISSING);
      const { text, images, files } = event.payload;
      if (images?.length || files?.length) throw new Error(RESEND_ATTACHMENTS);
      await interactive(() => sendToCloudAgent(scope, tabId, text, client, []));
      return { events: [], queued: true };
    },
    // Never through the mailbox: a queued Escape would land in some later turn. A runtime that cannot take it is left alone.
    interrupt: async (tabId) => {
      guard();
      if (interrupts) await client!.interruptAgentTab({ sessionId: ctx.sessionId, tabId });
    },
    // Stopping needs no compute: a sleeping workspace runs nothing to stop.
    stop: async (tabId) => {
      guard();
      await stopCloudAgent(scope, tabId, client);
    },
    toTerminal: async (tabId, transitionId) => {
      guard();
      if (!client) throw new Error("A tab moves to its terminal once the workspace is connected.");
      return !(await client.moveAgentTabToTerminal(ctx.sessionId, tabId, { transitionId, deferUntilIdle: true })).waitingForTurn;
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
    signIn: (tabId) => {
      const signIn = ctx.signIn?.(tabId);
      return signIn ? { signIn, organizationId: scope.organizationId } : null;
    },
    markRead: (tabId) => markCloudAgentRead(scope, tabId, client),
    patchTab: () => undefined,
    setTabStatus: () => undefined,
    terminalView: (tab) => {
      if (!terminalBase) return { available: false, reason: TERMINAL_VIEW_OLD_RUNTIME };
      if (!isPtyFirst(tab.harness)) return { available: false, reason: TERMINAL_VIEW_NO_TERMINAL };
      // A connected runtime decides. Not connected and never told: offered, and the view says Stopped.
      const served = connected ? !!ctx.client?.hasCapability("agent-pty/1") : agentPty;
      return served === false ? { available: false, reason: TERMINAL_VIEW_OLD_RUNTIME } : OFFERED;
    },
    commands: (tab) =>
      write ? cloudComposerCommands({ workspaceKey: ctx.workspaceKey, sessionId: ctx.sessionId, tabId: tab.id, harness: tab.harness, client, you }) : null,
    files: () => (write ? cloudComposerFiles({ workspaceKey: ctx.workspaceKey, sessionId: ctx.sessionId, client }) : null),
    agentTerminal: terminalBase && {
      workspaceKey: ctx.workspaceKey,
      client: client?.hasCapability("agent-pty/1") ? client : null,
      asleep: cloudAsleep(ctx.state, ctx.workspaceState),
      base: terminalBase,
      process: (tabId) => ctx.agentProcess?.(tabId) ?? null,
      // The same single wake a send asks for; only ever from a keystroke of someone who may type.
      wake: () => {
        if (readOnlyReason) return;
        followWake();
      },
    },
    outbox: {
      entries: (tabId) => ctx.outbox.filter((entry) => entry.tabId === tabId),
      followUps: ctx.followUps,
      workspaceStatus: ctx.workspaceStatus ?? null,
      deciding: (requestId) => isDeciding(scope, requestId),
      sendAgain: (entry) => interactive(() => sendAgain(scope, entry, client)),
    },
  };
}
