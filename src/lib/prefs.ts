import { useSyncExternalStore } from "react";
import { SHORTCUTS_VERSION, migrateShortcuts, shortcutsVersionOf } from "@/lib/shortcutMigration";
import type { IssueListFilter } from "@/lib/issueListFilter";

/**
 * UI preferences that the frontend can read for itself live in localStorage.
 * Anything the Rust side needs before the webview exists belongs in
 * ~/.raccoon/settings.json instead (see store/settings.rs).
 */
export interface Prefs {
  linkBrowser: "terminalx" | "system" | "ask";
  /** The reader used Settings or remembered a browser choice, rather than inheriting a default. */
  linkBrowserChosen: boolean;
  linkActions: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  /** A session's tabs as a row in the title bar. Off leaves them to the sidebar alone. */
  tabStrip: boolean;
  panelWidth: number;
  editorPaneWidth: number;
  updateChannel: "stable" | "beta";
  sounds: boolean;
  animations: boolean;
  fontScale: "sm" | "md" | "lg";
  transcriptLayout: "wide" | "chat";
  foldToolCalls: boolean;
  /**
   * The system's spelling correction, smart quotes and dashes, and text
   * replacements in the fields where the reader writes to an agent, and in the
   * notes beside them (see `@/lib/autocorrect`). Off unless the reader turned it on.
   */
  autocorrect: boolean;
  lastProject: string | null;
  lastAgent: string;
  lastModel: Record<string, string>;
  lastEffort: Record<string, string>;
  lastMode: string;
  issueProvider: "github" | "linear";
  /** The Issues list's filter and sort, by project and tracker (`issueFilterKey`). */
  issueFilters: Record<string, Partial<IssueListFilter>>;
  useWorktree: boolean;
  /** The reader ticked "don't ask again" on the bypass warning. */
  bypassConfirmed: boolean;
  /**
   * Sidebar sections the reader expanded or collapsed, by key (`local`, or
   * `org:<orgId>`). Local and live organizations with projects start
   * expanded; empty organizations start collapsed until opened deliberately.
   */
  sidebarSections: Record<string, "expanded" | "collapsed">;
  /** Organization visibility on this desktop. Local is always shown. */
  hiddenOrganizations: string[];
  organizationDisplay: "all" | "one";
  selectedOrganization: string | null;
  /**
   * The sidebar's shape: "simple" groups the conversations under their
   * projects; "list" is one flat list of chats, newest first, as a messaging
   * app draws it.
   */
  sidebarLayout: "simple" | "list";
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
  /**
   * Personal named sections of cloud projects (see `@/lib/cloudSidebarSections`),
   * by account email, then organization id, in the reader's order.
   */
  cloudSections: Record<string, Record<string, CloudSidebarSection[]>>;
  /**
   * Keyboard shortcuts the reader changed, by action id (see `@/lib/shortcuts`):
   * the bindings that replace the action's defaults, an empty list for none.
   * Kept per machine. An action not listed uses its defaults.
   */
  shortcuts: Record<string, string[]>;
  /** Which version's action ids `shortcuts` is written in (see `@/lib/shortcutMigration`). */
  shortcutsVersion: number;
  /**
   * The sidebar's session filter per person, by account email (`local` while
   * signed out). Only a filter that is on is kept; someone not listed sees
   * every session. One person's choice never carries over to another.
   */
  sidebarFilters: Record<string, "unread" | "needs">;
  /** The folder the reader last cloned or created a project in; the next one is suggested there. */
  projectsDir: string | null;
}

