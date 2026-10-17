import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppWindow, Archive, BookOpen, Check, ChevronDown, Cloud, Ellipsis, Folder, FolderGit2, FolderInput, FolderPlus, GitBranch, Pencil, Pin, PinOff, Plus, RefreshCw, Trash2, X } from "@/icons";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { StatusMark } from "@/components/ui/StatusMark";
import { RowActions, actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { archiveLine, deletionLine } from "@/components/cloud/CloudWorkspaceLifecycle";
import { archivingText, describeWorkspace } from "@/components/cloud/CloudWorkspaceView";
import { ShareBadge } from "@/components/cloud/CloudCollab";
import { WorkspaceActionItems, type LifecycleRequest } from "@/components/cloud/WorkspaceActions";
import { CloudDiagnosticsDialog, CloudDiagnosticsMenuItem, offersCloudDiagnostics } from "@/components/cloud/CloudDiagnosticsDialog";
import { errorMessage, type CloudWorkspaceListItem } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { refreshCloudWorkspaces } from "@/lib/cloudCatalog";
import { NEW_SESSION_ADMIN_REASON } from "@/lib/cloudCollab";
import { useCloudConnection } from "@/lib/cloudConnections";
import { cloudSessionMark, useCloudDashboard } from "@/lib/cloudDashboard";
import { archiving, checkpointText, deletion, lifecycleErrorMessage, operationFailureText } from "@/lib/cloudLifecycle";
import { deriveCloudActivity, type CloudActivity, type RowTone } from "@/lib/cloudRowState";
import {
  cloudAgentRan,
  cloudSessionStatus,
  deleteCloudSession,
  NEEDS_SECOND_CONFIRMATION,
  updateCloudSession,
  useCloudAgentRan,
  useCloudWorkspaceSessions,
  type CloudSessionRow,
} from "@/lib/cloudSessions";
import { createCloudSection, keepFocusForNameField, moveProjectToSection, sectionOfProject, useCloudSidebarSections } from "@/lib/cloudSidebarSections";
import { errorCode } from "@/lib/cloudTerminals";
import { mayStartCloudSessions } from "@/lib/multiOrg";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { getSessionStore, selectCloudSession, selectCloudWorkspace, selectSession, startCloudSessionIn, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import { parseCloudWorkspaceKey, type CloudProject, type CloudWorkspaceNode } from "@/types/target";
import type { TabStatus } from "@/types/session";
import { RowTime } from "../SidebarRows";
import { useFold } from "../useFold";

/**
 * A cloud project's rows in the chat-first sidebar, drawn as the local
 * projects are: the project, then its sessions along a guide line; a project
 * with several workspaces names each over its sessions. Every row keeps its
 * menu: the project's (new session, pin, its section, the workspace
 * lifecycle), a workspace's (its lifecycle) and a session's (rename, pin,
 * archive, delete). Looking costs nothing: rows read the catalog and this
 * desktop's caches; nothing connects or wakes a workspace until an action
 * that says so is chosen.
 */

type OnLifecycle = (request: LifecycleRequest) => void;

const DOT: Record<RowTone, string> = {
  ready: "bg-add",
  idle: "bg-add",
  done: "bg-add",
  working: "bg-info animate-pulse-soft",
  "needs-you": "bg-warning",
  stopped: "bg-faint",
  changing: "bg-info animate-pulse-soft",
  attention: "bg-destructive",
  archived: "bg-faint/60",
};

/** Workspace states a row names: the ones a reader would not assume (a ready workspace says nothing). */
const NAMED_TONES: ReadonlySet<RowTone> = new Set(["stopped", "changing", "attention", "needs-you"]);

/** The hover card of a workspace: where its sessions run. */
export function workspaceCard(item: CloudWorkspaceListItem, activity: CloudActivity): string {
  const { workspace } = item;
  const lines = [`Cloud workspace ${workspace.name}`, `Runs on ${workspace.provider}`, `State: ${activity.label}${activity.lastKnown ? " (last known)" : ""}`, describeWorkspace(item)];
  const branch = workspace.launch?.workBranch;
  if (branch) lines.push(`Branch: ${branch}`);
  // How far a delete is, or why it stopped.
  const deleting = deletionLine(item);
  if (deleting) lines.push(deleting);
  const repositories = (workspace.repositories ?? []).map((repository) => repository.fullName ?? repository.identity).filter(Boolean);
  if (repositories.length) lines.push(`Repositories: ${repositories.join(", ")}`);
  lines.push(`Access: ${workspace.accessMode === "organization" ? "organization" : "private"}`);
  return [...new Set(lines)].join("\n");
}

/** The other repositories a workspace checks out, and the sentence naming them; null when there are none or this person may not know. */
export function extraRepositories(item: CloudWorkspaceListItem): { label: string; card: string } | null {
  // Someone the workspace is not shared with learns nothing of what is in it.
  if (item.workspace.you?.role === "none") return null;
  const repositories = item.workspace.repositories ?? [];
  const extra = repositories.filter((repository, index) => (repositories.some((each) => each.primary) ? !repository.primary : index > 0));
  if (!extra.length) return null;
  const names = extra.map((repository) => repository.fullName ?? repository.identity ?? "a repository no longer selected");
  return { label: `+${extra.length} ${extra.length === 1 ? "repo" : "repos"}`, card: `${item.workspace.name} also checks out ${names.join(", ")}` };
}

/** A small label at a row's end. */
function Chip({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <span className={cn("shrink-0 rounded-sm bg-veil-raised px-1 text-[9px] text-faint", yieldsToRowActions)} {...rest}>
      {children}
    </span>
  );
}

/** The state a workspace shows: its lifecycle, then its connection, then the most urgent of its sessions. */
function useWorkspaceActivity(node: CloudWorkspaceNode, sessions: readonly CloudSessionRow[], fromCache: boolean): CloudActivity {
  const connection = useCloudConnection(node.key);
  return deriveCloudActivity(node.item, {
    connection: connection.refs > 0 || connection.state !== "idle" ? connection.state : null,
    tabs: sessions.flatMap((row) => row.tabs),
    fromCache,
  });
}

/** Runs a row's action, keeping what went wrong to say under the row. */
function useRowError(): [string | null, (work: () => Promise<void>) => Promise<void>] {
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(lifecycleErrorMessage(errorCode(e)));
    }
  };
  return [error, run];
}

