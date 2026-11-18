import { useSyncExternalStore } from "react";
import type { DashboardSession, DashboardTab, DashboardTabStatus } from "@terminalx/portable/dashboard";
import type { MessageActivity } from "@/lib/messageActivity";
import { getCloudAgents, type CloudAgentTab } from "@/lib/cloudAgents";
import { buildMachineSessions, getMachineCatalog, machineAgentScope, subscribeMachineCatalog, type MachineCatalogState } from "@/lib/machineCatalog";
import { getMachineConnections, subscribeMachineConnections } from "@/lib/machineConnections";
import { selectCloudSession } from "@/lib/sessions";
import { machineProjectKey, type MachineKey } from "@/types/target";
import type { MachineConnectionState, PairedMachine } from "@/types/machines";

/**
 * Sessions on paired machines as the overview, the dock badge, notifications
 * and attention stepping see them (PRO-346, docs/MACHINES.md decision 8):
 * every session the machine catalog knows of each paired machine, projected
 * into `DashboardSession` so the same columns, counts and search work for
 * local, cloud and machine sessions alike.
 *
 * Built only from what is already known: the catalog (live while a machine is
 * connected, else what was saved) and the agent tabs kept for each machine.
 *
 * - Connected: the live tab states decide.
 * - Not connected: a saved wait (a pending approval) still stands, a saved
 *   "working" is not believed, and a finished turn counts while it is unread.
 *
 * With no machine paired there is nothing here, and nothing is followed until
 * a reader subscribes.
 */

export interface MachineDashboardTab extends DashboardTab {
  tabId: string;
  title: string | null;
  /** The runtime's pending permission requests on this tab. */
  pendingApprovals: number;
  /** The status came from the connected machine, not the saved catalog. */
  live: boolean;
}

export interface MachineDashboardSession extends DashboardSession, MessageActivity {
  kind: "machine";
  /** `machine:<machineId>:<projectId>:<sessionId>`; also `id`. */
  key: MachineKey;
  machineId: string;
  machineName: string;
  projectId: string;
  /** `machine:<machineId>:<projectId>`; also `projectPath`. */
  projectKey: MachineKey;
  projectName: string;
  sessionId: string;
  created: string;
  pinned: boolean;
  rowStatus?: import("@terminalx/portable/sessionStatus").SessionStatusInput;
  manualStatus?: import("@/types/session").ManualStatus;
  /** The machine answered over a live connection; else this is what was saved. */
  connected: boolean;
  tabs: MachineDashboardTab[];
}

export function isMachineDashboardSession(session: object): session is MachineDashboardSession {
  return (session as { kind?: string }).kind === "machine";
}

/** A machine is connected when its route is up: direct or through the relay. */
export function machineConnected(state: MachineConnectionState | undefined): boolean {
  return state?.state === "direct" || state?.state === "relay";
}

export interface MachineProjectionInput {
  /** The paired machines, in their order; sessions of any other machine are left out. */
  machines: readonly PairedMachine[];
  catalog: MachineCatalogState;
  agentTabs: (machineId: string) => readonly CloudAgentTab[];
  includeArchived?: boolean;
}

/** Every session of every paired machine, archived ones only when asked. Pure. */
export function projectMachineSessions(input: MachineProjectionInput): MachineDashboardSession[] {
  const out: MachineDashboardSession[] = [];
  for (const machine of input.machines) {
    const entry = input.catalog.machines[machine.machineId];
    if (!entry) continue;
    const projects = new Map(entry.projects.map((project) => [project.projectId, project.name]));
    for (const row of buildMachineSessions(machine.machineId, entry, input.agentTabs(machine.machineId))) {
      if (row.archived && !input.includeArchived) continue;
      const live = row.source === "live";
      const projectName = projects.get(row.projectId) ?? row.projectId;
      const tabs = row.tabs.map((tab): MachineDashboardTab => {
        let status: DashboardTabStatus = tab.status === "completed" && tab.unread ? "completed" : "idle";
        // A saved wait stands: the approval is still asked for on the machine until it is answered there.
        if (tab.status === "waiting" || tab.pendingApprovals > 0) status = "waiting";
        // A saved "working" may have finished long ago: only the connected machine says it works.
        else if (tab.status === "in_progress" && live) status = "in_progress";
        return {
          tabId: tab.tabId,
          harness: tab.harness,
          title: tab.title,
          status,
          lastMessageAt: tab.lastMessageAt ?? null,
          pendingApprovals: tab.pendingApprovals,
          live,
        };
      });
      out.push({
        kind: "machine",
        id: row.key,
        key: row.key,
        machineId: machine.machineId,
        machineName: machine.name,
        projectId: row.projectId,
        projectKey: machineProjectKey(machine.machineId, row.projectId),
        projectPath: machineProjectKey(machine.machineId, row.projectId),
        projectName,
        sessionId: row.sessionId,
        // Never a path on this Mac: the project's name stands in for the folder.
        cwd: projectName,
        worktreeName: row.worktreeName,
        branch: row.branch,
        title: row.title,
        modified: row.modified,
        created: row.created,
        lastMessageAt: row.lastMessageAt,
        hasMessages: row.hasMessages,
        pinned: row.pinned,
        archived: row.archived,
        rowStatus: live ? row.rowStatus : undefined,
        manualStatus: row.manualStatus,
        ownerId: null,
        connected: live,
        tabs,
      });
    }
  }
  return out;
}

