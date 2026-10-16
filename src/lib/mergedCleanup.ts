import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MergedRemoval, MergedRemovalView, MergedRestored, MergedStatus, MergedSwept, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { mergedCleanup as native, type MergedCleanupSettings } from "@/lib/api";
import { isFloatingWindow } from "@/lib/appWindow";
import { getCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";
import { connectedCloudClient } from "@/lib/cloudConnections";
import { forgetCloudSessions, managesOf, refreshCloudSessions } from "@/lib/cloudSessions";
import { forgetWorkspaceSize } from "@/lib/workspaceSizes";
import { cloudWorkspaceKey, isCloudKey, parseCloudWorkspaceKey } from "@/types/target";

/**
 * Removing a workspace by itself once its pull request has merged.
 *
 * The removing is done where the worktree lives: by the backend on this
 * computer (`merged_cleanup.rs`), by the runtime for a cloud workspace
 * (`workspace/2`). Each of them checks, waits out the grace period, removes,
 * deletes the branches and keeps the record. This module only runs their
 * passes on a timer, and holds what the last pass said so that a workspace's
 * row can say why it is still there and a notice can offer Keep or Undo.
 *
 * On this computer the backend reads for itself which projects the setting is
 * on for, so nothing here can make it remove more. A cloud workspace has no
 * settings of this desktop: for it, "on" is that its passes are run at all,
 * which only a manager's connection may do.
 */

/** This computer, among the hosts a pass asks. A cloud workspace's id is its key. */
export const LOCAL_HOST = "local";

/**
 * How often a pass runs when nothing is due sooner. Passes go on while the
 * window is behind others: tidying up after a merge made in the browser is
 * the point. The hosts start a grace period again after 15 minutes without
 * one, so this must stay well under that.
 */
export const SWEEP_MS = 120_000;
/** Returning to the app runs a pass at once unless one ran this recently. */
const RETURN_FLOOR_MS = 20_000;
/** How long a notice stays before it goes by itself. */
const SCHEDULED_NOTICE_MS = 20_000;
/** A removal, or why a workspace stays: more to read. */
const NOTICE_MS = 60_000;

export interface HostedStatus extends MergedStatus {
  hostId: string;
}

export interface MergedNotice {
  id: string;
  hostId: string;
  /** `scheduled` offers to keep the workspace; `removed` offers to undo; `kept` says why a merged one stays. */
  kind: "scheduled" | "removed" | "kept";
  status: HostedStatus;
}

interface State {
  settings: MergedCleanupSettings;
  /** The settings were read from the backend. */
  ready: boolean;
  /** Where each workspace whose pull request merged stands, by host and path. */
  statuses: Record<string, HostedStatus>;
  /** Why a project's pull requests could not be read in the last pass, by host and project path. */
  unreadable: Record<string, string>;
  notices: MergedNotice[];
}

const OFF: MergedCleanupSettings = { enabled: false, projects: {}, deleteConversations: false, graceMinutes: 10 };

let state: State = { settings: OFF, ready: false, statuses: {}, unreadable: {}, notices: [] };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMergedCleanup(): State {
  return useSyncExternalStore(subscribe, getMergedCleanup, getMergedCleanup);
}

export function getMergedCleanup(): State {
  return state;
}

export function statusKey(hostId: string, path: string): string {
  return `${hostId}\n${path}`;
}

/** Whether the setting is on for a project: its own answer, else the default. */
export function mergedCleanupOn(settings: MergedCleanupSettings, key: string): boolean {
  return settings.projects[key] ?? settings.enabled;
}

/** Where the workspace at `path` on a host stands, when its pull request has merged. */
export function useMergedStatus(hostId: string, path: string | null | undefined): HostedStatus | undefined {
  const { statuses } = useMergedCleanup();
  return path ? statuses[statusKey(hostId, path)] : undefined;
}

/** The same for the workspace a session runs in, for a host whose rows are sessions. */
export function useMergedStatusOfSession(hostId: string, sessionId: string): HostedStatus | undefined {
  const { statuses } = useMergedCleanup();
  return Object.values(statuses).find((status) => status.hostId === hostId && status.sessions.includes(sessionId));
}

/** What a workspace's row says: why it stays, or when it goes. */
export function mergedNote(status: MergedStatus, now = Date.now()): string {
  switch (status.phase) {
    case "kept":
      return `kept: ${status.reason ?? "it could not be checked"}`;
    case "held":
      return "kept: your choice";
    case "removed":
      return "removed";
    case "scheduled":
      return `merged: deleting ${mergedDue(status, now)}`;
  }
}

/** When a scheduled workspace goes, as the end of a sentence: "in 8 min", or "shortly". */
export function mergedDue(status: MergedStatus, now = Date.now()): string {
  const left = status.due ? Date.parse(status.due) - now : 0;
  return left > 45_000 ? `in ${Math.ceil(left / 60_000)} min` : "shortly";
}

/** What became of the branches of a removed workspace, in a sentence or two. */
export function branchOutcome(record: MergedRemoval): string {
  const parts: string[] = [];
  if (record.localBranch.outcome === "deleted") parts.push(`The local branch ${record.branch} was deleted.`);
  else if (record.localBranch.outcome === "kept") parts.push(`The local branch ${record.branch} was kept: ${record.localBranch.reason}.`);
  const remote = record.remoteBranch;
  if (remote.outcome === "deleted") parts.push("Its branch on the remote was deleted.");
  else if (remote.outcome === "alreadyGone") parts.push("Its branch on the remote was already gone.");
  else if (remote.outcome === "moved") parts.push(`Its branch on the remote was kept: it has moved to ${remote.at.slice(0, 7)} since the merge.`);
  else parts.push(`Its branch on the remote was kept: ${remote.reason}.`);
  return parts.join(" ");
}

// ---- hosts -------------------------------------------------------------------

/** One place that removes its own merged workspaces. */
interface MergedHost {
  id: string;
  /** This pass only tells the host the setting was turned off; whatever it answers, it has nothing to show. */
  off?: boolean;
  sweep(): Promise<MergedSwept>;
  hold(path: string, held: boolean): Promise<void>;
  records(): Promise<MergedRemovalView[]>;
  restore(id: string): Promise<MergedRestored>;
}

const localHost: MergedHost = {
  id: LOCAL_HOST,
  sweep: () => native.sweep(),
  hold: (path, held) => native.hold(path, held),
  records: () => native.records(),
  restore: (id) => native.restore(id),
};

/** A cloud workspace as the setting sees it. */
export interface CloudMergedTarget {
  /** Its key, which is also what the setting is stored under. */
  key: string;
  orgId: string;
  workspaceId: string;
  name: string;
  /** Why its passes are not run right now; null when they are. */
  unavailable: string | null;
}

function cloudUnavailable(client: WorkspaceRpcClient | null): string | null {
  // A stopped workspace is never woken to tidy it.
  if (!client) return "Runs while the workspace is connected.";
  if (!client.hasCapability("workspace/2")) return "Its runtime is older than this setting. Restart the workspace to update it.";
  if (!managesOf(client)) return "Needs manager access to the workspace.";
  return null;
}

/** The cloud workspaces the setting can be chosen for. */
export function cloudMergedTargets(catalog: CloudCatalogState, clientOf: (key: string) => WorkspaceRpcClient | null = connectedCloudClient): CloudMergedTarget[] {
  return Object.values(catalog.orgs)
    .flatMap((org) => org.workspaces)
    .map((item) => item.workspace)
    .filter((workspace) => workspace.state !== "archived" && workspace.state !== "destroyed")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((workspace) => {
      const key = cloudWorkspaceKey(workspace.orgId, workspace.id);
      return { key, orgId: workspace.orgId, workspaceId: workspace.id, name: workspace.name, unavailable: cloudUnavailable(clientOf(key)) };
    });
}

/** `on: false` is the pass that tells a runtime the setting was turned off: it looks at nothing and forgets what it had seen. */
function cloudHost(key: string, client: WorkspaceRpcClient, on = true): MergedHost {
  return {
    id: key,
    off: !on,
    sweep: () => client.sweepMergedWorkspaces({ ...(on ? {} : { enabled: false }), deleteSessions: state.settings.deleteConversations, graceSeconds: state.settings.graceMinutes * 60 }),
    hold: (path, held) => client.holdMergedWorkspace(path, held),
    records: () => client.removedWorkspaceRecords(),
    restore: (id) => client.restoreRemovedWorkspace(id),
  };
}

function hostOf(hostId: string): MergedHost {
  if (hostId === LOCAL_HOST) return localHost;
  const client = connectedCloudClient(hostId);
  const unavailable = cloudUnavailable(client);
  if (!client || unavailable) throw new Error(unavailable ?? "The workspace is not connected.");
  return cloudHost(hostId, client);
}

function localOn(settings: MergedCleanupSettings): boolean {
  return settings.enabled || Object.entries(settings.projects).some(([key, on]) => on && !isCloudKey(key));
}

/**
 * The hosts the last pass ran on. One that has been turned off since is
 * asked once more, so that it forgets what it had seen: turned on again, a
 * workspace then waits out a grace period of its own.
 */
let wasOn = new Set<string>();

/** The hosts whose passes run now. */
function hostsNow(): MergedHost[] {
  const settings = state.settings;
  const hosts: MergedHost[] = [];
  const on = new Set<string>();
  if (localOn(settings)) on.add(LOCAL_HOST);
  if (on.has(LOCAL_HOST)) hosts.push(localHost);
  else if (wasOn.has(LOCAL_HOST)) hosts.push({ ...localHost, off: true });
  for (const target of cloudMergedTargets(getCloudCatalog())) {
    const client = connectedCloudClient(target.key);
    if (!client || target.unavailable) continue;
    if (mergedCleanupOn(settings, target.key)) {
      on.add(target.key);
      hosts.push(cloudHost(target.key, client));
    } else if (wasOn.has(target.key)) {
      hosts.push(cloudHost(target.key, client, false));
    }
  }
  wasOn = on;
  return hosts;
}

// ---- passes ------------------------------------------------------------------

let flight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastPass = 0;
const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The kept notices this window has shown, by host, path, pull request and reason: each is said once. */
const keptSaid = new Set<string>();

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** The reader is at the app: its window is on screen and has the focus. */
function looking(): boolean {
  return typeof document === "undefined" || (!hidden() && (typeof document.hasFocus !== "function" || document.hasFocus()));
}

/** Run a pass now, or right after the one that is running. Only the main window runs them. */
export function requestMergedSweep(): Promise<void> {
  if (!drives()) return Promise.resolve();
  if (flight) {
    again = true;
    return flight;
  }
  flight = pass()
    .catch(() => undefined)
    .finally(() => {
      flight = null;
      if (again) {
        again = false;
        void requestMergedSweep();
      } else {
        arm();
      }
    });
  return flight;
}

async function pass() {
  lastPass = Date.now();
  const hosts = hostsNow();
  // `null`: the host did not answer, and what was known of it stands.
  const swept = new Map<string, MergedSwept | null>();
  await Promise.all(
    hosts.map(async (host) => {
      try {
        const found = await host.sweep();
        swept.set(host.id, host.off ? { statuses: [], unreadable: [] } : found);
      } catch {
        swept.set(host.id, null);
      }
    }),
  );
  apply(swept);
}

function apply(swept: Map<string, MergedSwept | null>) {
  const before = state.statuses;
  const statuses: Record<string, HostedStatus> = {};
  const unreadable: Record<string, string> = {};
  // A host that was not asked (off, or not reachable as a manager) has nothing to say any more.
  for (const [key, status] of Object.entries(before)) {
    if (swept.get(status.hostId) === null) statuses[key] = status;
  }
  for (const [key, reason] of Object.entries(state.unreadable)) {
    if (swept.get(key.split("\n")[0]) === null) unreadable[key] = reason;
  }
  let notices = state.notices;
  const pushed: MergedNotice[] = [];
  for (const [hostId, found] of swept) {
    if (!found) continue;
    for (const project of found.unreadable) unreadable[statusKey(hostId, project.projectPath)] = project.reason;
    for (const raw of found.statuses) {
      const status: HostedStatus = { ...raw, hostId };
      const key = statusKey(hostId, status.path);
      const was = before[key];
      if (status.phase === "removed") {
        afterRemoval(status);
        if (status.record) pushed.push({ id: status.record.id, hostId, kind: "removed", status });
        continue;
      }
      statuses[key] = status;
      // Said once: when the merge is first seen, or when what kept it is gone.
      if (status.phase === "scheduled" && (status.fresh || (was && was.phase !== "scheduled"))) {
        pushed.push({ id: `scheduled:${key}`, hostId, kind: "scheduled", status });
      }
      // A merge first seen that the pass did not act on: the row alone is easy to miss (#476).
      const said = `${key}\n${status.pr.number}\n${status.reason ?? ""}`;
      if (status.phase === "kept" && status.fresh && !keptSaid.has(said)) {
        keptSaid.add(said);
        pushed.push({ id: `kept:${key}`, hostId, kind: "kept", status });
      }
    }
  }
  // A notice about waiting, or about what keeps it, is moot once that is no longer so.
  notices = notices.filter((notice) => notice.kind === "removed" || statuses[statusKey(notice.hostId, notice.status.path)]?.phase === notice.kind);
  for (const notice of pushed) {
    notices = [...notices.filter((existing) => existing.id !== notice.id), notice];
    expire(notice);
  }
  set({ statuses, unreadable, notices });
}

function afterRemoval(status: HostedStatus) {
  const cloud = parseCloudWorkspaceKey(status.hostId);
  if (!cloud) {
    // The backend has told the session store; only the size that was measured is this window's to forget.
    forgetWorkspaceSize(status.path);
    return;
  }
  const target = { orgId: cloud.orgId, workspaceId: cloud.workspaceId };
  if (status.record?.sessionsDeleted.length) forgetCloudSessions(target, status.record.sessionsDeleted);
  refreshCloud(status.hostId);
}

/** A cloud workspace's sessions moved: read its list again. */
function refreshCloud(hostId: string) {
  const cloud = parseCloudWorkspaceKey(hostId);
  const client = connectedCloudClient(hostId);
  if (cloud && client) void refreshCloudSessions({ orgId: cloud.orgId, workspaceId: cloud.workspaceId }, client).catch(() => undefined);
}

/** A notice goes by itself, but only once the reader has been at the app to see it. */
function expire(notice: MergedNotice) {
  clearTimeout(noticeTimers.get(notice.id));
  noticeTimers.delete(notice.id);
  if (!looking()) return;
  noticeTimers.set(
    notice.id,
    setTimeout(() => dismissMergedNotice(notice.id), notice.kind === "scheduled" ? SCHEDULED_NOTICE_MS : NOTICE_MS),
  );
}

export function dismissMergedNotice(id: string) {
  clearTimeout(noticeTimers.get(id));
  noticeTimers.delete(id);
  if (state.notices.some((notice) => notice.id === id)) set({ notices: state.notices.filter((notice) => notice.id !== id) });
}

/** The next pass: when the first scheduled workspace is due, and no later than the usual interval. */
function arm() {
  clearTimeout(timer);
  timer = undefined;
  const settings = state.settings;
  const anywhere = localOn(settings) || Object.entries(settings.projects).some(([key, on]) => on && isCloudKey(key));
  if (!anywhere || !drives()) return;
  const dues = Object.values(state.statuses)
    .filter((status) => status.phase === "scheduled" && status.due)
    .map((status) => Date.parse(status.due as string))
    .filter((due) => Number.isFinite(due));
  const untilDue = dues.length ? Math.max(Math.min(...dues) - Date.now(), 0) + 1_000 : SWEEP_MS;
  timer = setTimeout(
    () => {
      timer = undefined;
      void requestMergedSweep();
    },
    Math.min(SWEEP_MS, untilDue),
  );
}

/** Back at the app: the notices that waited start counting, and what merged meanwhile is looked at now. */
function onReturn() {
  if (!looking()) return;
  for (const notice of state.notices) if (!noticeTimers.has(notice.id)) expire(notice);
  if (Date.now() - lastPass >= RETURN_FLOOR_MS) void requestMergedSweep();
}

// ---- what the reader does ------------------------------------------------------

/** Keep a workspace that is waiting to be removed, or let it go again. */
export async function holdMergedWorkspace(hostId: string, path: string, held: boolean): Promise<void> {
  await hostOf(hostId).hold(path, held);
  dismissMergedNotice(`scheduled:${statusKey(hostId, path)}`);
  await requestMergedSweep();
}

/** Undo one removal on the host that made it. Its notice is the caller's to close: it may have more to say. */
export async function restoreMergedRemoval(hostId: string, id: string): Promise<MergedRestored> {
  const restored = await hostOf(hostId).restore(id);
  if (hostId !== LOCAL_HOST) refreshCloud(hostId);
  void requestMergedSweep();
  return restored;
}

export interface HostRecords {
  hostId: string;
  /** Null for this computer. */
  name: string | null;
  /** Null when the host could not be asked. */
  records: MergedRemovalView[] | null;
}

/** What was removed, on this computer and on each cloud workspace that can be asked now. */
export async function mergedRecords(): Promise<HostRecords[]> {
  const cloud = cloudMergedTargets(getCloudCatalog()).filter((target) => !target.unavailable);
  const read = async (hostId: string, name: string | null): Promise<HostRecords> => {
    try {
      return { hostId, name, records: await hostOf(hostId).records() };
    } catch {
      return { hostId, name, records: null };
    }
  };
  return Promise.all([read(LOCAL_HOST, null), ...cloud.map((target) => read(target.key, target.name))]);
}

/** Change the setting. The next pass runs at once, so turning it off takes effect now. */
export async function saveMergedCleanupSettings(patch: Parameters<typeof native.setSettings>[0]): Promise<MergedCleanupSettings> {
  const settings = await native.setSettings(patch);
  set({ settings, ready: true });
  void requestMergedSweep();
  return settings;
}

// ---- boot --------------------------------------------------------------------

/** Passes are the main window's to run: two windows would only ask twice. */
function drives(): boolean {
  return !isFloatingWindow();
}

let booted: Promise<void> | null = null;
/** The issue pipelines already seen merged: each asks for one pass, not one for every later word of it. */
const mergedPipelines = new Set<string>();

/** Mirror the setting, and in the main window run the passes. */
export function bootMergedCleanup(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<MergedCleanupSettings>("merged_cleanup_settings", (event) => {
        // This window's own change comes back here too, and has run its pass already.
        if (JSON.stringify(event.payload) === JSON.stringify(state.settings)) return;
        set({ settings: event.payload, ready: true });
        void requestMergedSweep();
      });
      set({ settings: await native.settings(), ready: true });
    } catch {
      return; // outside a webview
    }
    if (!drives()) return;
    // An issue's pipeline merges its own pull request (#433), or sees it merged elsewhere: its workspace is looked at now rather than at the next pass.
    await listen<{ id: string; state: string }>("issue_pipeline", ({ payload }) => {
      if (payload.state !== "merged" || mergedPipelines.has(payload.id)) return;
      mergedPipelines.add(payload.id);
      void requestMergedSweep();
    }).catch(() => undefined);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onReturn);
      document.addEventListener("visibilitychange", onReturn);
    }
    void requestMergedSweep();
  })());
}

/** Tests only: start from nothing. */
export function resetMergedCleanupForTest() {
  clearTimeout(timer);
  timer = undefined;
  for (const pending of noticeTimers.values()) clearTimeout(pending);
  noticeTimers.clear();
  keptSaid.clear();
  if (typeof window !== "undefined") {
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
  }
  flight = null;
  again = false;
  lastPass = 0;
  wasOn = new Set();
  mergedPipelines.clear();
  booted = null;
  state = { settings: OFF, ready: false, statuses: {}, unreadable: {}, notices: [] };
}
