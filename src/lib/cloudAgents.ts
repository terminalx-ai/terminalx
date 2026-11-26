import { cloudActivityRead, subscribeCloudReadMarkers, writeCloudReadMarker } from "@/lib/cloudReadMarkers";
import { keepMessageTime, newestMessageTime } from "@/lib/messageActivity";
import { useSyncExternalStore } from "react";
import { WorkspaceRpcError, type RuntimeIssuePipeline, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { applyEvent, dropTabLog, getTabLog, lastSeq, mergeTabEvents, setFeedContinuity } from "@/lib/agentEvents";
import type { FileInput, ImageInput } from "@/lib/api";
import { CLOUD_FILES_NEED_CONNECTION, CLOUD_FILES_OLD_RUNTIME, CLOUD_IMAGES_NEED_CONNECTION, CloudImageError, cloudFilesBlocked, cloudImagesBlocked, uploadAgentFiles, uploadCloudImages } from "@/lib/cloudComposer";
import type { CloudFileRef, CloudImageRef } from "@/lib/cloudAgentApi";
import {
  cloudAgentApi,
  TERMINAL_OUTBOX_STATES,
  type AgentTabInfo,
  type AgentTabStatus,
  type CachedTab,
  type CloudAgentScope,
  type FollowUpChange,
  type OutboxEntry,
  type OutboxKind,
  type OutboxPayload,
  type WakeResult,
} from "@/lib/cloudAgentApi";
import type { AgentEvent } from "@/types/events";
import { inputRefusalText } from "@/lib/cloudCollab";
import { DEFAULT_PERMISSION_MODE } from "@/lib/models";
import { clearDrafts, getDraft, setDraft, subscribeDrafts } from "@/lib/drafts";
import { dismissErrorKey, showError } from "@/lib/errorToasts";

/**
 * Agent tabs of cloud workspaces (PRO-22), per organization and workspace.
 *
 * The runtime is the only writer of a tab's transcript. The desktop shows,
 * from cheapest to most current: its local cache, the newest encrypted
 * checkpoint (only when newer, and never once a live stream is attached),
 * then the live stream, and only while the runtime is already online.
 * Reading never wakes compute; only a command (send, steer, decision) may,
 * and commands go through the API mailbox with a stable id, so a reconnect
 * never repeats a prompt or an approval.
 */
export interface CloudAgentTab {
  tabId: string;
  info: AgentTabInfo;
  /** Where `info` came from last. */
  source: "cache" | "checkpoint" | "live";
  /** Known only from checkpoint metadata so far; opening it fetches the rest. */
  placeholder: boolean;
  cursor: string | null;
  checkpoint: { epoch: number; version: number } | null;
  unread: boolean;
  completed: boolean;
  /** A live `session.subscribe` is feeding this tab. */
  live: boolean;
  /**
   * Its conversation has been read from somewhere (this desktop's cache, a
   * checkpoint, the live replay), or it has none to read. Until then an empty
   * transcript means "not here yet", not "nothing was said".
   */
  historyRead: boolean;
  /** Model, effort or mode chosen while offline, carried in the next send. */
  pendingConfig: { model?: string; effort?: string | null; mode?: string } | null;
  /**
   * A setting change of this tab was dropped: the runtime's receipt said
   * `settingsIgnored` (this person may no longer approve), or it was not sent
   * for that reason. Shown until the next change or message; not saved.
   */
  settingsIgnored?: boolean;
  /** Unsent composer text, kept with the cache so a relaunch brings it back. */
  draft?: string;
}

export interface CloudAgentsSnapshot {
  tabs: CloudAgentTab[];
  outbox: OutboxEntry[];
  loaded: boolean;
  /**
   * The runtime's own tab list has come over the connection that is up
   * (#1379): `loaded` is also true from the cache alone, even an empty or
   * failed one, which says nothing of which tabs the runtime still has.
   */
  liveListed: boolean;
  /** What the last interactive command did to the workspace's compute. */
  wake: WakeResult | null;
  error: string | null;
  version: number;
}

interface Store {
  scope: CloudAgentScope;
  /** The account the store was made for: its cache is read and written for it alone. */
  account: string;
  tabs: Map<string, CloudAgentTab>;
  outbox: OutboxEntry[];
  loaded: boolean;
  liveListed: boolean;
  loading: Promise<void> | null;
  wake: WakeResult | null;
  error: string | null;
  snapshot: CloudAgentsSnapshot;
  listeners: Set<() => void>;
  poll: ReturnType<typeof setTimeout> | null;
  /** A sync is in flight; the loop reschedules itself when it returns. */
  polling: boolean;
  /** Asked to poll again soon while a sync was in flight. */
  pollKick: boolean;
  pollDelay: number;
  saves: Map<string, ReturnType<typeof setTimeout>>;
  /** Decisions being enqueued right now, by request id. */
  deciding: Set<string>;
}

export const POLL_FIRST_MS = 1_000;
export const POLL_MAX_MS = 15_000;
export const SAVE_DEBOUNCE_MS = 500;
/** Committed events kept in the local cache per tab. */
const CACHE_EVENTS = 2_000;

const stores = new Map<string, Store>();
const deniedWorkspaces = new Set<string>();
/** Issued mutations outlive disposable stores. Do not clear this queue on
 * account changes: A -> B -> A must still wait for A's older native operation. */
const cacheMutations = new Map<string, Promise<void>>();
/** The signed-in account (`context.account`), as `@/lib/account` reports it; "" while signed out. */
let account = "";

/** Told by `@/lib/account` whenever the status changes. Stores made from now on are this account's. */
export function setCloudAgentAccount(next: string | null) {
  if (account === (next ?? "")) return;
  account = next ?? "";
  loadDeniedWorkspaces();
}

/** The account a store's cache belongs to; one made before anyone was known takes the first account it is used under. */
function cacheAccount(s: Store): string {
  if (!s.account) s.account = account;
  return s.account;
}
/** Told when any workspace's tabs change (the dashboard, notifications and palette read every workspace). */
const anyListeners = new Set<() => void>();

/** Follow every workspace's tabs at once; the listener is told after any change. */
export function subscribeAllCloudAgents(listener: () => void): () => void {
  anyListeners.add(listener);
  return () => anyListeners.delete(listener);
}

/**
 * A runtime with no organization: a paired machine (PRO-345). It has no API
 * mailbox, keys, checkpoints or cache. Every command goes over the live
 * connection: with `agent-commands/1` (PRO-343) send, steer, stop and
 * decisions alike, each answered once per id from the machine's receipts;
 * on an older machine only prompts.
 */
export function isDevScope(scope: CloudAgentScope): boolean {
  return !scope.organizationId;
}

/** An older machine, without `agent-commands/1`. */
export const DEV_SCOPE_NOTICE = "Steering, stopping and answering approvals need a newer TerminalX on that machine; it only takes prompts.";

/** Nothing is queued on this Mac for a machine it cannot reach (docs/MACHINES.md decision 3). */
export const LIVE_NOT_CONNECTED = "Not connected: nothing is sent until the machine is back.";

/** Whether `scope`'s commands go live, all of them: a machine that serves `agent-commands/1`. */
export function takesLiveCommands(scope: CloudAgentScope, client: WorkspaceRpcClient | null): boolean {
  return isDevScope(scope) && !!client && client.connection.state === "connected" && client.hasCapability("agent-commands/1");
}

export function cloudAgentsKey(scope: CloudAgentScope): string {
  return `${scope.organizationId}:${scope.workspaceId}`;
}

const EMPTY: CloudAgentsSnapshot = { tabs: [], outbox: [], loaded: false, liveListed: false, wake: null, error: null, version: 0 };

function store(scope: CloudAgentScope): Store {
  const k = cloudAgentsKey(scope);
  let s = stores.get(k);
  if (!s) {
    s = {
      scope,
      account,
      tabs: new Map(),
      outbox: [],
      loaded: false,
      liveListed: false,
      loading: null,
      wake: null,
      error: null,
      snapshot: EMPTY,
      listeners: new Set(),
      poll: null,
      polling: false,
      pollKick: false,
      pollDelay: POLL_FIRST_MS,
      saves: new Map(),
      deciding: new Set(),
    };
    stores.set(k, s);
  }
  return s;
}

subscribeCloudReadMarkers(() => {
  for (const s of stores.values()) publish(s);
});

function publish(s: Store) {
  if (stores.get(cloudAgentsKey(s.scope)) !== s) return;
  for (const tab of s.tabs.values()) {
    if (cloudActivityRead(s.scope.organizationId, s.scope.workspaceId, tab.info.sessionId, tab.info.lastMessageAt)) tab.unread = false;
  }
  const tabs = [...s.tabs.values()].sort((a, b) => a.info.created.localeCompare(b.info.created) || a.tabId.localeCompare(b.tabId));
  s.snapshot = { tabs, outbox: s.outbox, loaded: s.loaded, liveListed: s.liveListed, wake: s.wake, error: s.error, version: s.snapshot.version + 1 };
  for (const listener of [...s.listeners]) listener();
  for (const listener of [...anyListeners]) listener();
}

export function useCloudAgents(scope: CloudAgentScope): CloudAgentsSnapshot {
  const s = store(scope);
  return useSyncExternalStore(
    (cb) => {
      s.listeners.add(cb);
      return () => s.listeners.delete(cb);
    },
    () => s.snapshot,
    () => EMPTY,
  );
}

export function getCloudAgents(scope: CloudAgentScope): CloudAgentsSnapshot {
  return store(scope).snapshot;
}

/**
 * Forget every workspace's tabs, their unsent drafts and polling (sign-out,
 * another user signing in, tests). Saves still queued are dropped, not
 * written: they would land in the next account's cache.
 */
export function resetCloudAgents() {
  sentAttachments.clear();
  for (const s of stores.values()) {
    if (s.poll) clearTimeout(s.poll);
    for (const timer of s.saves.values()) clearTimeout(timer);
    for (const tab of s.tabs.values()) if (tab.info.sessionId) dropTabLog(tab.info.sessionId, tab.tabId);
  }
  stores.clear();
  caughtUp.clear();
  // After the stores are gone, so clearing a draft queues no save.
  const typed = new Set(draftTabs);
  draftTabs.clear();
  clearDrafts((tabId) => typed.has(tabId));
}

/**
 * Forget one workspace's tabs, queued saves and polling: it was deleted
 * (a tombstone). Returns how many tabs were known.
 */
export function dropCloudAgents(scope: CloudAgentScope): number {
  const k = cloudAgentsKey(scope);
  const s = stores.get(k);
  if (!s) return 0;
  if (s.poll) clearTimeout(s.poll);
  for (const timer of s.saves.values()) clearTimeout(timer);
  s.saves.clear();
  for (const tab of s.tabs.values()) if (tab.info.sessionId) dropTabLog(tab.info.sessionId, tab.tabId);
  const count = s.tabs.size;
  stores.delete(k);
  const ids = new Set(s.tabs.keys());
  clearDrafts((tabId) => ids.has(tabId));
  for (const id of ids) draftTabs.delete(id);
  return count;
}

function loadDeniedWorkspaces() {
  deniedWorkspaces.clear();
  if (!account) return;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`terminalx.denied-cloud.v1:${encodeURIComponent(account)}`) ?? "[]");
    if (Array.isArray(saved)) for (const key of saved) if (typeof key === "string") deniedWorkspaces.add(key);
  } catch { /* Native authorization remains authoritative if local storage is unavailable. */ }
}
function saveDeniedWorkspaces() {
  if (!account) return;
  localStorage.setItem(`terminalx.denied-cloud.v1:${encodeURIComponent(account)}`, JSON.stringify([...deniedWorkspaces]));
}

