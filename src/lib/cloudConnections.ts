import { useSyncExternalStore } from "react";
import type { Activation, WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { hasWorkspaceConnection, workspaceConnection, type CloudWorkspaceConnection } from "@/lib/api";
import { detachCloudTerminals } from "@/lib/cloudTerminals";
import { cloudWorkspaceKey } from "@/types/target";

/**
 * The cloud connection manager (PRO-23 CS-7): the one owner of live
 * connections to cloud workspaces. Every surface that needs a workspace's
 * runtime (the session view, the sidebar's session list, the new-session
 * flow, a row menu) retains a lease here and releases it when done.
 *
 * - **Reference counted.** One connection per workspace, however many
 *   surfaces hold it. The strongest activation asked for wins, and only
 *   `wake` (an interactive action) ever resumes stopped compute.
 * - **One wake.** Concurrent wakes of one workspace share a single flight:
 *   one attach (or activation) with `wake`, whatever number of surfaces ask.
 * - **Idle close.** A connection nobody holds closes 5 minutes after the
 *   last release; retaining it again in time keeps it.
 * - **At most 4.** Opening a fifth closes the least recently used one that
 *   nobody holds (or, failing that, the oldest), never the selected one.
 * - **Looking never costs money.** Nothing here runs on render: a lease is
 *   taken only when a surface asks for one.
 */

export const IDLE_CLOSE_MS = 5 * 60 * 1000;
export const MAX_CONNECTIONS = 4;

export interface CloudTarget {
  orgId: string;
  workspaceId: string;
}

export type LeaseActivation = Extract<Activation, "connect" | "wake">;

export interface CloudLease {
  key: string;
  connection: CloudWorkspaceConnection;
  client: WorkspaceRpcClient;
  /** Give the lease back; the connection closes after `IDLE_CLOSE_MS` once no lease holds it. Idempotent. */
  release(): void;
}

/** What a workspace's connection looks like to the rows. */
export interface CloudConnectionInfo {
  state: WorkspaceConnectionState["state"];
  /** Capabilities the runtime granted on its last connect; kept while reconnecting. */
  capabilities: string[] | null;
  authority: "manage" | "participate" | null;
  refs: number;
  waking: boolean;
  /** Raised to `wake` since it was opened: an interactive action asked for compute. */
  woke: boolean;
}

interface Entry {
  key: string;
  target: CloudTarget;
  refs: number;
  /** The connection being opened or held. */
  pending: Promise<CloudWorkspaceConnection> | null;
  connection: CloudWorkspaceConnection | null;
  activation: LeaseActivation | null;
  lastUsed: number;
  idle: ReturnType<typeof setTimeout> | null;
  wake: Promise<void> | null;
  unwatch: (() => void) | null;
  info: CloudConnectionInfo;
}

type ConnectedListener = (target: CloudTarget, client: WorkspaceRpcClient) => void | (() => void);

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const connectedListeners = new Set<ConnectedListener>();
/** Per workspace, what each connected-listener returned to undo when it disconnects. */
const connectedCleanups = new Map<string, (() => void)[]>();
let selectedKey: string | null = null;
let clock: () => number = () => Date.now();
let version = 0;

const IDLE_INFO: CloudConnectionInfo = { state: "idle", capabilities: null, authority: null, refs: 0, waking: false, woke: false };

function notify() {
  version++;
  for (const listener of [...listeners]) listener();
}

function entryFor(target: CloudTarget): Entry {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      target,
      refs: 0,
      pending: null,
      connection: null,
      activation: null,
      lastUsed: clock(),
      idle: null,
      wake: null,
      unwatch: null,
      info: IDLE_INFO,
    };
    entries.set(key, entry);
  }
  return entry;
}

function setInfo(entry: Entry, patch: Partial<CloudConnectionInfo>) {
  entry.info = { ...entry.info, ...patch };
  notify();
}

function runDisconnected(key: string) {
  const cleanups = connectedCleanups.get(key);
  connectedCleanups.delete(key);
  for (const cleanup of cleanups ?? []) {
    try {
      cleanup();
    } catch {
      /* a listener's cleanup never stops the others */
    }
  }
}

