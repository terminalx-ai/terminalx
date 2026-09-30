import { useCallback, useSyncExternalStore } from "react";
import type { WorkspaceConnectionState, WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import {
  WorkspaceCollab,
  collabGranted,
  leaseHeldBy,
  leaseLive,
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
  /**
   * The last access this person was known to have here, kept across
   * disconnects and filled from the share list, so a sleeping workspace still
   * shows a viewer's controls as a viewer's.
   */
  lastYou: WorkspaceYou | null;
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
  key: string;
  snapshot: CollabSnapshot;
  presence: Presence;
  client: WorkspaceRpcClient | null;
}

/** A typing indicator is refreshed at most this often while someone keeps typing. */
export const TYPING_REFRESH_MS = 10_000;
/** Back to "viewing" after this long without a keystroke. */
export const TYPING_IDLE_MS = 4_000;

const EMPTY: CollabSnapshot = { available: false, you: null, lastYou: null, participants: [], leases: {}, notes: {}, error: null };
const stores = new Map<string, Store>();

/**
 * Subscribers per workspace key, kept apart from the stores so a view that
 * stays mounted across `resetCollab` follows the new store, not the
 * discarded one.
 */
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

function subscribeTo(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}

function store(key: string): Store {
  let s = stores.get(key);
  if (!s) {
    s = { key, snapshot: { ...EMPTY }, presence: { tabId: null, activity: "viewing", typingSentAt: 0, idle: null }, client: null };
    stores.set(key, s);
  }
  return s;
}

function set(s: Store, change: Partial<CollabSnapshot>) {
  s.snapshot = { ...s.snapshot, ...change };
  // A store dropped by `resetCollab` no longer speaks for its key.
  if (stores.get(s.key) === s) notify(s.key);
}

export function useCollab(key: string): CollabSnapshot {
  const subscribe = useCallback((listener: () => void) => subscribeTo(key, listener), [key]);
  const snapshot = useCallback(() => store(key).snapshot, [key]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

export function getCollab(key: string): CollabSnapshot {
  return store(key).snapshot;
}

/** Forget every workspace's collaboration state (sign-out, organization switch, tests). */
export function resetCollab() {
  for (const s of stores.values()) if (s.presence.idle) clearTimeout(s.presence.idle);
  stores.clear();
  // Mounted views read their (now empty) new store.
  for (const key of [...listeners.keys()]) notify(key);
}

/** Forget one organization's workspaces (the user left it); keys are `cloud:<orgId>:<workspaceId>`. */
export function dropCollabIn(orgId: string) {
  const prefix = `cloud:${orgId}:`;
  for (const [key, s] of [...stores]) {
    if (!key.startsWith(prefix)) continue;
    if (s.presence.idle) clearTimeout(s.presence.idle);
    stores.delete(key);
    notify(key);
  }
}

/** What a composer says to someone the workspace is shared with as a viewer. */
export const VIEWER_REASON = "You can view this workspace; ask an admin for driver access";
/** What a composer says to a member the workspace is not shared with. */
export const NOT_SHARED_REASON = "This workspace has not been shared with you. Ask an organization admin or its creator to share it.";
/** Shown on the model, effort and mode pickers to someone who may not change them (review M1). */
export const SETTINGS_LOCKED_REASON = "Only a workspace admin or someone who can approve permissions changes the model, effort or permission mode";
/** Shown on permission requests to someone who may not answer them. */
export const APPROVE_BLOCKED_REASON = "Waiting for someone who can approve";

/**
 * This person's access from the workspace list (saas contract §21.2), before
 * or without a connection. Null on an older server, which does not say.
 */
export function listedYou(you: { role: WorkspaceYou["role"]; canApprove: boolean } | null | undefined): WorkspaceYou | null {
  return you ? { userId: "", role: you.role, canApprove: you.canApprove } : null;
}

/** Whether `you` says anything about sharing (a runtime without a member list yet does not). */
export function sharingKnown(you: WorkspaceYou | null | undefined): you is WorkspaceYou {
  return !!you && you.listed !== false;
}

/** Why this person may not send to a shared workspace's agents at all, or null. */
export function roleBlockReason(you: WorkspaceYou | null | undefined): string | null {
  if (!sharingKnown(you)) return null;
  if (you.role === "none") return NOT_SHARED_REASON;
  if (you.role === "viewer") return VIEWER_REASON;
  return null;
}

export interface TabGate {
  /** The lease the runtime still honours: live, or held for a running turn. */
  liveLease: TabLease | null;
  /** Why the composer is off for this person on this tab, or null. */
  blocked: string | null;
  mayStop: boolean;
  /** Why this person may not answer the tab's permission requests, or null. */
  approveBlocked: string | null;
  /** May change the tab's model, effort and permission mode (a manager or an approver). */
  mayConfigure: boolean;
}

/**
 * Model, effort and permission mode decide what the agent may do without
 * asking (bypassPermissions): only a manager or an approver changes them;
 * the runtime ignores them from anyone else (review M1). Sharing unknown:
 * the attachment rules apply as before.
 */
export function mayConfigure(you: WorkspaceYou | null | undefined): boolean {
  if (!sharingKnown(you)) return true;
  return you.role === "manager" || (canDrive(you) && you.canApprove);
}

/**
 * The PRO-30 rules for one agent tab: viewers read, one driver at a time holds
 * the tab's lease (a manager may take it over), and only approvers answer
 * permission requests. `you` null: sharing does not apply (an older runtime).
 */
export function tabGate(
  you: WorkspaceYou | null,
  lease: TabLease | null,
  now: number,
  turnRunning: boolean,
  nameOf: (userId: string | null | undefined) => string,
): TabGate {
  // The runtime keeps the holder's lease for as long as their turn runs.
  const liveLease = leaseLive(lease, now) || (lease && turnRunning) ? lease : null;
  const heldByOther = !!you && !!liveLease && liveLease.holderId !== you.userId;
  let blocked: string | null = null;
  if (you && !canDrive(you)) blocked = you.role === "none" && you.listed !== false ? NOT_SHARED_REASON : VIEWER_REASON;
  else if (you && heldByOther)
    blocked =
      you.role === "manager"
        ? `${nameOf(liveLease!.holderId)} is driving this tab. Take over to send.`
        : `${nameOf(liveLease!.holderId)} is driving this tab. You can send once they release it.`;
  const mayStop = !you || you.role === "manager" || (!!liveLease && liveLease.holderId === you.userId) || (!liveLease && canDrive(you));
  const approveBlocked = you && !canApprove(you) ? APPROVE_BLOCKED_REASON : null;
  return { liveLease, blocked, mayStop, approveBlocked, mayConfigure: mayConfigure(you) };
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
  // `listed: false`: the runtime has no member list yet and serves what it
  // did before sharing existed, so this is not "not shared".
  return state.state === "connected" && state.authority === "participate" && you?.role === "none" && you.listed !== false;
}

/** Remember this person's access from the share list (it answers while the workspace sleeps). */
export function rememberYou(key: string, you: { role: WorkspaceYou["role"]; canApprove: boolean }) {
  const s = store(key);
  if (s.snapshot.you) return;
  set(s, { lastYou: { userId: s.snapshot.lastYou?.userId ?? "", role: you.role, canApprove: you.canApprove } });
}

/** Who this person is for gating controls: live when connected, else the last known. */
export function knownYou(state: WorkspaceConnectionState, snapshot: CollabSnapshot): WorkspaceYou | null {
  if (state.state === "connected") return snapshot.available ? (snapshot.you ?? (state.you ?? null)) : null;
  return snapshot.lastYou;
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
      set(s, { you: event.you, lastYou: event.you });
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
    set(s, { ...EMPTY, lastYou: s.snapshot.lastYou });
    return () => undefined;
  }
  s.client = client;
  const you = state.state === "connected" ? (state.you ?? null) : null;
  set(s, { available: true, you, lastYou: you ?? s.snapshot.lastYou, error: null });
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
