import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Archive,
  ArrowLeftRight,
  BookOpen,
  Cloud,
  Ellipsis,
  Folder,
  FolderGit2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Terminal,
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
import { AgentTabRow, ItemTitle, RowChip, RowTime, ShellTabRow, StatusStripe, TreeGroup, TreeNode, TreeRow, TreeToggle } from "@/components/layout/SidebarRows";
import { archiveLine, deletionLine } from "@/components/cloud/CloudWorkspaceLifecycle";
import { archivingText, describeWorkspace } from "@/components/cloud/CloudWorkspaceView";
import { openNewCloudWorkspace } from "@/components/cloud/NewCloudWorkspaceDialog";
import { api, errorMessage, type CloudWorkspaceListItem, type OrganizationSummary } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import {
  cloudOrganizations,
  defaultOrgId,
  dismissCloudNotice,
  liveCloudOrgIds,
  placeCloudProjects,
  refreshCloudWorkspaces,
  useCloudCatalog,
  type OrgCatalog,
} from "@/lib/cloudCatalog";
import { NEW_SESSION_ADMIN_REASON, NEW_WORKSPACE_ADMIN_REASON } from "@/lib/cloudCollab";
import { useCloudConnection } from "@/lib/cloudConnections";
import { archiving, checkpointText, deletion, lifecycleErrorMessage, operationFailureText, purgeNoticeText } from "@/lib/cloudLifecycle";
import { mayStartCloudSessions } from "@/lib/multiOrg";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { cloudAgentLabel, deriveCloudActivity, type CloudActivity, type RowTone } from "@/lib/cloudRowState";
import { workspaceUsage } from "@/lib/runningLimit";
import {
  bootCloudSessions,
  closeCloudSessionTab,
  closeCloudWorkspaceTerminal,
  cloudSessionStatus,
  deleteCloudSession,
  NEEDS_SECOND_CONFIRMATION,
  updateCloudSession,
  useCloudWorkspaceSessions,
  type CloudSessionRow,
} from "@/lib/cloudSessions";
import { errorCode, revealCloudTerminal, sessionTerminals, useCloudTerminals, workspaceTerminals, type CloudTerminal } from "@/lib/cloudTerminals";
import { tabNodeId, tabPanelId } from "@/lib/sessionTabs";
import { selectSessionTab, useTerminals } from "@/lib/terminal";
import { resolveSessionTab, useVisibleSessionTab } from "@/lib/visibleTab";
import { cn } from "@/lib/cn";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { getSessionStore, selectCloudProjectInSidebar, selectCloudSession, selectCloudWorkspace, selectSession, startCloudSessionIn, useSessionStore } from "@/lib/sessions";
import { orgSectionKey, parseCloudWorkspaceKey, type CloudProject, type CloudWorkspaceNode } from "@/types/target";
import { AddRepositoryDialog, NewBlankProjectDialog } from "./AddCloudProject";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { ShareBadge } from "@/components/cloud/CloudCollab";
import { WorkspaceActionItems, WorkspaceLifecycleDialog, type LifecycleRequest as Dialog } from "@/components/cloud/WorkspaceActions";
import { CloudDiagnosticsDialog, CloudDiagnosticsMenuItem, offersCloudDiagnostics } from "@/components/cloud/CloudDiagnosticsDialog";

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
 * are live; none while signed out or with no cloud-enabled organization.
 */
