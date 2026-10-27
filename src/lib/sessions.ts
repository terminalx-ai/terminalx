import { keepMessageTime } from "@/lib/messageActivity";
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, workStatus, type WorkspaceRemoveOptions } from "@/lib/api";
import { getPrefs } from "@/lib/prefs";
import { getAccount } from "@/lib/account";
import { cloudKeyOrgId, mayStartCloudSessions } from "@/lib/multiOrg";
import { closeSessionShells, dropSessionTerminals, dropTabTerminals, setArchivedTerminalSessions, setSelectedAgent } from "@/lib/terminal";
import { buildPaletteIndex, type PaletteIndex } from "@/lib/commandPalette";
import { bootTabLayouts } from "@/lib/tabLayouts";
import { isFloatingWindow } from "@/lib/appWindow";
import type { NewQuickChat, OpenTarget } from "@/lib/api";
import type {
  ProjectPatch,
  Workspace, HarnessInfo, IssueRef, Project, SessionEntry, TabEntry } from "@/types/session";

/**
 * The index of sessions and projects, mirrored from ~/.raccoon and kept in a
 * module store so every component reads one copy. Mutations go through the
 * backend first and the store second; the backend is the source of truth.
 */
interface State {
  loaded: boolean;
  projects: Project[];
  lastProject: string | null;
  sessions: SessionEntry[];
  harnesses: HarnessInfo[];
  /** The folder New chat runs in; its sessions are chats, listed apart from projects. */
  chatsPath: string | null;
  selectedSessionId: string | null;
  /** The workspace whose last tab closed, available to Reopen while at welcome. */
  closedWorkspaceSessionId: string | null;
  /** Explicit navigation also reveals a destination that was collapsed. */
  navigationVersion: number;
  /** What the workspace shows when no session is selected. */
  view: "welcome" | "new" | "issues" | "agents" | "automations" | "skills" | "stats" | "project";
  /** The issues browser opens its new-issue form when it next shows; it sets this back. */
  newIssueRequested: boolean;
  /** A cross-workspace navigation request can open one automation directly. */
  selectedAutomationId: string | null;
  /** A tab menu can open Skills already narrowed to that tab's reach. */
  skillsFilter: { agent: string; projectPath: string } | null;
  showArchived: boolean;
  /** Which project the sidebar is focused on (its workspaces and sessions). */
  selectedProject: string | null;
  /** Workspaces per project path, refreshed on demand. */
  workspaces: Record<string, Workspace[]>;
  workspacesLoading: Record<string, boolean>;
  /**
   * A cloud workspace shown in the main slot (`cloud:<orgId>:<workspaceId>`),
   * with the sidebar kept. Any other navigation clears it.
   */
  selectedCloudWorkspace: string | null;
  /**
   * The session the new-session form was opened over: it stays drawn behind
   * the form, which is a dialog, and closing the form goes back to it.
   */
  newSessionReturn: { sessionId: string | null; view: State["view"] } | null;
  /** A new-session form pre-filled from a workspace row. */
  newSessionPreset: { projectPath: string; cwd: string | null } | null;
  /**
   * A new-session form for a cloud project (`cloud:<orgId>:<identity>`),
   * from the project row's `+`. Cleared by the same navigation that clears
   * `newSessionPreset`, and by any local preset.
   */
  cloudSessionPreset: { projectKey: string } | null;
  /** The cloud project the reader last clicked (`cloud:<orgId>:<identity>`); any local project focus clears it. */
  selectedCloudProject: string | null;
  /** Pre-normalized command-palette documents, rebuilt only when source data changes. */
  paletteIndex: PaletteIndex;
}