/** A revoke hint blocks cache/checkpoint/live reloads until a fresh authorized catalog answers. */
export function setCloudAgentsAccess(scope: CloudAgentScope, allowed: boolean) {
  const key = cloudAgentsKey(scope);
  if (allowed) {
    const wildcard = deniedWorkspaces.delete(`*:${scope.workspaceId}`);
    if (deniedWorkspaces.delete(key) || wildcard) {
      try { saveDeniedWorkspaces(); } catch { /* A stale durable denial can only hide data on relaunch. */ }
    }
    return;
  }
  deniedWorkspaces.add(key);
  const previous = stores.get(key);
  dropCloudAgents(scope);
  if (previous) {
    previous.snapshot = { ...EMPTY, version: previous.snapshot.version + 1 };
    for (const listener of [...previous.listeners]) listener();
  }
  for (const listener of [...anyListeners]) listener();
  // A failed durable write prevents the inbox checkpoint from committing and retries the invalidation.
  saveDeniedWorkspaces();
}

/** A minimal removal may arrive before the catalog knows the workspace's organization. */
export function denyCloudAgentsWorkspace(workspaceId: string) {
  deniedWorkspaces.add(`*:${workspaceId}`);
  for (const s of [...stores.values()]) {
    if (s.scope.workspaceId !== workspaceId) continue;
    dropCloudAgents(s.scope);
    s.snapshot = { ...EMPTY, version: s.snapshot.version + 1 };
    for (const listener of [...s.listeners]) listener();
  }
  for (const listener of [...anyListeners]) listener();
  saveDeniedWorkspaces();
}
export function cloudAgentsAccessDenied(scope: CloudAgentScope) {
  return deniedWorkspaces.has(cloudAgentsKey(scope)) || deniedWorkspaces.has(`*:${scope.workspaceId}`);
}

/** Forget one organization's tabs and polling: the user left it (CS-18). */
export function dropCloudAgentsIn(orgId: string): void {
  for (const key of [...stores.keys()]) {
    if (!key.startsWith(`${orgId}:`)) continue;
    const [organizationId, ...rest] = key.split(":");
    dropCloudAgents({ organizationId, workspaceId: rest.join(":") });
  }
}

export function errorText(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") return (error as { code: string }).code;
  if (error instanceof Error) return error.message;
  return String(error);
}

function placeholderInfo(tabId: string): AgentTabInfo {
  return {
    sessionId: "",
    tabId,
    title: null,
    harness: "claude",
    model: "",
    effort: null,
    permissionMode: DEFAULT_PERMISSION_MODE,
    status: "idle",
    process: "not-started",
    pendingPermissions: [],
    followUps: [],
    lastSeq: 0,
    created: "",
    modified: "",
  };
}

function newTab(info: AgentTabInfo, source: CloudAgentTab["source"], placeholder = false): CloudAgentTab {
  return {
    tabId: info.tabId,
    info,
    source,
    placeholder,
    cursor: null,
    checkpoint: null,
    unread: info.status === "completed",
    completed: info.status === "completed",
    live: false,
    // A tab with no events has nothing to read.
    historyRead: !info.lastSeq,
    pendingConfig: null,
  };
}

/** Old caches/checkpoints predate presence metadata and may have no verified message times. */
function withMessagePresence(info: AgentTabInfo, events: readonly AgentEvent[]): AgentTabInfo {
  if (info.hasMessages) return info;
  const hasMessages = events.some((event) => {
    if (event.subagent || event.sessionId !== info.sessionId || event.tabId !== info.tabId) return false;
    const p = event.payload;
    switch (p.type) {
      case "user_message": return true;
      case "assistant_text": return p.text.length > 0;
      case "turn_completed": return !!p.finalText;
      case "delta": return p.delta === "text_delta" && p.text.length > 0;
      default: return false;
    }
  });
  return hasMessages ? { ...info, hasMessages: true } : info;
}

function newer(a: { epoch: number; version: number }, b: { epoch: number; version: number } | null): boolean {
  if (!b) return true;
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.version > b.version);
}

/**
 * How far this desktop knows a tab: the last event the runtime reported for
 * it, or the last one in the transcript held here, whichever is later. The
 * one seq a checkpoint is compared with, and that decides whether the
 * transcript is behind.
 */
function knownSeq(tab: CloudAgentTab): number {
  return Math.max(tab.info.lastSeq, tab.info.sessionId ? lastSeq(tab.info.sessionId, tab.tabId) : 0);
}

/** A status change: a finished turn is unread until someone looks at it. */
function noteStatus(tab: CloudAgentTab, status: AgentTabStatus) {
  if (status === "completed" && tab.info.status !== "completed") {
    tab.unread = true;
    tab.completed = true;
  } else if (status === "in_progress") {
    tab.completed = false;
  }
}

// ---- persistence

function scheduleSave(s: Store, tabId: string) {
  const pending = s.saves.get(tabId);
  if (pending) clearTimeout(pending);
  s.saves.set(
    tabId,
    setTimeout(() => {
      s.saves.delete(tabId);
      void saveNow(s, tabId);
    }, SAVE_DEBOUNCE_MS),
  );
}

function queueCacheMutation(s: Store, tabId: string, mutate: (owner: string) => Promise<void>): Promise<void> {
  const owner = cacheAccount(s);
  const key = JSON.stringify([owner, s.scope.organizationId, s.scope.workspaceId, tabId]);
  const previous = cacheMutations.get(key) ?? Promise.resolve();
  const writing = previous.catch(() => undefined).then(() => mutate(owner));
  cacheMutations.set(key, writing);
  return writing.finally(() => {
    if (cacheMutations.get(key) === writing) cacheMutations.delete(key);
  });
}

async function mutateCache(s: Store, owner: string, tabId: string, entry: CachedTab | null) {
  await cloudAgentApi.cacheSave(owner, s.scope, tabId, entry);
}

