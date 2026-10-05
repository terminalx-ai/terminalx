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
  /**
   * By tab: notes from other people that arrived while the Notes drawer was
   * closed, counted on its toggle until it is opened.
   */
  unreadNotes: Record<string, number>;
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
  /** Tabs whose Notes drawer is open: their notes are read as they arrive. */
  notesOpen: Set<string>;
}

/** A typing indicator is refreshed at most this often while someone keeps typing. */
export const TYPING_REFRESH_MS = 10_000;
/** Back to "viewing" after this long without a keystroke. */
export const TYPING_IDLE_MS = 4_000;

const EMPTY: CollabSnapshot = { available: false, you: null, lastYou: null, participants: [], leases: {}, notes: {}, unreadNotes: {}, error: null };
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
    s = { key, snapshot: { ...EMPTY }, presence: { tabId: null, activity: "viewing", typingSentAt: 0, idle: null }, client: null, notesOpen: new Set() };
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
/**
 * Shown in an agent tab's terminal view (PRO-86) to a driver who may not
 * approve: the agent's own screen answers its permission prompts and changes
 * its mode, so typing there needs the same rights as changing its settings.
 */
export const TERMINAL_APPROVAL_REASON =
  "Typing in the agent's terminal can answer its permission requests and change its mode, so it needs approval rights. You can watch here and send messages from the chat.";
/** Shown on permission requests to someone who may not answer them. */
export const APPROVE_BLOCKED_REASON = "Waiting for someone who can approve";

/** Shown when a setting change was dropped because this person may no longer change settings (the receipt's `settingsIgnored`). */
export const SETTINGS_IGNORED_REASON = "Your model, effort or mode change was not applied: you can no longer approve permissions";
/** Why someone who does not manage a workspace cannot switch it between private and organization-visible (PRO-73: its creator and owners and admins manage it). */
export const VISIBILITY_ADMIN_REASON = "Only this workspace's creator or an organization owner or admin can change whether it is private or visible to the organization";
/** Shown to an approver whose connection cannot change a tab's settings live: they ride with the next message. */
export const SETTINGS_WITH_NEXT_MESSAGE = "Model, effort and mode changes apply with your next message";
/** The lock pane of someone whose access ended while they had the session, or who had it before. */
export const ACCESS_REMOVED_TITLE = "Your access to this workspace was removed.";
/** Why Stop, Resume, Archive and Delete are not offered: the API keeps them for whoever manages the workspace, its creator and owners and admins (PRO-73). */
export const LIFECYCLE_ADMIN_REASON = "Only this workspace's creator or an organization owner or admin can stop, archive or delete it";
/**
 * Why a member is not offered a new cloud session, against a server from
 * before PRO-73 only: there, creating a workspace is an owner's or admin's.
 * (With PRO-73 every member starts sessions, in workspaces of their own.)
 */
export const NEW_SESSION_ADMIN_REASON = "Only an organization owner or admin can start a new cloud session";
/** Why a member is not offered "New cloud workspace…" against such a server: the same rule as a new session, which is what creates one. */
export const NEW_WORKSPACE_ADMIN_REASON = "Only an organization owner or admin can create a cloud workspace";

/**
 * What the API lets this person do to a workspace as a whole, from the
 * workspace list (saas contract §21.2) and what opening it would grant:
 *
 * - `lifecycle`: stop, resume, archive, unarchive, delete and the access
 *   mode are for whoever manages the workspace: the API's `manager` role,
 *   which is an organization owner or admin and, since PRO-73, the member
 *   who created it. A share never grants it.
 * - `viewShares`: anyone who sees the workspace may read who it is shared
 *   with (the API allows the list to every member who can see it).
 * - `manageShares`: owners, admins and the creator change it.
 *
 * An older server says neither role nor share rights: nothing about sharing
 * is offered, and the lifecycle follows the attachment authority as before.
 */
export interface WorkspaceAuthority {
  lifecycle: boolean;
  viewShares: boolean;
  manageShares: boolean;
}

export function workspaceAuthority(workspace: {
  you?: { role: WorkspaceYou["role"]; canApprove: boolean; canManageShares?: boolean } | null;
  authority?: string | null;
}): WorkspaceAuthority {
  const { you } = workspace;
  if (!you) return { lifecycle: workspace.authority !== "participate", viewShares: false, manageShares: false };
  const manager = you.role === "manager";
  return { lifecycle: manager, viewShares: true, manageShares: manager || !!you.canManageShares };
}