const DEFAULTS: Prefs = {
  linkBrowser: "ask",
  linkBrowserChosen: false,
  linkActions: true,
  sidebarOpen: true,
  sidebarWidth: 268,
  panelOpen: false,
  tabStrip: true,
  panelWidth: 400,
  editorPaneWidth: 520,
  updateChannel: "stable",
  sounds: true,
  animations: true,
  fontScale: "md",
  transcriptLayout: "wide",
  foldToolCalls: true,
  autocorrect: false,
  lastProject: null,
  lastAgent: "claude",
  lastModel: {},
  lastEffort: {},
  lastMode: "bypassPermissions",
  issueProvider: "github",
  issueFilters: {},
  useWorktree: true,
  bypassConfirmed: false,
  sidebarSections: {},
  sidebarLayout: "simple",
  hiddenOrganizations: [],
  organizationDisplay: "all",
  selectedOrganization: null,
  cloudProjects: {},
  cloudBlankProjects: {},
  cloudPinned: {},
  cloudCollapsed: {},
  cloudSections: {},
  shortcuts: {},
  shortcutsVersion: SHORTCUTS_VERSION,
  sidebarFilters: {},
  projectsDir: null,
};

const KEY = "raccoon.prefs";

/** One personal section of an organization's cloud projects. */
export interface CloudSidebarSection {
  id: string;
  name: string;
  /** Project identities (`host/owner/name` or `blank/<name>`), each in one section at most. */
  projects: string[];
}

/** Saved sections as written, minus anything malformed (a hand-edited or older file never breaks the sidebar). */
function cleanCloudSections(value: unknown): Prefs["cloudSections"] {
  const isObject = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  if (!isObject(value)) return {};
  const out: Prefs["cloudSections"] = {};
  for (const [who, orgs] of Object.entries(value)) {
    if (!isObject(orgs)) continue;
    for (const [orgId, sections] of Object.entries(orgs)) {
      if (!Array.isArray(sections)) continue;
      const kept = sections.filter((section): section is CloudSidebarSection => isObject(section) && typeof section.id === "string" && typeof section.name === "string" && Array.isArray(section.projects)).map((section) => ({ id: section.id, name: section.name, projects: section.projects.filter((id): id is string => typeof id === "string") }));
      if (kept.length) (out[who] ??= {})[orgId] = kept;
    }
  }
  return out;
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const prefs = { ...DEFAULTS, ...parsed };
    prefs.hiddenOrganizations = Array.isArray(prefs.hiddenOrganizations) ? [...new Set(prefs.hiddenOrganizations.filter((id: unknown) => typeof id === "string"))] : [];
    prefs.organizationDisplay = prefs.organizationDisplay === "one" ? "one" : "all";
    prefs.selectedOrganization = typeof prefs.selectedOrganization === "string" ? prefs.selectedOrganization : null;
    // The project tree ("detailed") is gone; anyone who had it gets the default.
    prefs.sidebarLayout = prefs.sidebarLayout === "list" ? "list" : "simple";
    prefs.autocorrect = prefs.autocorrect === true;
    prefs.cloudSections = cleanCloudSections(prefs.cloudSections);
    // Each entry is checked as it is read (`issueFilterFor`); only the map itself is checked here.
    if (!prefs.issueFilters || typeof prefs.issueFilters !== "object" || Array.isArray(prefs.issueFilters)) prefs.issueFilters = {};
    let migrated = false;
    // Older versions saved the whole object, including the TerminalX default,
    // without recording whether it was chosen. Migrate unmarked values once;
    // choices made in Settings or remembered in the chooser survive this migration.
    if (prefs.linkBrowser === "terminalx" && prefs.linkBrowserChosen !== true) {
      prefs.linkBrowser = "system";
      migrated = true;
    }
    // Shortcuts saved under an older version's action ids, once. A newer version's are left as they are.
    const version = shortcutsVersionOf(parsed.shortcutsVersion);
    if (version < SHORTCUTS_VERSION) {
      const shortcuts = migrateShortcuts(prefs.shortcuts, version);
      migrated ||= shortcuts !== prefs.shortcuts;
      prefs.shortcuts = shortcuts;
      prefs.shortcutsVersion = SHORTCUTS_VERSION;
    }
    if (migrated) {
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch {
        // Still use the migrated preferences when storage is unavailable.
      }
    }
    return prefs;
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

// Another window of the app changed the preferences: take them here too, so a
// shortcut changed in one window is the shortcut in every window at once.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || e.storageArea !== localStorage) return;
    state = load();
    applyFontScale();
    for (const l of listeners) l();
  });
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
