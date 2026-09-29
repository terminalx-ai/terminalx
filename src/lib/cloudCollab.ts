import { useSyncExternalStore } from "react";
import type { WorkspaceConnectionState, WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import {
  WorkspaceCollab,
  collabGranted,
  leaseHeldBy,
  type CollabEvent,
  type Participant,
  type PresenceActivity,
  type TabLease,
  type WorkspaceNote,
} from "@terminalx/portable/workspaceCollab";

/**
 * Presence, notes and tab leases of a shared cloud workspace (PRO-30,
 * docs/CLOUD-SHARING.md), per workspace. Fed by `collab.state` once per
 * connection, then by the runtime's `collab.*` and `notes.posted`
 * notifications. Only a connection the runtime granted `collab/1` has any
 * of it; without it the workspace behaves as before sharing existed.
 */
export interface TabNotes {
  notes: WorkspaceNote[];
  more: boolean;
  loaded: boolean;
}

export interface CollabSnapshot {
  /** The current connection was granted `collab/1`. */
  available: boolean;
  you: WorkspaceYou | null;
  participants: Participant[];
  /** By tab; null once the runtime said the tab has no lease. */
  leases: Record<string, TabLease | null>;
  notes: Record<string, TabNotes>;
  error: string | null;
}

interface Presence {
  tabId: string | null;
  activity: PresenceActivity;
  /** When "typing" was last sent. */
  typingSentAt: number;
  idle: ReturnType<typeof setTimeout> | null;
}

interface Store {
  snapshot: CollabSnapshot;
  listeners: Set<() => void>;
  presence: Presence;
  client: WorkspaceRpcClient | null;
}

/** A typing indicator is refreshed at most this often while someone keeps typing. */
export const TYPING_REFRESH_MS = 10_000;
/** Back to "viewing" after this long without a keystroke. */
export const TYPING_IDLE_MS = 4_000;

const EMPTY: CollabSnapshot = { available: false, you: null, participants: [], leases: {}, notes: {}, error: null };
const stores = new Map<string, Store>();

function store(key: string): Store {
  let s = stores.get(key);
  if (!s) {
    s = { snapshot: EMPTY, listeners: new Set(), presence: { tabId: null, activity: "viewing", typingSentAt: 0, idle: null }, client: null };
    stores.set(key, s);
  }
  return s;
}

function set(s: Store, change: Partial<CollabSnapshot>) {
  s.snapshot = { ...s.snapshot, ...change };
  for (const listener of [...s.listeners]) listener();
}

export function useCollab(key: string): CollabSnapshot {
  const s = store(key);
  return useSyncExternalStore(
    (listener) => {
      s.listeners.add(listener);
      return () => s.listeners.delete(listener);
    },
    () => s.snapshot,
    () => EMPTY,
  );
}

export function getCollab(key: string): CollabSnapshot {
  return store(key).snapshot;
}

/** Forget every workspace's collaboration state (sign-out, organization switch, tests). */
export function resetCollab() {
  for (const s of stores.values()) if (s.presence.idle) clearTimeout(s.presence.idle);
  stores.clear();
}

/** Who this connection is: the runtime's latest word, else its `rpc.hello`. */
export function effectiveYou(state: WorkspaceConnectionState, snapshot: CollabSnapshot): WorkspaceYou | null {
  if (state.state !== "connected") return null;
  return snapshot.you ?? state.you ?? null;
}

export function canDrive(you: WorkspaceYou | null): boolean {
  return you?.role === "driver" || you?.role === "manager";
}

export function canApprove(you: WorkspaceYou | null): boolean {
  return you?.role === "manager" || !!you?.canApprove;
}

/** A participate connection the workspace is not shared with: it sees no content. */
export function notShared(state: WorkspaceConnectionState, you: WorkspaceYou | null): boolean {
  return state.state === "connected" && state.authority === "participate" && you?.role === "none";
}

export function applyCollabEvent(key: string, event: CollabEvent) {
  const s = store(key);
  switch (event.type) {
    case "presence":
      set(s, { participants: event.participants });
      break;
    case "note": {
      const current = s.snapshot.notes[event.note.tabId] ?? { notes: [], more: false, loaded: false };
      if (current.notes.some((note) => note.id === event.note.id)) return;
      const notes = [...current.notes, event.note].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      set(s, { notes: { ...s.snapshot.notes, [event.note.tabId]: { ...current, notes } } });
      break;
    }
    case "lease": {
      set(s, { leases: { ...s.snapshot.leases, [event.tabId]: event.lease } });
      break;
    }
    case "you": {
      const before = s.snapshot.you;
      set(s, { you: event.you });
      // Shared again (or for the first time): what was hidden can be read now.
      if (before?.role === "none" && event.you.role !== "none" && s.client) void refreshCollab(key, s.client);
      break;
    }
  }
}

async function refreshCollab(key: string, client: WorkspaceRpcClient) {
  const s = store(key);
  try {
    const state = await new WorkspaceCollab(client).state();
    if (s.client !== client) return;
    set(s, {
      you: state.you,
      participants: state.participants,
      leases: Object.fromEntries(state.leases.map((lease) => [lease.tabId, lease])),
      error: null,
    });
  } catch (error) {
    if (s.client === client) set(s, { error: codeOf(error) });
  }
}

/**
 * Follow a connected workspace's collaboration state. Call on every
 * (re)connect; returns what stops following it.
 */
export function startCollab(key: string, client: WorkspaceRpcClient): () => void {
  const s = store(key);
  const state = client.connection;
  if (!collabGranted(state)) {
    s.client = null;
    set(s, { ...EMPTY });
    return () => undefined;
  }
  s.client = client;
  const you = state.state === "connected" ? (state.you ?? null) : null;
  set(s, { available: true, you, error: null });
  const stop = new WorkspaceCollab(client).onEvent((event) => applyCollabEvent(key, event));
  if (you?.role !== "none") {
    void refreshCollab(key, client);
    // A new connection has no presence on the runtime yet.
    if (s.presence.tabId !== null) sendPresence(s, { tabId: s.presence.tabId, activity: "viewing" });
  }
  return () => {
    stop();
    if (s.client === client) s.client = null;
  };
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : String(error);
}

function active(s: Store): WorkspaceRpcClient | null {
  if (!s.client || !s.snapshot.available || s.snapshot.you?.role === "none") return null;
  return s.client;
}

function sendPresence(s: Store, update: { tabId: string | null; activity: PresenceActivity }) {
  const client = active(s);
  if (!client) return;
  void new WorkspaceCollab(client).updatePresence(update).catch(() => undefined);
}

/** The person switched to an agent tab or terminal (`null`: neither). */
export function presenceTab(key: string, tabId: string | null) {
  const s = store(key);
  const p = s.presence;
  if (p.tabId === tabId) return;
  p.tabId = tabId;
  p.activity = "viewing";
  if (p.idle) clearTimeout(p.idle);
  p.idle = null;
  sendPresence(s, { tabId, activity: "viewing" });
}

/** A keystroke in the composer: "typing" (throttled), then "viewing" once idle. */
export function presenceTyping(key: string) {
  const s = store(key);
  const p = s.presence;
  if (!active(s)) return;
  const now = Date.now();
  if (p.activity !== "typing" || now - p.typingSentAt >= TYPING_REFRESH_MS) {
    p.activity = "typing";
    p.typingSentAt = now;
    sendPresence(s, { tabId: p.tabId, activity: "typing" });
  }
  if (p.idle) clearTimeout(p.idle);
  p.idle = setTimeout(() => {
    p.idle = null;
    p.activity = "viewing";
    sendPresence(s, { tabId: p.tabId, activity: "viewing" });
  }, TYPING_IDLE_MS);
}

// ---- notes

export async function loadNotes(key: string, client: WorkspaceRpcClient, tabId: string) {
  const s = store(key);
  const listed = await new WorkspaceCollab(client).listNotes(tabId);
  const current = s.snapshot.notes[tabId];
  // Notes that arrived by notification while listing stay.
  const byId = new Map([...listed.notes, ...(current?.notes ?? [])].map((note) => [note.id, note]));
  const notes = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  set(s, { notes: { ...s.snapshot.notes, [tabId]: { notes, more: listed.more, loaded: true } } });
}

/** A note for the other people on the workspace; it never reaches the agent. */
export async function postNote(key: string, client: WorkspaceRpcClient, tabId: string, text: string): Promise<WorkspaceNote> {
  const note = await new WorkspaceCollab(client).postNote(tabId, text);
  applyCollabEvent(key, { type: "note", note });
  return note;
}

// ---- leases

function setLease(key: string, tabId: string, lease: TabLease | null) {
  applyCollabEvent(key, { type: "lease", tabId, lease });
}

/** Take the wheel. A refusal because someone else holds it records who, then rethrows. */
export async function acquireLease(key: string, client: WorkspaceRpcClient, tabId: string): Promise<TabLease> {
  try {
    const lease = await new WorkspaceCollab(client).acquireLease(tabId);
    setLease(key, tabId, lease);
    return lease;
  } catch (error) {
    const held = leaseHeldBy(error);
    if (held) setLease(key, tabId, held);
    throw error;
  }
}

export async function releaseLease(key: string, client: WorkspaceRpcClient, tabId: string) {
  await new WorkspaceCollab(client).releaseLease(tabId);
  setLease(key, tabId, null);
}

export async function takeOverLease(key: string, client: WorkspaceRpcClient, tabId: string): Promise<TabLease> {
  const lease = await new WorkspaceCollab(client).takeOverLease(tabId);
  setLease(key, tabId, lease);
  return lease;
}

export type { Participant, TabLease, WorkspaceNote };
