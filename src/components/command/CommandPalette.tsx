import { MANUAL_STATUSES, manualStatusLabel, normalizeManualStatus, type ManualStatus } from "@terminalx/portable/manualStatus";
import { ManualStatusIcon } from "@/components/session/ManualStatus";
import { conversationTitle } from "@/lib/sessions";
import { openSectionDialog } from "@/lib/localSections";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AtSign,
  BarChart3,
  Bot,
  FlaskConical,
  CalendarClock,
  CircleDot,
  Command as CommandIcon,
  FileText,
  FolderGit2,
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
  Sparkles,
  Sun,
  Terminal,
  User,
  Users,
  Workflow,
  Cloud,
  type LucideIcon,
  Trash2,
} from "@/icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { SETTINGS_SECTIONS as SETTINGS_PAGES, settingsSectionOffered } from "@/lib/settingsSections";
import { searchSettings } from "@/lib/settingsSearch";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { requestProjectSettings } from "@/lib/projectAdded";
import type { SettingsSection } from "@/components/settings/settingsRegistry";
import { AgentMark } from "@/components/AgentMark";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { cn } from "@/lib/cn";
import {
  indexPaletteItem,
  movePaletteSelection,
  PALETTE_TABS,
  paletteScopeShows,
  palettePlaceholder,
  paletteTabOf,
  parseSmartInput,
  rankPaletteItems,
  searchPaletteIndex,
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
import { getPrefs } from "@/lib/prefs";
import { START_ACTIONS, type StartAction } from "@/lib/projectStart";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
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
import { SHORTCUT_ACTIONS, keycaps, useKeymap, type ShortcutAction } from "@/lib/shortcuts";
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
  commands: 8,
  settings: 30,
  "settings-pages": 30,
  "settings-projects": 30,
};

/** Each Settings page's icon in the palette (design 07.05 gives every page its own). */
const SETTINGS_PAGE_ICONS: Record<SettingsSection, LucideIcon> = {
  account: User,
  devices: Smartphone,
  general: Settings,
  appearance: Palette,
  agents: Bot,
  orchestrator: Workflow,
  environment: KeyRound,
  transcription: Mic,
  integrations: Plug,
  projects: FolderPlus,
  repositories: FolderGit2,
  organizations: Users,
  storage: HardDrive,
  shortcuts: Keyboard,
  experimental: FlaskConical,
  about: Info,
};

interface CommandEntry extends PaletteEntityBase {
  group: "commands";
  icon: LucideIcon;
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
  icon?: LucideIcon;
  agentId?: string;
  project?: Project;
  run: () => void | Promise<void>;
  restoreFocus?: boolean;
  closeBefore?: boolean;
  /** One line: the title, and the secondary text after it (the Settings pages list, design 07.05). */
  inline?: boolean;
}

