import { useMemo, useSyncExternalStore } from "react";
import type { AgentTabInfo, MachineProject, RuntimeSession, RuntimeSessionPatch, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CloudWorkspaceConnection } from "@/lib/api";
import { applyLiveTabs, getCloudAgents, subscribeAllCloudAgents, useCloudAgents, watchLiveTabs, type CloudAgentTab } from "@/lib/cloudAgents";
import type { CloudAgentScope } from "@/lib/cloudAgentApi";
import { getMachineConnections, subscribeMachineConnections } from "@/lib/machineConnections";
import { keepMessageTime, newestMessageTime } from "@/lib/messageActivity";
import { compareSidebarSessions } from "@/lib/sidebarView";
import { cloudTabTitle } from "@/lib/cloudRowState";
import { machineProjectKey, machineSectionKey, machineSessionKey, parseMachineKey, type MachineKey } from "@/types/target";
import type { TabStatus } from "@/types/session";

/**
 * Each paired machine's projects and sessions (PRO-346, docs/MACHINES.md
 * decision 8), for its sidebar section, the overview, the dock badge and
 * notifications.
 *
 * While a machine is attached ({@link startMachineConnections}) and its
 * connection is up, this follows it: `machine.projects` and `machine.changed`
 * for the projects, `session.list` and `session.sessions` for the sessions,
 * and `session.tabs` for the agent tabs (kept in the shared `cloudAgents`
 * store under the machine's scope, as the machine's view keeps them). What it
 * last heard is saved on this Mac, so a machine that cannot be reached keeps
 * its section with its last known sessions, read from the save.
 *
 * Nothing here connects: it only follows connections `machineConnections`
 * holds.
 */

/** What is known of one machine. */
export interface MachineCatalogEntry {
  projects: MachineProject[];
  sessions: RuntimeSession[];
  /** Agent tabs that were unread when last known, so a relaunch keeps the mark while the machine is away. */
  unread: string[];
  /** `live` while its connection is up and has answered; else what was saved. */
  source: "live" | "cache";
  /** When the machine last answered (ms since epoch); null if never. */
  syncedAt: number | null;
}

export interface MachineCatalogState {
  machines: Record<string, MachineCatalogEntry>;
}

export interface MachineSessionTab {
  tabId: string;
  harness: string;
  title: string | null;
  status: TabStatus;
  unread: boolean;
  pendingApprovals: number;
  created?: string;
  lastMessageAt?: string | null;
  live: boolean;
}

/** A session on a machine, as its sidebar row, the overview and the badge read it. */
export interface MachineSessionRow {
  key: MachineKey;
  machineId: string;
  projectId: string;
  sessionId: string;
  title: string;
  branch: string | null;
  worktreeName: string | null;
  created: string;
  modified: string;
  lastMessageAt?: string | null;
  hasMessages?: boolean;
  pinned: boolean;
  archived: boolean;
  rowStatus?: RuntimeSession["rowStatus"];
  manualStatus?: RuntimeSession["manualStatus"];
  tabs: MachineSessionTab[];
  activeTab: string | null;
  source: "live" | "cache";
}

/** A project on a machine with its sessions, most recent activity first. */
export interface MachineProjectNode {
  key: MachineKey;
  machineId: string;
  project: MachineProject;
  sessions: MachineSessionRow[];
}

const STORAGE_KEY = "terminalx.machineCatalog.v1";
const SAVE_DEBOUNCE_MS = 500;

/** The scope a machine's agent tabs are kept under in `cloudAgents`: the same one its view uses. */
export function machineAgentScope(machineId: string): CloudAgentScope {
  return { organizationId: "", workspaceId: machineSectionKey(machineId) };
}

// ---- the store -------------------------------------------------------------

let state: MachineCatalogState = { machines: {} };
const listeners = new Set<() => void>();
let loaded = false;

function publish() {
  for (const listener of [...listeners]) listener();
}

export function subscribeMachineCatalog(listener: () => void): () => void {
  boot();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The catalog as it is now, outside React (the badge, notifications). */
export function getMachineCatalog(): MachineCatalogState {
  boot();
  return state;
}

export function useMachineCatalog(): MachineCatalogState {
  return useSyncExternalStore(subscribeMachineCatalog, getMachineCatalog, getMachineCatalog);
}

function isProject(value: unknown): value is MachineProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<MachineProject>;
  return typeof project.projectId === "string" && /^[A-Za-z0-9_-]+$/.test(project.projectId) && typeof project.name === "string";
}

function isSession(value: unknown): value is RuntimeSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<RuntimeSession>;
  return typeof session.id === "string" && !session.id.includes(":") && Array.isArray(session.tabs);
}

