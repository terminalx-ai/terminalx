import { ArchiveRowButton, DraftPreview, SessionRowExtras, useSessionDraft } from "./SessionRowExtras";
import { BotsSidebarSection } from "@/components/bots/BotsSidebarSection";
import { isUnread } from "@/lib/dashboard";
import { keepFocusForNameField } from "@/lib/cloudSidebarSections";
import { GroupHeader, LocalSidebarSections, MoveToLocalSectionItems } from "./LocalSidebarSections";
import { groupLocalSessions, useLocalSections } from "@/lib/localSections";
import { createContext, useContext, useId, useMemo, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Archive, ArchiveRestore, ChevronDown, CircleDot, Copy, Ellipsis, ExternalLink, Eye, EyeOff, Folder, FolderInput, FolderOpen, FolderPlus, GitBranch, GitPullRequest, GitPullRequestArrow, Github, Laptop, Link, Mail, Palette, Pencil, PictureInPicture2, Pin, Plus, Settings, Share2, SquarePen, SquareTerminal, Trash2 } from "@/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmInApp } from "@/lib/confirm";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { UpdateButton } from "./UpdateNotice";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  AsyncContextMenu,
  AsyncDropdownMenu,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  MenuItemText,
  MenuKbd,
} from "@/components/ui/menu";
import { openSessionShare } from "@/lib/localSharing";
import { showFloatingWindow } from "@/lib/floating";
import { inScratch, isQuickChat, quickChatPlace } from "@/lib/quickChats";
import { listedUnderBot } from "@/lib/botChats";
import { useBotStore } from "@/lib/bots";
import { useShortcutKeys } from "@/lib/hotkeys";
import { archiveWithUndo } from "@/lib/archiveNotices";
import { RowActions, actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { AccountSidebarEntry } from "@/components/account/AccountSidebarEntry";
import { SidebarTitlebar, ViewMenu } from "./SidebarTitlebar";
import { IssuePipelineSettingsDialog } from "@/components/issues/IssuePipelineSettingsDialog";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/api";
import { reportError, showError } from "@/lib/errorToasts";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { useReducedMotion } from "@/lib/reducedMotion";
import { branchSessionsAsTabs } from "@/lib/tabLayouts";
import { branchMerged, checkoutLabel, conversationBranch } from "@/lib/checkout";
import { showDetachedRename } from "@/lib/branchToasts";
import { START_ACTIONS, type StartAction } from "@/lib/projectStart";
import { addProject, archiveSession, archiveSessions, conversationTitle, openProjectOverview, pinSession, removeProject, selectSession, setSessionUnread, setShowArchived, startChat, startFromIn, startSessionIn, updateProject, useSessionStore } from "@/lib/sessions";
import { requestProjectSettings } from "@/lib/projectAdded";
import { ROW_ATTRIBUTE, isPicked, pickOnClick, usePickedSessions } from "@/lib/rowSelection";
import { SidebarBulkBar } from "./SidebarBulkBar";
import { copyText } from "@/lib/clipboard";
import { openRenameSession, openWorktreeCleanup } from "@/lib/dialogs";
import { LOCAL_HOST, mergedNote, useMergedCleanup, useMergedStatus, type HostedStatus } from "@/lib/mergedCleanup";
import { copyShareLink } from "@/lib/localSharing";
import { ContinuationDialog } from "@/components/session/ContinuationDialog";
import { openSettle, openWorkspaceRestore } from "@/lib/dialogs";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import { setSidebarFilter, useSidebarFilter } from "@/lib/sidebarFilter";
import type { Project, TabEntry, Workspace } from "@/types/session";
import type { SessionEntry } from "@/types/session";
import { useFold } from "./useFold";
import { LeadGlyph, LeadHoverCard, LeadTrailing, QueuedPieceRow, RunFamiliesContext, StarterMark, TryMark, WorkerMark, WorkerTier, leadsRun, useLeadFamily, useLeadSummary, useWorkerPiece, type RunFamilies } from "./RunRows";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { showRunView, useRunsByLead } from "@/lib/orchestration";
import { familyHolds, nestWorkers, workerTitle } from "@/lib/runFamily";
import { StatusMarkIcon } from "@/components/ui/SessionStatus";
import { statusText } from "@terminalx/portable/sessionStatus";
import { useSessionRowStatus } from "@/lib/sessionRowStatus";
import { AppDestinations, ProjectAppearance, ProjectGlyph, type RailProps } from "./ProjectRail";
import { MachinesSection } from "@/components/machines/MachinesSection";
import { CloudOrganizations, useHasCloudOrganizations } from "./CloudOrganizations";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { isPlaceholderBranch } from "@/lib/worktreeNames";
import { IssueLinkContextItems, IssueLinkMenuItems } from "@/components/session/IssueLinkMenuItems";

import { compareSidebarSessions, type SidebarSort } from "@/lib/sidebarView";
import { ManualStatusMenu } from "@/components/session/ManualStatus";
import { manualStatusLabel } from "@terminalx/portable/manualStatus";
import { conversationTime } from "@/lib/messageActivity";
import { helperActivity, legacyReviewerSessions, useIssuePipelines } from "@/lib/issuePipeline";

import { bySavedOrder, customSessionOrder, useSidebarOrder, type SidebarOrder } from "@/lib/sidebarOrder";
import { SidebarSortList, SidebarSortGroup, SidebarOrderError, useSidebarSortable } from "./SidebarSort";

const canon = (path: string) => path.replace(/\/+$/, "");

export { conversationTitle };

/**
 * Every live conversation as one list, in custom order or pinned first, then newest. The open one stays even when archived, unless
 * Show archived is on (`showArchived`): it is then among the archived, whose fold it keeps open.
 */
export function orderConversations(sessions: SessionEntry[], selectedId: string | null, showArchived = false, sort: SidebarSort = "updated", order?: SidebarOrder): SessionEntry[] {
  const live = sessions.filter((session) => !session.archived || (!showArchived && session.id === selectedId));
  return order?.custom ? customSessionOrder(live, order) : live.sort((a, b) => compareSidebarSessions(a, b, sort));
}

/** Archived conversations follow the same ordering choice as the live list. */
export function archivedConversations(sessions: SessionEntry[], sort: SidebarSort = "updated", order?: SidebarOrder): SessionEntry[] {
  const archived = sessions.filter((session) => session.archived);
  return order?.custom ? customSessionOrder(archived, order) : archived.sort((a, b) => compareSidebarSessions(a, b, sort));
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
  // A quick chat has no project: its path is its scratch folder, named by its own id (#1464).
  if (isQuickChat(session)) return quickChatLink(session, projects, chatsPath, workspaces);
  // The branch is named the same way the tab strip groups a branch's sessions by (`conversationBranch`).
  const branch = conversationBranch(session, chatsPath, workspaces);
  if (canon(session.projectPath) === chatsPath) {
    // A chat links itself to whichever repo its agent last worked in.
    if (!session.link) return null;
    const linked = canon(session.link.path);
    const project = projects.find((entry) => canon(entry.path) === linked) ?? null;
    return { path: session.link.path, project, name: project?.name ?? (linked.split("/").pop() || linked), branch };
  }
  const path = canon(session.projectPath);
  const project = projects.find((entry) => canon(entry.path) === path) ?? null;
  return { path: session.projectPath, project, name: project?.name ?? (path.split("/").pop() || path), branch };
}

const holds = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * A quick chat is linked to the listed project it was pointed into, its
 * folder or one of its worktrees, as a chat is to the repository its agent
 * works in; the folder never becomes a project. In its scratch folder, or
 * pointed anywhere else, it is linked to nothing and listed under Chats. The
 * deepest folder that holds it wins, so a worktree kept inside its project's
 * folder names its own branch.
 */
function quickChatLink(
  session: SessionEntry,
  projects: Project[],
  chatsPath: string | null,
  workspaces: Record<string, Workspace[]>,
): { path: string; project: Project; name: string; branch: string | null } | null {
  if (inScratch(session)) return null;
  const cwd = canon(session.cwd);
  let best: { depth: number; project: Project; branch: string | null } | null = null;
  for (const project of projects) {
    const root = canon(project.path);
    if (project.archived || root === chatsPath) continue;
    const checkouts = workspaces[project.path] ?? workspaces[root] ?? [];
    const places = [{ path: root, branch: checkouts.find((checkout) => checkout.isMain)?.branch ?? null }, ...checkouts.map((checkout) => ({ path: canon(checkout.path), branch: checkout.branch }))];
    for (const place of places) {
      if (!place.path || !holds(place.path, cwd) || (best && best.depth >= place.path.length)) continue;
      best = { depth: place.path.length, project, branch: place.branch };
    }
  }
  if (!best) return null;
  return { path: best.project.path, project: best.project, name: best.project.name, branch: best.branch ?? session.branch ?? null };
}

/** Where a row out of its project lives, for its tooltip: the project, then the branch by the label it was given. */
export function locationOf(link: NonNullable<ReturnType<typeof conversationLink>>): string {
  const branch = link.branch ? (link.project?.branchLabels?.[link.branch] ?? link.branch) : null;
  return [link.name, branch].filter(Boolean).join(" · ");
}

export interface ConversationGroup {
  path: string;
  name: string;
  project: Project | null;
  sessions: SessionEntry[];
  /** Its archived conversations, while Show archived is on (#718); else none. */
  archived: SessionEntry[];
  /** The branch each conversation works on, by its id. */
  branches: Record<string, string | null>;
}

/**
 * Conversations under the project each is linked to (a chat by the repo its
 * agent works in, any other by its own project), and the chats linked to
 * nothing on their own. Projects come by their latest activity, pinned ones
 * first; inside each, pinned conversations first, then the newest. With
 * `showArchived`, each project's archived conversations, and the chats', are
 * set apart beside them (#718); a project taken out of TerminalX then comes
 * back as a group of its own, so what removing it archived can be found.
 */
export function groupConversations(
  sessions: SessionEntry[],
  projects: Project[],
  chatsPath: string | null,
  workspaces: Record<string, Workspace[]>,
  selectedId: string | null,
  /** List every open project, one with no conversations yet too: one just added is there at once (off while a filter narrows the list). */
  everyProject = false,
  showArchived = false,
  sort: SidebarSort = "updated",
  order?: SidebarOrder,
  /**
   * The sidebar nests a session another started under it (orchestration, PRO-281): a quick chat started by a
   * session in the same list then joins its parent's project, where it can nest, rather than being listed apart.
   */
  nestChildren = false,
): { groups: ConversationGroup[]; chats: SessionEntry[]; archivedChats: SessionEntry[] } {
  const groups = new Map<string, ConversationGroup>();
  const chats: SessionEntry[] = [];
  const archivedChats: SessionEntry[] = [];
  const listed = new Map(sessions.map((session) => [session.id, session]));
  const linkOf = (session: SessionEntry) => {
    const own = conversationLink(session, projects, chatsPath, workspaces);
    if (!nestChildren || !isQuickChat(session)) return own;
    // Up through quick chats to the first session that is not one; a loop in the records follows nothing.
    const seen = new Set([session.id]);
    let parent = session.parent?.sessionId ? listed.get(session.parent.sessionId) : undefined;
    while (parent && isQuickChat(parent) && !seen.has(parent.id)) {
      seen.add(parent.id);
      parent = parent.parent?.sessionId ? listed.get(parent.parent.sessionId) : undefined;
    }
    const lead = parent && !seen.has(parent.id) ? conversationLink(parent, projects, chatsPath, workspaces) : null;
    return lead ? { ...lead, branch: own?.project === lead.project ? own.branch : lead.branch } : own;
  };
  const add = (session: SessionEntry, archived: boolean) => {
    const link = linkOf(session);
    if (!link) {
      (archived ? archivedChats : chats).push(session);
      return;
    }
    const key = canon(link.path);
    const group = groups.get(key) ?? { path: link.path, name: link.name, project: link.project, sessions: [], archived: [], branches: {} };
    (archived ? group.archived : group.sessions).push(session);
    group.branches[session.id] = link.branch;
    groups.set(key, group);
  };
  for (const session of orderConversations(sessions, selectedId, showArchived, sort, order)) add(session, false);
  if (showArchived) for (const session of archivedConversations(sessions, sort, order)) add(session, true);
  if (everyProject) {
    for (const project of projects) {
      const key = canon(project.path);
      if (project.archived || key === chatsPath || groups.has(key)) continue;
      groups.set(key, { path: project.path, name: project.name, project, sessions: [], archived: [], branches: {} });
    }
  }
  // A populated group follows its messages; opening its project is not a message.
  const latest = (group: ConversationGroup) => group.sessions.length
    ? Math.max(...group.sessions.map((session) => Date.parse(sort === "created" ? session.created : conversationTime(session)) || 0))
    : Date.parse(group.project?.lastOpened ?? "") || 0;
  const ordered = [...groups.values()].sort((a, b) => Number(!!b.project?.pinned) - Number(!!a.project?.pinned) || latest(b) - latest(a) || a.path.localeCompare(b.path));
  return { groups: order?.custom ? bySavedOrder(ordered, order.projects, (g) => canon(g.path), (a, b) => a.path.localeCompare(b.path)) : ordered, chats, archivedChats };
}

/**
 * Ask, then take a project out of the sidebar. Its conversations are
 * archived, not deleted, so they can come back: View → Show archived lists
 * them under the project's name (#718). The folder on disk is not touched.
 */
export async function confirmRemoveProject(group: ConversationGroup) {
  const open = group.sessions.filter((session) => !session.archived);
  const conversations = open.length === 1 ? "Its conversation is archived" : open.length ? `Its ${open.length} conversations are archived` : "";
  const detail = conversations
    ? `${conversations} (View → Show archived lists ${open.length === 1 ? "it" : "them"}), and the folder on disk is left as it is.`
    : "The folder on disk is left as it is.";
  const yes = await confirmInApp({ title: `Remove ${group.name} from TerminalX?`, body: detail, action: "Remove", destructive: true });
  if (!yes) return;
  try {
    await archiveSessions(open.map((session) => session.id), true);
    if (group.project) await removeProject(group.path);
  } catch (error) {
    showError(`Couldn't remove “${group.name}” from TerminalX`, error);
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

/**
 * The sidebar as a chat app draws it: each project with its conversations
 * under it (a chat joins the project its agent works in), then the chats
 * that belong to none. Workspaces and tabs are not levels here; a row names
 * its branch, and the full tree is one click away as the detailed sidebar.
 */
export function SessionSidebar({ onHide, onOpenSettings, onOpenAccount, onSearch, onOpenHome, onNewSession, onOpenIssues, onOpenAgents, onOpenAutomations }: RailProps) {
  const store = useSessionStore();
  const order = useSidebarOrder();
  const filter = useSidebarFilter();
  const { sidebarSort } = usePrefs();
  const [error, setError] = useState<string | null>(null);
  // A chat on its way into a project: the dialog that chooses how its new session starts there.
  const [moving, setMoving] = useState<{ session: SessionEntry; source: TabEntry; project: Project; worktree: boolean } | null>(null);
  const chatsPath = store.chatsPath ? canon(store.chatsPath) : null;
  const projects = store.projects.filter((project) => !project.archived && canon(project.path) !== chatsPath).sort((a, b) => a.name.localeCompare(b.name));
  const showAgents = useMemo(() => mixesAgents(store.sessions.filter((session) => !session.archived)), [store.sessions]);
  const sectioned = useHasCloudOrganizations();
  // One row per session: a pipeline's reviewer that was opened as a session of its own folds under its author's
  // (PRO-331), as in one list; its branch's row would otherwise be named by it now that rows go by titles (PRO-384).
  const pipelines = useIssuePipelines();
  const reviewers = useMemo(() => legacyReviewerSessions(pipelines, store.sessions), [pipelines, store.sessions]);
  // Unread or Needs you: only the conversations that pass (and the open one), and so only their projects.
  // A bot's chats are listed under the bot (PRO-468), while Bots is on and the bot is there to list them.
  const { bots } = useBotStore();
  const listed = useMemo(
    () => store.sessions.filter((session) => !reviewers.has(session.id) && !listedUnderBot(session, bots) && (!filter.active || filter.shows(session.id))),
    [filter, store.sessions, reviewers, bots],
  );
  // Archived conversations never pass a filter, so Show archived shows nothing more while one is on.
  const showArchived = store.showArchived && filter.filter === "all";
  const { sections: localSections } = useLocalSections();
  // Pinned sessions leave their project or section for the Pinned group at the top (02.04).
  const pinned = useMemo(() => listed.filter((session) => session.pinned && !session.archived), [listed]);
  const unpinned = useMemo(() => (pinned.length ? listed.filter((session) => !session.pinned || session.archived) : listed), [listed, pinned]);
  const sectionedSessions = useMemo(() => groupLocalSessions(unpinned, localSections), [unpinned, localSections]);
  // Where a project nests the sessions others started (orchestration), a quick chat goes to its parent's project too.
  const nestChildren = useExperimentalSettings()?.orchestratorRuns === true;
  const { groups: allGroups, chats, archivedChats } = useMemo(
    () => groupConversations(sectionedSessions.ungrouped, store.projects, chatsPath, store.workspaces, store.selectedSessionId, !filter.active, showArchived, sidebarSort, order, nestChildren),
    [sectionedSessions, store.projects, chatsPath, store.workspaces, store.selectedSessionId, filter.active, showArchived, sidebarSort, order, nestChildren],
  );

  // Hide project (02.14): out of the sidebar, its sessions still running. A filter that a hidden project's session
  // passes still shows it, and the open session keeps its project there.
  const groups = useMemo(() => allGroups.filter((group) => !group.project?.hidden || filter.active || group.sessions.some((session) => session.id === store.selectedSessionId)), [allGroups, filter.active, store.selectedSessionId]);
  const hiddenProjects = useMemo(() => projects.filter((project) => project.hidden && !groups.some((group) => canon(group.path) === canon(project.path))), [projects, groups]);
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
  // A chat linked to nothing, archived or not: it may still be linked to a project.
  const chatRow = (session: SessionEntry) => (
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
  );

  // A session in a section or the Pinned group names its project in its tooltip; its row is its title (02.14).
  const sectionRow = (session: SessionEntry, inPinned = false) => {
    const link = conversationLink(session, store.projects, chatsPath, store.workspaces);
    return link ? <ConversationRow key={session.id} session={session} selected={store.selectedSessionId === session.id} branch={link.branch} locationLabel={locationOf(link)} linkTo={null} inPinned={inPinned} /> : chatRow(session);
  };
  const hasSections = localSections.length > 0;
  const addProjectMenu = <AddProjectMenu run={(action) => run(async () => action.run())()} />;

  return (
    <div className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-r border-hairline" data-testid="sidebar-rail">
      <SidebarTitlebar onHide={onHide} />

      <div className="shrink-0 px-2">
        <AppDestinations onOpenHome={onOpenHome} onNewSession={onNewSession} onSearch={onSearch} onOpenIssues={onOpenIssues} onOpenAgents={onOpenAgents} onOpenAutomations={onOpenAutomations} />
      </div>

      {error && <div className="mx-2 mt-1 shrink-0 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      <SidebarOrderError />
      <ShowAgents.Provider value={showAgents}>
      <nav className="mt-3 min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain scrollbar-thin px-2 pb-2" aria-label="Conversations" data-testid="conversation-list">
        {/* Bots (PRO-467) sit above the project lists, only while their experimental switch is on. */}
        <BotsSidebarSection />
        <ListHeading label={hasSections ? "Sections" : "Sessions"} actions={<><ViewMenu />{!sectioned && addProjectMenu}</>} />
        <PinnedGroup sessions={pinned} selectedId={store.selectedSessionId} showArchived={showArchived}>{(session) => sectionRow(session, true)}</PinnedGroup>
        <LocalSidebarSections
          groups={sectionedSessions.sections.map(({ section, items }) => ({ section, items: [...orderConversations(items, store.selectedSessionId, showArchived, sidebarSort, order), ...(showArchived ? archivedConversations(items, sidebarSort, order) : [])] }))}
          filtered={filter.active}
          renderSession={(session) => sectionRow(session)}
        />
        {groups.length === 0 && chats.length === 0 && filter.active ? (
          // Nothing local passed; the organizations below may still hold something that did.
          filter.count === 0 && pinned.length === 0 ? <FilteredEmpty text={filter.empty} /> : null
        ) : groups.length === 0 && hiddenProjects.length === 0 && chats.length === 0 && archivedChats.length === 0 && !hasSections && pinned.length === 0 ? (
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
            {(groups.length > 0 || hiddenProjects.length > 0) && (
              // With cloud organizations, Local is a row like theirs; beside sections, the projects get a heading of their own.
              <ListSection
                id="projects"
                label={sectioned ? "Local" : "Projects"}
                mark={sectioned ? <Laptop className="size-3.5 shrink-0 text-muted-foreground" /> : undefined}
                note={sectioned ? "this Mac" : undefined}
                heading={sectioned || hasSections}
                actions={sectioned ? addProjectMenu : undefined}
              >
                <SidebarSortList kind="projects" items={groups.map((group) => ({ id: canon(group.path), name: group.name }))}>
                {groups.map((group) => (
                  <ProjectGroup
                    key={group.path}
                    group={group}
                    hasSections={hasSections}
                    filtered={filter.active}
                    selectedId={store.selectedSessionId}
                    workspaces={store.workspaces[group.path] ?? []}
                    onNewSession={(place) => run(() => startChat({ projectPath: group.path, ...place }))()}
                  />
                ))}
                </SidebarSortList>
                <CleanupLine />
                <HiddenProjects projects={hiddenProjects} />
              </ListSection>
            )}
            {(chats.length > 0 || archivedChats.length > 0) && (
              <ListSection id="chats" label="Chats">
                <ul className="flex flex-col">
                  <SidebarSortList items={chats.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>{chats.map(chatRow)}</SidebarSortList>
                  {archivedChats.length > 0 && (
                    <ArchivedSessions id="chats" count={archivedChats.length} opened={archivedChats.some((session) => session.id === store.selectedSessionId)}>
                      <SidebarSortList items={archivedChats.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>{archivedChats.map(chatRow)}</SidebarSortList>
                    </ArchivedSessions>
                  )}
                </ul>
              </ListSection>
            )}
          </>
        )}
        <MachinesSection />
        <CloudOrganizations onOpenOrganizations={() => onOpenSettings("organizations")} />
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

      <SidebarBulkBar sessions={store.sessions} />
      <div className="flex shrink-0 items-center gap-1 border-t border-hairline px-2 py-2" data-testid="sidebar-account-row">
        {/* The account; Settings keeps the far end. */}
        <div className="min-w-0 max-w-[70%]">
          <AccountSidebarEntry onOpenAccount={onOpenAccount} />
        </div>
        <div className="flex-1" />
        <UpdateButton />
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
      <button type="button" className="underline underline-offset-2 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => { setSidebarFilter("all"); setPrefs({ sidebarProject: null }); }}>
        Show all sessions
      </button>
    </div>
  );
}

/**
 * A list heading as 02.01 draws it: uppercase, letter-spaced and faint, with an optional note after it (" · by
 * status") and its actions at the end.
 */
export function ListHeading({ label, note, actions, className }: { label: string; note?: string; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-7 min-w-0 items-center gap-1 pl-2.5 pr-1", className)} data-testid="list-heading">
      <h2 className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[.08em] text-faint">
        {label}
        {note && <span className="ml-1 font-normal normal-case tracking-normal"> · {note}</span>}
      </h2>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

/**
 * A titled part of the list that folds. Drawn as an organization's row when it has a `mark` (Local, a cloud
 * organization: 02.04), else as an uppercase heading. `note` follows the label ("this Mac", "cloud · 2 running");
 * `actions` sit at the header's end, shown on hover or focus like a row's; `notes` are lines under the header
 * that stay while it is folded (an organization's loading or offline line); `title` is the header's tooltip;
 * `forceOpen` keeps it open whatever its fold. Without `heading` (and a mark) there is no header: the
 * list's own heading above names it.
 */
export function ListSection({
  id,
  label,
  children,
  actions,
  notes,
  title,
  mark,
  note,
  description,
  heading = true,
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
  mark?: ReactNode;
  note?: ReactNode;
  /** Persistent accessible description, also revealed on hover or keyboard focus. */
  description?: string;
  heading?: boolean;
  forceOpen?: boolean;
  /** Open the section's menu: a right-click, or the context-menu key, on its header. */
  onMenu?: () => void;
} & Record<`data-${string}`, string>) {
  const descriptionId = useId();
  const [expanded, toggle] = useFold(`list:${id}`, true);
  const open = expanded || forceOpen || !heading;
  return (
    <section aria-labelledby={heading ? `list-${id}` : undefined} aria-label={heading ? undefined : label} className="mb-4" {...rest}>
      {heading && (
        <div
          className={cn(actionRow, "relative flex h-7 min-w-0 items-center gap-1 rounded-md pr-1", mark ? "mt-2.5 hover:bg-selected/50" : "mt-3")}
          onContextMenu={onMenu && ((event) => { event.preventDefault(); onMenu(); })}
          onKeyDown={onMenu && ((event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            onMenu();
          })}
        >
          <WithTooltip label={description}>
            <button
              type="button"
              id={`list-${id}`}
              onClick={toggle}
              aria-expanded={open}
              aria-label={label}
              aria-describedby={description ? descriptionId : undefined}
              title={title}
              className={cn(
                "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                !mark && "text-[11px] font-medium uppercase tracking-[.08em] text-faint hover:text-muted-foreground",
              )}
            >
              {mark}
              <span data-list-name className={cn("min-w-0 shrink-0 truncate", mark && "max-w-[60%] text-[12.5px] font-medium text-foreground/90")}>{label}</span>
              {note && <span className="min-w-0 truncate text-[11px] text-faint">{note}</span>}
            </button>
          </WithTooltip>
          {description && <span id={descriptionId} className="sr-only">{description}</span>}
          {actions && <div className="flex min-w-0 shrink-0 items-center gap-0.5">{actions}</div>}
          {/* The fold at the header's end, as on a project's row: shown on hover or focus, and always while folded. */}
          <button
            type="button"
            onClick={toggle}
            aria-hidden
            tabIndex={-1}
            className={cn("flex size-5 shrink-0 items-center justify-center rounded-sm text-faint outline-none hover:text-muted-foreground", open && "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100")}
          >
            <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
          </button>
        </div>
      )}
      {notes}
      {open && children}
    </section>
  );
}

/** Pinned sessions, gathered at the top of the list from their projects and sections (02.04, 02.19). */
export function PinnedGroup({ sessions, selectedId, showArchived, children }: { sessions: SessionEntry[]; selectedId: string | null; showArchived: boolean; children: (session: SessionEntry) => ReactNode }) {
  const [expanded, toggle] = useFold("pinned", true);
  const { sidebarSort } = usePrefs();
  const order = useSidebarOrder();
  const { sections } = useLocalSections();
  if (!sessions.length) return null;
  const ordered = orderConversations(sessions, selectedId, showArchived, sidebarSort, order);
  return (
    <section aria-label="Pinned" className="mb-2" data-testid="pinned-group">
      <GroupHeader icon={<Pin className="size-3.5 text-muted-foreground" />} name="Pinned" count={sessions.length} open={expanded} onToggle={toggle} />
      {expanded && (
        <ul className="flex flex-col [--indent:10px]">
          <SidebarSortList items={ordered.map((session) => ({ id: session.id, name: conversationTitle(session), pinned: true, section: sections.find((section) => section.sessions.includes(session.id))?.id ?? null }))}>{ordered.map(children)}</SidebarSortList>
        </ul>
      )}
    </section>
  );
}

/** A project, then all its conversations under it. */
function ProjectGroup({
  group,
  hasSections = false,
  filtered = false,
  selectedId,
  workspaces,
  onNewSession,
}: {
  group: ConversationGroup;
  hasSections?: boolean;
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
  // What the reader named each branch; a branch with a label goes by it, placeholder or not.
  const labels = group.project?.branchLabels ?? {};
  // The project's own checkout is never a placeholder, whatever its branch is called.
  const mainBranch = workspaces.find((workspace) => workspace.isMain)?.branch ?? null;
  const newSessionKeys = useShortcutKeys("app.newSession");
  const startFromKeys = useShortcutKeys("app.startFrom");
  // Its archived chats while Show archived is off: a project with only those has chats, out of the list.
  const allSessions = useSessionStore().sessions;
  const hiddenArchived = useMemo(() => (group.archived.length ? 0 : allSessions.filter((session) => session.archived && canon(session.projectPath) === canon(group.path)).length), [allSessions, group.archived.length, group.path]);
  // Told from the branch's name alone, so a row is drawn by its final name from the first paint, not once the checkouts load.
  const placeholders = useMemo(
    () => new Set(Object.values(group.branches).filter((branch) => branch && branch !== mainBranch && isPlaceholderBranch(branch) && !group.project?.branchLabels?.[branch])),
    [group.branches, mainBranch, group.project?.branchLabels],
  );
  // The branch whose Rename dialog is open. The project's own checkout keeps its branch; its label can still change.
  const [renaming, setRenaming] = useState<string | null>(null);
  // On a detached HEAD there is no branch to rename: Rename branch… says so, and offers to make one at the commit (PRO-295).
  // The row's branch reads "detached at 1a2b3c4" then (or nothing): it is the checkout that says there is no branch.
  const detachedCheckout = (session: SessionEntry, branch: string) => {
    if (session.worktreeRemoved) return null;
    const checkout = workspaces.find((workspace) => canon(workspace.path) === canon(session.cwd));
    if (!checkout || checkout.branch || !checkout.head || (branch && branch !== checkoutLabel(checkout))) return null;
    return { ...checkout, head: checkout.head };
  };
  // A detached row is one checkout's (see `branches` below), so any live session in it names that checkout: the open
  // one first, else the next that still is, not just the first, which may be gone (PRO-367).
  const detachedAt = (branch: string, sessions: SessionEntry[]) => {
    const selected = sessions.find((entry) => entry.id === selectedId);
    for (const session of selected ? [selected, ...sessions.filter((entry) => entry !== selected)] : sessions) {
      const checkout = detachedCheckout(session, branch);
      if (checkout) return { cwd: checkout.path, head: checkout.head, title: conversationTitle(session) || null };
    }
    return null;
  };
  const renameBranch = (branch: string, sessions: SessionEntry[]) => {
    if (!group.project || group.project.kind === "folder") return null;
    const detached = detachedAt(branch, sessions);
    if (detached) return () => void showDetachedRename({ projectPath: group.path, ...detached });
    return branch ? () => setRenaming(branch) : null;
  };
  const nav = useSessionStore();
  const sort = useSidebarSortable(canon(group.path));
  const overviewOpen = nav.view === "project" && !!nav.selectedProject && canon(nav.selectedProject) === canon(group.path);
  // The project folds its branches away by the chevron at its row's end, shown on hover and always while folded.
  const [expanded, toggle] = useFold(`project:${canon(group.path)}`, true);
  const open = expanded || filtered;
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const menu = useRowMenu();
  const prefs = usePrefs();
  const reduced = useReducedMotion();
  // A branch's sessions are tabs or sidebar rows, never both: as tabs, the branch is one row here whatever their number.
  const asTabs = branchSessionsAsTabs(prefs);
  // Orchestration (PRO-281), behind Settings → Experimental: a lead's workers nest under its row, whatever worktree
  // they run in, instead of each taking a branch row of its own. Off, every session is listed as before.
  const orchestrating = useExperimentalSettings()?.orchestratorRuns === true;
  const runs = useRunsByLead(orchestrating);
  const nested = useMemo(() => (orchestrating ? nestWorkers(group.sessions, runs) : { top: group.sessions, workersOf: {} }), [orchestrating, group.sessions, runs]);
  const families = useMemo<RunFamilies>(() => ({ workersOf: nested.workersOf, runs }), [nested.workersOf, runs]);
  // One row per branch, newest work first; the conversations come in that order already.
  const branches = useMemo(() => {
    const byBranch = new Map<string, { key: string; branch: string; sessions: SessionEntry[] }>();
    for (const session of nested.top) {
      const branch = group.branches[session.id] ?? "";
      // A retained history must not join a live checkout merely because its
      // original branch name has been reused (or it now resumes on main).
      // Checkouts detached at one commit share a label, not a row: each is its own, so its actions act on it (PRO-367).
      const detached = branch ? detachedCheckout(session, branch) : null;
      const key = session.worktreeRemoved ? `removed:${session.removedWorkspace?.path ?? session.id}` : detached ? `detached:${canon(detached.path)}` : `branch:${branch}`;
      const entry = byBranch.get(key) ?? { key, branch, sessions: [] };
      entry.sessions.push(session);
      byBranch.set(key, entry);
    }
    return [...byBranch.values()];
  }, [group, nested.top, workspaces]);
  // A removed workspace's conversations are kept, read and resumed from here, but set apart from the live ones
  // under a fold of their own (#696): left in the list, they sat beside live work for good.
  const live = branches.filter((entry) => !entry.key.startsWith("removed:"));
  const removed = branches.filter((entry) => entry.key.startsWith("removed:"));
  const shown = live;
  const sortBranch = ({ key, branch, sessions }: { key: string; branch: string; sessions: SessionEntry[] }) => {
    const tabbed = asTabs ? sessions.filter((session) => session.tabs.length > 0) : sessions;
    const represented = tabbed.length ? tabbed : sessions;
    const current = represented.find((session) => session.id === selectedId) ?? represented[0];
    const byTitle = (sessions.length === 1 || asTabs) && !current.worktreeRemoved && placeholders.has(branch);
    return { id: `branch:${key}`, name: byTitle ? conversationTitle(current) : labels[branch] ?? (branch || "No branch"), members: sessions.map((session) => session.id) };
  };
  const branchRow = (key: string, branch: string, sessions: SessionEntry[], sortId = `branch:${key}`) => (
    <ConversationRow
      key={key}
      sortId={sortId}
      // The branch's row opens the session that is open on it, else its latest.
      session={sessions.find((session) => session.id === selectedId) ?? sessions[0]}
      peers={sessions}
      selected={sessions.some((session) => session.id === selectedId)}
      branch={!sessions[0].worktreeRemoved && placeholders.has(branch) ? null : branch || null}
      named={!sessions[0].worktreeRemoved && placeholders.has(branch) ? "title" : "branch"}
      merged={!sessions[0].worktreeRemoved && merged.has(branch)}
      onNewSession={newSessionOn(branch, sessions)}
      label={labels[branch]}
      onRenameBranch={renameBranch(branch, sessions)}
      linkTo={null}
    />
  );
  // As tabs, a branch's row stands for the sessions whose tabs are in its row of tabs. A session with no tab open has
  // nothing there to click, so it keeps a row of its own under the branch's, named by its title: that row opens it,
  // with its own page, closed tabs and history (#721). Once it has a tab again it is one of the branch's tabs.
  const tabsRows = (key: string, branch: string, sessions: SessionEntry[]) => {
    const tabbed = sessions.filter((session) => session.tabs.length > 0);
    const bare = sessions.filter((session) => !session.tabs.length);
    if (!bare.length || sessions.length === 1) return branchRow(key, branch, sessions);
    return (
      <SidebarSortGroup key={key} id={`branch:${key}`}>
        {tabbed.length > 0 && branchRow(key, branch, tabbed, `display:${key}`)}
        <SidebarSortList items={bare.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>
        {bare.map((session) => (
          <ConversationRow
            key={session.id}
            session={session}
            selected={session.id === selectedId}
            branch={!session.worktreeRemoved && placeholders.has(branch) ? null : branch || null}
            label={labels[branch]}
            linkTo={null}
          />
        ))}
        </SidebarSortList>
      </SidebarSortGroup>
    );
  };
  const row = ({ key, branch, sessions }: { key: string; branch: string; sessions: SessionEntry[] }) =>
    sessions.length === 1 || asTabs ? (
      tabsRows(key, branch, sessions)
    ) : (
      <BranchRow
        key={key}
        sortId={`branch:${key}`}
        path={group.path}
        branch={branch}
        foldKey={key.startsWith("branch:") ? branch : key}
        label={labels[branch]}
        sessions={sessions}
        selectedId={selectedId}
        opened={filtered}
        merged={!sessions[0].worktreeRemoved && merged.has(branch)}
        onNewSession={newSessionOn(branch, sessions)}
        onRename={renameBranch(branch, sessions)}
      />
    );
  return (
    <div ref={sort.ref} style={sort.style} role="group" aria-label={group.name} className="mb-2 last:mb-0">
      <DropdownMenu {...menu.root}>
        <div {...menu.surface} className={cn(actionRow, "relative flex h-7 items-center gap-2 rounded-md pl-2.5 pr-1 hover:bg-selected/50", overviewOpen && "bg-selected")} title={group.path}>
          {sort.handle}
          {/* The picture always tells projects apart (PRO-373): never swapped for the chevron. A click on it still folds
              the project, as before; the keyboard folds with the chevron at the row's end. */}
          <span aria-hidden onClick={toggle} className="flex h-full shrink-0 items-center">
            {group.project ? <ProjectGlyph project={group.project} size={14} /> : <Folder className="size-3.5 text-faint" />}
          </span>
          <button
            type="button"
            onClick={() => (group.project ? openProjectOverview(group.path) : toggle())}
            aria-current={overviewOpen ? "page" : undefined}
            aria-label={group.project ? `${group.name} overview` : undefined}
            className="flex h-full min-w-0 flex-1 items-center rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-muted-foreground">{group.name}</span>
          </button>
          <RowActions>
            <WithTooltip label={`New chat in ${group.name}`}>
              <Button variant="ghost" size="icon-xs" aria-label={`New chat in ${group.name}`} onClick={() => startSessionIn(group.path, null)}>
                <Plus />
              </Button>
            </WithTooltip>
            <DropdownMenuTrigger asChild {...menu.trigger}>
              <Button variant="ghost" size="icon-xs" aria-label={`Project menu for ${group.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </RowActions>
          {/* The fold sits at the row's end, after the hover actions, as on the section headers: shown on hover or
              focus, and always while folded. It keeps its place when hidden so the actions never move onto it. */}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? `Collapse ${group.name}` : `Expand ${group.name}`}
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-sm text-faint outline-none transition-opacity duration-150 hover:text-muted-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40",
              open && "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-has-[[data-state=open]]/row:opacity-100",
            )}
          >
            <ChevronDown className={cn("size-3 transition-transform duration-200", !open && "-rotate-90")} data-testid="project-fold" />
          </button>
        </div>
        {/* The designed project menu (02.14): start something, its settings, then how it shows in the sidebar. */}
        <DropdownMenuContent align="end" className="w-[288px]">
          <DropdownMenuItem onSelect={() => startSessionIn(group.path, null)}>
            <SquarePen /> <span className="min-w-0 flex-1 truncate">New session</span><MenuKbd keys={newSessionKeys} />
          </DropdownMenuItem>
          {group.project && group.project.kind !== "folder" && (
            <DropdownMenuItem onSelect={() => startFromIn(group.path)}>
              <GitPullRequestArrow /> <span className="min-w-0 flex-1 truncate">Start from a branch, issue or PR…</span><MenuKbd keys={startFromKeys} />
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {group.project && (
            <>
              <DropdownMenuItem onSelect={() => requestProjectSettings(group.path, "general")}>
                <Settings /> Project settings
              </DropdownMenuItem>
              {group.project.kind !== "folder" && (
                <DropdownMenuItem onSelect={() => requestProjectSettings(group.path, "scripts")}>
                  <SquareTerminal /> Scripts and actions
                </DropdownMenuItem>
              )}
              {/* Not in Settings: a project's name, colour and logo, and its issue pipeline, are set from here. */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Palette /> Name and appearance
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <ProjectAppearance project={group.project} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {group.project.kind !== "folder" && (
                <DropdownMenuItem onSelect={() => setPipelineOpen(true)}>
                  <GitPullRequest /> Issue pipeline…
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ExternalLink /> Open in
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuItem onSelect={() => void Promise.resolve().then(() => revealItemInDir(group.path)).catch(reportError(`Couldn't reveal “${group.name}” in Finder`))}>
                <FolderOpen /> Finder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyText(group.path).catch(reportError(`Couldn't copy the path of “${group.name}”`))}>
                <Copy /> Copy path
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {group.project && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void updateProject(group.path, { pinned: !group.project?.pinned }).catch(reportError(`Couldn't ${group.project?.pinned ? "unpin" : "pin"} “${group.name}”`))}>
                <Pin /> {group.project.pinned ? "Unpin project" : "Pin project"}
              </DropdownMenuItem>
              <DropdownMenuItem className="items-start" onSelect={() => void updateProject(group.path, { hidden: !group.project?.hidden }).catch(reportError(`Couldn't ${group.project?.hidden ? "show" : "hide"} “${group.name}”`))}>
                {group.project.hidden ? <Eye className="mt-0.5" /> : <EyeOff className="mt-0.5" />}
                <MenuItemText label={group.project.hidden ? "Show project" : "Hide project"} hint={group.project.hidden ? "Back in the sidebar" : "Hidden from the sidebar; sessions keep running"} />
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive className="items-start" onSelect={() => void confirmRemoveProject(group)}>
            <Trash2 className="mt-0.5" /> <MenuItemText label="Remove project…" hint="The folder on disk is left as it is." />
          </DropdownMenuItem>
        </DropdownMenuContent>
        {/* Mounted only while open: a row per project would otherwise each hold a dialog. */}
        {pipelineOpen && group.project && <IssuePipelineSettingsDialog project={group.project} open onOpenChange={setPipelineOpen} />}
      </DropdownMenu>
      {/* The branches slide open and closed: a grid row that grows from nothing to its content's height, which a height alone cannot animate. */}
      <div
        className={cn("grid", !reduced && "transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        aria-hidden={!open}
        inert={!open}
        data-testid="project-branches"
      >
        <div className="min-h-0 overflow-hidden">
      {/* Rows are inset and rounded; their content is indented by `--indent` under the project's name. */}
      <RunFamiliesContext.Provider value={families}>
      <ul className="flex flex-col [--indent:10px] [--indent-2:24px]">
        <SidebarSortList items={shown.map(sortBranch)}>
          {shown.map(row)}
        </SidebarSortList>
        {branches.length === 0 && group.archived.length === 0 && (hiddenArchived > 0 ? (
          // Only archived chats (PRO-386): it has chats, they are out of the list. The line shows them.
          <li>
            <button
              type="button"
              onClick={() => setShowArchived(true)}
              title="Show archived"
              data-testid="only-archived"
              className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md pr-2 pl-[calc(0.5rem+var(--indent,0px))] text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Archive className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{hiddenArchived === 1 ? "1 archived chat" : `${hiddenArchived} archived chats`}</span>
            </button>
          </li>
        ) : <li className="flex h-7 items-center pr-2 pl-[calc(0.5rem+var(--indent,0px))] text-[12px] text-faint">{hasSections ? "No chats in the main list" : "No chats yet"}</li>)}
        {removed.length > 0 && (
          <RemovedWorkspaces
            id={canon(group.path)}
            count={removed.length}
            opened={filtered || removed.some((entry) => entry.sessions.some((session) => session.id === selectedId))}
          >
            <SidebarSortList items={removed.map(sortBranch)}>{removed.map(row)}</SidebarSortList>
          </RemovedWorkspaces>
        )}
        {group.archived.length > 0 && (
          <ArchivedSessions id={canon(group.path)} count={group.archived.length} opened={group.archived.some((session) => session.id === selectedId)}>
            <SidebarSortList items={group.archived.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>
            {group.archived.map((session) => (
              <ConversationRow key={session.id} session={session} selected={session.id === selectedId} branch={group.branches[session.id] || null} linkTo={null} inArchive />
            ))}
            </SidebarSortList>
          </ArchivedSessions>
        )}
      </ul>
      </RunFamiliesContext.Provider>
        </div>
      </div>
      {renaming !== null && (
        <RenameBranchDialog
          key={renaming}
          projectPath={group.path}
          branch={renaming}
          label={labels[renaming]}
          canRenameBranch={renaming !== mainBranch}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}

/**
 * The conversations of workspaces that were removed (#696): kept, and read and resumed from here (a message resumes
 * one in its project's folder), but out of the live list. Folded until opened, and open while it holds the open
 * conversation or a filter is on. `children` are list items.
 */
export function RemovedWorkspaces({ id, count, opened, children }: { id: string; count: number; opened: boolean; children: ReactNode }) {
  const [open, toggle] = useFold(`removed-workspaces:${id}`, false);
  const expanded = open || opened;
  return (
    <li data-testid="removed-workspaces">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        title="Their workspaces were removed. The conversations are kept, and a message resumes one in its project's folder."
        className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md pr-2 pl-[calc(0.5rem+var(--indent,0px))] text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="min-w-0 truncate">Removed workspaces ({count})</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />
      </button>
      {expanded && <ul className="flex flex-col">{children}</ul>}
    </li>
  );
}

/**
 * A project's archived conversations, or the chats', while Show archived is on (#718): kept whole, out of the live
 * list. Open until the reader folds it, and open whatever its fold while it holds the open conversation. A row's
 * Unarchive, or a message to it, puts it back. `children` are list items.
 */
export function ArchivedSessions({ id, count, opened, children }: { id: string; count: number; opened: boolean; children: ReactNode }) {
  const [open, toggle] = useFold(`archived-sessions:${id}`, true);
  const expanded = open || opened;
  return (
    <li data-testid="archived-sessions">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        title="Archived: out of the list and kept whole. Unarchive puts one back, and so does a message to it."
        className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md pr-2 pl-[calc(0.5rem+var(--indent,0px))] text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Archive className="size-3 shrink-0" />
        <span className="min-w-0 truncate">Archived ({count})</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />
      </button>
      {expanded && <ul className="flex flex-col">{children}</ul>}
    </li>
  );
}

/** A row's Unarchive, one click away on an archived conversation. */
export function UnarchiveButton({ session, title }: { session: SessionEntry; title: string }) {
  return (
    <WithTooltip label="Unarchive">
      <Button variant="ghost" size="icon-xs" aria-label={`Unarchive ${title}`} onClick={() => void archiveSession(session.id, false).catch(reportError(`Couldn't unarchive “${title}”`))}>
        <ArchiveRestore />
      </Button>
    </WithTooltip>
  );
}

/** A branch more than one conversation works on: the branch, how many, and the conversations under it. */
function BranchRow({
  sortId,
  path,
  branch,
  label: named,
  sessions,
  selectedId,
  opened,
  merged,
  onNewSession,
  onRename,
  foldKey,
}: {
  sortId: string;
  path: string;
  branch: string;
  /** What its fold is remembered by: the branch, or the one checkout or removed workspace the row stands for. */
  foldKey: string;
  /** What the reader named the branch, shown instead of it. */
  label?: string;
  onRename: (() => void) | null;
  sessions: SessionEntry[];
  selectedId: string | null;
  /** Open whatever its fold: the sidebar's filter is on. */
  opened: boolean;
  /** Its commits are in the default branch. */
  merged: boolean;
  onNewSession: NewSessionAction | null;
}) {
  const sort = useSidebarSortable(sortId);
  const { workersOf } = useContext(RunFamiliesContext);
  const holdsSelected = sessions.some((session) => session.id === selectedId || familyHolds(workersOf, session.id, selectedId));
  const removed = sessions.every((session) => session.worktreeRemoved);
  const cleanup = useMergedStatus(LOCAL_HOST, removed ? null : sessions[0]?.cwd);
  const [open, toggle] = useFold(`branch:${canon(path)}:${foldKey}`, false);
  const expanded = open || holdsSelected || opened;
  const label = `${named ?? (branch || "No branch")}${removed ? " (workspace removed)" : ""}`;
  return (
    <li ref={sort.ref} style={sort.style}>
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div className={cn(actionRow, "relative flex h-[30px] items-center rounded-md pr-2.5 text-foreground/90 hover:bg-selected/50")}>
        {sort.handle}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          title={named ? `${named} · ${branch}` : label}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pl-[calc(1rem+var(--indent,0px))] pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <BranchGlyph merged={merged} cleanup={cleanup} />
          <span className="min-w-0 flex-1 truncate text-[13px]">{named ?? (branch || "No branch")}</span>
          {removed && <span className="shrink-0 text-[12px] text-faint">removed</span>}
          <span className={cn("shrink-0 font-mono text-[12px] tabular-nums text-faint", yieldsToRowActions)}>{sessions.length}</span>
          <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform", !expanded && "-rotate-90")} />
        </button>
        {onNewSession && (
          <RowActions>
            <NewSessionButton action={onNewSession} />
          </RowActions>
        )}
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {onRename && (
          <ContextMenuItem onSelect={onRename}>
            <Pencil /> Rename branch…
          </ContextMenuItem>
        )}
        {branch && (
          <ContextMenuItem onSelect={() => void copyText(branch).catch(reportError(`Couldn't copy the branch name “${branch}”`))}>
            <GitBranch /> Copy branch name
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <ul className="flex flex-col [--indent:var(--indent-2)]">
          <SidebarSortList items={sessions.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>
          {sessions.map((session) => (
            <ConversationRow key={session.id} session={session} selected={selectedId === session.id} branch={null} linkTo={null} />
          ))}
          </SidebarSortList>
        </ul>
      )}
    </li>
  );
}

/**
 * A branch row's icon; a merged branch has a tick drawn into its empty corner, in the icon's own stroke. A merged
 * workspace clean-up has not deleted (`cleanup`) has the tick in amber, and its tooltip says why: the row's quiet
 * marker, where the full story and its buttons are in the session's Branch tab.
 */
function BranchGlyph({ merged, cleanup }: { merged: boolean; cleanup?: HostedStatus }) {
  const waiting = cleanup && cleanup.phase !== "removed";
  if (!merged && !waiting) return <GitBranch className="size-4 shrink-0 text-muted-foreground" />;
  const note = waiting ? mergedNote(cleanup) : "";
  const title = waiting ? `${note.charAt(0).toUpperCase()}${note.slice(1)}` : "Merged: its commits are in the default branch";
  return (
    <span className="flex shrink-0" title={title} data-testid={waiting ? "branch-cleanup-marker" : undefined}>
      <GitBranch className="size-4 text-muted-foreground">
        <path d="M9.25 3.75l1.75 1.75 3.5-3.75" className={waiting && cleanup.phase === "kept" ? "text-warning" : "text-info"} />
      </GitBranch>
      <span className="sr-only">{waiting ? title : "merged"}</span>
    </span>
  );
}

/**
 * Under the projects: the ones hidden from the sidebar (02.14 Hide project), folded into one line. Opened, each
 * has Show, which puts it back.
 */
function HiddenProjects({ projects }: { projects: Project[] }) {
  const [open, toggle] = useFold("hidden-projects", false);
  if (!projects.length) return null;
  return (
    <div data-testid="hidden-projects" className="mt-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 px-4 text-left text-[12.5px] text-faint outline-none hover:bg-selected/50 hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <EyeOff className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{projects.length === 1 ? "1 hidden project" : `${projects.length} hidden projects`}</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {projects.map((project) => (
            <li key={project.path} className={cn(actionRow, "relative -mx-2 flex h-8 items-center gap-2 pl-[calc(1rem+10px)] pr-3 text-muted-foreground hover:bg-selected/50")} title={project.path}>
              <ProjectGlyph project={project} />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{project.name}</span>
              <Button variant="ghost" size="xs" aria-label={`Show ${project.name} in the sidebar`} onClick={() => void updateProject(project.path, { hidden: false }).catch(reportError(`Couldn't show “${project.name}”`))}>
                <Eye /> Show
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Under the projects: how many merged workspaces clean-up kept, as one line that opens the clean-up list. Only
 * while there are some; nothing pops up for them.
 */
function CleanupLine() {
  const { statuses } = useMergedCleanup();
  const kept = Object.values(statuses).filter((status) => status.phase === "kept").length;
  if (!kept) return null;
  return (
    <button
      type="button"
      onClick={openWorktreeCleanup}
      data-testid="sidebar-cleanup-line"
      className="mt-1 flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] text-muted-foreground outline-none hover:bg-selected/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className="min-w-0 flex-1 truncate">Clean up {kept} merged {kept === 1 ? "workspace" : "workspaces"}</span>
    </button>
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

type ConversationLinkActions = { projects: Project[]; onMove: (project: Project, worktree: boolean) => void; onAddProject: (worktree: boolean) => void };

type ConversationMenuProps = {
  session: SessionEntry;
  branch: string | null;
  rename: (() => void) | null;
  renameBranch?: (() => void) | null;
  /** The sessions the row stands for, which Select picks for the bulk bar. */
  ids?: string[];
  linkTo?: ConversationLinkActions | null;
};

/** One action list for a conversation's ⋯, right-click and keyboard menus, in both sidebar layouts. */
export function ConversationMenuItems({ session, branch, rename, renameBranch, ids = [session.id], linkTo, contextMenu = false }: ConversationMenuProps & { contextMenu?: boolean }) {
  const Item = contextMenu ? ContextMenuItem : DropdownMenuItem;
  const Separator = contextMenu ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = contextMenu ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = contextMenu ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = contextMenu ? ContextMenuSubContent : DropdownMenuSubContent;
  const IssueItems = contextMenu ? IssueLinkContextItems : IssueLinkMenuItems;
  const title = conversationTitle(session) || "this conversation";
  const copy = (text: string, what: string) => void copyText(text).catch(reportError(`Couldn't copy ${what}`));
  const store = useSessionStore();
  const unread = store.sessions.filter((entry) => ids.includes(entry.id)).some(isUnread);
  const archiveKeys = useShortcutKeys("session.archive");
  const [error, setError] = useState<string | null>(null);
  // The designed list (02.13): what the reader does most first, the rest a submenu away. Keys show only where one
  // is bound: R and P act in this menu, Archive shows the reader's own key for it (none by default).
  return (
    <>
      {session.tabs.length > 0 && <Item data-row-key="r" aria-keyshortcuts="R" onSelect={(event) => {
        event.preventDefault();
        setError(null);
        void setSessionUnread(ids, !unread).catch((cause) => setError(errorMessage(cause)));
      }}>
        <Mail /> {unread ? "Mark as read" : "Mark as unread"}<MenuKbd keys="R" />
      </Item>}
      {error && <span role="alert" className="block px-2 text-xs text-destructive">{error}</span>}
      <Item data-row-key="p" aria-keyshortcuts="P" onSelect={() => void pinSession(session.id, !session.pinned).catch(reportError(`Couldn't ${session.pinned ? "unpin" : "pin"} “${title}”`))}>
        <Pin /> {session.pinned ? "Unpin" : "Pin"}<MenuKbd keys="P" />
      </Item>
      <ManualStatusMenu sessionId={session.id} status={session.manualStatus} contextMenu={contextMenu} />
      <MoveToLocalSectionItems sessionIds={ids} home={store.projects.find((project) => project.path === session.projectPath)?.name} contextMenu={contextMenu} />
      {linkTo && (
        <Sub>
          <SubTrigger>
            <FolderInput /> Link to a project
          </SubTrigger>
          <SubContent className="w-60">
            {linkTo.projects.map((project) =>
              project.kind === "folder" ? (
                <Item key={project.path} onSelect={() => linkTo.onMove(project, false)}>
                  <ProjectGlyph project={project} /> <span className="truncate">{project.name}</span>
                </Item>
              ) : (
                <Sub key={project.path}>
                  <SubTrigger>
                    <ProjectGlyph project={project} /> <span className="truncate">{project.name}</span>
                  </SubTrigger>
                  <SubContent>
                    {/* A worktree first: the project's own checkout is shared with its other conversations. */}
                    <Item onSelect={() => linkTo.onMove(project, true)}>
                      <GitBranch /> On a new branch (worktree)
                    </Item>
                    <Item onSelect={() => linkTo.onMove(project, false)}>
                      <FolderOpen /> In its main checkout
                    </Item>
                  </SubContent>
                </Sub>
              ),
            )}
            {linkTo.projects.length > 0 && <Separator />}
            <Item onSelect={() => linkTo.onAddProject(false)}>
              <FolderPlus /> Choose a folder…
            </Item>
            <Item onSelect={() => linkTo.onAddProject(true)}>
              <GitBranch /> Choose a repo, new branch…
            </Item>
          </SubContent>
        </Sub>
      )}
      <Sub>
        <SubTrigger>
          <ExternalLink /> Open in
        </SubTrigger>
        <SubContent className="w-56">
          <Item onSelect={() => void Promise.resolve().then(() => revealItemInDir(session.cwd)).catch(reportError(`Couldn't reveal “${title}” in Finder`))}>
            <FolderOpen /> Finder
          </Item>
          {session.tabs.length > 0 && (
            <Item onSelect={() => void showFloatingWindow(session.id, session.activeTab).catch(reportError(`Couldn't open “${title}” in a floating window`))}>
              <PictureInPicture2 /> Floating window
            </Item>
          )}
          <Separator />
          <Item onSelect={() => copy(session.cwd, `the path of “${title}”`)}>
            <Copy /> Copy path
          </Item>
          {branch && (
            <Item onSelect={() => copy(branch, `the branch name “${branch}”`)}>
              <GitBranch /> Copy branch name
            </Item>
          )}
        </SubContent>
      </Sub>
      {rename && (
        <Item data-row-key="n" aria-keyshortcuts="N" onSelect={rename}>
          <Pencil /> Rename…
        </Item>
      )}
      {renameBranch && (
        <Item onSelect={renameBranch}>
          <GitBranch /> Rename branch…
        </Item>
      )}
      <Item onSelect={() => void copyShareLink(session.id).catch(reportError(`Couldn't copy a link to “${title}”`))}>
        <Link /> Copy link
      </Item>
      <Item onSelect={() => openSessionShare(session.id)}>
        <Share2 /> Share session…
      </Item>
      {!isQuickChat(session) && (
        <Sub>
          <SubTrigger>
            <CircleDot /> Issue and pull request
          </SubTrigger>
          <SubContent className="w-60">
            <IssueItems session={session} />
          </SubContent>
        </Sub>
      )}
      <Separator />
      {session.worktreeRemoved && (
        <Item onSelect={() => openWorkspaceRestore(session.id)}>
          <FolderInput /> Restore workspace…
        </Item>
      )}
      {session.worktreeName && !session.worktreeRemoved && (
        <Item className="items-start" onSelect={() => openSettle(session)}>
          <Folder className="mt-0.5" /> <MenuItemText label="Remove workspace…" hint="The conversations are kept" />
        </Item>
      )}
      <Item data-row-key="a" aria-keyshortcuts="A" onSelect={() => void (session.archived ? archiveSession(session.id, false) : archiveWithUndo(session.id)).catch(reportError(`Couldn't ${session.archived ? "unarchive" : "archive"} “${title}”`))}>
        <Archive /> {session.archived ? "Unarchive" : "Archive"}<MenuKbd keys={archiveKeys} />
      </Item>
      <Item destructive onSelect={() => void confirmDeleteSession(session)}>
        <Trash2 /> Delete session…
      </Item>
    </>
  );
}

/** Activate a row action only in this menu, never while typing in a submenu. */
export function rowMenuKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !/^[a-z]$/i.test(event.key)) return;
  const target = event.target as HTMLElement;
  if (target.closest("input,textarea,[contenteditable=true]") || target.closest('[role="menu"]') !== event.currentTarget) return;
  const item = event.currentTarget.querySelector<HTMLElement>(`[data-row-key="${event.key.toLowerCase()}"]`);
  if (!item || item.hasAttribute("data-disabled")) return;
  event.preventDefault();
  event.stopPropagation();
  item.click();
}

export function RowContextMenu(props: ConversationMenuProps) {
  return <ContextMenuContent className="w-56" onKeyDown={rowMenuKeys} onCloseAutoFocus={keepFocusForNameField}><ConversationMenuItems {...props} contextMenu /></ContextMenuContent>;
}

/**
 * A session's row (02.04): its status mark, its title in the UI font, then its PR, line counts or age. A row
 * standing for a branch is still named by its session's title; the branch is in its tooltip and menu.
 */
export function ConversationRow({
  session,
  sortId = session.id,
  peers = [session],
  selected,
  branch,
  named = "title",
  locationLabel,
  inPinned = false,
  merged = false,
  onNewSession = null,
  label,
  onRenameBranch = null,
  linkTo,
  inArchive = false,
  worker = false,
}: {
  session: SessionEntry;
  sortId?: string;
  /** A branch row's sessions (as tabs, the row stands for all of them): the row shows the most pressing state among them. */
  peers?: SessionEntry[];
  selected: boolean;
  /** Whether to include branch context in the row’s accessible name. */
  named?: "title" | "branch";
  /** Where a row in a section or the Pinned group lives (its project and branch), for its tooltip. */
  locationLabel?: string;
  /** Drawn in the Pinned group, which says it is pinned. */
  inPinned?: boolean;
  /** The branch's commits are in the default branch: said in a branch row's accessible name. */
  merged?: boolean;
  /** Start another session on the row's branch, where it is checked out (or a workspace from it). */
  onNewSession?: NewSessionAction | null;
  /** The branch label used in the row’s tooltip and accessible name. */
  label?: string;
  /** Open the separate Rename branch action; title renaming always targets the session. */
  onRenameBranch?: (() => void) | null;
  /** The branch it works on, named at the row's end; without one the row shows when it was last active. */
  branch: string | null;
  /** For a chat linked to nothing: the projects it may be linked to. */
  linkTo: ConversationLinkActions | null;
  /** Drawn under an Archived fold, which says it already. */
  inArchive?: boolean;
  /** Drawn under its lead (PRO-281): named by its piece, marked by its piece's state, with its model's tier. */
  worker?: boolean;
}) {
  const sort = useSidebarSortable(sortId);
  const { selectedSessionId } = useSessionStore();
  // A lead (PRO-281): its workers nest under it and fold with it; folded, their marks come up to its row. A lead
  // its coordinator started is one of its coordinator's rows and a lead too, with its own workers (PRO-364).
  const { workersOf } = useContext(RunFamiliesContext);
  const family = useLeadFamily(session, inArchive ? NO_PEERS : peers);
  const summary = useLeadSummary(family);
  // Only a run's lead has the run's glyph and summary; a session that only started the ones under it has a quieter mark (PRO-337).
  const runLead = leadsRun(family);
  const [leadOpen, toggleLead] = useFold(`lead:${session.id}`, true);
  const leadExpanded = !!family && (leadOpen || peers.some((peer) => familyHolds(workersOf, peer.id, selectedSessionId)));
  // Its rows are its workers and, before their workers start, its queued pieces (18.03): either folds with it.
  const folded = !!family && family.rows.length > 0 && !leadExpanded;
  const { piece, found } = useWorkerPiece(session);
  // An earlier try at a piece is drawn quieter than the piece's current one (PRO-364).
  const earlierTry = worker && !!found && !found.current;
  // A lead goes by its title, as a run's rows are read (18.07): its branch is in its tooltip, its run's glyph leads it.
  if (family) named = "title";
  const statusDescriptionId = useId();
  // A row under its lead goes by its piece, else its session's own title: never its tab's, the brief's first line (PRO-364).
  const title = worker ? workerTitle(session, found) : conversationTitle(session);
  const draft = useSessionDraft(peers);
  const unread = peers.some(isUnread) || (folded && !!summary?.unread);
  // The sessions the row stands for, picked as one for the bulk bar (#718).
  const ids = peers.map((peer) => peer.id);
  const pickedNow = usePickedSessions();
  const picking = pickedNow.length > 0;
  const picked = isPicked(ids, pickedNow);
  const removed = session.worktreeRemoved;
  const location = removed ? `${session.removedWorkspace?.path ?? session.cwd} · workspace removed · resumes in ${session.cwd}` : null;
  // What a pipeline's helper tab is doing while one works (PRO-331): on hover, as rows are one line (PRO-384).
  const helper = helperActivity(useIssuePipelines(), session.id);
  // One status for all the sessions the row stands for: the mark leads the row, its label is the mark's name (02.04).
  const rowStatus = useSessionRowStatus(peers);
  // A row is its name and its age: which agent runs it is in the chat, and where it works is in its tooltip.
  // A quick chat under Chats says where it runs: its scratch folder, or the folder it was pointed at (#1464).
  const branchName = locationLabel ?? label ?? branch ?? (isQuickChat(session) ? quickChatPlace(session) : null);
  // The visible title belongs to the session, even when this row represents a branch.
  const rename = () => openRenameSession(session.id);
  return (
    <li ref={sort.ref} style={sort.style} className={family ? "[--own-indent:var(--indent,0px)]" : undefined} data-lead={family ? session.id : undefined} data-worker={worker ? session.id : undefined}
      data-try={worker && found ? found.number : undefined} data-earlier-try={earlierTry ? "" : undefined}>
      <AsyncDropdownMenu>
        <AsyncContextMenu>
        <ContextMenuTrigger asChild>
        <div
          className={cn(
            actionRow,
            // Inset and rounded on a 30px pitch (02.04); its content is indented under its project or section.
            "relative flex items-center gap-2 rounded-md pl-[calc(1rem+var(--indent,0px))] pr-2.5",
            worker ? "min-h-7 py-0.5" : "min-h-[30px] py-[5px]",
            selected ? "bg-selected text-foreground" : "text-foreground/90 hover:bg-selected/50",
            picked && "bg-info/12 ring-1 ring-inset ring-info/45",
          )}
          // A folded lead's hover card says more than a title would.
          title={folded ? undefined : [location ?? (branchName ? `${branchName} · ${title}` : title), helper].filter(Boolean).join("\n")}
          data-folded-lead={folded ? "" : undefined}
          {...{ [ROW_ATTRIBUTE]: ids.join(" ") }}
        >
          {sort.handle}
          {/* A worker hangs from its lead's glyph by a line. */}
          {worker && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-[calc(var(--lead-indent,0px)+1rem+7px)] border-l border-hairline" />}
          {/* A lead folds its workers by the chevron in front of its glyph; the row itself opens the lead. */}
          {family && family.rows.length > 0 && (
            <button
              type="button"
              onClick={toggleLead}
              aria-expanded={leadExpanded}
              aria-label={leadExpanded ? `Fold the workers of ${title}` : `Unfold the workers of ${title}`}
              data-testid="lead-fold"
              className="absolute inset-y-0 left-[calc(var(--indent,0px)+1px)] flex w-3.5 items-center justify-center rounded-sm text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronDown aria-hidden className={cn("size-3 transition-transform", !leadExpanded && "-rotate-90")} />
            </button>
          )}
          {withLeadHover(
          <button
            type="button"
            onClick={(event) => {
              if (pickOnClick(event, ids)) return;
              selectSession(session.id);
              // A lead with a run opens on its run (18.07).
              if (runLead) showRunView(session.id, true);
            }}
            onDoubleClick={picking ? undefined : rename}
            aria-current={selected ? "true" : undefined}
            aria-pressed={picking ? picked : undefined}
            aria-describedby={statusDescriptionId}
            // Named by its title, without the PR, counts or age after it; a branch's row reads out its branch first,
            // as it is no longer drawn (PRO-384).
            aria-label={named === "branch" ? `${branchName ?? "No branch"}${removed ? " (workspace removed)" : merged ? " (merged)" : ""}, ${title}` : `${title}${removed ? " (workspace removed)" : session.archived && !inArchive ? " (archived)" : ""}`}
            className="flex min-w-0 flex-1 flex-col items-start rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              {/* The row leads with its session status mark; the reader's own status groups rows and is read out here. */}
              {runLead ? <LeadGlyph /> : worker ? <WorkerMark piece={earlierTry ? null : piece} status={rowStatus} /> : <StatusMarkIcon status={rowStatus} decorative />}
              <span id={statusDescriptionId} hidden>{statusText(rowStatus)}. Status: {manualStatusLabel(session.manualStatus)}{runLead && summary?.needs.length ? `. Waiting on you: ${summary.needs.map((need) => need.text).join("; ")}` : ""}</span>
              {session.pinned && !inPinned && <Pin aria-label="Pinned" className="size-3 shrink-0 text-faint" />}
              <span data-row-title className={cn("min-w-0 flex-1 truncate", worker ? "text-[12.5px]" : "text-[13px]", earlierTry && "text-muted-foreground")}>{title}</span>
              {worker && <TryMark found={found} />}
              {family && !runLead && <StarterMark />}
              {removed && <span className="shrink-0 text-[12px] text-faint">removed</span>}
              {session.archived && !inArchive && <span className="shrink-0 text-[12px] text-faint">archived</span>}
              {unread && <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-info" />}
              {runLead && summary ? <LeadTrailing family={family} folded={folded} summary={summary} fallback={<SessionRowExtras sessions={peers} selected={selected} status={rowStatus} at={conversationTime(session)} />} />
                : worker ? <WorkerTier piece={piece} found={found} session={session} />
                : <SessionRowExtras sessions={peers} selected={selected} status={rowStatus} at={conversationTime(session)} />}
            </span>
            <DraftPreview text={draft} />
          </button>)}
          <RowActions>
            <ArchiveRowButton session={session} title={title} />
            {session.archived && <UnarchiveButton session={session} title={title} />}
            {onNewSession && <NewSessionButton action={onNewSession} />}
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`Menu for ${title}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </RowActions>
        </div>
        </ContextMenuTrigger>
        <RowContextMenu session={session} branch={branch ?? session.branch ?? null} rename={rename} renameBranch={onRenameBranch} ids={ids} linkTo={linkTo} />
        </AsyncContextMenu>
        <DropdownMenuContent align="end" className="w-56" onKeyDown={rowMenuKeys} onCloseAutoFocus={keepFocusForNameField}>
          <ConversationMenuItems session={session} branch={branch ?? session.branch ?? null} rename={rename} renameBranch={onRenameBranch} ids={ids} linkTo={linkTo} />
        </DropdownMenuContent>
      </AsyncDropdownMenu>
      {family && leadExpanded && family.rows.length > 0 && (
        <ul aria-label={`Workers of ${title}`} data-testid="lead-workers" className="flex flex-col [--lead-indent:var(--own-indent,0px)] [--indent:calc(var(--own-indent,0px)+16px)]">
          {family.rows.map((row) => row.kind === "worker"
            ? <ConversationRow key={row.session.id} session={row.session} selected={row.session.id === selectedSessionId} branch={null} linkTo={null} worker />
            : <QueuedPieceRow key={`queued:${row.piece.id}`} piece={row.piece} run={family.run!} />)}
        </ul>
      )}
    </li>
  );

  function withLeadHover(button: ReactElement) {
    return folded && runLead && summary ? <LeadHoverCard family={family} summary={summary} title={title}>{button}</LeadHoverCard> : button;
  }
}
const NO_PEERS: SessionEntry[] = [];
