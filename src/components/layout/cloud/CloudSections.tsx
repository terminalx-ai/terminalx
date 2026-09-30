import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Archive,
  ArrowLeftRight,
  Cloud,
  Ellipsis,
  Folder,
  FolderGit2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
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
import { RowActions, actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { AgentTabRow, ItemTitle, RowChip, RowTime, StatusStripe, TreeGroup, TreeNode, TreeRow, TreeToggle } from "@/components/layout/SidebarRows";
import { archiveLine } from "@/components/cloud/CloudWorkspaceLifecycle";
import { describeWorkspace } from "@/components/cloud/CloudSessionPage";
import { api, errorMessage, type CloudWorkspaceListItem, type OrganizationSummary } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import {
  cloudOrganizations,
  defaultOrgId,
  liveCloudOrgIds,
  placeCloudProjects,
  refreshCloudCatalog,
  useCloudCatalog,
  type OrgCatalog,
} from "@/lib/cloudCatalog";
import { useCloudConnection } from "@/lib/cloudConnections";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { deriveCloudActivity, type CloudActivity, type RowTone } from "@/lib/cloudRowState";
import {
  bootCloudSessions,
  closeCloudSessionTab,
  cloudSessionStatus,
  deleteCloudSession,
  updateCloudSession,
  useCloudWorkspaceSessions,
  type CloudSessionRow,
} from "@/lib/cloudSessions";
import { errorCode } from "@/lib/cloudTerminals";
import { cn } from "@/lib/cn";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { getSessionStore, selectCloudProjectInSidebar, selectCloudSession, selectCloudWorkspace, selectSession, startCloudSessionIn, useSessionStore } from "@/lib/sessions";
import { orgSectionKey, parseCloudWorkspaceKey, type CloudProject, type CloudWorkspaceNode } from "@/types/target";
import { AddRepositoryDialog, NewBlankProjectDialog } from "./AddCloudProject";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { ShareBadge } from "@/components/cloud/CloudCollab";
import { WorkspaceActionItems, WorkspaceLifecycleDialog, type LifecycleRequest as Dialog } from "@/components/cloud/WorkspaceActions";

export { useRowMenu };

/**
 * Organization sections of the sidebar (PRO-23), built like the Local
 * section: an organization lists its projects (repositories, and blank
 * projects with no repository), each project lists its sessions and their
 * tabs, and `+` on a project starts a new session in it. The VM a session
 * runs on is a detail: a small location chip and the hover card, and a group
 * row only when a project has more than one workspace. Workspace lifecycle
 * actions live in the project's "…" menu.
 *
 * Every cloud-enabled organization's section is live at once on a server
 * that authorizes desktop cloud routes by membership (CS-18): its projects,
 * sessions, `+` and new session work with no switch of the default
 * organization. On an older server only the default organization's section
 * is live, and the others are one line with Switch, as before.
 *
 * Looking never costs money: rendering, expanding and selecting read the
 * catalog and this desktop's caches only; nothing connects or resumes.
 */

/**
 * Organizations with a section, default first then by name, and which of them
 * are live; none while signed out, with no cloud-enabled organization, or
 * with the kill switch off.
 */
export function useCloudSections(): { orgs: OrganizationSummary[]; defaultOrg: string | null; live: ReadonlySet<string> } {
  const { status } = useAccount();
  const { cloudSidebar } = usePrefs();
  return useMemo(() => {
    if (!cloudSidebar) return { orgs: [], defaultOrg: null, live: new Set<string>() };
    const orgs = cloudOrganizations(status);
    const defaultOrg = defaultOrgId(status);
    const sorted = [...orgs].sort((a, b) => Number(b.id === defaultOrg) - Number(a.id === defaultOrg) || sectionName(a).localeCompare(sectionName(b)));
    return { orgs: sorted, defaultOrg, live: new Set(liveCloudOrgIds(status)) };
  }, [status, cloudSidebar]);
}

export function sectionName(org: OrganizationSummary): string {
  return org.isPersonal ? "Personal" : org.name;
}

/** Whether a section is collapsed, remembered per section in prefs; `byDefault` when never toggled. */
export function useSectionCollapsed(key: string, byDefault = false): [boolean, () => void] {
  const { sidebarSections } = usePrefs();
  const stored = sidebarSections[key];
  const collapsed = stored ? stored === "collapsed" : byDefault;
  return [collapsed, () => setPrefs({ sidebarSections: { ...sidebarSections, [key]: collapsed ? "expanded" : "collapsed" } })];
}

type AddDialog = { orgId: string; orgName: string; kind: "repository" | "blank" };

export function CloudSections({ onOpenCloudPage, onOpenAccount }: { onOpenCloudPage?: () => void; onOpenAccount?: () => void }) {
  const { orgs, defaultOrg, live } = useCloudSections();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [adding, setAdding] = useState<AddDialog | null>(null);
  useEffect(() => bootCloudSessions(), []);
  if (!orgs.length) return null;
  return (
    <>
      {orgs.map((org, index) => (
        <OrgSection
          key={org.id}
          org={org}
          isDefault={org.id === defaultOrg}
          live={live.has(org.id)}
          // Live sections are spaced like Local; organizations that are not live sit close together as compact lines under one gap.
          spaced={index === 0 || live.has(org.id) || live.has(orgs[index - 1].id)}
          onLifecycle={setDialog}
          onAdd={(kind) => setAdding({ orgId: org.id, orgName: sectionName(org), kind })}
          onOpenCloudPage={onOpenCloudPage}
        />
      ))}
      {dialog && <WorkspaceLifecycleDialog request={dialog} onClose={() => setDialog(null)} />}
      {adding?.kind === "repository" && (
        <AddRepositoryDialog orgId={adding.orgId} orgName={adding.orgName} onClose={() => setAdding(null)} onOpenSettings={onOpenAccount} />
      )}
      {adding?.kind === "blank" && <NewBlankProjectDialog orgId={adding.orgId} orgName={adding.orgName} onClose={() => setAdding(null)} />}
    </>
  );
}

const HINT = "Its cloud sessions show when it is the default organization. Use Switch.";

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function OrgSection({
  org,
  isDefault,
  live,
  spaced,
  onLifecycle,
  onAdd,
  onOpenCloudPage,
}: {
  org: OrganizationSummary;
  isDefault: boolean;
  /** Its projects and sessions show and work (CS-18: every cloud-enabled organization; before it, the default one). */
  live: boolean;
  spaced: boolean;
  onLifecycle: (dialog: Dialog) => void;
  onAdd: (kind: AddDialog["kind"]) => void;
  onOpenCloudPage?: () => void;
}) {
  const catalog = useCloudCatalog();
  const { status } = useAccount();
  // A live section starts expanded; one that is not live is a compact line. The collapse is remembered per organization.
  const [collapsed, toggle] = useSectionCollapsed(orgSectionKey(org.id), !live);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const menu = useRowMenu();
  const addMenu = useRowMenu();
  const cached = catalog.orgs[org.id];
  const name = sectionName(org);
  const offline = live && !!cached?.error && cached.fetchedAt !== null;

  const switchOrg = async () => {
    setSwitchError(null);
    const current = status.identity?.organization ?? "the current organization";
    const yes = await ask(`Cloud sessions open in ${current} will close. Switch the default organization to ${org.name}?`, {
      title: "Switch organization",
      kind: "info",
      okLabel: "Switch",
      cancelLabel: "Cancel",
    }).catch(() => false);
    if (!yes) return;
    try {
      await api.organizationSelect(org.id, status.context?.revision ?? "");
      await refreshAccount();
    } catch (error) {
      setSwitchError(errorMessage(error));
    }
  };

  return (
    <div
      role="treeitem"
      aria-label={`${name} organization`}
      aria-expanded={live ? !collapsed : undefined}
      aria-description={live ? undefined : HINT}
      className={cn("min-w-0", spaced ? "mt-3" : "mt-0.5")}
      data-testid="cloud-org-section"
      data-org={org.id}
    >
      <div data-tree-row className={cn(actionRow, "relative flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 hover:bg-selected/40")} data-testid="cloud-org-header" title={live ? undefined : HINT}>
        {live ? (
          <>
            <TreeToggle expanded={!collapsed} label={`${name} organization`} onToggle={toggle} />
            <button
              type="button"
              onClick={toggle}
              className="min-w-0 flex-1 truncate rounded-sm text-left text-[11px] font-medium uppercase tracking-wide text-faint outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              title={org.isPersonal ? `${org.name} (personal)` : org.name}
            >
              {name}
            </button>
          </>
        ) : (
          // Another organization is exactly one line: its name, its role, and Switch; the explanation is the tooltip.
          <span className="min-w-0 flex-1 truncate pl-5 text-[11px] font-medium uppercase tracking-wide text-faint" data-testid="cloud-org-name">
            {name}
          </span>
        )}
        <span className={cn("shrink-0", yieldsToRowActions)} data-testid="cloud-org-role">
          <RowChip>{org.role}</RowChip>
        </span>
        <RowActions persistent className={menu.open || addMenu.open ? "not-sr-only" : undefined}>
          {!live && (
            <WithTooltip label="Make this the default organization to show its cloud sessions">
              <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[10px]" onClick={() => void switchOrg()} data-testid="cloud-org-switch">
                Switch
              </Button>
            </WithTooltip>
          )}
          {live && (
            <DropdownMenu {...addMenu.root}>
              <WithTooltip label="Add project">
                <DropdownMenuTrigger asChild {...addMenu.trigger}>
                  <Button variant="ghost" size="icon-xs" aria-label={`Add project to ${name}`} data-testid="cloud-add-project">
                    <Plus />
                  </Button>
                </DropdownMenuTrigger>
              </WithTooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onAdd("repository")}>
                  <FolderGit2 /> From repository…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAdd("blank")}>
                  <Folder /> New project…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu {...menu.root}>
            <DropdownMenuTrigger asChild {...menu.trigger}>
              <Button variant="ghost" size="icon-xs" aria-label={`Menu for ${name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {live ? (
                <>
                  <DropdownMenuItem onSelect={() => void refreshCloudCatalog(org.id)}>
                    <RefreshCw /> Refresh cloud workspaces
                  </DropdownMenuItem>
                  {/* The full-window page works in the default organization. */}
                  {isDefault && onOpenCloudPage && (
                    <DropdownMenuItem onSelect={onOpenCloudPage}>
                      <Plus /> New cloud workspace…
                    </DropdownMenuItem>
                  )}
                </>
              ) : (
                <DropdownMenuItem onSelect={() => void switchOrg()}>
                  <ArrowLeftRight /> Switch to show cloud sessions
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </RowActions>
      </div>
      {switchError && <div className="pl-5 text-[10px] text-destructive">{switchError}</div>}
      {offline && (
        <div className="pl-5 text-[10px] text-faint" data-testid="cloud-org-offline" title={cached!.error ?? undefined}>
          Offline · last known {timeText(cached!.fetchedAt!)}
        </div>
      )}
      {live && (
        <TreeGroup expanded={!collapsed} className={cn("min-w-0", offline && "opacity-70")}>
          <OrgTree org={cached} orgId={org.id} onLifecycle={onLifecycle} />
        </TreeGroup>
      )}
    </div>
  );
}

function OrgTree({ org, orgId, onLifecycle }: { org: OrgCatalog | undefined; orgId: string; onLifecycle: (dialog: Dialog) => void }) {
  const catalog = useCloudCatalog();
  const prefs = usePrefs();
  const placed = useMemo(
    () =>
      placeCloudProjects(org ?? { orgId, workspaces: [], repositories: null }, catalog.createMemory, {
        pinned: prefs.cloudPinned[orgId],
        added: prefs.cloudProjects[orgId],
        blank: prefs.cloudBlankProjects[orgId],
      }),
    [org, orgId, catalog.createMemory, prefs.cloudPinned, prefs.cloudProjects, prefs.cloudBlankProjects],
  );
  const [archivedOpen, setArchivedOpen] = useState(false);

  if (!org || (org.fetchedAt === null && !org.workspaces.length && !placed.projects.length)) {
    return (
      <div className="pl-5 text-[11px] text-faint" data-testid="cloud-org-loading">
        {org?.error ? `Cloud workspaces are unavailable (${org.error}).` : "Loading cloud workspaces…"}
      </div>
    );
  }
  const empty = !placed.projects.length && !placed.archived.length;
  return (
    <>
      {empty && <div className="pl-5 text-[11px] text-faint">No cloud projects yet. Add one with +.</div>}
      {placed.projects.map((project) => (
        <CloudProjectNode key={project.key} project={project} onLifecycle={onLifecycle} />
      ))}
      {placed.archived.length > 0 && (
        <TreeNode label={`Archived workspaces (${placed.archived.length})`} expanded={archivedOpen}>
          <div data-tree-row className="relative flex h-7 min-w-0 items-center gap-1 rounded-md px-1 text-muted-foreground hover:bg-selected/50" data-testid="cloud-node-archived" title="Stopped, and deleted after their deadline">
            <TreeToggle expanded={archivedOpen} label={`Archived workspaces (${placed.archived.length})`} onToggle={() => setArchivedOpen((open) => !open)} />
            <button type="button" onClick={() => setArchivedOpen((open) => !open)} className="min-w-0 flex-1 truncate rounded-sm text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              Archived workspaces ({placed.archived.length})
            </button>
          </div>
          <TreeGroup expanded={archivedOpen} className="pb-1 pl-2">
            {placed.archived.map((node) => (
              <ArchivedWorkspaceRow key={node.key} node={node} onLifecycle={onLifecycle} />
            ))}
          </TreeGroup>
        </TreeNode>
      )}
    </>
  );
}

// ---- projects --------------------------------------------------------------

/** `+`: the new-session form for the project, with the prompt focused so Return starts it. */
function startNewCloudSession(projectKey: string) {
  startCloudSessionIn(projectKey);
  setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea[data-new-session-prompt]")?.focus(), 0);
}

/** On a row: focus the button or tab row a click landed on (WebKit does not focus a clicked button). */
function focusClicked(event: MouseEvent<HTMLElement>) {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button, [role="treeitem"][tabindex]');
  if (target && event.currentTarget.contains(target)) keepFocus(target);
}

/**
 * Keep keyboard focus on the row that was clicked. A click driven through the
 * accessibility tree (or one that re-renders the main slot) must not leave
 * focus, and its ring, on some other control such as a navigation item.
 */
function keepFocus(element: HTMLElement) {
  element.focus();
  setTimeout(() => {
    if (element.isConnected && document.activeElement !== element && !element.closest("[hidden]")) element.focus();
  }, 0);
}

function updateOrgList(key: "cloudProjects" | "cloudPinned" | "cloudBlankProjects", orgId: string, change: (list: string[]) => string[]) {
  const current = getPrefs()[key];
  setPrefs({ [key]: { ...current, [orgId]: change(current[orgId] ?? []) } });
}

function CloudProjectNode({ project, onLifecycle }: { project: CloudProject; onLifecycle: (dialog: Dialog) => void }) {
  const prefs = usePrefs();
  const store = useSessionStore();
  const menu = useRowMenu();
  const [error, setError] = useState<string | null>(null);
  const expanded = !prefs.cloudCollapsed[project.key];
  const selectedWorkspace = store.selectedSessionId ? parseCloudWorkspaceKey(store.selectedSessionId) : null;
  const holdsSelection = !!selectedWorkspace && project.workspaces.some((node) => node.item.workspace.id === selectedWorkspace.workspaceId && node.item.workspace.orgId === selectedWorkspace.orgId);
  const drafting = store.cloudSessionPreset?.projectKey === project.key;
  const focused = store.selectedCloudProject === project.key && !holdsSelection;
  const grouped = project.workspaces.length > 1;
  const toggle = () => {
    const next = { ...prefs.cloudCollapsed };
    if (expanded) next[project.key] = true;
    else delete next[project.key];
    setPrefs({ cloudCollapsed: next });
  };
  // A selection inside reveals the project, like local navigation does.
  useEffect(() => {
    if (!holdsSelection || !prefs.cloudCollapsed[project.key]) return;
    const next = { ...prefs.cloudCollapsed };
    delete next[project.key];
    setPrefs({ cloudCollapsed: next });
  }, [holdsSelection, store.navigationVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const added = (prefs.cloudProjects[project.orgId] ?? []).includes(project.identity);
  const pendingBlank = project.blank && !project.workspaces.length;
  const removable = !project.workspaces.length && (added || pendingBlank);
  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(lifecycleErrorMessage(errorCode(e)));
    }
  };

  return (
    <TreeNode label={project.fullName} expanded={expanded}>
      <div
        data-tree-row
        className={cn(actionRow, "relative flex h-8 min-w-0 items-center gap-1 rounded-md px-1", drafting || focused ? "bg-selected" : holdsSelection ? "bg-selected/50" : "hover:bg-selected/50")}
        title={project.blank ? `${project.fullName} · no repository` : project.identity}
        data-testid="cloud-project-row"
        data-project={project.key}
      >
        <TreeToggle expanded={expanded} label={project.fullName} onToggle={toggle} />
        <button
          type="button"
          onClick={(event) => {
            keepFocus(event.currentTarget);
            selectCloudProjectInSidebar(project.key);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {project.blank ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-[13px]">{project.fullName}</span>
          {project.pinned && <Pin className="size-3 shrink-0 text-faint" />}
          {project.blank && <RowChip>no repo</RowChip>}
          {!project.selected && <RowChip>not accessible</RowChip>}
        </button>
        <RowActions persistent className={menu.open ? "not-sr-only" : undefined}>
          <WithTooltip label={`New session in ${project.fullName}`}>
            <Button variant="ghost" size="icon-xs" aria-label={`New session in ${project.fullName}`} onClick={() => startNewCloudSession(project.key)} disabled={!project.selected}>
              <Plus />
            </Button>
          </WithTooltip>
          <DropdownMenu {...menu.root}>
            <DropdownMenuTrigger asChild {...menu.trigger}>
              <Button variant="ghost" size="icon-xs" aria-label={`Project menu for ${project.fullName}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[17rem]">
              <DropdownMenuItem onSelect={() => startNewCloudSession(project.key)} disabled={!project.selected}>
                <Plus /> New session
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => updateOrgList("cloudPinned", project.orgId, (list) => (project.pinned ? list.filter((id) => id !== project.identity) : [...list, project.identity]))}
              >
                {project.pinned ? <PinOff /> : <Pin />} {project.pinned ? "Unpin project" : "Pin project"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void refreshCloudCatalog(project.orgId)}>
                <RefreshCw /> Refresh
              </DropdownMenuItem>
              {project.workspaces.length === 1 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="truncate">Workspace · {project.workspaces[0].item.workspace.name}</DropdownMenuLabel>
                  <WorkspaceActionItems item={project.workspaces[0].item} onLifecycle={onLifecycle} run={run} />
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
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
      <TreeGroup expanded={expanded} className="pb-1 pl-2">
        {project.workspaces.length === 0 ? (
          <div className="px-5 py-1 text-[11px] text-faint">{project.blank ? "No sessions yet. + starts one." : "No sessions yet."}</div>
        ) : grouped ? (
          project.workspaces.map((node) => <WorkspaceGroupNode key={node.key} node={node} expanded={expanded} onLifecycle={onLifecycle} />)
        ) : (
          <WorkspaceSessions node={project.workspaces[0]} shown={expanded} showLocation />
        )}
      </TreeGroup>
    </TreeNode>
  );
}

// ---- workspaces ------------------------------------------------------------

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

/** The hover card of a workspace: where its sessions run. */
function workspaceCard(item: CloudWorkspaceListItem, activity: CloudActivity): string {
  const { workspace } = item;
  const lines = [`Cloud workspace ${workspace.name}`, `Runs on ${workspace.provider}`, `State: ${activity.label}${activity.lastKnown ? " (last known)" : ""}`, describeWorkspace(item)];
  const branch = workspace.launch?.workBranch;
  if (branch) lines.push(`Branch: ${branch}`);
  const repositories = (workspace.repositories ?? []).map((repository) => repository.fullName ?? repository.identity).filter(Boolean);
  if (repositories.length) lines.push(`Repositories: ${repositories.join(", ")}`);
  lines.push(`Access: ${workspace.accessMode === "organization" ? "organization" : "private"}`);
  return [...new Set(lines)].join("\n");
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

/** One workspace as a group row, when its project has more than one. */
function WorkspaceGroupNode({ node, expanded: projectExpanded, onLifecycle }: { node: CloudWorkspaceNode; expanded: boolean; onLifecycle: (dialog: Dialog) => void }) {
  const store = useSessionStore();
  const [expanded, setExpanded] = useState(true);
  const menu = useRowMenu();
  const [error, setError] = useState<string | null>(null);
  const { workspace } = node.item;
  const selected = store.selectedCloudWorkspace === node.key;
  const shown = projectExpanded && expanded;
  const { sessions, known } = useCloudWorkspaceSessions(node, { load: shown, showArchived: store.showArchived, selectedKey: store.selectedSessionId });
  const activity = useWorkspaceActivity(node, sessions, !known || sessions.every((row) => row.source !== "live"));
  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(lifecycleErrorMessage(errorCode(e)));
    }
  };
  const branch = workspace.launch?.workBranch ?? null;
  return (
    <div role="treeitem" aria-label={workspace.name} aria-expanded={expanded} aria-selected={selected} className="min-w-0" data-testid="cloud-workspace-node" data-workspace={workspace.id} onClickCapture={focusClicked}>
      <TreeRow level="group" selected={selected} title={workspaceCard(node.item, activity)}>
        <TreeToggle expanded={expanded} label={workspace.name} onToggle={() => setExpanded((open) => !open)} className="ml-0.5" />
        <Cloud className="size-3 shrink-0" aria-label="Cloud workspace" />
        <button type="button" onClick={() => selectCloudWorkspace(node.key)} className="min-w-0 flex-1 truncate rounded-sm text-left font-mono text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          {workspace.name}
        </button>
        {branch && (
          <span className={cn("min-w-0", yieldsToRowActions)} title="This workspace's own branch" data-testid="cloud-workspace-row-branch">
            <RowChip mono>{branch}</RowChip>
          </span>
        )}
        <ShareBadge you={workspace.you} sharedWith={workspace.sharedWith} className={yieldsToRowActions} />
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[activity.tone])} />
        <span className={cn("shrink-0 text-[10px] text-faint", activity.tone === "attention" && "text-destructive", yieldsToRowActions)} data-testid="cloud-workspace-row-state">
          {activity.label}
        </span>
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
      </TreeRow>
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
      <TreeGroup expanded={expanded} className="pl-2">
        <WorkspaceSessions node={node} shown={shown} showLocation={false} />
      </TreeGroup>
    </div>
  );
}

