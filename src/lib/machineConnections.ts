import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { closeWorkspaceConnection, errorMessage, workspaceConnection, workspaceTargetKey, type CloudWorkspaceConnection, type MachineWorkspaceTarget } from "@/lib/api";
import { detachCloudTerminals } from "@/lib/cloudTerminals";
import { machinesApi } from "@/lib/machines";
import { getSessionStore, selectCloudWorkspace } from "@/lib/sessions";
import { isMachineKey } from "@/types/target";
import type { MachineConnectionState, MachineConnectionView, PairedMachine } from "@/types/machines";

/**
 * The machines this computer paired with and how each is connected (PRO-345,
 * docs/MACHINES.md "As built (PRO-345)").
 *
 * While Experimental → Machines is on ({@link startMachineConnections}), every
 * paired machine is attached: the native side keeps one owner per machine that
 * connects direct first, then through the relay, and reconnects on its own.
 * Each machine's state comes from `machines_connections` and then
 * `machines_connection_changed`. Turned off, the connections are closed and
 * nothing here touches the network.
 */
export interface MachineConnectionsState {
  /** The paired machines have been read (or failed to be) at least once. */
  ready: boolean;
  /** `machines_list`, in its order. */
  machines: PairedMachine[];
  /** By `machineId`; a machine with none yet is not attached (`idle`). */
  states: Record<string, MachineConnectionState>;
  /** The connection this window holds to each attached machine. */
  connections: Record<string, CloudWorkspaceConnection>;
  /** Why a machine could not be attached or retried (`machine_token_missing`, …). */
  attachErrors: Record<string, string>;
  /** Why the paired machines could not be read. */
  error: string | null;
}

const IDLE: MachineConnectionState = { state: "idle" };

let state: MachineConnectionsState = { ready: false, machines: [], states: {}, connections: {}, attachErrors: {}, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<MachineConnectionsState>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Told whenever the paired machines, their states or this window's connections change. */
export const subscribeMachineConnections = subscribe;

/** The store as it is now, outside React. */
export function getMachineConnections(): MachineConnectionsState {
  return state;
}

export function useMachineConnections(): MachineConnectionsState {
  return useSyncExternalStore(subscribe, getMachineConnections, getMachineConnections);
}

/** One machine's record, state, connection and attach error; `machine` is null for one no longer paired. */
export function machineConnection(store: MachineConnectionsState, machineId: string) {
  return {
    machine: store.machines.find((machine) => machine.machineId === machineId) ?? null,
    state: store.states[machineId] ?? IDLE,
    connection: store.connections[machineId] ?? null,
    attachError: store.attachErrors[machineId] ?? null,
  };
}

const target = (machineId: string): MachineWorkspaceTarget => ({ kind: "machine", machineId });

/** Holders of {@link startMachineConnections}; attached while there is one. */
let holders = 0;
const attaching = new Set<string>();
/** Events seen per machine, so a slower `machines_connections` read never overwrites a newer event. */
const eventCount = new Map<string, number>();
let listening: Promise<void> | null = null;
/** Bumped by each read of the list, so only the latest one applies. */
let reads = 0;

function isView(value: unknown): value is MachineConnectionView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<MachineConnectionView>;
  return typeof view.machineId === "string" && !!view.state && typeof view.state === "object" && typeof view.state.state === "string";
}

const linked = (current: MachineConnectionState | undefined) => current?.state === "direct" || current?.state === "relay";

function applyEvent(view: MachineConnectionView) {
  eventCount.set(view.machineId, (eventCount.get(view.machineId) ?? 0) + 1);
  const before = state.states[view.machineId];
  set({ states: { ...state.states, [view.machineId]: view.state } });
  // A machine paired in another window, or one whose `machine.describe` just
  // renamed it or moved its last-seen time: read the records again. Before the
  // first read has answered, that read brings them.
  if (!state.ready) return;
  const unknown = !state.machines.some((machine) => machine.machineId === view.machineId);
  if (unknown || (linked(view.state) && !linked(before))) void refreshPairedMachines();
}

