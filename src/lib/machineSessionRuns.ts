import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MachineAction, MachineActionOutcome, MachineSessionActions, MachineSetupRun, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { syncCloudTerminals, type CloudTerminal } from "@/lib/cloudTerminals";
import type { createTerminal } from "@/components/terminal/TerminalView";

/**
 * A machine session's Setup and Run (`machine/7`, PRO-403, docs/MACHINES.md
 * "As built (PRO-403 to PRO-408)"), as data for the Run menu, the Open button
 * and the dock's Setup and Run tabs to show.
 *
 * Everything is the machine's: its project's saved actions, preview URLs and
 * setup script are read there (`machine.sessionActions`), each run is a pane
 * of the machine runtime's own action runner or workspace setup, in the
 * session's folder there, and `pty.list` lists it with its session and its
 * `run`, so it is one of the session's terminals here. A preview's `$PORT` is
 * the machine's port. Nothing runs on this computer.
 */

/** The namespace that serves it. */
export const MACHINE_RUNS = "machine/7";
/** How often a setup that is still going is read again: its status is not pushed. */
export const SETUP_POLL_MS = 2_000;

/** One action's run on the machine, by its terminal. */
export interface MachineScriptRun {
  actionId: string;
  name: string;
  /** The machine's pane id: what `pty.attach` and `pty.kill` name. */
  ptyId: string;
  /** The terminal's id in this window's terminal store (`cloudTerminals`): what selects it in the dock. */
  terminalId: string;
  state: "running" | "exited";
  exitCode: number | null;
  /** When the machine opened it (ms since the epoch); 0 when not said. */
  createdAt: number;
}

/** What `CloudSessionModel.scripts` is for a machine session. */
export interface MachineSessionScripts {
  /** The machine granted `machine/7` on this connection; without it there is nothing to run, and the rest is empty. */
  served: boolean;
  /** The session's actions, previews, setup script, ports and latest setup attempt, as last read on the machine. */
  info: MachineSessionActions | null;
  /** The last read failed, in the machine's words. */
  error: string | null;
  /** Saved actions the Run menu offers: not hidden, and none once the worktree is gone. */
  actions: MachineAction[];
  /** Every action run's terminal, oldest first. */
  runs: MachineScriptRun[];
  /** The latest run of each action: what the Run menu marks running and Restart replaces. */
  latestRuns: MachineScriptRun[];
  /** The latest setup attempt's terminal (its id in this window's store), while the machine keeps it. */
  setupTerminalId: string | null;
  /** Why nothing can be started now (not connected, not a manager, not served); null when it can. */
  blocked: string | null;
  /** Read it again from the machine. */
  refresh(): Promise<void>;
  /**
   * Run a saved action in a terminal of the session on the machine. A
   * non-concurrent action already running there is answered `started: false`
   * with that run; `restart` replaces it. The terminal is listed here before
   * this resolves.
   */
  run(actionId: string, options?: { restart?: boolean }): Promise<MachineActionOutcome>;
  /** Run the session's setup script again on the machine. */
  rerunSetup(): Promise<MachineSetupRun | null>;
  /** Stop the setup attempt that is going on the machine. */
  stopSetup(): Promise<MachineSetupRun | null>;
}

/** Whether a setup attempt is still going, and so worth reading again. */
export function setupSettling(setup: MachineSetupRun | null | undefined): boolean {
  return !!setup && (setup.status === "pending" || setup.status === "running" || setup.status === "stopping");
}