function updateOrgList(key: "cloudProjects" | "cloudPinned" | "cloudBlankProjects", orgId: string, change: (list: string[]) => string[]) {
  const current = getPrefs()[key];
  setPrefs({ [key]: { ...current, [orgId]: change(current[orgId] ?? []) } });
}

/** `+`: the new-session form for the project, with the prompt focused so Return starts it. */
function startNewCloudSession(projectKey: string) {
  startCloudSessionIn(projectKey);
  setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea[data-new-session-prompt]")?.focus(), 0);
}

// ---- projects --------------------------------------------------------------

/** A cloud project, then its sessions along a guide line, like a local project's branches. */
export function CloudProjectGroup({ project, onLifecycle }: { project: CloudProject; onLifecycle: OnLifecycle }) {
  const store = useSessionStore();
  const { animations, cloudProjects } = usePrefs();
  const { status } = useAccount();
  const filter = useSidebarFilter();
  const menu = useRowMenu();
  const [error, run] = useRowError();
  const [diagnostics, setDiagnostics] = useState(false);
  const foldKey = `cloud-project:${project.key}`;
  const [expanded, toggle] = useFold(foldKey, true);
  // A filter shows what it found: the project is open while it is on.
  const open = expanded || filter.active;
  const drafting = store.cloudSessionPreset?.projectKey === project.key;
  const grouped = project.workspaces.length > 1;
  const only = project.workspaces.length === 1 ? project.workspaces[0] : null;
  const selectedWorkspace = store.selectedSessionId ? parseCloudWorkspaceKey(store.selectedSessionId) : null;
  const holdsSelection = !!selectedWorkspace && project.workspaces.some((node) => node.item.workspace.id === selectedWorkspace.workspaceId && node.item.workspace.orgId === selectedWorkspace.orgId);
  // A selection inside opens the project, as local navigation does.
  useEffect(() => {
    if (holdsSelection && !expanded) setPrefs({ sidebarSections: { ...getPrefs().sidebarSections, [foldKey]: "expanded" } });
  }, [holdsSelection, store.navigationVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Starting a session creates a workspace, resumes one, or adds a session to
  // a running one: the server keeps all three for owners and admins. Null
  // while this account's role is not known yet: nothing is offered until it is.
  const mayStart = mayStartCloudSessions(status, project.orgId);
  const startBlocked = !project.selected || mayStart !== true;
  const added = (cloudProjects[project.orgId] ?? []).includes(project.identity);
  const pendingBlank = project.blank && !project.workspaces.length;
  const removable = !project.workspaces.length && (added || pendingBlank);
  // One workspace has no row of its own: its state, extra repositories and access show on the project's row.
  const onlyAgentRan = useCloudAgentRan(only?.item ?? null);
  const onlyState = only ? deriveCloudActivity(only.item, { agentRan: onlyAgentRan }) : null;
  const extra = only ? extraRepositories(only.item) : null;

  return (
    <div role="group" aria-label={project.fullName} className="mb-1" data-testid="cloud-project-group" data-project={project.key}>
      <div
        className={cn(actionRow, "relative flex h-8 min-w-0 items-center gap-2 rounded-md px-2", drafting ? "bg-selected" : "hover:bg-selected/50")}
        title={[project.blank ? `${project.fullName} · no repository` : project.identity, extra?.card].filter(Boolean).join("\n")}
        onContextMenu={(event) => {
          event.preventDefault();
          menu.setOpen(true);
        }}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${project.fullName}` : `Expand ${project.fullName}`}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="relative size-4 shrink-0">
            <span className={cn("absolute inset-0 transition-opacity duration-150", open ? "group-hover/row:opacity-0 group-focus-within/row:opacity-0" : "opacity-0")} aria-hidden>
              {project.blank ? <Folder className="size-4 text-faint" /> : <FolderGit2 className="size-4 text-faint" />}
            </span>
            <ChevronDown
              className={cn(
                "absolute inset-0 size-4 text-muted-foreground transition-[opacity,transform] duration-200",
                open ? "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100" : "-rotate-90 opacity-100",
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{project.fullName}</span>
          {project.pinned && <Pin className="size-3 shrink-0 text-faint" />}
          {extra && <Chip data-testid="cloud-extra-repositories">{extra.label}</Chip>}
          {project.blank && <Chip>no repo</Chip>}
          {!project.selected && <Chip>not accessible</Chip>}
          {onlyState && NAMED_TONES.has(onlyState.tone) && (
            <span className={cn("flex shrink-0 items-center gap-1 text-[10px] text-faint", onlyState.tone === "attention" && "text-destructive", yieldsToRowActions)} data-testid="cloud-workspace-row-state">
              <span aria-hidden className={cn("size-1.5 rounded-full", DOT[onlyState.tone])} />
              {onlyState.label}
            </span>
          )}
        </button>
        {only && <ShareBadge you={only.item.workspace.you} sharedWith={only.item.workspace.sharedWith} className={yieldsToRowActions} />}
        <RowActions persistent className={menu.open ? "not-sr-only" : undefined}>
          {/* A member is not shown a + that could only be refused; the menu's "New session" says why. */}
          {mayStart === true && (
            <WithTooltip label={`New session in ${project.fullName}`}>
              <Button variant="ghost" size="icon-xs" aria-label={`New session in ${project.fullName}`} onClick={() => startNewCloudSession(project.key)} disabled={startBlocked}>
                <Plus />
              </Button>
            </WithTooltip>
          )}
          <DropdownMenu {...menu.root}>
            <DropdownMenuTrigger asChild {...menu.trigger}>
              <Button variant="ghost" size="icon-xs" aria-label={`Project menu for ${project.fullName}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[17rem]" onCloseAutoFocus={keepFocusForNameField}>
              <DropdownMenuItem onSelect={() => startNewCloudSession(project.key)} disabled={startBlocked} title={mayStart === false ? NEW_SESSION_ADMIN_REASON : undefined}>
                <Plus /> New session
                {mayStart === false && <span className="ml-auto pl-3 text-[10px] text-faint">admins only</span>}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => updateOrgList("cloudPinned", project.orgId, (list) => (project.pinned ? list.filter((id) => id !== project.identity) : [...list, project.identity]))}
              >
                {project.pinned ? <PinOff /> : <Pin />} {project.pinned ? "Unpin project" : "Pin project"}
              </DropdownMenuItem>
              <MoveToSectionItems project={project} />
              <DropdownMenuItem onSelect={() => void refreshCloudWorkspaces(project.orgId)}>
                <RefreshCw /> Refresh
              </DropdownMenuItem>
              {/* The organization's report, for its owners and admins; one workspace is marked when the project has just one. */}
              {offersCloudDiagnostics(status, project.orgId) && <CloudDiagnosticsMenuItem onSelect={() => setDiagnostics(true)} />}
              {only && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="truncate">Workspace · {only.item.workspace.name}</DropdownMenuLabel>
                  <OpenWorkspaceItem node={only} />
                  <WorkspaceActionItems item={only.item} onLifecycle={onLifecycle} run={run} />
                </>
              )}
              {grouped && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                  {project.workspaces.map((node) => (
                    <DropdownMenuSub key={node.key}>
                      <DropdownMenuSubTrigger>
                        <Cloud /> <span className="truncate">{node.item.workspace.name}</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-[17rem]">
                        <OpenWorkspaceItem node={node} />
                        <WorkspaceActionItems item={node.item} onLifecycle={onLifecycle} run={run} />
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </>
              )}
              {removable && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      pendingBlank
                        ? updateOrgList("cloudBlankProjects", project.orgId, (list) => list.filter((name) => name.trim().toLowerCase() !== project.fullName.toLowerCase()))
                        : updateOrgList("cloudProjects", project.orgId, (list) => list.filter((id) => id !== project.identity))
                    }
                  >
                    <X /> Remove from sidebar
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </RowActions>
      </div>
      {error && <p className="ml-8 text-[10px] text-destructive">{error}</p>}
      {diagnostics && <CloudDiagnosticsDialog request={{ orgId: project.orgId, workspaceId: only?.item.workspace.id ?? null }} onClose={() => setDiagnostics(false)} />}
      <div
        className={cn("grid", animations && "transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        aria-hidden={!open}
        inert={!open}
        data-testid="cloud-project-sessions"
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="ml-[15px] flex flex-col gap-px border-l border-hairline pl-1.5">
            {project.workspaces.length === 0 && <li className="px-2 py-1 text-[12px] text-faint">{project.blank ? "No sessions yet. + starts one." : "No workspace yet."}</li>}
            {project.workspaces.map((node) => (
              <WorkspaceRows key={node.key} node={node} named={grouped} open={open} onLifecycle={onLifecycle} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** "Move to section" in a project's menu: the reader's sections, a new one, or none. */
function MoveToSectionItems({ project }: { project: CloudProject }) {
  const sections = useCloudSidebarSections(project.orgId);
  const current = sectionOfProject(sections, project.identity);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput /> Move to section
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[14rem]">
        {sections.map((section) => (
          <DropdownMenuItem
            key={section.id}
            role="menuitemradio"
            aria-checked={current?.id === section.id}
            disabled={current?.id === section.id}
            onSelect={() => moveProjectToSection(project.orgId, project.identity, section.id)}
          >
            {current?.id === section.id ? <Check /> : <span aria-hidden className="size-4 shrink-0" />}
            <span className="truncate">{section.name}</span>
          </DropdownMenuItem>
        ))}
        {sections.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => createCloudSection(project.orgId, project.identity)}>
          <FolderPlus /> New section…
        </DropdownMenuItem>
        {current && (
          <DropdownMenuItem onSelect={() => moveProjectToSection(project.orgId, project.identity, null)}>
            <X /> <span className="min-w-0 truncate">Remove from {current.name}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// ---- workspaces ------------------------------------------------------------

/**
 * Whether a workspace's own view (its terminals, files, Git and ports) can be
 * opened: it is running or stopped, and not mid-change or failed. A failed
 * first prompt counts only while `launchFailureStands` (no agent has run
 * there since), the rule "+" reuses a workspace by (`planCloudStart`).
 * Opening it may connect to a running machine; it never wakes a stopped one.
 * `tone`: the row's own state, when it already judged the workspace's tabs.
 */
export function workspaceOpenable(item: CloudWorkspaceListItem, tone?: RowTone): boolean {
  const { state } = item.workspace;
  const judged = tone ?? deriveCloudActivity(item, { agentRan: cloudAgentRan(item) }).tone;
  return (state === "ready" || state === "suspended") && judged !== "changing" && judged !== "attention";
}

/** "Open workspace" in a menu: the workspace's view, the one way to its terminals, files, Git and ports. */
function OpenWorkspaceItem({ node }: { node: CloudWorkspaceNode }) {
  if (!workspaceOpenable(node.item)) return null;
  return (
    <DropdownMenuItem onSelect={() => selectCloudWorkspace(node.key)} title="Its terminals, files, Git and ports; a stopped workspace is not started" data-testid="cloud-open-workspace">
      <AppWindow /> Open workspace
    </DropdownMenuItem>
  );
}

/** A workspace's sessions; with several workspaces in the project, under a row that names the workspace. */
function WorkspaceRows({ node, named, open, onLifecycle }: { node: CloudWorkspaceNode; named: boolean; open: boolean; onLifecycle: OnLifecycle }) {
  const store = useSessionStore();
  const filter = useSidebarFilter();
  const menu = useRowMenu();
  const [error, run] = useRowError();
  const { sessions: every, capabilities, manage: manages, known } = useCloudWorkspaceSessions(node, { load: open, showArchived: store.showArchived, selectedKey: store.selectedSessionId });
  const sessions = useMemo(() => {
    if (!filter.active) return every;
    const found = every.filter((row) => filter.shows(row.key));
    // The list says this workspace waits for a person, and no session known here says which: all of them show
    // (or, for one never opened on this desktop, the line that opens it).
    return !found.length && filter.showsWorkspace(node.key) ? every : found;
  }, [every, filter, node.key]);
  const activity = useWorkspaceActivity(node, every, !known || every.every((row) => row.source !== "live"));
  // Each session's mark as the Dashboard shows it: the live tabs while connected, else the server's list.
  const dashboard = useCloudDashboard();
  const marks = useMemo(() => new Map(dashboard.filter((session) => session.orgId === node.item.workspace.orgId && session.workspaceId === node.item.workspace.id).map((session) => [session.key, cloudSessionMark(session)])), [dashboard, node.item.workspace.orgId, node.item.workspace.id]);
  const connection = useCloudConnection(node.key);
  // What this desktop may do here: the attach result's authority once it has
  // connected, else what the list says opening would grant. A participant is
  // refused session changes, so it is not offered them; an older server that
  // says neither keeps the menu. On a shared workspace the manager role
  // (PRO-30) holds too: session/2 refuses anyone else.
  const authority = connection.authority ?? node.item.workspace.authority ?? null;
  const manage = manages && !!capabilities?.includes("session/2") && (authority === null || authority === "manage");
  const { workspace } = node.item;
  const openable = workspaceOpenable(node.item, activity.tone);
  // Filtered: a workspace with no such session has no rows, unless the server's list alone says it waits for a person.
  if (filter.active && !sessions.length && !filter.showsWorkspace(node.key)) return null;
  const rows = (
    <>
      {sessions.map((row) => (
        <CloudSessionItem key={row.key} row={row} status={marks.get(row.key) ?? cloudSessionStatus(row)} manage={manage} selected={store.selectedSessionId === row.key} />
      ))}
      {sessions.length === 0 && (
        <li className="truncate px-2 py-1 text-[12px] text-faint" data-testid="cloud-workspace-empty" data-workspace={workspace.id} title={workspaceCard(node.item, activity)}>
          {known ? (
            "No sessions yet."
          ) : !openable ? (
            activity.label
          ) : (
            <button type="button" className="max-w-full truncate text-left underline-offset-2 hover:text-muted-foreground hover:underline" onClick={() => selectCloudWorkspace(node.key)}>
              Open to load sessions
            </button>
          )}
        </li>
      )}
    </>
  );
  if (!named) return rows;
  const selected = store.selectedCloudWorkspace === node.key;
  const extra = extraRepositories(node.item);
  return (
    <li data-testid="cloud-workspace-group" data-workspace={workspace.id}>
      <div
        className={cn(actionRow, "relative flex h-8 min-w-0 items-center gap-2 rounded-md pl-2 pr-1 text-foreground/85", selected ? "bg-selected text-foreground" : "hover:bg-selected/50")}
        title={[workspaceCard(node.item, activity), extra?.card].filter(Boolean).join("\n")}
        onContextMenu={(event) => {
          event.preventDefault();
          menu.setOpen(true);
        }}
      >
        <button
          type="button"
          onClick={() => selectCloudWorkspace(node.key)}
          aria-current={selected ? "true" : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <GitBranch className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{workspace.name}</span>
          {extra && <Chip data-testid="cloud-extra-repositories">{extra.label}</Chip>}
          <span className={cn("flex shrink-0 items-center gap-1 text-[10px] text-faint", activity.tone === "attention" && "text-destructive", yieldsToRowActions)} data-testid="cloud-workspace-row-state">
            <span aria-hidden className={cn("size-1.5 rounded-full", DOT[activity.tone])} />
            {NAMED_TONES.has(activity.tone) ? activity.label : every.length > 0 && <span className="tabular-nums">{every.length}</span>}
          </span>
        </button>
        <ShareBadge you={workspace.you} sharedWith={workspace.sharedWith} className={yieldsToRowActions} />
        <RowActions persistent className={menu.open ? "not-sr-only" : undefined}>
          <DropdownMenu {...menu.root}>
            <DropdownMenuTrigger asChild {...menu.trigger}>
              <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${workspace.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[17rem]">
              <WorkspaceActionItems item={node.item} onLifecycle={onLifecycle} run={run} />
            </DropdownMenuContent>
          </DropdownMenu>
        </RowActions>
      </div>
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
      {deletionLine(node.item) && (
        <p className={cn("ml-6 text-[10px]", deletion(node.item) === "failed" ? "whitespace-normal break-words text-destructive" : "text-faint")} data-testid="cloud-workspace-row-deletion">
          {deletionLine(node.item)}
        </p>
      )}
      <ul className="ml-[13px] flex flex-col gap-px border-l border-hairline pl-1.5">{rows}</ul>
    </li>
  );
}

// ---- sessions --------------------------------------------------------------

/**
 * A cloud session as the sidebar draws a conversation: its name, its state at
 * the end, and its branch or when it was last active; its menu (for whoever
 * manages the workspace, on a runtime with session/2) renames, pins, archives
 * and deletes it, as a local conversation's does.
 */
function CloudSessionItem({ row, status, manage, selected }: { row: CloudSessionRow; status: TabStatus; manage: boolean; selected: boolean }) {
  const menu = useRowMenu();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorCode(e) === "cloud_workspace_stopped" ? "The workspace is stopped. Resume it to change its sessions." : errorMessage(e));
    }
  };
  const commitRename = () => {
    setRenaming(false);
    const next = title.trim();
    if (next && next !== row.title) void act(() => updateCloudSession(row, { title: next }));
  };
  const remove = async () => {
    const yes = await ask(`Delete "${row.title}"? Its transcript is removed from the cloud workspace.${row.worktreeName ? " Its worktree goes with it when no other session uses it." : ""}`, {
      title: "Delete session",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    }).catch(() => false);
    if (!yes) return;
    await act(async () => {
      try {
        await deleteCloudSession(row);
      } catch (refused) {
        // The runtime found the worktree not clean and merged: say what
        // would be lost and ask the second time before trying again.
        const reason = errorMessage(refused);
        if (!reason.includes(NEEDS_SECOND_CONFIRMATION)) throw refused;
        const sure = await ask(`${reason}\n\nNothing was deleted. Delete "${row.title}" and its worktree anyway?`, {
          title: "Delete anyway?",
          kind: "warning",
          okLabel: "Delete anyway",
          cancelLabel: "Cancel",
        }).catch(() => false);
        if (!sure) return;
        await deleteCloudSession(row, { confirmedUnsafe: true });
      }
      // Read at the time of the action, not of the render.
      if (getSessionStore().selectedSessionId === row.key) selectSession(null);
    });
  };
  return (
    <li>
      <div
        className={cn(actionRow, "relative flex h-8 items-center gap-2 rounded-md pl-2 pr-1", selected ? "bg-selected text-foreground" : "text-foreground/85 hover:bg-selected/50")}
        title={row.branch ? `${row.branch} · ${row.title}` : row.title}
        data-testid="cloud-session-row"
        data-session={row.key}
        onContextMenu={
          manage
            ? (event) => {
                event.preventDefault();
                menu.setOpen(true);
              }
            : undefined
        }
      >
        {renaming ? (
          <input
            autoFocus
            value={title}
            aria-label="Session name"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                setTitle(row.title);
                setRenaming(false);
              }
              event.stopPropagation();
            }}
            className="h-6 min-w-0 flex-1 rounded-sm bg-well px-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
          />
        ) : (
          <button
            type="button"
            onClick={() => selectCloudSession(row.key)}
            aria-current={selected ? "true" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {row.pinned && <Pin className="size-3 shrink-0 text-faint" />}
            <span className={cn("min-w-0 flex-1 truncate text-[13px]", row.archived && "text-faint")}>{row.title}</span>
            <StatusMark status={status} />
            {status === "in_progress" ? null : row.branch ? (
              <span className={cn("flex max-w-[45%] shrink-0 items-center gap-1 font-mono text-[10px] text-faint", yieldsToRowActions)}>
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{row.branch}</span>
              </span>
            ) : (
              <RowTime at={row.modified} />
            )}
          </button>
        )}
        {manage && !renaming && (
          <RowActions persistent className={menu.open ? "not-sr-only" : undefined}>
            <DropdownMenu {...menu.root}>
              <DropdownMenuTrigger asChild {...menu.trigger}>
                <Button variant="ghost" size="icon-xs" aria-label={`Session menu for ${row.title}`}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  onSelect={() => {
                    setTitle(row.title);
                    setRenaming(true);
                  }}
                >
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void act(() => updateCloudSession(row, { pinned: !row.pinned }))}>
                  <Pin /> {row.pinned ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void act(() => updateCloudSession(row, { archived: !row.archived }))}>
                  <Archive /> {row.archived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => void remove()}>
                  <Trash2 /> Delete session…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </RowActions>
        )}
      </div>
      {error && <p className="ml-2 text-[10px] text-destructive">{error}</p>}
    </li>
  );
}

// ---- archived workspaces --------------------------------------------------

/**
 * An archived workspace's second line: the archive in progress, why it did
 * not finish (it stays here to retry), or its deletion deadline; and what
 * the final save of its conversations did, when the archive reported it.
 */
export function archivedRowText(item: CloudWorkspaceListItem, now = Date.now()): { line: string; failed: boolean; saved: string | null } {
  const busy = archiving(item);
  const failed = item.workspace.state !== "archived" && !busy && !deletion(item);
  const saved = !busy && item.latestOperation?.action === "archive" ? checkpointText(item.latestOperation.checkpoint) : null;
  const deleting = deletionLine(item);
  const line = deleting
    ? deleting
    : busy
      ? archivingText(item)
      : failed
        ? `The archive did not finish: ${item.latestOperation ? operationFailureText(item.latestOperation) : lifecycleErrorMessage("cloud_workspace_unknown_error")}`
        : archiveLine(item, now);
  // A reason is read whole: it wraps instead of being cut at the sidebar's width.
  return { line, failed: failed || deletion(item) === "failed", saved };
}

/** An organization's archived workspaces, folded away at its end, each with what happens to it and its menu (Unarchive, Delete). */
export function ArchivedWorkspaces({ orgId, nodes, onLifecycle }: { orgId: string; nodes: CloudWorkspaceNode[]; onLifecycle: OnLifecycle }) {
  const [open, toggle] = useFold(`cloud-archived:${orgId}`, false);
  const label = `Archived workspaces (${nodes.length})`;
  return (
    <div role="group" aria-label={label} className="mb-1" data-testid="cloud-node-archived">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title="Stopped, and deleted after their deadline"
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-muted-foreground outline-none hover:bg-selected/50 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Archive className="size-4 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
        <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="ml-[15px] border-l border-hairline pl-1.5">
          <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-faint" data-testid="cloud-archived-note">
            Stopped and kept until their deadline, then deleted automatically. Storage keeps billing at the provider until then.
          </p>
          <ul className="flex flex-col gap-px">
            {nodes.map((node) => (
              <ArchivedWorkspaceRow key={node.key} node={node} onLifecycle={onLifecycle} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ArchivedWorkspaceRow({ node, onLifecycle }: { node: CloudWorkspaceNode; onLifecycle: OnLifecycle }) {
  const store = useSessionStore();
  const { item, key } = node;
  const { workspace } = item;
  const [error, run] = useRowError();
  const menu = useRowMenu();
  const state = deriveCloudActivity(item);
  const selected = store.selectedCloudWorkspace === key;
  const text = archivedRowText(item);
  // Reading is for anyone the workspace is shared with; it connects without waking, and an archived machine is never started by it.
  const readable = workspace.state === "archived" && !deletion(item) && workspace.you?.role !== "none";
  return (
    <li data-testid="cloud-workspace-node" data-workspace={workspace.id}>
      <div
        className={cn(actionRow, "relative flex min-w-0 items-start gap-1 rounded-md pl-2 pr-1", selected ? "bg-selected text-foreground" : "hover:bg-selected/50")}
        title={[describeWorkspace(item), text.line, text.saved].filter(Boolean).join("\n")}
        onContextMenu={(event) => {
          event.preventDefault();
          menu.setOpen(true);
        }}
      >
        <button
          type="button"
          onClick={() => selectCloudWorkspace(key)}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 flex-col items-stretch rounded-sm py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state.tone])} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{workspace.name}</span>
            <span className={cn("shrink-0 text-[10px] text-faint", yieldsToRowActions)} data-testid="cloud-workspace-row-state">
              {state.label}
            </span>
          </span>
          <span className={cn("pl-3.5 text-[10px] text-faint", text.failed ? "whitespace-normal break-words text-destructive" : "truncate")} data-testid="cloud-archive-deadline">
            {text.line}
          </span>
          {text.saved && (
            <span className="truncate pl-3.5 text-[10px] text-faint" data-testid="cloud-archive-saved">
              {text.saved}
            </span>
          )}
        </button>
        <RowActions persistent className={cn("mt-1", menu.open && "not-sr-only")}>
          <DropdownMenu {...menu.root}>
            <DropdownMenuTrigger asChild {...menu.trigger}>
              <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${workspace.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[17rem]">
              {readable && (
                <DropdownMenuItem onSelect={() => selectCloudWorkspace(key)} title="Read saved agent conversations; nothing is started" data-testid="cloud-read-conversations">
                  <BookOpen /> Read conversations
                </DropdownMenuItem>
              )}
              <WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} archived />
            </DropdownMenuContent>
          </DropdownMenu>
        </RowActions>
      </div>
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
    </li>
  );
}