/**
 * Whether a connection's reconnect reason says this person may no longer
 * open the workspace at all, as opposed to a drop the next attempt may fix.
 * The one reason the desktop's attach really reports for that is
 * `cloud_workspace_not_found`: the API no longer lists the workspace for this
 * person (it went private, they left the organization, or it was deleted).
 * A revoked share closes the connection without a reason and the next attach
 * succeeds with role `none`, which the role reports, not the reason. Nothing
 * broader is matched: a proxy's 403 on the relay handshake is not lost access.
 */
export function accessLostReason(reason: string | null | undefined): boolean {
  return !!reason && /\bcloud_workspace_not_found\b/.test(reason);
}

/** How long the list and the runtime may disagree before the pane stops saying "Checking access…". */
export const ACCESS_GRACE_MS = 15_000;

/**
 * Why a cloud session shows the lock pane instead of its tabs, or null:
 *
 * - `removed`: this person had access and no longer does. Only for a real
 *   transition: a role seen from the runtime in this view, or the session's
 *   conversation kept on this desktop, followed by none.
 * - `not-shared`: they never had it.
 * - `checking`: the workspace list says it is shared with them but the
 *   runtime does not (yet): normal for a few seconds after a share, until the
 *   runtime reads its member list. After `ACCESS_GRACE_MS` it is `pending`.
 *
 * The runtime's role decides while connected, else the list's or the last
 * one seen; a reconnect refused for access counts as none.
 */
export type AccessLoss = "removed" | "not-shared" | "checking" | "pending";

export function accessLoss(input: {
  state: WorkspaceConnectionState;
  /** The live role while connected, else the list's or the last one seen. */
  you: WorkspaceYou | null;
  /** This person had a role here earlier in this view, or this desktop holds the session's conversation. */
  hadAccess: boolean;
  /** The workspace list says it is shared with this person, and nothing seen later says otherwise. */
  listShared?: boolean;
  /** How long the runtime has said none while the list says shared. */
  disagreeingMs?: number;
}): AccessLoss | null {
  const { state, you } = input;
  if (state.state === "reconnecting" && accessLostReason(state.reason)) return input.hadAccess ? "removed" : "not-shared";
  // A manage attachment is an admin's: the runtime closes it rather than leave it with role none.
  const none = sharingKnown(you) && you.role === "none" && !(state.state === "connected" && state.authority === "manage");
  if (!none) return null;
  if (state.state === "connected" && input.listShared) return (input.disagreeingMs ?? 0) < ACCESS_GRACE_MS ? "checking" : "pending";
  return input.hadAccess ? "removed" : "not-shared";
}

// ---- access changes

type AccessListener = (orgId: string) => void;
const accessListeners = new Set<AccessListener>();

/**
 * Told whenever who may open a workspace of `orgId` changed as far as this
 * desktop can see: its own role, the people the runtime lists, or a share or
 * visibility change made here. The catalog lists the organization again, so
 * rows and chips follow without a manual refresh. Listing never wakes compute.
 */
export function onAccessChanged(listener: AccessListener): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

export function notifyAccessChanged(orgId: string | null | undefined) {
  if (!orgId) return;
  for (const listener of [...accessListeners]) {
    try {
      listener(orgId);
    } catch {
      /* one listener never stops the others */
    }
  }
}

type WorkspaceAccessListener = (key: string, access: "lost" | "regained") => void;
const workspaceAccessListeners = new Set<WorkspaceAccessListener>();

/**
 * Told when this person's access to one workspace (`cloud:<orgId>:<workspaceId>`)
 * ended as its runtime or the API sees it (role none, or a reconnect refused
 * for access), and when a role came back on the same connection. On a loss
 * the sidebar forgets the workspace's sessions, tabs and terminals at once,
 * without waiting for the next list.
 */
export function onWorkspaceAccess(listener: WorkspaceAccessListener): () => void {
  workspaceAccessListeners.add(listener);
  return () => workspaceAccessListeners.delete(listener);
}

function notifyWorkspaceAccess(key: string, access: "lost" | "regained") {
  for (const listener of [...workspaceAccessListeners]) {
    try {
      listener(key, access);
    } catch {
      /* one listener never stops the others */
    }
  }
}

/** The organization of a `cloud:<orgId>:<workspaceId>` key. */
function orgOf(key: string): string | null {
  const parts = key.split(":");
  return parts[0] === "cloud" && parts.length >= 3 ? parts[1] : null;
}

