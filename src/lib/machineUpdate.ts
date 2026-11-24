import { useEffect, useState, useSyncExternalStore } from "react";
import { ThisComputer, thisComputer } from "@/lib/platform";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { WorkspaceRpcError, machineUpdateStatus, type WorkspaceConnectionState, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { errorMessage, invoke } from "@/lib/api";
import { getMachineConnections, machineConnection, useMachineConnections } from "@/lib/machineConnections";
import { machineFeature, machineFeatureMessage, machineIsNewer, machineVersionGap, type MachineVersionGap } from "@/lib/machineFeatures";
import { checkForUpdate, getUpdateState, installUpdate, subscribeUpdate } from "@/lib/updates";
import { parseMachineKey } from "@/types/target";
import {
  MACHINES_APP_UPDATE_REQUESTED_EVENT,
  type MachineAppUpdateReport,
  type MachineConnectionState,
  type MachineUpdateRequest,
  type MachineUpdateStatus,
  type PairedMachine,
} from "@/types/machines";

/**
 * A machine's version against this desktop's, and its update (PRO-354,
 * docs/MACHINES.md "Versions and updates"): which features it hides, which
 * side updates, the machine's `machine.updateStatus` followed by
 * `machine.updateChanged`, `machine.update` with its confirmation, and this
 * Mac's answer when another computer asks its app to update.
 */

// ------------------------------------------------------------------ this desktop's version

let thisVersion: string | null = null;
let readingVersion: Promise<string | null> | null = null;

/** This desktop's TerminalX version; null until read (or outside the app). */
export function readThisVersion(): Promise<string | null> {
  return (readingVersion ??= getVersion()
    .then((version) => (thisVersion = version))
    .catch(() => null));
}

export function useThisVersion(): string | null {
  const [version, setVersion] = useState(thisVersion);
  useEffect(() => {
    let live = true;
    void readThisVersion().then((read) => live && setVersion(read));
    return () => {
      live = false;
    };
  }, []);
  return version;
}

// ------------------------------------------------------------------ one machine, as the views read it

/** The capabilities a client's runtime granted, null while not connected. */
function grantedBy(state: WorkspaceConnectionState): string[] | null {
  return state.state === "connected" ? state.capabilities : null;
}

/** Follow a client's connection state; idle without a client. */
export function useClientState(client: WorkspaceRpcClient | null): WorkspaceConnectionState {
  const [state, setState] = useState<WorkspaceConnectionState>(() => client?.connection ?? { state: "idle" });
  useEffect(() => {
    if (!client) {
      setState({ state: "idle" });
      return;
    }
    return client.onState(setState);
  }, [client]);
  return state;
}

export interface MachineVersionView {
  machine: PairedMachine | null;
  state: MachineConnectionState;
  client: WorkspaceRpcClient | null;
  /** What the connected runtime granted; null while not connected. */
  granted: string[] | null;
  /** The machine's TerminalX version: the connected runtime's, the state's, else the record's. */
  version: string | null;
  /** This desktop's version. */
  ours: string | null;
  /** Needs update (and what is hidden), or null. */
  gap: MachineVersionGap | null;
  /** Connected, newer than this desktop, nothing hidden: its page offers this Mac's update. */
  newer: boolean;
  /** The chip's state: `needsUpdate` when a connected machine hides features. */
  shownState: MachineConnectionState;
}

/** Everything the card, chip and page need to say about a machine's version. */
export function machineVersionView(machine: PairedMachine | null, state: MachineConnectionState, client: WorkspaceRpcClient | null, clientState: WorkspaceConnectionState, ours: string | null): MachineVersionView {
  // What the machine grants is known only while it is connected: a link
  // that dropped says nothing about it, so a machine that was hiding a
  // feature shows Connecting, Reconnecting or Offline, not Needs update.
  const live = state.state === "direct" || state.state === "relay";
  const granted = live ? grantedBy(clientState) : null;
  const runtimeVersion = clientState.state === "connected" && clientState.runtimeVersion ? clientState.runtimeVersion : null;
  const version = runtimeVersion ?? (state.state === "needsUpdate" ? state.version : null) ?? machine?.version ?? null;
  const gap = machineVersionGap(state, granted, version, ours);
  const newer = !gap && !!granted && machineIsNewer(version, ours);
  const shownState: MachineConnectionState = gap && live ? { state: "needsUpdate", version: gap.version, side: gap.side } : state;
  return { machine, state, client, granted, version, ours, gap, newer, shownState };
}

export function useMachineVersion(machineId: string): MachineVersionView {
  const store = useMachineConnections();
  const { machine, state, connection } = machineConnection(store, machineId);
  const client = connection?.client ?? null;
  const clientState = useClientState(client);
  const ours = useThisVersion();
  return machineVersionView(machine, state, client, clientState, ours);
}

/**
 * The one line a hidden feature's place shows on a machine (21.09), or null
 * when the feature is there (or `workspaceKey` is not a machine's, or the
 * machine is not connected: then nothing is known to be missing).
 */
export function machineFeatureNotice(workspaceKey: string, capability: string, granted: readonly string[] | null): string | null {
  const machineId = parseMachineKey(workspaceKey)?.machineId;
  const feature = machineFeature(capability);
  if (!machineId || !feature || !granted || granted.includes(capability)) return null;
  const store = getMachineConnections();
  const { machine } = machineConnection(store, machineId);
  const connection = store.connections[machineId];
  const live = connection?.client.connection;
  const version = live?.state === "connected" && live.runtimeVersion ? live.runtimeVersion : (machine?.version ?? null);
  return machineFeatureMessage(machine?.name ?? "This machine", version, feature);
}

// ------------------------------------------------------------------ the machine's update

export interface MachineUpdateEntry {
  status: MachineUpdateStatus | null;
  loading: boolean;
  /** A `machine.update` in flight. */
  requesting: boolean;
  error: string | null;
}

const EMPTY: MachineUpdateEntry = { status: null, loading: false, requesting: false, error: null };

let entries: Record<string, MachineUpdateEntry> = {};
const listeners = new Set<() => void>();

function patch(machineId: string, change: Partial<MachineUpdateEntry>) {
  entries = { ...entries, [machineId]: { ...(entries[machineId] ?? EMPTY), ...change } };
  for (const listener of [...listeners]) listener();
}

export function getMachineUpdate(machineId: string): MachineUpdateEntry {
  return entries[machineId] ?? EMPTY;
}

export function useMachineUpdateEntry(machineId: string): MachineUpdateEntry {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getMachineUpdate(machineId),
    () => getMachineUpdate(machineId),
  );
}

