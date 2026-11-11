import { dashboardPreferences, DEFAULT_DASHBOARD_PREFERENCES, type DashboardPreferences } from "@terminalx/portable/dashboard";
import { useSyncExternalStore } from "react";
import { appWindow } from "@/lib/appWindow";
import { FIRST_RUN_PERMISSION_MODE } from "@terminalx/portable/agentSettings";
import { SHORTCUTS_VERSION, migrateShortcuts, shortcutsVersionOf } from "@/lib/shortcutMigration";
import type { IssueListFilter } from "@/lib/issueListFilter";
import type { IssuePipelineSettings } from "@/types/issuePipeline";
import userPreferenceDefaults from "./userPreferenceDefaults.json";

/**
 * User-facing preferences live in settings.json after the one-time migration.
 * Transient navigation/layout state stays in localStorage.
 */
export interface Prefs {
  dashboard: DashboardPreferences;
  linkBrowser: "terminalx" | "system" | "ask";
  /** The reader used Settings or remembered a browser choice, rather than inheriting a default. */
  linkBrowserChosen: boolean;
  linkActions: boolean;
  /** Has made a share link: Share opens on its settings, with How sharing works for the introduction. */
  shareOnboarded: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  colourLineCounts: boolean;
  panelOpen: boolean;
  /** A session's tabs as a row under the title bar. Off leaves them to the sidebar alone. */
  tabStrip: boolean;
  /**
   * Where several sessions on one branch are kept: as tabs beside each other
   * in the tab bar, with one row for the branch in the sidebar, or listed
   * under the branch in the sidebar, with the tab bar holding only the open
   * session's own tabs. One or the other, never both. With no tab bar it is
   * the sidebar (see `branchSessionsAsTabs` in `@/lib/tabLayouts`).
   */
  branchSessions: "tabs" | "sidebar";
  panelWidth: number;
  diffMode: "unified" | "split";
  diffHideWhitespace: boolean;
  diffWrap: boolean;
  /** Explicit per-source, per-path choices. Missing keys follow diffWrap. */
  diffWrapFiles: Record<string, boolean>;
  /** The right panel's terminal dock: shown below the panel's tabs, and its height. */
  panelTerminalOpen: boolean;
  panelTerminalHeight: number;
  editorPaneWidth: number;
  updateChannel: "stable" | "beta";
  sounds: boolean;
  animations: boolean;
  fontScale: "sm" | "md" | "lg";
  transcriptLayout: "wide" | "chat";
  foldToolCalls: boolean;
  /** Under each finished turn, a chip per file it changed with the lines added and removed. */
  turnChanges: boolean;
  /** A mark per prompt down the transcript's right edge: hover to read one, click to go to it. */
  promptMap: boolean;
  /** Appended to the prompt that sends failed CI logs to an agent. */
  fixErrorsInstructions: string;
  /**
   * The system's spelling correction, smart quotes and dashes, and text
   * replacements in the fields where the reader writes to an agent, and in the
   * notes beside them (see `@/lib/autocorrect`). Off unless the reader turned it on.
   */
  autocorrect: boolean;
  followUps: "now" | "hold";
  lastProject: string | null;
  lastAgent: string;
  lastModel: Record<string, string>;
  lastEffort: Record<string, string>;
  /**
   * The permission mode new chats start in: the last one the reader picked,
   * and Ask every time on a profile where they never picked one.
   */
  lastMode: string;
  prActivityOrder: "newest" | "oldest";
  issueProvider: "github" | "linear";
  /** The cloud project the Issues view shows (`cloud:<orgId>:<identity>`); null for `lastProject`, a project on this computer. */
  issueCloudProject: string | null;
  /** Issue pipeline settings of cloud projects, by project key. Kept here; each issue session started from here takes them to its workspace. */
  cloudIssuePipelines: Record<string, IssuePipelineSettings>;
  /** 1: `cloudIssuePipelines` stores a launch switch only once it is chosen (#700). */
  cloudIssuePipelinesVersion: number;
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
   * app draws it; "status" groups individual sessions by their manual status.
   */
  sidebarLayout: "simple" | "list" | "status";
  sidebarSort: "updated" | "created" | "custom";
  sidebarProject: string | null;
  sidebarShowArchived: boolean;
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

const CLOUD_ISSUE_PIPELINES_VERSION = 1;

const DEFAULTS: Prefs = {
  dashboard: DEFAULT_DASHBOARD_PREFERENCES,
  linkBrowser: "ask",
  linkBrowserChosen: false,
  linkActions: true,
  shareOnboarded: false,
  sidebarOpen: true,
  sidebarWidth: 268,
  colourLineCounts: false,
  panelOpen: false,
  tabStrip: true,
  branchSessions: "tabs",
  panelWidth: 400,
  diffMode: "unified",
  diffHideWhitespace: false,
  diffWrap: true,
  diffWrapFiles: {},
  panelTerminalOpen: false,
  panelTerminalHeight: 260,
  editorPaneWidth: 520,
  updateChannel: "stable",
  sounds: true,
  animations: true,
  fontScale: "md",
  transcriptLayout: "wide",
  // Off: every step of a turn stays in view between its paragraphs, so a turn reads as what the agent did, in order.
  foldToolCalls: false,
  turnChanges: true,
  promptMap: true,
  fixErrorsInstructions: "",
  autocorrect: false,
  followUps: "now",
  lastProject: null,
  lastAgent: "claude",
  lastModel: {},
  lastEffort: {},
  lastMode: FIRST_RUN_PERMISSION_MODE,
  prActivityOrder: "newest",
  issueProvider: "github",
  issueCloudProject: null,
  cloudIssuePipelines: {},
  cloudIssuePipelinesVersion: CLOUD_ISSUE_PIPELINES_VERSION,
  issueFilters: {},
  useWorktree: true,
  bypassConfirmed: false,
  sidebarSections: {},
  sidebarLayout: "simple",
  sidebarSort: "updated",
  sidebarProject: null,
  sidebarShowArchived: false,
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
// Window layout choices have their own record; another window cannot overwrite them.
const WINDOW_KEYS = ["sidebarLayout", "sidebarSort", "sidebarProject", "sidebarShowArchived", "sidebarFilters", "sidebarSections"] as const;
const windowKey = () => `${KEY}.sidebar.${appWindow()}`;
/** Independent chat labels are never reused. Keep only records for windows that still exist. */
export function sidebarChatWindowLabels(): string[] {
  try {
    const prefix = `${KEY}.sidebar.`;
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "")
      .filter((key) => key.startsWith(`${prefix}chat-`)).map((key) => key.slice(prefix.length));
  } catch { return []; }
}

export function forgetSidebarWindow(label: string) {
  if (!label.startsWith("chat-")) return;
  try { localStorage.removeItem(`${KEY}.sidebar.${label}`); } catch { /* Storage may be unavailable. */ }
}

export function pruneSidebarWindows(active: readonly string[], candidates: readonly string[]) {
  for (const label of candidates) if (!active.includes(label)) forgetSidebarWindow(label);
}

function windowChoices(value: unknown): Partial<Prefs> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const prefs = value as Partial<Prefs>;
  return Object.fromEntries(WINDOW_KEYS.filter((key) => key in prefs).map((key) => [key, prefs[key]]));
}

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