/** Who is listed with which rights: what a share change alters, not what they look at. */
function membersKey(participants: readonly Participant[]): string {
  return participants
    .map((person) => `${person.userId}:${person.role}:${person.canApprove ? 1 : 0}`)
    .sort()
    .join(",");
}

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
  // Without this person's own id (the list's role, before a connection) a lease cannot be called someone else's.
  const heldByOther = !!you && !!you.userId && !!liveLease && liveLease.holderId !== you.userId;
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

/**
 * A shell is arbitrary code as the workspace's user, so typing into a
 * terminal needs what changing an agent's settings needs: a manager, or a
 * driver who may approve permissions (PRO-88; the runtime refuses the rest).
 */
export function canTypeInTerminals(you: WorkspaceYou | null): boolean {
  return you?.role === "manager" || (canDrive(you) && !!you?.canApprove);
}

/** Why a driver without the approval right only watches terminals. */
export const TERMINAL_APPROVER_REASON = "typing in a terminal needs the right to approve permissions; ask an admin.";

/**
 * Receipt categories of a message the runtime refused because the agent's CLI
 * would run it by itself: a slash command, a `!` shell command, or an `@`
 * mention of a file outside the project (PRO-88). Only a manager or an
 * approver sends those.
 */
const INPUT_REFUSALS: Record<string, string> = {
  "slash-command-forbidden": "Not sent: that command needs someone who can approve permissions.",
  "shell-command-forbidden": "Not sent: a message that starts with ! runs as a shell command, which needs someone who can approve permissions.",
  "file-mention-forbidden": "Not sent: attaching a file from outside the project needs someone who can approve permissions.",
  // For everyone: a slash or `!` command is not queued behind a running turn.
  "command-not-queued": "Not sent: a turn is running. Send this command when it has ended.",
  // For everyone (PRO-22): the message names an image the runtime does not hold.
  "attachment-missing": "Not sent: an image of this message did not reach the workspace. Attach it and send again.",
};

/**
 * Why the runtime refused a message, or null when the category is not one of
 * these. The receipt's own `message` names the command and what this agent's
 * CLI accepts instead; without a readable receipt (its key is gone) the
 * category's sentence is shown.
 */
export function inputRefusalText(category: string | null | undefined, receipt: Record<string, unknown> | null | undefined): string | null {
  const fallback = category ? INPUT_REFUSALS[category] : undefined;
  if (!fallback) return null;
  const message = receipt?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 400) return fallback;
  return /^not sent/i.test(message) ? message : `Not sent: ${message.replace(/ was not sent: /, ": ")}`;
}

/** A participate connection the workspace is not shared with: it sees no content. */
export function notShared(state: WorkspaceConnectionState, you: WorkspaceYou | null): boolean {
  // `listed: false`: the runtime has no member list yet and serves what it
  // did before sharing existed, so this is not "not shared".
  return state.state === "connected" && state.authority === "participate" && you?.role === "none" && you.listed !== false;
}

/**
 * This person lost access to the workspace (role none, or a reconnect refused
 * for access): drop its leases, people and notes, and stop following the
 * connection. `lastYou` then says "none", so reopening shows the lock pane.
 */
export function clearCollabAccess(key: string) {
  const s = store(key);
  notifyWorkspaceAccess(key, "lost");
  if (s.presence.idle) clearTimeout(s.presence.idle);
  s.presence.idle = null;
  s.notesOpen.clear();
  const { snapshot } = s;
  const cleared = snapshot.lastYou?.role === "none" && !snapshot.participants.length && !Object.keys(snapshot.leases).length && !Object.keys(snapshot.notes).length;
  if (cleared && (!snapshot.you || snapshot.you.role === "none")) return;
  const none: WorkspaceYou = { userId: snapshot.you?.userId ?? snapshot.lastYou?.userId ?? "", role: "none", canApprove: false };
  set(s, { you: snapshot.you ? none : null, lastYou: none, participants: [], leases: {}, notes: {}, unreadNotes: {}, error: null });
}

/** Forget the last access this desktop saw here, so the next connection decides afresh. */
export function forgetCollabAccess(key: string) {
  const s = store(key);
  if (s.snapshot.you || !s.snapshot.lastYou) return;
  set(s, { lastYou: null });
}

/** The Notes drawer of a tab opened or closed: while open, its notes are read as they arrive. */
export function setNotesOpen(key: string, tabId: string, open: boolean) {
  const s = store(key);
  if (open) s.notesOpen.add(tabId);
  else s.notesOpen.delete(tabId);
  if (open && s.snapshot.unreadNotes[tabId]) {
    const unreadNotes = { ...s.snapshot.unreadNotes };
    delete unreadNotes[tabId];
    set(s, { unreadNotes });
  }
}