function listenOnce(): Promise<void> {
  return (listening ??= (async () => {
    try {
      await listen<unknown>("machines_connection_changed", (event) => {
        if (isView(event.payload)) applyEvent(event.payload);
      });
    } catch {
      // No event bus (a test, the demo): reads still answer.
    }
  })());
}

/**
 * Read the paired machines and their states again, and (while held) attach
 * the ones not attached yet and close the ones no longer paired.
 */
export async function refreshPairedMachines(): Promise<void> {
  const mine = ++reads;
  let machines: PairedMachine[];
  try {
    machines = await machinesApi.list();
  } catch (error) {
    if (mine === reads) set({ ready: true, error: errorMessage(error) });
    return;
  }
  const before = new Map(eventCount);
  let views: MachineConnectionView[] = [];
  try {
    const read = await machinesApi.connections();
    views = Array.isArray(read) ? read.filter(isView) : [];
  } catch {
    // The states follow from events; the list still shows.
  }
  if (mine !== reads) return;
  const states = { ...state.states };
  for (const view of views) {
    if ((eventCount.get(view.machineId) ?? 0) === (before.get(view.machineId) ?? 0)) states[view.machineId] = view.state;
  }
  set({ ready: true, error: null, machines, states });
  const paired = new Set(machines.map((machine) => machine.machineId));
  for (const machineId of Object.keys(state.connections)) if (!paired.has(machineId)) detach(machineId);
  if (holders > 0) for (const machine of machines) void attach(machine.machineId);
}

async function attach(machineId: string): Promise<void> {
  if (state.connections[machineId] || attaching.has(machineId)) return;
  attaching.add(machineId);
  try {
    const connection = await workspaceConnection(target(machineId));
    const paired = state.machines.some((machine) => machine.machineId === machineId);
    if (!connection || holders === 0 || !paired) {
      closeWorkspaceConnection(target(machineId));
      return;
    }
    const { [machineId]: _cleared, ...attachErrors } = state.attachErrors;
    set({ connections: { ...state.connections, [machineId]: connection }, attachErrors });
  } catch (error) {
    set({ attachErrors: { ...state.attachErrors, [machineId]: errorMessage(error) } });
  } finally {
    attaching.delete(machineId);
  }
}

function detach(machineId: string) {
  const key = workspaceTargetKey(target(machineId));
  detachCloudTerminals(key);
  closeWorkspaceConnection(target(machineId));
  const { [machineId]: _closed, ...connections } = state.connections;
  set({ connections });
  if (getSessionStore().selectedCloudWorkspace === key) selectCloudWorkspace(null);
}

/**
 * Attach every paired machine and keep them attached until the returned
 * stop is called by every holder (Experimental → Machines turned off, or the
 * window going away). The runtime keeps its sessions running either way.
 */
export function startMachineConnections(): () => void {
  holders++;
  if (holders === 1) {
    void listenOnce().then(() => (holders > 0 ? refreshPairedMachines() : undefined));
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    holders--;
    if (holders > 0) return;
    for (const machineId of Object.keys(state.connections)) detach(machineId);
    // A machine's view is shown only while Machines is on.
    if (isMachineKey(getSessionStore().selectedCloudWorkspace)) selectCloudWorkspace(null);
  };
}

/** "Try again": nudge the machine's owner, and attach it again if this window holds no connection to it. */
export async function reconnectMachine(machineId: string): Promise<void> {
  const { [machineId]: _cleared, ...attachErrors } = state.attachErrors;
  set({ attachErrors });
  if (holders > 0 && !state.connections[machineId]) {
    await attach(machineId);
    return;
  }
  try {
    await machinesApi.reconnect(machineId);
  } catch (error) {
    set({ attachErrors: { ...state.attachErrors, [machineId]: errorMessage(error) } });
  }
}

/** For tests: forget everything read and held. */
export function resetMachineConnectionsForTests() {
  state = { ready: false, machines: [], states: {}, connections: {}, attachErrors: {}, error: null };
  holders = 0;
  attaching.clear();
  eventCount.clear();
  listening = null;
  reads = 0;
  listeners.clear();
}