function watch(entry: Entry, connection: CloudWorkspaceConnection) {
  entry.unwatch?.();
  let wasConnected = false;
  entry.unwatch = connection.client.onState((state) => {
    if (state.state === "connected") {
      setInfo(entry, { state: state.state, capabilities: state.capabilities, authority: state.authority });
      // Every connect, reconnects included: lists are re-read after time away.
      runDisconnected(entry.key);
      const cleanups: (() => void)[] = [];
      for (const listener of [...connectedListeners]) {
        try {
          const cleanup = listener(entry.target, connection.client);
          if (typeof cleanup === "function") cleanups.push(cleanup);
        } catch {
          /* one listener never stops the others */
        }
      }
      connectedCleanups.set(entry.key, cleanups);
      wasConnected = true;
    } else {
      // Stopped again after running (idle suspend, or stopped elsewhere): the next action wakes it anew.
      setInfo(entry, state.state === "suspended" && wasConnected ? { state: state.state, woke: false } : { state: state.state });
      if (state.state === "suspended" && wasConnected) entry.activation = "connect";
      if (wasConnected && state.state !== "reconnecting") runDisconnected(entry.key);
      // Stopped for an identity change: the api layer closed it; forget it.
      if (state.state === "stopped") drop(entry);
    }
  });
}

/** Close a connection now, whoever holds it. */
function drop(entry: Entry) {
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = null;
  entry.unwatch?.();
  entry.unwatch = null;
  runDisconnected(entry.key);
  const connection = entry.connection;
  const pending = entry.pending;
  entry.connection = null;
  entry.pending = null;
  entry.activation = null;
  entry.refs = 0;
  entries.delete(entry.key);
  detachCloudTerminals(entry.key);
  if (connection) connection.close();
  else if (pending) void pending.then((late) => late.close()).catch(() => undefined);
  notify();
}

function live(): Entry[] {
  return [...entries.values()].filter((entry) => entry.connection || entry.pending);
}

/** Beyond `MAX_CONNECTIONS`, close the least recently used one: unheld first, never the selected one or `keep`. */
function evict(keep: Entry) {
  const open = live();
  if (open.length <= MAX_CONNECTIONS) return;
  const candidates = open
    .filter((entry) => entry !== keep && entry.key !== selectedKey)
    .sort((a, b) => Number(a.refs > 0) - Number(b.refs > 0) || a.lastUsed - b.lastUsed);
  for (const entry of candidates.slice(0, open.length - MAX_CONNECTIONS)) drop(entry);
}

function stronger(a: LeaseActivation | null, b: LeaseActivation): boolean {
  return b === "wake" && a !== "wake";
}

async function open(entry: Entry, activation: LeaseActivation): Promise<CloudWorkspaceConnection> {
  // Someone else closed the api's connection underneath (the full-window page): start over.
  if (entry.connection && !hasWorkspaceConnection({ kind: "cloud", organizationId: entry.target.orgId, workspaceId: entry.target.workspaceId })) {
    entry.unwatch?.();
    entry.unwatch = null;
    runDisconnected(entry.key);
    entry.connection = null;
    entry.pending = null;
    entry.activation = null;
  }
  if (!entry.pending) {
    const target = { kind: "cloud" as const, organizationId: entry.target.orgId, workspaceId: entry.target.workspaceId };
    entry.activation = activation;
    if (activation === "wake") setInfo(entry, { woke: true });
    const pending = workspaceConnection(target, activation).then((connection) => {
      if (!connection) throw new Error("cloud_workspace_not_connected");
      return connection;
    });
    entry.pending = pending;
    setInfo(entry, { state: "opening" });
    try {
      const connection = await pending;
      if (entry.pending !== pending) {
        // Dropped while it opened.
        connection.close();
        throw new Error("cloud_connection_closed");
      }
      entry.connection = connection;
      watch(entry, connection);
      evict(entry);
      return connection;
    } catch (error) {
      if (entry.pending === pending) {
        entry.pending = null;
        entry.activation = null;
        setInfo(entry, { state: "idle" });
      }
      throw error;
    }
  }
  const connection = await entry.pending;
  if (stronger(entry.activation, activation)) {
    entry.activation = activation;
    setInfo(entry, { woke: true });
    await connection.activate(activation);
  }
  return connection;
}

/**
 * Hold a connection to a workspace. `connect` never resumes a stopped
 * workspace; `wake` does, once (see `wakeCloudConnection` to share one wake
 * among concurrent callers). Release the lease when done.
 */
export async function retainCloudConnection(target: CloudTarget, activation: LeaseActivation = "connect"): Promise<CloudLease> {
  const entry = entryFor(target);
  entry.refs++;
  entry.lastUsed = clock();
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = null;
  setInfo(entry, { refs: entry.refs });
  let connection: CloudWorkspaceConnection;
  try {
    connection = await open(entry, activation);
  } catch (error) {
    releaseEntry(entry);
    throw error;
  }
  let released = false;
  return {
    key: entry.key,
    connection,
    client: connection.client,
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    },
  };
}