function saveNow(s: Store, tabId: string): Promise<void> {
  return queueCacheMutation(s, tabId, (owner) => persistNow(s, tabId, owner));
}

async function persistNow(s: Store, tabId: string, owner: string) {
  if (stores.get(cloudAgentsKey(s.scope)) !== s) return;
  if (isDevScope(s.scope)) return;
  const tab = s.tabs.get(tabId);
  if (!tab || tab.placeholder || !tab.info.sessionId) return;
  const history = getTabLog(tab.info.sessionId, tabId).events;
  // Retain presence before trimming the saved tail, including history from older live runtimes.
  const info = withMessagePresence(tab.info, history);
  if (info !== tab.info) {
    tab.info = info;
    publish(s);
  }
  const events = history.filter((ev) => ev.payload.type !== "delta").slice(-CACHE_EVENTS);
  const entry: CachedTab = {
    tab: tab.info,
    events,
    cursor: tab.cursor,
    checkpoint: tab.checkpoint,
    unread: tab.unread,
    completed: tab.completed,
    pendingConfig: tab.pendingConfig,
    draft: tab.draft || undefined,
    updatedAt: Date.now(),
  };
  // The cache carries the tab's unsent text: a save that fails says so, and the next change saves it again.
  await mutateCache(s, owner, tabId, entry).then(
    () => dismissErrorKey(CLOUD_DRAFT_KEY),
    () => { if (entry.draft) showError("Couldn’t save a cloud tab’s unsent text. It stays in this window and is saved again with your next change", undefined, { key: CLOUD_DRAFT_KEY, tone: "warning" }); },
  );
}

const CLOUD_DRAFT_KEY = "cloud-draft-save";

/** Cloud tabs with a draft in `@/lib/drafts`, to forget with this account (a tab the runtime closed keeps its id there). */
const draftTabs = new Set<string>();

/**
 * What is typed in a cloud tab's composer and not sent (`@/lib/drafts`, by
 * tab id) is saved with the tab's cache, this account's and dropped with the
 * workspace, so a relaunch brings it back. Nothing is published: the
 * composer holds the text it shows.
 */
function keepDraft(tabId: string, text: string) {
  for (const s of stores.values()) {
    const tab = s.tabs.get(tabId);
    if (!tab) continue;
    draftTabs.add(tabId);
    if ((tab.draft ?? "") === text) continue;
    tab.draft = text;
    scheduleSave(s, tabId);
  }
}
subscribeDrafts(keepDraft);

/** A draft read back from the cache, unless something is typed in the tab already, or the store was dropped meanwhile (another account). */
function restoreDraft(s: Store, tab: CloudAgentTab, draft: string | undefined) {
  if (!draft || stores.get(cloudAgentsKey(s.scope)) !== s || getDraft(tab.tabId)) return;
  tab.draft = draft;
  draftTabs.add(tab.tabId);
  setDraft(tab.tabId, draft);
  // Reaffirm the restored value through the serialized writer. A cache read
  // started before another write is not proof of what remains on disk now.
  scheduleSave(s, tab.tabId);
}

/** Write pending cache entries now (e.g. before leaving the page). */
export async function flushCloudAgentCache(scope: CloudAgentScope) {
  const s = store(scope);
  const ids = [...s.saves.keys()];
  for (const id of ids) clearTimeout(s.saves.get(id)!);
  s.saves.clear();
  await Promise.all(ids.map((id) => saveNow(s, id)));
}

// ---- loading: cache, then checkpoint metadata

/**
 * The tab list without the runtime: the local cache, then tabs that only
 * have a checkpoint. Idempotent; never connects and never wakes anything.
 */
export function loadCloudAgents(scope: CloudAgentScope): Promise<void> {
  if (cloudAgentsAccessDenied(scope)) return Promise.resolve();
  const s = store(scope);
  if (s.loaded) return Promise.resolve();
  if (s.loading) return s.loading;
  if (isDevScope(scope)) {
    s.loaded = true;
    publish(s);
    return Promise.resolve();
  }
  s.loading = (async () => {
    try {
      const cached = await cloudAgentApi.cacheLoad(cacheAccount(s), scope);
      if (stores.get(cloudAgentsKey(scope)) !== s) return;
      for (const [tabId, entry] of Object.entries(cached?.tabs ?? {})) {
        if (!entry?.tab) continue;
        const info = withMessagePresence(entry.tab, entry.events ?? []);
        const known = s.tabs.get(tabId);
        // A tab the live runtime listed first still gets back what was being typed in it.
        if (known) {
          restoreDraft(s, known, entry.draft);
          if (known.info.sessionId === info.sessionId && info.hasMessages && !known.info.hasMessages) {
            known.info = { ...known.info, hasMessages: true };
            // The live list may arrive before its replay. Preserve the cached messages
            // when saving the migrated metadata instead of replacing them with an empty log.
            if (entry.events?.length) mergeTabEvents(info.sessionId, tabId, entry.events);
            scheduleSave(s, tabId);
          }
          continue;
        }
        const tab = newTab(info, "cache");
        tab.cursor = entry.cursor ?? null;
        tab.checkpoint = entry.checkpoint ?? null;
        tab.unread = entry.unread;
        tab.completed = entry.completed;
        tab.pendingConfig = entry.pendingConfig ?? null;
        if (entry.events?.length) tab.historyRead = true;
        s.tabs.set(tabId, tab);
        restoreDraft(s, tab, entry.draft);
        if (entry.tab.sessionId && entry.events?.length) mergeTabEvents(entry.tab.sessionId, tabId, entry.events);
        if (info !== entry.tab) scheduleSave(s, tabId);
      }
    } catch (error) {
      s.error = errorText(error);
    }
    if (stores.get(cloudAgentsKey(scope)) !== s) return;
    try {
      const outbox = await cloudAgentApi.outbox(scope);
      if (stores.get(cloudAgentsKey(scope)) !== s) return;
      s.outbox = outbox;
    } catch (error) {
      s.error = errorText(error);
    }
    if (stores.get(cloudAgentsKey(scope)) !== s) return;
    try {
      const metas = await cloudAgentApi.checkpoints(scope);
      if (stores.get(cloudAgentsKey(scope)) !== s) return;
      for (const meta of metas) {
        if (!s.tabs.has(meta.tabId)) s.tabs.set(meta.tabId, newTab(placeholderInfo(meta.tabId), "checkpoint", true));
      }
    } catch (error) {
      // No key yet, or no API: the cache is all there is.
      s.error ??= errorText(error);
    }
    s.loaded = true;
    s.loading = null;
    publish(s);
    if (s.outbox.some((entry) => !TERMINAL_OUTBOX_STATES.has(entry.state))) startOutboxPolling(scope);
  })();
  return s.loading;
}

/**
 * Read the workspace's checkpoint list again: `loadCloudAgents` reads it once,
 * and a tab whose first checkpoint was saved since (a session started after
 * that, PRO-109) is known from then on, as a placeholder until its checkpoint
 * is read. A read of the API; never connects and never wakes anything.
 */
export async function relistCloudCheckpoints(scope: CloudAgentScope): Promise<void> {
  if (isDevScope(scope) || cloudAgentsAccessDenied(scope)) return;
  await loadCloudAgents(scope);
  if (cloudAgentsAccessDenied(scope)) return;
  const s = store(scope);
  const listed = await cloudAgentApi.checkpoints(scope);
  // Dropped meanwhile (another account, a deleted workspace): nothing is added to a store nobody holds.
  if (stores.get(cloudAgentsKey(scope)) !== s) return;
  let added = false;
  for (const meta of listed) {
    if (s.tabs.has(meta.tabId)) continue;
    s.tabs.set(meta.tabId, newTab(placeholderInfo(meta.tabId), "checkpoint", true));
    added = true;
  }
  if (added) publish(s);
}

/**
 * Bring one tab up to date from its checkpoint, when that is newer than what
 * is shown. Skipped once the tab streams live: a live projection is always
 * stronger than a checkpoint.
 */
