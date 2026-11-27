import { MANUAL_STATUSES, manualStatusLabel, normalizeManualStatus, type ManualStatus } from "@terminalx/portable/manualStatus";
import { thisComputer } from "@/lib/platform";
import { ManualStatusIcon } from "@/components/session/ManualStatus";
import { conversationTitle } from "@/lib/sessions";
import { editLocalSection, openSectionDialog, useLocalSections, type LocalSectionEdit } from "@/lib/localSections";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppWindow,
  Archive,
  ArrowLeft,
  AtSign,
  BookOpen,
  FileDiff,
  RefreshCw,
  SquarePen,
  Wrench,
  BarChart3,
  Bot,
  Building,
  FlaskConical,
  CalendarClock,
  Check,
  CircleDot,
  Command as CommandIcon,
  FileText,
  Folder,
  FolderGit2,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitBranch,
  GitPullRequest,
  HardDrive,
  Globe,
  Home,
  Info,
  KeyRound,
  Keyboard,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Mic,
  Moon,
  PanelLeft,
  Play,
  PanelRight,
  Palette,
  Plug,
  Search,
  Settings,
  Smartphone,
  Laptop,
  Sparkles,
  Sun,
  Terminal,
  User,
  Users,
  Workflow,
  Cloud,
  Monitor,
  type LucideIcon,
  Trash2,
  Server,
} from "@/icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { SETTINGS_SECTIONS as SETTINGS_PAGES, settingsSectionOffered } from "@/lib/settingsSections";
import { searchSettings } from "@/lib/settingsSearch";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { requestProjectSettings } from "@/lib/projectAdded";
import type { SettingsSection } from "@/components/settings/settingsRegistry";
import { AgentMark } from "@/components/AgentMark";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { cn } from "@/lib/cn";
import {
  indexPaletteItem,
  movePaletteSelection,
  orderPaletteItems,
  organizationSwitchQuery,
  ORGANIZATIONS_TAB,
  PALETTE_TABS,
  paletteScopeShows,
  palettePlaceholder,
  paletteTabOf,
  parseSmartInput,
  rankPaletteItems,
  searchPaletteIndex,
  sectionChoices,
  stepPaletteTab,
  buildCloudPaletteProjects,
  buildCloudPaletteSessions,
  withCloudProjects,
  withCloudSessions,
  type MatchRange,
  type PaletteEntityBase,
  type PaletteMatch,
  type PaletteNavigationKey,
  type PaletteScope,
  type SmartInput,
} from "@/lib/commandPalette";
import { api, errorMessage, files, gh, issues, type FileHit, type Issue, type PullRequest } from "@/lib/api";
import { openFile } from "@/lib/editors";
import { runShortcut, useHotkey } from "@/lib/hotkeys";
import { issuePromptWithComments, issueWorktreeName, pullRequestPrompt } from "@/lib/issueSession";
import { pipelineSettings, startPipeline } from "@/lib/issuePipeline";
import { getPrefs, usePrefs } from "@/lib/prefs";
import { START_ACTIONS, type StartAction } from "@/lib/projectStart";
import { ONLY_THIS_MAC, organizationName, organizationSwitchTargets, switchOrganization, useOrganizationVisibility } from "@/lib/organizationVisibility";
import { useOrganizationSwitchingEnabled } from "@/lib/organizationVisibilityGate";
import { readOrganizationRoster } from "@/lib/organizationRoster";
import { openOrganizationSettings } from "@/lib/settingsLinks";
import { parseCloudWorkspaceKey } from "@/types/target";
import { visiblePaletteSessions } from "@/lib/organizationSessions";
import {
  openNewIssue,
  openWorkspace,
  refreshWorkspaces,
  selectProjectInSidebar,
  selectSession,
  startCloudSessionIn,
  startSessionIn,
  upsertSession,
  useSessionStore,
} from "@/lib/sessions";
import { ORGANIZATION_SHORTCUTS, SHORTCUT_ACTIONS, defaultBindings, isMac, joinKeycaps, keycaps, useKeymap, type ShortcutAction } from "@/lib/shortcuts";
import { openCloudSession, useCloudDashboard } from "@/lib/cloudDashboard";
import { updateCloudSession, useCloudSessionForStatus } from "@/lib/cloudSessions";
import { openNewCloudWorkspace } from "@/components/cloud/NewCloudWorkspaceDialog";
import { useAccount } from "@/lib/account";
import { defaultOrgId, lastActivity, liveCloudOrgIds } from "@/lib/cloudCatalog";
import { useCloudProjectChoices } from "@/components/session/CloudNewSession";
import { mayStartCloudSessions } from "@/lib/multiOrg";
import { setStatusSettings, useStatus } from "@/lib/status";
import { THEMES, setMode, setTheme, useTheme } from "@/lib/theme";
import { relativeTime } from "@/lib/time";
import type { SettingsTab } from "@/components/settings/SettingsPage";
import { openWorktreeCleanup } from "@/lib/dialogs";
import { openPairPhone } from "@/lib/pairing";
import type { Project, SessionEntry } from "@/types/session";
import { offersRunMenu, openPreview, startAction } from "@/components/session/RunMenu";
import { visibleActions } from "@/lib/repositoryActions";

const GROUP_CAPS: Record<string, number> = {
  smart: 5,
  sessions: 7,
  workspaces: 6,
  projects: 4,
  files: 8,
  "session-actions": 8,
  commands: 8,
  sections: 500,
  settings: 30,
  "settings-pages": 30,
  "settings-projects": 30,
};

/** Each Settings page's icon in the palette (design 07.05 gives every page its own). */
const SETTINGS_PAGE_ICONS: Record<SettingsSection, LucideIcon> = {
  account: User,
  devices: Smartphone,
  machines: Laptop,
  stats: BarChart3,
  general: Settings,
  appearance: Palette,
  agents: Bot,
  orchestrator: Workflow,
  environment: KeyRound,
  mcp: Server,
  localVms: Monitor,
  transcription: Mic,
  integrations: Plug,
  projects: FolderPlus,
  repositories: FolderGit2,
  organizations: Users,
  storage: HardDrive,
  shortcuts: Keyboard,
  experimental: FlaskConical,
  advanced: Wrench,
  about: Info,
};

/**
 * The Actions list with nothing typed (design 07.04): the open session's actions
 * under its title, then the app's, each with the most used first. An action
 * named here leads its group in this order; the rest follow as the shortcut
 * registry lists them, and the app's housekeeping (updates, help, About) ends it.
 */
const SESSION_ACTIONS_FIRST = [
  "command:shortcut:session.fixErrors",
  "command:shortcut:git.createPr",
  "command:shortcut:git.merge",
  "command:shortcut:git.commitPush",
  "command:shortcut:git.pull",
  "command:shortcut:panel.changes",
  "command:shortcut:panel.pullRequests",
  "command:session-status",
  "command:local-section:move",
  "command:shortcut:session.archive",
  "command:shortcut:session.newTab",
  "command:shortcut:files.quickOpen",
  "command:shortcut:files.search",
];
const APP_ACTIONS_FIRST = [
  "command:shortcut:app.newSession",
  "command:local-section:create",
  "command:shortcut:app.addProject",
  "command:shortcut:app.automations",
  "command:shortcut:app.startFrom",
  "command:new-issue",
  "command:shortcut:app.home",
  "command:shortcut:app.issues",
  "command:shortcut:app.agentDashboard",
  "command:shortcut:app.stats",
  "command:shortcut:app.skills",
  "command:shortcut:app.settings",
  "command:settings:search",
  "command:shortcut:app.shortcuts",
  "command:shortcut:app.toggleSidebar",
  "command:shortcut:app.togglePanel",
];
const APP_ACTIONS_LAST = ["command:shortcut:app.checkUpdates", "command:shortcut:app.docs", "command:shortcut:app.reportIssue", "command:shortcut:app.about"];

/** A binding as one keycap (design 07.04): ⇧⌘X on the Mac, Ctrl+Shift+X elsewhere. */
const chordCap = (binding: string) => joinKeycaps(keycaps(binding));

interface CommandEntry extends PaletteEntityBase {
  group: "commands";
  icon: LucideIcon;
  /** The action is the open session's: listed under "This session", not under "App". */
  session?: boolean;
  /** The entry is a keyboard shortcut's action: it runs where the focus was. */
  shortcut?: boolean;
  /** The action's current keys, when it has any. */
  chord?: string;
  /** The entry narrows the palette instead of leaving it. */
  keepOpen?: boolean;
  run: () => void | Promise<void>;
}