interface PaletteGroup {
  id: string;
  label: string;
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
  const orchestratorRuns = useExperimentalSettings()?.orchestratorRuns === true;
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [statusSessionId, setStatusSessionId] = useState<string | null>(null);
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
    const shortcutEntries = SHORTCUT_ACTIONS.map((shortcut, index) =>
      indexPaletteItem({
        id: `command:shortcut:${shortcut.id}`,
        group: "commands" as const,
        primary: shortcut.label,
        secondary: shortcut.id === "app.home" ? "Open the welcome screen" : `${shortcut.group} shortcut`,
        recentAt: SHORTCUT_ACTIONS.length - index,
        icon: shortcutIcon(shortcut),
        shortcut: true,
        chord: keymap[shortcut.id][0],
        run: () => runAction(shortcut),
      }, keymap[shortcut.id]),
    );
    const extras: CommandEntry[] = [
      ...(statusTarget ? [indexPaletteItem({
        id: "command:session-status", group: "commands" as const, primary: "Set status…",
        secondary: `${statusTarget.title} · ${manualStatusLabel(statusTarget.manualStatus)}`,
        recentAt: 25, icon: CircleDot, keepOpen: true,
        run: () => { setStatusSessionId(statusTarget.key); setQuery(""); setSelected(0); setError(null); },
      }, ["session backlog progress review done canceled workflow"])] : []),
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
      indexPaletteItem({ id: "command:pair-phone", group: "commands" as const, primary: "Pair a phone…", secondary: "Drive this Mac's sessions from TerminalX for iPhone", recentAt: 2, icon: Smartphone, run: () => openPairPhone() }, ["phone iphone mobile pair pairing device qr remote"]),
      indexPaletteItem({ id: "command:worktree-cleanup", group: "commands" as const, primary: "Clean up worktrees…", secondary: "Review and remove safe worktrees across open projects, here and on cloud workspaces", recentAt: 2, icon: Trash2, run: () => openWorktreeCleanup() }, ["worktree workspace cleanup disk space remove delete prune"]),
      indexPaletteItem({ id: "command:local-section:create", group: "commands" as const, primary: "New local section…", secondary: "Group sessions across local projects", recentAt: 2, icon: FolderPlus, run: () => openSectionDialog({ kind: "create" }) }, ["create sidebar section"]),
      ...(selectedSession && !store.selectedCloudWorkspace ? [indexPaletteItem({ id: "command:local-section:move", group: "commands" as const, primary: "Move to section…", secondary: conversationTitle(selectedSession), recentAt: 3, icon: FolderPlus, run: () => openSectionDialog({ kind: "move", sessionIds: [selectedSession.id] }) }, ["move session sidebar section"])] : []),
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
    const runEntries: CommandEntry[] = selectedSession && offersRunMenu(selectedSession, runProject)
      ? [
          ...visibleActions(runProject.actions ?? []).map((action, index) => indexPaletteItem({
            id: `command:run-action:${action.id}`, group: "commands" as const, primary: `Run ${action.name}`, secondary: action.command,
            recentAt: 30 - index, icon: Play, chord: index === 0 ? keymap["session.runAction"][0] : undefined,
            run: () => startAction(selectedSession, action),
          }, ["run action start script"])),
          ...(runProject.previewUrls ?? []).map((preview, index) => indexPaletteItem({
            id: `command:open-preview:${preview.id}`, group: "commands" as const, primary: `Open ${preview.name}`, secondary: preview.url,
            recentAt: 28 - index, icon: Globe,
            run: () => openPreview(selectedSession, preview),
          }, ["open preview url browser"])),
        ]
      : [];
    return [...runEntries, ...shortcutEntries, ...extras];
  }, [store.projects, selectedSession, statusTarget, store.selectedCloudWorkspace, cloud.live, cloud.mayCreate, cloud.orgName, runAction, keymap, status.settings.percent, status.settings.visible, theme.mode, theme.theme]);

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
  const { visibleIds } = useOrganizationVisibility();
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

  const groups = useMemo<PaletteGroup[]>(() => {
    if (statusSessionId) {
      if (!statusTarget) return [{ id: "statuses", label: "Status is unavailable for this session", rows: [] }];
      return [{ id: "statuses", label: `Set status · ${statusTarget.title}`, rows: MANUAL_STATUSES
        .filter((status) => manualStatusLabel(status).toLocaleLowerCase().includes(deferredQuery.toLocaleLowerCase()))
        .map((status) => ({
          id: `status:${status}`, kind: "command", primary: manualStatusLabel(status),
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
            inline: true,
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
        inline: true,
        run: () => requestProjectSettings(project.path),
      })),
    };
    if (scope === "settings") return deferredQuery.trim() ? [settingsGroup] : [settingsGroup, settingsProjectsGroup];
    const entityMatches = searchPaletteIndex(paletteIndex, deferredQuery);
    const commandMatches = rankPaletteItems(commandEntries, deferredQuery);
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
    const commandRows = commandMatches.map((match) => entityRow(match, "command", match.item.run, {
      ...(match.item.keepOpen ? { closeBefore: false } : {}),
      chord: match.item.chord,
      icon: match.item.icon,
      restoreFocus: !!match.item.shortcut,
    }));

    if (scope === "cloud") {
      const cloudRows = entityMatches.sessions.flatMap((match, index) => (match.item.cloudKey ? [sessionRows[index]] : []));
      return [{ id: "sessions", label: "Cloud sessions", rows: cloudRows }];
    }
    const searched = !!deferredQuery.trim();
    // A strong settings match ("font") should beat a fuzzy command; an exact
    // command ("Home") should still win over incidental settings keywords.
    const commandGroup: PaletteGroup = { id: "commands", label: "Views and commands", rows: commandRows };
    const settingsFirst = searched && (settingsMatches[0]?.score ?? Infinity) < (commandMatches[0]?.score ?? Infinity);
    return [
      { id: "smart", label: "Smart input", rows: smartRows },
      { id: "sessions", label: searched ? "Sessions" : "Recent sessions", rows: sessionRows },
      { id: "workspaces", label: searched ? "Workspaces" : "Recent workspaces", rows: workspaceRows },
      { id: "projects", label: searched ? "Projects" : "Recent projects", rows: projectRows },
      { id: "files", label: activeProject ? `Files · ${activeProject.name}` : "Files", rows: fileRows },
      ...(settingsFirst ? [settingsGroup, commandGroup] : [commandGroup, settingsGroup]),
    ].filter((group) => paletteScopeShows(scope, group.id));
  }, [statusSessionId, statusTarget, settingStatus, setOpen, scope, onOpenSettings, activeProject, commandEntries, deferredQuery, fileEntries, openFileHit, resolvedWorkItem, smartInput, smartProject, startWorkItem, paletteIndex, store.paletteIndex, store.projects, store.sessions, workItemLoading, orchestratorRuns]);

  const renderedGroups = useMemo(() => {
    let offset = 0;
    return groups.flatMap((group) => {
      if (!group.rows.length) return [];
      const cap = expanded[group.id] ? group.rows.length : (GROUP_CAPS[group.id] ?? 8);
      const rows = group.rows.slice(0, cap);
      const rendered = { ...group, rows, offset, more: group.rows.length - rows.length };
      offset += rows.length;
      return rendered;
    });
  }, [expanded, groups]);
  const selectableRows = useMemo(() => renderedGroups.flatMap((group) => group.rows), [renderedGroups]);

  useEffect(() => {
    setSelected(0);
    setExpanded({});
    listRef.current?.scrollTo(0, 0);
  }, [query, scope]);

  useEffect(() => {
    if (selected >= selectableRows.length) setSelected(Math.max(0, selectableRows.length - 1));
  }, [selectableRows.length, selected]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = useCallback(
    (row: PaletteRow) => {
      if (row.closeBefore === false) {
        void row.run();
        return;
      }
      skipRestoreRef.current = !row.restoreFocus;
      setOpen(false);
      requestAnimationFrame(() => void row.run());
    },
    [setOpen],
  );

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setSelected((current) => movePaletteSelection(current, selectableRows.length, event.key as PaletteNavigationKey));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = selectableRows[selected];
      if (row && !startingWorkItem) choose(row);
    } else if (event.key === "Backspace" && statusSessionId && !query) {
      setStatusSessionId(null);
    } else if (event.key === "Backspace" && scope !== "all" && !query) {
      // Backspace on an empty search returns to every group.
      setScope("all");
    }
  };

  const searching = (scope === "all" || scope === "cloud") && (fileLoading || workItemLoading || reposLoading);
  const tab = paletteTabOf(scope);
  const empty = !selectableRows.length && !searching;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showClose={false}
        width="max-w-[46rem]"
        className="top-[12%] max-h-[78vh] translate-y-0 overflow-hidden p-0"
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
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-lg bg-well px-3 hairline focus-within:ring-1 focus-within:ring-ring/40">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={palettePlaceholder(scope)}
            aria-label="Command palette search"
            aria-controls="command-palette-results"
            aria-activedescendant={selectableRows[selected]?.id}
            autoComplete="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          {searching && <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" aria-label="Searching" />}
          <kbd className="rounded-md bg-veil-raised px-1.5 py-0.5 text-[10px] text-faint">Esc</kbd>
        </div>

        {!statusSessionId && (
          <div role="tablist" aria-label="Search in" className="mt-2 flex h-10 items-center gap-1 border-b border-hairline px-2.5">
            {PALETTE_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
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

        <div ref={listRef} id="command-palette-results" role="listbox" className="mt-2 max-h-[min(34rem,calc(78vh-7rem))] overflow-y-auto px-2 pb-2 scrollbar-thin">
          {renderedGroups.map((group) => (
            <section key={group.id} role="group" aria-labelledby={`palette-group-${group.id}`} className="pt-2">
              <h2 id={`palette-group-${group.id}`} className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">
                {group.label}
              </h2>
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
                  className="mx-2 mt-1 rounded-md px-2 py-1 text-[11px] text-faint outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
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
              {scope === "all" && <p className="mt-1 text-xs text-faint">Try a session, branch, project, file path, setting, issue, pull request or command.</p>}
            </div>
          )}
        </div>

        <div className="flex h-9 items-center gap-4 border-t border-hairline px-4 text-xs text-faint">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          {/* Design 07.05: with nothing typed, Settings lists only its pages. */}
          {scope === "settings" && !query.trim() && <span className="ml-auto truncate">Type to search every setting, not only pages</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
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
      data-palette-index={index}
      onMouseMove={() => onHover(index)}
      onFocus={() => onHover(index)}
      onClick={() => onSelect(row)}
      className={cn(
        "flex w-full items-center rounded-lg px-2.5 text-left outline-none",
        row.inline ? "h-9 gap-2.5" : "gap-3 py-2",
        selected ? "bg-selected text-foreground shadow-button" : "text-muted-foreground hover:bg-veil-raised",
      )}
    >
      {row.inline ? <>
        {row.project ? <ProjectGlyph project={row.project} size={14} /> : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate text-[13px] text-foreground">
          <HighlightedText text={row.primary} ranges={row.primaryRanges} />
        </span>
        <span className="ml-auto min-w-0 max-w-[60%] shrink truncate pl-3 text-right text-xs text-faint">
          <HighlightedText text={row.secondary} ranges={row.secondaryRanges} />
        </span>
      </> : <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-veil-raised text-muted-foreground">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : row.manualStatus ? <ManualStatusIcon status={row.manualStatus} /> : row.agentId ? <AgentMark id={row.agentId} className="size-4" decorative /> : row.project ? <ProjectGlyph project={row.project} /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">
          <HighlightedText text={row.primary} ranges={row.primaryRanges} />
        </span>
        <span className="block truncate text-[11px] text-faint">
          <HighlightedText text={row.secondary} ranges={row.secondaryRanges} />
        </span>
      </span>
      {row.chord && (
        <span className="flex shrink-0 gap-0.5">
          {keycaps(row.chord).map((key, index) => (
            <kbd key={`${key}:${index}`} className="min-w-5 rounded-md bg-veil-raised px-1 py-0.5 text-center text-[10px] text-faint hairline">
              {key}
            </kbd>
          ))}
        </span>
      )}
      </>}
    </button>
  );
}
