import { useMemo, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Cloud, Ellipsis, FolderGit2, GitBranch, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { RowActions, actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { RowChip, TreeGroup, TreeNode, TreeRow, TreeToggle } from "@/components/layout/SidebarRows";
import { CloudWorkspaceLifecycleDialog, actionsFor, archiveLine, type LifecycleAction } from "@/components/cloud/CloudWorkspaceLifecycle";
import { describeWorkspace } from "@/components/cloud/CloudSessionPage";
import { api, errorMessage, type CloudWorkspaceListItem, type OrganizationSummary } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import {
  cloudOrganizations,
  defaultOrgId,
  placeCloudProjects,
  refreshCloudCatalog,
  resumeCloudWorkspace,
  unarchiveCloudWorkspace,
  useCloudCatalog,
  type OrgCatalog,
} from "@/lib/cloudCatalog";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { errorCode } from "@/lib/cloudTerminals";
import { cn } from "@/lib/cn";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { selectCloudWorkspace, useSessionStore } from "@/lib/sessions";
import { orgSectionKey, type CloudProject, type CloudWorkspaceNode } from "@/types/target";
import { workspaceRowState, type RowTone } from "./rowState";

/**
 * Organization sections of the sidebar (PRO-23 CS-5): one per organization
 * with cloud workspaces enabled, the default organization first. The default
 * organization lists its cloud projects (repositories) and workspaces from
 * the cloud catalog; the others offer to switch until every organization can
 * be listed at once (CS-18).
 *
 * Looking never costs money: rendering and expanding read the catalog only,
 * and selecting a workspace shows it without resuming it.
 */

/** Organizations with a section, default first then by name; none while signed out, with no cloud-enabled organization, or with the kill switch off. */
export function useCloudSections(): { orgs: OrganizationSummary[]; defaultOrg: string | null } {
  const { status } = useAccount();
  const { cloudSidebar } = usePrefs();
  return useMemo(() => {
    if (!cloudSidebar) return { orgs: [], defaultOrg: null };
    const orgs = cloudOrganizations(status);
    const defaultOrg = defaultOrgId(status);
    const sorted = [...orgs].sort((a, b) => Number(b.id === defaultOrg) - Number(a.id === defaultOrg) || sectionName(a).localeCompare(sectionName(b)));
    return { orgs: sorted, defaultOrg };
  }, [status, cloudSidebar]);
}

function sectionName(org: OrganizationSummary): string {
  return org.isPersonal ? "Personal" : org.name;
}

export function useSectionCollapsed(key: string): [boolean, () => void] {
  const { collapsedSidebarSections } = usePrefs();
  const collapsed = collapsedSidebarSections.includes(key);
  return [
    collapsed,
    () => setPrefs({ collapsedSidebarSections: collapsed ? collapsedSidebarSections.filter((item) => item !== key) : [...collapsedSidebarSections, key] }),
  ];
}

type Dialog = { item: CloudWorkspaceListItem; action: LifecycleAction };

export function CloudSections({ onOpenCloudPage }: { onOpenCloudPage?: () => void }) {
  const { orgs, defaultOrg } = useCloudSections();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  if (!orgs.length) return null;
  return (
    <>
      {orgs.map((org) => (
        <OrgSection key={org.id} org={org} isDefault={org.id === defaultOrg} onLifecycle={setDialog} onOpenCloudPage={onOpenCloudPage} />
      ))}
      {dialog && (
        <CloudWorkspaceLifecycleDialog
          item={dialog.item}
          initial={dialog.action}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refreshCloudCatalog();
          }}
          onExport={() => {
            const { item } = dialog;
            setDialog(null);
            selectCloudWorkspace(`cloud:${item.workspace.orgId}:${item.workspace.id}`);
          }}
        />
      )}
    </>
  );
}

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function OrgSection({
  org,
  isDefault,
  onLifecycle,
  onOpenCloudPage,
}: {
  org: OrganizationSummary;
  isDefault: boolean;
  onLifecycle: (dialog: Dialog) => void;
  onOpenCloudPage?: () => void;
}) {
  const catalog = useCloudCatalog();
  const { status } = useAccount();
  const [collapsed, toggle] = useSectionCollapsed(orgSectionKey(org.id));
  const [switchError, setSwitchError] = useState<string | null>(null);
  const cached = catalog.orgs[org.id];
  const name = sectionName(org);
  const offline = isDefault && !!cached?.error && cached.fetchedAt !== null;

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
    <div role="treeitem" aria-label={`${name} organization`} aria-expanded={!collapsed} className="mt-3 min-w-0" data-testid="cloud-org-section" data-org={org.id}>
      <div data-tree-row className={cn(actionRow, "relative flex h-7 min-w-0 items-center gap-1 rounded-md pr-1")}>
        <TreeToggle expanded={!collapsed} label={`${name} organization`} onToggle={toggle} />
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          title={org.isPersonal ? `${org.name} (personal)` : org.name}
        >
          <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wide text-faint">{name}</span>
          <span className={cn("shrink-0 text-[10px] text-faint/80", yieldsToRowActions)}>{org.role}</span>
        </button>
        {isDefault && (
          <RowActions>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Menu for ${name}`}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void refreshCloudCatalog(org.id)}>
                  <RefreshCw /> Refresh cloud workspaces
                </DropdownMenuItem>
                {onOpenCloudPage && (
                  <DropdownMenuItem onSelect={onOpenCloudPage}>
                    <Plus /> New cloud workspace…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </RowActions>
        )}
      </div>
      {offline && (
        <div className="pl-5 text-[10px] text-faint" data-testid="cloud-org-offline" title={cached!.error ?? undefined}>
          Offline · last known {timeText(cached!.fetchedAt!)}
        </div>
      )}
      <TreeGroup expanded={!collapsed} className={cn("min-w-0", offline && "opacity-70")}>
        {isDefault ? (
          <DefaultOrgTree org={cached} orgId={org.id} onLifecycle={onLifecycle} />
        ) : (
          <div className="flex flex-col gap-0.5 pl-5 pr-1">
            <button
              type="button"
              onClick={() => void switchOrg()}
              className="w-full truncate rounded-md px-1 py-1 text-left text-[11px] text-muted-foreground outline-none hover:bg-selected/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              data-testid="cloud-org-switch"
            >
              Switch to show cloud sessions
            </button>
            {switchError && <span className="px-1 text-[10px] text-destructive">{switchError}</span>}
          </div>
        )}
      </TreeGroup>
    </div>
  );
}

function DefaultOrgTree({ org, orgId, onLifecycle }: { org: OrgCatalog | undefined; orgId: string; onLifecycle: (dialog: Dialog) => void }) {
  const catalog = useCloudCatalog();
  const placed = useMemo(
    () => placeCloudProjects(org ?? { orgId, workspaces: [], repositories: null }, catalog.createMemory),
    [org, orgId, catalog.createMemory],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const isExpanded = (key: string, byDefault: boolean) => (expanded.has(key) ? !byDefault : byDefault);
  const flip = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!org || (org.fetchedAt === null && !org.workspaces.length)) {
    return (
      <div className="pl-5 text-[11px] text-faint" data-testid="cloud-org-loading">
        {org?.error ? `Cloud workspaces are unavailable (${org.error}).` : "Loading cloud workspaces…"}
      </div>
    );
  }
  const empty = !placed.projects.length && !placed.other.length && !placed.archived.length;
  return (
    <>
      {empty && <div className="pl-5 text-[11px] text-faint">No cloud workspaces yet.</div>}
      {placed.projects.map((project) => (
        <CloudProjectNode
          key={project.key}
          project={project}
          expanded={isExpanded(project.key, project.workspaces.length > 0)}
          onToggle={() => flip(project.key)}
          onLifecycle={onLifecycle}
        />
      ))}
      {placed.more.length > 0 && (
        <CloudGroupNode id={`${orgId}:more`} label={`More repositories (${placed.more.length})`} expanded={isExpanded(`${orgId}:more`, false)} onToggle={() => flip(`${orgId}:more`)}>
          {placed.more.map((project) => (
            <CloudProjectNode key={project.key} project={project} expanded={false} onToggle={() => undefined} onLifecycle={onLifecycle} />
          ))}
        </CloudGroupNode>
      )}
      {placed.other.length > 0 && (
        <CloudGroupNode
          id={`${orgId}:other`}
          label={`Other workspaces (${placed.other.length})`}
          hint="No repository, or not known yet"
          expanded={isExpanded(`${orgId}:other`, false)}
          onToggle={() => flip(`${orgId}:other`)}
        >
          {placed.other.map((node) => (
            <CloudWorkspaceRow key={node.key} node={node} onLifecycle={onLifecycle} />
          ))}
        </CloudGroupNode>
      )}
      {placed.archived.length > 0 && (
        <CloudGroupNode
          id={`${orgId}:archived`}
          label={`Archived workspaces (${placed.archived.length})`}
          hint="Stopped, and deleted after their deadline"
          expanded={isExpanded(`${orgId}:archived`, false)}
          onToggle={() => flip(`${orgId}:archived`)}
        >
          {placed.archived.map((node) => (
            <CloudWorkspaceRow key={node.key} node={node} onLifecycle={onLifecycle} archived />
          ))}
        </CloudGroupNode>
      )}
    </>
  );
}

function CloudProjectNode({
  project,
  expanded,
  onToggle,
  onLifecycle,
}: {
  project: CloudProject;
  expanded: boolean;
  onToggle: () => void;
  onLifecycle: (dialog: Dialog) => void;
}) {
  const hasWorkspaces = project.workspaces.length > 0;
  return (
    <TreeNode label={project.fullName} expanded={hasWorkspaces && expanded}>
      <div data-tree-row className={cn(actionRow, "relative flex h-8 min-w-0 items-center gap-1 rounded-md px-1 hover:bg-selected/50")} title={project.identity} data-testid="cloud-project-row">
        {hasWorkspaces ? (
          <TreeToggle expanded={expanded} label={project.fullName} onToggle={onToggle} />
        ) : (
          <span aria-hidden className="w-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px]">{project.fullName}</span>
          {!project.selected && <RowChip>not accessible</RowChip>}
          {!hasWorkspaces && <span className="shrink-0 text-[10px] text-faint">no workspaces yet</span>}
        </button>
      </div>
      {hasWorkspaces && (
        <TreeGroup expanded={expanded} className="pb-1 pl-2">
          {project.workspaces.map((node) => (
            <CloudWorkspaceRow key={node.key} node={node} onLifecycle={onLifecycle} />
          ))}
        </TreeGroup>
      )}
    </TreeNode>
  );
}

function CloudGroupNode({ id, label, hint, expanded, onToggle, children }: { id: string; label: string; hint?: string; expanded: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <TreeNode label={label} expanded={expanded}>
      <div data-tree-row className="relative flex h-7 min-w-0 items-center gap-1 rounded-md px-1 text-muted-foreground hover:bg-selected/50" data-testid={`cloud-node-${id.split(":").pop()}`} title={hint}>
        <TreeToggle expanded={expanded} label={label} onToggle={onToggle} />
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 truncate rounded-sm text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          {label}
        </button>
      </div>
      <TreeGroup expanded={expanded} className="pb-1 pl-2">
        {children}
      </TreeGroup>
    </TreeNode>
  );
}

const TONE: Record<RowTone, string> = {
  ready: "bg-add",
  stopped: "bg-faint",
  changing: "bg-info animate-pulse-soft",
  attention: "bg-destructive",
  archived: "bg-faint/60",
};

function CloudWorkspaceRow({ node, onLifecycle, archived = false }: { node: CloudWorkspaceNode; onLifecycle: (dialog: Dialog) => void; archived?: boolean }) {
  const store = useSessionStore();
  const { item, key } = node;
  const { workspace } = item;
  const [error, setError] = useState<string | null>(null);
  const state = workspaceRowState(item);
  const selected = store.selectedCloudWorkspace === key;
  const actions = actionsFor(item);
  const busy = state.tone === "changing";
  const branch = workspace.launch?.workBranch ?? null;
  const extra = Math.max(0, (workspace.repositories?.length ?? 0) - 1);

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
        <span aria-hidden className={cn("ml-1.5 size-1.5 shrink-0 rounded-full", TONE[state.tone])} />
        <button
          type="button"
          onClick={() => selectCloudWorkspace(key)}
          className="flex min-w-0 flex-1 flex-col items-stretch rounded-sm py-1 pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="flex min-w-0 items-center gap-1">
            <Cloud className="size-3 shrink-0 text-faint" aria-label="Cloud workspace" />
            <span className="min-w-0 flex-1 truncate text-[12px]">{workspace.name}</span>
            {extra > 0 && <RowChip>+{extra} repo</RowChip>}
            <span className={cn("shrink-0 text-[10px] text-faint", state.tone === "attention" && "text-destructive", yieldsToRowActions)} data-testid="cloud-workspace-row-state">
              {state.label}
            </span>
          </span>
          {archived ? (
            <span className="truncate pl-4 text-[10px] text-faint">{archiveLine(item)}</span>
          ) : branch ? (
            <span className="flex min-w-0 items-center gap-1 pl-4 font-mono text-[10px] text-faint" title="This workspace's own branch">
              <GitBranch className="size-2.5 shrink-0" />
              <span className="min-w-0 truncate" data-testid="cloud-workspace-row-branch">
                {branch}
              </span>
            </span>
          ) : null}
        </button>
        <RowActions>
          <DropdownMenu>
            <WithTooltip label="Workspace actions">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${workspace.name}`}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
            </WithTooltip>
            <DropdownMenuContent align="end" className="w-[17rem]">
              {workspace.state === "suspended" && !archived && (
                <DropdownMenuItem disabled={busy} onSelect={() => void run(() => resumeCloudWorkspace(item))}>
                  <Play /> Resume
                </DropdownMenuItem>
              )}
              {actions.includes("stop") && !archived && (
                <DropdownMenuItem disabled={busy} onSelect={() => onLifecycle({ item, action: "stop" })}>
                  <Pause /> Stop
                </DropdownMenuItem>
              )}
              {actions.includes("archive") && (
                <DropdownMenuItem disabled={busy} onSelect={() => onLifecycle({ item, action: "archive" })}>
                  <Archive /> {archived ? "Retry archive" : "Archive… (stops compute, deleted after 30 days)"}
                </DropdownMenuItem>
              )}
              {archived && (
                <DropdownMenuItem disabled={busy} onSelect={() => void run(() => unarchiveCloudWorkspace(item).then(() => refreshCloudCatalog()))}>
                  <ArchiveRestore /> Unarchive
                </DropdownMenuItem>
              )}
              {actions.includes("delete") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive disabled={state.label === "Deleting"} onSelect={() => onLifecycle({ item, action: "delete" })}>
                    <Trash2 /> Delete…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </RowActions>
      </TreeRow>
      {error && <p className="ml-6 text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