export async function refreshFromCheckpoint(scope: CloudAgentScope, tabId: string): Promise<boolean> {
  if (cloudAgentsAccessDenied(scope)) return false;
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab || tab.live) return false;
  const checkpoint = await cloudAgentApi.checkpoint(scope, tabId, tab.checkpoint);
  if (stores.get(cloudAgentsKey(scope)) !== s) return false;
  const current = s.tabs.get(tabId);
  if (!current) return false;
  if (!checkpoint && !current.historyRead) {
    // No checkpoint newer than the one already merged, or none at all for a tab that said nothing.
    current.historyRead = !current.info.lastSeq || !!current.checkpoint;
    if (current.historyRead) publish(s);
  }
  // Once live, the replay is stronger, but a live tab that has shown nothing yet (the replay
  // is slow, or not answered) still takes the checkpoint's events: they merge by seq.
  const replayed = current.live && (current.historyRead || (!!current.info.sessionId && lastSeq(current.info.sessionId, tabId) > 0));
  if (!checkpoint || replayed || !newer(checkpoint, current.checkpoint)) return false;
  const p = checkpoint.projection;
  if (p.tabId !== tabId) return false;
  current.checkpoint = { epoch: checkpoint.epoch, version: checkpoint.version };
  // A newer checkpoint of a history rewritten by a reset (#1326): the old one's turns go first.
  if (followHistory(s, current, p.history)) current.info = { ...current.info, reset: p.reset ?? null };
  // Its status is taken only when it is at least as far as what this desktop
  // knows of the tab: a checkpoint from before that, or one with no events to
  // tell by, says nothing newer about the turn. A placeholder knows nothing yet.
  const upTo = p.events.length ? p.events[p.events.length - 1].seq : null;
  const upToDate = upTo !== null && upTo >= knownSeq(current);
  if (current.placeholder || (current.source !== "live" && upToDate)) {
    noteStatus(current, p.status);
    current.info = {
      ...current.info,
      sessionId: p.sessionId,
      title: p.title,
      harness: p.harness,
      model: p.model,
      effort: p.effort,
      requestedModel: p.requestedModel,
      requestedEffort: p.requestedEffort,
      permissionMode: p.permissionMode,
      requestedPermissionMode: p.requestedPermissionMode,
      status: p.status,
      process: p.process,
      followUps: p.followUps ?? [],
      history: p.history ?? null,
      reset: p.reset ?? null,
      lastSeq: upTo ?? current.info.lastSeq,
      modified: new Date(p.updatedAt || 0).toISOString(),
    };
    current.source = "checkpoint";
    current.placeholder = false;
  }
  // Chronology is independent of the retained event tail: a large event can
  // leave a checkpoint with no events, while its verified metadata still advances.
  current.info = { ...current.info,
    created: p.created || current.info.created,
    lastMessageAt: newestMessageTime(current.info.lastMessageAt, p.lastMessageAt),
    hasMessages: current.info.hasMessages || p.hasMessages,
    sessionCreated: p.sessionCreated ?? current.info.sessionCreated,
    sessionLastMessageAt: newestMessageTime(current.info.sessionLastMessageAt, p.sessionLastMessageAt),
    sessionHasMessages: current.info.sessionHasMessages || p.sessionHasMessages,
  };
  current.info = withMessagePresence(current.info, p.events);
  mergeTabEvents(p.sessionId, tabId, p.events);
  current.historyRead = true;
  publish(s);
  scheduleSave(s, tabId);
  return true;
}

// ---- the live runtime

/**
 * An agent with no way to sign in (PRO-78) is not working, whatever turn its
 * tab is in: the prompt went to a sign-in screen. Settled here, where tab
 * state comes in, so every row, badge and spinner agrees.
 */
export function settledStatus(info: Pick<AgentTabInfo, "signIn">, status: AgentTabStatus): AgentTabStatus {
  return info.signIn && status === "in_progress" ? "idle" : status;
}

/** The live feeds of each tab, by store and tab: started again from the first event after a reset (#1326). */
const restarts = new Map<string, Set<() => void>>();

function feedKey(s: Store, tabId: string): string {
  return `${cloudAgentsKey(s.scope)}/${tabId}`;
}

/**
 * A reset on the runtime rewrote the tab's history (#1326): what this
 * desktop kept of the old one is dropped, so the turns cut off leave the
 * chat, and the new one is read from its first event. A live feed starts
 * again; otherwise the next checkpoint or attach brings it. The caller then
 * takes the new `info`. Returns whether the history changed.
 */
function followHistory(s: Store, tab: CloudAgentTab, history: string | null | undefined): boolean {
  if ((tab.info.history ?? null) === (history ?? null)) return false;
  if (tab.info.sessionId) dropTabLog(tab.info.sessionId, tab.tabId);
  tab.cursor = null;
  tab.historyRead = false;
  tab.info = { ...tab.info, history: history ?? null, lastSeq: 0 };
  for (const restart of [...(restarts.get(feedKey(s, tab.tabId)) ?? [])]) restart();
  return true;
}

/**
 * One tab as the runtime just described it, in answer to something done
 * here (a reset, a fork, #1326): taken at once, before `session.tabs` says
 * it to everyone. Unlike the whole list, it removes no other tab.
 */
export function applyLiveTab(scope: CloudAgentScope, reported: AgentTabInfo) {
  if (cloudAgentsAccessDenied(scope)) return;
  const s = store(scope);
  const info = { ...reported, status: settledStatus(reported, reported.status) };
  const existing = s.tabs.get(info.tabId);
  if (!existing) {
    s.tabs.set(info.tabId, newTab(info, "live"));
  } else {
    followHistory(s, existing, info.history);
    noteStatus(existing, info.status);
    existing.info = withPending({ ...keepMessageTime(info, existing.info),
      sessionLastMessageAt: newestMessageTime(info.sessionLastMessageAt, existing.info.sessionLastMessageAt),
      sessionHasMessages: info.sessionHasMessages || existing.info.sessionHasMessages,
    }, existing.pendingConfig);
    existing.source = "live";
    existing.placeholder = false;
    if (!info.lastSeq) existing.historyRead = true;
  }
  scheduleSave(s, info.tabId);
  publish(s);
}

/** The runtime's own tab list is authoritative: tabs it no longer has are gone. */
export function applyLiveTabs(scope: CloudAgentScope, tabs: AgentTabInfo[]) {
  if (cloudAgentsAccessDenied(scope)) return;
  const s = store(scope);
  const seen = new Set<string>();
  for (const reported of tabs) {
    const info = { ...reported, status: settledStatus(reported, reported.status) };
    seen.add(info.tabId);
    const existing = s.tabs.get(info.tabId);
    if (!existing) {
      s.tabs.set(info.tabId, newTab(info, "live"));
    } else {
      followHistory(s, existing, info.history);
      noteStatus(existing, info.status);
      // Settings chosen here and not sent yet stay shown as chosen.
      existing.info = withPending({ ...keepMessageTime(info, existing.info),
        sessionLastMessageAt: newestMessageTime(info.sessionLastMessageAt, existing.info.sessionLastMessageAt),
        sessionHasMessages: info.sessionHasMessages || existing.info.sessionHasMessages,
      }, existing.pendingConfig);
      existing.source = "live";
      existing.placeholder = false;
      if (!info.lastSeq) existing.historyRead = true;
    }
    scheduleSave(s, info.tabId);
  }
  for (const [tabId, tab] of [...s.tabs]) {
    if (seen.has(tabId)) continue;
    forgetTab(s, tab);
  }
  s.loaded = true;
  s.liveListed = true;
  publish(s);
}

function forgetTab(s: Store, tab: CloudAgentTab) {
  s.tabs.delete(tab.tabId);
  const pending = s.saves.get(tab.tabId);
  if (pending) clearTimeout(pending);
  s.saves.delete(tab.tabId);
  if (tab.info.sessionId) dropTabLog(tab.info.sessionId, tab.tabId);
  if (!isDevScope(s.scope)) void queueCacheMutation(s, tab.tabId,
    (owner) => mutateCache(s, owner, tab.tabId, null)).catch(() => undefined);
}

export async function syncLiveTabs(scope: CloudAgentScope, client: WorkspaceRpcClient) {
  const s = store(scope);
  const tabs = await client.listAgentTabs();
  if (stores.get(cloudAgentsKey(scope)) !== s) return;
  applyLiveTabs(scope, tabs);
}

/** Tabs brought up to date from their checkpoints at one connect, at most. */
const RECONCILE_CHECKPOINTS = 20;

/**
 * Bring every tab in line with the runtime after a connect (the first, a
 * reconnect, a new runtime generation, or access given back): its own tab
 * list decides each tab's status, so a turn that finished while this desktop
 * was away never stays "Working"; and a tab nothing streams here whose
 * transcript is behind the runtime's catches its tail up from the checkpoint.
 * The tab being looked at streams live and replays from its cursor instead.
 */
export async function reconcileCloudAgents(scope: CloudAgentScope, client: WorkspaceRpcClient) {
  const s = store(scope);
  const tabs = await client.listAgentTabs();
  if (stores.get(cloudAgentsKey(scope)) !== s || cloudAgentsAccessDenied(scope)) return;
  applyLiveTabs(scope, tabs);
  if (isDevScope(scope)) return;
  const behind = tabs.filter((info) => {
    const tab = s.tabs.get(info.tabId);
    return !!tab && !tab.live && !!info.sessionId && knownSeq(tab) > lastSeq(info.sessionId, info.tabId);
  });
  await Promise.all(behind.slice(0, RECONCILE_CHECKPOINTS).map((info) => refreshFromCheckpoint(scope, info.tabId).catch(() => false)));
}