/** Remember this person's access from the share list (it answers while the workspace sleeps). */
export function rememberYou(key: string, you: { role: WorkspaceYou["role"]; canApprove: boolean }) {
  const s = store(key);
  if (s.snapshot.you) return;
  set(s, { lastYou: { userId: s.snapshot.lastYou?.userId ?? "", role: you.role, canApprove: you.canApprove } });
}

/** Who this person is for gating controls: live when connected, else the last known. */
export function knownYou(state: WorkspaceConnectionState, snapshot: CollabSnapshot): WorkspaceYou | null {
  // Until the store follows this connection, its hello already says who this is.
  if (state.state === "connected") return snapshot.available ? (snapshot.you ?? (state.you ?? null)) : collabGranted(state) ? (state.you ?? null) : null;
  return snapshot.lastYou;
}

export function applyCollabEvent(key: string, event: CollabEvent) {
  const s = store(key);
  switch (event.type) {
    case "presence": {
      const before = membersKey(s.snapshot.participants);
      set(s, { participants: event.participants });
      // Someone was added, removed or changed role: the share count and chips are stale.
      if (before !== membersKey(event.participants)) notifyAccessChanged(orgOf(key));
      break;
    }
    case "note": {
      const tabId = event.note.tabId;
      const current = s.snapshot.notes[tabId] ?? { notes: [], more: false, loaded: false };
      if (current.notes.some((note) => note.id === event.note.id)) return;
      const notes = [...current.notes, event.note].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      // Someone else's note with the drawer closed is unread until it is opened.
      const mine = !!s.snapshot.you?.userId && event.note.authorId === s.snapshot.you.userId;
      const unread = mine || s.notesOpen.has(tabId) ? s.snapshot.unreadNotes : { ...s.snapshot.unreadNotes, [tabId]: (s.snapshot.unreadNotes[tabId] ?? 0) + 1 };
      set(s, { notes: { ...s.snapshot.notes, [tabId]: { ...current, notes } }, unreadNotes: unread });
      break;
    }
    case "lease": {
      set(s, { leases: { ...s.snapshot.leases, [event.tabId]: event.lease } });
      break;
    }
    case "you": {
      const before = s.snapshot.you;
      if (event.you.role === "none" && event.you.listed !== false) {
        // Access ended: nothing of the workspace's people, leases or notes stays on screen.
        if (s.presence.idle) clearTimeout(s.presence.idle);
        s.presence.idle = null;
        s.notesOpen.clear();
        set(s, { you: event.you, lastYou: event.you, participants: [], leases: {}, notes: {}, unreadNotes: {}, error: null });
        notifyWorkspaceAccess(key, "lost");
      } else {
        set(s, { you: event.you, lastYou: event.you });
      }
      // Shared again (or for the first time): what was hidden can be read now.
      if (before?.role === "none" && event.you.role !== "none" && s.client) void refreshCollab(key, s.client);
      if (before?.role === "none" && event.you.role !== "none") notifyWorkspaceAccess(key, "regained");
      if (before?.role !== event.you.role || before?.canApprove !== event.you.canApprove) notifyAccessChanged(orgOf(key));
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
  const before = s.snapshot.lastYou;
  if (you?.role === "none" && you.listed !== false) {
    // Reconnected without access (the share was revoked): leases, people and notes of before are not shown.
    s.notesOpen.clear();
    set(s, { available: true, you, lastYou: you, participants: [], leases: {}, notes: {}, unreadNotes: {}, error: null });
    notifyWorkspaceAccess(key, "lost");
  } else {
    set(s, { available: true, you, lastYou: you ?? s.snapshot.lastYou, error: null });
  }
  // The role differs from what this desktop last knew: the list's rows and chips are stale.
  if (you && sharingKnown(you) && before && (before.role !== you.role || before.canApprove !== you.canApprove)) notifyAccessChanged(orgOf(key));
  const stop = new WorkspaceCollab(client).onEvent((event) => applyCollabEvent(key, event));
  if (you?.role !== "none") {
    void refreshCollab(key, client);
    // A new connection has no presence on the runtime yet.
    if (s.presence.tabId !== null) sendPresence(s, { tabId: s.presence.tabId, activity: "viewing" });
  }
  return () => {
    stop();
    if (s.client !== client) return;
    s.client = null;
    // What this connection said about the person ends with it: the next one's
    // hello decides afresh, and `lastYou` answers meanwhile. Nothing stale is
    // read as live after a reconnect.
    if (stores.get(s.key) === s && (s.snapshot.available || s.snapshot.you)) set(s, { available: false, you: null });
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