/** `machine.updateStatus` on `client`, kept for `machineId`. A runtime without `machine/3` has none to read. */
export async function loadMachineUpdate(machineId: string, client: WorkspaceRpcClient, refresh = false): Promise<MachineUpdateStatus | null> {
  if (!client.hasCapability("machine/3")) return null;
  patch(machineId, { loading: true, error: null });
  try {
    const status = await client.machineUpdateStatus(refresh);
    patch(machineId, { status, loading: false });
    return status;
  } catch (error) {
    patch(machineId, { loading: false, error: errorMessage(error) });
    return null;
  }
}

/** Read the machine's update status while connected with `machine/3`, and follow `machine.updateChanged`. */
export function useMachineUpdate(machineId: string, client: WorkspaceRpcClient | null): MachineUpdateEntry {
  const clientState = useClientState(client);
  const updates = clientState.state === "connected" && clientState.capabilities.includes("machine/3");
  const link = clientState.state === "connected" ? `${clientState.runtimeEpoch ?? ""}:${clientState.link ?? 0}` : null;
  useEffect(() => {
    if (!client || !updates) return;
    void loadMachineUpdate(machineId, client);
    return client.onMachineUpdate((status) => patch(machineId, { status, error: null }));
  }, [machineId, client, updates, link]);
  return useMachineUpdateEntry(machineId);
}

export type MachineUpdateOutcome =
  /** The machine started it. */
  | { kind: "started"; status: MachineUpdateStatus }
  /** The machine wants a confirmation first: what stops, who else is connected. */
  | { kind: "confirm"; status: MachineUpdateStatus }
  | { kind: "failed"; message: string };

/** What a refusal of `machine.update` means for the person. */
export function updateRefusalText(error: unknown, name: string): string {
  if (error instanceof WorkspaceRpcError) {
    if (error.code === "update_unavailable") return `${name} cannot update from here. Update it the way it was installed, or open TerminalX on it.`;
    if (error.code === "update_busy") return `${name} is already updating.`;
    if (error.code === "capability_not_granted") return `${name} runs a TerminalX that cannot be updated from ${thisComputer}. Update it on ${name}.`;
  }
  return errorMessage(error);
}

/**
 * `machine.update`. Refused with `update_confirm`, the answer is the status
 * to confirm against (its blockers and other computers); any other refusal
 * is a message.
 */
