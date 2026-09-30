import { useSyncExternalStore } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { applyEvent, dropTabLog, getTabLog, lastSeq, mergeTabEvents } from "@/lib/agentEvents";
import {
  cloudAgentApi,
  TERMINAL_OUTBOX_STATES,
  type AgentTabInfo,
  type AgentTabStatus,
  type CachedTab,
  type CloudAgentScope,
  type OutboxEntry,
  type OutboxKind,
  type OutboxPayload,
  type WakeResult,
} from "@/lib/cloudAgentApi";
import type { AgentEvent } from "@/types/events";
import { DEFAULT_PERMISSION_MODE } from "@/lib/models";

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
  /** Model, effort or mode chosen while offline, carried in the next send. */
  pendingConfig: { model?: string; effort?: string | null; mode?: string } | null;
}

export interface CloudAgentsSnapshot {
  tabs: CloudAgentTab[];
  outbox: OutboxEntry[];
  loaded: boolean;
  /** What the last interactive command did to the workspace's compute. */
  wake: WakeResult | null;
  error: string | null;
  version: number;
}

interface Store {
  scope: CloudAgentScope;
  tabs: Map<string, CloudAgentTab>;
  outbox: OutboxEntry[];
  loaded: boolean;
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

/**
 * A runtime attached by pairing code for development: no organization, so no
 * API mailbox, keys, checkpoints or cache. Prompts go over live RPC; steering,
 * stopping and decisions need a cloud workspace.
 */
export function isDevScope(scope: CloudAgentScope): boolean {
  return !scope.organizationId;
}

export const DEV_SCOPE_NOTICE = "Steering, stopping and permission decisions need a cloud workspace; this development runtime only takes prompts.";

export function cloudAgentsKey(scope: CloudAgentScope): string {
  return `${scope.organizationId}:${scope.workspaceId}`;
}

const EMPTY: CloudAgentsSnapshot = { tabs: [], outbox: [], loaded: false, wake: null, error: null, version: 0 };

function store(scope: CloudAgentScope): Store {
  const k = cloudAgentsKey(scope);
  let s = stores.get(k);
  if (!s) {
    s = {
      scope,
      tabs: new Map(),
      outbox: [],
      loaded: false,
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

function publish(s: Store) {
  const tabs = [...s.tabs.values()].sort((a, b) => a.info.created.localeCompare(b.info.created) || a.tabId.localeCompare(b.tabId));
  s.snapshot = { tabs, outbox: s.outbox, loaded: s.loaded, wake: s.wake, error: s.error, version: s.snapshot.version + 1 };
  for (const listener of [...s.listeners]) listener();
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

/** Forget every workspace's tabs and stop polling (sign-out, organization switch, tests). */
export function resetCloudAgents() {
  for (const s of stores.values()) {
    if (s.poll) clearTimeout(s.poll);
    for (const timer of s.saves.values()) clearTimeout(timer);
    for (const tab of s.tabs.values()) if (tab.info.sessionId) dropTabLog(tab.info.sessionId, tab.tabId);
  }
  stores.clear();
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
  return count;
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
    pendingConfig: null,
  };
}

function newer(a: { epoch: number; version: number }, b: { epoch: number; version: number } | null): boolean {
  if (!b) return true;
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.version > b.version);
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

async function saveNow(s: Store, tabId: string) {
  if (isDevScope(s.scope)) return;
  const tab = s.tabs.get(tabId);
  if (!tab || tab.placeholder || !tab.info.sessionId) return;
  const events = getTabLog(tab.info.sessionId, tabId).events.filter((ev) => ev.payload.type !== "delta").slice(-CACHE_EVENTS);
  const entry: CachedTab = {
    tab: tab.info,
    events,
    cursor: tab.cursor,
    checkpoint: tab.checkpoint,
    unread: tab.unread,
    completed: tab.completed,
    pendingConfig: tab.pendingConfig,
    updatedAt: Date.now(),
  };
  try {
    await cloudAgentApi.cacheSave(s.scope, tabId, entry);
  } catch {
    // The cache is only a head start; the checkpoint and the runtime hold the truth.
  }
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
      const cached = await cloudAgentApi.cacheLoad(scope);
      for (const [tabId, entry] of Object.entries(cached?.tabs ?? {})) {
        if (!entry?.tab || s.tabs.has(tabId)) continue;
        const tab = newTab(entry.tab, "cache");
        tab.cursor = entry.cursor ?? null;
        tab.checkpoint = entry.checkpoint ?? null;
        tab.unread = entry.unread;
        tab.completed = entry.completed;
        tab.pendingConfig = entry.pendingConfig ?? null;
        s.tabs.set(tabId, tab);
        if (entry.tab.sessionId && entry.events?.length) mergeTabEvents(entry.tab.sessionId, tabId, entry.events);
      }
    } catch (error) {
      s.error = errorText(error);
    }
    try {
      s.outbox = await cloudAgentApi.outbox(scope);
    } catch (error) {
      s.error = errorText(error);
    }
    try {
      for (const meta of await cloudAgentApi.checkpoints(scope)) {
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
 * Bring one tab up to date from its checkpoint, when that is newer than what
 * is shown. Skipped once the tab streams live: a live projection is always
 * stronger than a checkpoint.
 */
export async function refreshFromCheckpoint(scope: CloudAgentScope, tabId: string): Promise<boolean> {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab || tab.live) return false;
  const checkpoint = await cloudAgentApi.checkpoint(scope, tabId, tab.checkpoint);
  const current = s.tabs.get(tabId);
  if (!checkpoint || !current || current.live || !newer(checkpoint, current.checkpoint)) return false;
  const p = checkpoint.projection;
  if (p.tabId !== tabId) return false;
  current.checkpoint = { epoch: checkpoint.epoch, version: checkpoint.version };
  if (current.source !== "live" || current.placeholder) {
    noteStatus(current, p.status);
    current.info = {
      ...current.info,
      sessionId: p.sessionId,
      title: p.title,
      harness: p.harness,
      model: p.model,
      effort: p.effort,
      permissionMode: p.permissionMode,
      status: p.status,
      process: p.process,
      followUps: p.followUps ?? [],
      lastSeq: p.events.length ? p.events[p.events.length - 1].seq : current.info.lastSeq,
      created: current.info.created || new Date(p.updatedAt || 0).toISOString(),
      modified: new Date(p.updatedAt || 0).toISOString(),
    };
    current.source = "checkpoint";
    current.placeholder = false;
  }
  mergeTabEvents(p.sessionId, tabId, p.events);
  publish(s);
  scheduleSave(s, tabId);
  return true;
}

// ---- the live runtime

/** The runtime's own tab list is authoritative: tabs it no longer has are gone. */
export function applyLiveTabs(scope: CloudAgentScope, tabs: AgentTabInfo[]) {
  const s = store(scope);
  const seen = new Set<string>();
  for (const info of tabs) {
    seen.add(info.tabId);
    const existing = s.tabs.get(info.tabId);
    if (!existing) {
      s.tabs.set(info.tabId, newTab(info, "live"));
    } else {
      noteStatus(existing, info.status);
      existing.info = info;
      existing.source = "live";
      existing.placeholder = false;
    }
    scheduleSave(s, info.tabId);
  }
  for (const [tabId, tab] of [...s.tabs]) {
    if (seen.has(tabId)) continue;
    forgetTab(s, tab);
  }
  s.loaded = true;
  publish(s);
}

function forgetTab(s: Store, tab: CloudAgentTab) {
  s.tabs.delete(tab.tabId);
  const pending = s.saves.get(tab.tabId);
  if (pending) clearTimeout(pending);
  s.saves.delete(tab.tabId);
  if (tab.info.sessionId) dropTabLog(tab.info.sessionId, tab.tabId);
  if (!isDevScope(s.scope)) void cloudAgentApi.cacheSave(s.scope, tab.tabId, null).catch(() => undefined);
}

export async function syncLiveTabs(scope: CloudAgentScope, client: WorkspaceRpcClient) {
  applyLiveTabs(scope, await client.listAgentTabs());
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
 * Stream a tab live. Call only while the connection is up: reading never
 * wakes compute. Resumes after the cached cursor; overlapping replays are
 * merged by seq.
 */
export async function attachCloudAgentTab(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient): Promise<() => void> {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab || !tab.info.sessionId) return () => undefined;
  const sessionId = tab.info.sessionId;
  tab.live = true;
  publish(s);
  const onEvent = (raw: unknown) => {
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
  try {
    stop = await client.subscribeSession(sessionId, tabId, onEvent, {
      sinceCursor: tab.cursor ?? undefined,
      onCursor: (cursor) => {
        const current = s.tabs.get(tabId);
        if (current) current.cursor = cursor ?? null;
      },
      onStatus: (change) => {
        const current = s.tabs.get(tabId);
        if (!current) return;
        noteStatus(current, change.status);
        if (change.status === "completed" && isViewed(scope, tabId)) current.unread = false;
        // The runtime reports the process in `session.tabs`, not with a status.
        current.info = { ...current.info, status: change.status, process: change.process ?? current.info.process };
        publish(s);
        scheduleSave(s, tabId);
      },
    });
  } catch (error) {
    const current = s.tabs.get(tabId);
    if (current) current.live = false;
    publish(s);
    throw error;
  }
  return () => {
    stop?.();
    const current = s.tabs.get(tabId);
    if (current) current.live = false;
    publish(s);
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
  if (tab.info.status === "completed") tab.info = { ...tab.info, status: "idle" };
  publish(s);
  scheduleSave(s, tabId);
  if (client && client.connection.state === "connected" && tab.info.sessionId) {
    await client.markAgentTabRead(tab.info.sessionId, tabId).catch(() => undefined);
  }
}

export async function createCloudAgentTab(
  scope: CloudAgentScope,
  client: WorkspaceRpcClient,
  params: { agent: string; model?: string; effort?: string | null; mode?: string; title?: string; prompt?: string; useWorktree?: boolean },
): Promise<string> {
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
  return created.tabId;
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

/** Model, effort or permission mode: now when connected, else with the next message. */
export async function configureCloudAgentTab(
  scope: CloudAgentScope,
  tabId: string,
  patch: { model?: string; effort?: string | null; mode?: string },
  client: WorkspaceRpcClient | null,
) {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (!tab) return;
  const optimistic = {
    ...tab.info,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.mode !== undefined ? { permissionMode: patch.mode } : {}),
  };
  if (client && client.connection.state === "connected" && tab.info.sessionId) {
    const updated = await client.configureAgentTab({ sessionId: tab.info.sessionId, tabId, ...patch });
    const current = s.tabs.get(tabId);
    if (current) current.info = updated ?? optimistic;
  } else {
    tab.pendingConfig = { ...(tab.pendingConfig ?? {}), ...patch };
    tab.info = optimistic;
  }
  publish(s);
  scheduleSave(s, tabId);
}

// ---- the outbox

function upsert(s: Store, entry: OutboxEntry) {
  const at = s.outbox.findIndex((existing) => existing.clientCommandId === entry.clientCommandId);
  s.outbox = at >= 0 ? s.outbox.map((existing, i) => (i === at ? entry : existing)) : [...s.outbox, entry];
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
): Promise<OutboxEntry> {
  const s = store(scope);
  const entry = await cloudAgentApi.enqueue(scope, tabId, kind, payload);
  upsert(s, entry);
  if (entry.wake) s.wake = entry.wake;
  s.error = null;
  publish(s);
  if (client && client.connection.state === "connected") void client.nudgeMailbox().catch(() => undefined);
  if (!TERMINAL_OUTBOX_STATES.has(entry.state)) startOutboxPolling(scope);
  return entry;
}

/** A prompt: now if the agent is idle, else queued as a follow-up by the runtime. */
export async function sendToCloudAgent(scope: CloudAgentScope, tabId: string, text: string, client: WorkspaceRpcClient | null) {
  const s = store(scope);
  const tab = s.tabs.get(tabId);
  if (isDevScope(scope)) return sendOverLiveRpc(scope, tabId, text, client);
  const sent = tab?.pendingConfig ?? null;
  const entry = await enqueue(scope, tabId, "send", { text, ...(sent ?? {}) }, client);
  // Only what went out is settled; a change made meanwhile waits for the next.
  const current = s.tabs.get(tabId);
  if (current && sent && current.pendingConfig === sent) {
    current.pendingConfig = null;
    scheduleSave(s, tabId);
  }
  return entry;
}

/** A development runtime has no mailbox: the legacy live `session.send`. */
async function sendOverLiveRpc(scope: CloudAgentScope, tabId: string, text: string, client: WorkspaceRpcClient | null): Promise<OutboxEntry> {
  const tab = store(scope).tabs.get(tabId);
  if (!client || client.connection.state !== "connected" || !tab?.info.sessionId) throw new Error("The development runtime is not connected");
  await client.mutate("session.send", { sessionId: tab.info.sessionId, tabId, text });
  const now = Date.now();
  return { clientCommandId: `live-${now}`, tabId, kind: "send", text, state: "applied", createdAt: now, updatedAt: now };
}

/** Into the running turn now. */
export function steerCloudAgent(scope: CloudAgentScope, tabId: string, text: string, client: WorkspaceRpcClient | null) {
  if (isDevScope(scope)) return Promise.reject(new Error(DEV_SCOPE_NOTICE));
  return enqueue(scope, tabId, "steer", { text }, client);
}

export function stopCloudAgent(scope: CloudAgentScope, tabId: string, client: WorkspaceRpcClient | null) {
  if (isDevScope(scope)) return Promise.reject(new Error(DEV_SCOPE_NOTICE));
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
  if (isDevScope(scope)) throw new Error(DEV_SCOPE_NOTICE);
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

export function isDeciding(scope: CloudAgentScope, requestId: string): boolean {
  const s = store(scope);
  return s.deciding.has(requestId) || !!decisionFor(s.outbox, requestId);
}

/**
 * The reader chose to try an unconfirmed message again: a new command with a
 * new id. Never done automatically.
 */
export function sendAgain(scope: CloudAgentScope, entry: OutboxEntry, client: WorkspaceRpcClient | null) {
  if (entry.kind === "stop") return stopCloudAgent(scope, entry.tabId, client);
  if (entry.kind === "permission-decision") throw new Error("A decision is never sent twice");
  return enqueue(scope, entry.tabId, entry.kind, { text: entry.text ?? "" }, client);
}

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
