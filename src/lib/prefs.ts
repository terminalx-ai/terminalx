import { useSyncExternalStore } from "react";

/**
 * UI preferences that the frontend can read for itself live in localStorage.
 * Anything the Rust side needs before the webview exists belongs in
 * ~/.raccoon/settings.json instead (see store/settings.rs).
 */
export interface Prefs {
  linkBrowser: "terminalx" | "system";
  linkActions: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  editorPaneWidth: number;
  updateChannel: "stable" | "beta";
  sounds: boolean;
  animations: boolean;
  fontScale: "sm" | "md" | "lg";
  transcriptLayout: "wide" | "chat";
  foldToolCalls: boolean;
  lastProject: string | null;
  lastAgent: string;
  lastModel: Record<string, string>;
  lastEffort: Record<string, string>;
  lastMode: string;
  issueProvider: "github" | "linear";
  useWorktree: boolean;
  /** The reader ticked "don't ask again" on the bypass warning. */
  bypassConfirmed: boolean;
  /**
   * Organization sections with cloud projects and workspaces in the sidebar
   * (PRO-23). The kill switch until the full-window cloud page is removed.
   */
  cloudSidebar: boolean;
  /**
   * Sidebar sections the reader expanded or collapsed, by key (`local`, or
   * `org:<orgId>`). A section not listed uses its default: Local and the
   * default organization expanded, other organizations collapsed.
   */
  sidebarSections: Record<string, "expanded" | "collapsed">;
  /**
   * Cloud projects the reader added with "+ Add project", per organization:
   * repository identities (`host/owner/name`). Projects with workspaces show
   * without being added.
   */
  cloudProjects: Record<string, string[]>;
  /**
   * Blank cloud projects (no repository) added with "New project…" but not
   * created yet, per organization, by name. Adding one spends nothing: its
   * workspace is created when its first session starts, and from then on it
   * is known by that workspace's name on every device.
   */
  cloudBlankProjects: Record<string, string[]>;
  /** Cloud projects the reader pinned, per organization, as repository identities. */
  cloudPinned: Record<string, string[]>;
  /** Cloud projects the reader collapsed, by project key (`cloud:<orgId>:<identity>`); expanded by default. */
  cloudCollapsed: Record<string, true>;
}

const DEFAULTS: Prefs = {
  linkBrowser: "terminalx",
  linkActions: true,
  sidebarOpen: true,
  sidebarWidth: 268,
  panelOpen: false,
  panelWidth: 400,
  editorPaneWidth: 520,
  updateChannel: "stable",
  sounds: true,
  animations: true,
  fontScale: "md",
  transcriptLayout: "wide",
  foldToolCalls: true,
  lastProject: null,
  lastAgent: "claude",
  lastModel: {},
  lastEffort: {},
  lastMode: "bypassPermissions",
  issueProvider: "github",
  useWorktree: true,
  bypassConfirmed: false,
  cloudSidebar: true,
  sidebarSections: {},
  cloudProjects: {},
  cloudBlankProjects: {},
  cloudPinned: {},
  cloudCollapsed: {},
};

const KEY = "raccoon.prefs";

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return state;
}

export function setPrefs(patch: Partial<Prefs>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  applyFontScale();
  for (const l of listeners) l();
}

function applyFontScale() {
  if (typeof document === "undefined") return;
  const scale = { sm: "13px", md: "13.5px", lg: "14.5px" }[state.fontScale];
  document.documentElement.style.setProperty("--fs-base", scale);
}

applyFontScale();

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function usePref<K extends keyof Prefs>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const prefs = usePrefs();
  return [prefs[key], (v) => setPrefs({ [key]: v } as Partial<Prefs>)];
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