function readSaved(): Record<string, MachineCatalogEntry> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, MachineCatalogEntry> = {};
    for (const [machineId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || machineId.includes(":")) continue;
      const entry = value as Partial<MachineCatalogEntry>;
      out[machineId] = {
        projects: Array.isArray(entry.projects) ? entry.projects.filter(isProject) : [],
        sessions: Array.isArray(entry.sessions) ? entry.sessions.filter(isSession) : [],
        unread: Array.isArray(entry.unread) ? entry.unread.filter((id): id is string => typeof id === "string") : [],
        source: "cache",
        syncedAt: typeof entry.syncedAt === "number" ? entry.syncedAt : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DEBOUNCE_MS);
}

function saveNow() {
  const out: Record<string, Omit<MachineCatalogEntry, "source">> = {};
  for (const [machineId, entry] of Object.entries(state.machines)) {
    out[machineId] = { projects: entry.projects, sessions: entry.sessions, unread: unreadTabs(machineId, entry), syncedAt: entry.syncedAt };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Storage refused: the next launch shows the machine's section empty until it answers.
  }
}

/** The unread agent tabs of a machine: what the agents store knows, else what was saved. */
function unreadTabs(machineId: string, entry: MachineCatalogEntry): string[] {
  const known = new Map(getCloudAgents(machineAgentScope(machineId)).tabs.map((tab) => [tab.tabId, tab]));
  const ids = new Set<string>();
  for (const session of entry.sessions) {
    for (const tab of session.tabs) {
      const agent = known.get(tab.id);
      if (agent ? agent.unread : entry.unread.includes(tab.id)) ids.add(tab.id);
    }
  }
  return [...ids];
}

function setEntry(machineId: string, patch: Partial<MachineCatalogEntry>) {
  const before = state.machines[machineId] ?? { projects: [], sessions: [], unread: [], source: "cache" as const, syncedAt: null };
  state = { machines: { ...state.machines, [machineId]: { ...before, ...patch } } };
  publish();
  scheduleSave();
}

function dropEntry(machineId: string) {
  if (!state.machines[machineId]) return;
  const { [machineId]: _dropped, ...machines } = state.machines;
  state = { machines };
  publish();
  scheduleSave();
}

// ---- following the connections --------------------------------------------

interface Follow {
  connection: CloudWorkspaceConnection;
  stop: () => void;
}

const following = new Map<string, Follow>();

function follow(machineId: string, connection: CloudWorkspaceConnection): Follow {
  const client = connection.client;
  const scope = machineAgentScope(machineId);
  let generation = 0;
  let stopTabs: (() => void) | null = null;

  const read = async () => {
    const mine = ++generation;
    try {
      const [projects, sessions, tabs] = await Promise.all([
        client.hasCapability("machine/1") ? client.machineProjects() : Promise.resolve(null),
        client.listSessions(),
        client.listAgentTabs().catch(() => null),
      ]);
      if (mine !== generation || following.get(machineId)?.connection !== connection) return;
      if (tabs) applyLiveTabs(scope, tabs);
      takeSessions(machineId, sessions, projects);
    } catch {
      // A read refused or cut off: the next connection reads again; what was known stays.
    }
  };

  const onState = (connected: boolean) => {
    stopTabs?.();
    stopTabs = null;
    if (connected) {
      stopTabs = watchLiveTabs(scope, client);
      void read();
    } else if (state.machines[machineId]?.source === "live") {
      generation++;
      setEntry(machineId, { source: "cache" });
    }
  };

  const offState = client.onState((next) => onState(next.state === "connected"));
  const offSessions = client.onSessions((sessions) => takeSessions(machineId, sessions, null));
  const offChanged = client.onMachineChanged(({ projects }) => {
    if (projects) setEntry(machineId, { projects: projects.filter(isProject), source: "live", syncedAt: Date.now() });
    else void read();
  });
  if (client.connection.state === "connected") onState(true);

  return {
    connection,
    stop: () => {
      generation++;
      stopTabs?.();
      offState();
      offSessions();
      offChanged();
      if (state.machines[machineId]?.source === "live") setEntry(machineId, { source: "cache" });
    },
  };
}

function takeSessions(machineId: string, sessions: RuntimeSession[], projects: MachineProject[] | null) {
  const previous = state.machines[machineId]?.sessions ?? [];
  const next = sessions.filter(isSession).map((session) => keepMessageTime(session, previous.find((old) => old.id === session.id)));
  setEntry(machineId, { sessions: next, ...(projects ? { projects: projects.filter(isProject) } : {}), source: "live", syncedAt: Date.now() });
}

/** Follow the connections `machineConnections` holds, and forget machines no longer paired. */
function reconcile() {
  const connections = getMachineConnections();
  for (const [machineId, follower] of [...following]) {
    if (connections.connections[machineId] !== follower.connection) {
      follower.stop();
      following.delete(machineId);
    }
  }
  for (const [machineId, connection] of Object.entries(connections.connections)) {
    if (!following.has(machineId)) following.set(machineId, follow(machineId, connection));
  }
  if (connections.ready && !connections.error) {
    const paired = new Set(connections.machines.map((machine) => machine.machineId));
    for (const machineId of Object.keys(state.machines)) if (!paired.has(machineId)) dropEntry(machineId);
  }
}