let state: State = {
  loaded: false,
  projects: [],
  lastProject: null,
  sessions: [],
  harnesses: [],
  chatsPath: null,
  selectedSessionId: null,
  closedWorkspaceSessionId: null,
  navigationVersion: 0,
  view: "welcome",
  newIssueRequested: false,
  selectedAutomationId: null,
  skillsFilter: null,
  showArchived: false,
  selectedProject: null,
  workspaces: {},
  workspacesLoading: {},
  selectedCloudWorkspace: null,
  newSessionReturn: null,
  newSessionPreset: null,
  cloudSessionPreset: null,
  selectedCloudProject: null,
  paletteIndex: buildPaletteIndex([], [], {}, []),
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  const next = { ...state, ...patch };
  // Background deletion/archival must not replace another destination or an explicit draft.
  const previous = state.sessions.find((session) => session.id === state.selectedSessionId);
  if (patch.sessions && previous && !("selectedSessionId" in patch)) {
    const selected = patch.sessions.find((session) => session.id === previous.id);
    if (!selected || (!previous.archived && selected.archived)) {
      next.selectedSessionId = null;
      next.view = "welcome";
    }
  }
  if ((patch.view && patch.view !== "welcome") || patch.selectedSessionId || patch.selectedCloudWorkspace) next.closedWorkspaceSessionId = null;
  if (patch.sessions && next.closedWorkspaceSessionId && !patch.sessions.some((session) => session.id === next.closedWorkspaceSessionId && !session.archived && !session.worktreeRemoved)) next.closedWorkspaceSessionId = null;
  // Clear the draft destination when navigating away, not in React cleanup
  // (Strict Mode also runs cleanup when a workspace first mounts).
  if ((patch.view && patch.view !== "new") || patch.selectedSessionId) next.newSessionPreset = null;
  // Opened from a session, the form remembers it; any other way out forgets it.
  // Only an explicit "New session" (`openNewSession`, a project's or branch's +) records where to go back to; any way out forgets it.
  if (next.view !== "new" || next.selectedSessionId) next.newSessionReturn = null;
  // A cloud draft goes the same way, and gives way to any local one.
  if ((patch.view && patch.view !== "new") || patch.selectedSessionId || ("newSessionPreset" in patch && !("cloudSessionPreset" in patch))) next.cloudSessionPreset = null;
  if ("selectedProject" in patch && !("selectedCloudProject" in patch)) next.selectedCloudProject = null;
  // Selecting a session or another view leaves the cloud workspace.
  if (!("selectedCloudWorkspace" in patch) && ("selectedSessionId" in patch || "view" in patch)) next.selectedCloudWorkspace = null;
  if (
    next.projects !== state.projects ||
    next.sessions !== state.sessions ||
    next.workspaces !== state.workspaces ||
    next.harnesses !== state.harnesses
  ) {
    next.paletteIndex = buildPaletteIndex(next.sessions, next.projects, next.workspaces, next.harnesses);
  }
  state = next;
  if (patch.sessions) setArchivedTerminalSessions(patch.sessions.filter((session) => session.archived).map((session) => session.id));
  for (const l of listeners) l();
}

