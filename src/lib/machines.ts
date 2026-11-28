import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage, invoke } from "@/lib/api";
import type {
  InspectedMachineCode,
  MachineAccountDirectory,
  MachineAccountOffer,
  MachineActivityEntry,
  MachineConnectionView,
  MachineHostView,
  MachineListen,
  MachinePairingCode,
  MachinePairResult,
  MachineRoute,
  PairedMachine,
} from "@/types/machines";

/**
 * The `machines_*` commands (docs/MACHINES.md "As built (PRO-342)"). On this
 * Mac as the machine: the host's status, the operate switch, codes, Allow and
 * revoke. On this Mac as the operating computer: inspect, pair, the store.
 */
export const machinesApi = {
  hostStatus: () => invoke<MachineHostView>("machines_host_status"),
  setAllowOperating: (enabled: boolean) => invoke<MachineHostView>("machines_set_allow_operating", { enabled }),
  /** Where this Mac listens for computers and phones, and whether public callers are answered (PRO-487). */
  setListen: (listen: MachineListen, allowPublic: boolean) => invoke<MachineHostView>("machines_set_listen", { listen, allowPublic }),
  createCode: () => invoke<MachinePairingCode>("machines_create_code"),
  /**
   * Restart runtime `epoch`, which cannot verify this window, with what it runs; resolves once a fresh one is attached
   * (PRO-486). `shown` is the offer as displayed: the runtime is stopped only if it stops no more than that names (PRO-489).
   */
  restartRuntimeForWindow: (epoch: string, shown: string) => invoke<void>("local_runtime_restart_for_window", { epoch, shown }),
  approve: (requestId: string) => invoke<unknown>("machines_approve", { requestId }),
  decline: (requestId: string) => invoke<unknown>("machines_decline", { requestId }),
  revoke: (id: string) => invoke<unknown>("machines_revoke", { id }),
  /** Close a computer's connections and refuse it until it is let back (PRO-357). */
  disconnect: (id: string) => invoke<unknown>("machines_disconnect", { id }),
  /** Let a disconnected computer connect again. Like Allow, only a person may. */
  letBack: (id: string) => invoke<unknown>("machines_let_back", { id }),
  /** What operating computers did on this Mac: the last 200 entries, newest first. */
  activity: () => invoke<MachineActivityEntry[]>("machines_activity"),
  inspectCode: (code: string) => invoke<InspectedMachineCode>("machines_inspect_code", { code }),
  pair: (code: string, route: MachineRoute) => invoke<MachinePairResult>("machines_pair", { code, route }),
  cancelPairing: () => invoke<unknown>("machines_cancel_pairing"),
  list: () => invoke<PairedMachine[]>("machines_list"),
  setRoute: (machineId: string, route: MachineRoute) => invoke<unknown>("machines_set_route", { machineId, route }),
  /** Every paired machine's connection state (PRO-345); `idle` when not attached. */
  connections: () => invoke<MachineConnectionView[]>("machines_connections"),
  /** "Try again": nudge the machine's owner; after access removed or needs update it tries once more. */
  reconnect: (machineId: string) => invoke<unknown>("machines_reconnect", { machineId }),
  /** Forget a paired machine: its connection, record and credentials. Its sessions stay on it. */
  remove: (machineId: string) => invoke<boolean>("machines_remove", { machineId }),
  /** The account's computers (PRO-349). */
  accountList: () => invoke<MachineAccountDirectory>("machines_account_list"),
  /** Ask a computer on the account for a one-time grant; its offer comes back as a code. */
  accountRequest: (hostId: string) => invoke<MachineAccountOffer>("machines_account_request", { hostId }),
  /** Stop waiting for a grant. */
  accountCancel: () => invoke<unknown>("machines_account_cancel"),
  /** After pairing with an account offer: consume the grant when paired, revoke it when not. */
  accountFinish: (grantRequestId: string, paired: boolean) => invoke<unknown>("machines_account_finish", { grantRequestId, paired }),
};

interface MachineHostState {
  view: MachineHostView | null;
  ready: boolean;
  /** A command in flight: its controls wait. */
  busy: boolean;
  /** The last command's failure, or why the status could not be read. */
  error: string | null;
}

let state: MachineHostState = { view: null, ready: false, busy: false, error: null };
const listeners = new Set<() => void>();
const __subscribe_listeners = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function set(patch: Partial<MachineHostState>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function apply(view: MachineHostView | null | undefined) {
  if (view && typeof view === "object") set({ view, ready: true });
}

/** The machine host as it is now, outside React. */
export function getMachineHost(): MachineHostState {
  return state;
}

/** This Mac as a machine: the switch, its status, the computer asking to operate it. */
export function useMachineHost(): MachineHostState {
  return useSyncExternalStore(
    __subscribe_listeners,
    () => state,
    () => state,
  );
}

let booted: Promise<void> | null = null;
/** Read the host once and follow `machines_host_changed`. Safe to call from every view that needs it. */
export function bootMachineHost(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<MachineHostView>("machines_host_changed", (event) => apply(event.payload));
    } catch {
      // No event bus (a test, the demo): the read below still answers.
    }
    try {
      apply(await machinesApi.hostStatus());
    } catch (error) {
      set({ ready: true, error: errorMessage(error) });
    }
  })());
}

