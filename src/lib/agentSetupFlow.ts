import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { agentSetup, errorMessage, pty, type AgentSetupStep } from "@/lib/api";
import { announceReadiness, checkAgentReadiness, type AgentReadiness } from "@/lib/agentReadiness";
import { refreshHarnesses } from "@/lib/sessions";
import { disposeInstance, peekInstance } from "@/lib/terminal";

/**
 * Installing an agent and signing in to it from inside the app (PRO-152).
 *
 * "Install and sign in" runs the agent's official installer in an embedded
 * terminal, then its own sign-in in the same one, and checks readiness after
 * each: nothing is claimed from an exit code alone. The flow is this
 * window's, one per agent, so the welcome screen, Settings › Agents and the
 * new-session view all show the same run wherever it was started.
 *
 * The backend makes each step's command (`src-tauri/src/harness/setup.rs`);
 * the pane's exit code says how it ended ({@link SETUP_EXIT}).
 */
export type SetupProblem =
  /** A folder the installer writes is not writable. */
  | "permission"
  /** The provider could not be reached. */
  | "offline"
  /** The installer could not be downloaded, or was not one. */
  | "download"
  /** The installer ran and failed. */
  | "install"
  /** The sign-in did not finish. */
  | "login"
  /** A step finished but the CLI is not to be found. */
  | "not_found"
  /** The step could not be started at all. */
  | "start";

export type AgentSetupFlow =
  /** Nothing running: a run was canceled or ended without an answer either way. */
  | { phase: "idle" }
  | { phase: "running"; step: AgentSetupStep; pane: string; chain: boolean }
  | { phase: "checking"; step: AgentSetupStep; pane: string; chain: boolean }
  | { phase: "failed"; step: AgentSetupStep; pane: string | null; chain: boolean; problem: SetupProblem; detail?: string }
  | { phase: "done" };

/** The wrapper's exit codes (`harness::setup::exit` in the backend). */
export const SETUP_EXIT = { permission: 70, offline: 71, download: 72, install: 73, login: 74 } as const;

/** What a step's exit means for the flow. A canceled step is no failure. */
export function afterExit(flow: AgentSetupFlow, code: number | null): AgentSetupFlow {
  if (flow.phase !== "running") return flow;
  const { step, pane, chain } = flow;
  if (code === 0) return { phase: "checking", step, pane, chain };
  const problem: SetupProblem =
    code === SETUP_EXIT.permission ? "permission"
    : code === SETUP_EXIT.offline ? "offline"
    : code === SETUP_EXIT.download ? "download"
    : step === "install" ? "install" : "login";
  return { phase: "failed", step, pane, chain, problem };
}

/**
 * What a readiness check after a step means: the next step, done, or why
 * not. Installing leads to sign-in when the run was "Install and sign in".
 */
export function afterCheck(flow: AgentSetupFlow, readiness: AgentReadiness): AgentSetupFlow {
  if (flow.phase !== "checking") return flow;
  const { step, pane, chain } = flow;
  switch (readiness.state) {
    case "ready":
      return { phase: "done" };
    case "missing":
      return { phase: "failed", step, pane, chain, problem: "not_found" };
    case "signed_out":
      if (step === "install") return chain ? { phase: "running", step: "login", pane, chain } : { phase: "idle" };
      return { phase: "failed", step, pane, chain, problem: "login" };
    default:
      // Installed, and the login cannot be told: Sign in stays on offer.
      return { phase: "idle" };
  }
}

/** Whether the flow is doing something, or has something to say about it. */
export function setupActive(flow: AgentSetupFlow | null | undefined): flow is Extract<AgentSetupFlow, { phase: "running" | "checking" | "failed" }> {
  return !!flow && (flow.phase === "running" || flow.phase === "checking" || flow.phase === "failed");
}

let flows: Record<string, AgentSetupFlow> = {};
const listeners = new Set<() => void>();
function put(harness: string, flow: AgentSetupFlow) {
  flows = { ...flows, [harness]: flow };
  for (const listener of listeners) listener();
}
const subscribe = (changed: () => void) => {
  listeners.add(changed);
  return () => { listeners.delete(changed); };
};

/** Every agent's flow in this window, by agent id. */
export function useAgentSetupFlows(): Record<string, AgentSetupFlow> {
  return useSyncExternalStore(subscribe, () => flows, () => flows);
}

export function useAgentSetupFlow(harness: string): AgentSetupFlow | null {
  return useSyncExternalStore(subscribe, () => flows[harness] ?? null, () => flows[harness] ?? null);
}

export function getAgentSetupFlow(harness: string): AgentSetupFlow | null {
  return flows[harness] ?? null;
}