export function useSessionStore(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function getSessionStore() {
  return state;
}

/** Told after every change, outside React. */
export function subscribeSessionStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let booted = false;
const workspaceRefreshVersions = new Map<string, number>();
export async function bootSessions() {
  if (booted) return;
  booted = true;
  // Backfill can publish while the first list is being read. Subscribe first,
  // retaining only chronology until initialization supplies the session rows.
  const initialMessageTimes = new Map<string, Pick<SessionEntry, "lastMessageAt">>();
  try {
    await listen<SessionEntry>("session_updated", (e) => {
      if (state.loaded) upsertSession(e.payload);
      else initialMessageTimes.set(e.payload.id, keepMessageTime(
        { lastMessageAt: e.payload.lastMessageAt }, initialMessageTimes.get(e.payload.id),
      ));
    });
  } catch {
    /* outside a webview */
  }
  // Projects and sessions are two file reads; the harness probe may shell out
  // to a login shell and take seconds, so it lands on its own.
  // How the tabs are arranged is read alongside the sessions and not waited for: a window must never
  // fail to list its sessions over it. Until it lands, tabs are in the order they were opened.
  void bootTabLayouts();
  const [projects, sessions] = await Promise.all([api.listProjects(), api.listSessions()]);
  set({ loaded: true, projects: projects.projects, lastProject: projects.lastSelected,
    sessions: sessions.map((session) => keepMessageTime(session, initialMessageTimes.get(session.id))),
  });
  initialMessageTimes.clear();
  void api.listHarnesses().then((harnesses) => set({ harnesses })).catch(() => {});
  void api.chatsDir().then((chatsPath) => set({ chatsPath })).catch(() => {});
  try {
    await listen<SessionEntry>("session_created", (e) => upsertSession(e.payload));
    await listen<string>("session_deleted", (e) => removeSessions([e.payload]));
    await listen<string>("workspaces_changed", (e) => void refreshWorkspaces(e.payload));
    // Another window added, removed or edited a project.
    await listen("projects_changed", () => void refreshProjects());
    // The floating window hands a session over ("Open in main window").
    if (!isFloatingWindow()) await listen<OpenTarget>("open_session", (e) => openTarget(e.payload));
  } catch {
    /* outside a webview */
  }
}

export async function refreshSessions() {
  const incoming = await api.listSessions();
  const before = state.sessions;
  const sessions = incoming.map((session) => keepMessageTime(session, before.find((old) => old.id === session.id)));
  set({ sessions });
  // The list was replaced wholesale: what is no longer in it has no row to be closed from.
  const kept = new Map(sessions.map((session) => [session.id, session]));
  const gone = before.filter((session) => !kept.has(session.id)).map((session) => session.id);
  const closed = before.flatMap((session) => {
    const now = kept.get(session.id);
    return now ? session.tabs.filter((tab) => !now.tabs.some((other) => other.id === tab.id)).map((tab) => tab.id) : [];
  });
  if (gone.length || closed.length) {
    queueMicrotask(() => {
      dropSessionTerminals(gone);
      dropTabTerminals(closed);
    });
  }
}

export function upsertSession(s: SessionEntry) {
  const i = state.sessions.findIndex((x) => x.id === s.id);
  s = keepMessageTime(s, state.sessions[i]);
  // Its checkout was just removed: a shell left running there has no directory.
  if (s.worktreeRemoved && i >= 0 && !state.sessions[i].worktreeRemoved) void closeSessionShells(s.id);
  const sessions = i >= 0 ? state.sessions.map((x) => (x.id === s.id ? s : x)) : [...state.sessions, s];
  const closed = i >= 0 ? state.sessions[i].tabs.filter((tab) => !s.tabs.some((kept) => kept.id === tab.id)).map((tab) => tab.id) : [];
  set({ sessions });
  // After the list changed, so no view of a closed tab is left to ask for its terminal again.
  if (closed.length) queueMicrotask(() => dropTabTerminals(closed));
  // A quick chat has no project, so there are no workspaces to catch up on.
  if (s.kind === "quick") return;
  // A session that just cut its own worktree is ahead of the cached workspace
  // list, and the sidebar files an unknown cwd under "missing". Every creation
  // path lands here, so the catch-up belongs here rather than in each caller.
  const known = state.workspaces[s.projectPath] ?? [];
  const stale = !s.worktreeRemoved && !known.some((w) => w.path === s.cwd);
  if (stale && !state.workspacesLoading[s.projectPath]) void refreshWorkspaces(s.projectPath);
  // A chat that followed its agent into a repo the app had not seen: the
  // backend registered it as a project, so the list catches up.
  const linked = s.link?.path;
  if (linked && !state.projects.some((project) => project.path === linked)) {
    void api.listProjects().then((projects) => set({ projects: projects.projects })).catch(() => {});
    if (!state.workspacesLoading[linked]) void refreshWorkspaces(linked);
  }
}

/** Forget sessions the backend has deleted, dropping the selection if it was one of them. */
export function removeSessions(ids: string[]) {
  dropSessionTerminals(ids);
  const gone = new Set(ids);
  const selectedGone = !!state.selectedSessionId && gone.has(state.selectedSessionId);
  if (!selectedGone && !state.sessions.some((s) => gone.has(s.id))) return;
  set({
    sessions: state.sessions.filter((s) => !gone.has(s.id)),
    ...(selectedGone ? { selectedSessionId: null, view: "welcome" as const } : {}),
  });
}

export function patchSession(id: string, patch: Partial<SessionEntry>) {
  set({ sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}

export function patchTab(sessionId: string, tabId: string, patch: Partial<TabEntry>) {
  set({
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) } : s,
    ),
  });
}

function focusProject(path: string | null, patch: Partial<State> = {}) {
  set({ ...patch, selectedProject: path });
  if (path) void refreshWorkspaces(path);
}

/** Return to the resting screen without requesting a new session. */
export function openWelcome(closedWorkspaceSessionId: string | null = null) {
  set({ selectedSessionId: null, view: "welcome", selectedAutomationId: null, closedWorkspaceSessionId });
}

