/**
 * Where the main window was when the app last closed (PRO-130), so a launch
 * opens there instead of on the welcome screen: the session on screen, or
 * the page (a project's overview, Issues, Home, …). Each session's agent tab
 * is the session's own (`activeTab`, kept by the backend); its right-panel
 * tab is kept here, per session, with the panel's open state in prefs.
 *
 * Like the window's other navigation and layout state it lives in
 * localStorage, the main window's alone: a chat window neither saves nor
 * restores it. A session archived or deleted while the app was closed falls
 * back to its project's overview, and to the welcome screen when the project
 * is gone too, without a word: there is nothing to fix.
 */
import { appWindow } from "@/lib/appWindow";
import type { PanelTab } from "@/lib/panelTab";
import {
  getSessionStore, openAgents, openAutomations, openHome, openIssues, openProjectOverview, openSkills, openStats,
  selectSession, subscribeSessionStore,
} from "@/lib/sessions";
import { whenSessionsLoaded } from "@/lib/tabDeepLink";
import { isLocalKey } from "@/types/target";

const KEY = "raccoon.lastView";
/** Panel tabs kept for this many sessions at most; the ones shown longest ago go first. */
const MAX_PANEL_TABS = 200;
const PANEL_TABS: readonly PanelTab[] = ["branch", "changes", "files", "browser", "ports", "computer"];

/** The pages a launch can reopen. The new-session form is a draft and is not one: the session behind it is. */
const PAGES = ["welcome", "home", "issues", "agents", "automations", "skills", "stats", "project"] as const;
export type LastPage = (typeof PAGES)[number];

export interface LastView {
  /** The session on screen, this Mac's; null for a page. */
  sessionId: string | null;
  /** The page on screen when no session is: `welcome` while one is. */
  view: LastPage;
  /** The project of the session or overview on screen; where a gone session falls back to. */
  projectPath: string | null;
  /** The right panel's tab, by session. */
  panelTabs: Record<string, PanelTab>;
}

const EMPTY: LastView = { sessionId: null, view: "welcome", projectPath: null, panelTabs: {} };

function mainWindow(): boolean {
  return appWindow() === "main";
}

/** What was saved, cleaned: a hand-edited or older record never breaks a launch. */
export function readLastView(): LastView {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LastView> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY, panelTabs: {} };
    const tabs = raw.panelTabs && typeof raw.panelTabs === "object" && !Array.isArray(raw.panelTabs) ? raw.panelTabs : {};
    return {
      sessionId: typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null,
      view: PAGES.includes(raw.view as LastPage) ? (raw.view as LastPage) : "welcome",
      projectPath: typeof raw.projectPath === "string" && raw.projectPath ? raw.projectPath : null,
      panelTabs: Object.fromEntries(Object.entries(tabs).filter(([, tab]) => PANEL_TABS.includes(tab as PanelTab))) as Record<string, PanelTab>,
    };
  } catch {
    return { ...EMPTY, panelTabs: {} };
  }
}

function write(view: LastView) {
  try { localStorage.setItem(KEY, JSON.stringify(view)); } catch { /* Storage may be unavailable; the launch then opens on welcome. */ }
}

/** The right panel's tab last shown for `sessionId`, or null. */
export function savedPanelTab(sessionId: string): PanelTab | null {
  return readLastView().panelTabs[sessionId] ?? null;
}

/** Keep the right panel's tab for `sessionId` (the main window's). */
export function savePanelTab(sessionId: string, tab: PanelTab): void {
  if (!mainWindow()) return;
  const saved = readLastView();
  if (saved.panelTabs[sessionId] === tab) return;
  // Re-inserted last, so the oldest are the first entries when the record is trimmed.
  const { [sessionId]: _previous, ...others } = saved.panelTabs;
  const entries = Object.entries({ ...others, [sessionId]: tab });
  write({ ...saved, panelTabs: Object.fromEntries(entries.slice(-MAX_PANEL_TABS)) });
}

/**
 * What the store shows, as a launch would reopen it, or null to keep what
 * was saved: a new-session draft, a cloud or machine session, a cloud
 * workspace, or a session not listed yet.
 */
export function viewOf(store: ReturnType<typeof getSessionStore>): Omit<LastView, "panelTabs"> | null {
  if (store.selectedCloudWorkspace) return null;
  if (store.selectedSessionId) {
    if (!isLocalKey(store.selectedSessionId)) return null;
    const session = store.sessions.find((candidate) => candidate.id === store.selectedSessionId);
    if (!session) return null;
    return { sessionId: session.id, view: "welcome", projectPath: session.kind === "quick" ? null : session.projectPath };
  }
  if (!PAGES.includes(store.view as LastPage)) return null;
  return { sessionId: null, view: store.view as LastPage, projectPath: store.view === "project" ? store.selectedProject : null };
}

/**
 * Open what was on screen when the app last closed, if the person has not
 * gone anywhere since launch (a link that opened a session, a click). A
 * session archived or deleted since falls back to its project's overview.
 * Returns what it opened: the session, the page, or null for nothing.
 */
export function restoreLastView(saved: LastView = readLastView()): { sessionId: string } | { view: LastPage; projectPath?: string } | null {
  const store = getSessionStore();
  const projectExists = (path: string | null): path is string => !!path && store.projects.some((project) => project.path === path && !project.archived);
  if (saved.sessionId) {
    const session = store.sessions.find((candidate) => candidate.id === saved.sessionId);
    if (session && !session.archived) {
      selectSession(session.id);
      return { sessionId: session.id };
    }
    const fallback = session?.projectPath ?? saved.projectPath;
    if (session?.kind !== "quick" && projectExists(fallback)) {
      openProjectOverview(fallback);
      return { view: "project", projectPath: fallback };
    }
    return null;
  }
  switch (saved.view) {
    case "project":
      if (!projectExists(saved.projectPath)) return null;
      openProjectOverview(saved.projectPath);
      return { view: "project", projectPath: saved.projectPath };
    case "home": openHome(); break;
    case "issues": openIssues(); break;
    case "agents": openAgents(); break;
    case "automations": openAutomations(); break;
    case "skills": openSkills(); break;
    case "stats": openStats(); break;
    case "welcome": return null;
  }
  return { view: saved.view };
}

let booted = false;

/**
 * Reopen the last view once the sessions are read, then keep it up to date
 * as the person moves around. The main window's only. Nothing is restored
 * when the person (or a link) went somewhere before the sessions were read.
 */
export function bootLastView(): void {
  if (booted || !mainWindow()) return;
  booted = true;
  const atLaunch = getSessionStore().navigationVersion;
  void whenSessionsLoaded().then(() => {
    const store = getSessionStore();
    const untouched = store.navigationVersion === atLaunch && store.view === "welcome" && !store.selectedSessionId && !store.selectedCloudWorkspace;
    if (untouched) {
      try { restoreLastView(); } catch (error) { console.error("reopen the last view", error); }
    }
    // Written once now (what was reopened, or where a gone session fell back to), then on each move.
    let last: ReturnType<typeof viewOf> = null;
    const save = () => {
      const now = viewOf(getSessionStore());
      if (!now || (last && now.sessionId === last.sessionId && now.view === last.view && now.projectPath === last.projectPath)) return;
      last = now;
      write({ ...readLastView(), ...now });
    };
    save();
    subscribeSessionStore(save);
  }).catch((error) => console.error("keep the last view", error));
}

/** Forget the boot and what was saved (tests). */
export function resetLastView(): void {
  booted = false;
  try { localStorage.removeItem(KEY); } catch { /* Storage may be unavailable. */ }
}