let unsubscribe: (() => void) | null = null;

function boot() {
  if (loaded) return;
  loaded = true;
  state = { machines: readSaved() };
  const offConnections = subscribeMachineConnections(reconcile);
  // An unread mark set or cleared by the agents store is saved with the catalog, and rows built from it change.
  const offAgents = subscribeAllCloudAgents(() => {
    if (Object.keys(state.machines).length) {
      scheduleSave();
      // A new snapshot, so hooks that read the catalog build their rows again.
      state = { ...state };
      publish();
    }
  });
  unsubscribe = () => {
    offConnections();
    offAgents();
  };
  reconcile();
}

// ---- rows ------------------------------------------------------------------

function tabRow(tab: RuntimeSession["tabs"][number], session: RuntimeSession, first: boolean, agent: CloudAgentTab | undefined, unread: readonly string[], live: boolean): MachineSessionTab {
  const reported = (agent ? agent.info.status : tab.status) as TabStatus;
  // Only a machine that answers now says a turn is running: a saved "working" may long have ended there.
  // So the row mark, the sidebar's filters, the overview and the badge all read an unreachable machine's turn as idle.
  const status: TabStatus = reported === "in_progress" && !live ? "idle" : reported;
  const title = agent?.info.title ?? tab.title ?? null;
  return {
    tabId: tab.id,
    harness: agent?.info.harness || tab.harness,
    title: cloudTabTitle(title, session.title, first),
    status,
    unread: agent ? agent.unread : unread.includes(tab.id),
    pendingApprovals: agent?.info.pendingPermissions.length ?? 0,
    created: agent?.info.created ?? tab.created,
    lastMessageAt: newestMessageTime(agent?.info.lastMessageAt, tab.lastMessageAt),
    live: agent?.live ?? false,
  };
}

/** A machine's session rows, archived ones included, most recent activity first. Sessions with no project are left out: no key can name them. */
export function buildMachineSessions(machineId: string, entry: MachineCatalogEntry | undefined, agentTabs: readonly CloudAgentTab[]): MachineSessionRow[] {
  if (!entry) return [];
  const agents = new Map<string, CloudAgentTab>();
  for (const tab of agentTabs) agents.set(tab.tabId, tab);
  const rows: MachineSessionRow[] = [];
  for (const session of entry.sessions) {
    if (!session.projectId) continue;
    const live = entry.source === "live";
    const tabs = session.tabs.map((tab, index) => tabRow(tab, session, index === 0, agents.get(tab.id), entry.unread, live));
    rows.push({
      key: machineSessionKey(machineId, session.projectId, session.id),
      machineId,
      projectId: session.projectId,
      sessionId: session.id,
      title: session.title,
      branch: session.branch ?? null,
      worktreeName: session.worktreeName ?? null,
      created: session.created,
      modified: session.modified,
      lastMessageAt: newestMessageTime(session.lastMessageAt, ...tabs.map((tab) => tab.lastMessageAt)),
      hasMessages: session.hasMessages,
      pinned: session.pinned,
      archived: session.archived,
      // Saved, the row status keeps its branch and PR, but not a turn the machine can no longer confirm is running (as `tabRow`).
      rowStatus: live || !session.rowStatus ? session.rowStatus : { ...session.rowStatus, tabs: session.rowStatus.tabs.map((tab) => (tab.status === "in_progress" ? { ...tab, status: "idle" as const, activity: null } : tab)) },
      manualStatus: session.manualStatus,
      tabs,
      activeTab: session.activeTab ?? null,
      source: entry.source,
    });
  }
  // Pinned first, then by messages: the local sidebar's own order.
  const order = (row: MachineSessionRow) => ({ id: row.key, pinned: row.pinned, created: row.created, lastMessageAt: row.lastMessageAt, hasMessages: row.hasMessages });
  return rows.sort((a, b) => compareSidebarSessions(order(a), order(b), "updated"));
}

/** A machine's projects with their sessions, in the machine's own order; archived projects only while they have sessions. */
export function buildMachineProjects(machineId: string, entry: MachineCatalogEntry | undefined, sessions: readonly MachineSessionRow[]): MachineProjectNode[] {
  if (!entry) return [];
  return entry.projects
    .map((project) => ({
      key: machineProjectKey(machineId, project.projectId),
      machineId,
      project,
      sessions: sessions.filter((session) => session.projectId === project.projectId),
    }))
    .filter((node) => !node.project.archived || node.sessions.some((session) => !session.archived));
}