export function selectSession(id: string | null) {
  const selected = id ? state.sessions.find((session) => session.id === id) : null;
  const patch: Partial<State> = { selectedSessionId: id, view: id ? "welcome" : "new", newSessionPreset: null, navigationVersion: state.navigationVersion + 1, selectedAutomationId: null };
  // A quick chat has no project to focus: the one in focus stays as it is.
  if (selected && selected.kind !== "quick") focusProject(selected.projectPath, patch);
  else set(patch);
}

/** Show a session another window asked for, on the tab it named. */
export function openTarget(target: OpenTarget) {
  if (!state.sessions.some((session) => session.id === target.sessionId)) return;
  selectSession(target.sessionId);
  if (target.tabId) setSelectedAgent(target.sessionId, target.tabId);
}

async function refreshProjects() {
  try {
    const projects = await api.listProjects();
    set({ projects: projects.projects });
  } catch {
    /* keep what is listed; the next change tries again */
  }
}

/**
 * Select a cloud session by its key, `cloud:<orgId>:<workspaceId>:<sessionId>`
 * (PRO-23). Selecting only renders it: nothing here attaches, resumes or
 * wakes the workspace. Local project focus is left as it is.
 */
export function selectCloudSession(key: string) {
  set({ selectedSessionId: key, view: "welcome", newSessionPreset: null, navigationVersion: state.navigationVersion + 1, selectedAutomationId: null });
}

/** The issues browser takes the workspace; no session stays selected. */
export function openIssues() {
  set({ selectedSessionId: null, view: "issues", selectedAutomationId: null });
}

/** The issues browser with its new-issue form open (the command palette's "New issue…"). */
export function openNewIssue() {
  set({ selectedSessionId: null, view: "issues", selectedAutomationId: null, newIssueRequested: true });
}

/** The issues browser has opened the form it was asked for. */
export function takeNewIssueRequest() {
  if (state.newIssueRequested) set({ newIssueRequested: false });
}

/** A project's overview page: its branches, contributors and latest work, from its name in the sidebar. */
export function openProjectOverview(path: string) {
  focusProject(path, { selectedSessionId: null, view: "project", selectedAutomationId: null, lastProject: path, navigationVersion: state.navigationVersion + 1 });
}

/** The agent dashboard, like the issues browser, replaces the whole workspace. */
export function openAgents() {
  set({ selectedSessionId: null, view: "agents", selectedAutomationId: null });
}

/** Local app activity and transcript-backed token analytics. */
export function openStats() {
  set({ selectedSessionId: null, view: "stats", selectedAutomationId: null });
}

/** Saved agent runs share the full workspace with issues and the dashboard. */
export function openAutomations() {
  set({ selectedSessionId: null, view: "automations", selectedAutomationId: null });
}

/** Open a saved automation after creating it from another workspace. */
export function openAutomation(id: string) {
  set({ selectedSessionId: null, view: "automations", selectedAutomationId: id });
}

/** The filesystem-backed skills reader, optionally scoped to one agent tab. */
export function openSkills(filter: State["skillsFilter"] = null) {
  set({ selectedSessionId: null, view: "skills", skillsFilter: filter, selectedAutomationId: null });
}

/**
 * Show a cloud workspace in the main slot. Selecting only looks: it never
 * resumes the workspace (the view connects with `connect`, never `wake`).
 */
export function selectCloudWorkspace(key: string | null) {
  set({ selectedCloudWorkspace: key, selectedSessionId: null, view: "welcome", newSessionPreset: null, selectedAutomationId: null });
}

/** Open the new-session form for a cloud project, as the project row's `+` does. */
export function startCloudSessionIn(projectKey: string) {
  // Every way into the cloud new-session form passes here. A member (or an
  // account whose role is not known yet) only focuses the project: the form
  // could end in nothing but a refusal.
  if (mayStartCloudSessions(getAccount().status, cloudKeyOrgId(projectKey)) !== true) {
    set({ selectedCloudProject: projectKey, navigationVersion: state.navigationVersion + 1 });
    return;
  }
  set({
    newSessionReturn: returnHere(),
    selectedCloudProject: projectKey,
    selectedSessionId: null,
    view: "new",
    newSessionPreset: null,
    cloudSessionPreset: { projectKey },
    navigationVersion: state.navigationVersion + 1,
    selectedAutomationId: null,
  });
}

export function selectProjectInSidebar(path: string | null) {
  focusProject(path, { navigationVersion: state.navigationVersion + 1, ...(!state.selectedSessionId && state.view === "new" ? { newSessionPreset: null } : {}) });
}

