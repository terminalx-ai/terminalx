import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ListedPort, ListedProcess } from "@terminalx/portable/workspace";
import { api, browser as browserApi, CLOUD_PORT_FORWARDS_CHANGED, type CloudPortForward, type CloudPortForwardsChanged, type CloudPortSettings } from "@/lib/api";
import { openBrowserPage } from "@/lib/browser";
import { copyText } from "@/lib/clipboard";

/**
 * A connection's port forwards to this Mac, its two switches and the names of
 * the programs listening (PRO-355, 14.10, 14.11), kept once for every view of
 * it: the header's forward chip and its popover, the side panel's Ports tab,
 * and the "Port N forwarded" toast. The native side is the source of truth;
 * `cloud_port_forwards_changed` carries every change, whoever made it, so the
 * chip's count is right while no panel is drawn and nothing polls.
 *
 * A machine's forwards stay listed as `waiting` while it is away and open
 * again once it is back; a cloud workspace's go with the connection
 * (docs/MACHINES.md "As built (PRO-355)").
 */

/** What the desktop answers before it knows the switches, and what an older desktop means: Forwarding on, automatic off. */
export const DEFAULT_PORT_SETTINGS: CloudPortSettings = { enabled: true, auto: false };

export interface PortForwardsEntry {
  /** False until the first answer: until then nothing is known to be forwarded, and nothing expires. */
  loaded: boolean;
  forwards: CloudPortForward[];
  settings: CloudPortSettings;
  /** The program last seen listening on each port, kept while the list is not read (the toast, a machine that is away). */
  processes: ReadonlyMap<number, ListedProcess>;
}

const EMPTY: PortForwardsEntry = { loaded: false, forwards: [], settings: DEFAULT_PORT_SETTINGS, processes: new Map() };

