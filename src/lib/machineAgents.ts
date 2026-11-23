import { useEffect, useSyncExternalStore } from "react";
import type { RuntimeAgentSignIn, RuntimeAgentsReport, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { errorMessage } from "@/lib/api";
import { refreshRuntimeModels } from "@/lib/cloudModels";

/**
 * A machine's agents as its page shows them (PRO-350, docs/MACHINES.md "As
 * built (PRO-350): the machine page"): `runtime.agents` with each agent's
 * version and sign-in, and the agents it has no CLI for. One reading per
 * connection, shared by the page and its setup runs; nothing survives a
 * reconnect. An older runtime answers without sign-in states or missing
 * agents, and its agents are shown without a state.
 */
export interface MachineAgentsSnapshot {
  report: RuntimeAgentsReport | null;
  /** Why the last read failed; the report before it stays. */
  error: string | null;
  loading: boolean;
}

const EMPTY: MachineAgentsSnapshot = { report: null, error: null, loading: false };

class AgentsReading {
  snapshot: MachineAgentsSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private unwatch: (() => void) | null = null;
  private link: unknown = null;
  private pending: Promise<RuntimeAgentsReport | null> | null = null;

  constructor(private client: WorkspaceRpcClient) {}

  get = () => this.snapshot;

  private set(patch: Partial<MachineAgentsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.unwatch) {
      this.unwatch = this.client.onState((state) => {
        // A new connection (or a runtime that restarted) says nothing the last one did.
        if (state.state !== "connected") return;
        if (this.link === state) return;
        this.link = state;
        this.snapshot = EMPTY;
        this.pending = null;
        void this.read(false);
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.unwatch?.();
        this.unwatch = null;
        this.link = null;
      }
    };
  };

  /** Ask now; `refresh` makes the runtime read the sign-ins again instead of answering from its minute-old check. */
  read = (refresh: boolean): Promise<RuntimeAgentsReport | null> => {
    const state = this.client.connection;
    if (state.state !== "connected" || !this.client.hasCapability("agents/1")) return Promise.resolve(null);
    if (this.pending && !refresh) return this.pending;
    this.set({ loading: true });
    const pending = Promise.resolve()
      .then(() => this.client.runtimeAgentsReport(refresh ? { refresh: true } : {}))
      .then((report) => {
        if (this.client.connection !== state) return null;
        if (this.pending === pending) this.set({ report, error: null, loading: false });
        // A fresh check of the sign-ins: the new-session form's word on them
        // follows (PRO-350). Its own failure is the form's, never this read's.
        if (refresh) {
          try {
            void refreshRuntimeModels(this.client).catch(() => {});
          } catch {
            // The form keeps what it read before.
          }
        }
        return report;
      })
      .catch((error: unknown) => {
        if (this.pending === pending) this.set({ error: errorMessage(error), loading: false });
        return null;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  };
}

const readings = new WeakMap<WorkspaceRpcClient, AgentsReading>();
function readingFor(client: WorkspaceRpcClient): AgentsReading {
  let reading = readings.get(client);
  if (!reading) readings.set(client, (reading = new AgentsReading(client)));
  return reading;
}
const nothing = () => EMPTY;
const noSubscription = () => () => {};

/** The machine's agents, read once the page shows and again on every new connection. */
export function useMachineAgents(client: WorkspaceRpcClient | null): MachineAgentsSnapshot {
  const reading = client ? readingFor(client) : null;
  const snapshot = useSyncExternalStore(reading?.subscribe ?? noSubscription, reading?.get ?? nothing, nothing);
  useEffect(() => {
    if (reading && !reading.snapshot.report) void reading.read(false);
  }, [reading]);
  return snapshot;
}

/** Read the agents again; with `refresh` the runtime asks each CLI about its sign-in now. */
export function readMachineAgents(client: WorkspaceRpcClient, refresh = false): Promise<RuntimeAgentsReport | null> {
  return readingFor(client).read(refresh);
}

// ------------------------------------------------------------------ rows

/** One agent row on the page (21.10). */
export interface MachineAgentRow {
  id: string;
  name: string;
  /** Installed there, or known with no CLI there. */
  installed: boolean;
  version: string | null;
  /** Null from an older runtime: the row shows no state and offers nothing. */
  signIn: RuntimeAgentSignIn | null;
  /** A missing agent whose provider has an official installer. */
  installable: boolean;
}

/** Installed agents in the runtime's order, then the missing ones. */
export function machineAgentRows(report: RuntimeAgentsReport | null): MachineAgentRow[] {
  if (!report) return [];
  const installed = report.agents.map(
    (agent): MachineAgentRow => ({ id: agent.id, name: agent.name, installed: true, version: agent.version ?? null, signIn: agent.signIn ?? null, installable: false }),
  );
  const missing = (report.missing ?? [])
    .filter((agent) => !installed.some((row) => row.id === agent.id))
    .map((agent): MachineAgentRow => ({ id: agent.id, name: agent.name, installed: false, version: null, signIn: null, installable: agent.installable }));
  return [...installed, ...missing];
}

/** Whose sign-in sessions there use: "this server’s", "this Mac’s", "this machine’s". */
export function signInOwner(machine: { hasWindow?: boolean | null; os: { family: string } }): string {
  if (machine.hasWindow === false) return "this server’s";
  return machine.os.family === "macos" ? "this Mac’s" : "this machine’s";
}

/**
 * The row's second line: "2.4.1 · sessions here use this server’s sign-in",
 * "Installed · not signed in", "Not installed". An older runtime's agent says
 * only its version, or Installed.
 */
export function agentRowLine(row: MachineAgentRow, owner: string): string {
  if (!row.installed) return row.installable ? "Not installed" : "Not installed · install it on the machine";
  const installed = row.version ?? "Installed";
  switch (row.signIn) {
    case "signedIn":
      return `${installed} · sessions here use ${owner} sign-in`;
    case "signedOut":
      // 21.10: what matters is the missing sign-in, not the version.
      return "Installed · not signed in";
    case "unknown":
      return `${installed} · its sign-in could not be checked`;
    default:
      return installed;
  }
}

/** What the row offers: Sign in, Install, or nothing (signed in, an older runtime, or no `machine/4`). */
export function agentRowAction(row: MachineAgentRow, setupGranted: boolean): "login" | "install" | null {
  if (!setupGranted) return null;
  if (!row.installed) return row.installable ? "install" : null;
  return row.signIn === "signedOut" || row.signIn === "unknown" ? "login" : null;
}