/** Open the new-session form for a project, optionally inside one of its workspaces. */
export function startSessionIn(projectPath: string, cwd: string | null) {
  focusProject(projectPath, { newSessionReturn: returnHere(), selectedSessionId: null, view: "new", newSessionPreset: { projectPath, cwd }, lastProject: projectPath, navigationVersion: state.navigationVersion + 1, selectedAutomationId: null });
}

const openingWorkspaces = new Map<string, Promise<SessionEntry>>();

/** Open a checkout without starting an agent, reusing its open session. */
export function openWorkspace(projectPath: string, cwd: string): Promise<SessionEntry> {
  const pathKey = cwd.replace(/\/+$/, "");
  const existing = state.sessions.find(
    (s) =>
      s.projectPath === projectPath &&
      !s.archived &&
      !s.worktreeRemoved &&
      !s.tabs.length &&
      s.cwd.replace(/\/+$/, "") === pathKey,
  );
  if (existing) {
    selectSession(existing.id);
    return Promise.resolve(existing);
  }

  const key = `${projectPath}\0${pathKey}`;
  const pending = openingWorkspaces.get(key);
  if (pending) return pending;
  const request = api
    .createSession({ projectPath, cwd, useWorktree: false })
    .then((session) => {
      upsertSession(session);
      selectSession(session.id);
      return session;
    })
    .finally(() => openingWorkspaces.delete(key));
  openingWorkspaces.set(key, request);
  return request;
}

/** Where the new-session dialog goes back to when it is opened from here; kept when it is already open. */
function returnHere(): State["newSessionReturn"] {
  if (state.view === "new" && !state.selectedSessionId) return state.newSessionReturn;
  return state.loaded ? { sessionId: state.selectedSessionId, view: state.view } : null;
}

/** "New session" (⌘N, the + buttons): the form, as a dialog over what is shown now. */
export function openNewSession() {
  const back = returnHere();
  selectSession(null);
  set({ newSessionReturn: back });
}

/** Close the new-session dialog: back to the session or view it was opened over. */
export function closeNewSession() {
  const back = state.newSessionReturn;
  if (back?.sessionId && state.sessions.some((session) => session.id === back.sessionId)) return selectSession(back.sessionId);
  set({ view: back && back.view !== "new" ? back.view : "welcome", navigationVersion: state.navigationVersion + 1 });
}

export function clearNewSessionPreset() {
  if (state.newSessionPreset) set({ newSessionPreset: null });
}

export async function refreshWorkspaces(projectPath: string) {
  const version = (workspaceRefreshVersions.get(projectPath) ?? 0) + 1;
  workspaceRefreshVersions.set(projectPath, version);
  set({ workspacesLoading: { ...state.workspacesLoading, [projectPath]: true } });
  try {
    const list = await api.listWorkspaces(projectPath);
    if (workspaceRefreshVersions.get(projectPath) === version) {
      set({ workspaces: { ...state.workspaces, [projectPath]: list } });
    }
  } catch {
    /* not a repo, or gone; keep whatever was known */
  } finally {
    if (workspaceRefreshVersions.get(projectPath) === version) {
      set({ workspacesLoading: { ...state.workspacesLoading, [projectPath]: false } });
    }
  }
}

export async function renameWorkspace(projectPath: string, path: string, name: string) {
  const renamed = await api.renameWorkspace(projectPath, path, name);
  if (state.newSessionPreset?.projectPath === projectPath && state.newSessionPreset.cwd === path) {
    set({ newSessionPreset: { projectPath, cwd: renamed.path } });
  }
  for (const session of renamed.sessions) upsertSession(session);
  await refreshWorkspaces(projectPath);
  return renamed;
}

/** The global refresh: projects, sessions and every project's workspaces. */
export async function refreshEverything() {
  const [projects, sessions] = await Promise.all([api.listProjects(), api.listSessions()]);
  set({ projects: projects.projects, sessions });
  await Promise.all(projects.projects.map((p) => refreshWorkspaces(p.path)));
}

export async function updateProject(path: string, patch: ProjectPatch) {
  const p = await api.updateProject(path, patch);
  set({ projects: state.projects.map((x) => (x.path === path ? p : x)) });
  return p;
}

export async function setProjectLogo(path: string, source: string | null) {
  const p = await api.setProjectLogo(path, source);
  set({ projects: state.projects.map((x) => (x.path === path ? p : x)) });
  return p;
}

