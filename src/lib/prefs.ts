import { useSyncExternalStore } from "react";

/**
 * UI preferences that the frontend can read for itself live in localStorage.
 * Anything the Rust side needs before the webview exists belongs in
 * ~/.raccoon/settings.json instead (see store/settings.rs).
 */
export interface Prefs {
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  editorPaneWidth: number;
  terminalHeight: number;
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
}

const DEFAULTS: Prefs = {
  sidebarOpen: true,
  sidebarWidth: 268,
  panelOpen: false,
  panelWidth: 400,
  editorPaneWidth: 520,
  terminalHeight: 260,
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
