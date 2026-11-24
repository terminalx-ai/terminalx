import { MAX_LAUNCH_PROMPT_BYTES, type CloudCredential, type CloudLaunch, type CloudLifecycle, type CloudWorkspace } from "./api";
import { phoneMode, phoneModeLabel, type PhoneMode } from "./agent-settings";
import { LAUNCH_STAGES, RUNTIME_EVENTS, credentialName, failureCause, loginDetail } from "./launch";

export { FIRST_TASK_TOO_LONG, LAUNCH_INVALID } from "./launch";

/**
 * A launch's first task from the phone (PRO-547, board 25.09): which agent
 * the new workspace starts, in which mode, and what it is told first; then
 * where that launch is, by the server's `launch.phase` (contract 19.2), and
 * what the phone says when the agent does not start. The sentences are the
 * desktop's (`src/lib/cloudCreate.ts`), changed only where the desktop names
 * a place the phone does not have.
 */

// ── The form ──

export const FIRST_TASK_PLACEHOLDER = "What should the agent work on? Sent once, when the agent is ready.";
export const NO_AGENT_TICKED = "Tick an agent above to start it in this workspace.";
/** Said under an empty task only once `EMPTY_FIRST_TASK_CHECKED_LIVE` is on (`live-checks.ts`). */
export const EMPTY_FIRST_TASK = "With no first task, the agent starts and waits for your first message.";

/**
 * An agent a first task can start, as the launch form offers it: until the
 * server's setup answer lists the agents a workspace can run, these are the
 * organization's agent logins that are ticked for the workspace, by the
 * runtime's name for each (the login's provider: `claude`, `codex`, `cursor`).
 */
export interface TaskAgent {
  id: string;
  label: string;
  /** Who the login is: beside the agent in its sheet. */
  detail: string;
}

const AGENT_ID = /^[a-z0-9-]{1,32}$/;

/** The ticked logins as agents, in their order, one per agent. */
export function taskAgents(ticked: readonly Pick<CloudCredential, "provider" | "displayIdentity" | "authKind">[]): TaskAgent[] {
  const agents: TaskAgent[] = [];
  for (const login of ticked) {
    if (login.provider === "github" || !AGENT_ID.test(login.provider) || agents.some((agent) => agent.id === login.provider)) continue;
    agents.push({ id: login.provider, label: credentialName(login.provider), detail: loginDetail(login) });
  }
  return agents;
}

/** What the person chose for the first task; the agent is the runtime's name for it. */
export interface FirstTaskDraft {
  agent: string | null;
  mode: PhoneMode;
  text: string;
}

