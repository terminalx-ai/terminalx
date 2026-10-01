import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { RuntimeSession, RuntimeSessionPatch, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { applyLiveTabs, closeCloudAgentTab, loadCloudAgents, useCloudAgents, watchLiveTabs, type CloudAgentTab } from "@/lib/cloudAgents";
import { cacheCloudSessions, useCloudCatalog, type CachedWorkspaceSessions } from "@/lib/cloudCatalog";
import { onCloudConnected, retainCloudConnection, waitCloudConnected, type CloudTarget } from "@/lib/cloudConnections";
import { cloudSessionKey, cloudWorkspaceKey, type CloudKey, type CloudWorkspaceNode } from "@/types/target";
import type { TabStatus } from "@/types/session";

/**
 * Each cloud workspace's sessions (PRO-23 CS-8), built from what is known,
 * cheapest first, without ever connecting to build it:
 *
 * 1. the launch placeholder: a workspace's first session is known from its
 *    launch intent (`launch.sessionId`/`tabId`) before anything is decrypted;
 * 2. the cache: the list its runtime last reported, saved with the catalog;
 * 3. the agent tabs this desktop holds (its tab cache and checkpoints);
 * 4. the live runtime, whenever something else holds a connection: its
 *    `session.list` and `session.tabs`, then the `session.sessions` (session/2)
 *    and `session.tabs` notifications. A live list replaces the cached one
 *    and is saved in its place.
 *
 * Tab states come from the `cloudAgents` store, which follows the runtime
 * while connected. A stopped workspace never shows a tab as working.
 */

export interface CloudSessionTab {
  tabId: string;
  harness: string;
  title: string | null;
  status: TabStatus;
  unread: boolean;
  pendingApprovals: number;
  /** Streaming live now. */
  live: boolean;
}

export interface CloudSessionRow {
  key: CloudKey;
  orgId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  branch: string | null;
  worktreeName: string | null;
  created: string;
  modified: string;
  pinned: boolean;
  archived: boolean;
  tabs: CloudSessionTab[];
  /** Where the session itself is known from. */
  source: "launch" | "cache" | "agents" | "live";
}

// ---- the live lists --------------------------------------------------------

interface LiveList {
  sessions: RuntimeSession[];
  capabilities: string[];
  /** The connection manages the workspace (the runtime's effective authority). */
  manage: boolean;
}

const live = new Map<string, LiveList>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function takeLive(target: CloudTarget, sessions: RuntimeSession[], capabilities: string[], manage: boolean) {
  live.set(cloudWorkspaceKey(target.orgId, target.workspaceId), { sessions, capabilities, manage });
  cacheCloudSessions(target.orgId, target.workspaceId, sessions, capabilities);
  publish();
}

function capabilitiesOf(client: WorkspaceRpcClient): string[] {
  const state = client.connection;
  return state.state === "connected" ? state.capabilities : [];
}

/** The runtime reports the effective authority: a demoted admin's manage attachment reads participate. */
function managesOf(client: WorkspaceRpcClient): boolean {
  const state = client.connection;
  return state.state === "connected" && state.authority === "manage" && (!state.you || state.you.listed === false || state.you.role === "manager");
}

/** Read the lists on every connect and follow them while connected. */
function onConnected(target: CloudTarget, client: WorkspaceRpcClient): () => void {
  const scope = { organizationId: target.orgId, workspaceId: target.workspaceId };
  const capabilities = capabilitiesOf(client);
  const manage = managesOf(client);
  let open = true;
  void client
    .listSessions()
    .then((sessions) => open && takeLive(target, sessions, capabilities, manage))
    .catch(() => undefined);
  void client
    .listAgentTabs()
    .then((tabs) => open && applyLiveTabs(scope, tabs))
    .catch(() => undefined);
  const stopTabs = watchLiveTabs(scope, client);
  const stopSessions = client.onSessions((sessions) => open && takeLive(target, sessions, capabilities, manage));
  return () => {
    open = false;
    stopTabs();
    stopSessions();
    // The cached copy (the same list) takes over.
    if (live.delete(cloudWorkspaceKey(target.orgId, target.workspaceId))) publish();
  };
}

let booted: (() => void) | null = null;

/** Start following every connection's session lists. Idempotent. */
export function bootCloudSessions() {
  if (!booted) booted = onCloudConnected(onConnected);
}

/** For tests. */
export function resetCloudSessions() {
  booted?.();
  booted = null;
  live.clear();
  publish();
}

// ---- building a workspace's rows ------------------------------------------

function tabStatus(status: TabStatus, stopped: boolean): TabStatus {
  // A stopped workspace is never shown as working, whatever was cached.
  return stopped && status === "in_progress" ? "idle" : status;
}

function iso(at: number | null | undefined): string {
  return new Date(at ?? 0).toISOString();
}

/**
 * A workspace's sessions, pinned first then newest (the order local sessions
 * use), archived ones only with `showArchived` (or when selected).
 */
export function buildCloudSessions(input: {
  item: CloudWorkspaceListItem;
  cached?: CachedWorkspaceSessions | null;
  live?: RuntimeSession[] | null;
  agentTabs?: readonly CloudAgentTab[];
  showArchived?: boolean;
  selectedKey?: string | null;
}): CloudSessionRow[] {
  const { item } = input;
  const { orgId, id: workspaceId, name, state, launch } = item.workspace;
  const stopped = state === "suspended" || state === "archived";
  // Not shared with this person (saas §21.2): nothing this desktop kept of
  // the workspace is listed, no session title, tab or status. One row, named
  // after the workspace, opens the lock pane: the selected session if it is
  // here, else the first one the launch intent names.
  if (item.workspace.you?.role === "none") {
    const prefix = `${cloudWorkspaceKey(orgId, workspaceId)}:`;
    const selected = input.selectedKey?.startsWith(prefix) ? input.selectedKey.slice(prefix.length) : null;
    const sessionId = selected || launch?.sessionId || null;
    if (!sessionId) return [];
    return [
      {
        key: cloudSessionKey(orgId, workspaceId, sessionId),
        orgId,
        workspaceId,
        sessionId,
        title: name,
        branch: null,
        worktreeName: null,
        created: iso(item.workspace.createdAt),
        modified: iso(item.workspace.lastActivityAt ?? item.workspace.updatedAt),
        pinned: false,
        archived: false,
        tabs: [],
        source: "launch",
      },
    ];
  }
  const agentTabs = new Map((input.agentTabs ?? []).map((tab) => [tab.tabId, tab]));
  const rows = new Map<string, CloudSessionRow>();
  const source: CloudSessionRow["source"] = input.live ? "live" : "cache";
  const listed = input.live ?? input.cached?.sessions ?? [];

  const tabOf = (tabId: string, fallback: { harness: string; title?: string | null; status: TabStatus }): CloudSessionTab => {
    const known = agentTabs.get(tabId);
    const status = known ? known.info.status : fallback.status;
    return {
      tabId,
      harness: known?.info.harness || fallback.harness,
      title: known?.info.title ?? fallback.title ?? null,
      status: tabStatus(status, stopped),
      unread: known ? known.unread : status === "completed",
      pendingApprovals: known?.info.pendingPermissions.length ?? 0,
      live: known?.live ?? false,
    };
  };

  for (const session of listed) {
    rows.set(session.id, {
      key: cloudSessionKey(orgId, workspaceId, session.id),
      orgId,
      workspaceId,
      sessionId: session.id,
      title: session.title || name,
      branch: session.branch ?? null,
      worktreeName: session.worktreeName ?? null,
      created: session.created,
      modified: session.modified,
      pinned: session.pinned,
      archived: session.archived,
      tabs: session.tabs.map((tab) => tabOf(tab.id, { harness: tab.harness, title: tab.title, status: tab.status })),
      source,
    });
  }

  // Tabs this desktop knows whose session the list does not have (yet).
  if (!input.live) {
    for (const tab of agentTabs.values()) {
      const sessionId = tab.info.sessionId;
      if (!sessionId || tab.placeholder) continue;
      let row = rows.get(sessionId);
      if (!row) {
        row = {
          key: cloudSessionKey(orgId, workspaceId, sessionId),
          orgId,
          workspaceId,
          sessionId,
          title: tab.info.title || name,
          branch: null,
          worktreeName: null,
          created: tab.info.created || iso(item.workspace.createdAt),
          modified: tab.info.modified || iso(item.workspace.updatedAt),
          pinned: false,
          archived: false,
          tabs: [],
          source: "agents",
        };
        rows.set(sessionId, row);
      }
      if (!row.tabs.some((known) => known.tabId === tab.tabId)) row.tabs.push(tabOf(tab.tabId, { harness: tab.info.harness, status: tab.info.status }));
    }
  }

  // The launch placeholder: the first session, before any list names it.
  if (!input.live && launch?.sessionId && !rows.has(launch.sessionId)) {
    rows.set(launch.sessionId, {
      key: cloudSessionKey(orgId, workspaceId, launch.sessionId),
      orgId,
      workspaceId,
      sessionId: launch.sessionId,
      title: name,
      branch: launch.workBranch || null,
      worktreeName: null,
      created: iso(launch.timings?.requestedAt ?? item.workspace.createdAt),
      modified: iso(item.workspace.lastActivityAt ?? item.workspace.updatedAt),
      pinned: false,
      archived: false,
      tabs: launch.tabId ? [tabOf(launch.tabId, { harness: launch.agent, status: "idle" })] : [],
      source: "launch",
    });
  }

  return [...rows.values()]
    .filter((row) => row.archived === !!input.showArchived || row.key === input.selectedKey)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified));
}

