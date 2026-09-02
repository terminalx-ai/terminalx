import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import type { HarnessInfo, Project, SessionEntry, TabEntry } from "@/types/session";

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
  selectedSessionId: string | null;
  /** What the workspace shows when no session is selected. */
  view: "new" | "issues";
  showArchived: boolean;
}

let state: State = {
  loaded: false,
  projects: [],
  lastProject: null,
  sessions: [],
  harnesses: [],
  selectedSessionId: null,
  view: "new",
  showArchived: false,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
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

let booted = false;
export async function bootSessions() {
  if (booted) return;
  booted = true;
  // Projects and sessions are two file reads; the harness probe may shell out
  // to a login shell and take seconds, so it lands on its own.
  const [projects, sessions] = await Promise.all([api.listProjects(), api.listSessions()]);
  set({ loaded: true, projects: projects.projects, lastProject: projects.lastSelected, sessions });
  void api.listHarnesses().then((harnesses) => set({ harnesses })).catch(() => {});
  try {
    await listen<SessionEntry>("session_created", (e) => upsertSession(e.payload));
    await listen<SessionEntry>("session_updated", (e) => upsertSession(e.payload));
  } catch {
    /* outside a webview */
  }
}

export async function refreshSessions() {
  const sessions = await api.listSessions();
  set({ sessions });
}

export function upsertSession(s: SessionEntry) {
  const i = state.sessions.findIndex((x) => x.id === s.id);
  const sessions = i >= 0 ? state.sessions.map((x) => (x.id === s.id ? s : x)) : [...state.sessions, s];
  set({ sessions });
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

export function selectSession(id: string | null) {
  set({ selectedSessionId: id, view: "new" });
}

/** The issues browser takes the workspace; no session stays selected. */
export function openIssues() {
  set({ selectedSessionId: null, view: "issues" });
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
  set({ projects: exists ? state.projects : [...state.projects, p], lastProject: p.path });
  return p;
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

export async function deleteSession(id: string, removeWorktree: boolean) {
  await api.deleteSession(id, removeWorktree);
  set({
    sessions: state.sessions.filter((s) => s.id !== id),
    selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
  });
}

export async function settleSession(id: string, action: "delete" | "relocate") {
  const s = await api.settleSession(id, action);
  upsertSession(s);
  return s;
}

export async function forkSession(id: string, tabId: string) {
  const s = await api.forkSession(id, tabId);
  upsertSession(s);
  set({ selectedSessionId: s.id });
  return s;
}

export async function addTab(sessionId: string, harness: string, model: string, effort: string | null, permissionMode: string) {
  const tab = await api.addTab(sessionId, { harness, model, effort, permissionMode });
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) patchSession(sessionId, { tabs: [...s.tabs, tab], activeTab: tab.id });
  return tab;
}

export async function removeTab(sessionId: string, tabId: string) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.tabs.length <= 1) return;
  await api.removeTab(sessionId, tabId);
  const tabs = s.tabs.filter((t) => t.id !== tabId);
  const idx = s.tabs.findIndex((t) => t.id === tabId);
  const next = s.activeTab === tabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTab;
  patchSession(sessionId, { tabs, activeTab: next });
}

export async function setActiveTab(sessionId: string, tabId: string) {
  patchSession(sessionId, { activeTab: tabId });
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
