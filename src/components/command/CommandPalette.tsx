import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AtSign,
  BarChart3,
  CalendarClock,
  CircleDot,
  Command as CommandIcon,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  GitPullRequest,
  Keyboard,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Moon,
  PanelLeft,
  PanelRight,
  Palette,
  Search,
  Settings,
  Sparkles,
  Sun,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AgentMark } from "@/components/AgentMark";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { cn } from "@/lib/cn";
import {
  indexPaletteItem,
  movePaletteSelection,
  parseSmartInput,
  rankPaletteItems,
  searchPaletteIndex,
  type MatchRange,
  type PaletteEntityBase,
  type PaletteMatch,
  type PaletteNavigationKey,
  type SmartInput,
} from "@/lib/commandPalette";
import { api, errorMessage, files, gh, issues, type FileHit, type Issue, type PullRequest } from "@/lib/api";
import { openFile } from "@/lib/editors";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { issuePrompt, issueWorktreeName, pullRequestPrompt } from "@/lib/issueSession";
import { getPrefs } from "@/lib/prefs";
import {
  openWorkspace,
  refreshWorkspaces,
  selectProjectInSidebar,
  selectSession,
  startSessionIn,
  upsertSession,
  useSessionStore,
} from "@/lib/sessions";
import { SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import { setStatusSettings, useStatus } from "@/lib/status";
import { THEMES, setMode, setTheme, useTheme } from "@/lib/theme";
import { relativeTime } from "@/lib/time";
import type { SettingsTab } from "@/components/settings/SettingsDialog";
import type { Project, SessionEntry } from "@/types/session";

const GROUP_CAPS: Record<string, number> = {
  smart: 5,
  sessions: 7,
  workspaces: 6,
  projects: 4,
  files: 8,
  commands: 8,
};

interface CommandEntry extends PaletteEntityBase {
  group: "commands";
  icon: LucideIcon;
  chord?: string;
  run: () => void | Promise<void>;
}

interface FileEntry extends PaletteEntityBase {
  group: "files";
  hit: FileHit;
}

interface PaletteRow {
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

function shortcutIcon(shortcut: Shortcut): LucideIcon {
  const label = shortcut.label.toLowerCase();
  if (label.includes("session") || label === "send") return MessageSquare;
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

function HighlightedText({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={`${range.start}:${range.end}`} className="bg-transparent font-semibold text-foreground">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
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

function dispatchShortcut(chord: string, previousFocus: HTMLElement | null): void {
  previousFocus?.isConnected && previousFocus.focus({ preventScroll: true });
  if (chord === "@" || chord === "/") {
    insertComposerText(chord);
    return;
  }
  if (chord === "shift+enter" && insertComposerText("\n")) return;

  const parts = chord.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : window;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: key === "escape" ? "Escape" : key === "enter" ? "Enter" : key,
      code: key === "[" ? "BracketLeft" : key === "]" ? "BracketRight" : undefined,
      metaKey: parts.includes("mod"),
      altKey: parts.includes("alt"),
      shiftKey: parts.includes("shift"),
      bubbles: true,
      cancelable: true,
    }),
  );
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
  const deferredQuery = useDeferredValue(query);
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
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
  const activeProjectPath = selectedSession?.projectPath ?? store.selectedProject ?? store.lastProject ?? store.projects[0]?.path ?? null;
  const activeProject = store.projects.find((project) => project.path === activeProjectPath) ?? null;
  const preset = store.newSessionPreset;
  const presetRoot = preset?.projectPath === activeProject?.path ? (preset?.cwd ?? null) : null;
  const mainWorkspace = activeProject ? (store.workspaces[activeProject.path] ?? []).find((workspace) => workspace.isMain) : null;
  const fileRoot = selectedSession?.cwd ?? presetRoot ?? mainWorkspace?.path ?? activeProject?.path ?? null;
  const smartInput = useMemo(() => parseSmartInput(query), [query]);

  useHotkey("escape", () => {
    if (!open) return false;
    skipRestoreRef.current = false;
    setOpen(false);
    return true;
  }, { enabled: open, global: true });

  useEffect(() => {
    if (!open) return;
    setQuery("");
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
      store.projects.map(async (project) => [project.path, await issues.githubRepo(project.path).catch(() => null)] as const),
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
    if (!smartInput.owner || !smartInput.repo) return activeProject;
    const wanted = `${smartInput.owner}/${smartInput.repo}`.toLowerCase();
    return store.projects.find((project) => githubRepoKey(repoByProject[project.path] ?? "") === wanted) ?? null;
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
    if (!open || !fileRoot || !deferredQuery.trim() || smartInput) {
      setFileHits([]);
      setFileLoading(false);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setFileLoading(true);
      void files
        .search(fileRoot, deferredQuery.trim(), 80)
        .then((hits) => live && setFileHits(hits))
        .catch(() => live && setFileHits([]))
        .finally(() => live && setFileLoading(false));
    }, 45);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [deferredQuery, fileRoot, open, smartInput]);

  const runShortcut = useCallback(
    (chord: string) => dispatchShortcut(chord, previousFocusRef.current),
    [],
  );

  const commandEntries = useMemo<CommandEntry[]>(() => {
    const shortcutEntries = SHORTCUTS.map((shortcut, index) =>
      indexPaletteItem({
        id: `command:shortcut:${index}:${shortcut.chord}`,
        group: "commands" as const,
        primary: shortcut.label,
        secondary: `${shortcut.group} shortcut`,
        recentAt: SHORTCUTS.length - index,
        icon: shortcutIcon(shortcut),
        chord: shortcut.chord,
        run: () => runShortcut(shortcut.chord),
      }, [shortcut.chord]),
    );
    const extras: CommandEntry[] = [
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
      indexPaletteItem({ id: "command:settings:appearance", group: "commands" as const, primary: "Open Appearance settings", secondary: "Themes, type and transcript layout", recentAt: 2, icon: Settings, run: () => onOpenSettings("appearance") }),
    ];
    return [...shortcutEntries, ...extras];
  }, [onOpenSettings, runShortcut, status.settings.percent, status.settings.visible, theme.mode, theme.theme]);

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
      if (!fileRoot || !activeProject) return;
      let session = selectedSession;
      if (!session || cleanPath(session.cwd) !== cleanPath(fileRoot)) session = await openWorkspace(activeProject.path, fileRoot);
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
      const prefs = getPrefs();
      const identifier = `#${item.number}`;
      const session = await api.createSession({
        projectPath: item.project.path,
        title: `${identifier} ${item.title}`.slice(0, 80),
        useWorktree: true,
        worktreeName: issueWorktreeName(identifier, item.title),
        issue: { provider: "github", id: item.issue?.id ?? String(item.number), identifier, title: item.title, url: item.url },
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
      if (tab) onCreated(session.id, tab.id, item.issue ? issuePrompt(item.issue) : pullRequestPrompt(item.pullRequest!));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStartingWorkItem(false);
    }
  }, [lookupWorkItem, onCreated, resolvedWorkItem, setOpen, smartInput, smartProject, store.harnesses]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const entityMatches = searchPaletteIndex(store.paletteIndex, deferredQuery);
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
      () => selectSession(match.item.sessionId),
      { agentId: match.item.agentIds[0] },
    ));
    const workspaceRows = entityMatches.workspaces.map((match) => entityRow(match, "workspace", () => void openWorkspace(match.item.projectPath, match.item.workspace.path)));
    const projectRows = entityMatches.projects.map((match) => entityRow(match, "project", () => {
      selectProjectInSidebar(match.item.project.path);
      startSessionIn(match.item.project.path, null);
    }, { project: match.item.project }));
    const fileRows = rankedFiles.map((match) => entityRow(match, "file", () => void openFileHit(match.item.hit)));
    const commandRows = commandMatches.map((match) => entityRow(match, "command", match.item.run, {
      chord: match.item.chord,
      icon: match.item.icon,
      restoreFocus: !!match.item.chord,
    }));

    return [
      { id: "smart", label: "Smart input", rows: smartRows },
      { id: "sessions", label: deferredQuery.trim() ? "Sessions" : "Recent sessions", rows: sessionRows },
      { id: "workspaces", label: deferredQuery.trim() ? "Workspaces" : "Recent workspaces", rows: workspaceRows },
      { id: "projects", label: deferredQuery.trim() ? "Projects" : "Recent projects", rows: projectRows },
      { id: "files", label: activeProject ? `Files · ${activeProject.name}` : "Files", rows: fileRows },
      { id: "commands", label: "Views and commands", rows: commandRows },
    ];
  }, [activeProject, commandEntries, deferredQuery, fileEntries, openFileHit, resolvedWorkItem, smartInput, smartProject, startWorkItem, store.paletteIndex, store.projects, store.sessions, workItemLoading]);

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
  }, [query]);

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
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setSelected((current) => movePaletteSelection(current, selectableRows.length, event.key as PaletteNavigationKey));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = selectableRows[selected];
      if (row && !startingWorkItem) choose(row);
    }
  };

  const empty = !selectableRows.length && !fileLoading && !workItemLoading && !reposLoading;

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
        <DialogDescription className="sr-only">Search sessions, workspaces, projects, files, views and commands</DialogDescription>
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-lg bg-well px-3 hairline focus-within:ring-1 focus-within:ring-ring/40">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search sessions, workspaces, projects, files and commands…"
            aria-label="Command palette search"
            aria-controls="command-palette-results"
            aria-activedescendant={selectableRows[selected]?.id}
            autoComplete="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          {(fileLoading || workItemLoading || reposLoading) && <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" aria-label="Searching" />}
          <kbd className="rounded-md bg-veil-raised px-1.5 py-0.5 text-[10px] text-faint">Esc</kbd>
        </div>

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
              <p className="text-sm text-muted-foreground">No results match this search.</p>
              <p className="mt-1 text-xs text-faint">Try a session, branch, project, file path, issue, pull request or command.</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-hairline px-3 py-2 text-[10px] text-faint">
          <span><kbd className="rounded bg-veil-raised px-1">↑↓</kbd> move</span>
          <span><kbd className="rounded bg-veil-raised px-1">↵</kbd> open</span>
          <span><kbd className="rounded bg-veil-raised px-1">Esc</kbd> close</span>
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
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none",
        selected ? "bg-selected text-foreground shadow-button" : "text-muted-foreground hover:bg-veil-raised",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-veil-raised text-muted-foreground">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : row.agentId ? <AgentMark id={row.agentId} className="size-4" decorative /> : row.project ? <ProjectGlyph project={row.project} /> : <Icon className="size-4" />}
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
    </button>
  );
}