/** The mark a machine session shows: the most urgent of its tabs. */
export function machineSessionMark(session: Pick<MachineDashboardSession, "tabs">): DashboardTabStatus {
  if (session.tabs.some((tab) => tab.status === "waiting")) return "waiting";
  if (session.tabs.some((tab) => tab.status === "in_progress")) return "in_progress";
  if (session.tabs.some((tab) => tab.status === "completed")) return "completed";
  return "idle";
}

/** The tab a machine session's notice is about: the one waiting, else the one working, else the finished one, else the first. */
export function machineAttentionTab(session: MachineDashboardSession): MachineDashboardTab | undefined {
  return session.tabs.find((tab) => tab.status === "waiting") ?? session.tabs.find((tab) => tab.status === "in_progress") ?? session.tabs.find((tab) => tab.status === "completed") ?? session.tabs[0];
}

/** Open a machine session from the overview, a notice or a shortcut: AppShell shows it in its machine's view. */
export function openMachineSession(key: string) {
  selectCloudSession(key);
}

// ---- the store -------------------------------------------------------------

const EMPTY: MachineDashboardSession[] = [];
let snapshot: MachineDashboardSession[] = EMPTY;
let allSessions: MachineDashboardSession[] = EMPTY;
let signature = "[]";
let dirty = true;
let scheduled = false;
let unsubscribers: (() => void)[] = [];
const listeners = new Set<() => void>();

function publish() {
  for (const listener of [...listeners]) listener();
}

function recompute(): MachineDashboardSession[] {
  return projectMachineSessions({
    includeArchived: true,
    machines: getMachineConnections().machines,
    catalog: getMachineCatalog(),
    agentTabs: (machineId) => getCloudAgents(machineAgentScope(machineId)).tabs,
  });
}

function take(next: MachineDashboardSession[]): boolean {
  const nextSignature = JSON.stringify(next);
  if (nextSignature === signature) return false;
  signature = nextSignature;
  allSessions = next.length ? next : EMPTY;
  snapshot = next.length ? next.filter((session) => !session.archived) : EMPTY;
  return true;
}

function refresh() {
  scheduled = false;
  dirty = false;
  if (take(recompute())) publish();
}

function invalidate() {
  dirty = true;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(refresh);
}

/** Follow the catalog (which also changes with the machines' agent tabs) and the paired machines, once something reads. */
function start() {
  if (unsubscribers.length) return;
  unsubscribers = [subscribeMachineCatalog(invalidate), subscribeMachineConnections(invalidate)];
}

/** Every non-archived machine session, now; none while no machine is paired. */
export function getMachineDashboard(): MachineDashboardSession[] {
  start();
  if (dirty && !scheduled) {
    dirty = false;
    take(recompute());
  }
  return snapshot;
}

function getAllMachineDashboard(): MachineDashboardSession[] {
  getMachineDashboard();
  return allSessions;
}

export function subscribeMachineDashboard(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMachineDashboard(includeArchived = false): MachineDashboardSession[] {
  const get = includeArchived ? getAllMachineDashboard : getMachineDashboard;
  return useSyncExternalStore(subscribeMachineDashboard, get, get);
}

/** For tests: forget everything and stop following. */
export function resetMachineDashboardForTests() {
  for (const stop of unsubscribers) stop();
  unsubscribers = [];
  listeners.clear();
  snapshot = EMPTY;
  allSessions = EMPTY;
  signature = "[]";
  dirty = true;
  scheduled = false;
}

// ---- attention: which waits and finishes to raise --------------------------

export interface MachineAttention {
  kind: "waiting" | "done";
  session: MachineDashboardSession;
  tab: MachineDashboardTab;
}

/**
 * Decide which machine waits and finishes deserve a notice, once each. Only a
 * change seen on a connected machine raises: a tab that starts waiting (or
 * appears waiting), or a working tab that finishes unread. A machine's first
 * connected pass, at launch or after a reconnect, is taken as known, so a wait
 * already showing from the save, or one that began while it was away, is not
 * raised then; its row and the dock badge still show it.
 */
export function createMachineAttentionTracker() {
  const lastStatus = new Map<string, DashboardTabStatus>();
  /** Machines seen connected on the previous pass. */
  let connected = new Set<string>();

  return function observe(sessions: readonly MachineDashboardSession[]): MachineAttention[] {
    const out: MachineAttention[] = [];
    const seenTabs = new Set<string>();
    const nowConnected = new Set<string>();
    for (const session of sessions) {
      if (session.connected) nowConnected.add(session.machineId);
      const settled = session.connected && connected.has(session.machineId);
      for (const tab of session.tabs) {
        const tabKey = `${session.key}/${tab.tabId}`;
        seenTabs.add(tabKey);
        const previous = lastStatus.get(tabKey);
        lastStatus.set(tabKey, tab.status);
        if (!settled || session.archived) continue;
        if (tab.status === "waiting" && previous !== "waiting") out.push({ kind: "waiting", session, tab });
        else if (tab.status === "completed" && previous === "in_progress") out.push({ kind: "done", session, tab });
      }
    }
    for (const tabKey of [...lastStatus.keys()]) if (!seenTabs.has(tabKey)) lastStatus.delete(tabKey);
    connected = nowConnected;
    // One notice per session and pass: several of its tabs starting to wait together are one thing to look at.
    const raised = new Set<string>();
    return out.filter((event) => {
      if (event.kind === "done") return true;
      if (raised.has(event.session.key)) return false;
      raised.add(event.session.key);
      return true;
    });
  };
}
