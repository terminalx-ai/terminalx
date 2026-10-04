import { useEffect, useMemo, useRef, useState } from "react";
import {
  Globe,
  Archive,
  CalendarClock,
  Ellipsis,
  FolderOpen,
  GitBranch,
  GitFork,
  Pin,
  Plus,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AgentMark } from "@/components/AgentMark";
import { WorkspaceNameEditor } from "@/components/session/WorkspaceNameEditor";
import { RowActions } from "@/components/layout/RowActions";
import {
  AgentTabRow,
  BrowserTabRow,
  DiffStats,
  GroupTitle,
  ItemTitle,
  RowChip,
  WorkspaceFacts,
  RowTime,
  ShellTabRow,
  StatusStripe,
  TreeGroup,
  TreeNode,
  TreeRow,
  TreeToggle,
} from "@/components/layout/SidebarRows";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import { workspaceName as sessionWorkspaceName } from "@/lib/dashboard";
import { openSettle, openWorkspaceDelete } from "@/lib/dialogs";
import { useMobileDrivenTabs } from "@/lib/mobileDriver";
import { getPrefs } from "@/lib/prefs";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { useWorkspaceSizes } from "@/lib/workspaceSizes";
import {
  addTab,
  archiveSession,
  forkSession,
  openAutomations,
  openSkills,
  pinSession,
  refreshWorkspaces,
  renameWorkspace,
  selectSession,
  setActiveTab,
  sortSessions,
  startSessionIn,
  useSessionStore,
} from "@/lib/sessions";
import { useTabViews } from "@/lib/tabViews";
import { activatePeer, browserPageLabel, closePeer, peerOrder, selectedPeer, tabNodeId, tabPanelId, type PeerTab } from "@/lib/sessionTabs";
import { openBrowserTab, pagesFor, useBrowser } from "@/lib/browser";
import { openTerminal, useTerminals } from "@/lib/terminal";
import { sessionStatus, type Project, type SessionEntry, type TabEntry, type Workspace } from "@/types/session";

interface WorkspaceGroup {
  workspace: Workspace | null;
  key: string;
  path: string;
  sessions: SessionEntry[];
  removed: boolean;
}

const canon = (path: string) => path.replace(/\/+$/, "");
const workspaceKey = (projectPath: string, path: string) => `${projectPath}\0${canon(path)}`;

/** Keep live checkouts and historical, missing checkouts in the same hierarchy. */
export function groupProjectWorkspaces(
  projectPath: string,
  workspaces: Workspace[],
  sessions: SessionEntry[],
  showArchived: boolean,
  selectedId?: string | null,
  /** The sidebar's filter (unread, needs you): sessions it does not show are left out, and so are checkouts left with none. */
  shows?: (sessionId: string) => boolean,
): WorkspaceGroup[] {
  const visible = sortSessions(
    sessions.filter((session) => session.projectPath === projectPath && (session.archived === showArchived || session.id === selectedId) && (!shows || shows(session.id))),
  );
  const byPath = new Map<string, SessionEntry[]>();
  const missing = new Map<string, SessionEntry[]>();
  const removed = new Map<string, SessionEntry[]>();

  for (const session of visible) {
    const path = canon(session.worktreeRemoved ? (session.removedWorkspace?.path ?? session.cwd) : session.cwd);
    const target = session.worktreeRemoved ? removed : byPath;
    target.set(path, [...(target.get(path) ?? []), session]);
  }

  const known = new Set(workspaces.map((workspace) => canon(workspace.path)));
  const groups: WorkspaceGroup[] = workspaces.map((workspace) => {
    const path = canon(workspace.path);
    return { workspace, path, key: workspaceKey(projectPath, path), sessions: byPath.get(path) ?? [], removed: false };
  });

  for (const [path, rows] of byPath) {
    if (!known.has(path)) missing.set(path, [...(missing.get(path) ?? []), ...rows]);
  }
  for (const [path, rows] of missing) {
    groups.push({ workspace: null, path, key: `${workspaceKey(projectPath, path)}\0missing`, sessions: sortSessions(rows), removed: false });
  }
  for (const [path, rows] of removed) {
    groups.push({ workspace: null, path, key: `${workspaceKey(projectPath, path)}\0removed`, sessions: sortSessions(rows), removed: true });
  }
  return shows ? groups.filter((group) => group.sessions.length > 0) : groups;
}