/** The session's action runs among its terminals, oldest first; closed ones are left out. */
export function scriptRunsOf(terminals: readonly CloudTerminal[]): MachineScriptRun[] {
  return terminals
    .filter((terminal) => terminal.run?.kind === "action" && !terminal.gone)
    .map((terminal) => {
      const run = terminal.run as { kind: "action"; actionId: string; name: string };
      return {
        actionId: run.actionId,
        name: run.name,
        ptyId: terminal.ptyId,
        terminalId: terminal.id,
        state: terminal.exited ? ("exited" as const) : ("running" as const),
        exitCode: terminal.exited ? terminal.exitCode : null,
        createdAt: terminal.createdAt ?? 0,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The newest run of each action, in the order the actions first ran. */
export function latestRunsOf(runs: readonly MachineScriptRun[]): MachineScriptRun[] {
  const latest = new Map<string, MachineScriptRun>();
  for (const run of runs) latest.set(run.actionId, run);
  return [...latest.values()];
}

/**
 * The terminal of the setup attempt the machine reports: by its pane when one
 * is reported, else the newest setup terminal listed.
 */
export function setupTerminalOf(terminals: readonly CloudTerminal[], setup: MachineSetupRun | null | undefined): string | null {
  const listed = terminals.filter((terminal) => terminal.run?.kind === "setup" && !terminal.gone).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  if (setup?.paneId) return listed.find((terminal) => terminal.ptyId === setup.paneId)?.id ?? null;
  return listed.at(-1)?.id ?? null;
}

/** Why a session's scripts cannot be started now; null when they can. */
export function scriptsBlocked(input: { name: string; connected: boolean; manage: boolean; served: boolean; available: boolean }): string | null {
  if (!input.connected) return `Can't run until ${input.name} is back`;
  if (!input.served) return `${input.name} runs an older TerminalX without Setup and Run for its sessions. Update it to run them from here.`;
  if (!input.manage) return `Only a computer paired with ${input.name} runs its scripts`;
  if (!input.available) return "This session's worktree was removed; nothing runs in it.";
  return null;
}

/**
 * The model's `scripts`: read on each connect, again whenever one of the
 * session's runs starts or ends, and every {@link SETUP_POLL_MS} while its
 * setup is going.
 */
export function useMachineSessionScripts(input: {
  client: WorkspaceRpcClient | null;
  connected: boolean;
  manage: boolean;
  name: string;
  /** The session's id on the machine. */
  sessionId: string;
  /** Changes on each connect. */
  generation: string | null;
  /** The connection's terminal store key, and the session's terminals in it. */
  workspaceKey: string;
  terminals: readonly CloudTerminal[];
  terminalBase: () => ReturnType<typeof createTerminal>;
}): MachineSessionScripts {
  const { client, connected, manage, name, sessionId, generation, workspaceKey, terminals, terminalBase } = input;
  const served = connected && !!client && client.hasCapability(MACHINE_RUNS);
  const [read, setRead] = useState<{ sessionId: string; info: MachineSessionActions | null; error: string | null }>({ sessionId, info: null, error: null });
  const own = read.sessionId === sessionId ? read : { sessionId, info: null, error: null };
  const inflight = useRef<Promise<void> | null>(null);
  const live = useRef({ client, sessionId, served });
  live.current = { client, sessionId, served };

  const refresh = useCallback(async () => {
    const { client: current, sessionId: id, served: now } = live.current;
    if (!now || !current || !id) return;
    if (inflight.current) return inflight.current;
    const reading = current
      .sessionActions(id)
      .then((info) => {
        if (live.current.sessionId === id) setRead({ sessionId: id, info, error: null });
      })
      .catch((cause: unknown) => {
        if (live.current.sessionId === id) setRead((last) => ({ sessionId: id, info: last.sessionId === id ? last.info : null, error: cause instanceof Error ? cause.message : String(cause) }));
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = reading;
    return reading;
  }, []);

  const runs = useMemo(() => scriptRunsOf(terminals), [terminals]);
  // A run started, ended or closed, or a setup pane come or gone, is a reason to read again.
  const signature = useMemo(
    () =>
      terminals
        .filter((terminal) => terminal.run && !terminal.gone)
        .map((terminal) => `${terminal.ptyId}:${terminal.exited ? 1 : 0}`)
        .join(","),
    [terminals],
  );
  useEffect(() => {
    if (served && generation) void refresh();
  }, [served, generation, sessionId, signature, refresh]);
  const going = setupSettling(own.info?.setup);
  useEffect(() => {
    if (!served || !going) return;
    const timer = setInterval(() => void refresh(), SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [served, going, refresh]);

  const available = own.info?.available !== false;
  const blocked = scriptsBlocked({ name, connected: connected && !!client, manage, served, available });
  const listAgain = useCallback(async () => {
    if (client) await syncCloudTerminals(workspaceKey, client, terminalBase).catch(() => undefined);
  }, [client, workspaceKey, terminalBase]);
  const guard = useCallback(() => {
    if (blocked || !client) throw new Error(blocked ?? `Can't run until ${name} is back`);
    return client;
  }, [blocked, client, name]);

  const run = useCallback(
    async (actionId: string, options: { restart?: boolean } = {}) => {
      const outcome = await guard().runAction(sessionId, actionId, options.restart ?? false);
      // Listed now, so the dock can show it at once rather than at the next poll.
      await listAgain();
      return outcome;
    },
    [guard, sessionId, listAgain],
  );
  const rerunSetup = useCallback(async () => {
    const setup = await guard().rerunSetup(sessionId);
    await Promise.all([refresh(), listAgain()]);
    return setup;
  }, [guard, sessionId, refresh, listAgain]);
  const paneId = own.info?.setup?.paneId ?? null;
  const stopSetup = useCallback(async () => {
    const current = guard();
    if (!paneId) return own.info?.setup ?? null;
    const setup = await current.stopSetup(sessionId, paneId);
    await Promise.all([refresh(), listAgain()]);
    return setup;
  }, [guard, paneId, sessionId, refresh, listAgain, own.info?.setup]);

  return useMemo(
    () => ({
      served,
      info: served ? own.info : null,
      error: served ? own.error : null,
      actions: served && available ? (own.info?.actions ?? []).filter((action) => !action.hidden) : [],
      runs,
      latestRuns: latestRunsOf(runs),
      setupTerminalId: setupTerminalOf(terminals, own.info?.setup),
      blocked,
      refresh,
      run,
      rerunSetup,
      stopSetup,
    }),
    [served, own.info, own.error, available, runs, terminals, blocked, refresh, run, rerunSetup, stopSetup],
  );
}