export function useCloudSections(): { orgs: OrganizationSummary[]; defaultOrg: string | null; live: ReadonlySet<string> } {
  const { status } = useAccount();
  return useMemo(() => {
    const orgs = cloudOrganizations(status);
    const defaultOrg = defaultOrgId(status);
    const sorted = [...orgs].sort((a, b) => Number(b.id === defaultOrg) - Number(a.id === defaultOrg) || sectionName(a).localeCompare(sectionName(b)));
    return { orgs: sorted, defaultOrg, live: new Set(liveCloudOrgIds(status)) };
  }, [status]);
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

export function CloudSections({ onOpenAccount }: { onOpenAccount?: () => void }) {
  const { orgs, defaultOrg, live } = useCloudSections();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [adding, setAdding] = useState<AddDialog | null>(null);
  useEffect(() => bootCloudSessions(), []);
  if (!orgs.length) return null;
  return (
    <>
      <PurgeNotices />
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

/** What this Mac dropped of workspaces deleted elsewhere (unsent messages, unsaved edits), said once and dismissed by hand. */
function PurgeNotices() {
  const { notices } = useCloudCatalog();
  if (!notices.length) return null;
  return (
    <div className="mt-3 flex min-w-0 flex-col gap-1 px-1">
      {notices.map((notice) => (
        <div key={notice.workspaceId} className="flex min-w-0 items-start gap-1.5 rounded-md bg-well px-2 py-1.5 text-[11px] text-muted-foreground" role="status" data-testid="cloud-tombstone-notice">
          <Trash2 className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{purgeNoticeText(notice)}</span>
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => dismissCloudNotice(notice)}>
            <X />
          </Button>
        </div>
      ))}
    </div>
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
}: {
  org: OrganizationSummary;
  isDefault: boolean;
  /** Its projects and sessions show and work (CS-18: every cloud-enabled organization; before it, the default one). */
  live: boolean;
  spaced: boolean;
  onLifecycle: (dialog: Dialog) => void;
  onAdd: (kind: AddDialog["kind"]) => void;
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
  // Creating a workspace is the API's owner-or-admin action, the same rule as
  // a project's "+": true for them, false for a member, null while this
  // account's role here is not known yet (nothing is offered until it is).
  const mayCreate = mayStartCloudSessions(status, org.id);
  // From the list this section already has; an older server sends none.
  const usage = live ? workspaceUsage(org.id, catalog) : null;

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
        {/* Stays beside the row's actions (the role chip gives way): its tooltip is reached by hovering or focusing it. */}
        {usage && (
          <InfoChip card={usage.card} className={usage.atLimit ? "[&>span]:text-warning" : undefined} data-testid="cloud-org-quota" data-at-limit={usage.atLimit || undefined}>
            {usage.label}
          </InfoChip>
        )}
        <RowActions persistent className={menu.open || addMenu.open ? "not-sr-only" : undefined}>
          {!live && (
            <WithTooltip label="Make this the default organization to show its cloud sessions">
              <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[10px]" onClick={() => void switchOrg()} data-testid="cloud-org-switch">
                Switch
              </Button>
            </WithTooltip>
          )}
          {/* Adding a repository only pins it to this sidebar, so a member may; a new project is created with its first session, so it says who can. */}
          {live && mayCreate !== null && (
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
                <DropdownMenuItem onSelect={() => onAdd("blank")} disabled={!mayCreate} title={mayCreate ? undefined : NEW_SESSION_ADMIN_REASON} data-testid="cloud-add-blank-project">
                  <Folder /> New project…
                  {!mayCreate && <span className="ml-auto pl-3 text-[10px] text-faint">admins only</span>}
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
                  <DropdownMenuItem onSelect={() => void refreshCloudWorkspaces(org.id)}>
                    <RefreshCw /> Refresh cloud workspaces
                  </DropdownMenuItem>
                  {/* The full form (several repositories, the provider) works in the default organization. */}
                  {isDefault && mayCreate !== null && (
                    <DropdownMenuItem onSelect={() => openNewCloudWorkspace()} disabled={!mayCreate} title={mayCreate ? undefined : NEW_WORKSPACE_ADMIN_REASON} data-testid="cloud-new-workspace">
                      <Plus /> New cloud workspace…
                      {!mayCreate && <span className="ml-auto pl-3 text-[10px] text-faint">admins only</span>}
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
          <OrgTree org={cached} orgId={org.id} mayCreate={mayCreate} onLifecycle={onLifecycle} />
        </TreeGroup>
      )}
    </div>
  );
}

/** What an organization with no cloud projects says: only someone who can create one is pointed at "+". */
export function emptyOrgText(mayCreate: boolean | null): string {
  if (mayCreate === true) return "No cloud projects yet. Add one with +.";
  // A member sees the workspaces shared with them, and cannot create one.
  if (mayCreate === false) return "No cloud projects shared with you yet.";
  return "No cloud projects yet.";
}

function OrgTree({ org, orgId, mayCreate, onLifecycle }: { org: OrgCatalog | undefined; orgId: string; mayCreate: boolean | null; onLifecycle: (dialog: Dialog) => void }) {
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
  const filter = useSidebarFilter();

  if (!org || (org.fetchedAt === null && !org.workspaces.length && !placed.projects.length)) {
    return (
      <div className="pl-5 text-[11px] text-faint" data-testid="cloud-org-loading">
        {org?.error ? `Cloud workspaces are unavailable (${org.error}).` : "Loading cloud workspaces…"}
      </div>
    );
  }
  // Unread or Needs you: only the projects with such a session, and no archive (nothing archived runs or answers).
  if (filter.active) {
    const projects = placed.projects.filter((project) => filter.showsProject(project.key));
    if (!projects.length) {
      return (
        <div className="pl-5 text-[11px] text-faint" data-testid="cloud-org-filtered-empty">
          {filter.empty}
        </div>
      );
    }
    return (
      <>
        {projects.map((project) => (
          <CloudProjectNode key={project.key} project={project} onLifecycle={onLifecycle} />
        ))}
      </>
    );
  }
  const empty = !placed.projects.length && !placed.archived.length;
  return (
    <>
      {empty && (
        <div className="pl-5 text-[11px] text-faint" data-testid="cloud-org-empty">
          {emptyOrgText(mayCreate)}
        </div>
      )}
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
            <p className="px-1.5 pb-1 text-[10px] leading-snug text-faint" data-testid="cloud-archived-note">
              Stopped and kept until their deadline, then deleted automatically. Storage keeps billing at the provider until then.
            </p>
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
  const { status } = useAccount();
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const filter = useSidebarFilter();
  // A filter shows what it found: the project is open while it is on.
  const expanded = filter.active || !prefs.cloudCollapsed[project.key];
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
  // Starting a session creates a workspace, resumes one, or adds a session to
  // a running one: the server keeps all three for owners and admins. Null
  // while this account's role is not known yet: nothing is offered until it is.
  const mayStart = mayStartCloudSessions(status, project.orgId);
  const startBlocked = !project.selected || mayStart !== true;
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
        // The row is one button, so its own tooltip names the extra repositories of its only workspace.
        title={[project.blank ? `${project.fullName} · no repository` : project.identity, !grouped && project.workspaces[0] ? extraRepositories(project.workspaces[0].item)?.card : null].filter(Boolean).join("\n")}
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
          {/* One workspace has no row of its own: its extra repositories show here. */}
          {!grouped && project.workspaces[0] && <ExtraRepositoriesChip item={project.workspaces[0].item} plain />}
          {project.blank && <RowChip>no repo</RowChip>}
          {!project.selected && <RowChip>not accessible</RowChip>}
        </button>
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
            <DropdownMenuContent align="end" className="w-[17rem]">
              <DropdownMenuItem onSelect={() => startNewCloudSession(project.key)} disabled={startBlocked} title={mayStart === false ? NEW_SESSION_ADMIN_REASON : undefined}>
                <Plus /> New session
                {mayStart === false && <span className="ml-auto pl-3 text-[10px] text-faint">admins only</span>}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => updateOrgList("cloudPinned", project.orgId, (list) => (project.pinned ? list.filter((id) => id !== project.identity) : [...list, project.identity]))}
              >
                {project.pinned ? <PinOff /> : <Pin />} {project.pinned ? "Unpin project" : "Pin project"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void refreshCloudWorkspaces(project.orgId)}>
                <RefreshCw /> Refresh
              </DropdownMenuItem>
              {/* The organization's report, for its owners and admins; one workspace is marked when the project has just one. */}
              {offersCloudDiagnostics(status, project.orgId) && <CloudDiagnosticsMenuItem onSelect={() => setDiagnostics(true)} />}
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
      {diagnostics && (
        <CloudDiagnosticsDialog
          request={{ orgId: project.orgId, workspaceId: project.workspaces.length === 1 ? project.workspaces[0].item.workspace.id : null }}
          onClose={() => setDiagnostics(false)}
        />
      )}
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
  // How far a delete is, or why it stopped.
  const deleting = deletionLine(item);
  if (deleting) lines.push(deleting);
  const repositories = (workspace.repositories ?? []).map((repository) => repository.fullName ?? repository.identity).filter(Boolean);
  if (repositories.length) lines.push(`Repositories: ${repositories.join(", ")}`);
  lines.push(`Access: ${workspace.accessMode === "organization" ? "organization" : "private"}`);
  return [...new Set(lines)].join("\n");
}

/**
 * `+N repo` for a workspace with more checkouts than the repository it is
 * listed under (its primary one, S1 `repositories`); the tooltip names them.
 * Nothing on a server that does not report repositories.
 */
/** The other repositories a workspace checks out, and the sentence naming them; null when there are none or this person may not know. */
function extraRepositories(item: CloudWorkspaceListItem): { label: string; card: string } | null {
  // Someone the workspace is not shared with learns nothing of what is in it.
  if (item.workspace.you?.role === "none") return null;
  const repositories = item.workspace.repositories ?? [];
  const extra = repositories.filter((repository, index) => (repositories.some((each) => each.primary) ? !repository.primary : index > 0));
  if (!extra.length) return null;
  const names = extra.map((repository) => repository.fullName ?? repository.identity ?? "a repository no longer selected");
  return { label: `+${extra.length} ${extra.length === 1 ? "repo" : "repos"}`, card: `${item.workspace.name} also checks out ${names.join(", ")}` };
}

/**
 * A chip whose explanation is a tooltip: it can be hovered and takes the
 * keyboard focus, so the tooltip is reachable either way, and it never gives
 * way to the row's actions (a chip that hides on hover has a tooltip nobody
 * can open).
 */
function InfoChip({ card, className, children, ...rest }: { card: string; className?: string; children: string } & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <WithTooltip label={card.replace(/\n/g, " · ")}>
      <span tabIndex={0} role="note" aria-label={`${children}. ${card}`} className={cn("shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40", className)} {...rest}>
        <RowChip>{children}</RowChip>
      </span>
    </WithTooltip>
  );
}

/**
 * `+N repo` on a workspace's own row. Inside a project row (which is one
 * button) the plain chip is used instead and the row's tooltip names them.
 */
function ExtraRepositoriesChip({ item, plain = false }: { item: CloudWorkspaceListItem; plain?: boolean }) {
  const extra = extraRepositories(item);
  if (!extra) return null;
  if (plain) {
    return (
      <span className="shrink-0" data-testid="cloud-extra-repositories">
        <RowChip>{extra.label}</RowChip>
      </span>
    );
  }
  return (
    <InfoChip card={extra.card} data-testid="cloud-extra-repositories">
      {extra.label}
    </InfoChip>
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

/** One workspace as a group row, when its project has more than one. */
function WorkspaceGroupNode({ node, expanded: projectExpanded, onLifecycle }: { node: CloudWorkspaceNode; expanded: boolean; onLifecycle: (dialog: Dialog) => void }) {
  const store = useSessionStore();
  const [expanded, setExpanded] = useState(true);
  const menu = useRowMenu();
  const [error, setError] = useState<string | null>(null);
  const { workspace } = node.item;
  const selected = store.selectedCloudWorkspace === node.key;
  const filter = useSidebarFilter();
  // A filter shows what it found: the workspace is open while it is on.
  const open = expanded || filter.active;
  const shown = projectExpanded && open;
  const { sessions, known } = useCloudWorkspaceSessions(node, { load: shown, showArchived: store.showArchived, selectedKey: store.selectedSessionId });
  const activity = useWorkspaceActivity(node, sessions, !known || sessions.every((row) => row.source !== "live"));
  // Filtered: a workspace with no such session has no row, unless the server's list alone says it waits for a person.
  const filteredOut = filter.active && !sessions.some((row) => filter.shows(row.key)) && !filter.showsWorkspace(node.key);
  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(lifecycleErrorMessage(errorCode(e)));
    }
  };
  const branch = workspace.launch?.workBranch ?? null;
  if (filteredOut) return null;
  return (
    <div role="treeitem" aria-label={workspace.name} aria-expanded={open} aria-selected={selected} className="min-w-0" data-testid="cloud-workspace-node" data-workspace={workspace.id} onClickCapture={focusClicked}>
      <TreeRow level="group" selected={selected} title={workspaceCard(node.item, activity)}>
        <TreeToggle expanded={open} label={workspace.name} onToggle={() => setExpanded((current) => !current)} className="ml-0.5" />
        <Cloud className="size-3 shrink-0" aria-label="Cloud workspace" />
        <button type="button" onClick={() => selectCloudWorkspace(node.key)} className="min-w-0 flex-1 truncate rounded-sm text-left font-mono text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          {workspace.name}
        </button>
        {branch && (
          <span className={cn("min-w-0", yieldsToRowActions)} title="This workspace's own branch" data-testid="cloud-workspace-row-branch">
            <RowChip mono>{branch}</RowChip>
          </span>
        )}
        <ExtraRepositoriesChip item={node.item} />
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
      {deletionLine(node.item) && (
        <p className={cn("ml-6 text-[10px]", deletion(node.item) === "failed" ? "whitespace-normal break-words text-destructive" : "text-faint")} data-testid="cloud-workspace-row-deletion">
          {deletionLine(node.item)}
        </p>
      )}
      <TreeGroup expanded={open} className="pl-2">
        <WorkspaceSessions node={node} shown={shown} showLocation={false} />
      </TreeGroup>
    </div>
  );
}

/** A workspace's sessions, straight under the project (or under its group row). */
function WorkspaceSessions({ node, shown, showLocation }: { node: CloudWorkspaceNode; shown: boolean; showLocation: boolean }) {
  const store = useSessionStore();
  const { sessions: every, capabilities, manage: manages, known } = useCloudWorkspaceSessions(node, { load: shown, showArchived: store.showArchived, selectedKey: store.selectedSessionId });
  const filter = useSidebarFilter();
  const sessions = useMemo(() => {
    if (!filter.active) return every;
    const found = every.filter((row) => filter.shows(row.key));
    // The list says this workspace waits for a person, and no session known here says which: all of them show
    // (or, for one never opened on this desktop, the line that opens it).
    return !found.length && filter.showsWorkspace(node.key) ? every : found;
  }, [every, filter, node.key]);
  const activity = useWorkspaceActivity(node, every, every.every((row) => row.source !== "live"));
  const card = workspaceCard(node.item, activity);
  const connection = useCloudConnection(node.key);
  // What this desktop may do here: the attach result's authority once it has
  // connected, else what the list says opening would grant (§20.1). A
  // participant is refused session changes, so it is not offered them; an
  // older server that says neither keeps the menu.
  const authority = connection.authority ?? node.item.workspace.authority ?? null;
  // Both rules hold: the attachment's authority (above), and on a shared
  // workspace the manager role (PRO-30): session/2 refuses anyone else, a
  // demoted admin's lingering manage attachment included.
  const manage = manages && !!capabilities?.includes("session/2") && (authority === null || authority === "manage");
  const { state } = node.item.workspace;
  // Filtered: only the sessions found; no placeholder line and no workspace terminals.
  if (filter.active && !sessions.length && !filter.showsWorkspace(node.key)) return null;
  if (!sessions.length) {
    const openable = (state === "ready" || state === "suspended") && activity.tone !== "changing" && activity.tone !== "attention";
    return (
      <>
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
        <WorkspaceTerminals node={node} sessionIds={[]} />
      </>
    );
  }
  return (
    <>
      {sessions.map((row) => (
        <CloudSessionNode key={row.key} row={row} node={node} manage={manage} location={showLocation ? { tone: activity.tone, card } : null} />
      ))}
      {!filter.active && <WorkspaceTerminals node={node} sessionIds={sessions.map((row) => row.sessionId)} />}
    </>
  );
}

/** Asks first: closing a live terminal ends its shell on the VM for everyone. */
async function closeTerminalRow(node: CloudWorkspaceNode, terminal: CloudTerminal): Promise<void> {
  if (!terminal.gone && !terminal.exited) {
    const yes = await ask(`Close ${terminal.title}? Its shell ends on the cloud workspace.`, { title: "Close terminal", kind: "warning", okLabel: "Close", cancelLabel: "Cancel" }).catch(() => false);
    if (!yes) return;
  }
  await closeCloudWorkspaceTerminal({ orgId: node.item.workspace.orgId, workspaceId: node.item.workspace.id }, terminal.id);
}

/**
 * Terminals of a workspace that belong to none of its sessions: all of them on
 * a runtime older than `pty/2`, which does not say which session a terminal
 * was opened for. Listed once per workspace; choosing one opens the workspace
 * view on that terminal. Only terminals this window has seen (it connected to
 * the workspace) are known, so nothing here connects or wakes anything.
 */
function WorkspaceTerminals({ node, sessionIds }: { node: CloudWorkspaceNode; sessionIds: string[] }) {
  const store = useSessionStore();
  const state = useCloudTerminals(node.key);
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const terminals = workspaceTerminals(state.terminals, sessionIds);
  // Not shared with this person: no terminal of it is listed, whatever this window still holds.
  if (!terminals.length || node.item.workspace.you?.role === "none") return null;
  const showing = store.selectedCloudWorkspace === node.key && !!state.shown;
  return (
    <div role="treeitem" aria-label="Workspace terminals" aria-expanded={expanded} className="min-w-0" data-testid="cloud-workspace-terminals" data-workspace={node.item.workspace.id} onClickCapture={focusClicked}>
      <TreeRow level="group" selected={false} title={`Terminals of ${node.item.workspace.name} that belong to no session`}>
        <TreeToggle expanded={expanded} label="Workspace terminals" onToggle={() => setExpanded((open) => !open)} className="ml-0.5" />
        <Terminal className="size-3 shrink-0" aria-hidden />
        <button type="button" onClick={() => setExpanded((open) => !open)} className="min-w-0 flex-1 truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          Workspace terminals
        </button>
      </TreeRow>
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
      <TreeGroup expanded={expanded} className="pl-5">
        {terminals.map((terminal) => (
          <ShellTabRow
            key={terminal.id}
            nodeId={`cloud-terminal-${node.item.workspace.id}-${terminal.ptyId}`}
            panelId={`cloud-terminal-panel-${node.item.workspace.id}-${terminal.ptyId}`}
            title={terminal.title}
            exited={terminal.exited || !!terminal.gone}
            selected={showing && state.selected === terminal.id}
            onOpen={() => {
              selectCloudWorkspace(node.key);
              revealCloudTerminal(node.key, terminal.id);
            }}
            onClose={() => {
              setError(null);
              void closeTerminalRow(node, terminal).catch((e: unknown) => setError(errorMessage(e)));
            }}
          />
        ))}
      </TreeGroup>
    </div>
  );
}

/** A session title keeps this many leading characters before its row's chips stop shrinking. */
const TITLE_FLOOR = 12;

/**
 * Where a session runs: a small chip, with the workspace's hover card. It is
 * the first thing in the row to give way to the title: the name truncates,
 * then leaves the state dot and the cloud icon (the tooltip still names it).
 */
function LocationChip({ name, tone, card }: { name: string; tone: RowTone; card: string }) {
  return (
    <span
      className={cn(
        // One line high; a name with no room left for even its ellipsis wraps out of sight.
        "flex h-3.5 max-w-24 min-w-[26px] shrink flex-wrap content-start items-center gap-x-1 overflow-hidden whitespace-nowrap rounded-sm bg-veil-raised px-1 text-[9px] leading-[14px] text-faint",
        yieldsToRowActions,
      )}
      title={card}
      data-testid="cloud-location-chip"
    >
      <span aria-hidden className={cn("size-1 shrink-0 rounded-full", DOT[tone])} />
      <Cloud className="size-2.5 shrink-0" aria-label="Runs in the cloud" />
      <span className="min-w-[9px] grow basis-0 truncate">{name}</span>
    </span>
  );
}

/**
 * The lock chip ("View only", "Not shared") in a session row marked tight:
 * its label is cut off whole and the lock stays, with the chip's tooltip.
 */
const LOCK_CHIP_IN_TIGHT_ROW = "[&>svg]:shrink-0 group-data-[tight]/session:w-[18px] group-data-[tight]/session:overflow-hidden group-data-[tight]/session:whitespace-nowrap";

/**
 * Marks a session row `data-tight` when its title, at its floor of
 * {@link TITLE_FLOOR} characters, would not fit beside the location chip at
 * its smallest and the lock chip at full size. The lock chip then shows its
 * icon only. Every width asked for here is the same whether or not the row is
 * marked, so the mark never flips back and forth.
 */
function useTightRow(...deps: unknown[]) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = host.current;
    const line = node?.querySelector<HTMLElement>("[data-tree-row]");
    if (!node || !line || typeof ResizeObserver === "undefined") return;
    const check = () => {
      const row = getComputedStyle(line);
      const room = line.clientWidth - parseFloat(row.paddingLeft) - parseFloat(row.paddingRight);
      if (!(room > 0)) return;
      let wanted = 0;
      let parts = 0;
      for (const child of Array.from(line.children) as HTMLElement[]) {
        const style = getComputedStyle(child);
        if (style.position === "absolute" || style.display === "none") continue;
        parts++;
        if (child.dataset.testid === "cloud-access-chip") wanted += child.scrollWidth;
        else if (child.dataset.testid === "cloud-location-chip") wanted += parseFloat(style.minWidth) || 0;
        else if (child.style.minWidth) wanted += parseFloat(child.style.minWidth);
        else wanted += child.getBoundingClientRect().width;
      }
      wanted += Math.max(0, parts - 1) * (parseFloat(row.columnGap) || 0);
      node.toggleAttribute("data-tight", wanted > room + 0.5);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(line);
    // The title's floor is measured again once the fonts are in.
    let live = true;
    void document.fonts?.ready.then(() => live && check());
    return () => {
      live = false;
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return host;
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
  const you = node.item.workspace.you;
  const locked = you?.role === "viewer" || you?.role === "none";
  const tight = useTightRow(row.title, row.pinned, row.archived, row.modified, locked, node.item.workspace.sharedWith, !!location, renaming);
  const closeTab = async (tabId: string, label: string) => {
    const yes = await ask(`Close ${label}? Its agent stops on the cloud workspace.`, { title: "Close tab", kind: "warning", okLabel: "Close", cancelLabel: "Cancel" }).catch(() => false);
    if (yes) await act(() => closeCloudSessionTab(row, tabId));
  };
  // Its terminals, as this window knows them: listed once it has connected to
  // the workspace, and kept current while it stays connected.
  // None under a workspace that is not shared with this person (the row then opens the lock pane).
  const known = useCloudTerminals(node.key).terminals;
  const terminals = you?.role === "none" ? [] : sessionTerminals(known, row.sessionId);
  // The row that is marked is the tab the open session shows; before its view
  // has said, the same rule the view uses.
  const requested = useTerminals().selected[row.key];
  const visible = useVisibleSessionTab(row.key);
  const shown = selected
    ? (visible ?? resolveSessionTab({ requested, agentIds: row.tabs.map((tab) => tab.tabId), activeTab: row.activeTab, terminalIds: terminals.map((terminal) => terminal.id) }))
    : null;
  /** A tab row opens its session on that tab. */
  const open = (tab: { kind: "agent" | "terminal"; id: string }) => {
    selectSessionTab(row.key, tab);
    selectCloudSession(row.key);
  };

  return (
    <div ref={tight} role="none" className="group/session" data-testid="cloud-session-node" data-session={row.key} onClickCapture={focusClicked}>
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
            <ItemTitle title={row.title} pinned={row.pinned} archived={row.archived} minChars={TITLE_FLOOR} onActivate={() => selectCloudSession(row.key)} />
          )}
          {location && <ShareBadge you={you} sharedWith={node.item.workspace.sharedWith} className={cn(locked && LOCK_CHIP_IN_TIGHT_ROW, yieldsToRowActions)} />}
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
            const label = tab.title?.trim() || cloudAgentLabel(tab.harness);
            const peer = { kind: "agent" as const, id: tab.tabId };
            return (
              <AgentTabRow
                key={tab.tabId}
                // The open session's panels are labelled by these rows; other sessions' rows only need unique ids.
                nodeId={selected ? tabNodeId(peer) : `cloud-tab-${row.workspaceId}-${tab.tabId}`}
                panelId={selected ? tabPanelId(peer) : `cloud-panel-${row.workspaceId}-${tab.tabId}`}
                harness={tab.harness}
                label={label}
                status={tab.status}
                mobileDriven={false}
                terminalView={false}
                selected={shown?.kind === "agent" && shown.id === tab.tabId}
                onOpen={() => open(peer)}
                // Closing a tab stops its agent: a workspace manager's, like the session menu.
                onClose={manage ? () => void closeTab(tab.tabId, label) : undefined}
              />
            );
          })}
          {terminals.map((terminal) => {
            const peer = { kind: "terminal" as const, id: terminal.id };
            return (
              <ShellTabRow
                key={terminal.id}
                nodeId={selected ? tabNodeId(peer) : `cloud-terminal-${row.workspaceId}-${terminal.ptyId}`}
                panelId={selected ? tabPanelId(peer) : `cloud-terminal-panel-${row.workspaceId}-${terminal.ptyId}`}
                title={terminal.title}
                exited={terminal.exited || !!terminal.gone}
                selected={shown?.kind === "terminal" && shown.id === terminal.id}
                onOpen={() => open(peer)}
                // Killing a terminal is a workspace manager's too.
                onClose={manage ? () => void act(() => closeTerminalRow(node, terminal)) : undefined}
              />
            );
          })}
          {row.tabs.length === 0 && terminals.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-faint">{node.item.workspace.you?.role === "none" ? "Not shared with you." : "No tabs."}</div>
          ) : null}
        </TreeGroup>
      </TreeNode>
    </div>
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

