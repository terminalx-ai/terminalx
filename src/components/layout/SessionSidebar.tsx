import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Archive, ChevronDown, Ellipsis, Folder, FolderInput, FolderOpen, FolderPlus, GitBranch, GitPullRequest, Palette, Pin, Plus, Settings, SquarePen, Trash2 } from "@/icons";
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
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { addProject, archiveSession, pinSession, removeProject, selectSession, startChat, startSessionIn, updateProject, useSessionStore } from "@/lib/sessions";
import { moveChatToProject } from "@/lib/continuation";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import type { Project, Workspace } from "@/types/session";
import { sessionStatus, type SessionEntry } from "@/types/session";
import { RowTime } from "./SidebarRows";
import { StatusMark } from "@/components/ui/StatusMark";
import { AppDestinations, ProjectAppearance, ProjectGlyph, type RailProps } from "./ProjectRail";
import { AgentMark } from "@/components/AgentMark";

const canon = (path: string) => path.replace(/\/+$/, "");

/** A conversation's name: its agent's title for it once there is one. */
export function conversationTitle(session: SessionEntry): string {
  const tab = session.tabs.find((entry) => entry.id === session.activeTab) ?? session.tabs[0];
  return tab?.title?.trim() || session.title;
}

const byRecency = (a: SessionEntry, b: SessionEntry) => Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified);

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
  // A worktree has its branch to itself. A conversation in the project's own
  // checkout shares it, so it names the branch its agent last worked on (or
  // started on), not wherever another conversation has since switched it.
  const branch = session.worktreeName && !session.worktreeRemoved
    ? (session.branch ?? session.worktreeName)
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
  const latest = (group: ConversationGroup) => group.sessions.reduce((max, session) => (session.modified > max ? session.modified : max), "");
  const ordered = [...groups.values()].sort((a, b) => Number(!!b.project?.pinned) - Number(!!a.project?.pinned) || latest(b).localeCompare(latest(a)));
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

/** A fold the sidebar remembers between launches. */
function useFold(key: string, byDefault: boolean): [boolean, () => void] {
  const { sidebarSections } = usePrefs();
  const stored = sidebarSections[key];
  const open = stored ? stored === "expanded" : byDefault;
  return [open, () => setPrefs({ sidebarSections: { ...getPrefs().sidebarSections, [key]: open ? "collapsed" : "expanded" } })];
}

/**
 * The sidebar as a chat app draws it: each project with its conversations
 * under it (a chat joins the project its agent works in), then the chats
 * that belong to none. Workspaces and tabs are not levels here; a row names
 * its branch, and the full tree is one click away as the detailed sidebar.
 */
export function SessionSidebar({ onHide, onOpenSettings, onOpenAccount, onSearch, onOpenIssues, onOpenAgents, onOpenAutomations }: RailProps) {
  const store = useSessionStore();
  const [error, setError] = useState<string | null>(null);
  const chatsPath = store.chatsPath ? canon(store.chatsPath) : null;
  const projects = store.projects.filter((project) => !project.archived && canon(project.path) !== chatsPath).sort((a, b) => a.name.localeCompare(b.name));
  const showAgents = useMemo(() => mixesAgents(store.sessions.filter((session) => !session.archived)), [store.sessions]);
  const { groups, chats } = useMemo(
    () => groupConversations(store.sessions, store.projects, chatsPath, store.workspaces, store.selectedSessionId),
    [store.sessions, store.projects, chatsPath, store.workspaces, store.selectedSessionId],
  );

  const run = (action: () => Promise<unknown>) => () => {
    action().then(() => setError(null), (cause) => setError(errorMessage(cause)));
  };
  const newChat = run(() => startChat());
  const move = async (session: SessionEntry, projectPath: string, worktree: boolean) => {
    const moved = await moveChatToProject({ ...session, title: conversationTitle(session) }, projectPath, worktree);
    if (!moved.delivered) throw new Error("Moved, but the chat's context could not be confirmed as sent. It is in the new conversation's composer.");
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
        {groups.length === 0 && chats.length === 0 ? (
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
              <ListSection id="projects" label="Projects">
                {groups.map((group) => (
                  <ProjectGroup
                    key={group.path}
                    group={group}
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
                        onMove: (project, worktree) => run(() => move(session, project.path, worktree))(),
                        onAddProject: (worktree) => run(async () => {
                          const dir = await openDialog({ directory: true, multiple: false, title: "Link this chat to a project" });
                          if (typeof dir !== "string") return;
                          const project = await addProject(dir);
                          await move(session, project.path, worktree && project.kind !== "folder");
                        })(),
                      }}
                    />
                  ))}
                </ul>
              </ListSection>
            )}
          </>
        )}
      </nav>
      </ShowAgents.Provider>

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

function ListSection({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const [open, toggle] = useFold(`list:${id}`, true);
  return (
    <section aria-labelledby={`list-${id}`} className="mb-3">
      <button
        type="button"
        id={`list-${id}`}
        onClick={toggle}
        aria-expanded={open}
        className="flex h-6 items-center gap-1 rounded-sm px-2 text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {label}
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && children}
    </section>
  );
}