const entries = new Map<string, PortForwardsEntry>();
/** Per connection, the forwards and stops made here: a read one overtook is not taken. */
const mutations = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function update(connectionId: string, change: (entry: PortForwardsEntry) => PortForwardsEntry) {
  entries.set(connectionId, change(entries.get(connectionId) ?? EMPTY));
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const byPort = (forwards: readonly CloudPortForward[]) => [...forwards].sort((a, b) => a.port - b.port);

/** The connection's forwards as last known; empty and not `loaded` before the first answer. */
export function portForwardsOf(connectionId: string | null): PortForwardsEntry {
  return (connectionId && entries.get(connectionId)) || EMPTY;
}

/** Forwards listening on this Mac now: what the chip and the "Ports N" tab count. */
export function openForwardCount(forwards: readonly CloudPortForward[]): number {
  return forwards.filter((forward) => forward.state !== "waiting").length;
}

// ---- the event

let listening: Promise<() => void> | null = null;

/** Starts following `cloud_port_forwards_changed`, once for the window. */
function follow() {
  if (listening) return;
  listening = listen<CloudPortForwardsChanged>(CLOUD_PORT_FORWARDS_CHANGED, ({ payload }) => receivePortForwards(payload)).catch(() => {
    // No event to follow (outside the app): reads still answer, and it is tried again on the next view.
    listening = null;
    return () => undefined;
  });
}

/** A change the desktop announced: the forwards and switches as they now are, and a toast for each that opened unasked. */
export function receivePortForwards(payload: CloudPortForwardsChanged) {
  if (!payload || typeof payload.connectionId !== "string") return;
  const forwards = Array.isArray(payload.forwards) ? byPort(payload.forwards) : null;
  update(payload.connectionId, (entry) => ({
    ...entry,
    loaded: entry.loaded || !!forwards,
    forwards: forwards ?? entry.forwards,
    settings: payload.settings ?? entry.settings,
  }));
  for (const forward of Array.isArray(payload.opened) ? payload.opened : []) raiseToast(payload.connectionId, forward);
}

// ---- reads and changes

/** Reads the connection's forwards (and, with `settings`, its switches) from the desktop. A read overtaken by a change made here is dropped. */
export async function readPortForwards(connectionId: string, { settings = false }: { settings?: boolean } = {}): Promise<CloudPortForward[] | null> {
  const at = mutations.get(connectionId) ?? 0;
  const [forwards, switches] = await Promise.all([api.cloudPortForwards(connectionId).catch(() => null), settings ? api.cloudPortSettings(connectionId).catch(() => null) : Promise.resolve(null)]);
  if (switches) update(connectionId, (entry) => ({ ...entry, settings: switches }));
  if (!forwards || at !== (mutations.get(connectionId) ?? 0)) return null;
  const sorted = byPort(forwards);
  update(connectionId, (entry) => ({ ...entry, loaded: true, forwards: sorted }));
  return sorted;
}

const bump = (connectionId: string) => mutations.set(connectionId, (mutations.get(connectionId) ?? 0) + 1);

/** Forwards `port`; with `samePort`, on the same number here or not at all. Throws the desktop's refusal. */
export async function forwardPort(connectionId: string, port: number, samePort: boolean): Promise<CloudPortForward> {
  const forward = await api.cloudPortForward(connectionId, port, samePort ? { localPort: port, exact: true } : {});
  bump(connectionId);
  update(connectionId, (entry) => ({ ...entry, loaded: true, forwards: byPort([...entry.forwards.filter((other) => other.port !== port), forward]) }));
  return forward;
}

/** Stops forwarding `port`. Throws the desktop's refusal. */
export async function unforwardPort(connectionId: string, port: number): Promise<void> {
  await api.cloudPortUnforward(connectionId, port);
  bump(connectionId);
  update(connectionId, (entry) => ({ ...entry, forwards: entry.forwards.filter((other) => other.port !== port) }));
}

/** Turns Forwarding or "Forward new ports automatically" on or off; the forwards follow (Forwarding off keeps them waiting). */
export async function setPortSettings(connectionId: string, settings: Partial<CloudPortSettings>): Promise<CloudPortSettings> {
  const now = await api.cloudPortSetSettings(connectionId, settings);
  update(connectionId, (entry) => ({ ...entry, settings: now }));
  // The listeners opened or closed with the switch: read them as they now are.
  void readPortForwards(connectionId);
  return now;
}

/**
 * A cloud workspace's connection went: its forwards closed with it and do not
 * return, so nothing is known to be forwarded until it is read again.
 */
export function dropPortForwards(connectionId: string) {
  const entry = entries.get(connectionId);
  if (!entry || (!entry.loaded && !entry.forwards.length)) return;
  bump(connectionId);
  update(connectionId, (current) => ({ ...current, loaded: false, forwards: [] }));
}

/** What `ports.list` said listens: kept so a row is named while the list is not read. */
export function notePortProcesses(connectionId: string, ports: readonly ListedPort[]) {
  const known = portForwardsOf(connectionId).processes;
  const next = new Map(known);
  let changed = false;
  for (const entry of ports) {
    if (!entry.process) continue;
    const before = known.get(entry.port);
    if (before?.name === entry.process.name && before?.cwd === entry.process.cwd) continue;
    next.set(entry.port, entry.process);
    changed = true;
  }
  if (changed) update(connectionId, (entry) => ({ ...entry, processes: next }));
}

/**
 * Follows a connection's forwards while `enabled`: listens for the event and
 * reads them once (again whenever `generation` changes, a reconnect). Answers
 * them as last known whether or not it follows.
 */
export function usePortForwards(connectionId: string | null, enabled: boolean, generation: unknown = null): PortForwardsEntry {
  const entry = useSyncExternalStore(
    subscribe,
    () => portForwardsOf(connectionId),
    () => portForwardsOf(connectionId),
  );
  useEffect(() => {
    if (!enabled || !connectionId) return;
    follow();
    void readPortForwards(connectionId, { settings: true });
  }, [connectionId, enabled, generation]);
  return entry;
}

// ---- words

/** `vite · console`: the program, and the last part of its folder when that says something more. Null when the runtime did not name it. */
export function processLabel(process: ListedProcess | null | undefined): string | null {
  if (!process?.name) return null;
  const folder = process.cwd?.replace(/\/+$/, "").split("/").pop();
  return folder && folder !== process.name ? `${process.name} · ${folder}` : process.name;
}

// 127.0.0.1, never `localhost`: the listener is IPv4 only, and `localhost`
// could reach another program listening on IPv6 loopback at that port.
export const forwardAddress = (localPort: number) => `127.0.0.1:${localPort}`;
export const forwardUrl = (localPort: number) => `http://${forwardAddress(localPort)}`;

export function copyForwardUrl(localPort: number): Promise<void> {
  return copyText(forwardUrl(localPort));
}

// ---- the built-in browser

/**
 * The built-in browser's pages are grouped by a local folder, and a cloud or
 * machine session's folder is not this Mac's (`invoke` refuses it): previews
 * open under a folder of their own inside the app's Chats folder, which no
 * session works in, so the page belongs to no session's tabs and opens in
 * the browser's own window.
 */
let previewWorkspace: Promise<string> | null = null;
export function forwardsBrowserWorkspace(): Promise<string> {
  previewWorkspace ??= api.chatsDir().then(
    (chats) => `${chats.replace(/\/+$/, "")}/.forwarded-ports`,
    (error: unknown) => {
      previewWorkspace = null;
      throw error;
    },
  );
  return previewWorkspace;
}

/** Opens a forward's address in TerminalX's built-in browser, not the system's, and brings its window forward. */
export async function openForwardInBrowser(localPort: number): Promise<void> {
  const workspace = await forwardsBrowserWorkspace();
  const pageId = await openBrowserPage(workspace, forwardUrl(localPort));
  await browserApi.activatePage(pageId, true);
}

// ---- toasts

export interface PortToast {
  id: string;
  connectionId: string;
  forward: CloudPortForward;
}

/** How long a "Port N forwarded" toast stays unless closed. */
export const PORT_TOAST_MS = 12_000;

let toasts: PortToast[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emitToasts() {
  for (const listener of toastListeners) listener();
}

function raiseToast(connectionId: string, forward: CloudPortForward) {
  if (!forward || typeof forward.port !== "number" || typeof forward.localPort !== "number") return;
  const id = `port-toast-${++toastSeq}`;
  // One toast per port: a newer one replaces it.
  toasts = [...toasts.filter((toast) => !(toast.connectionId === connectionId && toast.forward.port === forward.port)), { id, connectionId, forward }];
  toastTimers.set(
    id,
    setTimeout(() => dismissPortToast(id), PORT_TOAST_MS),
  );
  emitToasts();
}

export function dismissPortToast(id: string) {
  const timer = toastTimers.get(id);
  if (timer) clearTimeout(timer);
  toastTimers.delete(id);
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emitToasts();
}

/** The toasts for forwards that opened unasked on `connectionId`. */
export function usePortToasts(connectionId: string | null): PortToast[] {
  const all = useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => toastListeners.delete(listener);
    },
    () => toasts,
    () => toasts,
  );
  return connectionId ? all.filter((toast) => toast.connectionId === connectionId) : [];
}

/** Forgets every connection's forwards, toasts and the event subscription (tests). */
export function resetPortForwards() {
  entries.clear();
  mutations.clear();
  for (const timer of toastTimers.values()) clearTimeout(timer);
  toastTimers.clear();
  toasts = [];
  previewWorkspace = null;
  const was = listening;
  listening = null;
  void was?.then((stop) => stop()).catch(() => undefined);
  emit();
  emitToasts();
}