/**
 * The connection went away: what the runtime said of each tab is the last
 * known state from here on, not the live one, so a newer checkpoint may say
 * that a turn finished (`refreshFromCheckpoint`).
 */
export function markCloudAgentsOffline(scope: CloudAgentScope) {
  const s = stores.get(cloudAgentsKey(scope));
  if (!s) return;
  for (const tab of s.tabs.values()) if (tab.source === "live") tab.source = "cache";
  // The next connection's list is not known until it comes.
  if (s.liveListed) {
    s.liveListed = false;
    publish(s);
  }
}

/** Follow `session.tabs` broadcasts from the runtime. */
export function watchLiveTabs(scope: CloudAgentScope, client: WorkspaceRpcClient): () => void {
  return client.onNotification((notification) => {
    if (notification.event !== "session.tabs") return;
    const tabs = (notification.params as { tabs?: AgentTabInfo[] }).tabs;
    if (Array.isArray(tabs)) applyLiveTabs(scope, tabs);
  });
}

/**
 * The live feeds of each tab, by `sessionId/tabId`, that caught up from the
 * runtime's own history over a connection that is still up. While one has,
 * the tab's log is continuous with that history, and a compaction it shows
 * running is running (#644). With none, the reader may have missed how it
 * ended, and it is shown as unknown.
 */
const caughtUp = new Map<string, Set<object>>();

function noteCaughtUp(sessionId: string, tabId: string, feed: object, on: boolean) {
  const k = `${sessionId}/${tabId}`;
  const feeds = caughtUp.get(k) ?? new Set<object>();
  if (on) feeds.add(feed);
  else feeds.delete(feed);
  if (feeds.size) caughtUp.set(k, feeds);
  else caughtUp.delete(k);
  setFeedContinuity(sessionId, tabId, feeds.size > 0);
}

/**
 * Stream a tab live. Call only while the connection is up: reading never
 * wakes compute. Resumes after the cached cursor; overlapping replays are
 * merged by seq.
 */
export async function attachCloudAgentTab(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient): Promise<() => void> {
  if (cloudAgentsAccessDenied(scope)) return () => {};
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  // Not known here yet (the runtime's tab list or a checkpoint has not named its session):
  // attach as soon as it is, rather than when the connection next changes.
  if (!tab || !tab.info.sessionId) return attachWhenKnown(scope, tabId, client);
  const sessionId = tab.info.sessionId;
  tab.live = true;
  publish(s);
  // This feed has caught up once its replay is merged over a live connection,
  // and has not from when that connection drops until the resume's replay.
  const feed = {};
  let ended = false;
  const caught = (on: boolean) => {
    if (!on || !ended) noteCaughtUp(sessionId, tabId, feed, on);
  };
  const offState = client.onState((state) => {
    if (state.state !== "connected") caught(false);
  });
  const end = () => {
    ended = true;
    offState();
    caught(false);
  };
  const onEvent = (raw: unknown) => {
    if (stores.get(cloudAgentsKey(scope)) !== s) return;
    const ev = raw as AgentEvent;
    if (!ev || typeof ev !== "object" || !ev.payload) return;
    const current = s.tabs.get(tabId);
    if (ev.payload.type === "delta") {
      applyEvent(ev);
      return;
    }
    if (ev.seq <= lastSeq(sessionId, tabId)) mergeTabEvents(sessionId, tabId, [ev]);
    else applyEvent(ev);
    if (current) {
      current.info = { ...current.info, lastSeq: Math.max(current.info.lastSeq, ev.seq) };
      if (ev.payload.type === "turn_completed" && !isViewed(scope, tabId)) {
        current.unread = true;
        current.completed = true;
      }
    }
    scheduleSave(s, tabId);
  };
  let stop: (() => void) | null = null;
  // Each subscription is one attempt; a reset retires the current one
  // (#1326, #1398), and what a retired attempt still delivers is ignored.
  let attempt = 0;
  const subscribe = (sinceCursor: string | undefined) => {
    const mine = attempt;
    const current = () => mine === attempt && stores.get(cloudAgentsKey(scope)) === s;
    return client.subscribeSession(sessionId, tabId, (raw) => { if (current()) onEvent(raw); }, {
      sinceCursor,
      onCursor: (cursor) => {
        if (!current()) return;
        const tab = s.tabs.get(tabId);
        if (tab) tab.cursor = cursor ?? null;
      },
      onStatus: (change) => {
        if (!current()) return;
        const tab = s.tabs.get(tabId);
        if (!tab) return;
        const status = settledStatus(tab.info, change.status);
        noteStatus(tab, status);
        if (status === "completed" && isViewed(scope, tabId)) tab.unread = false;
        // The runtime reports the process in `session.tabs`, not with a status.
        tab.info = { ...tab.info, status, process: change.process ?? tab.info.process };
        publish(s);
        scheduleSave(s, tabId);
      },
      onReplayed: () => { if (current()) caught(client.connection.state === "connected"); },
    });
  };
  // The replay has been merged: the conversation is what is shown now.
  const replayed = () => {
    const tab = s.tabs.get(tabId);
    if (tab && !tab.historyRead) {
      tab.historyRead = true;
      publish(s);
    }
  };
  // A reset rewrote the history (#1326): the feed of the old one ends, and
  // the new one is replayed from its first event into the emptied log. It
  // can come while the first subscription is still being answered (#1398):
  // that one is retired too, and stopped once it is.
  const restart = () => {
    const previous = stop;
    stop = null;
    previous?.();
    caught(false);
    const mine = ++attempt;
    void subscribe(undefined).then(
      (next) => {
        if (ended || mine !== attempt || stores.get(cloudAgentsKey(scope)) !== s) return next();
        stop = next;
        replayed();
      },
      // The connection went meanwhile: the next attach replays from the emptied cursor.
      () => undefined,
    );
  };
  const feeds = restarts.get(feedKey(s, tabId)) ?? new Set<() => void>();
  feeds.add(restart);
  restarts.set(feedKey(s, tabId), feeds);
  const unregister = () => {
    feeds.delete(restart);
    if (!feeds.size && restarts.get(feedKey(s, tabId)) === feeds) restarts.delete(feedKey(s, tabId));
  };
  try {
    const first = await subscribe(tab.cursor ?? undefined);
    if (attempt === 0) stop = first;
    else first();
  } catch (error) {
    // A reset meanwhile started a feed of its own, which this failure does not end.
    if (attempt === 0) {
      unregister();
      end();
      const current = s.tabs.get(tabId);
      if (current) current.live = false;
      publish(s);
      throw error;
    }
  }
  if (stores.get(cloudAgentsKey(scope)) !== s) { unregister(); stop?.(); end(); return () => {}; }
  if (attempt === 0) replayed();
  return () => {
    unregister();
    stop?.();
    end();
    const current = s.tabs.get(tabId);
    if (current) current.live = false;
    publish(s);
  };
}

/** `attachCloudAgentTab` once the tab and its session are known; the returned stop also ends the wait. */
function attachWhenKnown(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient): () => void {
  const s = store(scope);
  let stopped = false;
  let stop: (() => void) | null = null;
  const check = () => {
    if (stopped || !s.tabs.get(tabId)?.info.sessionId) return;
    s.listeners.delete(check);
    void attachCloudAgentTab(scope, tabId, client).then(
      (unsubscribe) => (stopped ? unsubscribe() : (stop = unsubscribe)),
      () => undefined,
    );
  };
  s.listeners.add(check);
  return () => {
    stopped = true;
    s.listeners.delete(check);
    stop?.();
  };
}

const viewed = new Set<string>();
function isViewed(scope: CloudAgentScope, tabId: string) {
  return viewed.has(`${cloudAgentsKey(scope)}/${tabId}`);
}

/** The reader is looking at this tab now (or stopped looking). */
export function setViewing(scope: CloudAgentScope, tabId: string, on: boolean) {
  const k = `${cloudAgentsKey(scope)}/${tabId}`;
  if (on) viewed.add(k);
  else viewed.delete(k);
}

export async function markCloudAgentRead(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient | null) {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab || (!tab.unread && tab.info.status !== "completed")) return;
  tab.unread = false;
  // Use the runtime session row ID and the message actually rendered, never the desktop tab ID or wall clock.
  if (!isDevScope(scope)) void writeCloudReadMarker(scope.organizationId, scope.workspaceId, tab.info.sessionId, tab.info.lastMessageAt);
  if (tab.info.status === "completed") tab.info = { ...tab.info, status: "idle" };
  publish(s);
  scheduleSave(s, tabId);
  if (client && client.connection.state === "connected" && tab.info.sessionId) {
    await client.markAgentTabRead(tab.info.sessionId, tabId).catch(() => undefined);
  }
}