/** A project, then its conversations along a guide line: the latest few, the open one, and "View all". */
function ProjectGroup({
  group,
  selectedId,
  workspaces,
  onNewSession,
}: {
  group: ConversationGroup;
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
    const checkout = workspaces.find((workspace) => workspace.branch === branch)?.path ?? sessions.find((session) => session.worktreeName && !session.worktreeRemoved)?.cwd;
    if (checkout) return { label: `New session on ${branch || "this branch"}`, run: () => onNewSession({ cwd: checkout }) };
    if (!branch) return null;
    return { label: `New workspace from ${branch}`, run: () => onNewSession({ fromBranch: branch }) };
  };
  const [all, toggleAll] = useFold(`project-all:${canon(group.path)}`, false);
  // The project folds its branches away: its picture turns into a chevron on hover, and stays one while folded.
  const [open, toggle] = useFold(`project:${canon(group.path)}`, true);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const { animations } = usePrefs();
  // One row per branch, newest work first; the conversations come in that order already.
  const branches = useMemo(() => {
    const byBranch = new Map<string, SessionEntry[]>();
    for (const session of group.sessions) {
      const branch = group.branches[session.id] ?? "";
      byBranch.set(branch, [...(byBranch.get(branch) ?? []), session]);
    }
    return [...byBranch.entries()].map(([branch, sessions]) => ({ branch, sessions }));
  }, [group]);
  const shown = all ? branches : branches.filter((entry, index) => index < PEEK || entry.sessions.some((session) => session.id === selectedId));
  const more = branches.length > shown.length || (all && branches.length > PEEK);
  return (
    <div role="group" aria-label={group.name} className="mb-1">
      <DropdownMenu>
        <div className={cn(actionRow, "relative flex h-8 items-center gap-2 rounded-md px-2 hover:bg-selected/50")} title={group.path}>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? `Collapse ${group.name}` : `Expand ${group.name}`}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
      <ul className="ml-[15px] flex flex-col gap-px border-l border-hairline pl-1.5">
        {shown.map(({ branch, sessions }) =>
          sessions.length === 1 ? (
            <ConversationRow
              key={branch}
              session={sessions[0]}
              selected={selectedId === sessions[0].id}
              branch={branch || null}
              named="branch"
              onNewSession={newSessionOn(branch, sessions)}
              linkTo={null}
            />
          ) : (
            <BranchRow key={branch} path={group.path} branch={branch} sessions={sessions} selectedId={selectedId} onNewSession={newSessionOn(branch, sessions)} />
          ),
        )}
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
  onNewSession,
}: {
  path: string;
  branch: string;
  sessions: SessionEntry[];
  selectedId: string | null;
  onNewSession: NewSessionAction | null;
}) {
  const holdsSelected = sessions.some((session) => session.id === selectedId);
  const [open, toggle] = useFold(`branch:${canon(path)}:${branch}`, false);
  const expanded = open || holdsSelected;
  const label = branch || "No branch";
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
          <GitBranch className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{label}</span>
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
        <ul className="ml-[13px] flex flex-col gap-px border-l border-hairline pl-1.5">
          {sessions.map((session) => (
            <ConversationRow key={session.id} session={session} selected={selectedId === session.id} branch={null} linkTo={null} />
          ))}
        </ul>
      )}
    </li>
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

function ConversationRow({
  session,
  selected,
  branch,
  named = "title",
  onNewSession = null,
  linkTo,
}: {
  session: SessionEntry;
  selected: boolean;
  /** What the row is called: the conversation's title, or (alone on its branch in a project) the branch. */
  named?: "title" | "branch";
  /** Start another session on the row's branch, where it is checked out (or a workspace from it). */
  onNewSession?: NewSessionAction | null;
  /** The branch it works on, named at the row's end; without one the row shows when it was last active. */
  branch: string | null;
  /** For a chat linked to nothing: the projects it may be linked to. */
  linkTo: { projects: Project[]; onMove: (project: Project, worktree: boolean) => void; onAddProject: (worktree: boolean) => void } | null;
}) {
  const title = conversationTitle(session);
  const status = sessionStatus(session);
  const agent = useContext(ShowAgents) ? conversationAgent(session) : null;
  const mark = agent && <AgentMark id={agent} className={cn("size-3 text-faint", yieldsToRowActions)} />;
  return (
    <li>
      <DropdownMenu>
        <div
          className={cn(actionRow, "relative flex h-8 items-center gap-2 rounded-md pl-2 pr-1", selected ? "bg-selected text-foreground" : "text-foreground/85 hover:bg-selected/50")}
          title={branch ? `${branch} · ${title}` : title}
        >
          <button
            type="button"
            onClick={() => selectSession(session.id)}
            aria-current={selected ? "true" : undefined}
            aria-label={named === "branch" ? `${branch ?? "No branch"}, ${title}` : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {session.pinned && <Pin className="size-3 shrink-0 text-faint" />}
            {named === "branch" ? (
              <>
                <GitBranch className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{branch ?? "No branch"}</span>
                {mark}
                {/* The row's state sits where the time does, at the end, so the row's own icon keeps its place; while working, the sign stands in for the time. */}
                <StatusMark status={status} />
                {status !== "in_progress" && <RowTime at={session.modified} />}
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
              <RowTime at={session.modified} />
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
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => void confirmDeleteSession(session)}>
            <Trash2 /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