/**
 * Remove a workspace. Deleting it removes the sessions that ran in it;
 * settling (`keepSessions`) keeps them and moves them to the project.
 */
export async function removeWorkspace(projectPath: string, path: string, options: WorkspaceRemoveOptions) {
  const report = await api.removeWorkspace(projectPath, path, options);
  if (state.newSessionPreset?.projectPath === projectPath && state.newSessionPreset.cwd === path) {
    set({ newSessionPreset: { projectPath, cwd: projectPath } });
  }
  if (options.keepSessions) for (const session of report.sessions) upsertSession(session);
  else removeSessions(report.sessions.map((s) => s.id));
  await refreshWorkspaces(projectPath);
  return report;
}

export async function refreshHarnesses() {
  const harnesses = await api.listHarnesses();
  set({ harnesses });
}

export function getSessions(): State {
  return state;
}

export function subscribeSessions(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function debug(message: string) {
  void invoke("frontend_log", { level: "info", message }).catch(() => {});
}

export function setShowArchived(v: boolean) {
  set({ showArchived: v });
}

export async function addProject(path: string) {
  const p = await api.addProject(path);
  const exists = state.projects.some((x) => x.path === p.path);
  set({ projects: exists ? state.projects.map((existing) => existing.path === p.path ? p : existing) : [...state.projects, p], lastProject: p.path });
  return p;
}

/**
 * The sidebar's New chat: an agent conversation in the store's Chats folder,
 * so talking to a model needs no project. The folder is a plain directory, so
 * the session runs in place with no worktree, and it is never added as a
 * project: the sidebar lists its sessions on their own.
 */
export async function startChat(place?: { projectPath: string; cwd?: string; fromBranch?: string }): Promise<SessionEntry> {
  const harness = state.harnesses.find((item) => item.id === "claude" && item.available) ?? state.harnesses.find((item) => item.available);
  if (!harness) throw new Error("Install and sign in to an agent to start a chat.");
  // Without a place, a chat of its own; with one, another session in that
  // checkout, on its branch, or in a new workspace branched from `fromBranch`.
  const chatsPath = place ? null : (state.chatsPath ?? (await api.chatsDir()));
  if (chatsPath && chatsPath !== state.chatsPath) set({ chatsPath });
  const prefs = getPrefs();
  const session = await api.createSession({
    projectPath: place?.projectPath ?? chatsPath!,
    cwd: place?.fromBranch ? null : (place?.cwd ?? chatsPath!),
    title: "Chat",
    useWorktree: !!place?.fromBranch,
    baseRef: place?.fromBranch ?? null,
    // The workspace is named after the branch it comes from (made unique), not after the chat.
    worktreeName: place?.fromBranch ? (place.fromBranch.split("/").pop() ?? null) : null,
    tab: {
      harness: harness.id,
      model: prefs.lastModel[harness.id] ?? "",
      effort: prefs.lastEffort[harness.id] ?? null,
      permissionMode: prefs.lastMode,
    },
  });
  upsertSession(session);
  selectSession(session.id);
  return session;
}

export async function removeProject(path: string) {
  await api.removeProject(path);
  set({
    projects: state.projects.filter((p) => p.path !== path),
    lastProject: state.lastProject === path ? (state.projects.find((p) => p.path !== path)?.path ?? null) : state.lastProject,
  });
}

export async function selectProject(path: string) {
  set({ lastProject: path });
  await api.selectProject(path);
}

export async function archiveSession(id: string, archived: boolean) {
  await api.setSessionArchived(id, archived);
  patchSession(id, { archived });
}

export async function pinSession(id: string, pinned: boolean) {
  await api.setSessionPinned(id, pinned);
  patchSession(id, { pinned });
}

export async function renameSession(id: string, title: string) {
  await api.renameSession(id, title);
  patchSession(id, { title });
}

/** A conversation's name: its agent's title for it once there is one. */
export function conversationTitle(session: SessionEntry): string {
  const tab = session.tabs.find((entry) => entry.id === session.activeTab) ?? session.tabs[0];
  return tab?.title?.trim() || session.title;
}

/** Rename a conversation by the title the sidebar shows: the session's, and its tab's when the tab has its own. */
export async function renameConversation(session: SessionEntry, title: string) {
  await renameSession(session.id, title);
  const tab = session.tabs.find((entry) => entry.id === session.activeTab) ?? session.tabs[0];
  if (tab?.title?.trim()) await api.renameTab(session.id, tab.id, title);
}

/** Rename a branch in git where it is checked out; its sessions and its label go with it. */
export async function renameBranch(projectPath: string, from: string, to: string) {
  const renamed = await api.renameBranch(projectPath, from, to);
  for (const session of renamed.sessions) upsertSession(session);
  set({ projects: state.projects.map((x) => (x.path === projectPath ? renamed.project : x)) });
  await refreshWorkspaces(projectPath);
  return renamed.branch;
}

/** "Link to issue…": the session works on `issue` from now on, and says so to the reader's other machines and team (#441). */
export async function linkSessionIssue(id: string, issue: IssueRef) {
  upsertSession(await workStatus.linkIssue(id, issue));
}

/** "Unlink": the session works on no issue, and is never linked to this one again by itself. */
export async function unlinkSessionIssue(id: string) {
  upsertSession(await workStatus.unlinkIssue(id));
}

/** "Don't share this session": its work status stays on this Mac. */
export async function setSessionWorkPrivate(id: string, isPrivate: boolean) {
  upsertSession(await workStatus.setPrivate(id, isPrivate));
}

/** Delete one session. Its workspace stays, and so does every other session. */
export async function deleteSession(id: string) {
  await api.deleteSession(id);
  removeSessions([id]);
}

/** Start a quick chat: a session with no project. The caller selects it and sends the first prompt. */
export async function createQuickChat(req: NewQuickChat) {
  const session = await api.createQuickChat(req);
  upsertSession(session);
  return session;
}

/** Run a quick chat in another folder (`null`: its scratch directory again). The folder does not become a project. */
export async function setQuickChatCwd(id: string, cwd: string | null) {
  const session = await api.setQuickChatCwd(id, cwd);
  upsertSession(session);
  return session;
}

/** Turn a quick chat into an ordinary session of a project, keeping its history. */
export async function moveQuickChatToProject(id: string, projectPath: string) {
  const session = await api.moveQuickChatToProject(id, projectPath);
  // The project may be new to this window; the event that says so can land after the session does.
  await refreshProjects();
  upsertSession(session);
  return session;
}

/** Keep the worktree on disk but run the session in the project itself from now on. */
export async function relocateSession(id: string) {
  const session = await api.relocateSession(id);
  upsertSession(session);
  return session;
}

export async function forkSession(id: string, tabId: string) {
  const s = await api.forkSession(id, tabId);
  upsertSession(s);
  selectSession(s.id);
  return s;
}

export async function addTab(sessionId: string, harness: string, model: string, effort: string | null, permissionMode: string) {
  const tab = await api.addTab(sessionId, { harness, model, effort, permissionMode });
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) patchSession(sessionId, { tabs: [...s.tabs.filter((t) => t.id !== tab.id), tab], activeTab: tab.id });
  setSelectedAgent(sessionId, tab.id);
  return tab;
}

