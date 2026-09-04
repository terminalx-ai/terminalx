import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUp,
  CalendarClock,
  ChevronDown,
  FolderOpen,
  GitBranch,
  GitFork,
  Lock,
  Pin,
  Plus,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AgentMark } from "@/components/AgentMark";
import { WorkspaceNameEditor } from "@/components/session/WorkspaceNameEditor";
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
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { workspaceName as sessionWorkspaceName } from "@/lib/dashboard";
import { openSettle, openWorkspaceDelete } from "@/lib/dialogs";
import { useMobileDrivenTabs } from "@/lib/mobileDriver";
import { getPrefs } from "@/lib/prefs";
import {
  addTab,
  archiveSession,
  deleteSession,
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
import { relativeTime } from "@/lib/time";
import { activatePeer, closePeer, peerOrder, selectedPeer, tabNodeId, tabPanelId, type PeerTab } from "@/lib/sessionTabs";
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
export function groupProjectWorkspaces(projectPath: string, workspaces: Workspace[], sessions: SessionEntry[], showArchived: boolean, selectedId?: string | null): WorkspaceGroup[] {
  const visible = sortSessions(sessions.filter((session) => session.projectPath === projectPath && (session.archived === showArchived || session.id === selectedId)));
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
  return groups;
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

  const groups = useMemo(
    () => groupProjectWorkspaces(project.path, workspaces, store.sessions, store.showArchived, store.selectedSessionId),
    [project.path, store.sessions, store.showArchived, store.selectedSessionId, workspaces],
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
    <div hidden={!expanded} className={cn("pb-1 pl-2", !expanded && "hidden")} role="group">
      {groups.length === 0 ? (
        <div className="px-5 py-2 text-[11px] text-faint">
          {store.workspacesLoading[project.path] ? "Reading workspaces…" : "No workspaces found."}
        </div>
      ) : null}
      {groups.map((group) => (
        <WorkspaceNode
          key={group.key}
          project={project}
          group={group}
          expanded={expandedWorkspaces.has(group.key)}
          active={activeWorkspaceKey === group.key}
          onToggle={() => setExpandedWorkspaces((current) => toggleInSet(current, group.key))}
          selectedSessionId={store.selectedSessionId}
          expandedSessions={expandedSessions}
          onToggleSession={(id) => setExpandedSessions((current) => toggleInSet(current, id))}
          tabViews={tabViews.views}
          mobileDriven={mobileDriven}
          harnessNames={harnessNames}
        />
      ))}
    </div>
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
}: {
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
  const kind = group.removed ? "removed" : !workspace ? "missing" : workspace.isMain ? "main" : workspace.managed ? "worktree" : "external";
  const openWorkspace = () => {
    if (workspace) startSessionIn(project.path, workspace.path);
    else if (group.sessions[0]) selectSession(group.sessions[0].id);
  };

  return (
    <div role="treeitem" aria-label={displayName} aria-expanded={expanded} className="min-w-0">
      <div
        data-tree-row
        className={cn(
          "group/ws relative flex min-h-7 items-center gap-1 rounded-md pr-1 text-[11px] text-muted-foreground",
          active ? "bg-selected/60" : "hover:bg-selected/40",
        )}
        title={group.path}
      >
        <TreeToggle expanded={expanded} label={displayName} onToggle={onToggle} className="ml-0.5" />
        <GitBranch className="size-3 shrink-0" />
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
          <button type="button" onClick={openWorkspace} className="min-w-0 flex-1 truncate rounded-sm text-left font-mono text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">{displayName}</button>
        )}
        <span className="shrink-0 rounded-sm bg-veil-raised px-1 text-[9px] text-faint">{kind}</span>
        {workspace ? <WorkspaceStats workspace={workspace} /> : null}
        {workspace ? (
          <span className="absolute right-1 flex items-center opacity-0 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 has-[[data-state=open]]:opacity-100">
            <WithTooltip label="New session here">
              <Button variant="ghost" size="icon-xs" aria-label={`New session in ${displayName}`} onClick={() => startSessionIn(project.path, workspace.path)}>
                <Plus />
              </Button>
            </WithTooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Workspace menu for ${displayName}`}>
                  <span className="text-[13px] leading-none">…</span>
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
          </span>
        ) : null}
      </div>
      {renameError ? (
        <div role="alert" className="mx-6 mb-1 text-[11px] leading-tight text-destructive">
          {renameError}
        </div>
      ) : null}
      <div hidden={!expanded} className={cn("pl-2", !expanded && "hidden")} role="group">
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
      </div>
    </div>
  );
}

function WorkspaceStats({ workspace }: { workspace: Workspace }) {
  if (!workspace.additions && !workspace.deletions && !workspace.unpushed) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 group-has-[[data-state=open]]/ws:opacity-0">
      {workspace.additions > 0 ? <span className="text-add">+{workspace.additions}</span> : null}
      {workspace.deletions > 0 ? <span className="text-destructive">−{workspace.deletions}</span> : null}
      {workspace.unpushed > 0 ? (
        <span className="flex items-center text-warning" title={`${workspace.unpushed} unpushed commit${workspace.unpushed === 1 ? "" : "s"}`}>
          <ArrowUp className="size-3" />
          {workspace.unpushed}
        </span>
      ) : null}
    </span>
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
  const status = sessionStatus(session);
  const terminals = useTerminals();
  const peers = peerOrder(session, terminals.panes);
  const activePeer = selectedPeer(session, peers, terminals.selected[session.id]);
  const branchBadge = session.issue && !session.worktreeName && !session.worktreeRemoved ? session.branch : null;

  return (
    <DropdownMenu>
      <div role="treeitem" aria-label={session.title} aria-expanded={expanded} className="min-w-0">
        <div
          data-tree-row
          className={cn(
            "group/session relative flex min-h-7 cursor-default items-center gap-1 rounded-md pr-1 outline-none",
            selected ? "bg-selected" : "hover:bg-selected/50",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full",
              status === "waiting" && "bg-warning",
              status === "completed" && "bg-add",
              status === "in_progress" && "bg-info animate-pulse-soft",
            )}
          />
          <TreeToggle expanded={expanded} label={session.title} onToggle={onToggle} />
          <button
            type="button"
            onClick={() => selectSession(session.id)}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            title={session.title}
          >
            {session.pinned ? <Pin className="size-3 shrink-0 text-faint" /> : null}
            {session.archived ? <Archive className="size-3 shrink-0 text-faint" aria-label="Archived session" /> : null}
            <span className="min-w-0 flex-1 truncate text-[12px]">{session.title}</span>
            {branchBadge ? <span className="max-w-20 shrink-0 truncate rounded-sm bg-veil-raised px-1 font-mono text-[9px] text-faint">{branchBadge}</span> : null}
          </button>
          <span className="shrink-0 text-[10px] tabular-nums text-faint group-hover/session:opacity-0 group-focus-within/session:opacity-0 group-has-[[data-state=open]]/session:opacity-0">
            {relativeTime(session.modified)}
          </span>
          <span className="absolute right-1 flex items-center opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100 has-[[data-state=open]]:opacity-100">
            <NewTabButton session={session} />
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`Session menu for ${session.title}`}>
                <span className="text-[13px] leading-none">…</span>
              </Button>
            </DropdownMenuTrigger>
          </span>
        </div>
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
        <div hidden={!expanded} className={cn("pl-5", !expanded && "hidden")} role="group">
          {peers.map((peer) => peer.kind === "agent" ? (
            <TabNode
              key={peer.id}
              session={session}
              tab={peer.tab}
              active={selected && activePeer?.kind === "agent" && peer.id === activePeer.id}
              label={peer.tab.title?.trim() || harnessNames.get(peer.tab.harness) || peer.tab.harness}
              terminal={tabViews[peer.id] === "terminal"}
              mobileDriven={mobileDriven.has(peer.id)}
              onClose={() => void closePeer(session.id, peer, peers, activePeer)}
            />
          ) : <ShellNode key={peer.id} session={session} peer={peer} active={selected && activePeer?.kind === "terminal" && peer.id === activePeer.id} onClose={() => void closePeer(session.id, peer, peers, activePeer)} />)}
          {peers.length === 0 ? <div className="px-3 py-1 text-[11px] text-faint">No tabs.</div> : null}
        </div>
      </div>
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
        <div
          role="treeitem"
          id={tabNodeId({ kind: "agent", id: tab.id })}
          aria-controls={tabPanelId({ kind: "agent", id: tab.id })}
          aria-label={label}
          aria-selected={active}
          tabIndex={0}
          onClick={open}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          }}
          onAuxClick={(event) => event.button === 1 && onClose()}
          className={cn(
            "group/tab relative flex h-6 min-w-0 cursor-default items-center gap-1.5 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            active ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:bg-selected/40 hover:text-foreground",
          )}
          title={label}
        >
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full",
              tab.status === "waiting" && "bg-warning",
              tab.status === "completed" && "bg-add",
              tab.status === "in_progress" && "bg-info animate-pulse-soft",
            )}
          />
          <AgentMark id={tab.harness} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[11px]">{label}</span>
          {mobileDriven ? <Lock className="size-3 shrink-0 text-warning" aria-label="Mobile is driving this terminal" /> : null}
          {terminal ? <Terminal className="size-3 shrink-0 text-faint" aria-label="In terminal view" /> : null}
          {(
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
              className="rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
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

function ShellNode({ session, peer, active, onClose }: { session: SessionEntry; peer: Extract<PeerTab, { kind: "terminal" }>; active: boolean; onClose: () => void }) {
  const open = () => { selectSession(session.id); activatePeer(session.id, peer); };
  return <div role="treeitem" id={tabNodeId(peer)} aria-controls={tabPanelId(peer)} aria-label={`${peer.pane.title}${peer.pane.exited ? ", exited" : ""}`} aria-selected={active} tabIndex={0}
    title={peer.pane.title} onClick={open} onAuxClick={(event) => event.button === 1 && onClose()}
    onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } }}
    className={cn("group/tab relative flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40", active ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:bg-selected/40")}>
    <Terminal className="size-3.5 shrink-0" />
    <span className={cn("min-w-0 flex-1 truncate", peer.pane.exited && "text-faint line-through")}>{peer.pane.title}</span>
    <button type="button" aria-label={`Close ${peer.pane.title} terminal tab`} onClick={(event) => { event.stopPropagation(); onClose(); }} className="rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong group-hover/tab:opacity-100 focus-visible:opacity-100"><X className="size-3" /></button>
  </div>;
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
        {store.harnesses.map((harness) => (
          <DropdownMenuItem key={harness.id} disabled={!harness.available} onSelect={() => void add(harness.id)}>
            <AgentMark id={harness.id} />
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
        <DropdownMenuItem onSelect={() => openSettle(session.id)}>
          <X /> Settle worktree…
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={() => void confirmDelete(session)}>
        <Trash2 /> Delete session…
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

function TreeToggle({ expanded, label, onToggle, className }: { expanded: boolean; label: string; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      data-tree-toggle
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      onClick={onToggle}
      className={cn("shrink-0 rounded-sm p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40", className)}
    >
      <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform", !expanded && "-rotate-90")} />
    </button>
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

async function confirmDelete(session: SessionEntry) {
  let detail = "Its transcript and attachments are removed.";
  if (session.worktreeName && !session.worktreeRemoved) {
    try {
      const disposition = await api.worktreeDisposition(session.id);
      const parts = [];
      if (disposition.unpushed > 0) parts.push(`${disposition.unpushed} unpushed commit${disposition.unpushed === 1 ? "" : "s"}`);
      if (disposition.uncommitted > 0) parts.push(`${disposition.uncommitted} uncommitted file${disposition.uncommitted === 1 ? "" : "s"}`);
      detail = parts.length
        ? `Its worktree has ${parts.join(" and ")}; deleting loses them along with the transcript.`
        : "Its worktree, transcript and attachments are removed.";
    } catch {
      // The confirmation still protects the destructive action if status fails.
    }
  }
  const yes = await ask(`Delete "${session.title}"? ${detail}`, {
    title: "Delete session",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  }).catch(() => false);
  if (!yes) return;
  try {
    await deleteSession(session.id, true);
  } catch (error) {
    console.error(errorMessage(error));
  }
}