/** The status a session row's stripe shows: the most urgent of its tabs. */
export function cloudSessionStatus(row: CloudSessionRow): TabStatus {
  let out: TabStatus = "idle";
  for (const tab of row.tabs) {
    if (tab.status === "waiting" || tab.pendingApprovals > 0) return "waiting";
    if (tab.status === "in_progress") out = "in_progress";
    else if (tab.status === "completed" && tab.unread && out === "idle") out = "completed";
  }
  return out;
}

/** What the runtime of a workspace can do with sessions, from the live connection or the cache; null when never known. */
export function cloudSessionCapabilities(orgId: string, workspaceId: string, cached: CachedWorkspaceSessions | undefined): string[] | null {
  return live.get(cloudWorkspaceKey(orgId, workspaceId))?.capabilities ?? cached?.capabilities ?? null;
}

/** A workspace's live session list, while a connection follows it; null otherwise. */
export function liveCloudSessionList(orgId: string, workspaceId: string): RuntimeSession[] | null {
  return live.get(cloudWorkspaceKey(orgId, workspaceId))?.sessions ?? null;
}

/** Told whenever any workspace's live session list changes. */
export function subscribeCloudSessionLists(listener: () => void): () => void {
  return subscribe(listener);
}

/** Whether the workspace's rows come from a live runtime now. */
export function hasLiveCloudSessions(orgId: string, workspaceId: string): boolean {
  return live.has(cloudWorkspaceKey(orgId, workspaceId));
}

