import { useSyncExternalStore } from "react";
import type { RuntimeSession } from "@terminalx/portable/workspace";
import type { DashboardSession, DashboardTab, DashboardTabStatus } from "@terminalx/portable/dashboard";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import { getAccount, subscribeAccount } from "@/lib/account";
import { getCloudAgents, loadCloudAgents, subscribeAllCloudAgents, type CloudAgentTab } from "@/lib/cloudAgents";
import { blankIdentity, cloudOrganizations, getCloudCatalog, liveCloudOrgIds, repositoryOf, subscribeCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";
import { cloudConnectionInfo, subscribeCloudConnections } from "@/lib/cloudConnections";
import { isArchived } from "@/lib/cloudLifecycle";
import { buildCloudSessions, liveCloudSessionList, subscribeCloudSessionLists } from "@/lib/cloudSessions";
import { selectCloudSession } from "@/lib/sessions";
import { selectSessionTab } from "@/lib/terminal";
import { cloudProjectKey, cloudWorkspaceKey } from "@/types/target";

/**
 * Cloud sessions as the Agent Dashboard, the dock badge, notifications and
 * the command palette see them (PRO-23 CS-19): every session of every live
 * organization, projected into `DashboardSession` so the same columns, counts
 * and search work for local and cloud alike.
 *
 * Built only from what is already known, and never by connecting: the
 * catalog (with each workspace's cached session list and its server-side
 * `runtimeActivity`), this desktop's agent-tab cache, and the live lists and
 * tabs of connections something else holds.
 *
 * - Connected: the live tab states decide.
 * - Not connected, on a server that reports `runtimeActivity`: the list's
 *   `pendingApprovals` and `activeTurns` decide, placed on the tabs the cache
 *   says were waiting or working (or else the newest session's first tab).
 * - Not connected, on an older server: the cache, except that a cached
 *   "working" is never trusted.
 * - A stopped workspace is never Working.
 */

export interface CloudDashboardTab extends DashboardTab {
  tabId: string;
  title: string | null;
  /** The runtime's pending permission requests on this tab, when known. */
  requestIds: string[];
  /** What the agent waits on (the tool it asks to use), when known. */
  waitingOn: string | null;
  /** Where a `waiting` status came from: the live runtime, this desktop's cache, or the server's list. */
  from: "live" | "cache" | "list";
}

export interface CloudDashboardSession extends DashboardSession {
  kind: "cloud";
  /** `cloud:<orgId>:<workspaceId>:<sessionId>`; also `id`. */
  key: string;
  orgId: string;
  orgName: string;
  workspaceId: string;
  workspaceName: string;
  sessionId: string;
  /** The cloud project (`cloud:<orgId>:<identity>`); also `projectPath`. */
  projectKey: string;
  projectName: string;
  /** `host/owner/name` of the primary repository; null for a blank project. */
  repository: string | null;
  connected: boolean;
  stopped: boolean;
  /** The evidence is the live runtime or a list this launch fetched, not only what was saved before it. */
  fresh: boolean;
  /** When the server's list last heard from the runtime (ms), if it says. */
  reportedAt: number | null;
  tabs: CloudDashboardTab[];
}

export function isCloudDashboardSession(session: object): session is CloudDashboardSession {
  return (session as { kind?: string }).kind === "cloud";
}

export interface CloudProjectionInput {
  orgs: { id: string; name: string }[];
  catalog: Pick<CloudCatalogState, "orgs" | "createMemory">;
  liveSessions: (orgId: string, workspaceId: string) => RuntimeSession[] | null;
  agentTabs: (orgId: string, workspaceId: string) => readonly CloudAgentTab[];
  connected: (orgId: string, workspaceId: string) => boolean;
}

function nameOfIdentity(identity: string): string {
  return identity.split("/").slice(1).join("/") || identity;
}

function isStopped(item: CloudWorkspaceListItem): boolean {
  const { state } = item.workspace;
  return state === "suspended" || state === "attention-required" || state === "provisioning" || isArchived(item.workspace);
}

/** Every non-archived session of the given organizations' non-archived workspaces. Pure. */
export function projectCloudSessions(input: CloudProjectionInput): CloudDashboardSession[] {
  const out: CloudDashboardSession[] = [];
  for (const org of input.orgs) {
    const catalog = input.catalog.orgs[org.id];
    if (!catalog) continue;
    for (const item of catalog.workspaces) {
      if (isArchived(item.workspace)) continue;
      out.push(...projectWorkspace(item, org, catalog.source === "live", input));
    }
  }
  return out;
}

function projectWorkspace(item: CloudWorkspaceListItem, org: { id: string; name: string }, listed: boolean, input: CloudProjectionInput): CloudDashboardSession[] {
  const { workspace } = item;
  const orgId = org.id;
  const connected = input.connected(orgId, workspace.id);
  const stopped = isStopped(item);
  const agentTabs = input.agentTabs(orgId, workspace.id);
  const byTab = new Map(agentTabs.map((tab) => [tab.tabId, tab]));
  const rows = buildCloudSessions({
    item,
    cached: input.catalog.orgs[orgId]?.sessions[workspace.id] ?? null,
    live: input.liveSessions(orgId, workspace.id),
    agentTabs,
  });
  const repository = repositoryOf(item, input.catalog.createMemory);
  const identity = repository?.identity ?? blankIdentity(workspace.name);
  const projectName = repository ? (repository.fullName ?? nameOfIdentity(repository.identity)) : workspace.name.trim() || workspace.name;
  const runtime = workspace.runtimeActivity ?? null;
  // The server's list speaks for a workspace this desktop is not connected to.
  const fromList = !connected && !!runtime;

  // What the cached tab state said, for placing the list's counts.
  const cachedWaiting: CloudDashboardTab[] = [];
  const cachedWorking: CloudDashboardTab[] = [];
  let newestFirstTab: CloudDashboardTab | null = null;
  let newest = "";

  const sessions = rows.map((row): CloudDashboardSession => {
    const tabs = row.tabs.map((tab): CloudDashboardTab => {
      const known = byTab.get(tab.tabId);
      const requests = known?.info.pendingPermissions ?? [];
      const waitingNow = tab.status === "waiting" || tab.pendingApprovals > 0;
      const done = tab.status === "completed" && tab.unread;
      let status: DashboardTabStatus = done ? "completed" : "idle";
      if (connected) {
        if (waitingNow) status = "waiting";
        else if (tab.status === "in_progress" && !stopped) status = "in_progress";
      } else if (!fromList) {
        // An older server: the cache's waiting stands; its working only while a stream is live.
        if (waitingNow) status = "waiting";
        else if (tab.status === "in_progress" && tab.live && !stopped) status = "in_progress";
      }
      const projected: CloudDashboardTab = {
        tabId: tab.tabId,
        harness: tab.harness,
        title: tab.title,
        status,
        requestIds: requests.map((request) => request.requestId),
        waitingOn: requests[0]?.toolName ?? null,
        from: connected || tab.live ? "live" : "cache",
      };
      if (fromList && waitingNow) cachedWaiting.push(projected);
      if (fromList && tab.status === "in_progress") cachedWorking.push(projected);
      return projected;
    });
    if (tabs.length && row.modified > newest) {
      newest = row.modified;
      newestFirstTab = tabs[0];
    }
    return {
      kind: "cloud",
      id: row.key,
      key: row.key,
      orgId,
      orgName: org.name,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      sessionId: row.sessionId,
      projectPath: cloudProjectKey(orgId, identity),
      projectKey: cloudProjectKey(orgId, identity),
      projectName,
      repository: repository?.identity ?? null,
      // Never a local path: the workspace's name stands in for the folder.
      cwd: workspace.name,
      worktreeName: row.worktreeName,
      branch: row.branch ?? workspace.launch?.workBranch ?? null,
      title: row.title,
      modified: row.modified,
      archived: row.archived,
      connected,
      stopped,
      fresh: connected || listed,
      reportedAt: runtime?.reportedAt ?? null,
      tabs,
    };
  });

  if (fromList && runtime.online && !stopped) {
    if (runtime.pendingApprovals > 0) {
      const targets = cachedWaiting.length ? cachedWaiting : cachedWorking.length ? cachedWorking : newestFirstTab ? [newestFirstTab] : [];
      for (const tab of targets) {
        tab.status = "waiting";
        tab.from = "list";
      }
    }
    if (runtime.activeTurns > 0) {
      for (const tab of cachedWorking) if (tab.status !== "waiting") tab.status = "in_progress";
      const first = newestFirstTab as CloudDashboardTab | null;
      if (!cachedWorking.some((tab) => tab.status === "in_progress") && first && first.status !== "waiting") first.status = "in_progress";
    }
  }
  return sessions;
}

// ---- the store -------------------------------------------------------------

/** The organizations whose sessions count: the live ones. */
export function dashboardOrgs(status: AccountStatus): { id: string; name: string }[] {
  const live = new Set(liveCloudOrgIds(status));
  return cloudOrganizations(status)
    .filter((org) => live.has(org.id))
    .map((org) => ({ id: org.id, name: org.isPersonal ? "Personal" : org.name }));
}

let snapshot: CloudDashboardSession[] = [];
let signature = "";
let dirty = true;
let unsubscribers: (() => void)[] = [];
const listeners = new Set<() => void>();
const loaded = new Set<string>();
let scheduled = false;

function recompute(): CloudDashboardSession[] {
  return projectCloudSessions({
    orgs: dashboardOrgs(getAccount().status),
    catalog: getCloudCatalog(),
    liveSessions: liveCloudSessionList,
    agentTabs: (organizationId, workspaceId) => getCloudAgents({ organizationId, workspaceId }).tabs,
    connected: (orgId, workspaceId) => cloudConnectionInfo(cloudWorkspaceKey(orgId, workspaceId)).state === "connected",
  });
}

/** This desktop's tab cache for each workspace, once: a disk read (and the checkpoint list), never a connection or a wake. */
function loadAgentCaches() {
  const catalog = getCloudCatalog();
  for (const org of dashboardOrgs(getAccount().status)) {
    for (const item of catalog.orgs[org.id]?.workspaces ?? []) {
      const key = cloudWorkspaceKey(org.id, item.workspace.id);
      if (isArchived(item.workspace) || loaded.has(key)) continue;
      loaded.add(key);
      void loadCloudAgents({ organizationId: org.id, workspaceId: item.workspace.id }).catch(() => undefined);
    }
  }
}

function take(next: CloudDashboardSession[]): boolean {
  const nextSignature = JSON.stringify(next);
  if (nextSignature === signature) return false;
  signature = nextSignature;
  snapshot = next;
  return true;
}

function refresh() {
  scheduled = false;
  dirty = false;
  loadAgentCaches();
  if (!take(recompute())) return;
  for (const listener of [...listeners]) listener();
}

function invalidate() {
  dirty = true;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(refresh);
}

function start() {
  if (unsubscribers.length) return;
  unsubscribers = [subscribeAccount(invalidate), subscribeCloudCatalog(invalidate), subscribeCloudSessionLists(invalidate), subscribeAllCloudAgents(invalidate), subscribeCloudConnections(invalidate)];
  invalidate();
}

/** Every cloud session the dashboard shows, now. */
export function getCloudDashboard(): CloudDashboardSession[] {
  start();
  if (dirty && !scheduled) {
    dirty = false;
    take(recompute());
  }
  return snapshot;
}

export function subscribeCloudDashboard(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCloudDashboard(): CloudDashboardSession[] {
  return useSyncExternalStore(subscribeCloudDashboard, getCloudDashboard, getCloudDashboard);
}

/** For tests: forget everything and stop following the sources. */
export function resetCloudDashboard() {
  for (const stop of unsubscribers) stop();
  unsubscribers = [];
  listeners.clear();
  loaded.clear();
  snapshot = [];
  signature = "";
  dirty = true;
  scheduled = false;
}

/**
 * Open a cloud session from the dashboard, a notification or the palette, on
 * the given tab. Only looks: the session view connects without waking, and a
 * stopped workspace stays stopped.
 */
export function openCloudSession(key: string, tabId?: string | null) {
  selectCloudSession(key);
  if (tabId) selectSessionTab(key, { kind: "agent", id: tabId });
}

/** The tab a cloud session opens on: the one waiting, else the one working, else the first. */
export function attentionTab(session: CloudDashboardSession): CloudDashboardTab | undefined {
  return session.tabs.find((tab) => tab.status === "waiting") ?? session.tabs.find((tab) => tab.status === "in_progress") ?? session.tabs.find((tab) => tab.status === "completed") ?? session.tabs[0];
}

// ---- attention: which waits and finishes to raise --------------------------

export interface CloudAttention {
  kind: "waiting" | "done";
  session: CloudDashboardSession;
  tab: CloudDashboardTab;
}

/** A wait that ends and comes back this soon, with nothing new to say, is the same wait seen through another source. */
export const ATTENTION_GRACE_MS = 15_000;
const REMEMBERED_REQUESTS = 2_000;

/**
 * Decide which cloud waits and finishes deserve a notice, once each, however
 * often the same state is seen again: on every poll, on a reconnect, through
 * the cache and then the live runtime, or through the list and then the
 * runtime. A wait is raised when a tab starts waiting (like a local tab), or
 * when the server's list first says a workspace this desktop is not connected
 * to has pending approvals. What was already true before this launch's first
 * list (only the saved cache) is taken as known and raised never.
 */
export function createCloudAttentionTracker(now: () => number = Date.now) {
  /** Tabs waiting now, by `${key}/${tabId}`. */
  const waitingTabs = new Set<string>();
  /**
   * Workspaces waiting now, by workspace key. `claimable` while the wait is
   * known only from the list or the saved cache: the first live wait seen in
   * the workspace is then that same wait, seen closer, and is not raised again.
   */
  const waitingWorkspaces = new Map<string, { claimable: boolean }>();
  /** When each workspace's last wait ended. */
  const endedAt = new Map<string, number>();
  /** Every permission request already seen waiting. */
  const seenRequests = new Set<string>();
  /** When each workspace was last seen connected. */
  const connectedAt = new Map<string, number>();
  const lastStatus = new Map<string, DashboardTabStatus>();

  const remember = (ids: readonly string[]) => {
    for (const id of ids) seenRequests.add(id);
    while (seenRequests.size > REMEMBERED_REQUESTS) seenRequests.delete(seenRequests.values().next().value as string);
  };

  return function observe(sessions: readonly CloudDashboardSession[]): CloudAttention[] {
    const at = now();
    const out: CloudAttention[] = [];
    const seenTabs = new Set<string>();
    const seenWorkspaces = new Set<string>();
    for (const session of sessions) {
      const workspaceKey = cloudWorkspaceKey(session.orgId, session.workspaceId);
      if (session.connected) connectedAt.set(workspaceKey, at);
      for (const tab of session.tabs) {
        const tabKey = `${session.key}/${tab.tabId}`;
        const previous = lastStatus.get(tabKey);
        lastStatus.set(tabKey, tab.status);
        if (tab.status !== "waiting") {
          if (previous === "in_progress" && tab.status === "completed" && tab.from === "live" && session.fresh) out.push({ kind: "done", session, tab });
          continue;
        }
        seenTabs.add(tabKey);
        seenWorkspaces.add(workspaceKey);
        const newRequests = tab.requestIds.filter((id) => !seenRequests.has(id));
        remember(tab.requestIds);
        const tabKnown = waitingTabs.has(tabKey);
        waitingTabs.add(tabKey);
        const workspace = waitingWorkspaces.get(workspaceKey);
        const live = tab.from === "live";
        if (!workspace) waitingWorkspaces.set(workspaceKey, { claimable: !live || !session.fresh });
        else if (live && workspace.claimable) {
          // The wait the list (or the cache) already stood for, now seen live: the same wait.
          workspace.claimable = false;
          continue;
        }
        if (tabKnown) continue;
        // Only a live runtime or a list fetched in this launch raises; what the saved cache says is known already.
        if (!session.fresh || tab.from === "cache") continue;
        // The workspace's wait was already raised: another source for it, or another tab of it seen through the list.
        if (workspace && !live) continue;
        // Nothing new to ask: a request already seen (a reconnect, another connection, a source switch).
        if (tab.requestIds.length && !newRequests.length) continue;
        // Back right after it ended with nothing to tell it apart: a source switch, not a new wait.
        const ended = endedAt.get(workspaceKey);
        if (!tab.requestIds.length && !live && ended !== undefined && at - ended < ATTENTION_GRACE_MS) continue;
        if (tab.from === "list") {
          // The list may lag behind a connection that just showed the wait answered.
          const lastConnected = connectedAt.get(workspaceKey);
          if (lastConnected !== undefined && (session.reportedAt === null || session.reportedAt <= lastConnected)) continue;
        }
        out.push({ kind: "waiting", session, tab });
      }
    }
    for (const tabKey of [...waitingTabs]) if (!seenTabs.has(tabKey)) waitingTabs.delete(tabKey);
    for (const workspaceKey of [...waitingWorkspaces.keys()]) {
      if (seenWorkspaces.has(workspaceKey)) continue;
      waitingWorkspaces.delete(workspaceKey);
      endedAt.set(workspaceKey, at);
    }
    // One notice per session and pass: several of its tabs starting to wait together are one thing to look at.
    const raised = new Set<string>();
    return out.filter((event) => {
      if (event.kind !== "waiting") return true;
      const key = cloudWorkspaceKey(event.session.orgId, event.session.workspaceId) + "/" + event.session.sessionId;
      if (raised.has(key)) return false;
      raised.add(key);
      return true;
    });
  };
}