interface FileEntry extends PaletteEntityBase {
  group: "files";
  hit: FileHit;
}

interface PaletteRow {
  manualStatus?: ManualStatus;
  id: string;
  kind: "session" | "workspace" | "project" | "file" | "command" | "smart-session" | "smart-start" | "smart-workspace";
  primary: string;
  secondary: string;
  primaryRanges: MatchRange[];
  secondaryRanges: MatchRange[];
  chord?: string;
  organizationInitial?: string;
  current?: boolean;
  icon?: LucideIcon;
  agentId?: string;
  project?: Project;
  run: () => void | Promise<void>;
  restoreFocus?: boolean;
  closeBefore?: boolean;
  /**
   * One 36px line instead of a tile with two. "line" is an action (design 07.04): the label, a grey detail after
   * it, and its keys at the end. "page" is a Settings page (design 07.05): the title, and what it holds at the end.
   */
  layout?: "line" | "page";
  /** A section's emoji, drawn where the icon would be. */
  emoji?: string;
  /** Said in small type at the row's end, before the keys: a section's session count. */
  trailing?: string;
  /** The row has a check column, and this row's is ticked: the section the session is in. */
  checked?: boolean;
  /** While selected, the row shows the Enter keycap. */
  enterHint?: boolean;
}

interface PaletteGroup {
  id: string;
  /** The heading; none for a list that needs no name (the sections of Move to section). */
  label: string;
  /** Said after the heading in ordinary case: the open session's title. */
  labelDetail?: string;
  /** A hairline above the group, when another precedes it. */
  divider?: boolean;
  /** Said above the group in place of rows that are not there: no section matches. */
  note?: { title: string; detail: string };
  emptyText?: string;
  rows: PaletteRow[];
}

interface ResolvedWorkItem {
  project: Project;
  number: number;
  title: string;
  url: string;
  issue?: Issue;
  pullRequest?: PullRequest;
}

const START_ACTION_ICONS: Record<StartAction["id"], LucideIcon> = { local: FolderOpen, github: FolderGit2, quick: FolderPlus };

function shortcutIcon(shortcut: ShortcutAction): LucideIcon {
  const label = shortcut.label.toLowerCase();
  if (shortcut.id === "app.home") return Home;
  // Design 07.04 gives an action its own glyph where there is one; the keyboard is what is left.
  if (shortcut.id === "app.newSession" || shortcut.id === "app.startFrom") return SquarePen;
  if (shortcut.id === "app.about") return Info;
  if (shortcut.id === "app.checkUpdates") return RefreshCw;
  if (shortcut.id === "app.docs") return BookOpen;
  if (shortcut.id === "session.archive") return Archive;
  if (shortcut.id === "session.runAction") return Play;
  if (shortcut.id === "panel.changes") return FileDiff;
  if (shortcut.id === "panel.repository") return GitBranch;
  if (shortcut.id === "files.search" || shortcut.id === "files.replace" || shortcut.id === "files.find") return Search;
  if (label.includes("pull request")) return GitPullRequest;
  if (label.includes("check")) return Wrench;
  if (shortcut.id.startsWith("git.")) return GitBranch;
  if (label.includes("project")) return FolderGit2;
  if (label.includes("window") || label.includes("zoom") || label.includes("size") || label.includes("full screen")) return AppWindow;
  if (label.includes("session") || label === "send" || label.includes("chat")) return MessageSquare;
  if (label.includes("issue")) return CircleDot;
  if (label.includes("dashboard")) return LayoutGrid;
  if (label.includes("usage")) return BarChart3;
  if (label.includes("automation")) return CalendarClock;
  if (label.includes("skill")) return Sparkles;
  if (label.includes("setting")) return Settings;
  if (label.includes("sidebar")) return PanelLeft;
  if (label.includes("panel")) return PanelRight;
  if (label.includes("file") || label.includes("preview") || label.includes("save")) return FileText;
  if (label.includes("terminal")) return Terminal;
  if (label.includes("mention")) return AtSign;
  if (label.includes("palette")) return CommandIcon;
  return Keyboard;
}

function cleanPath(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function directory(path: string): string {
  const at = path.lastIndexOf("/");
  return at > 0 ? path.slice(0, at) : ".";
}

function insertComposerText(text: string): boolean {
  const active = document.activeElement;
  const textarea = active instanceof HTMLTextAreaElement && active.matches("[data-composer]")
    ? active
    : document.querySelector<HTMLTextAreaElement>("[data-composer]");
  if (!textarea) return false;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const next = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, next);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(start + text.length, start + text.length);
  return true;
}

/** Run a shortcut's action from the palette, with the focus back where it was: by its action, so it works whatever its keys are, even none. */
function dispatchShortcut(action: ShortcutAction, previousFocus: HTMLElement | null): void {
  previousFocus?.isConnected && previousFocus.focus({ preventScroll: true });
  if (action.id === "composer.mention" || action.id === "composer.slashCommand") {
    insertComposerText(action.keys[0]);
    return;
  }
  if (action.id === "composer.newLine" && insertComposerText("\n")) return;
  runShortcut(action.id);
}