export function ProjectNavigation({ project, expanded }: { project: Project; expanded: boolean }) {
  const store = useSessionStore();
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const attemptedLoad = useRef(false);
  const workspaces = store.workspaces[project.path] ?? [];
  const selectedSession = store.sessions.find((session) => session.id === store.selectedSessionId) ?? null;
  const presetCwd = !selectedSession && store.view === "new" && store.newSessionPreset?.projectPath === project.path ? store.newSessionPreset.cwd : null;
  const activeCwd = selectedSession?.projectPath === project.path ? selectedSession.cwd : presetCwd;
  const tabViews = useTabViews();
  const terminals = useTerminals();
  const selectedPeerId = selectedSession ? terminals.selected[selectedSession.id]?.id : null;
  const mobileDriven = useMobileDrivenTabs();
  const harnessNames = useMemo(() => new Map(store.harnesses.map((harness) => [harness.id, harness.name])), [store.harnesses]);

  // Sizes arrive after the list: each is a walk of the whole checkout.
  const sizes = useWorkspaceSizes(project.path, useMemo(() => (project.kind === "folder" ? [] : workspaces.map((workspace) => workspace.path)), [project.kind, workspaces]), expanded);

  const filter = useSidebarFilter();
  const groups = useMemo(
    () => groupProjectWorkspaces(project.path, workspaces, store.sessions, store.showArchived, store.selectedSessionId, filter.active ? filter.shows : undefined),
    [project.path, store.sessions, store.showArchived, store.selectedSessionId, workspaces, filter],
  );
  const activeWorkspaceKey = groups.find((group) => selectedSession
    ? group.sessions.some((session) => session.id === selectedSession.id)
    : !group.removed && activeCwd && canon(group.path) === canon(activeCwd))?.key ?? null;

  useEffect(() => {
    if (expanded && !attemptedLoad.current && !store.workspaces[project.path] && !store.workspacesLoading[project.path]) {
      attemptedLoad.current = true;
      void refreshWorkspaces(project.path);
    }
  }, [expanded, project.path, store.workspaces, store.workspacesLoading]);

  // A destination opened from notifications, search, or another live update
  // reveals its full ancestry without resetting unrelated expansion choices.
  useEffect(() => {
    if (!activeWorkspaceKey) return;
    setExpandedWorkspaces((current) => addToSet(current, activeWorkspaceKey));
    if (selectedSession?.projectPath === project.path) {
      setExpandedSessions((current) => addToSet(current, selectedSession.id));
    }
  }, [activeWorkspaceKey, project.path, selectedSession?.activeTab, selectedSession?.id, selectedSession?.projectPath, selectedPeerId, store.navigationVersion]);

  return (
    <TreeGroup expanded={expanded} className="pb-1 pl-2">
      {groups.length === 0 && !filter.active ? (
        <div className="px-5 py-2 text-[11px] text-faint">
          {store.workspacesLoading[project.path] ? "Reading workspaces…" : "No workspaces found."}
        </div>
      ) : null}
      {groups.map((group) => (
        <WorkspaceNode
          key={group.key}
          project={project}
          group={group}
          // A filter shows what it found: its checkouts are open.
          expanded={filter.active || expandedWorkspaces.has(group.key)}
          active={activeWorkspaceKey === group.key}
          onToggle={() => setExpandedWorkspaces((current) => toggleInSet(current, group.key))}
          selectedSessionId={store.selectedSessionId}
          expandedSessions={expandedSessions}
          onToggleSession={(id) => setExpandedSessions((current) => toggleInSet(current, id))}
          tabViews={tabViews.views}
          mobileDriven={mobileDriven}
          harnessNames={harnessNames}
          bytes={group.workspace ? sizes[group.workspace.path] : undefined}
        />
      ))}
    </TreeGroup>
  );
}