/**
 * A workspace's session rows for the sidebar. `load` reads this desktop's tab
 * cache and checkpoint list (no connection, no compute); pass it only for
 * rows that are shown.
 */
export function useCloudWorkspaceSessions(node: CloudWorkspaceNode, options: { load: boolean; showArchived: boolean; selectedKey: string | null }): {
  sessions: CloudSessionRow[];
  capabilities: string[] | null;
  /**
   * May rename, pin, archive and delete sessions: the live connection's
   * authority, else the list's role (saas §21.2), else as before.
   */
  manage: boolean;
  known: boolean;
} {
  const { orgId, id: workspaceId } = node.item.workspace;
  const key = cloudWorkspaceKey(orgId, workspaceId);
  const catalog = useCloudCatalog();
  const cached = catalog.orgs[orgId]?.sessions[workspaceId];
  const liveList = useSyncExternalStore(subscribe, () => live.get(key) ?? null, () => null);
  const scope = useMemo(() => ({ organizationId: orgId, workspaceId }), [orgId, workspaceId]);
  const agents = useCloudAgents(scope);
  useEffect(() => {
    if (options.load) void loadCloudAgents(scope).catch(() => undefined);
  }, [options.load, scope]);
  const sessions = useMemo(
    () => buildCloudSessions({ item: node.item, cached, live: liveList?.sessions ?? null, agentTabs: agents.tabs, showArchived: options.showArchived, selectedKey: options.selectedKey }),
    [node.item, cached, liveList, agents.tabs, options.showArchived, options.selectedKey],
  );
  return {
    sessions,
    capabilities: liveList?.capabilities ?? cached?.capabilities ?? null,
    manage: liveList ? liveList.manage : node.item.workspace.you ? node.item.workspace.you.role === "manager" : true,
    known: !!liveList || !!cached || agents.tabs.length > 0 || !!node.item.workspace.launch?.sessionId,
  };
}