export async function createCloudAgentTab(scope: CloudAgentScope, client: WorkspaceRpcClient, params: NewCloudAgentTab): Promise<string> {
  return (await newCloudAgentTab(scope, client, params)).tabId;
}

type NewCloudAgentTab = Parameters<WorkspaceRpcClient["createAgentTab"]>[0];

/**
 * `createCloudAgentTab`, with what the runtime said of the issue's pipeline
 * when the tab was started from an issue (`pipeline/1`): the pipeline, or why
 * there is none.
 */
export async function newCloudAgentTab(scope: CloudAgentScope, client: WorkspaceRpcClient, params: NewCloudAgentTab): Promise<{ tabId: string; sessionId: string; pipeline: RuntimeIssuePipeline | null; pipelineNote: string | null; startError: string | null }> {
  const created = await client.createAgentTab(params);
  const s = store(scope);
  const now = new Date().toISOString();
  const info: AgentTabInfo = created.tab ?? {
    ...placeholderInfo(created.tabId),
    sessionId: created.sessionId,
    harness: params.agent,
    model: params.model ?? "",
    effort: params.effort ?? null,
    permissionMode: params.mode || DEFAULT_PERMISSION_MODE,
    title: params.title ?? null,
    created: now,
    modified: now,
  };
  if (!s.tabs.has(created.tabId)) s.tabs.set(created.tabId, newTab(info, "live"));
  publish(s);
  scheduleSave(s, created.tabId);
  return { tabId: created.tabId, sessionId: created.sessionId, pipeline: created.pipeline ?? null, pipelineNote: created.pipelineNote ?? null, startError: created.startError ?? null };
}

/** Stop the tab's process and drop it and its checkpoints from the workspace. */
export async function closeCloudAgentTab(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient) {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab) return;
  if (tab.info.sessionId) await client.closeAgentTab(tab.info.sessionId, tabId, true);
  forgetTab(s, tab);
  publish(s);
}

type TabSettings = { model?: string; effort?: string | null; mode?: string };

/** A tab's info with the settings still waiting for the next message shown as chosen. */
function withPending(info: AgentTabInfo, pending: TabSettings | null): AgentTabInfo {
  if (!pending) return info;
  return {
    ...info,
    ...(pending.model !== undefined ? { model: pending.model } : {}),
    ...(pending.effort !== undefined ? { effort: pending.effort } : {}),
    ...(pending.mode !== undefined ? { permissionMode: pending.mode } : {}),
  };
}

/**
 * Whether this connection may change a tab's settings with the live
 * `session.configure`: the runtime keeps it for a manage attachment whose
 * person is (still) a manager. Everyone else's change rides with their next
 * message, which the runtime applies for a manager or an approver
 * (docs/CLOUD-SHARING.md, Settings).
 */
export function configuresLive(client: WorkspaceRpcClient | null): client is WorkspaceRpcClient {
  const state = client?.connection;
  return !!state && state.state === "connected" && state.authority === "manage" && (!state.you || state.you.listed === false || state.you.role === "manager");
}

/**
 * Model, effort or permission mode: now over the live connection when it may
 * configure tabs, else kept and sent with the next message. Either way the
 * tab shows what was chosen, and `pendingConfig` says it has not reached the
 * agent yet, so a picker never changes back without a word.
 */
export async function configureCloudAgentTab(
  scope: CloudAgentScope,
  tabId: string,
  patch: TabSettings,
  client: WorkspaceRpcClient | null,
) {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab) return;
  if (configuresLive(client) && tab.info.sessionId) {
    const updated = await client.configureAgentTab({ sessionId: tab.info.sessionId, tabId, ...patch });
    const current = s.tabs.get(tabId);
    if (current) {
      // What was just applied no longer waits for a message.
      if (current.pendingConfig) {
        const rest = { ...current.pendingConfig };
        for (const key of Object.keys(patch) as (keyof TabSettings)[]) delete rest[key];
        current.pendingConfig = Object.keys(rest).length ? rest : null;
      }
      current.info = withPending(updated ?? withPending(current.info, patch), current.pendingConfig);
    }
  } else {
    tab.pendingConfig = { ...(tab.pendingConfig ?? {}), ...patch };
    tab.info = withPending(tab.info, tab.pendingConfig);
  }
  // A new choice replaces the notice about the last one.
  const now = s.tabs.get(tabId);
  if (now) now.settingsIgnored = false;
  publish(s);
  scheduleSave(s, tabId);
}

/**
 * Hold a tab to `mode` with its next message (PRO-514): the mode rides in
 * that message whatever the tab is in now, and the runtime sets it before the
 * prompt reaches the agent. False for a tab this desktop does not hold, which
 * no message of its own could carry a mode for.
 */
export function holdCloudAgentTabMode(scope: CloudAgentScope, tabId: string, mode: string): boolean {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab) return false;
  tab.pendingConfig = { ...(tab.pendingConfig ?? {}), mode };
  tab.info = withPending(tab.info, tab.pendingConfig);
  tab.settingsIgnored = false;
  publish(s);
  scheduleSave(s, tabId);
  return true;
}

/**
 * Drop a tab's unsent setting change because this person may no longer make
 * it (they lost approval rights since choosing it), and say so. The next
 * message then goes without settings the runtime would only ignore.
 */
export function discardPendingConfig(scope: CloudAgentScope, tabId: string) {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab?.pendingConfig) return;
  tab.pendingConfig = null;
  tab.settingsIgnored = true;
  publish(s);
  scheduleSave(s, tabId);
}

/** The notice about a dropped setting change was read (a new message is on its way). */
function clearSettingsIgnored(s: Store, tabId: string) {
  const tab = s.tabs.get(tabId);
  if (tab?.settingsIgnored) tab.settingsIgnored = false;
}


// ---- the outbox

function upsert(s: Store, entry: OutboxEntry) {
  const at = s.outbox.findIndex((existing) => existing.clientCommandId === entry.clientCommandId);
  // A receipt that just arrived saying the message went without its settings
  // (the sender may not configure the tab any more): say so, and stop
  // promising that they apply with the next message. Receipts already known
  // (an earlier launch's) say nothing new.
  if (at >= 0 && entry.receipt?.settingsIgnored === true && s.outbox[at]!.receipt?.settingsIgnored !== true) {
    const tab = s.tabs.get(entry.tabId);
    if (tab) {
      tab.settingsIgnored = true;
      if (tab.pendingConfig) {
        tab.pendingConfig = null;
        scheduleSave(s, entry.tabId);
      }
    }
  }
  s.outbox = at >= 0 ? s.outbox.map((existing, i) => (i === at ? entry : existing)) : [...s.outbox, entry];
  // Settled for good: its attachments are not needed for a "Send again".
  if (entry.state === "applied" || entry.state === "rejected" || entry.state === "cancelled") sentAttachments.delete(entry.clientCommandId);
}

/** A decision for this request that is, or may be, on its way: never enqueue another. */
export function decisionFor(outbox: OutboxEntry[], requestId: string): OutboxEntry | undefined {
  return outbox.find(
    (entry) =>
      entry.kind === "permission-decision" &&
      entry.requestId === requestId &&
      !(entry.state === "cancelled" || (entry.state === "rejected" && entry.category !== "request-not-pending")),
  );
}

async function enqueue(
  scope: CloudAgentScope,
  tabId: string,
  kind: OutboxKind,
  payload: OutboxPayload,
  client: WorkspaceRpcClient | null,
  options: { wake?: boolean } = {},
): Promise<OutboxEntry> {
  const s = store(scope);
  const entry = await (options.wake === false ? cloudAgentApi.enqueue(scope, tabId, kind, payload, { wake: false }) : cloudAgentApi.enqueue(scope, tabId, kind, payload));
  upsert(s, entry);
  if (entry.wake) s.wake = entry.wake;
  s.error = null;
  publish(s);
  if (client && client.connection.state === "connected") void client.nudgeMailbox().catch(() => undefined);
  if (!TERMINAL_OUTBOX_STATES.has(entry.state)) startOutboxPolling(scope);
  return entry;
}

/**
 * A prompt: now if the agent is idle, else queued as a follow-up by the runtime.
 * With `wake: false` it starts nothing: a workspace that is not running refuses it (`WORKSPACE_STOPPED`) and nothing is kept.
 */
