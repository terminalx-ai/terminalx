import { useSyncExternalStore } from "react";
import { WorkspaceRpcError, type MachineAgentSetupRun, type MachineAgentSetupStep, type PtyAttachment, type RuntimeAgentsReport, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { errorMessage } from "@/lib/api";
import { afterExit, type SetupProblem } from "@/lib/agentSetupFlow";
import { readMachineAgents } from "@/lib/machineAgents";
import { createTerminal } from "@/components/terminal/TerminalView";
import { disposeInstance, getInstance, type TerminalInstance } from "@/lib/terminal";
import {
  acknowledgeTerminalResize,
  coordinateTerminalResize,
  followTerminalOutputSize,
  isOutputResize,
  requestTerminalResize,
  stopTerminalOutput,
  writeTerminalOutput,
} from "@/lib/terminalOutput";

/**
 * Installing an agent or signing in to it on a machine (PRO-350, `machine/4`),
 * from its page in Settings → Machines. The same flow as on this Mac
 * (`src/lib/agentSetupFlow.ts`), with the terminal on the machine:
 *
 * - The caller names only the agent and the step (`machine.agentSetup`); the
 *   command is the machine's own, and nothing of this Mac (key, token, file
 *   or environment) is sent.
 * - The terminal shows inside the page under the agent's row until it exits.
 *   Its exit code says how (`SETUP_EXIT`, read by `afterExit`); the page then
 *   reads `runtime.agents` with `refresh` and says what the probe says. The
 *   exit code alone is never taken as signed in.
 * - One step at a time per agent there: a start refused with `setup_busy`
 *   follows the run that is going instead, when the refusal names one (a
 *   terminal this computer can attach to); a run in the machine's own window
 *   is not named, and the refusal's message is shown.
 */
export type MachineSetupFlow =
  | { phase: "running"; step: MachineAgentSetupStep; ptyId: string; terminal: string }
  | { phase: "checking"; step: MachineAgentSetupStep; ptyId: string; terminal: string }
  | { phase: "failed"; step: MachineAgentSetupStep; ptyId: string | null; terminal: string | null; problem: SetupProblem; detail?: string; busy?: boolean };

let flows: Record<string, MachineSetupFlow> = {};
const listeners = new Set<() => void>();
const keyOf = (machineId: string, harness: string) => `${machineId}\u0000${harness}`;

function put(key: string, flow: MachineSetupFlow | null) {
  const next = { ...flows };
  if (flow) next[key] = flow;
  else delete next[key];
  flows = next;
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useMachineSetupFlow(machineId: string, harness: string): MachineSetupFlow | null {
  const key = keyOf(machineId, harness);
  return useSyncExternalStore(subscribe, () => flows[key] ?? null, () => flows[key] ?? null);
}

export function getMachineSetupFlow(machineId: string, harness: string): MachineSetupFlow | null {
  return flows[keyOf(machineId, harness)] ?? null;
}

/** The xterm id of a setup terminal: distinct from every local pane and cloud terminal id. */
export function setupTerminalId(machineId: string, ptyId: string): string {
  return `machine-setup:${machineId}:${ptyId}`;
}

/** The size a setup terminal starts at, as on this Mac; the view fits it once it shows. */
export const SETUP_SIZE = { cols: 100, rows: 14 };

// ------------------------------------------------------------------ the terminal

const attachments = new Map<string, PtyAttachment>();

const mode = (): "dark" | "light" => (typeof document !== "undefined" && document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark");

/**
 * The xterm for a setup terminal on the machine: what is typed goes to the
 * machine's terminal (`pty.write`), and the view's size to `pty.resize`.
 */
export function setupTerminalFactory(client: WorkspaceRpcClient, ptyId: string): (shade?: "dark" | "light") => TerminalInstance {
  return (shade = mode()) => {
    const instance = createTerminal(shade);
    instance.term.onData((data) => void client.write(ptyId, data).catch(() => undefined));
    coordinateTerminalResize(instance.term, ({ cols, rows }) => client.resizePty(ptyId, cols, rows).then(() => acknowledgeTerminalResize(instance.term, { cols, rows })));
    instance.term.onResize((size) => {
      if (!isOutputResize(instance.term)) requestTerminalResize(instance.term, size);
    });
    const release = instance.release;
    instance.release = () => {
      stopTerminalOutput(instance.term);
      release?.();
    };
    return instance;
  };
}

function detach(terminal: string) {
  attachments.get(terminal)?.detach();
  attachments.delete(terminal);
}

/** Done with a run's terminal: stop its stream and drop its view. */
function release(flow: MachineSetupFlow | null | undefined) {
  if (!flow?.terminal) return;
  detach(flow.terminal);
  disposeInstance(flow.terminal);
}

async function attach(key: string, machineId: string, client: WorkspaceRpcClient, ptyId: string) {
  const terminal = setupTerminalId(machineId, ptyId);
  const make = setupTerminalFactory(client, ptyId);
  const instance = getInstance(terminal, () => make());
  const attachment = await client.attachPty(ptyId, {
    onData: (bytes, _offset, _replay, size) => writeTerminalOutput(instance.term, bytes, size),
    onResize: (cols, rows) => followTerminalOutputSize(instance.term, { cols, rows }),
    onExit: (code) => void exited(key, client, ptyId, code),
    onGone: () => void exited(key, client, ptyId, null),
  });
  const flow = flows[key];
  // Hidden or canceled while it attached.
  if (!flow || flow.ptyId !== ptyId) {
    attachment.detach();
    return;
  }
  attachments.set(terminal, attachment);
}

// ------------------------------------------------------------------ the flow

/** What a refreshed reading says after a step that exited 0. */
export function afterMachineCheck(step: MachineAgentSetupStep, harness: string, report: RuntimeAgentsReport | null): { done: true } | { done: false; problem: SetupProblem } {
  const agent = report?.agents.find((entry) => entry.id === harness) ?? null;
  if (!agent) return { done: false, problem: "not_found" };
  // Installed: the row now offers Sign in. Signed in, or a sign-in the CLI cannot tell: the row says which.
  if (step === "install" || agent.signIn !== "signedOut") return { done: true };
  return { done: false, problem: "login" };
}

async function exited(key: string, client: WorkspaceRpcClient, ptyId: string, code: number | null) {
  const flow = flows[key];
  if (!flow || flow.phase !== "running" || flow.ptyId !== ptyId) return;
  // The same reading of an exit code as on this Mac.
  const next = afterExit({ phase: "running", step: flow.step, pane: flow.terminal, chain: false }, code);
  if (next.phase === "failed") {
    put(key, { phase: "failed", step: flow.step, ptyId, terminal: flow.terminal, problem: next.problem });
    void readMachineAgents(client, true);
    return;
  }
  const checking: MachineSetupFlow = { phase: "checking", step: flow.step, ptyId, terminal: flow.terminal };
  put(key, checking);
  const report = await readMachineAgents(client, true);
  if (flows[key] !== checking) return;
  const harness = key.slice(key.indexOf("\u0000") + 1);
  const result = afterMachineCheck(flow.step, harness, report);
  if (result.done) {
    put(key, null);
    release(checking);
  } else put(key, { phase: "failed", step: flow.step, ptyId, terminal: flow.terminal, problem: result.problem });
}

/** A `setup_busy` refusal's run, else null. */
export function busyRun(error: unknown): MachineAgentSetupRun | null {
  if (!(error instanceof WorkspaceRpcError) || error.code !== "setup_busy") return null;
  const data = error.data as Partial<MachineAgentSetupRun> | undefined;
  return data && typeof data.ptyId === "string" && (data.step === "install" || data.step === "login") ? { ptyId: data.ptyId, step: data.step } : null;
}

async function follow(key: string, machineId: string, client: WorkspaceRpcClient, run: MachineAgentSetupRun) {
  const terminal = setupTerminalId(machineId, run.ptyId);
  put(key, { phase: "running", step: run.step, ptyId: run.ptyId, terminal });
  try {
    await attach(key, machineId, client, run.ptyId);
  } catch (error) {
    if (flows[key]?.ptyId !== run.ptyId) return;
    put(key, { phase: "failed", step: run.step, ptyId: null, terminal: null, problem: "start", detail: errorMessage(error) });
    disposeInstance(terminal);
  }
}

/**
 * Install the agent on the machine, or sign in to it there, in a terminal
 * on the machine. A run already under way for the agent is left alone; one
 * started elsewhere (another computer, the machine's own window) is followed.
 */
export async function startMachineAgentSetup(machineId: string, client: WorkspaceRpcClient, harness: string, step: MachineAgentSetupStep): Promise<void> {
  const key = keyOf(machineId, harness);
  const current = flows[key];
  if (current?.phase === "running" || current?.phase === "checking") return;
  release(current);
  // Starting: no terminal yet. Shown as running so the button cannot start a second one.
  const starting: MachineSetupFlow = { phase: "running", step, ptyId: "", terminal: "" };
  put(key, starting);
  try {
    const info = await client.startAgentSetup({ harness, step, cols: SETUP_SIZE.cols, rows: SETUP_SIZE.rows });
    if (flows[key] !== starting) {
      // Canceled while it started: it would run out of sight.
      void client.killPty(info.ptyId).catch(() => undefined);
      return;
    }
    await follow(key, machineId, client, { ptyId: info.ptyId, step: info.setup?.step ?? step });
  } catch (error) {
    if (flows[key] !== starting) return;
    const run = busyRun(error);
    if (run) {
      await follow(key, machineId, client, run);
      return;
    }
    // Busy with a run this computer cannot attach to (the machine's own window runs it): its message says so.
    const busy = error instanceof WorkspaceRpcError && error.code === "setup_busy";
    put(key, { phase: "failed", step, ptyId: null, terminal: null, problem: "start", detail: errorMessage(error), ...(busy ? { busy: true } : {}) });
  }
}

/**
 * Follow the steps that run on the machine already, for agents this window
 * shows none of: the page was opened again, or another computer started one.
 */
export async function followMachineAgentSetups(machineId: string, client: WorkspaceRpcClient, harnesses: readonly string[]): Promise<void> {
  await Promise.all(
    harnesses.map(async (harness) => {
      const key = keyOf(machineId, harness);
      if (flows[key]) return;
      const run = await client.agentSetupRunning(harness).catch(() => null);
      if (run && !flows[key]) await follow(key, machineId, client, run);
    }),
  );
}

/** Stop the running step on the machine: no failure is shown, and its terminal goes. */
export function cancelMachineAgentSetup(machineId: string, client: WorkspaceRpcClient | null, harness: string) {
  const key = keyOf(machineId, harness);
  const flow = flows[key];
  if (!flow) return;
  put(key, null);
  if (flow.phase === "running" && flow.ptyId) void client?.killPty(flow.ptyId).catch(() => undefined);
  release(flow);
}

/** Put a failed run's output away. */
export function dismissMachineAgentSetup(machineId: string, harness: string) {
  const key = keyOf(machineId, harness);
  const flow = flows[key];
  if (flow?.phase !== "failed") return;
  put(key, null);
  release(flow);
}

/** For tests: forget every run. */
export function resetMachineAgentSetupForTests() {
  for (const flow of Object.values(flows)) release(flow);
  flows = {};
  for (const listener of [...listeners]) listener();
}