/** A workspace's sessions, straight under the project (or under its group row). */
function WorkspaceSessions({ node, shown, showLocation }: { node: CloudWorkspaceNode; shown: boolean; showLocation: boolean }) {
  const store = useSessionStore();
  const { sessions, capabilities, known } = useCloudWorkspaceSessions(node, { load: shown, showArchived: store.showArchived, selectedKey: store.selectedSessionId });
  const activity = useWorkspaceActivity(node, sessions, sessions.every((row) => row.source !== "live"));
  const card = workspaceCard(node.item, activity);
  const manage = !!capabilities?.includes("session/2");
  const { state } = node.item.workspace;
  if (!sessions.length) {
    const openable = (state === "ready" || state === "suspended") && activity.tone !== "changing" && activity.tone !== "attention";
    return (
      <div className="flex min-w-0 items-center gap-1.5 px-5 py-1 text-[11px] text-faint" data-testid="cloud-workspace-empty" data-workspace={node.item.workspace.id} title={card}>
        {showLocation && <LocationChip name={node.item.workspace.name} tone={activity.tone} card={card} />}
        {known || !openable ? (
          <span className="min-w-0 truncate">{known ? "No sessions yet." : activity.label}</span>
        ) : (
          <button type="button" className="min-w-0 truncate underline-offset-2 hover:text-muted-foreground hover:underline" onClick={() => selectCloudWorkspace(node.key)}>
            Open to load sessions
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      {sessions.map((row) => (
        <CloudSessionNode key={row.key} row={row} node={node} manage={manage} location={showLocation ? { tone: activity.tone, card } : null} />
      ))}
    </>
  );
}

/** Where a session runs: a small chip, with the workspace's hover card. */
function LocationChip({ name, tone, card }: { name: string; tone: RowTone; card: string }) {
  return (
    <span className={cn("flex max-w-24 shrink-0 items-center gap-1 rounded-sm bg-veil-raised px-1 text-[9px] text-faint", yieldsToRowActions)} title={card} data-testid="cloud-location-chip">
      <span aria-hidden className={cn("size-1 shrink-0 rounded-full", DOT[tone])} />
      <Cloud className="size-2.5 shrink-0" aria-label="Runs in the cloud" />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

// ---- sessions --------------------------------------------------------------

function CloudSessionNode({ row, node, manage, location }: { row: CloudSessionRow; node: CloudWorkspaceNode; manage: boolean; location: { tone: RowTone; card: string } | null }) {
  const store = useSessionStore();
  const selected = store.selectedSessionId === row.key;
  const [expanded, setExpanded] = useState(selected);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [error, setError] = useState<string | null>(null);
  const menu = useRowMenu();
  const status = cloudSessionStatus(row);
  useEffect(() => {
    if (selected) setExpanded(true);
  }, [selected, store.navigationVersion]);

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      const code = errorCode(e);
      setError(code === "cloud_workspace_stopped" ? "The workspace is stopped. Resume it to change its sessions." : errorMessage(e));
    }
  };
  const commitRename = () => {
    setRenaming(false);
    const next = title.trim();
    if (next && next !== row.title) void act(() => updateCloudSession(row, { title: next }));
  };
  const remove = async () => {
    const yes = await ask(`Delete "${row.title}"? Its transcript is removed from the cloud workspace${row.worktreeName ? ", with its worktree" : ""}.`, {
      title: "Delete session",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    }).catch(() => false);
    if (!yes) return;
    await act(async () => {
      await deleteCloudSession(row);
      // Read at the time of the action, not of the render.
      if (getSessionStore().selectedSessionId === row.key) selectSession(null);
    });
  };
  const closeTab = async (tabId: string, label: string) => {
    const yes = await ask(`Close ${label}? Its agent stops on the cloud workspace.`, { title: "Close tab", kind: "warning", okLabel: "Close", cancelLabel: "Cancel" }).catch(() => false);
    if (yes) await act(() => closeCloudSessionTab(row, tabId));
  };

  return (
    <div role="none" data-testid="cloud-session-node" data-session={row.key} onClickCapture={focusClicked}>
      <TreeNode label={row.title} expanded={expanded}>
        <TreeRow level="item" selected={selected} title={location?.card}>
          <StatusStripe status={status} size="row" />
          <TreeToggle expanded={expanded} label={row.title} onToggle={() => setExpanded((open) => !open)} />
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
              className="h-6 min-w-0 flex-1 rounded-sm bg-well px-1 text-[12px] outline-none focus:ring-2 focus:ring-ring/40"
            />
          ) : (
            <ItemTitle title={row.title} pinned={row.pinned} archived={row.archived} onActivate={() => selectCloudSession(row.key)} />
          )}
          {location && <ShareBadge you={node.item.workspace.you} sharedWith={node.item.workspace.sharedWith} className={yieldsToRowActions} />}
          {location && <LocationChip name={node.item.workspace.name} tone={location.tone} card={location.card} />}
          <RowTime at={row.modified} />
          {manage && (
            <RowActions persistent className={menu.open ? "not-sr-only" : undefined}>
              <DropdownMenu {...menu.root}>
                <DropdownMenuTrigger asChild {...menu.trigger}>
                  <Button variant="ghost" size="icon-xs" aria-label={`Session menu for ${row.title}`}>
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
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
        </TreeRow>
        {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
        <TreeGroup expanded={expanded} className="pl-5">
          {row.tabs.map((tab) => {
            const label = tab.title?.trim() || (tab.harness === "codex" ? "Codex" : tab.harness === "claude" ? "Claude" : tab.harness);
            return (
              <AgentTabRow
                key={tab.tabId}
                nodeId={`cloud-tab-${row.workspaceId}-${tab.tabId}`}
                panelId={`cloud-panel-${row.workspaceId}-${tab.tabId}`}
                harness={tab.harness}
                label={label}
                status={tab.status}
                mobileDriven={false}
                terminalView={false}
                selected={selected}
                onOpen={() => selectCloudSession(row.key)}
                onClose={() => void closeTab(tab.tabId, label)}
              />
            );
          })}
          {row.tabs.length === 0 ? <div className="px-3 py-1 text-[11px] text-faint">No tabs.</div> : null}
        </TreeGroup>
      </TreeNode>
    </div>
  );
}

// ---- archived workspaces --------------------------------------------------

function ArchivedWorkspaceRow({ node, onLifecycle }: { node: CloudWorkspaceNode; onLifecycle: (dialog: Dialog) => void }) {
  const store = useSessionStore();
  const { item, key } = node;
  const { workspace } = item;
  const [error, setError] = useState<string | null>(null);
  const menu = useRowMenu();
  const state = deriveCloudActivity(item);
  const selected = store.selectedCloudWorkspace === key;
  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(lifecycleErrorMessage(errorCode(e)));
    }
  };
  return (
    <div role="treeitem" aria-label={workspace.name} aria-selected={selected} className="min-w-0" data-testid="cloud-workspace-node" data-workspace={workspace.id}>
      <TreeRow level="item" selected={selected} title={describeWorkspace(item)}>
        <span aria-hidden className={cn("ml-1.5 size-1.5 shrink-0 rounded-full", DOT[state.tone])} />
        <button
          type="button"
          onClick={() => selectCloudWorkspace(key)}
          className="flex min-w-0 flex-1 flex-col items-stretch rounded-sm py-1 pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="flex min-w-0 items-center gap-1">
            <Cloud className="size-3 shrink-0 text-faint" aria-label="Cloud workspace" />
            <span className="min-w-0 flex-1 truncate text-[12px]">{workspace.name}</span>
            <span className={cn("shrink-0 text-[10px] text-faint", yieldsToRowActions)} data-testid="cloud-workspace-row-state">
              {state.label}
            </span>
          </span>
          <span className="truncate pl-4 text-[10px] text-faint">{archiveLine(item)}</span>
        </button>
        <RowActions persistent className={menu.open ? "not-sr-only" : undefined}>
          <DropdownMenu {...menu.root}>
            <WithTooltip label="Workspace actions">
              <DropdownMenuTrigger asChild {...menu.trigger}>
                <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${workspace.name}`}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
            </WithTooltip>
            <DropdownMenuContent align="end" className="w-[17rem]">
              <WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} archived />
            </DropdownMenuContent>
          </DropdownMenu>
        </RowActions>
      </TreeRow>
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
    </div>
  );
}
