import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Archive, ChevronDown, Ellipsis, Folder, FolderInput, FolderOpen, FolderPlus, GitBranch, GitPullRequest, Github, Palette, Pin, Plus, Settings, SquarePen, Trash2 } from "@/icons";
import { ask as askDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/menu";
import { RowActions, actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { AccountSidebarEntry } from "@/components/account/AccountSidebarEntry";
import { SidebarTitlebar } from "./SidebarTitlebar";
import { IssuePipelineSettingsDialog } from "@/components/issues/IssuePipelineSettingsDialog";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { branchSessionsAsTabs } from "@/lib/tabLayouts";
import { branchMerged, checkoutLabel, worktreeCheckout } from "@/lib/checkout";
import { START_ACTIONS, type StartAction } from "@/lib/projectStart";
import { addProject, archiveSession, openProjectOverview, pinSession, removeProject, selectSession, startChat, startSessionIn, updateProject, useSessionStore } from "@/lib/sessions";
import { ContinuationDialog } from "@/components/session/ContinuationDialog";
import { openSettle } from "@/lib/dialogs";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import { setSidebarFilter, useSidebarFilter } from "@/lib/sidebarFilter";
import type { Project, TabEntry, Workspace } from "@/types/session";
import { sessionStatus, type SessionEntry, type TabStatus } from "@/types/session";
import { RowTime } from "./SidebarRows";
import { useFold } from "./useFold";
import { StatusMark } from "@/components/ui/StatusMark";
import { AppDestinations, ProjectAppearance, ProjectGlyph, type RailProps } from "./ProjectRail";
import { DevelopmentSection } from "@/components/cloud/DevRuntime";
import { CloudOrganizations, useHasCloudOrganizations } from "./CloudOrganizations";
import { AgentMark } from "@/components/AgentMark";
import { IssueLinkMenuItems } from "@/components/session/IssueLinkMenuItems";

import { compareMessageActivity, conversationTime } from "@/lib/messageActivity";

const canon = (path: string) => path.replace(/\/+$/, "");

/** A conversation's name: its agent's title for it once there is one. */
export function conversationTitle(session: SessionEntry): string {
  const tab = session.tabs.find((entry) => entry.id === session.activeTab) ?? session.tabs[0];
  return tab?.title?.trim() || session.title;
}

const byRecency = (a: SessionEntry, b: SessionEntry) => compareMessageActivity(a, b, a.id, b.id);

/** Every live conversation as one list, pinned first, then newest; the open one stays even when archived. */
export function orderConversations(sessions: SessionEntry[], selectedId: string | null): SessionEntry[] {
  return sessions.filter((session) => !session.archived || session.id === selectedId).sort(byRecency);
}

/**
 * What a conversation is linked to, with the branch it works on: a chat's is
 * the repo its agent last worked in (nothing until it has), a project
 * conversation's is its project, on its worktree's branch or the one it last worked on.
 */
export function conversationLink(
  session: SessionEntry,
  projects: Project[],
  chatsPath: string | null,
  workspaces: Record<string, Workspace[]> = {},
): { path: string; project: Project | null; name: string; branch: string | null } | null {
  if (canon(session.projectPath) === chatsPath) {
    // A chat links itself to whichever repo its agent last worked in.
    if (!session.link) return null;
    const linked = canon(session.link.path);
    const project = projects.find((entry) => canon(entry.path) === linked) ?? null;
    return { path: session.link.path, project, name: project?.name ?? (linked.split("/").pop() || linked), branch: session.link.branch ?? null };
  }
  const path = canon(session.projectPath);
  const project = projects.find((entry) => canon(entry.path) === path) ?? null;
  const checkout = (workspaces[session.projectPath] ?? []).find((workspace) => canon(workspace.path) === canon(session.cwd));
  // A worktree has its branch to itself, so it names what is checked out there
  // now (its agent may have switched it, or left it on a bare commit). A
  // conversation in the project's own checkout shares it, so it names the
  // branch its agent last worked on (or started on), not wherever another
  // conversation has since switched it.
  const own = worktreeCheckout(session, workspaces);
  const branch = session.worktreeRemoved
    ? (session.removedWorkspace?.branch ?? null)
    : session.worktreeName
    ? ((own && checkoutLabel(own)) ?? session.branch ?? session.worktreeName)
    : (session.link?.branch ?? session.branch ?? checkout?.branch ?? null);
  return { path: session.projectPath, project, name: project?.name ?? (path.split("/").pop() || path), branch };
}

export interface ConversationGroup {
  path: string;
  name: string;
  project: Project | null;
  sessions: SessionEntry[];
  /** The branch each conversation works on, by its id. */
  branches: Record<string, string | null>;
}

/**
 * Conversations under the project each is linked to (a chat by the repo its
 * agent works in, any other by its own project), and the chats linked to
 * nothing on their own. Projects come by their latest activity, pinned ones
 * first; inside each, pinned conversations first, then the newest.
 */
export function groupConversations(
  sessions: SessionEntry[],
  projects: Project[],
  chatsPath: string | null,
  workspaces: Record<string, Workspace[]>,
  selectedId: string | null,
  /** List every open project, one with no conversations yet too: one just added is there at once (off while a filter narrows the list). */
  everyProject = false,
): { groups: ConversationGroup[]; chats: SessionEntry[] } {
  const groups = new Map<string, ConversationGroup>();
  const chats: SessionEntry[] = [];
  for (const session of orderConversations(sessions, selectedId)) {
    const link = conversationLink(session, projects, chatsPath, workspaces);
    if (!link) {
      chats.push(session);
      continue;
    }
    const key = canon(link.path);
    const group = groups.get(key) ?? { path: link.path, name: link.name, project: link.project, sessions: [], branches: {} };
    group.sessions.push(session);
    group.branches[session.id] = link.branch;
    groups.set(key, group);
  }
  if (everyProject) {
    for (const project of projects) {
      const key = canon(project.path);
      if (project.archived || key === chatsPath || groups.has(key)) continue;
      groups.set(key, { path: project.path, name: project.name, project, sessions: [], branches: {} });
    }
  }
  // A populated group follows its messages; opening its project is not a message.
  const latest = (group: ConversationGroup) => group.sessions.length
    ? Math.max(...group.sessions.map((session) => Date.parse(conversationTime(session)) || 0))
    : Date.parse(group.project?.lastOpened ?? "") || 0;
  const ordered = [...groups.values()].sort((a, b) => Number(!!b.project?.pinned) - Number(!!a.project?.pinned) || latest(b) - latest(a) || a.path.localeCompare(b.path));
  return { groups: ordered, chats };
}

/**
 * Ask, then take a project out of the sidebar. Its conversations are
 * archived, not deleted, so they can come back; the folder on disk is not
 * touched.
 */
export async function confirmRemoveProject(group: ConversationGroup) {
  const open = group.sessions.filter((session) => !session.archived);
  const conversations = open.length === 1 ? "Its conversation is archived" : open.length ? `Its ${open.length} conversations are archived` : "";
  const detail = conversations ? `${conversations}, and the folder on disk is left as it is.` : "The folder on disk is left as it is.";
  const yes = await askDialog(`Remove ${group.name} from TerminalX? ${detail}`, { title: "Remove project", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" }).catch(() => false);
  if (!yes) return;
  try {
    for (const session of open) await archiveSession(session.id, true);
    if (group.project) await removeProject(group.path);
  } catch (error) {
    console.error("remove project", errorMessage(error));
  }
}

/** The agent a conversation runs: its open tab's. */
export function conversationAgent(session: SessionEntry): string | null {
  return (session.tabs.find((tab) => tab.id === session.activeTab) ?? session.tabs[0])?.harness ?? null;
}

/**
 * Whether rows name their agent: only once the conversations use more than
 * one, so a reader who only ever runs Claude never sees a mark that tells
 * them nothing.
 */
export function mixesAgents(sessions: SessionEntry[]): boolean {
  return new Set(sessions.map(conversationAgent).filter(Boolean)).size > 1;
}

const ShowAgents = createContext(false);

/** How many conversations a project shows before "View all". */
const PEEK = 3;

/**
 * The sidebar as a chat app draws it: each project with its conversations
 * under it (a chat joins the project its agent works in), then the chats
 * that belong to none. Workspaces and tabs are not levels here; a row names
 * its branch, and the full tree is one click away as the detailed sidebar.
 */
export function SessionSidebar({ onHide, onOpenSettings, onOpenAccount, onSearch, onOpenIssues, onOpenAgents, onOpenAutomations }: RailProps) {
  const store = useSessionStore();
  const filter = useSidebarFilter();
  const [error, setError] = useState<string | null>(null);
  // A chat on its way into a project: the dialog that chooses how its new session starts there.
  const [moving, setMoving] = useState<{ session: SessionEntry; source: TabEntry; project: Project; worktree: boolean } | null>(null);
  const chatsPath = store.chatsPath ? canon(store.chatsPath) : null;
  const projects = store.projects.filter((project) => !project.archived && canon(project.path) !== chatsPath).sort((a, b) => a.name.localeCompare(b.name));
  const showAgents = useMemo(() => mixesAgents(store.sessions.filter((session) => !session.archived)), [store.sessions]);
  const sectioned = useHasCloudOrganizations();
  // Unread or Needs you: only the conversations that pass (and the open one), and so only their projects.
  const listed = useMemo(() => (filter.active ? store.sessions.filter((session) => filter.shows(session.id)) : store.sessions), [filter, store.sessions]);
  const { groups, chats } = useMemo(
    () => groupConversations(listed, store.projects, chatsPath, store.workspaces, store.selectedSessionId, !filter.active),
    [listed, store.projects, chatsPath, store.workspaces, store.selectedSessionId, filter.active],
  );

  const run = (action: () => Promise<unknown>) => () => {
    action().then(() => setError(null), (cause) => setError(errorMessage(cause)));
  };
  const newChat = run(() => startChat());
  const move = (session: SessionEntry, project: Project, worktree: boolean) => {
    const source = session.tabs.find((tab) => tab.id === session.activeTab) ?? session.tabs[0];
    if (!source) throw new Error("This chat has no conversation to carry over.");
    setError(null);
    setMoving({ session, source, project, worktree: worktree && project.kind !== "folder" });
  };
  const addAndStart = run(async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Add a project" });
    if (typeof dir === "string") startSessionIn((await addProject(dir)).path, null);
  });

  return (
    <div className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-r border-hairline" data-testid="sidebar-rail">
      <SidebarTitlebar onHide={onHide} onSearch={onSearch} onNewChat={newChat} onAddProject={addAndStart} projects={projects} />

      <div className="shrink-0 px-2">
        <div><AppDestinations onOpenIssues={onOpenIssues} onOpenAgents={onOpenAgents} onOpenAutomations={onOpenAutomations} /></div>
      </div>

      {error && <div className="mx-2 mt-1 shrink-0 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      <ShowAgents.Provider value={showAgents}>
      <nav className="mt-2 min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain scrollbar-thin border-t border-hairline px-2 py-2" aria-label="Conversations" data-testid="conversation-list">
        {groups.length === 0 && chats.length === 0 && filter.active ? (
          // Nothing local passed; the organizations below may still hold something that did.
          filter.count === 0 ? <FilteredEmpty text={filter.empty} /> : null
        ) : groups.length === 0 && chats.length === 0 ? (
          <button
            type="button"
            onClick={newChat}
            className="flex w-full flex-col items-center gap-1 rounded-lg px-3 py-6 text-center text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <SquarePen className="size-4" />
            Start a chat. It joins a project as soon as it works in one.
          </button>
        ) : (
          <>
            {groups.length > 0 && (
              <ListSection id="projects" label={sectioned ? "Local" : "Projects"} actions={<AddProjectMenu run={(action) => run(async () => action.run())()} />}>
                {groups.map((group) => (
                  <ProjectGroup
                    key={group.path}
                    group={group}
                    filtered={filter.active}
                    selectedId={store.selectedSessionId}
                    workspaces={store.workspaces[group.path] ?? []}
                    onNewSession={(place) => run(() => startChat({ projectPath: group.path, ...place }))()}
                  />
                ))}
              </ListSection>
            )}
            {chats.length > 0 && (
              <ListSection id="chats" label="Chats">
                <ul className="flex flex-col gap-px">
                  {chats.map((session) => (
                    <ConversationRow
                      key={session.id}
                      session={session}
                      selected={store.selectedSessionId === session.id}
                      branch={null}
                      linkTo={{
                        projects,
                        onMove: (project, worktree) => run(async () => move(session, project, worktree))(),
                        onAddProject: (worktree) => run(async () => {
                          const dir = await openDialog({ directory: true, multiple: false, title: "Link this chat to a project" });
                          if (typeof dir !== "string") return;
                          move(session, await addProject(dir), worktree);
                        })(),
                      }}
                    />
                  ))}
                </ul>
              </ListSection>
            )}
          </>
        )}
        <CloudOrganizations onOpenOrganizations={() => onOpenSettings("organizations")} />
        <DevelopmentSection />
      </nav>
      </ShowAgents.Provider>
      {moving && (
        <ContinuationDialog
          session={moving.session}
          source={moving.source}
          into={{ project: moving.project, worktree: moving.worktree }}
          onClose={() => setMoving(null)}
          onLateError={setError}
        />
      )}

      <div className="flex shrink-0 items-center gap-1 border-t border-hairline px-2 pb-2 pt-1" data-testid="sidebar-account-row">
        {/* The account; Settings keeps the far end. */}
        <div className="min-w-0 max-w-[70%]">
          <AccountSidebarEntry onOpenAccount={onOpenAccount} />
        </div>
        <div className="flex-1" />
        <WithTooltip label="Settings" shortcut="app.settings" side="top">
          <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Settings" onClick={() => onOpenSettings()}>
            <Settings />
          </Button>
        </WithTooltip>
      </div>
    </div>
  );
}

/** What the list says when the sidebar's filter leaves nothing in it, and the way back to everything. */
export function FilteredEmpty({ text }: { text: string }) {
  return (
    <div className="px-3 py-6 text-center text-[12px] text-faint" data-testid="sidebar-filter-empty">
      {text}{" "}
      <button type="button" className="underline underline-offset-2 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => setSidebarFilter("all")}>
        Show all sessions
      </button>
    </div>
  );
}

/**
 * A titled part of the list that folds. `actions` sit at the header's end,
 * shown on hover or focus like a row's; `notes` are lines under the header
 * that stay while it is folded (an organization's loading or offline line);
 * `title` is the header's tooltip; `forceOpen` keeps it open whatever its fold.
 */
export function ListSection({
  id,
  label,
  children,
  actions,
  notes,
  title,
  forceOpen = false,
  onMenu,
  ...rest
}: {
  id: string;
  label: string;
  children: ReactNode;
  actions?: ReactNode;
  notes?: ReactNode;
  title?: string;
  forceOpen?: boolean;
  /** Open the section's menu: a right-click, or the context-menu key, on its header. */
  onMenu?: () => void;
} & Record<`data-${string}`, string>) {
  const [expanded, toggle] = useFold(`list:${id}`, true);
  const open = expanded || forceOpen;
  return (
    <section aria-labelledby={`list-${id}`} className="mb-3" {...rest}>
      <div
        className={cn(actionRow, "flex h-6 min-w-0 items-center gap-1 pr-1")}
        onContextMenu={onMenu && ((event) => { event.preventDefault(); onMenu(); })}
        onKeyDown={onMenu && ((event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          onMenu();
        })}
      >
        <button
          type="button"
          id={`list-${id}`}
          onClick={toggle}
          aria-expanded={open}
          title={title}
          className="flex h-6 min-w-0 items-center gap-1 rounded-sm px-2 text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")} />
        </button>
        {actions && <div className="ml-auto flex min-w-0 shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {notes}
      {open && children}
    </section>
  );
}

/** A project, then its conversations along a guide line: the latest few, the open one, and "View all". */
function ProjectGroup({
  group,
  filtered = false,
  selectedId,
  workspaces,
  onNewSession,
}: {
  group: ConversationGroup;
  /** The sidebar's filter is on: the project shows everything that passed, opened. */
  filtered?: boolean;
  selectedId: string | null;
  /** The project's checkouts, to find the folder a branch is checked out in. */
  workspaces: Workspace[];
  /** Start a session in a checkout (`cwd`), or in a new workspace branched from `fromBranch`. */
  onNewSession: (place: { cwd: string } | { fromBranch: string }) => void;
}) {
  // Another session on a branch runs where that branch is checked out: the
  // project's checkout on it, else the worktree a conversation on it has
  // (the checkout list is not always loaded; a shared checkout may have
  // moved on since). One checked out nowhere (its worktree gone, the
  // checkout moved on) gets a new workspace branched from it instead.
  const newSessionOn = (branch: string, sessions: SessionEntry[]): NewSessionAction | null => {
    if (sessions.every((session) => session.worktreeRemoved)) return null;
    const checkout = workspaces.find((workspace) => workspace.branch === branch)?.path ?? sessions.find((session) => session.worktreeName && !session.worktreeRemoved)?.cwd;
    if (checkout) return { label: `New session on ${branch || "this branch"}`, run: () => onNewSession({ cwd: checkout }) };
    if (!branch) return null;
    return { label: `New workspace from ${branch}`, run: () => onNewSession({ fromBranch: branch }) };
  };
  // Branches whose checkout has its commits in the default branch, as git knows it here without a fetch.
  const merged = useMemo(() => new Set(workspaces.flatMap((workspace) => (branchMerged(workspace, group.sessions) ? [workspace.branch!] : []))), [workspaces, group.sessions]);
  // Branches still on the name drawn for their worktree: nobody named them, so their row goes by its conversation's title.
  const placeholders = useMemo(() => new Set(workspaces.flatMap((workspace) => (workspace.placeholder && workspace.branch ? [workspace.branch] : []))), [workspaces]);
  const nav = useSessionStore();
  const overviewOpen = nav.view === "project" && !!nav.selectedProject && canon(nav.selectedProject) === canon(group.path);
  const [all, toggleAll] = useFold(`project-all:${canon(group.path)}`, false);
  // The project folds its branches away: its picture turns into a chevron on hover, and stays one while folded.
  const [expanded, toggle] = useFold(`project:${canon(group.path)}`, true);
  const open = expanded || filtered;
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const prefs = usePrefs();
  const { animations } = prefs;
  // A branch's sessions are tabs or sidebar rows, never both: as tabs, the branch is one row here whatever their number.
  const asTabs = branchSessionsAsTabs(prefs);
  // One row per branch, newest work first; the conversations come in that order already.
  const branches = useMemo(() => {
    const byBranch = new Map<string, { key: string; branch: string; sessions: SessionEntry[] }>();
    for (const session of group.sessions) {
      const branch = group.branches[session.id] ?? "";
      // A retained history must not join a live checkout merely because its
      // original branch name has been reused (or it now resumes on main).
      const key = session.worktreeRemoved ? `removed:${session.removedWorkspace?.path ?? session.id}` : `branch:${branch}`;
      const entry = byBranch.get(key) ?? { key, branch, sessions: [] };
      entry.sessions.push(session);
      byBranch.set(key, entry);
    }
    return [...byBranch.values()];
  }, [group]);
  const shown = all || filtered ? branches : branches.filter((entry, index) => index < PEEK || entry.sessions.some((session) => session.id === selectedId));
  const more = !filtered && (branches.length > shown.length || (all && branches.length > PEEK));
  return (
    <div role="group" aria-label={group.name} className="mb-1">
      <DropdownMenu>
        <div className={cn(actionRow, "relative flex h-8 items-center gap-2 rounded-md px-2 hover:bg-selected/50", overviewOpen && "bg-selected")} title={group.path}>
          {/* Only the picture (a chevron on hover) folds the project; its name opens the project's overview. */}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? `Collapse ${group.name}` : `Expand ${group.name}`}
            className="flex h-full shrink-0 items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="relative size-4 shrink-0">
              <span className={cn("absolute inset-0 transition-opacity duration-150", open ? "group-hover/row:opacity-0 group-focus-within/row:opacity-0" : "opacity-0")} aria-hidden>
                {group.project ? <ProjectGlyph project={group.project} /> : <Folder className="size-4 text-faint" />}
              </span>
              <ChevronDown
                className={cn(
                  "absolute inset-0 size-4 text-muted-foreground transition-[opacity,transform] duration-200",
                  open ? "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100" : "-rotate-90 opacity-100",
                )}
                data-testid="project-fold"
              />
            </span>
          </button>
          <button
            type="button"
            onClick={() => (group.project ? openProjectOverview(group.path) : toggle())}
            aria-current={overviewOpen ? "page" : undefined}
            aria-label={group.project ? `${group.name} overview` : undefined}
            className="flex h-full min-w-0 flex-1 items-center rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="min-w-0 flex-1 truncate text-[13px]">{group.name}</span>
          </button>
          <RowActions>
            <WithTooltip label={`New chat in ${group.name}`}>
              <Button variant="ghost" size="icon-xs" aria-label={`New chat in ${group.name}`} onClick={() => startSessionIn(group.path, null)}>
                <Plus />
              </Button>
            </WithTooltip>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`Project menu for ${group.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </RowActions>
        </div>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => startSessionIn(group.path, null)}>
            <SquarePen /> New chat in {group.name}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void revealItemInDir(group.path)}>
            <FolderOpen /> Reveal in Finder
          </DropdownMenuItem>
          {group.project && (
            <>
              <DropdownMenuItem onSelect={() => void updateProject(group.path, { pinned: !group.project?.pinned })}>
                <Pin /> {group.project.pinned ? "Unpin project" : "Pin project"}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Palette /> Name and appearance
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <ProjectAppearance project={group.project} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
          {group.project && group.project.kind !== "folder" && (
            <DropdownMenuItem onSelect={() => setPipelineOpen(true)}>
              <GitPullRequest /> Issue pipeline…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => void confirmRemoveProject(group)}>
            <Trash2 /> Remove from TerminalX…
          </DropdownMenuItem>
        </DropdownMenuContent>
        {/* Mounted only while open: a row per project would otherwise each hold a dialog. */}
        {pipelineOpen && group.project && <IssuePipelineSettingsDialog project={group.project} open onOpenChange={setPipelineOpen} />}
      </DropdownMenu>
      {/* The branches slide open and closed: a grid row that grows from nothing to its content's height, which a height alone cannot animate. */}
      <div
        className={cn("grid", animations && "transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        aria-hidden={!open}
        inert={!open}
        data-testid="project-branches"
      >
        <div className="min-h-0 overflow-hidden">
      <ul className="ml-[15px] flex flex-col gap-px pl-1.5">
        {shown.map(({ key, branch, sessions }) =>
          sessions.length === 1 || asTabs ? (
            <ConversationRow
              key={key}
              // The branch's row opens the session that is open on it, else its latest.
              session={sessions.find((session) => session.id === selectedId) ?? sessions[0]}
              peers={sessions}
              selected={sessions.some((session) => session.id === selectedId)}
              branch={!sessions[0].worktreeRemoved && placeholders.has(branch) ? null : branch || null}
              named={!sessions[0].worktreeRemoved && placeholders.has(branch) ? "title" : "branch"}
              merged={!sessions[0].worktreeRemoved && merged.has(branch)}
              onNewSession={newSessionOn(branch, sessions)}
              linkTo={null}
            />
          ) : (
            <BranchRow key={key} path={group.path} branch={branch} sessions={sessions} selectedId={selectedId} opened={filtered} merged={!sessions[0].worktreeRemoved && merged.has(branch)} onNewSession={newSessionOn(branch, sessions)} />
          ),
        )}
        {branches.length === 0 && <li className="flex h-7 items-center px-2 text-[12px] text-faint">No chats yet</li>}
        {more && (
          <li>
            <button
              type="button"
              onClick={toggleAll}
              className="flex h-7 w-full items-center rounded-md px-2 text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {all ? "Show less" : "View all"}
            </button>
          </li>
        )}
      </ul>
        </div>
      </div>
    </div>
  );
}

/** A branch more than one conversation works on: the branch, how many, and the conversations under it. */
function BranchRow({
  path,
  branch,
  sessions,
  selectedId,
  opened,
  merged,
  onNewSession,
}: {
  path: string;
  branch: string;
  sessions: SessionEntry[];
  selectedId: string | null;
  /** Open whatever its fold: the sidebar's filter is on. */
  opened: boolean;
  /** Its commits are in the default branch. */
  merged: boolean;
  onNewSession: NewSessionAction | null;
}) {
  const holdsSelected = sessions.some((session) => session.id === selectedId);
  const removed = sessions.every((session) => session.worktreeRemoved);
  const foldKey = removed ? `removed:${sessions[0].removedWorkspace?.path ?? sessions[0].id}` : branch;
  const [open, toggle] = useFold(`branch:${canon(path)}:${foldKey}`, false);
  const expanded = open || holdsSelected || opened;
  const label = `${branch || "No branch"}${removed ? " (workspace removed)" : ""}`;
  return (
    <li>
      <div className={cn(actionRow, "relative flex h-8 items-center rounded-md pr-1 text-foreground/85 hover:bg-selected/50")}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          title={label}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <BranchGlyph merged={merged} />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{branch || "No branch"}</span>
          {removed && <span className="shrink-0 text-[10px] text-faint">removed</span>}
          <span className={cn("shrink-0 text-[11px] tabular-nums text-faint", yieldsToRowActions)}>{sessions.length}</span>
          <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform", !expanded && "-rotate-90")} />
        </button>
        {onNewSession && (
          <RowActions>
            <NewSessionButton action={onNewSession} />
          </RowActions>
        )}
      </div>
      {expanded && (
        <ul className="ml-[13px] flex flex-col gap-px pl-1.5">
          {sessions.map((session) => (
            <ConversationRow key={session.id} session={session} selected={selectedId === session.id} branch={null} linkTo={null} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A branch row's icon; a merged branch has a tick drawn into its empty corner, in the icon's own stroke. */
function BranchGlyph({ merged }: { merged: boolean }) {
  if (!merged) return <GitBranch className="size-3.5 shrink-0 text-faint" />;
  return (
    <span className="flex shrink-0" title="Merged: its commits are in the default branch">
      <GitBranch className="size-3.5 text-faint">
        <path d="M9.25 12.25l1.75 1.75 3.5-3.75" className="text-info" />
      </GitBranch>
      <span className="sr-only">merged</span>
    </span>
  );
}

const START_ICON: Record<StartAction["id"], typeof FolderOpen> = { local: FolderOpen, github: Github, quick: FolderPlus };

/** The Projects header's +: open a folder, clone from GitHub, or start a new empty project. */
function AddProjectMenu({ run }: { run: (action: StartAction) => void }) {
  return (
    <DropdownMenu>
      <WithTooltip label="Add a project">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Add a project" className="text-faint hover:text-foreground">
            <Plus />
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end">
        {START_ACTIONS.map((action) => {
          const Icon = START_ICON[action.id];
          return (
            <DropdownMenuItem key={action.id} onSelect={() => run(action)}>
              <Icon /> {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a branch row's + does, and what it is called. */
interface NewSessionAction {
  label: string;
  run: () => void;
}

function NewSessionButton({ action }: { action: NewSessionAction }) {
  return (
    <WithTooltip label={action.label}>
      <Button variant="ghost" size="icon-xs" aria-label={action.label} onClick={action.run}>
        <Plus />
      </Button>
    </WithTooltip>
  );
}

/** The state that matters most among several: a question waiting, then work in progress, then work done. */
function pressingStatus(statuses: TabStatus[]): TabStatus {
  const order: TabStatus[] = ["waiting", "in_progress", "completed", "idle"];
  return order.find((status) => statuses.includes(status)) ?? "idle";
}

function ConversationRow({
  session,
  peers = [session],
  selected,
  branch,
  named = "title",
  merged = false,
  onNewSession = null,
  linkTo,
}: {
  session: SessionEntry;
  /** A branch row's sessions (as tabs, the row stands for all of them): the row shows the most pressing state among them. */
  peers?: SessionEntry[];
  selected: boolean;
  /** What the row is called: the conversation's title, or (alone on its branch in a project) the branch. */
  named?: "title" | "branch";
  /** The branch's commits are in the default branch. */
  merged?: boolean;
  /** Start another session on the row's branch, where it is checked out (or a workspace from it). */
  onNewSession?: NewSessionAction | null;
  /** The branch it works on, named at the row's end; without one the row shows when it was last active. */
  branch: string | null;
  /** For a chat linked to nothing: the projects it may be linked to. */
  linkTo: { projects: Project[]; onMove: (project: Project, worktree: boolean) => void; onAddProject: (worktree: boolean) => void } | null;
}) {
  const title = named === "branch" && peers.length > 1 ? `${peers.length} sessions` : conversationTitle(session);
  const removed = session.worktreeRemoved;
  const location = removed ? `${session.removedWorkspace?.path ?? session.cwd} · workspace removed · resumes in ${session.cwd}` : null;
  const status = pressingStatus(peers.map(sessionStatus));
  const agent = useContext(ShowAgents) ? conversationAgent(session) : null;
  const mark = agent && <AgentMark id={agent} className={cn("size-3 text-faint", yieldsToRowActions)} />;
  return (
    <li>
      <DropdownMenu>
        <div
          className={cn(actionRow, "relative flex h-8 items-center gap-2 rounded-md pl-2 pr-1", selected ? "bg-selected text-foreground" : "text-foreground/85 hover:bg-selected/50")}
          title={location ?? (branch ? `${branch} · ${title}` : title)}
        >
          <button
            type="button"
            onClick={() => selectSession(session.id)}
            aria-current={selected ? "true" : undefined}
            aria-label={named === "branch" ? `${branch ?? "No branch"}${removed ? " (workspace removed)" : merged ? " (merged)" : ""}, ${title}` : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {session.pinned && <Pin className="size-3 shrink-0 text-faint" />}
            {named === "branch" ? (
              <>
                <BranchGlyph merged={merged} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{branch ?? "No branch"}</span>
                {removed && <span className="shrink-0 text-[10px] text-faint">removed</span>}
                {mark}
                {/* The row's state sits where the time does, at the end, so the row's own icon keeps its place; while working, the sign stands in for the time. */}
                <StatusMark status={status} />
                {status !== "in_progress" && <RowTime at={conversationTime(session)} />}
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
                {mark}
                <StatusMark status={status} />
              </>
            )}
            {named === "branch" || status === "in_progress" ? null : branch ? (
              <span className={cn("flex max-w-[45%] shrink-0 items-center gap-1 font-mono text-[10px] text-faint", yieldsToRowActions)}>
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{branch}</span>
              </span>
            ) : (
              <RowTime at={conversationTime(session)} />
            )}
          </button>
          <RowActions>
            {onNewSession && <NewSessionButton action={onNewSession} />}
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`Menu for ${title}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </RowActions>
        </div>
        <DropdownMenuContent align="end" className="w-56">
          {linkTo && (
            <>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInput /> Link to a project
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-60">
                  {linkTo.projects.map((project) =>
                    project.kind === "folder" ? (
                      <DropdownMenuItem key={project.path} onSelect={() => linkTo.onMove(project, false)}>
                        <ProjectGlyph project={project} /> <span className="truncate">{project.name}</span>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuSub key={project.path}>
                        <DropdownMenuSubTrigger>
                          <ProjectGlyph project={project} /> <span className="truncate">{project.name}</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {/* A worktree first: the project's own checkout is shared with its other conversations. */}
                          <DropdownMenuItem onSelect={() => linkTo.onMove(project, true)}>
                            <GitBranch /> On a new branch (worktree)
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => linkTo.onMove(project, false)}>
                            <FolderOpen /> In its main checkout
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ),
                  )}
                  {linkTo.projects.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => linkTo.onAddProject(false)}>
                    <FolderPlus /> Choose a folder…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => linkTo.onAddProject(true)}>
                    <GitBranch /> Choose a repo, new branch…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => void pinSession(session.id, !session.pinned)}>
            <Pin /> {session.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void archiveSession(session.id, !session.archived)}>
            <Archive /> {session.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <IssueLinkMenuItems session={session} />
          <DropdownMenuSeparator />
          {session.worktreeName && !session.worktreeRemoved && (
            <DropdownMenuItem onSelect={() => openSettle(session)}>
              <Folder /> Remove workspace, keep conversations…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem destructive onSelect={() => void confirmDeleteSession(session)}>
            <Trash2 /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