let preferenceFileValues: Partial<Prefs> = {};
let hasSidebarSortChoice = false;

function load(legacyOnly = false): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const legacy = raw ? JSON.parse(raw) : {};
    const fileValues = legacyOnly ? {} : preferenceFileValues;
    const savedWindow = legacyOnly ? null : localStorage.getItem(windowKey());
    let own = windowChoices({ ...legacy, ...fileValues });
    try { if (savedWindow) own = windowChoices(JSON.parse(savedWindow)); } catch { /* Ignore only the broken window record. */ }
    const parsed = { ...legacy, ...fileValues, ...own };
    const prefs = { ...DEFAULTS, ...parsed };
    prefs.dashboard = dashboardPreferences(prefs.dashboard);
    prefs.hiddenOrganizations = Array.isArray(prefs.hiddenOrganizations) ? [...new Set(prefs.hiddenOrganizations.filter((id: unknown) => typeof id === "string"))] : [];
    prefs.organizationDisplay = prefs.organizationDisplay === "one" ? "one" : "all";
    prefs.selectedOrganization = typeof prefs.selectedOrganization === "string" ? prefs.selectedOrganization : null;
    // The project tree ("detailed") is gone; anyone who had it gets the default.
    prefs.sidebarLayout = ["list", "status"].includes(prefs.sidebarLayout) ? prefs.sidebarLayout : "simple";
    prefs.sidebarSort = ["created", "custom"].includes(prefs.sidebarSort) ? prefs.sidebarSort : "updated";
    if (!legacyOnly) hasSidebarSortChoice = ["updated", "created", "custom"].includes(parsed.sidebarSort);
    prefs.sidebarProject = typeof prefs.sidebarProject === "string" ? prefs.sidebarProject : null;
    prefs.sidebarShowArchived = prefs.sidebarShowArchived === true;
    for (const key of ["sidebarFilters", "sidebarSections"] as const) {
      if (!prefs[key] || typeof prefs[key] !== "object" || Array.isArray(prefs[key])) prefs[key] = {};
    }
    prefs.autocorrect = prefs.autocorrect === true;
    prefs.followUps = prefs.followUps === "hold" ? "hold" : "now";
    prefs.prActivityOrder = prefs.prActivityOrder === "oldest" ? "oldest" : "newest";
    prefs.diffMode = prefs.diffMode === "split" ? "split" : "unified";
    prefs.diffHideWhitespace = prefs.diffHideWhitespace === true;
    prefs.diffWrap = prefs.diffWrap !== false;
    prefs.diffWrapFiles = prefs.diffWrapFiles && typeof prefs.diffWrapFiles === "object" && !Array.isArray(prefs.diffWrapFiles)
      ? Object.fromEntries(Object.entries(prefs.diffWrapFiles).filter(([, value]) => typeof value === "boolean")) : {};
    prefs.cloudSections = cleanCloudSections(prefs.cloudSections);
    prefs.issueCloudProject = typeof prefs.issueCloudProject === "string" && prefs.issueCloudProject.startsWith("cloud:") ? prefs.issueCloudProject : null;
    const pipelines = prefs.cloudIssuePipelines;
    prefs.cloudIssuePipelines = pipelines && typeof pipelines === "object" && !Array.isArray(pipelines) ? Object.fromEntries(Object.entries(pipelines).filter(([, value]) => !!value && typeof value === "object" && !Array.isArray(value))) : {};
    // Each entry is checked as it is read (`issueFilterFor`); only the map itself is checked here.
    if (!prefs.issueFilters || typeof prefs.issueFilters !== "object" || Array.isArray(prefs.issueFilters)) prefs.issueFilters = {};
    if (typeof prefs.fixErrorsInstructions !== "string") prefs.fixErrorsInstructions = "";
    prefs.fixErrorsInstructions = prefs.fixErrorsInstructions.slice(0, 8000);
    let migrated = false;
    // Older versions saved the whole object, including the TerminalX default,
    // without recording whether it was chosen. Migrate unmarked values once;
    // choices made in Settings or remembered in the chooser survive this migration.
    if (prefs.linkBrowser === "terminalx" && prefs.linkBrowserChosen !== true) {
      prefs.linkBrowser = "system";
      migrated = true;
    }
    // Before #700 every save of a cloud project's pipeline wrote both launch
    // switches, `false` unless turned on: that `false` was no choice, so it is
    // forgotten once and the switch follows where each session starts.
    // An older build keeps the version it does not know (it spreads what it
    // read), so a switch it saves as off afterwards reads as Off, never as no choice.
    const pipelinesVersion = Number(parsed.cloudIssuePipelinesVersion) || 0;
    if (pipelinesVersion < CLOUD_ISSUE_PIPELINES_VERSION) {
      for (const settings of Object.values(prefs.cloudIssuePipelines as Record<string, IssuePipelineSettings>)) {
        for (const key of ["autoMerge", "resolveConflicts"] as const) {
          if (settings[key] !== false) continue;
          delete settings[key];
          migrated = true;
        }
      }
    }
    // Never lowered: a newer build's migrations are not run again after a downgrade.
    prefs.cloudIssuePipelinesVersion = Math.max(pipelinesVersion, CLOUD_ISSUE_PIPELINES_VERSION);
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
        localStorage.setItem(KEY, JSON.stringify({
          ...prefs, ...windowChoices({ ...DEFAULTS, ...legacy }),
          // An unrelated migration must not turn the default into a sort choice
          // or publish this window's override. Undefined stays absent in JSON.
          sidebarSort: legacy.sidebarSort,
        }));
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
type FileWriter = (patch: Record<string, unknown>) => void;
let fileWriter: FileWriter | null = null;
const fileKeys = Object.keys(userPreferenceDefaults).filter((key) => key !== "theme" && key !== "mode") as (keyof Prefs)[];