function releaseEntry(entry: Entry) {
  if (entries.get(entry.key) !== entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  entry.lastUsed = clock();
  setInfo(entry, { refs: entry.refs });
  if (entry.refs > 0) return;
  if (!entry.connection && !entry.pending) {
    entries.delete(entry.key);
    notify();
    return;
  }
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = setTimeout(() => {
    entry.idle = null;
    if (entry.refs === 0 && entries.get(entry.key) === entry) drop(entry);
  }, IDLE_CLOSE_MS);
}

/**
 * Wake a workspace and hold its connection: the one path by which sending,
 * starting a session or opening a terminal resumes stopped compute. However
 * many surfaces ask at once, one `wake` goes out; each caller gets its own
 * lease.
 */
export async function wakeCloudConnection(target: CloudTarget): Promise<CloudLease> {
  const entry = entryFor(target);
  if (entry.activation !== "wake") {
    if (!entry.wake) {
      setInfo(entry, { waking: true });
      entry.wake = (async () => {
        const lease = await retainCloudConnection(target, "wake");
        // The flight's own hold ends once the callers took theirs.
        queueMicrotask(lease.release);
      })().finally(() => {
        entry.wake = null;
        if (entries.get(entry.key) === entry) setInfo(entry, { waking: false });
      });
    }
    await entry.wake;
  }
  return retainCloudConnection(target, "connect");
}

/**
 * Resolve once the client is connected; reject when the runtime cannot be
 * reached in time, needs an update, or (with `stoppedIsError`) the workspace
 * is stopped. A wake passes through a stopped state, so it is not an error by default.
 */
export function waitCloudConnected(client: WorkspaceRpcClient, withinMs = 5 * 60 * 1000, options: { stoppedIsError?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | null = null;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("cloud_workspace_unreachable")), withinMs);
    stop = client.onState((state) => {
      if (state.state === "connected") finish(null);
      else if (state.state === "updateRequired") finish(new Error("cloud_runtime_update_required"));
      else if (state.state === "stopped") finish(new Error("cloud_connection_closed"));
      else if (state.state === "suspended" && options.stoppedIsError) finish(new Error("cloud_workspace_stopped"));
    });
    if (settled) stop();
  });
}

/**
 * Run `listener` on every connect of every workspace (reconnects included),
 * with the target and its client. What it returns runs when that connection
 * goes away. Returns an unsubscribe.
 */
export function onCloudConnected(listener: ConnectedListener): () => void {
  connectedListeners.add(listener);
  return () => connectedListeners.delete(listener);
}

/** The session the main slot shows is in this workspace: its connection is never evicted. */
export function setSelectedCloudConnection(key: string | null) {
  selectedKey = key;
}

export function cloudConnectionInfo(key: string): CloudConnectionInfo {
  return entries.get(key)?.info ?? IDLE_INFO;
}

/** The connected client of a workspace, if one is held and connected now. */
export function connectedCloudClient(key: string): WorkspaceRpcClient | null {
  const entry = entries.get(key);
  return entry?.connection && entry.info.state === "connected" ? entry.connection.client : null;
}

export function subscribeCloudConnections(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A workspace's connection state for a row or a header. */
export function useCloudConnection(key: string): CloudConnectionInfo {
  return useSyncExternalStore(subscribeCloudConnections, () => cloudConnectionInfo(key), () => IDLE_INFO);
}

/** Changes whenever any connection does. */
export function useCloudConnectionsVersion(): number {
  return useSyncExternalStore(subscribeCloudConnections, () => version, () => 0);
}

/** Close one workspace's connection now (deleted, archived, or no longer a member). */
export function closeCloudConnection(target: CloudTarget) {
  const entry = entries.get(cloudWorkspaceKey(target.orgId, target.workspaceId));
  if (entry) drop(entry);
}

/** Close one organization's connections and forget them: the user left it (CS-18). */
export function closeCloudConnectionsIn(orgId: string) {
  const gone = [...entries.values()].filter((entry) => entry.target.orgId === orgId);
  if (!gone.length) return;
  for (const entry of gone) drop(entry);
  if (selectedKey && !entries.has(selectedKey)) selectedKey = null;
  notify();
}

/** Close every connection (sign-out, another user) and forget them. */
export function resetCloudConnections() {
  for (const entry of [...entries.values()]) drop(entry);
  entries.clear();
  selectedKey = null;
  notify();
}

/** Open connections, for tests and diagnostics. */
export function liveCloudConnections(): string[] {
  return live().map((entry) => entry.key);
}

/** For tests: a controllable clock for least-recently-used order. */
export function setCloudConnectionClock(now: (() => number) | null) {
  clock = now ?? (() => Date.now());
}