function githubRepoKey(value: string): string {
  return value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function matchingWorkItemSessions(sessions: SessionEntry[], intent: SmartInput, project: Project | null): SessionEntry[] {
  if (intent.kind !== "github") return [];
  return sessions
    .filter((session) => {
      if (session.archived || !session.issue) return false;
      if (intent.url && session.issue.url.replace(/\/+$/, "") === intent.url) return true;
      return session.issue.provider === "github" && session.issue.identifier === `#${intent.number}` && (!project || session.projectPath === project.path);
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function entityRow<T extends PaletteEntityBase>(
  match: PaletteMatch<T>,
  kind: PaletteRow["kind"],
  run: () => void | Promise<void>,
  extras: Partial<PaletteRow> = {},
): PaletteRow {
  return {
    id: match.item.id,
    kind,
    primary: match.item.primary,
    secondary: match.item.secondary,
    primaryRanges: match.primaryRanges,
    secondaryRanges: match.secondaryRanges,
    run,
    ...extras,
  };
}

export function CommandPalette({
  open,
  onOpenChange,
  onOpenSettings,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onCreated: (sessionId: string, tabId: string, text: string) => void;
}) {
  const store = useSessionStore();
  const status = useStatus();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>("all");
  const deferredQuery = useDeferredValue(query);
  // Settings behind an Experimental switch are listed and found only while it is on; the list follows the switch.
  const switches = useExperimentalSettings();
  const orchestratorRuns = switches?.orchestratorRuns === true;
  const localVmTasks = switches?.localVmTasks === true;
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [statusSessionId, setStatusSessionId] = useState<string | null>(null);
  // Move to section is a view of the palette (design 07.13): these sessions are being given a section.
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const movePending = useRef(false);
  const { sections } = useLocalSections();
  const [settingStatus, setSettingStatus] = useState(false);
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [repoByProject, setRepoByProject] = useState<Record<string, string>>({});
  const [reposLoading, setReposLoading] = useState(false);
  const [resolvedWorkItem, setResolvedWorkItem] = useState<ResolvedWorkItem | null>(null);
  const [workItemLoading, setWorkItemLoading] = useState(false);
  const [startingWorkItem, setStartingWorkItem] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const skipRestoreRef = useRef(false);
  const lookupRef = useRef<{ key: string; promise: Promise<ResolvedWorkItem> } | null>(null);

  const setOpen = useCallback((next: boolean) => {
    onOpenChange(next);
    if (!next && !skipRestoreRef.current) {
      requestAnimationFrame(() => previousFocusRef.current?.isConnected && previousFocusRef.current.focus({ preventScroll: true }));
    }
  }, [onOpenChange]);

  const selectedSession = store.sessions.find((session) => session.id === store.selectedSessionId) ?? null;
  const statusLocalSession = store.sessions.find((session) => session.id === (statusSessionId ?? store.selectedSessionId));
  const statusCloudSession = useCloudSessionForStatus(statusSessionId ?? store.selectedSessionId);
  const statusTarget = useMemo(() => {
    if (statusLocalSession) return {
      key: statusLocalSession.id, title: statusLocalSession.title, manualStatus: statusLocalSession.manualStatus,
      setStatus: (status: ManualStatus) => api.setSessionStatus(statusLocalSession.id, status),
    };
    if (statusCloudSession) return {
      key: statusCloudSession.key, title: statusCloudSession.title, manualStatus: statusCloudSession.manualStatus,
      setStatus: (status: ManualStatus) => updateCloudSession(statusCloudSession, { manualStatus: status }),
    };
    return null;
  }, [statusLocalSession, statusCloudSession]);
  const activeProjectPath = selectedSession?.projectPath ?? store.selectedProject ?? store.lastProject ?? store.projects[0]?.path ?? null;
  const activeProject = store.projects.find((project) => project.path === activeProjectPath) ?? null;
  const preset = store.newSessionPreset;
  const presetRoot = preset?.projectPath === activeProject?.path ? (preset?.cwd ?? null) : null;
  const mainWorkspace = activeProject ? (store.workspaces[activeProject.path] ?? []).find((workspace) => workspace.isMain) : null;
  const fileRoot = selectedSession?.cwd ?? presetRoot ?? mainWorkspace?.path ?? activeProject?.path ?? null;
  const smartInput = useMemo(() => scope === "all" ? parseSmartInput(query) : null, [query, scope]);

  useHotkey("escape", () => {
    if (!open) return false;
    skipRestoreRef.current = false;
    setOpen(false);
    return true;
  }, { enabled: open, global: true });

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope("all");
    setStatusSessionId(null);
    setMoveIds(null);
    setFileHits([]);
    setSelected(0);
    setExpanded({});
    setError(null);
    setResolvedWorkItem(null);
    setStartingWorkItem(false);
    skipRestoreRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    for (const project of store.projects) {
      if (!project.archived && !Object.hasOwn(store.workspaces, project.path)) void refreshWorkspaces(project.path);
    }
  }, [open, store.projects, store.workspaces]);

  useEffect(() => {
    if (!open || !store.projects.length) return;
    let live = true;
    setReposLoading(true);
    void Promise.all(
      store.projects.filter((project) => project.kind !== "folder").map(async (project) => [project.path, await issues.githubRepo(project.path).catch(() => null)] as const),
    ).then((entries) => {
      if (!live) return;
      setRepoByProject(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => !!entry[1])));
      setReposLoading(false);
    });
    return () => {
      live = false;
    };
  }, [open, store.projects]);

  const smartProject = useMemo(() => {
    if (smartInput?.kind !== "github") return null;
    if (!smartInput.owner || !smartInput.repo) return activeProject?.kind === "folder" ? null : activeProject;
    const wanted = `${smartInput.owner}/${smartInput.repo}`.toLowerCase();
    return store.projects.find((project) => project.kind !== "folder" && githubRepoKey(repoByProject[project.path] ?? "") === wanted) ?? null;
  }, [activeProject, repoByProject, smartInput, store.projects]);

  const lookupWorkItem = useCallback(
    (intent: Extract<SmartInput, { kind: "github" }>, project: Project): Promise<ResolvedWorkItem> => {
      const key = `${project.path}:${intent.type}:${intent.number}`;
      if (lookupRef.current?.key === key) return lookupRef.current.promise;
      const promise = (intent.type === "issue"
        ? issues.details(project.path, "github", String(intent.number)).then((issue) => ({
            project,
            number: intent.number,
            title: issue.title,
            url: issue.url,
            issue,
          }))
        : gh.details(project.path, intent.number).then((pullRequest) => ({
            project,
            number: intent.number,
            title: pullRequest.title,
            url: pullRequest.url,
            pullRequest,
          }))) as Promise<ResolvedWorkItem>;
      lookupRef.current = { key, promise };
      return promise;
    },
    [],
  );

  useEffect(() => {
    setResolvedWorkItem(null);
    if (!open || smartInput?.kind !== "github" || !smartProject) {
      setWorkItemLoading(false);
      return;
    }
    let live = true;
    setWorkItemLoading(true);
    void lookupWorkItem(smartInput, smartProject)
      .then((item) => live && setResolvedWorkItem(item))
      .catch(() => live && setResolvedWorkItem(null))
      .finally(() => live && setWorkItemLoading(false));
    return () => {
      live = false;
    };
  }, [lookupWorkItem, open, smartInput, smartProject]);

  useEffect(() => {
    if (!open || scope !== "all" || !fileRoot || !deferredQuery.trim() || smartInput) {
      setFileHits([]);
      setFileLoading(false);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setFileLoading(true);
      void files
        .search(fileRoot, deferredQuery.trim(), 80)
        .then((hits) => live && setFileHits(hits ?? []))
        .catch(() => live && setFileHits([]))
        .finally(() => live && setFileLoading(false));
    }, 45);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [deferredQuery, fileRoot, open, scope, smartInput]);

  const runAction = useCallback(
    (action: ShortcutAction) => dispatchShortcut(action, previousFocusRef.current),
    [],
  );
  const keymap = useKeymap();
  // What of the cloud this account is offered from here: its live organizations' sessions, and a new workspace in the default one.
  const { status: account } = useAccount();
  const switchingEnabled = useOrganizationSwitchingEnabled();
  const privacy = useDataPrivacy();
  const switchTargets = useMemo(() => switchingEnabled ? organizationSwitchTargets(account) : [], [account, switchingEnabled, privacy.enabled]);
  const tabs = switchTargets.length ? [...PALETTE_TABS, ORGANIZATIONS_TAB] : PALETTE_TABS;
  useEffect(() => {
    if (!switchTargets.length && scope === "organizations") setScope("all");
  }, [scope, switchTargets.length]);
  const switchQuery = organizationSwitchQuery(deferredQuery);
  const organizationMode = switchTargets.length > 0 && (scope === "organizations" || (scope === "all" && switchQuery !== null));
  const [rosterCounts, setRosterCounts] = useState<{ account: typeof account; counts: Record<string, number> } | null>(null);
  useEffect(() => {
    if (!open || !organizationMode) return;
    let current = true;
    for (const { org } of switchTargets) {
      if (!org) continue;
      void readOrganizationRoster(org.id).then((roster) => {
        if (current) setRosterCounts((previous) => ({
          account,
          counts: { ...(previous?.account === account ? previous.counts : {}), [org.id]: roster.members.length },
        }));
      }).catch(() => {});
    }
    return () => { current = false; };
  }, [account, open, organizationMode, switchTargets]);
  const cloud = useMemo(() => {
    const live = liveCloudOrgIds(account);
    const defaultOrg = defaultOrgId(account);
    return {
      live: live.length > 0,
      mayCreate: !!defaultOrg && live.includes(defaultOrg) && mayStartCloudSessions(account, defaultOrg) === true,
      orgName: account.identity?.organization ?? "your default organization",
    };
  }, [account]);

  const commandEntries = useMemo<CommandEntry[]>(() => {
    // An action behind an Experimental switch that is off (Bots) is not offered.
    const shortcutEntries = SHORTCUT_ACTIONS.filter((shortcut) => !shortcut.requires || switches?.[shortcut.requires] === true).map((shortcut, index) =>
      indexPaletteItem({
        id: `command:shortcut:${shortcut.id}`,
        group: "commands" as const,
        primary: shortcut.label,
        // One line each: an action says more than its name only when it has something to say (design 07.04).
        secondary: shortcut.id === "app.home" ? "Open the welcome screen" : "",
        recentAt: SHORTCUT_ACTIONS.length - index,
        icon: shortcutIcon(shortcut),
        shortcut: true,
        session: shortcut.group !== "App",
        chord: keymap[shortcut.id][0],
        run: () => runAction(shortcut),
      }, [...keymap[shortcut.id], `${shortcut.group} shortcut`]),
    );
    const inSection = selectedSession ? sections.find((section) => section.sessions.includes(selectedSession.id)) : undefined;
    const extras: CommandEntry[] = [
      ...(statusTarget ? [indexPaletteItem({
        id: "command:session-status", group: "commands" as const, primary: "Set status…",
        secondary: manualStatusLabel(statusTarget.manualStatus),
        recentAt: 25, icon: CircleDot, keepOpen: true, session: true,
        run: () => { setStatusSessionId(statusTarget.key); setQuery(""); setSelected(0); setError(null); },
      }, [statusTarget.title, "session backlog progress review done canceled workflow"])] : []),
      indexPaletteItem({
        id: "command:status-toggle",
        group: "commands" as const,
        primary: "Toggle status bar",
        secondary: status.settings.visible ? "Currently shown" : "Currently hidden",
        recentAt: 20,
        icon: Gauge,
        run: () => void setStatusSettings({ visible: !status.settings.visible }),
      }),
      indexPaletteItem({
        id: "command:usage-used",
        group: "commands" as const,
        primary: "Show usage as Used",
        secondary: status.settings.percent === "used" ? "Current percentage display" : "Status bar percentage display",
        recentAt: 19,
        icon: BarChart3,
        run: () => void setStatusSettings({ percent: "used" }),
      }, ["used remaining percent"]),
      indexPaletteItem({
        id: "command:usage-remaining",
        group: "commands" as const,
        primary: "Show usage as Remaining",
        secondary: status.settings.percent === "remaining" ? "Current percentage display" : "Status bar percentage display",
        recentAt: 18,
        icon: BarChart3,
        run: () => void setStatusSettings({ percent: "remaining" }),
      }, ["used remaining percent"]),
      ...THEMES.map((item, index) =>
        indexPaletteItem({
          id: `command:theme:${item.id}`,
          group: "commands" as const,
          primary: `Theme: ${item.name}`,
          secondary: theme.theme === item.id ? "Current theme" : "Change the application theme",
          recentAt: 10 - index,
          icon: Palette,
          run: () => setTheme(item.id),
        }),
      ),
      indexPaletteItem({ id: "command:mode:system", group: "commands" as const, primary: "Appearance: System", secondary: theme.mode === "system" ? "Current appearance" : "Follow the system appearance", recentAt: 5, icon: Palette, run: () => setMode("system") }),
      indexPaletteItem({ id: "command:mode:light", group: "commands" as const, primary: "Appearance: Light", secondary: theme.mode === "light" ? "Current appearance" : "Use the light appearance", recentAt: 4, icon: Sun, run: () => setMode("light") }),
      indexPaletteItem({ id: "command:mode:dark", group: "commands" as const, primary: "Appearance: Dark", secondary: theme.mode === "dark" ? "Current appearance" : "Use the dark appearance", recentAt: 3, icon: Moon, run: () => setMode("dark") }),
      indexPaletteItem({ id: "command:settings:search", group: "commands" as const, primary: "Search settings…", secondary: "Find a setting by name and open it", recentAt: 2, icon: Settings, keepOpen: true, run: () => { setScope("settings"); setQuery(""); setSelected(0); } }, ["preferences options configure"]),
      indexPaletteItem({ id: "command:new-issue", group: "commands" as const, primary: "New issue…", secondary: "Create a GitHub or Linear issue for the project", recentAt: 2, icon: CircleDot, run: () => openNewIssue() }, ["issue create new bug feature github linear ticket"]),
      indexPaletteItem({ id: "command:pair-phone", group: "commands" as const, primary: "Pair a phone…", secondary: `Drive ${thisComputer}'s sessions from the TerminalX phone app`, recentAt: 2, icon: Smartphone, run: () => openPairPhone() }, ["phone iphone android mobile pair pairing device qr remote"]),
      indexPaletteItem({ id: "command:worktree-cleanup", group: "commands" as const, primary: "Clean up worktrees…", secondary: "Review and remove safe worktrees across open projects, here and on cloud workspaces", recentAt: 2, icon: Trash2, run: () => openWorktreeCleanup() }, ["worktree workspace cleanup disk space remove delete prune"]),
      indexPaletteItem({ id: "command:local-section:create", group: "commands" as const, primary: "New section…", secondary: "Group sessions across local projects", recentAt: 2, icon: FolderPlus, run: () => openSectionDialog({ kind: "create" }) }, ["create sidebar local section"]),
      ...(selectedSession && !store.selectedCloudWorkspace ? [indexPaletteItem({ id: "command:local-section:move", group: "commands" as const, primary: "Move to section…", secondary: inSection ? `In ${inSection.name}` : "", recentAt: 3, icon: FolderInput, keepOpen: true, session: true, run: () => { setMoveIds([selectedSession.id]); setQuery(""); setError(null); } }, [conversationTitle(selectedSession), "move session sidebar section"])] : []),
      // The start screen's three ways to a project, for after the first one exists.
      ...START_ACTIONS.map((action, index) =>
        indexPaletteItem({
          id: `command:add-project:${action.id}`,
          group: "commands" as const,
          primary: `Add a project: ${action.label}`,
          secondary: action.hint,
          recentAt: 3 - index,
          icon: START_ACTION_ICONS[action.id],
          // The palette is closed by then, so a failed folder picker has nowhere to be shown.
          run: () => Promise.resolve(action.run()).then(() => {}, (cause) => console.error("add project failed", cause)),
        }, ["add project new open clone create folder repository github quick start"]),
      ),
      // Narrows the palette to cloud sessions (by kind, not by the word "cloud"). Choosing one only selects it.
      ...(cloud.live
        ? [indexPaletteItem({ id: "command:cloud-go", group: "commands" as const, primary: "Go to cloud session…", secondary: "List the sessions in your organizations' cloud workspaces", recentAt: 1, icon: Cloud, keepOpen: true, run: () => { setScope("cloud"); setQuery(""); setSelected(0); } }, ["cloud workspace session open"])]
        : []),
      // Creating a workspace is an owner's or admin's; nobody else is offered it.
      ...(cloud.mayCreate
        ? [indexPaletteItem({ id: "command:cloud-new-workspace", group: "commands" as const, primary: "New cloud workspace…", secondary: `A new machine in ${cloud.orgName}: repositories, first prompt and price`, recentAt: 1, icon: Cloud, run: () => openNewCloudWorkspace() }, ["cloud workspace create vm"])]
        : []),
    ];
    // PRO-363: the open local session's project actions and preview URLs, as the header's Run menu and Open button list them.
    const runProject = selectedSession && !store.selectedCloudWorkspace ? store.projects.find((project) => project.path === selectedSession.projectPath) : undefined;
    const runVisible = runProject ? visibleActions(runProject.actions ?? []) : [];
    const runEntries: CommandEntry[] = selectedSession && offersRunMenu(selectedSession, runProject)
      ? [
          // ⌘R runs an action only when it is the only one; with several it opens the Run menu, which shows the key.
          ...runVisible.map((action, index) => indexPaletteItem({
            id: `command:run-action:${action.id}`, group: "commands" as const, primary: `Run ${action.name}`, secondary: action.command,
            recentAt: 30 - index, icon: Play, session: true, chord: runVisible.length === 1 ? keymap["session.runAction"][0] : undefined,
            run: () => startAction(selectedSession, action),
          }, ["run action start script"])),
          ...(runProject.previewUrls ?? []).map((preview, index) => indexPaletteItem({
            id: `command:open-preview:${preview.id}`, group: "commands" as const, primary: `Open ${preview.name}`, secondary: preview.url,
            recentAt: 28 - index, icon: Globe, session: true,
            run: () => openPreview(selectedSession, preview),
          }, ["open preview url browser"])),
        ]
      : [];
    return [...runEntries, ...shortcutEntries, ...extras];
  }, [sections, store.projects, selectedSession, statusTarget, store.selectedCloudWorkspace, cloud.live, cloud.mayCreate, cloud.orgName, runAction, keymap, status.settings.percent, status.settings.visible, theme.mode, theme.theme, switches]);

  const fileEntries = useMemo<FileEntry[]>(
    () => fileHits.map((hit, index) => indexPaletteItem({
      id: `file:${hit.path}`,
      group: "files" as const,
      primary: hit.name,
      secondary: directory(hit.path),
      recentAt: fileHits.length - index,
      hit,
    }, [hit.path])),
    [fileHits],
  );

  const openFileHit = useCallback(
    async (hit: FileHit) => {
      if (!fileRoot) return;
      let session = selectedSession;
      if (!session || cleanPath(session.cwd) !== cleanPath(fileRoot)) {
        // A quick chat has no project to open a workspace in; its own folder is the session on screen, handled above.
        if (!activeProject) return;
        session = await openWorkspace(activeProject.path, fileRoot);
      }
      openFile(session.id, fileRoot, hit.path);
    },
    [activeProject, fileRoot, selectedSession],
  );

  const startWorkItem = useCallback(async () => {
    if (smartInput?.kind !== "github" || !smartProject) return;
    const harness = store.harnesses.find((item) => item.available);
    if (!harness) {
      setError("Install and sign in to an agent before starting this work.");
      return;
    }
    setStartingWorkItem(true);
    setError(null);
    try {
      const item = resolvedWorkItem ?? (await lookupWorkItem(smartInput, smartProject));
      // An issue's discussion is read before its session exists, so the first prompt is ready when the tab is.
      const issuePrompt = item.issue ? await issuePromptWithComments(item.project.path, item.issue) : null;
      const prefs = getPrefs();
      const identifier = `#${item.number}`;
      const session = await api.createSession({
        projectPath: item.project.path,
        title: `${identifier} ${item.title}`.slice(0, 80),
        useWorktree: true,
        ...(item.pullRequest ? { checkoutPr: item.number } : {}),
        worktreeName: issueWorktreeName(identifier, item.title),
        ...(item.issue ? { issue: { provider: "github" as const, id: item.issue.id, identifier, title: item.title, url: item.url } } : {}),
        tab: {
          harness: harness.id,
          model: prefs.lastModel[harness.id] ?? "",
          effort: prefs.lastEffort[harness.id] ?? null,
          permissionMode: prefs.lastMode,
        },
      });
      upsertSession(session);
      selectSession(session.id);
      skipRestoreRef.current = true;
      setOpen(false);
      const tab = session.tabs[0];
      if (tab) {
        let prompt = issuePrompt ?? pullRequestPrompt(item.pullRequest!);
        // An issue is carried on to a pull request and a review, with the
        // project's default for the merge. A pull request already is one.
        if (item.issue && pipelineSettings(item.project).enabled) {
          try {
            prompt = `${prompt}\n\n${(await startPipeline(session.id, tab.id, null)).authorBrief}`;
          } catch (cause) {
            console.error("issue pipeline did not start", cause);
          }
        }
        onCreated(session.id, tab.id, prompt);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStartingWorkItem(false);
    }
  }, [lookupWorkItem, onCreated, resolvedWorkItem, setOpen, smartInput, smartProject, store.harnesses]);

  // Cloud sessions of every live organization sit among the sessions (PRO-23 CS-19).
  const cloudSessions = useCloudDashboard();
  const { visibleIds, selectedOrganization } = useOrganizationVisibility();
  const { organizationDisplay } = usePrefs();
  const currentOrganization = (organizationDisplay === "one" ? selectedOrganization : null) ?? switchTargets[0]?.id;
  // And their projects among the projects, each named with its organization (a hidden organization's only when searched for, like its sessions).
  const cloudProjects = useCloudProjectChoices();
  const paletteIndex = useMemo(() => {
    const projects = cloudProjects
      .filter((org) => deferredQuery.trim() || visibleIds.has(org.orgId))
      .flatMap((org) => org.projects.map((project) => ({ ...project, orgName: org.orgName, workspaces: project.workspaces.map((node) => ({ name: node.item.workspace.name, lastActivity: lastActivity(node.item.workspace) })) })));
    return withCloudProjects(
      withCloudSessions(store.paletteIndex, buildCloudPaletteSessions(visiblePaletteSessions(cloudSessions, visibleIds, deferredQuery), store.harnesses)),
      buildCloudPaletteProjects(projects),
    );
  }, [store.paletteIndex, cloudSessions, cloudProjects, store.harnesses, visibleIds, deferredQuery]);

  // The open session's title: what "This session" is, and what Move to section moves.
  const sessionTitle = selectedSession ? conversationTitle(selectedSession) : (statusTarget?.title ?? null);
  const movedSession = moveIds?.length === 1 ? store.sessions.find((session) => session.id === moveIds[0]) : undefined;
  const moveTitle = !moveIds ? "" : moveIds.length > 1 ? `${moveIds.length} sessions` : movedSession ? conversationTitle(movedSession) : "this session";
  const leaveSubview = useCallback(() => {
    setMoveIds(null);
    setStatusSessionId(null);
    setScope("actions");
    setQuery("");
    setError(null);
    inputRef.current?.focus();
  }, []);
  /** Save a section edit from the Move to section view: the palette closes when it is saved and says why when it is not. */
  const moveTo = useCallback(async (edit: LocalSectionEdit) => {
    if (movePending.current) return;
    movePending.current = true;
    setError(null);
    try {
      await editLocalSection(edit);
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      movePending.current = false;
    }
  }, [setOpen]);

  const groups = useMemo<PaletteGroup[]>(() => {
    if (moveIds) {
      // Its own small list, filtered as typed: not deferred, so the row under the cursor is never a stale one.
      const listed = new Set(store.sessions.filter((session) => !session.archived).map((session) => session.id));
      const { choices, createName } = sectionChoices(sections, moveIds, query, (id) => listed.has(id));
      const line = { kind: "command" as const, layout: "line" as const, primaryRanges: [], secondaryRanges: [], closeBefore: false };
      const sectionRows: PaletteRow[] = choices.map((choice) => ({
        ...line,
        id: `palette:section:${choice.section.id}`,
        primary: choice.section.name,
        secondary: "",
        primaryRanges: choice.nameRanges,
        icon: Folder,
        emoji: choice.section.emoji?.trim() || undefined,
        trailing: `${choice.count} ${choice.count === 1 ? "session" : "sessions"}`,
        checked: choice.current,
        // Already there: choosing it again changes nothing, so nothing is sent.
        run: () => (choice.current ? setOpen(false) : moveTo({ kind: "move", sessionIds: moveIds, sectionId: choice.section.id })),
      }));
      if (query.trim()) {
        return [
          { id: "sections", label: "", rows: sectionRows },
          {
            id: "section-actions",
            label: "",
            divider: true,
            ...(choices.length ? {} : { note: { title: "No matching sections", detail: `${sections.length} local ${sections.length === 1 ? "section" : "sections"}` } }),
            rows: createName ? [{
              ...line,
              id: "palette:section-create-named",
              primary: `New section “${createName}”`,
              secondary: `and move ${moveTitle} into it`,
              icon: FolderPlus,
              enterHint: true,
              run: () => moveTo({ kind: "create", name: createName, emoji: null, sessionIds: moveIds }),
            }] : [],
          },
        ];
      }
      const home = movedSession && movedSession.kind !== "quick" ? store.projects.find((project) => project.path === movedSession.projectPath)?.name : undefined;
      const inAny = sections.some((section) => section.sessions.some((id) => moveIds.includes(id)));
      return [
        { id: "sections", label: "", rows: sectionRows },
        {
          id: "section-actions",
          label: "",
          divider: true,
          rows: [
            // The name and emoji are asked for in the section dialog, which then moves the session into it.
            { ...line, id: "palette:section-create", primary: "New section…", secondary: "", icon: FolderPlus, closeBefore: undefined, run: () => openSectionDialog({ kind: "create", sessionIds: moveIds }) },
            ...(inAny ? [{
              ...line,
              id: "palette:section-remove",
              primary: "Remove from section",
              secondary: home ? `Back under ${home}` : "Back in the main list",
              icon: FolderMinus,
              run: () => moveTo({ kind: "move", sessionIds: moveIds, sectionId: null }),
            }] : []),
          ],
        },
      ];
    }
    if (statusSessionId) {
      if (!statusTarget) return [{ id: "statuses", label: "Status is unavailable for this session", rows: [] }];
      return [{ id: "statuses", label: `Set status · ${statusTarget.title}`, rows: MANUAL_STATUSES
        .filter((status) => manualStatusLabel(status).toLocaleLowerCase().includes(deferredQuery.toLocaleLowerCase()))
        .map((status) => ({
          id: `status:${status}`, kind: "command", layout: "line", primary: manualStatusLabel(status),
          secondary: status === normalizeManualStatus(statusTarget.manualStatus) ? "Current status" : "", primaryRanges: [], secondaryRanges: [], manualStatus: status,
          closeBefore: false,
          run: async () => {
            if (settingStatus) return;
            setSettingStatus(true); setError(null);
            try { await statusTarget.setStatus(status); setOpen(false); }
            catch (cause) { setError(errorMessage(cause)); }
            finally { setSettingStatus(false); }
          },
        })) }];
    }
    // Settings are found by row (PRO-127): a row opens Settings on that row and
    // highlights it. With nothing typed, the pages are listed instead.
    const settingsMatches = searchSettings(deferredQuery);
    const settingsGroup: PaletteGroup = deferredQuery.trim()
      ? {
          id: "settings",
          label: "Settings",
          rows: settingsMatches.map((match) => {
            const page = `${match.sectionTitle} · `;
            return {
              id: `palette:setting:${match.id}`,
              kind: "command",
              primary: match.row.title,
              secondary: match.row.description ? `${page}${match.row.description}` : match.sectionTitle,
              primaryRanges: match.titleRanges,
              secondaryRanges: match.row.description
                ? match.descriptionRanges.map((range) => ({ start: range.start + page.length, end: range.end + page.length }))
                : [],
              icon: SETTINGS_PAGE_ICONS[match.section],
              run: () => onOpenSettings(match.id),
            };
          }),
        }
      : {
          id: "settings-pages",
          label: "Settings pages",
          rows: SETTINGS_PAGES.filter((page) => settingsSectionOffered(page.id)).map((page) => ({
            id: `palette:settings-page:${page.id}`,
            kind: "command",
            primary: page.title,
            secondary: page.description,
            primaryRanges: [],
            secondaryRanges: [],
            icon: SETTINGS_PAGE_ICONS[page.id],
            layout: "page",
            run: () => onOpenSettings(page.id),
          })),
        };
    // Under the pages, each project's own settings (design 07.05): the repositories Settings lists.
    const settingsProjectsGroup: PaletteGroup = {
      id: "settings-projects",
      label: "Projects",
      rows: store.projects.filter((project) => !project.archived).map((project) => ({
        id: `palette:settings-project:${project.path}`,
        kind: "command",
        primary: project.name,
        secondary: "Scripts, files to copy and workspace cleanup",
        primaryRanges: [],
        secondaryRanges: [],
        icon: FolderGit2,
        project,
        layout: "page",
        run: () => requestProjectSettings(project.path),
      })),
    };
    if (scope === "settings") return deferredQuery.trim() ? [settingsGroup] : [settingsGroup, settingsProjectsGroup];
    const entityMatches = searchPaletteIndex(paletteIndex, deferredQuery);
    // With an open session its actions are a group of their own, under its title; without one, every action is the app's.
    const sessionEntries = sessionTitle ? commandEntries.filter((entry) => entry.session) : [];
    const appEntries = sessionTitle ? commandEntries.filter((entry) => !entry.session) : commandEntries;
    // The project's own Run and Open entries lead the session's actions, as they did the list.
    const projectActions = sessionEntries.filter((entry) => /^command:(run-action|open-preview):/.test(entry.id)).map((entry) => entry.id);
    const sessionMatches = rankPaletteItems(orderPaletteItems(sessionEntries, [...projectActions, ...SESSION_ACTIONS_FIRST]), deferredQuery);
    const appMatches = rankPaletteItems(orderPaletteItems([...appEntries.filter((entry) => !APP_ACTIONS_LAST.includes(entry.id)), ...APP_ACTIONS_LAST.flatMap((id) => appEntries.filter((entry) => entry.id === id))], APP_ACTIONS_FIRST), deferredQuery);
    const rankedFiles = deferredQuery.trim() ? rankPaletteItems(fileEntries, deferredQuery) : [];
    const smartRows: PaletteRow[] = [];

    if (smartInput?.kind === "path") {
      const path = cleanPath(smartInput.path);
      const match = store.paletteIndex.workspaces
        .filter((item) => path === cleanPath(item.workspace.path) || path.startsWith(`${cleanPath(item.workspace.path)}/`))
        .sort((a, b) => b.workspace.path.length - a.workspace.path.length)[0];
      if (match) {
        smartRows.push({
          id: `smart:${match.id}`,
          kind: "smart-workspace",
          primary: `Open ${match.primary}`,
          secondary: `${match.projectName} · ${match.workspace.path}`,
          primaryRanges: [],
          secondaryRanges: [],
          run: () => void openWorkspace(match.projectPath, match.workspace.path),
        });
      }
    }

    if (smartInput?.kind === "github") {
      for (const session of matchingWorkItemSessions(store.sessions, smartInput, smartProject)) {
        smartRows.push({
          id: `smart:session:${session.id}`,
          kind: "smart-session",
          primary: `Open ${session.title}`,
          secondary: `${store.projects.find((project) => project.path === session.projectPath)?.name ?? session.projectPath} · active session`,
          primaryRanges: [],
          secondaryRanges: [],
          agentId: session.tabs[0]?.harness,
          run: () => selectSession(session.id),
        });
      }
      if (smartProject) {
        const kind = smartInput.type === "pull" ? "pull request" : "issue";
        smartRows.push({
          id: `smart:start:${smartProject.path}:${smartInput.type}:${smartInput.number}`,
          kind: "smart-start",
          primary: resolvedWorkItem ? `Start #${smartInput.number} ${resolvedWorkItem.title}` : `Start ${kind} #${smartInput.number}`,
          secondary: `${smartProject.name} · new worktree${workItemLoading ? " · looking up details…" : ""}`,
          primaryRanges: [],
          secondaryRanges: [],
          icon: smartInput.type === "issue" ? CircleDot : GitPullRequest,
          run: startWorkItem,
          closeBefore: false,
        });
      }
    }

    const sessionRows = entityMatches.sessions.map((match) => entityRow(
      { ...match, item: { ...match.item, secondary: `${match.item.secondary} · ${relativeTime(match.item.modified)}` } },
      "session",
      // A cloud session is selected, never woken (PRO-23 CS-19).
      () => (match.item.cloudKey ? openCloudSession(match.item.cloudKey) : selectSession(match.item.sessionId)),
      { agentId: match.item.agentIds[0] },
    ));
    const workspaceRows = entityMatches.workspaces.map((match) => entityRow(match, "workspace", () => void openWorkspace(match.item.projectPath, match.item.workspace.path)));
    const projectRows = entityMatches.projects.map((match) => {
      const { project, cloudKey } = match.item;
      // A cloud project opens its new-session form like a local one (a member's only focuses it); nothing is woken.
      if (cloudKey) return entityRow(match, "project", () => startCloudSessionIn(cloudKey), { icon: Cloud });
      return entityRow(match, "project", () => {
        selectProjectInSidebar(project!.path);
        startSessionIn(project!.path, null);
      }, { project });
    });
    const fileRows = rankedFiles.map((match) => entityRow(match, "file", () => void openFileHit(match.item.hit)));
    const commandRow = (match: PaletteMatch<CommandEntry>) => entityRow(match, "command", match.item.run, {
      ...(match.item.keepOpen ? { closeBefore: false } : {}),
      layout: "line",
      chord: match.item.chord,
      icon: match.item.icon,
      restoreFocus: !!match.item.shortcut,
    });

    if (organizationMode) {
      const organizationRows = switchTargets.flatMap(({ id, org }, position) => {
        const members = org && rosterCounts?.account === account ? rosterCounts.counts[id] : undefined;
        const entry = indexPaletteItem({
          id: `palette:organization:${id}`, group: "organizations",
          primary: org ? `Switch to ${organizationName(org)}` : "Only this Mac",
          secondary: org ? (members === undefined ? "" : `${members} member${members === 1 ? "" : "s"}`) : "Local sessions, nothing shared",
          recentAt: 0,
        });
        const [match] = rankPaletteItems([entry], switchQuery ?? deferredQuery);
        if (!match) return [];
        const shortcut = ORGANIZATION_SHORTCUTS[position];
        return [entityRow(match, "command", () => { switchOrganization(id); }, {
          layout: "line",
          icon: Laptop,
          organizationInitial: org ? Array.from(organizationName(org).trim())[0]?.toLocaleUpperCase() : undefined,
          chord: shortcut && keymap[shortcut.id][0],
          current: id === currentOrganization,
          closeBefore: false,
        })];
      });
      const local = currentOrganization === ONLY_THIS_MAC;
      const scopedSessions = entityMatches.sessions.flatMap(({ item }, index) => {
        const workspace = item.cloudKey && parseCloudWorkspaceKey(item.cloudKey);
        return (local ? !item.cloudKey : workspace && workspace.orgId === currentOrganization) ? [sessionRows[index]] : [];
      });
      const currentOrg = switchTargets.find((target) => target.id === currentOrganization)?.org;
      const sessionLocation = currentOrg ? organizationName(currentOrg) : "this Mac";
      return [
        { id: "organizations", label: "Organizations", rows: organizationRows, emptyText: "No organizations match" },
        { id: "organization-actions", label: "Actions", rows: [
          {
            id: "palette:organizations:create", kind: "command", layout: "line", icon: Building,
            primary: "Create organization…", secondary: "", primaryRanges: [], secondaryRanges: [],
            run: () => onOpenSettings("organizations.create"),
          },
          {
            id: "palette:organizations:settings", kind: "command", layout: "line", icon: Settings,
            primary: "Organization settings", secondary: "", primaryRanges: [], secondaryRanges: [],
            run: () => { if (currentOrg) openOrganizationSettings(currentOrg.id); else onOpenSettings("organizations"); },
          },
        ] },
        {
          id: "sessions",
          label: deferredQuery.trim() ? `Results for “${deferredQuery.trim()}” in ${sessionLocation}` : `Sessions in ${sessionLocation}`,
          rows: scopedSessions,
          emptyText: local ? "No sessions on this Mac match" : "No sessions on the server match",
        },
      ];
    }
    if (scope === "cloud") {
      const cloudRows = entityMatches.sessions.flatMap((match, index) => (match.item.cloudKey ? [sessionRows[index]] : []));
      return [{ id: "sessions", label: "Cloud sessions", rows: cloudRows }];
    }
    const searched = !!deferredQuery.trim();
    // A strong settings match ("font") should beat a fuzzy command; an exact
    // command ("Home") should still win over incidental settings keywords.
    const commandGroups: PaletteGroup[] = [
      { id: "session-actions", label: "This session", labelDetail: sessionTitle ?? undefined, rows: sessionMatches.map(commandRow) },
      { id: "commands", label: "App", rows: appMatches.map(commandRow) },
    ];
    const settingsFirst = searched && (settingsMatches[0]?.score ?? Infinity) < Math.min(sessionMatches[0]?.score ?? Infinity, appMatches[0]?.score ?? Infinity);
    return [
      { id: "smart", label: "Smart input", rows: smartRows },
      { id: "sessions", label: searched ? "Sessions" : "Recent sessions", rows: sessionRows },
      { id: "workspaces", label: searched ? "Workspaces" : "Recent workspaces", rows: workspaceRows },
      { id: "projects", label: searched ? "Projects" : "Recent projects", rows: projectRows },
      { id: "files", label: activeProject ? `Files · ${activeProject.name}` : "Files", rows: fileRows },
      ...(settingsFirst ? [settingsGroup, ...commandGroups] : [...commandGroups, settingsGroup]),
    ].filter((group) => paletteScopeShows(scope, group.id));
  }, [moveIds, movedSession, moveTitle, moveTo, sections, query, sessionTitle, statusSessionId, statusTarget, settingStatus, setOpen, scope, onOpenSettings, activeProject, commandEntries, deferredQuery, fileEntries, openFileHit, resolvedWorkItem, smartInput, smartProject, startWorkItem, paletteIndex, store.paletteIndex, store.projects, store.sessions, workItemLoading, orchestratorRuns, localVmTasks, organizationMode, switchTargets, switchQuery, rosterCounts, account, currentOrganization, keymap]);

  const renderedGroups = useMemo(() => {
    let offset = 0;
    return groups.flatMap((group) => {
      if (!group.rows.length && !group.note && !group.emptyText) return [];
      // The Actions tab is the whole list, scrolled (design 07.04); elsewhere a group shows its first few.
      const cap = expanded[group.id] || scope === "actions" || group.id === "organizations" ? group.rows.length : (GROUP_CAPS[group.id] ?? 8);
      const rows = group.rows.slice(0, cap);
      const rendered = { ...group, rows, offset, more: group.rows.length - rows.length };
      offset += rows.length;
      return rendered;
    });
  }, [expanded, groups, scope]);
  const selectableRows = useMemo(() => renderedGroups.flatMap((group) => group.rows), [renderedGroups]);

  useEffect(() => {
    // Move to section opens on the section the session is in, so Enter alone never takes it out of one (PRO-401).
    // The sections are read as they are when the view opens or the query changes, not followed.
    const current = moveIds && !query ? sectionChoices(sections, moveIds, "", () => true).choices.findIndex((choice) => choice.current) : -1;
    setSelected(Math.max(0, current));
    setExpanded({});
    listRef.current?.scrollTo(0, 0);
  }, [query, scope, moveIds]);

  useEffect(() => {
    // Clamp the row chosen last, not the one this render saw: the effect above may have just chosen one. Opening Move to
    // section from row 8 of the Actions list saw 8 here, past the view's six rows, and put the cursor on Remove from
    // section, the row Enter then ran (PRO-401).
    setSelected((current) => (current >= selectableRows.length ? Math.max(0, selectableRows.length - 1) : current));
  }, [selectableRows.length, selected]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = useCallback(
    (row: PaletteRow) => {
      if (row.closeBefore === false) {
        void row.run();
        // A row clicked with the mouse took the focus, and may be gone now: typing and Enter stay with the search.
        inputRef.current?.focus();
        return;
      }
      skipRestoreRef.current = !row.restoreFocus;
      setOpen(false);
      requestAnimationFrame(() => void row.run());
    },
    [setOpen],
  );

  const subview = moveIds ? "move" : statusSessionId ? "status" : null;
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setSelected((current) => movePaletteSelection(current, selectableRows.length, event.key as PaletteNavigationKey));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = selectableRows[selected];
      if (row && !startingWorkItem) choose(row);
    } else if (event.key === "Backspace" && subview && !query) {
      leaveSubview();
    } else if (event.key === "Tab" && !subview && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // Tab switches tabs (design 07.04); the query is kept.
      event.preventDefault();
      setScope(stepPaletteTab(paletteTabOf(scope), event.shiftKey ? -1 : 1, tabs));
    } else if (event.key === "Backspace" && scope !== "all" && !query) {
      // Backspace on an empty search returns to every group.
      setScope("all");
    }
  };

  const orgFooter = organizationMode && !subview;
  const defaultOrgChords = ORGANIZATION_SHORTCUTS.every(({ id }) => keymap[id][0] === defaultBindings(id)[0]);
  const orgChordHint = isMac ? "⌃1–⌃9" : "Ctrl+Alt+Shift+1–9";
  const searching = !organizationMode && (scope === "all" || scope === "cloud") && (fileLoading || workItemLoading || reposLoading);
  const tab = paletteTabOf(scope);
  const empty = !selectableRows.length && !searching;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showClose={false}
        width="max-w-[42.5rem]"
        // A fixed top (design 07.04: 96px), not centred in what is left: the palette stays where it is whatever it lists.
        className={cn("bottom-auto top-24 max-h-[calc(100dvh-7rem)] gap-0 overflow-hidden p-0", orgFooter && "flex flex-col")}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!skipRestoreRef.current && previousFocusRef.current?.isConnected) previousFocusRef.current.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search sessions, workspaces, projects, files, settings, views and commands</DialogDescription>
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={subview === "move" ? "Search sections…" : subview === "status" ? "Search statuses…" : palettePlaceholder(scope)}
            aria-label="Command palette search"
            aria-controls="command-palette-results"
            aria-activedescendant={selectableRows[selected]?.id}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          {searching && <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" aria-label="Searching" />}
          <Keycap>{keycaps("escape")[0]}</Keycap>
        </div>

        {subview ? (
          // A view of one action (design 07.13): the way back, and what it acts on.
          <div className="flex h-10 items-center gap-2 border-b border-hairline px-3 text-[12.5px]">
            <button
              type="button"
              className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-veil-strong px-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={leaveSubview}
            >
              <ArrowLeft className="size-3" aria-hidden />
              Back to actions
            </button>
            <span className="shrink-0 text-faint">{subview === "move" ? "Move" : "Set status of"}</span>
            <span className="min-w-0 truncate text-foreground">{subview === "move" ? moveTitle : (statusTarget?.title ?? "this session")}</span>
            {subview === "move" && <span className="shrink-0 text-faint">to a section</span>}
          </div>
        ) : (
          <div role="tablist" aria-label="Search in" className={cn("flex h-10 shrink-0 items-center gap-1 border-b border-hairline px-2.5", switchTargets.length > 0 && "overflow-x-auto")}>
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                tabIndex={-1}
                className={cn(
                  "flex h-7 items-center rounded-md px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  tab === item.id ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
                )}
                onClick={() => {
                  // Under Sessions, the cloud-only list widens to every session.
                  setScope(item.id);
                  inputRef.current?.focus();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {error && <div role="alert" className="mx-3 mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}

        <div ref={listRef} id="command-palette-results" role="listbox" aria-label="Results" className={cn(
          "overflow-y-auto px-1.5 pb-1.5 scrollbar-thin",
          orgFooter ? "h-[23.75rem] min-h-0" : "max-h-[min(35rem,calc(100dvh-15rem))]",
          subview && "pt-1.5",
        )}>
          {renderedGroups.map((group, at) => (
            <section key={group.id} role="group" {...(group.label ? { "aria-labelledby": `palette-group-${group.id}` } : { "aria-label": group.id === "sections" ? "Sections" : "More" })}>
              {group.note && (
                <div role="status" className="py-5 text-center">
                  <p className="text-[13px] text-muted-foreground">{group.note.title}</p>
                  <p className="mt-0.5 text-xs text-faint">{group.note.detail}</p>
                </div>
              )}
              {group.divider && (at > 0 || group.note) && group.rows.length > 0 && <div className="my-1 border-t border-hairline" />}
              {group.label && (
                <h2 id={`palette-group-${group.id}`} className="truncate px-2.5 pb-1 pt-3 text-xs uppercase tracking-[.08em] text-faint">
                  {group.label}
                  {group.labelDetail && <> · <span className="normal-case tracking-normal">{group.labelDetail}</span></>}
                </h2>
              )}
              {group.emptyText && !group.rows.length && (
                <p role="status" className="flex h-9 items-center gap-2 px-2.5 text-[12.5px] text-faint">
                  <Search className="size-3.5 shrink-0" aria-hidden />
                  {group.emptyText}
                </p>
              )}
              {group.rows.map((row, index) => {
                const paletteIndex = group.offset + index;
                return (
                  <PaletteResultRow
                    key={row.id}
                    row={row}
                    index={paletteIndex}
                    selected={selected === paletteIndex}
                    busy={startingWorkItem && row.kind === "smart-start"}
                    onHover={setSelected}
                    onSelect={choose}
                  />
                );
              })}
              {group.more > 0 && (
                <button
                  type="button"
                  className="mx-2 mt-1 rounded-md px-2 py-1 text-xs text-faint outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => {
                    setExpanded((current) => ({ ...current, [group.id]: true }));
                    inputRef.current?.focus();
                  }}
                >
                  {group.more} more
                </button>
              )}
            </section>
          ))}
          {empty && (
            <div className="px-5 py-10 text-center">
              <p role="status" className="text-sm text-muted-foreground">{scope === "settings" ? `No settings match ${query.trim()}` : "No results match this search."}</p>
              {scope === "all" && !subview && <p className="mt-1 text-xs text-faint">Try a session, branch, project, file path, setting, issue, pull request or command.</p>}
            </div>
          )}
        </div>

        <div className={cn("flex shrink-0 items-center border-t border-hairline px-4 text-xs text-faint",
          orgFooter ? "min-h-9 flex-wrap gap-x-4 gap-y-1 py-1.5" : "h-9 gap-4 whitespace-nowrap")}>
          {subview === "move" ? (
            // Design 07.13 and 07.14: what Enter does to the row under the cursor, and the way back.
            <>
              <span>{selectableRows[selected]?.id === "palette:section-create-named" ? "↵ create and move" : "↵ move"}</span>
              <span>{query ? "⌫ edits the query" : "⌫ on an empty query goes back"}</span>
              <span className="ml-auto">esc closes</span>
            </>
          ) : orgFooter ? (
            <>
              <span>↵ {selectableRows[selected]?.current !== undefined ? "switch" : "open"}</span>
              <span>{defaultOrgChords ? `${orgChordHint} switch from anywhere` : "Organization shortcuts switch from anywhere"}</span>
              <span className="sm:ml-auto">Your open sessions keep running</span>
            </>
          ) : subview === "status" ? (
            <>
              <span>↵ set status</span>
              <span>{query ? "⌫ edits the query" : "⌫ on an empty query goes back"}</span>
              <span className="ml-auto">esc closes</span>
            </>
          ) : (
            <>
              <span>↑↓ to move</span>
              <span>↵ to open</span>
              {/* Design 07.05: with nothing typed, Settings lists only its pages. Elsewhere, what Tab does (design 07.04). */}
              <span className="ml-auto truncate">{scope === "settings" && !query.trim() ? "Type to search every setting, not only pages" : "Tab switches tabs"}</span>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One keycap for a whole chord (design 07.04), at the 12px the smallest text is drawn at. */
function Keycap({ children }: { children: React.ReactNode }) {
  return <kbd className="shrink-0 rounded-[5px] border border-border px-1 py-0.5 font-sans text-xs font-medium leading-none text-muted-foreground">{children}</kbd>;
}

function PaletteResultRow({
  row,
  index,
  selected,
  busy,
  onHover,
  onSelect,
}: {
  row: PaletteRow;
  index: number;
  selected: boolean;
  busy: boolean;
  onHover: (index: number) => void;
  onSelect: (row: PaletteRow) => void;
}) {
  const Icon = row.icon ?? (
    row.kind === "workspace" || row.kind === "smart-workspace" ? GitBranch
      : row.kind === "file" ? FileText
        : row.kind === "project" ? FolderOpen
          : row.kind === "smart-start" ? GitPullRequest
            : row.kind === "session" || row.kind === "smart-session" ? MessageSquare
              : Keyboard
  );
  return (
    <button
      id={row.id}
      type="button"
      role="option"
      aria-selected={selected}
      aria-current={row.current ? "true" : undefined}
      data-palette-index={index}
      onMouseMove={() => onHover(index)}
      onFocus={() => onHover(index)}
      onClick={() => onSelect(row)}
      className={cn(
        "flex w-full items-center rounded-md px-2.5 text-left outline-none",
        row.layout ? "h-9 gap-2.5" : "gap-3 py-2",
        selected ? "bg-selected text-foreground shadow-button" : "text-muted-foreground hover:bg-veil-raised",
      )}
    >
      {row.layout ? <>
        {row.current !== undefined ? (
          <span aria-hidden className={cn(
            "grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-bold",
            row.current && row.organizationInitial ? "bg-accent text-accent-foreground" : "bg-veil-raised text-muted-foreground",
          )}>
            {row.organizationInitial ?? <Icon className="size-3.5" />}
          </span>
        ) : busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" />
          : row.emoji ? <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none">{row.emoji}</span>
            : row.manualStatus ? <ManualStatusIcon status={row.manualStatus} />
              : row.project ? <ProjectGlyph project={row.project} size={14} />
                : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0 truncate text-[13px] text-foreground", row.layout === "line" && "max-w-[70%] shrink-0")}>
          <HighlightedText text={row.primary} ranges={row.primaryRanges} />
        </span>
        {row.layout === "page" ? (
          <span className="ml-auto min-w-0 max-w-[60%] shrink truncate pl-3 text-right text-xs text-faint">
            <HighlightedText text={row.secondary} ranges={row.secondaryRanges} />
          </span>
        ) : <>
          {row.secondary && (
            <span className="min-w-0 truncate text-xs text-faint">
              <HighlightedText text={row.secondary} ranges={row.secondaryRanges} />
            </span>
          )}
          {row.current && <span className="shrink-0 text-xs text-faint">{row.secondary && "· "}current</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-faint">
            {row.trailing && <span className="font-mono">{row.trailing}</span>}
            {row.current && <Check aria-hidden className="size-3.5 text-foreground" />}
            {row.chord && <Keycap>{chordCap(row.chord)}</Keycap>}
            {row.enterHint && selected && <Keycap>↵</Keycap>}
            {row.checked !== undefined && (
              <span className="flex w-4 justify-center">{row.checked && <Check className="size-3.5 text-foreground" aria-label="Current section" />}</span>
            )}
          </span>
        </>}
      </> : <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-veil-raised text-muted-foreground">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : row.manualStatus ? <ManualStatusIcon status={row.manualStatus} /> : row.agentId ? <AgentMark id={row.agentId} className="size-4" decorative /> : row.project ? <ProjectGlyph project={row.project} /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">
          <HighlightedText text={row.primary} ranges={row.primaryRanges} />
        </span>
        <span className="block truncate text-xs text-faint">
          <HighlightedText text={row.secondary} ranges={row.secondaryRanges} />
        </span>
      </span>
      {row.chord && <Keycap>{chordCap(row.chord)}</Keycap>}
      </>}
    </button>
  );
}