/**
 * For a view that opens: the first read and the event follow-up when nothing has booted yet, a fresh read otherwise,
 * since what the event bus has not carried (a restart offered while no window looked, PRO-486) may have changed.
 */
export function openMachineHost(): Promise<void> {
  if (!booted) return bootMachineHost();
  return booted.then(refreshMachineHost);
}

/** Read the host again, as after a change made elsewhere. */
export async function refreshMachineHost(): Promise<void> {
  try {
    apply(await machinesApi.hostStatus());
  } catch (error) {
    set({ error: errorMessage(error) });
  }
}

/** Run one command; its failure shows as the store's error, then the host is read again. */
async function command(run: () => Promise<unknown>, answersView = false): Promise<boolean> {
  set({ busy: true, error: null });
  try {
    const result = await run();
    if (answersView) apply(result as MachineHostView);
    else await refreshMachineHost();
    return true;
  } catch (error) {
    set({ error: errorMessage(error) });
    return false;
  } finally {
    set({ busy: false });
  }
}

/** Let other computers operate this Mac (`machines.allowOperating`). */
export function setAllowOperating(enabled: boolean): Promise<boolean> {
  return command(() => machinesApi.setAllowOperating(enabled), true);
}

/** Where this Mac listens (`machines.listen`), and whether it answers public callers (`machines.allowPublic`). */
export function setMachineListen(listen: MachineListen, allowPublic: boolean): Promise<boolean> {
  return command(() => machinesApi.setListen(listen, allowPublic), true);
}

/** Let the waiting computer finish pairing: the person compared the fingerprints. */
export function approveMachine(requestId: string): Promise<boolean> {
  return command(() => machinesApi.approve(requestId));
}

/** Refuse the waiting computer. The code ends with it. */
export function declineMachine(requestId: string): Promise<boolean> {
  return command(() => machinesApi.decline(requestId));
}

/** End a computer's credential and close its connection. */
export function revokeComputer(id: string): Promise<boolean> {
  return command(() => machinesApi.revoke(id));
}

/** Close a computer's connections; it may not reconnect until it is let back. */
export function disconnectComputer(id: string): Promise<boolean> {
  return command(() => machinesApi.disconnect(id));
}

/** Let a disconnected computer connect again. */
export function letComputerBack(id: string): Promise<boolean> {
  return command(() => machinesApi.letBack(id));
}

/**
 * Keep this Mac awake while a computer (or phone) is connected: `pairing.keepAwake`,
 * shared with phones. The switch moves at once and returns if the Mac refuses.
 */
export async function setMachinesKeepAwake(enabled: boolean): Promise<void> {
  const before = state.view;
  if (before) set({ view: { ...before, keepAwake: enabled }, error: null });
  try {
    const status = await api.pairingSetKeepAwake(enabled);
    if (state.view) set({ view: { ...state.view, keepAwake: status.keepAwake } });
  } catch (error) {
    set({ view: before, error: errorMessage(error) });
  }
}

/** Make a pairing code; the store keeps none of it, the caller shows it. */
export async function createMachineCode(): Promise<MachinePairingCode> {
  set({ error: null });
  try {
    return await machinesApi.createCode();
  } finally {
    void refreshMachineHost();
  }
}

/**
 * A command only a person may send failed because the runtime running was not started by this window, so it cannot
 * verify it, and restarting it would stop work (PRO-486): `runtime_restart_required:<epoch>: <message>`.
 */
export function restartRequired(error: string | null | undefined): { epoch: string; message: string } | null {
  const match = /^runtime_restart_required:([^:\s]+): ([\s\S]*)$/.exec(error ?? "");
  return match ? { epoch: match[1], message: match[2] } : null;
}

/** Forget the last command's failure, as after the runtime it named was restarted. */
export function clearMachineHostError() {
  set({ error: null });
}

/**
 * Keep a failure as the last command's, as Restart runtime's: shown in place of the offer it answered, which may be
 * withdrawn (a handover) before the failure is (PRO-489).
 */
export function setMachineHostError(error: string) {
  set({ error });
}

/** For tests: forget what was read. */
export function resetMachineHostForTests() {
  state = { view: null, ready: false, busy: false, error: null };
  booted = null;
  listeners.clear();
}