// ---- session/2 actions ----------------------------------------------------

const CONNECT_WITHIN_MS = 30_000;

/**
 * Run `work` on the workspace's runtime: a connection is held (with
 * `connect`, never `wake`) for as long as it takes. A stopped workspace is
 * refused rather than resumed.
 */
async function onRuntime<T>(row: Pick<CloudSessionRow, "orgId" | "workspaceId">, work: (client: WorkspaceRpcClient) => Promise<T>): Promise<T> {
  const lease = await retainCloudConnection({ orgId: row.orgId, workspaceId: row.workspaceId }, "connect");
  try {
    await waitCloudConnected(lease.client, CONNECT_WITHIN_MS, { stoppedIsError: true });
    return await work(lease.client);
  } finally {
    lease.release();
  }
}

function applySession(row: CloudSessionRow, session: RuntimeSession | null, removed: readonly string[] = []) {
  const key = cloudWorkspaceKey(row.orgId, row.workspaceId);
  const current = live.get(key);
  if (!current) return;
  let sessions = current.sessions.filter((existing) => !removed.includes(existing.id));
  if (session) sessions = sessions.some((existing) => existing.id === session.id) ? sessions.map((existing) => (existing.id === session.id ? session : existing)) : [...sessions, session];
  takeLive({ orgId: row.orgId, workspaceId: row.workspaceId }, sessions, current.capabilities, current.manage);
}

export function updateCloudSession(row: CloudSessionRow, patch: RuntimeSessionPatch): Promise<void> {
  return onRuntime(row, async (client) => {
    const session = await client.updateSession(row.sessionId, patch);
    applySession(row, session ?? null);
  });
}

/** Delete a session and its transcripts on the VM; a worktree it has goes with it, with every session in it. */
export function deleteCloudSession(row: CloudSessionRow): Promise<string[]> {
  return onRuntime(row, async (client) => {
    const result = await client.deleteSession(row.sessionId, { removeWorktree: !!row.worktreeName });
    const deleted = result.deleted?.length ? result.deleted : [row.sessionId];
    applySession(row, null, deleted);
    return deleted;
  });
}

/** Read a workspace's list again now, e.g. after creating a session on a runtime without `session/2` notifications. */
export async function refreshCloudSessions(target: CloudTarget, client: WorkspaceRpcClient): Promise<void> {
  takeLive(target, await client.listSessions(), capabilitiesOf(client), managesOf(client));
}

/** Close one agent tab of a session on the VM (its process stops); a stopped workspace is refused, never resumed. */
export function closeCloudSessionTab(row: CloudSessionRow, tabId: string): Promise<void> {
  return onRuntime(row, async (client) => {
    await closeCloudAgentTab({ organizationId: row.orgId, workspaceId: row.workspaceId }, tabId, client);
    if (hasLiveCloudSessions(row.orgId, row.workspaceId)) await refreshCloudSessions({ orgId: row.orgId, workspaceId: row.workspaceId }, client).catch(() => undefined);
  });
}