export async function sendToCloudAgent(scope: CloudAgentScope, tabId: string, text: string, client: WorkspaceRpcClient | null, images: ImageInput[] = [], options: { wake?: boolean; files?: FileInput[] } = {}) {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  const files = options.files ?? [];
  // Files other than images go to the runtime (a machine's, PRO-407; a cloud workspace's, #1329), uploaded
  // before the images so a refused file costs no image upload. The message then names them, as it names images.
  let attachedFiles: CloudFileRef[] = [];
  if (files.length && isDevScope(scope)) {
    const target = liveTarget(scope, tabId, client);
    attachedFiles = await uploadAgentFiles(target.client, { sessionId: target.sessionId, tabId }, files, images.length);
  } else if (files.length) {
    const blocked = cloudFilesBlocked(client, false);
    if (blocked) throw new CloudImageError(blocked);
    if (!tab?.info.sessionId) throw new CloudImageError(CLOUD_FILES_NEED_CONNECTION);
    attachedFiles = await uploadAgentFiles(client!, { sessionId: tab.info.sessionId, tabId }, files, images.length, CLOUD_FILES_OLD_RUNTIME);
  }
  // Images go to the runtime first (PRO-22); the message then names them. A
  // mailbox command is far too small to carry one.
  let attached: CloudImageRef[] = [];
  if (images.length) {
    const blocked = cloudImagesBlocked(client, false);
    if (blocked) throw new CloudImageError(blocked);
    if (!tab?.info.sessionId) throw new CloudImageError(CLOUD_IMAGES_NEED_CONNECTION);
    attached = await uploadCloudImages(client!, { sessionId: tab.info.sessionId, tabId }, images);
  }
  const withAttachments = { ...(attached.length ? { images: attached } : {}), ...(attachedFiles.length ? { files: attachedFiles } : {}) };
  if (isDevScope(scope)) return sendOverLiveRpc(scope, tabId, text, client, attached, attachedFiles);
  const sent = tab?.pendingConfig ?? null;
  // With settings on board, an earlier notice is replaced by this message's own receipt.
  if (sent) clearSettingsIgnored(s, tabId);
  const entry = await enqueue(scope, tabId, "send", { text, ...(sent ?? {}), ...withAttachments }, client, { wake: options.wake });
  if (images.length || files.length) sentAttachments.set(entry.clientCommandId, { images, files });
  // Only what went out is settled; a change made meanwhile waits for the next.
  const current = s.tabs.get(tabId);
  if (current && sent && current.pendingConfig === sent) {
    current.pendingConfig = null;
    scheduleSave(s, tabId);
    // The "applies with your next message" note goes with the message.
    publish(s);
  }
  return entry;
}

/** `data.reason` of a live `session.send` the runtime refused with a sentence meant for the person. */
const LIVE_SEND_REFUSALS = new Set(["command-not-queued", "slash-command-forbidden", "shell-command-forbidden", "file-mention-forbidden", "attachment-missing", "follow-up-gone"]);

/**
 * What a refused live command says to the person (docs/MACHINES.md decision
 * 3, "Refusals"): the runtime's own sentence where it wrote one for them,
 * else what the refusal means.
 */
export function liveCommandError(error: unknown): Error {
  if (!(error instanceof WorkspaceRpcError)) return error instanceof Error ? error : new Error(String(error));
  const reason = (error.data as { reason?: unknown } | undefined)?.reason;
  if (typeof reason === "string" && LIVE_SEND_REFUSALS.has(reason)) return new Error(error.message);
  if (error.code === "conflict" && reason === "request-not-pending") return new Error("That request was already answered, or the agent no longer waits for it.");
  if (error.code === "outcome_unknown") return new Error("The machine restarted while applying this, so it cannot say whether it reached the agent. Look at the conversation before trying again.");
  return error;
}

/** The connection a live command goes over, and the tab's session there; refused while the machine is away. */
function liveTarget(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient | null): { client: WorkspaceRpcClient; sessionId: string } {
  const tab = store(scope).tabs.get(tabId);
  if (!client || client.connection.state !== "connected") throw new Error(LIVE_NOT_CONNECTED);
  if (!tab?.info.sessionId) throw new Error("This tab is not known to the machine yet.");
  return { client, sessionId: tab.info.sessionId };
}

/** A command applied live: what the outbox would have said once it settled. `clientCommandId`: the request's id, where it names what it queued. */
function appliedEntry(tabId: string, kind: OutboxEntry["kind"], text?: string, requestId?: string, clientCommandId?: string): OutboxEntry {
  const now = Date.now();
  return { clientCommandId: clientCommandId ?? `live-${now}`, tabId, kind, ...(text !== undefined ? { text } : {}), ...(requestId ? { requestId } : {}), state: "applied", createdAt: now, updatedAt: now };
}

/**
 * A prompt to a machine, live. With `agent-commands/1` its id is kept across
 * a dropped connection (the client resends it with the same id) and the
 * machine answers a resend from its durable receipt, so it is typed once; a
 * prompt during a turn waits in the tab's follow-up queue there. Settings
 * chosen while away ride with it, as they ride with a mailbox send.
 */