export async function removeTab(sessionId: string, tabId: string) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  await api.removeTab(sessionId, tabId);
  const tabs = s.tabs.filter((t) => t.id !== tabId);
  const idx = s.tabs.findIndex((t) => t.id === tabId);
  const next = s.activeTab === tabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTab;
  patchSession(sessionId, { tabs, activeTab: next });
  // The backend stopped the tab's CLI; its pane and xterm are this window's to drop.
  queueMicrotask(() => dropTabTerminals([tabId]));
}

/** Bring a closed tab back into its session, with its conversation, and show it. */
export async function reopenTab(sessionId: string, tabId: string) {
  const tab = await api.reopenTab(sessionId, tabId);
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) patchSession(sessionId, { tabs: [...s.tabs.filter((t) => t.id !== tab.id), tab], activeTab: tab.id });
  setSelectedAgent(sessionId, tab.id);
  return tab;
}

export async function setActiveTab(sessionId: string, tabId: string) {
  setSelectedAgent(sessionId, tabId);
  patchSession(sessionId, { activeTab: tabId });
  if (state.selectedSessionId === sessionId) set({ navigationVersion: state.navigationVersion + 1 });
  await api.setActiveTab(sessionId, tabId);
}

/** Sessions in the order the sidebar draws them: pinned first, then newest. */
export function sortSessions(sessions: SessionEntry[]): SessionEntry[] {
  return [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  });
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