/** Every machine's session rows, outside React (the dock badge, notifications, attention stepping). */
export function allMachineSessions(): MachineSessionRow[] {
  const { machines } = getMachineCatalog();
  return Object.entries(machines).flatMap(([machineId, entry]) => buildMachineSessions(machineId, entry, getCloudAgents(machineAgentScope(machineId)).tabs));
}

/** One machine's projects and session rows, following its catalog entry and agent tabs. */
export function useMachineProjects(machineId: string): { entry: MachineCatalogEntry | undefined; projects: MachineProjectNode[]; sessions: MachineSessionRow[] } {
  const catalog = useMachineCatalog();
  const agents = useCloudAgents(machineAgentScope(machineId));
  const entry = catalog.machines[machineId];
  return useMemo(() => {
    const sessions = buildMachineSessions(machineId, entry, agents.tabs);
    return { entry, projects: buildMachineProjects(machineId, entry, sessions), sessions };
  }, [machineId, entry, agents.tabs]);
}

/** Every machine's session rows, in React. */
export function useAllMachineSessions(): MachineSessionRow[] {
  const catalog = useMachineCatalog();
  // Agent tab changes publish the catalog too (see boot), so the catalog is enough to follow.
  return useMemo(() => allMachineSessions(), [catalog]);
}

/** The status a machine session row's mark shows: the most urgent of its tabs, as a cloud row's. */
export function machineSessionStatus(row: Pick<MachineSessionRow, "tabs">): TabStatus {
  let out: TabStatus = "idle";
  for (const tab of row.tabs) {
    if (tab.status === "waiting" || tab.pendingApprovals > 0) return "waiting";
    if (tab.status === "in_progress") out = "in_progress";
    else if (tab.status === "completed" && tab.unread && out === "idle") out = "completed";
  }
  return out;
}

/** A machine session's row, by key; null when no machine lists it. */
export function findMachineSession(key: string): MachineSessionRow | null {
  const parsed = parseMachineKey(key);
  if (!parsed?.sessionId) return null;
  const entry = getMachineCatalog().machines[parsed.machineId];
  return buildMachineSessions(parsed.machineId, entry, getCloudAgents(machineAgentScope(parsed.machineId)).tabs).find((row) => row.key === key) ?? null;
}

/** The agent tab to show for a machine session: the one its runtime last had in front, else its first. */
export function machineSessionTab(row: Pick<MachineSessionRow, "tabs" | "activeTab">): string | null {
  if (row.activeTab && row.tabs.some((tab) => tab.tabId === row.activeTab)) return row.activeTab;
  return row.tabs[0]?.tabId ?? null;
}

// ---- actions ---------------------------------------------------------------

/** The live client of a machine, or null while it is not connected. */
export function liveMachineClient(machineId: string): WorkspaceRpcClient | null {
  const connection = getMachineConnections().connections[machineId];
  return connection && connection.client.connection.state === "connected" ? connection.client : null;
}

/**
 * Rename, pin or archive a machine session on the machine (`session.update`).
 * The answer and the `session.sessions` that follows update the row. Refused
 * while the machine is not connected.
 */
export async function updateMachineSession(key: string, patch: RuntimeSessionPatch): Promise<void> {
  const parsed = parseMachineKey(key);
  if (!parsed?.sessionId) throw new Error("not a machine session");
  const client = liveMachineClient(parsed.machineId);
  if (!client) throw new Error("The machine is not connected");
  const updated = await client.updateSession(parsed.sessionId, patch);
  const entry = state.machines[parsed.machineId];
  if (entry && isSession(updated)) {
    setEntry(parsed.machineId, { sessions: entry.sessions.map((session) => (session.id === updated.id ? keepMessageTime(updated, session) : session)) });
  }
}

/**
 * Drop sessions the machine has deleted (their worktree was removed with
 * them) from its rows at once, before its `session.sessions` says so.
 */
export function forgetMachineSessions(machineId: string, sessionIds: readonly string[]) {
  const entry = state.machines[machineId];
  if (!entry || !sessionIds.length) return;
  const gone = new Set(sessionIds);
  const sessions = entry.sessions.filter((session) => !gone.has(session.id));
  if (sessions.length !== entry.sessions.length) setEntry(machineId, { sessions });
}

/** Live tabs reported for a machine, applied as the view would (for tests and the demo). */
export function applyMachineTabs(machineId: string, tabs: AgentTabInfo[]) {
  applyLiveTabs(machineAgentScope(machineId), tabs);
}

/** For tests: forget everything followed and saved in memory. */
export function resetMachineCatalogForTests() {
  for (const follower of following.values()) follower.stop();
  following.clear();
  unsubscribe?.();
  unsubscribe = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  state = { machines: {} };
  loaded = false;
  listeners.clear();
}

/** For tests: write what is pending now. */
export function flushMachineCatalogForTests() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  saveNow();
}