async function sendOverLiveRpc(scope: CloudAgentScope, tabId: string, text: string, client: WorkspaceRpcClient | null, images: CloudImageRef[] = [], files: CloudFileRef[] = []): Promise<OutboxEntry> {
  const s = store(scope);
  const target = liveTarget(scope, tabId, client);
  const durable = takesLiveCommands(scope, target.client);
  const settings = durable ? (s.tabs.get(tabId)?.pendingConfig ?? null) : null;
  let receipt: { settingsIgnored?: boolean } | undefined;
  // Its id names the follow-up it becomes when a turn runs (#1328), for a change to it later.
  const requestId = `send-${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    receipt = await target.client.mutate<{ settingsIgnored?: boolean }>("session.send", { sessionId: target.sessionId, tabId, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(settings ?? {}) }, requestId);
  } catch (error) {
    throw liveCommandError(error);
  }
  const current = s.tabs.get(tabId);
  if (current && settings) {
    // Only what went out is settled; a change made meanwhile waits for the next.
    if (current.pendingConfig === settings) current.pendingConfig = null;
    current.settingsIgnored = receipt?.settingsIgnored === true;
    publish(s);
  }
  return appliedEntry(tabId, "send", text, undefined, requestId);
}

/** Steer, stop or decide on a machine (`agent-commands/1`); an older machine takes prompts only. */
async function commandLive(scope: CloudAgentScope, tabId: string, method: "session.steer" | "session.stop" | "session.decide", params: Record<string, unknown>, client: WorkspaceRpcClient | null): Promise<void> {
  const target = liveTarget(scope, tabId, client);
  if (!takesLiveCommands(scope, target.client)) throw new Error(DEV_SCOPE_NOTICE);
  try {
    await target.client.mutate(method, { sessionId: target.sessionId, tabId, ...params });
  } catch (error) {
    throw liveCommandError(error);
  }
}

/** Into the running turn now. */
export async function steerCloudAgent(scope: CloudAgentScope, tabId: string, text: string, client: WorkspaceRpcClient | null) {
  if (isDevScope(scope)) {
    await commandLive(scope, tabId, "session.steer", { text }, client);
    return appliedEntry(tabId, "steer", text);
  }
  return enqueue(scope, tabId, "steer", { text }, client);
}

export async function stopCloudAgent(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient | null) {
  if (isDevScope(scope)) {
    await commandLive(scope, tabId, "session.stop", {}, client);
    return appliedEntry(tabId, "stop");
  }
  return enqueue(scope, tabId, "stop", {}, client);
}

/**
 * Answer a permission request or a question. One decision per request id,
 * ever: a second click, or a retry after a reconnect, gets the first one.
 */
export async function decideCloudAgent(
  scope: CloudAgentScope,
  tabId: string,
  decision: { requestId: string; optionId: string } | { requestId: string; answers: Record<string, string> },
  client: WorkspaceRpcClient | null,
): Promise<OutboxEntry | null> {
  if (isDevScope(scope)) return decideLive(scope, tabId, decision, client);
  const s = store(scope);
  const existing = decisionFor(s.outbox, decision.requestId);
  if (existing) return existing;
  if (s.deciding.has(decision.requestId)) return null;
  s.deciding.add(decision.requestId);
  publish(s);
  try {
    return await enqueue(scope, tabId, "permission-decision", decision, client);
  } finally {
    s.deciding.delete(decision.requestId);
    publish(s);
  }
}

/**
 * One id per permission request a machine is asked to decide: a second
 * click, or a retry after the reply was lost, is the same command, which the
 * machine answers from its receipt instead of deciding twice. A different
 * answer under the same id is refused there (`id-reused`).
 */
const liveDecisionIds = new Map<string, string>();

async function decideLive(
  scope: CloudAgentScope,
  tabId: string,
  decision: { requestId: string; optionId: string } | { requestId: string; answers: Record<string, string> },
  client: WorkspaceRpcClient | null,
): Promise<OutboxEntry | null> {
  const s = store(scope);
  if (s.deciding.has(decision.requestId)) return null;
  const target = liveTarget(scope, tabId, client);
  if (!takesLiveCommands(scope, target.client)) throw new Error(DEV_SCOPE_NOTICE);
  const key = `${cloudAgentsKey(scope)}|${tabId}|${decision.requestId}`;
  let id = liveDecisionIds.get(key);
  if (!id) {
    id = `decide-${crypto.randomUUID().replace(/-/g, "")}`;
    if (liveDecisionIds.size > 512) liveDecisionIds.clear();
    liveDecisionIds.set(key, id);
  }
  s.deciding.add(decision.requestId);
  publish(s);
  try {
    await target.client.mutate("session.decide", { sessionId: target.sessionId, tabId, ...decision }, id);
    return appliedEntry(tabId, "permission-decision", undefined, decision.requestId);
  } catch (error) {
    throw liveCommandError(error);
  } finally {
    s.deciding.delete(decision.requestId);
    publish(s);
  }
}

export function isDeciding(scope: CloudAgentScope, requestId: string): boolean {
  const s = store(scope);
  return s.deciding.has(requestId) || !!decisionFor(s.outbox, requestId);
}

/** Said where a runtime from before `follow-ups/1` holds a tab's follow-ups (#1328). */
export const FOLLOW_UPS_OLD_RUNTIME = "Editing, deleting or sending a held message now needs a newer runtime on this workspace or machine.";

/** Said when the cloud service refuses a held message's change: it is from before the `follow-up` command (#1328). */
export const FOLLOW_UPS_OLD_SERVICE = "The cloud service does not take changes to held messages yet. They still go to the agent one after each turn.";

/** Whether `client`'s runtime takes changes to its held follow-ups (#1328). */
export function changesFollowUps(scope: CloudAgentScope, client: WorkspaceRpcClient | null): boolean {
  if (!client?.hasCapability("follow-ups/1")) return false;
  // A machine takes them live, with the receipts of `agent-commands/1`.
  return !isDevScope(scope) || takesLiveCommands(scope, client);
}

/**
 * Change a follow-up a tab's runtime holds (#1328): its text, withdrawn
 * unsent, or released (first in line, the running turn interrupted). A cloud
 * workspace takes it through the mailbox, in order behind the tab's earlier
 * commands, and this waits for its receipt: a held message that went to the
 * agent meanwhile is refused (`follow-up-gone`) and the refusal is thrown. A
 * machine takes it live.
 */
export async function changeCloudFollowUp(scope: CloudAgentScope, tabId: string, change: FollowUpChange, client: WorkspaceRpcClient | null): Promise<void> {
  if (isDevScope(scope)) {
    const target = liveTarget(scope, tabId, client);
    if (!changesFollowUps(scope, target.client)) throw new Error(target.client.hasCapability("agent-commands/1") ? FOLLOW_UPS_OLD_RUNTIME : DEV_SCOPE_NOTICE);
    try {
      await target.client.mutate("session.followUp", { sessionId: target.sessionId, tabId, ...change });
    } catch (error) {
      throw liveCommandError(error);
    }
    return;
  }
  const entry = await enqueue(scope, tabId, "follow-up", change, client);
  const settled = await commandSettled(scope, entry.clientCommandId);
  if (settled.state !== "applied") throw new Error(followUpRefusal(settled));
}

/** A follow-up change that did not apply, in words: the runtime's own sentence where it wrote one. */
function followUpRefusal(entry: OutboxEntry): string {
  const refused = inputRefusalText(entry.category, entry.receipt);
  if (refused) return refused;
  const message = entry.receipt?.message;
  if (typeof message === "string" && message.trim() && message.length <= 400) return message;
  if (entry.category === "lease-held") return "Someone else is driving this tab.";
  // A cloud service from before the `follow-up` command refuses it as malformed, and stores nothing.
  if (entry.category === "cloud_workspace_request_invalid") return FOLLOW_UPS_OLD_SERVICE;
  if (entry.state === "outcome-unknown") return "The workspace could not say whether the change was made. Look at the held messages before trying again.";
  if (entry.state === "cancelled") return "The change was cancelled before it reached the workspace.";
  return `The workspace did not make the change${entry.category ? ` (${entry.category})` : ""}.`;
}

/**
 * The outbox entry `clientCommandId` once it is settled (applied, rejected,
 * cancelled or of unknown outcome). Refused when the workspace's commands
 * are let go here meanwhile (it was deleted, or access to it went).
 */
function commandSettled(scope: CloudAgentScope, clientCommandId: string): Promise<OutboxEntry> {
  const s = store(scope);
  return new Promise((resolve, reject) => {
    const check = () => {
      if (stores.get(cloudAgentsKey(scope)) !== s) {
        s.listeners.delete(check);
        reject(new Error("This workspace is no longer open here, so the change could not be followed."));
        return true;
      }
      const entry = s.outbox.find((candidate) => candidate.clientCommandId === clientCommandId);
      if (!entry || !TERMINAL_OUTBOX_STATES.has(entry.state)) return false;
      s.listeners.delete(check);
      resolve(entry);
      return true;
    };
    if (!check()) s.listeners.add(check);
  });
}

/**
 * The reader chose to try an unconfirmed message again: a new command with a
 * new id. Never done automatically.
 */
export function sendAgain(scope: CloudAgentScope, entry: OutboxEntry, client: WorkspaceRpcClient | null) {
  if (entry.kind === "stop") return stopCloudAgent(scope, entry.tabId, client);
  if (entry.kind === "permission-decision") throw new Error("A decision is never sent twice");
  // Its change is made again from the held messages, as they are by then.
  if (entry.kind === "follow-up") throw new Error("A change to a held message is never sent twice");
  // A message with images or files goes again with them (uploaded again: the runtime may have
  // dropped them), or not at all. It is never sent as its text alone, or as nothing.
  if (entry.kind === "send" && ((entry.images ?? 0) > 0 || (entry.files ?? 0) > 0)) {
    const held = sentAttachments.get(entry.clientCommandId);
    if (!held) return Promise.reject(new CloudImageError(SEND_AGAIN_IMAGES_GONE));
    return sendToCloudAgent(scope, entry.tabId, entry.text ?? "", client, held.images, { files: held.files }).then((again) => {
      // The new command holds them now.
      sentAttachments.delete(entry.clientCommandId);
      return again;
    });
  }
  return enqueue(scope, entry.tabId, entry.kind, { text: entry.text ?? "" }, client);
}

/**
 * Said when "Send again" is pressed on a message whose images or files this
 * app no longer holds (it was restarted since): the outbox keeps their
 * count, not the attachments.
 */
export const SEND_AGAIN_IMAGES_GONE = "This message had attachments, which are no longer held here. Attach them again and send it from the composer.";

/**
 * The images and files of messages whose fate is not known yet, by command,
 * for "Send again". In memory only, and let go as soon as the message is
 * applied, rejected or cancelled.
 */
const sentAttachments = new Map<string, { images: ImageInput[]; files: FileInput[] }>();

export async function cancelCloudAgentCommand(scope: CloudAgentScope, clientCommandId: string) {
  const s = store(scope);
  upsert(s, await cloudAgentApi.cancel(scope, clientCommandId));
  publish(s);
}

/**
 * Resend unsent envelopes and poll their state until every command settled,
 * backing off from 1 s to 15 s while nothing changes.
 */
export function startOutboxPolling(scope: CloudAgentScope) {
  const s = store(scope);
  if (isDevScope(scope)) return;
  s.pollDelay = POLL_FIRST_MS;
  // One loop per workspace: a running sync picks the kick up when it returns.
  if (s.polling) {
    s.pollKick = true;
    return;
  }
  if (s.poll) return;
  const tick = async () => {
    s.poll = null;
    s.polling = true;
    let changed = false;
    try {
      const before = JSON.stringify(s.outbox.map((e) => [e.clientCommandId, e.state, e.updatedAt]));
      const entries = await cloudAgentApi.outboxSync(s.scope);
      if (stores.get(cloudAgentsKey(s.scope)) !== s) return;
      for (const entry of entries) upsert(s, entry);
      changed = JSON.stringify(s.outbox.map((e) => [e.clientCommandId, e.state, e.updatedAt])) !== before;
      if (changed) publish(s);
    } catch (error) {
      s.error = errorText(error);
      publish(s);
    } finally {
      s.polling = false;
    }
    if (stores.get(cloudAgentsKey(s.scope)) !== s) return;
    const kicked = s.pollKick;
    s.pollKick = false;
    if (!s.outbox.some((entry) => !TERMINAL_OUTBOX_STATES.has(entry.state))) return;
    s.pollDelay = changed || kicked ? POLL_FIRST_MS : Math.min(POLL_MAX_MS, s.pollDelay * 2);
    if (!s.poll) s.poll = setTimeout(() => void tick(), s.pollDelay);
  };
  s.poll = setTimeout(() => void tick(), s.pollDelay);
}

export function outboxFor(snapshot: CloudAgentsSnapshot, tabId: string): OutboxEntry[] {
  return snapshot.outbox.filter((entry) => entry.tabId === tabId);
}