function ArchivedWorkspaceRow({ node, onLifecycle }: { node: CloudWorkspaceNode; onLifecycle: (dialog: Dialog) => void }) {
  const store = useSessionStore();
  const { item, key } = node;
  const { workspace } = item;
  const [error, setError] = useState<string | null>(null);
  const menu = useRowMenu();
  const state = deriveCloudActivity(item);
  const selected = store.selectedCloudWorkspace === key;
  const text = archivedRowText(item);
  // Reading is for anyone the workspace is shared with; it connects without waking, and an archived machine is never started by it.
  const readable = workspace.state === "archived" && !deletion(item) && workspace.you?.role !== "none";
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
      <TreeRow level="item" selected={selected} title={[describeWorkspace(item), text.line, text.saved].filter(Boolean).join("\n")}>
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
          <span className={cn("pl-4 text-[10px] text-faint", text.failed ? "whitespace-normal break-words text-destructive" : "truncate")} data-testid="cloud-archive-deadline">
            {text.line}
          </span>
          {text.saved && (
            <span className="truncate pl-4 text-[10px] text-faint" data-testid="cloud-archive-saved">
              {text.saved}
            </span>
          )}
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
              {readable && (
                <DropdownMenuItem onSelect={() => selectCloudWorkspace(key)} title="Read saved agent conversations; nothing is started" data-testid="cloud-read-conversations">
                  <BookOpen /> Read conversations
                </DropdownMenuItem>
              )}
              <WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} archived />
            </DropdownMenuContent>
          </DropdownMenu>
        </RowActions>
      </TreeRow>
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
    </div>
  );
}