let exits: Promise<void> | null = null;
/** Exits of setup panes, heard before the first step starts so none is missed. */
function hearExits(): Promise<void> {
  exits ??= listen<{ id: string; code: number | null }>("pty_exit", (event) => {
    const { id, code } = event.payload;
    if (!id.startsWith("setup:")) return;
    const harness = Object.keys(flows).find((key) => { const flow = flows[key]; return flow.phase === "running" && flow.pane === id; });
    if (!harness) return; // canceled, or another window's
    const next = afterExit(flows[harness], code);
    put(harness, next);
    if (next.phase === "checking") void check(harness);
  }).then(() => {}, () => {});
  return exits;
}

const SIZE = { cols: 100, rows: 14 };

async function run(harness: string, step: AgentSetupStep, pane: string, chain: boolean) {
  put(harness, { phase: "running", step, pane, chain });
  await hearExits();
  try {
    // The view has been laid out by now when it was already showing the pane.
    const term = peekInstance(pane)?.term;
    await agentSetup.start(pane, harness, step, term?.cols ?? SIZE.cols, term?.rows ?? SIZE.rows);
    // A view that fitted the terminal before the pane existed told nobody.
    const fitted = peekInstance(pane)?.term;
    if (fitted) void pty.resize(pane, fitted.cols, fitted.rows).catch(() => {});
  } catch (cause) {
    const flow = flows[harness];
    if (flow?.phase === "running" && flow.pane === pane) put(harness, { phase: "failed", step, pane, chain, problem: "start", detail: errorMessage(cause) });
  }
}

/** How long to wait before asking again about a CLI that was just installed. */
const RECHECK_AFTER_INSTALL_MS = 1500;

/**
 * Readiness after a step. A CLI's first run after its install can stumble
 * (its new home still being set up by another of its processes): a login
 * that cannot be read then is asked about again before the sign-in that
 * should follow is given up on.
 */
async function readinessAfter(harness: string, step: AgentSetupStep): Promise<AgentReadiness> {
  let value = await checkAgentReadiness(harness);
  for (let tries = 0; step === "install" && value.state === "unknown" && tries < 2; tries++) {
    await new Promise((resolve) => setTimeout(resolve, RECHECK_AFTER_INSTALL_MS));
    value = await checkAgentReadiness(harness);
  }
  return value;
}

async function check(harness: string) {
  // The welcome screen reads installation from the harness list.
  try { await refreshHarnesses(); } catch { /* readiness below still answers */ }
  const checking = flows[harness];
  if (checking?.phase !== "checking") return;
  const value = await readinessAfter(harness, checking.step);
  announceReadiness(harness, value);
  // Canceled, or begun again, while it was being checked.
  const flow = flows[harness];
  if (flow !== checking) return;
  const next = afterCheck(flow, value);
  if (next.phase === "running") {
    await run(harness, next.step, next.pane, next.chain);
    return;
  }
  put(harness, next);
  if (next.phase === "done" || next.phase === "idle") release(flow.pane);
}

/** The pane and its terminal are done with: the next run starts a new one. */
function release(pane: string | null) {
  if (!pane) return;
  void pty.kill(pane).catch(() => {});
  disposeInstance(pane);
}

let runs = 0;
const newPane = (harness: string) => `setup:${harness}:${Date.now().toString(36)}${(++runs).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Install the agent's CLI (and sign in after it, with `chain`), or only sign
 * in. A run already under way for the agent is left alone.
 */
export function startAgentSetup(harness: string, step: AgentSetupStep, { chain = false }: { chain?: boolean } = {}): Promise<void> {
  const flow = flows[harness];
  if (flow?.phase === "running" || flow?.phase === "checking") return Promise.resolve();
  if (flow?.phase === "failed") release(flow.pane);
  return run(harness, step, newPane(harness), chain);
}

/**
 * Try the failed step again, in the same terminal: its output stays above
 * the new attempt. A CLI that was not found is only looked for again.
 */
export function retryAgentSetup(harness: string): Promise<void> {
  const flow = flows[harness];
  if (flow?.phase !== "failed") return Promise.resolve();
  if (flow.problem === "not_found" && flow.pane) {
    put(harness, { phase: "checking", step: flow.step, pane: flow.pane, chain: flow.chain });
    return check(harness);
  }
  return run(harness, flow.step, flow.pane ?? newPane(harness), flow.chain);
}

/** Stop the step that is running: no failure, nothing left behind. */
export function cancelAgentSetup(harness: string) {
  const flow = flows[harness];
  if (!setupActive(flow)) return;
  put(harness, { phase: "idle" });
  release(flow.pane);
}

/** Put a failed run's output away. */
export const dismissAgentSetup = cancelAgentSetup;

/** For tests: forget every flow. */
export function resetAgentSetupFlows() {
  flows = {};
  exits = null;
  for (const listener of listeners) listener();
}