/** Only choices actually kept by the old build, with its migrations applied. */
export function legacyUserPreferences(): Record<string, unknown> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const legacy = load(true);
    return Object.fromEntries(fileKeys.filter((key) => key in saved || (key === "shortcutsVersion" && "shortcuts" in saved)).map((key) => [key, legacy[key]]));
  } catch { return {}; }
}

export function connectPreferenceFile(writer: FileWriter) { fileWriter = writer; }

/** Apply a complete file view: removing a key restores its default. */
export function applyFilePreferences(values: Record<string, unknown>, persist = true) {
  const patch = Object.fromEntries(fileKeys.map((key) => [key, values[key] ?? DEFAULTS[key]]));
  preferenceFileValues = patch;
  let own: Partial<Prefs> = {};
  try { own = windowChoices(JSON.parse(localStorage.getItem(windowKey()) ?? "{}")); } catch { /* Ignore a broken window record. */ }
  state = { ...state, ...patch, ...own };
  if (persist) persistLocal();
  applyFontScale();
  for (const listener of listeners) listener();
}

function persistLocal(patch: Partial<Prefs> = {}) {
  try {
    // Keep inherited choices for windows that have no record yet. File-backed
    // layout is only a default; choosing a view never edits settings.json.
    let legacy: Partial<Prefs> = {};
    try { legacy = windowChoices(JSON.parse(localStorage.getItem(KEY) ?? "{}")); } catch { /* Replace corrupt shared preferences. */ }
    const local: Record<string, unknown> = { ...legacy, ...Object.fromEntries(Object.entries(state).filter(([key]) => !WINDOW_KEYS.includes(key as typeof WINDOW_KEYS[number]))) };
    if (fileWriter) for (const key of fileKeys) delete local[key];
    localStorage.setItem(KEY, JSON.stringify(local));
    const changed = windowChoices(patch);
    if (Object.keys(changed).length) {
      let own: Partial<Prefs> = {};
      try { own = windowChoices(JSON.parse(localStorage.getItem(windowKey()) ?? "{}")); } catch { /* Replace a broken window record. */ }
      // Only an explicit view choice overrides the inherited file default.
      localStorage.setItem(windowKey(), JSON.stringify({ ...own, ...changed }));
    }
  } catch { /* storage unavailable */ }
}

export function getPrefs(): Prefs {
  return state;
}

/** Unconfigured windows inherit the Rust index's pre-existing custom-order choice. */
export function getSidebarSortChoice(): Prefs["sidebarSort"] | null {
  return hasSidebarSortChoice ? state.sidebarSort : null;
}

export function setPrefs(patch: Partial<Prefs>) {
  if (patch.sidebarSort !== undefined) hasSidebarSortChoice = true;
  state = { ...state, ...patch };
  persistLocal(patch);
  const saved = Object.fromEntries(Object.entries(patch).filter(([key]) => fileKeys.includes(key as keyof Prefs) && !WINDOW_KEYS.includes(key as typeof WINDOW_KEYS[number])));
  if (Object.keys(saved).length) fileWriter?.(saved);
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
    if ((e.key !== KEY && e.key !== windowKey()) || e.storageArea !== localStorage) return;
    const fileValues = fileWriter ? Object.fromEntries(fileKeys.filter((key) => !WINDOW_KEYS.includes(key as typeof WINDOW_KEYS[number])).map((key) => [key, state[key]])) : {};
    state = { ...load(), ...fileValues };
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