function WorkspaceNode({
  project,
  group,
  expanded,
  active,
  onToggle,
  selectedSessionId,
  expandedSessions,
  onToggleSession,
  tabViews,
  mobileDriven,
  harnessNames,
  bytes,
}: {
  /** What the workspace takes on disk, once measured. */
  bytes?: number;
  project: Project;
  group: WorkspaceGroup;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
  selectedSessionId: string | null;
  expandedSessions: Set<string>;
  onToggleSession: (id: string) => void;
  tabViews: Record<string, "chat" | "terminal">;
  mobileDriven: Set<string>;
  harnessNames: Map<string, string>;
}) {
  const [renameError, setRenameError] = useState<string | null>(null);
  const workspace = group.workspace;
  const removedSession = group.sessions.find((session) => session.removedWorkspace) ?? group.sessions[0];
  const name = group.removed && removedSession ? sessionWorkspaceName(removedSession) : (workspace?.name ?? group.path.split("/").pop() ?? group.path);
  const displayName = group.removed ? name : workspace?.managed ? name : (workspace?.branch ?? name);
  const kind = group.removed ? "removed" : !workspace ? "missing" : project.kind === "folder" ? "folder" : workspace.isMain ? "main" : workspace.managed ? "worktree" : "external";
  const openWorkspace = () => {
    if (workspace) startSessionIn(project.path, workspace.path);
    else if (group.sessions[0]) selectSession(group.sessions[0].id);
  };

  return (
    <TreeNode label={displayName} expanded={expanded}>
      <TreeRow level="group" selected={active} title={group.path}>
        <TreeToggle expanded={expanded} label={displayName} onToggle={onToggle} className="ml-0.5" />
        {project.kind === "folder" ? <FolderOpen className="size-3 shrink-0" /> : <GitBranch className="size-3 shrink-0" />}
        {workspace ? (
          <WorkspaceNameEditor
            value={displayName}
            editable={workspace.managed && !workspace.isMain}
            onActivate={openWorkspace}
            onCommit={async (requested) => {
              const renamed = await renameWorkspace(project.path, workspace.path, requested);
              return renamed.name;
            }}
            onError={setRenameError}
            className="flex-1 text-left text-foreground/90"
          />
        ) : (
          <GroupTitle label={displayName} onActivate={openWorkspace} />
        )}
        <RowChip title={kind === "external" ? "A worktree not created by TerminalX" : undefined}>{kind}</RowChip>
        {workspace && project.kind !== "folder" ? <WorkspaceFacts state={workspace.state} bytes={bytes} /> : null}
        {workspace ? <DiffStats additions={workspace.additions} deletions={workspace.deletions} unpushed={workspace.unpushed} /> : null}
        {workspace ? (
          <RowActions>
            <WithTooltip label="New session here">
              <Button variant="ghost" size="icon-xs" aria-label={`New session in ${displayName}`} onClick={() => startSessionIn(project.path, workspace.path)}>
                <Plus />
              </Button>
            </WithTooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Workspace menu for ${displayName}`}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={openWorkspace}>
                  <FolderOpen /> Open
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void revealItemInDir(workspace.path)}>
                  <FolderOpen /> Reveal in Finder
                </DropdownMenuItem>
                {!workspace.isMain ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => openWorkspaceDelete(project.path, workspace.path, name)}>
                      <Trash2 /> Delete workspace…
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </RowActions>
        ) : null}
      </TreeRow>
      {renameError ? (
        <div role="alert" className="mx-6 mb-1 text-[11px] leading-tight text-destructive">
          {renameError}
        </div>
      ) : null}
      <TreeGroup expanded={expanded} className="pl-2">
        {group.sessions.map((session) => (
          <SessionNode
            key={session.id}
            session={session}
            selected={selectedSessionId === session.id}
            expanded={expandedSessions.has(session.id)}
            onToggle={() => onToggleSession(session.id)}
            tabViews={tabViews}
            mobileDriven={mobileDriven}
            harnessNames={harnessNames}
          />
        ))}
        {group.sessions.length === 0 ? <div className="px-5 py-1 text-[11px] text-faint">No sessions yet.</div> : null}
      </TreeGroup>
    </TreeNode>
  );
}

function SessionNode({
  session,
  selected,
  expanded,
  onToggle,
  tabViews,
  mobileDriven,
  harnessNames,
}: {
  session: SessionEntry;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  tabViews: Record<string, "chat" | "terminal">;
  mobileDriven: Set<string>;
  harnessNames: Map<string, string>;
}) {
  const terminals = useTerminals();
  const browser = useBrowser();
  const peers = peerOrder(session, terminals.panes, pagesFor(browser.pages, session.cwd));
  const activePeer = selectedPeer(session, peers, terminals.selected[session.id]);
  const branchBadge = session.issue && !session.worktreeName && !session.worktreeRemoved ? session.branch : null;
  const isActive = (peer: PeerTab) => selected && activePeer?.kind === peer.kind && peer.id === activePeer.id;
  const close = (peer: PeerTab) => () => void closePeer(session.id, peer, peers, activePeer);
  const open = (peer: PeerTab) => () => { selectSession(session.id); activatePeer(session.id, peer); };

  return (
    <DropdownMenu>
      <TreeNode label={session.title} expanded={expanded}>
        <TreeRow level="item" selected={selected}>
          <StatusStripe status={sessionStatus(session)} size="row" />
          <TreeToggle expanded={expanded} label={session.title} onToggle={onToggle} />
          <ItemTitle title={session.title} pinned={session.pinned} archived={session.archived} badge={branchBadge} onActivate={() => selectSession(session.id)} />
          <RowTime at={session.modified} />
          <RowActions>
            <NewTabButton session={session} />
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`Session menu for ${session.title}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </RowActions>
        </TreeRow>
        {session.automation ? (
          <button
            type="button"
            onClick={openAutomations}
            className="ml-7 flex max-w-[calc(100%-1.75rem)] items-center gap-1 truncate text-[10px] text-faint hover:text-muted-foreground"
          >
            <CalendarClock className="size-3 shrink-0" />
            <span className="truncate">{session.automation.name} #{session.automation.runNumber}</span>
          </button>
        ) : null}
        <TreeGroup expanded={expanded} className="pl-5">
          {peers.map((peer) => peer.kind === "agent" ? (
            <TabNode
              key={peer.id}
              session={session}
              tab={peer.tab}
              active={isActive(peer)}
              label={peer.tab.title?.trim() || harnessNames.get(peer.tab.harness) || peer.tab.harness}
              terminal={tabViews[peer.id] === "terminal"}
              mobileDriven={mobileDriven.has(peer.id)}
              onClose={close(peer)}
            />
          ) : peer.kind === "browser" ? (
            <BrowserTabRow
              key={peer.id}
              nodeId={tabNodeId(peer)}
              panelId={tabPanelId(peer)}
              label={browserPageLabel(peer.page)}
              url={peer.page.url}
              agentTarget={peer.page.active}
              selected={isActive(peer)}
              onOpen={open(peer)}
              onClose={close(peer)}
            />
          ) : (
            <ShellTabRow
              key={peer.id}
              nodeId={tabNodeId(peer)}
              panelId={tabPanelId(peer)}
              title={peer.pane.title}
              exited={peer.pane.exited}
              selected={isActive(peer)}
              onOpen={open(peer)}
              onClose={close(peer)}
            />
          ))}
          {peers.length === 0 ? <div className="px-3 py-1 text-[11px] text-faint">No tabs.</div> : null}
        </TreeGroup>
      </TreeNode>
      <SessionMenu session={session} />
    </DropdownMenu>
  );
}

function TabNode({
  session,
  tab,
  active,
  label,
  terminal,
  mobileDriven,
  onClose,
}: {
  session: SessionEntry;
  tab: TabEntry;
  active: boolean;
  label: string;
  terminal: boolean;
  mobileDriven: boolean;
  onClose: () => void;
}) {
  const open = () => {
    selectSession(session.id);
    void setActiveTab(session.id, tab.id);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <AgentTabRow
          nodeId={tabNodeId({ kind: "agent", id: tab.id })}
          panelId={tabPanelId({ kind: "agent", id: tab.id })}
          harness={tab.harness}
          label={label}
          status={tab.status}
          mobileDriven={mobileDriven}
          terminalView={terminal}
          selected={active}
          onOpen={open}
          onClose={onClose}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openSkills({ agent: tab.harness, projectPath: session.cwd })}>
          <Sparkles /> Skills for this tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={onClose}>
          <X /> Close tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function NewTabButton({ session }: { session: SessionEntry }) {
  const store = useSessionStore();
  const add = async (harness: string) => {
    const prefs = getPrefs();
    await addTab(session.id, harness, prefs.lastModel[harness] ?? "", prefs.lastEffort[harness] ?? null, prefs.lastMode);
    selectSession(session.id);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`New tab in ${session.title}`}>
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>New tab with</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => { selectSession(session.id); void openTerminal(session.id, session.cwd); }}><Terminal /> Shell terminal</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { selectSession(session.id); void openBrowserTab(session.id, session.cwd).catch((error) => console.error("browser open failed", error)); }}><Globe /> Browser tab</DropdownMenuItem>
        {store.harnesses.map((harness) => (
          <DropdownMenuItem key={harness.id} disabled={!harness.available} onSelect={() => void add(harness.id)}>
            <AgentMark id={harness.id} decorative />
            <span>{harness.name}</span>
            {!harness.available ? <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionMenu({ session }: { session: SessionEntry }) {
  return (
    <DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={() => pinSession(session.id, !session.pinned)}>
        <Pin /> {session.pinned ? "Unpin" : "Pin"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => archiveSession(session.id, !session.archived)}>
        <Archive /> {session.archived ? "Unarchive" : "Archive"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void forkSession(session.id, session.activeTab ?? session.tabs[0]?.id ?? "")} disabled={!session.tabs.length}>
        <GitFork /> Fork session
      </DropdownMenuItem>
      {session.worktreeName && !session.worktreeRemoved ? (
        <DropdownMenuItem onSelect={() => openSettle(session)}>
          <X /> Settle worktree…
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={() => void confirmDeleteSession(session)}>
        <Trash2 /> Delete session…
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

function addToSet(current: Set<string>, value: string) {
  if (current.has(value)) return current;
  const next = new Set(current);
  next.add(value);
  return next;
}

function toggleInSet(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