export async function requestMachineUpdate(machineId: string, client: WorkspaceRpcClient, request: MachineUpdateRequest, name: string): Promise<MachineUpdateOutcome> {
  patch(machineId, { requesting: true, error: null });
  try {
    const status = await client.updateMachine(request);
    patch(machineId, { status, requesting: false });
    return { kind: "started", status };
  } catch (error) {
    const confirm = error instanceof WorkspaceRpcError && error.code === "update_confirm" ? machineUpdateStatus(error.data) : null;
    if (confirm) {
      patch(machineId, { status: confirm, requesting: false });
      return { kind: "confirm", status: confirm };
    }
    const message = updateRefusalText(error, name);
    patch(machineId, { requesting: false, error: message });
    return { kind: "failed", message };
  }
}

/** Whether `status` asks for a confirmation before `machine.update`: work that stops, or other computers connected. */
export function needsConfirmation(status: MachineUpdateStatus | null): boolean {
  return !!status && (status.blockers.length > 0 || status.otherComputers.length > 0);
}

/**
 * The request after the person confirmed `status`: stop every blocker it
 * named, and the other computers it named. A computer that connects after
 * the confirmation is not among them, so the machine asks again.
 */
export function confirmedRequest(version: string, status: MachineUpdateStatus): MachineUpdateRequest {
  return { version, stop: status.blockers.map((blocker) => blocker.id), confirmedOthers: status.otherComputers.map((computer) => computer.id) };
}

/**
 * The version to update a machine to: what it offers. An installer machine
 * offering nothing has no newer signed runtime yet, so there is nothing to
 * ask for; an app machine's own updater finds its version, so it is asked to
 * catch up to this desktop's.
 */
export function updateTarget(status: MachineUpdateStatus | null, ours: string | null): string | null {
  if (status?.available) return status.available.version;
  return status?.method === "installer" ? null : ours;
}

// ------------------------------------------------------------------ another computer asks this Mac's app to update

/** `machines_app_update_report`: forwarded to this Mac's runtime as `runtime.machineUpdate.report`. */
export function reportAppUpdate(report: MachineAppUpdateReport): Promise<void> {
  return invoke<unknown>("machines_app_update_report", { phase: report.phase, step: report.step ?? null, message: report.message ?? null, available: report.available ?? null }).then(
    () => undefined,
    (error: unknown) => console.warn(`TerminalX machine update report: ${errorMessage(error)}`),
  );
}

let answering = false;

/**
 * Another computer asked this Mac to update its app (`machine.update` on an
 * app machine): run the same updater as Settings → About and report each
 * step. Updating relaunches the app, which hands its runtime over.
 */
export async function answerAppUpdateRequest(): Promise<void> {
  if (answering) return;
  answering = true;
  let restarting = false;
  const stop = subscribeUpdate(() => {
    const state = getUpdateState();
    if (state.kind === "installing" && state.pct >= 100 && !restarting) {
      restarting = true;
      void reportAppUpdate({ phase: "restarting", step: state.version });
    }
  });
  try {
    await reportAppUpdate({ phase: "checking" });
    const found = await checkForUpdate();
    if (found.kind === "none") return void (await reportAppUpdate({ phase: "upToDate" }));
    if (found.kind === "error") return void (await reportAppUpdate({ phase: "failed", message: found.message }));
    if (found.kind === "installing") return void (await reportAppUpdate({ phase: "installing", step: found.version, available: found.version }));
    if (found.kind === "choosing") return void (await reportAppUpdate({ phase: "installing", step: found.update.version, available: found.update.version, message: `Waiting for someone at ${thisComputer}: updating now would stop work that is running.` }));
    if (found.kind !== "available") return void (await reportAppUpdate({ phase: "failed", message: `${ThisComputer} could not check for an update.` }));
    await reportAppUpdate({ phase: "downloading", step: found.update.version, available: found.update.version });
    await installUpdate();
    const after = getUpdateState();
    if (after.kind === "error") await reportAppUpdate({ phase: "failed", message: after.message });
    else if (after.kind === "choosing") await reportAppUpdate({ phase: "installing", step: after.update.version, message: `Waiting for someone at ${thisComputer}: updating now would stop work that is running.` });
    else if (after.kind === "installing" && !restarting) await reportAppUpdate({ phase: "installing", step: after.version });
  } finally {
    stop();
    answering = false;
  }
}

let responding: Promise<() => void> | null = null;

/** Answer `machines_app_update_requested` for as long as this window lives. Once per window. */
export function startAppUpdateResponder(): Promise<() => void> {
  return (responding ??= listen<unknown>(MACHINES_APP_UPDATE_REQUESTED_EVENT, () => void answerAppUpdateRequest()).catch(() => () => undefined));
}

/** For tests. */
export function resetMachineUpdateForTests() {
  entries = {};
  listeners.clear();
  answering = false;
  responding = null;
  thisVersion = null;
  readingVersion = null;
}