/** The agent the task starts: the chosen one while it is still ticked, else the first ticked one. */
export function taskAgent(chosen: string | null, agents: readonly TaskAgent[]): TaskAgent | null {
  return agents.find((agent) => agent.id === chosen) ?? agents[0] ?? null;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Longer than the server takes: checked on the phone as it is typed. */
export const taskTooLong = (text: string): boolean => bytes(text) > MAX_LAUNCH_PROMPT_BYTES;

/** Whether the task says anything: an empty or blank one is no first prompt. */
export const taskWritten = (text: string): boolean => text.trim() !== "";

/**
 * The first task a launch sends, or nothing when no agent is ticked. The
 * mode is always named and never bypass; the model and effort are left to
 * the agent while the phone has no list of them; the prompt is sent as
 * typed, and left out when it is blank.
 */
export function launchOf(draft: FirstTaskDraft, agents: readonly TaskAgent[]): CloudLaunch | undefined {
  const agent = taskAgent(draft.agent, agents);
  if (!agent) return undefined;
  return { v: 1, agent: agent.id, mode: phoneMode(draft.mode), ...(taskWritten(draft.text) ? { prompt: draft.text } : {}) };
}

/** The review's First task rows. A task is shown in full, however long: it is what will be sent. */
export function taskFacts(launch: CloudLaunch): { label: string; value: string; block?: boolean }[] {
  const model = launch.model ? [launch.model, launch.effort].filter(Boolean).join(" · ") : "Agent’s default";
  return [
    { label: "Agent", value: credentialName(launch.agent) },
    { label: "Model", value: model },
    { label: "Permission mode", value: phoneModeLabel(launch.mode) },
    launch.prompt ? { label: "Task", value: launch.prompt, block: true } : { label: "Task", value: "None" },
  ];
}

/** Where the unsent first task of a launch is kept on the phone, for Launch again after a cancel. */
export const keptTaskKey = (orgId: string, workspaceId: string): string => `cloud:${orgId}:first-task:${workspaceId}`;

// ── Progress ──

type Launch = NonNullable<CloudWorkspace["launch"]>;

/** The launch's phases (contract 19.2) in order, as the page names them. */
export const TASK_PHASE_IDS = ["allocating", "booting", "authenticating-runtime", "syncing-repository", "starting-agent", "running"] as const;
export const TASK_PHASES: readonly string[] = ["Creating the machine", "Installing the runtime", "Connecting to the runtime", "Syncing the repository", "Starting the agent", "Running"];

/** How long a running workspace may leave its first task unclaimed before the page says so (the desktop's `RUNTIME_PICKUP_MS`). */
export const RUNTIME_PICKUP_MS = 2 * 60 * 1000;

export interface TaskProgress {
  /**
   * `launching`: the machine is not running yet, and may be canceled.
   * `starting`: it runs, and the agent is on its way. `failed`: the launch
   * itself failed (25.05's page). `task-failed`, `task-unsure`: the workspace
   * is there, and the first task did not start, or may not have been sent.
   */
  phase: "launching" | "starting" | "canceling" | "canceled" | "failed" | "task-failed" | "task-unsure" | "running";
  /** Where the launch is among `TASK_PHASES`; where it stopped, once it has. */
  stage: number;
  status: "running" | "failed" | "finished";
  /** Under the current phase: the latest event, or why it stopped. */
  detail?: string;
  cancelable: boolean;
  /** The workspace runs, and its runtime has not taken the task for two minutes or more. */
  notPickedUp: boolean;
  /** The agent's login is why it did not start: Agent logins is where that is fixed. */
  signIn: boolean;
  hasPrompt: boolean;
}

/**
 * Whether a listed workspace's first task is still on its way, so its page
 * shows the launch rather than the workspace: claimed by the runtime, or
 * waiting for it no longer than the page waits before saying it was not
 * picked up. One left waiting past that is shown as the workspace.
 */
export function taskUnderWay(launch: CloudWorkspace["launch"], now: number): boolean {
  if (!launch || launch.phase === "running" || launch.phase === "failed" || launch.phase === "canceled") return false;
  if (launch.state === "claimed") return true;
  const ends = taskWaitEnds(launch);
  return ends !== null && now < ends;
}

/** When a listed launch's unclaimed task stops holding its page: twice the pickup wait after it was asked for. */
export function taskWaitEnds(launch: CloudWorkspace["launch"]): number | null {
  const since = launch?.timings?.requestedAt;
  return launch?.state === "pending" && typeof since === "number" ? since + 2 * RUNTIME_PICKUP_MS : null;
}

/** Whether a launch is over: it runs, it did not, or it was canceled. The page stops asking then. */
export function taskSettled(progress: Pick<TaskProgress, "phase">): boolean {
  return progress.phase !== "launching" && progress.phase !== "starting" && progress.phase !== "canceling";
}

const STOPPED_STATES = new Set(["failed", "outcome-unknown", "expired"]);
const UNSURE_CATEGORIES = new Set(["runtime-interrupted", "runtime-storage-replaced", "prompt-send-failed"]);

/** The last phase a launch that stopped had reached, from its timings, as the desktop places its cross. */
function lastReached(launch: Launch, stage: string | null, fallback: number): number {
  const timings = launch.timings;
  if (timings?.startingAgentAt) return 4;
  if (timings?.syncingAt) return 3;
  if (timings?.authenticatingAt) return 2;
  if (timings?.bootingAt) return 1;
  if (stage === "bootstrapping") return 1;
  if (stage === "connecting-relay" || stage === "ready") return 2;
  if (stage === "queued" || stage === "preflight" || stage === "creating-machine") return 0;
  return fallback;
}

/**
 * A launch with a first task as the progress page draws it, from the
 * workspace's `launch` view and the operation. `lastStage` is where it was
 * last seen: a cancel's cleanup is not one of the phases. `now` is the
 * server's clock, for the two minutes a runtime has to take the task.
 */
export function taskProgress(lifecycle: Pick<CloudLifecycle, "operation"> & { workspace: Pick<CloudWorkspace, "state" | "launch"> }, lastStage: number, now: number): TaskProgress {
  const { operation, workspace } = lifecycle;
  const launch: Launch = workspace.launch ?? {};
  const hasPrompt = launch.hasPrompt === true;
  const base = { cancelable: false, notPickedUp: false, signIn: false, hasPrompt };
  const stopped = () => lastReached(launch, operation.stage, lastStage);
  if (launch.phase === "running" || launch.state === "started") return { ...base, phase: "running", stage: TASK_PHASES.length - 1, status: "finished" };
  if (launch.state && STOPPED_STATES.has(launch.state)) {
    const unsure = launch.state === "outcome-unknown" || UNSURE_CATEGORIES.has(launch.category ?? "");
    return { ...base, phase: unsure ? "task-unsure" : "task-failed", stage: stopped(), status: "failed", detail: taskFailure(launch), signIn: !!launch.category && agentLoginFailure(launch.category) };
  }
  if (operation.state === "cancel-requested") return { ...base, phase: "canceling", stage: stopped(), status: "running", detail: "Cleaning up" };
  if (operation.state === "canceled" || launch.phase === "canceled" || launch.state === "canceled") return { ...base, phase: "canceled", stage: stopped(), status: "failed", detail: "Canceled" };
  if (operation.state === "failed" || launch.phase === "failed") return { ...base, phase: "failed", stage: stopped(), status: "failed", detail: failureCause(operation) };
  const at = TASK_PHASE_IDS.indexOf(launch.phase as (typeof TASK_PHASE_IDS)[number]);
  // A phase this app does not know (a newer server's) is shown as under way, where the launch was last seen.
  const stage = at >= 0 ? at : lastReached(launch, operation.stage, lastStage);
  const running = workspace.state === "ready";
  const since = launch.timings?.authenticatingAt ?? (operation.state === "succeeded" ? operation.updatedAt : null) ?? launch.timings?.requestedAt ?? null;
  const notPickedUp = running && launch.state === "pending" && TASK_PHASE_IDS[stage] === "authenticating-runtime" && since !== null && now - since >= RUNTIME_PICKUP_MS;
  return { ...base, phase: running ? "starting" : "launching", stage, status: "running", ...(phaseDetail(lifecycle, stage) ?? {}), cancelable: !running && operation.cancelable, notPickedUp };
}

/** Under a phase while it runs: the operation's finer steps under the first, the runtime's events under the second, the agent under the fifth. */
function phaseDetail({ operation, workspace }: Pick<CloudLifecycle, "operation"> & { workspace: Pick<CloudWorkspace, "launch"> }, stage: number): { detail: string } | null {
  const phase = TASK_PHASE_IDS[stage];
  if (phase === "allocating") {
    const step = operation.stage === "queued" ? LAUNCH_STAGES[0] : operation.stage === "preflight" ? LAUNCH_STAGES[1] : null;
    return step ? { detail: step } : null;
  }
  if (phase === "booting") {
    const latest = operation.events?.length ? operation.events.reduce((newest, event) => (event.occurredAt >= newest.occurredAt ? event : newest)) : null;
    const said = latest ? RUNTIME_EVENTS[latest.code] : undefined;
    return said ? { detail: said } : null;
  }
  if (phase === "starting-agent" && workspace.launch?.agent) return { detail: [credentialName(workspace.launch.agent), workspace.launch.model].filter(Boolean).join(" · ") };
  return null;
}

// ── When the first task does not start ──

/** Where an organization's agent logins are on the phone: the desktop names its Settings path here. */
const AGENT_LOGINS = "Agent logins";
const AGENT_SIGN_IN = `The agent has no working login in this workspace, so the first prompt was not sent. The organization's login for it may be missing, expired, revoked, or limited to workspaces only owners and admins can drive. An owner or admin can see which in ${AGENT_LOGINS}.`;
const EXPIRED = "The workspace took too long to start, and its first prompt expired.";
const DID_NOT_START = "The agent did not start.";

/** The desktop's sentence for each category the runtime and the server report (`cloudCreate.ts` FAILURES), in the phone's words where it names a place. */
const TASK_FAILURES: Record<string, string> = {
  "agent-unavailable": "The agent is not installed in the workspace image.",
  "agent-start-failed": "The agent could not be started.",
  "agent-model-unavailable": "The chosen Claude model is not available in this workspace. Choose a model listed by the workspace's Claude CLI.",
  "agent-sign-in-required": AGENT_SIGN_IN,
  "repository-clone-failed": "A repository could not be cloned.",
  "repository-access-denied": "GitHub refused the clone. Check that the organization's GitHub access covers the repository.",
  "repository-branch-not-found": "The base branch does not exist in the repository.",
  "repository-clone-timed-out": "Cloning a repository took too long or stalled, so it was stopped.",
  "repository-path-occupied": "A folder with the repository's name is already in the workspace and is not that repository. Nothing was changed.",
  "repository-empty": "The repository has no commits yet, so there is nothing to start from.",
  "workspace-disk-full": "The workspace ran out of disk space while cloning a repository.",
  "repository-sync-failed": "A repository could not be switched to its branch.",
  "branch-create-failed": "The work branch could not be created.",
  "runtime-interrupted": "The workspace restarted while starting the agent. The prompt may not have been sent.",
  "runtime-storage-replaced": "The workspace lost its state while starting the agent. The prompt may not have been sent.",
  "payload-invalid": "The launch settings were not accepted by the workspace.",
  "launch-intent-unavailable": "The first prompt could not be read back on the server, so it was not sent.",
  "runtime-unsupported": "This workspace's runtime cannot start agents from a first prompt, so it was not sent. Open the workspace to start the agent yourself.",
  // The runtime reports it (`cloud_agents/launch.rs`): the agent's tab exists, and the prompt may or may not have reached it.
  "prompt-send-failed": "The agent started, but the first task may not have reached it.",
};

/** A category about the agent's login, from a runtime's report or a service error (the desktop's `agentLoginFailure`). */
export function agentLoginFailure(code: string): boolean {
  return code === "agent-sign-in-required" || /agent[-_]credential|^credential[-_](required|missing|invalid|expired|revoked|reauth)/.test(code);
}

/** Why a first task did not start, in one sentence. The phone never shows a category's code. */
export function taskFailure(launch: Pick<Launch, "state" | "category">): string {
  // The category first, as the desktop's `failureMessage` reads it.
  const category = launch.category;
  if (category) return agentLoginFailure(category) ? AGENT_SIGN_IN : TASK_FAILURES[category] ?? DID_NOT_START;
  return launch.state === "expired" ? EXPIRED : DID_NOT_START;
}

export const TASK_HEAD = { starting: "Starting the agent…", failed: "The first task did not start", unsure: "The first task may not have been sent" } as const;
export const TASK_NOTE = {
  next: "The workspace is running. The agent starts next, and the conversation opens by itself.",
  working: "The agent is working on the first task. Opening it in a moment…",
  ready: "The agent is ready. Opening it in a moment…",
  canceled: "The machine was removed and the first prompt was not sent. Launching again asks for a new price.",
  kept: "The first task is kept: it is sent once the workspace runs.",
} as const;
/** After two minutes with the task unclaimed (the desktop's `RUNTIME_NOT_PICKED_UP`, with the phone's word for where to go). */
export const TASK_NOT_PICKED_UP = "The workspace is ready, but its runtime has not picked up the first task. It may not support starting agents from a first prompt. Open the workspace to start the agent yourself.";
/** What a first task that did not start leaves, approved by the owner on 2026-11-24. */
export const TASK_LEFT = "The workspace itself is running, with no conversation. It is billed to the organization while it runs.";
/** The same, when the task may have reached the agent after all (25.09). */
export const TASK_UNSURE_LEFT = "The workspace itself is running. Open it to see whether the agent has the task. It is billed to the organization while it runs.";
