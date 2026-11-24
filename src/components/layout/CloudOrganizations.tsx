import { CloudWorkspaceSections } from "./CloudWorkspaceSections";
import { OrgMark } from "./OrgMark";
import { cloudPresence } from "@/lib/cloudPresence";
import { OrganizationPresenceCount } from "./WorkspaceFollowingSection";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { PrivacyEmptyState } from "@/components/settings/DataPrivacySettings";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Check, Ellipsis, EyeOff, Folder, FolderGit2, FolderPlus, Loader2, Plus, RefreshCw, Settings, Trash2, X } from "@/icons";
import { openOrganizationSettings } from "@/lib/settingsLinks";
import { confirmInApp } from "@/lib/confirm";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { RowActions } from "@/components/layout/RowActions";
import { openNewCloudWorkspace } from "@/components/cloud/NewCloudWorkspaceDialog";
import { WorkspaceLifecycleDialog, type LifecycleRequest } from "@/components/cloud/WorkspaceActions";
import { cn } from "@/lib/cn";
import { api, errorMessage, type OrganizationSummary } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import { catalogErrorText, dismissCloudNotice, placeCloudProjects, refreshCloudWorkspaces, useCloudCatalog } from "@/lib/cloudCatalog";
import { NEW_SESSION_ADMIN_REASON, NEW_WORKSPACE_ADMIN_REASON } from "@/lib/cloudCollab";
import { purgeNoticeText } from "@/lib/cloudLifecycle";
import { bootCloudMirrors } from "@/lib/cloudMirror";
import { bootCloudSessions } from "@/lib/cloudSessions";
import {
  createCloudSection,
  discardCloudSectionDrafts,
  keepFocusForNameField,
  useCloudSidebarSections,
} from "@/lib/cloudSidebarSections";
import { mayStartCloudSessions } from "@/lib/multiOrg";
import { organizationName, organizationRunningCount, setOrganizationHidden, switchOrganization, useOrganizationVisibility } from "@/lib/organizationVisibility";
import { useOrganizationSwitchingEnabled } from "@/lib/organizationVisibilityGate";
import { setPrefs, usePrefs, type CloudSidebarSection } from "@/lib/prefs";
import { bootCloudPins, useCloudPins, useCloudPinsError } from "@/lib/cloudPins";
import { workspaceUsage } from "@/lib/runningLimit";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { parseCloudWorkspaceKey, type CloudProject } from "@/types/target";
import { AddRepositoryDialog, NewBlankProjectDialog } from "./cloud/AddCloudProject";
import { ArchivedWorkspaces } from "./cloud/CloudProjectRows";
import { ListSection } from "./SessionSidebar";

/**
 * The cloud organizations under the local projects, drawn as the sidebar draws
 * projects: a section per organization, named after it, listing its cloud
 * projects (a repository with workspaces, or a blank project); each project
 * folds to its sessions, and a project with several workspaces names each
 * workspace over its sessions. `+` on a project starts a session there, as it
 * does on a local project.
 *
 * An organization's header carries its menu (refresh, a new section of the
 * reader's own, a new workspace, hide) and `+` to add a project; under it,
 * collapsed or not, whether its list is loading, failed or offline, with
 * Retry. The reader's own named sections group its projects (PRO-23); they
 * are this Mac's layout only. The sidebar's Unread / Needs you filter narrows
 * these as it does the local list.
 *
 * Looking costs nothing: everything here is read from the catalog and this
 * desktop's caches; nothing connects or wakes a workspace.
 */
export function CloudOrganizations({ onOpenOrganizations }: { onOpenOrganizations?: () => void }) {
  const privacy = useDataPrivacy();
  const { status } = useAccount();
  const draftScope = `${status.context?.account ?? status.identity?.email ?? ""}:${status.context?.scope ?? ""}:${status.state}`;
  useEffect(() => () => discardCloudSectionDrafts(), [draftScope, privacy.enabled]);
  const cloud = useOrganizationVisibility();
  const catalog = useCloudCatalog();
  const [dialog, setDialog] = useState<LifecycleRequest | null>(null);
  const [adding, setAdding] = useState<AddDialog | null>(null);
  // Live session lists follow the connections other surfaces open; a local mirror (PRO-25) too. Neither opens one.
  useEffect(() => bootCloudSessions(), []);
  useEffect(() => bootCloudMirrors(), []);
  if (privacy.enabled) return <PrivacyEmptyState />;
  if (!cloud.all.length && !cloud.orgs.length) return null;
  const hiddenRunning = cloud.hidden.reduce((count, org) => count + organizationRunningCount(org.id, catalog), 0);
  return (
    <>
      <PurgeNotices />
      {cloud.orgs.map((org) => (
        <OrganizationSection
          key={org.id}
          org={org}
          isDefault={org.id === cloud.defaultOrg}
          live={cloud.live.has(org.id)}
          temporary={org.id === cloud.temporaryOrganization}
          organizations={cloud.choices}
          selectedOrganization={cloud.selectedOrganization}
          onLifecycle={setDialog}
          onAdd={(kind) => setAdding({ orgId: org.id, orgName: sectionName(org), kind })}
        />
      ))}
      {cloud.hidden.length > 0 && (
        <button
          type="button"
          onClick={onOpenOrganizations}
          aria-label={`${cloud.hidden.length} organization${cloud.hidden.length === 1 ? "" : "s"} hidden${hiddenRunning ? `, ${hiddenRunning} running workspaces` : ""}`}
          className="mb-3 flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-2 text-left text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="hidden-organizations"
        >
          <EyeOff className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {cloud.hidden.length} organization{cloud.hidden.length === 1 ? "" : "s"} hidden
          </span>
          {hiddenRunning > 0 && (
            <span title={`${hiddenRunning} workspaces keep running and costing money`} className="ml-auto flex shrink-0 items-center gap-1 text-warning">
              <span className="size-1.5 rounded-full bg-warning" aria-hidden />
              {hiddenRunning} running
            </span>
          )}
        </button>
      )}
      {dialog && <WorkspaceLifecycleDialog request={dialog} onClose={() => setDialog(null)} />}
      {adding?.kind === "repository" && <AddRepositoryDialog orgId={adding.orgId} orgName={adding.orgName} onClose={() => setAdding(null)} />}
      {adding?.kind === "blank" && <NewBlankProjectDialog orgId={adding.orgId} orgName={adding.orgName} onClose={() => setAdding(null)} />}
    </>
  );
}

/** Whether the sidebar has an organization section, so the local projects are labelled "Local". */
export function useHasCloudOrganizations(): boolean {
  return useOrganizationVisibility().orgs.length > 0;
}

export function sectionName(org: OrganizationSummary): string {
  return organizationName(org);
}

/** What an organization with no cloud projects says: only someone who can create one is pointed at "+". */
export function emptyOrgText(mayCreate: boolean | null): string {
  if (mayCreate === true) return "No cloud projects yet. Add one with +.";
  // A member sees the workspaces shared with them, and cannot create one.
  if (mayCreate === false) return "No cloud projects shared with you yet.";
  return "No cloud projects yet.";
}

type AddDialog = { orgId: string; orgName: string; kind: "repository" | "blank" };

const HINT = "Its cloud sessions show when it is the default organization. Use Switch.";

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function OrganizationSection({
  org,
  isDefault,
  live,
  temporary,
  organizations,
  selectedOrganization,
  onLifecycle,
  onAdd,
}: {
  org: OrganizationSummary;
  isDefault: boolean;
  /** Its projects and sessions show and work (every cloud-enabled organization on a server that authorizes by membership; before it, the default one). */
  live: boolean;
  /** Shown only while one of its sessions is selected; the reader's choice to hide it is unchanged. */
  temporary: boolean;
  organizations: OrganizationSummary[];
  selectedOrganization: string | null;
  onLifecycle: (request: LifecycleRequest) => void;
  onAdd: (kind: AddDialog["kind"]) => void;
}) {
  const catalog = useCloudCatalog();
  const prefs = usePrefs();
  const switchingEnabled = useOrganizationSwitchingEnabled();
  const cloudEnabled = org.cloud?.enabled === true;
  const cloudPins = useCloudPins();
  const pinsError = useCloudPinsError();
  const store = useSessionStore();
  const { status } = useAccount();
  const filter = useSidebarFilter();
  const sections = useCloudSidebarSections(org.id);
  const sectionOwner = status.context?.account ?? status.identity?.email ?? null;
  useEffect(() => () => { if (sectionOwner) discardCloudSectionDrafts(org.id, sectionOwner); }, [org.id, sectionOwner]);
  const menu = useRowMenu();
  const addMenu = useRowMenu();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const name = sectionName(org);
  const cached = catalog.orgs[org.id];
  const placed = useMemo(
    () => placeCloudProjects(cached ?? { orgId: org.id, workspaces: [], repositories: null }, catalog.createMemory, { pinned: cloudPins[org.id], added: prefs.cloudProjects[org.id], blank: prefs.cloudBlankProjects[org.id] }),
    [cached, org.id, catalog.createMemory, cloudPins, prefs.cloudProjects, prefs.cloudBlankProjects],
  );
  // Creating a workspace is the API's owner-or-admin action, the same rule as
  // a project's "+": true for them, false for a member, null while this
  // account's role here is not known yet (nothing is offered until it is).
  const mayCreate = mayStartCloudSessions(status, org.id);
  // Never listed yet: loading, or failed with nothing to show.
  const unloaded = live && (!cached || (cached.fetchedAt === null && !cached.workspaces.length && !placed.projects.length));
  const offline = live && !!cached?.error && cached.fetchedAt !== null;
  // From the list this section already has; an older server sends none.
  const usage = live ? workspaceUsage(org.id, catalog) : null;
  const anyMenuOpen = menu.open || addMenu.open;

  const switchOrg = async () => {
    setSwitchError(null);
    const current = status.identity?.organization ?? "the current organization";
    const yes = await confirmInApp({
      title: `Switch the default organization to ${org.name}?`,
      body: `Cloud sessions open in ${current} will close.`,
      action: "Switch",
    });
    if (!yes) return;
    try {
      cloudPresence.leave();
      await api.organizationSelect(org.id, status.context?.revision ?? "");
      await refreshAccount();
    } catch (error) {
      setSwitchError(errorMessage(error));
    }
  };

  // The organization's row says it is the cloud and how many of its workspaces run; the tooltip has the limit where
  // the organization has one (PRO-371: only the count where it has none).
  const note = usage ? (
    <span
      className={cn("block min-w-0 truncate", usage.atLimit && "text-warning")}
      data-testid="cloud-org-quota"
      data-at-limit={usage.atLimit || undefined}
    >
      cloud · {usage.used} running
    </span>
  ) : cloudEnabled ? "cloud" : "Cloud workspaces unavailable";

  const actions = (
    <>
      {cloudEnabled && <OrganizationPresenceCount orgId={org.id} />}
      <RowActions persistent className={anyMenuOpen ? "not-sr-only" : undefined}>
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
        {/* Every member: the settings page itself limits what each role may change (#1286). */}
        <WithTooltip label={`Settings for ${name}`}>
          <Button variant="ghost" size="icon-xs" aria-label={`Settings for ${name}`} onClick={() => openOrganizationSettings(org.id)} data-testid="cloud-org-settings">
            <Settings />
          </Button>
        </WithTooltip>
        <DropdownMenu {...menu.root}>
          <DropdownMenuTrigger asChild {...menu.trigger}>
            <Button variant="ghost" size="icon-xs" aria-label={`Menu for ${name}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={keepFocusForNameField}>
            {live ? (
              <>
                <DropdownMenuItem onSelect={() => void refreshCloudWorkspaces(org.id)}>
                  <RefreshCw /> Refresh cloud workspaces
                </DropdownMenuItem>
                {/* The reader's own grouping of this organization's projects; it changes nothing for anyone else. */}
                <DropdownMenuItem onSelect={() => createCloudSection(org.id)} data-testid="cloud-new-section">
                  <FolderPlus /> New section
                </DropdownMenuItem>
                {/* The full form (several repositories, the provider) works in the default organization. */}
                {isDefault && mayCreate !== null && (
                  <DropdownMenuItem onSelect={() => openNewCloudWorkspace()} disabled={!mayCreate} title={mayCreate ? undefined : NEW_WORKSPACE_ADMIN_REASON} data-testid="cloud-new-workspace">
                    <Plus /> New cloud workspace…
                    {!mayCreate && <span className="ml-auto pl-3 text-[10px] text-faint">admins only</span>}
                  </DropdownMenuItem>
                )}
              </>
            ) : cloudEnabled && (
              <DropdownMenuItem onSelect={() => void switchOrg()}>
                <ArrowLeftRight /> Switch to show cloud sessions
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => openOrganizationSettings(org.id)} data-testid="cloud-org-settings-item">
              <Settings /> Organization settings…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {prefs.organizationDisplay === "one" ? (
              // One organization at a time: which one, chosen here; nothing changes on the server and nothing wakes.
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowLeftRight /> Organization in sidebar
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-[14rem]">
                  {organizations.map((choice) => (
                    <DropdownMenuItem
                      key={choice.id}
                      role="menuitemradio"
                      aria-checked={choice.id === selectedOrganization}
                      onSelect={() => {
                        if (switchingEnabled) {
                          switchOrganization(choice.id);
                          return;
                        }
                        setPrefs({ selectedOrganization: choice.id });
                        // Leaving an organization also leaves a session of it that was shown only while selected.
                        const selected = store.selectedSessionId ? parseCloudWorkspaceKey(store.selectedSessionId) : null;
                        if (selected && selected.orgId !== choice.id) selectSession(null);
                      }}
                    >
                      {choice.id === selectedOrganization ? <Check /> : <span aria-hidden className="size-4 shrink-0" />}
                      <span className="truncate">{sectionName(choice)}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem onSelect={() => void setOrganizationHidden(org.id, true)}>
                <EyeOff /> Hide organization
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </RowActions>
    </>
  );

  const notes = (
    <>
      {switchError && <p className="px-2 text-[11px] text-destructive">{switchError}</p>}
      {/* Unread, the pins are not shown, and every project reads as unpinned: say so, rather than drop them silently. */}
      {live && pinsError && (
        <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[11px] text-destructive" title={pinsError} data-testid="cloud-pins-error">
          <span className="min-w-0 flex-1 truncate">Pinned projects could not be read.</span>
          <button type="button" onClick={() => void bootCloudPins()} className="shrink-0 rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" data-testid="cloud-pins-retry">
            Try again
          </button>
        </div>
      )}
      {cloudEnabled && !live && (
        <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[12px] text-faint" title={HINT} data-testid="cloud-org-not-live">
          <span className="min-w-0 flex-1 truncate">Its cloud sessions show when it is the default organization.</span>
          <button type="button" onClick={() => void switchOrg()} className="shrink-0 rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" data-testid="cloud-org-switch">
            Switch
          </button>
        </div>
      )}
      {offline && (
        <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[11px] text-faint" data-testid="cloud-org-offline" title={catalogErrorText(cached!.error!)}>
          <span className="min-w-0 truncate">Offline · last known {timeText(cached!.fetchedAt!)}</span>
          <RetryButton orgId={org.id} name={name} />
        </div>
      )}
      {unloaded && <OrgLoadState orgId={org.id} name={name} error={cached?.error ?? null} />}
    </>
  );

  return (
    <ListSection
      id={`org:${org.id}`}
      label={name}
      mark={<OrgMark name={name} />}
      note={note}
      description={usage?.card.replace(/\n/g, " · ")}
      title={temporary ? "Shown while selected; your sidebar preference is unchanged" : org.isPersonal ? `${org.name} (personal)` : org.name}
      forceOpen={temporary}
      actions={actions}
      notes={notes}
      onMenu={() => menu.setOpen(true)}
      data-testid="cloud-org-list"
      data-org={org.id}
    >
      {live && !unloaded && (
        <div className={cn("min-w-0", offline && "opacity-70")}>
          <OrgProjects orgId={org.id} projects={placed.projects} archived={placed.archived} sections={sections} filtered={filter.active} empty={filter.empty} mayCreate={mayCreate} onLifecycle={onLifecycle} />
        </div>
      )}
    </ListSection>
  );
}

/** An organization's projects: the reader's sections first, then the projects in none, then the archive. */
function OrgProjects({
  orgId,
  projects: all,
  archived,
  sections,
  filtered,
  empty,
  mayCreate,
  onLifecycle,
}: {
  orgId: string;
  projects: CloudProject[];
  archived: ReturnType<typeof placeCloudProjects>["archived"];
  sections: CloudSidebarSection[];
  filtered: boolean;
  empty: string;
  mayCreate: boolean | null;
  onLifecycle: (request: LifecycleRequest) => void;
}) {
  const filter = useSidebarFilter();
  // Unread and Needs you hide the archive; a project filter keeps matching archived workspaces.
  const projects = filtered ? all.filter((project) => filter.showsProject(project.key)) : all;
  const visibleArchived = filter.filter === "all" ? archived.filter((node) => filter.showsWorkspace(node.key)) : [];
  return <>
    {filtered && !projects.length && !visibleArchived.length && <p className="px-2 py-1 text-[12px] text-faint" data-testid="cloud-org-filtered-empty">{empty}</p>}
    {!all.length && !archived.length && <p className="px-2 py-1 text-[12px] text-faint" data-testid="cloud-org-empty">{emptyOrgText(mayCreate)}</p>}
    <CloudWorkspaceSections orgId={orgId} projects={all} sections={sections} filtered={filtered} onLifecycle={onLifecycle} />
    {visibleArchived.length > 0 && <ArchivedWorkspaces orgId={orgId} nodes={visibleArchived} onLifecycle={onLifecycle} />}
  </>;
}



// ---- organization states ---------------------------------------------------

/** An organization whose list has never answered: loading, or why it failed and a way to ask again. */
function OrgLoadState({ orgId, name, error }: { orgId: string; name: string; error: string | null }) {
  if (!error) {
    return (
      <div role="status" className="flex items-center gap-1.5 px-2 py-1 text-[12px] text-faint" data-testid="cloud-org-loading">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Loading cloud projects…
      </div>
    );
  }
  return (
    <div role="status" className="px-2 py-1 text-[12px] text-faint" data-testid="cloud-org-failed">
      <p>
        Couldn’t load cloud projects. <span data-testid="cloud-org-failed-reason">{catalogErrorText(error)}</span>
      </p>
      <RetryButton orgId={orgId} name={name} />
    </div>
  );
}

/** Lists the organization again now; says so while it does. */
function RetryButton({ orgId, name }: { orgId: string; name: string }) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void refreshCloudWorkspaces(orgId).finally(() => setRetrying(false));
  };
  return (
    <button
      type="button"
      onClick={retry}
      disabled={retrying}
      aria-label={retrying ? `Retrying ${name}` : `Retry loading ${name}`}
      className="shrink-0 rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:no-underline"
      data-testid="cloud-org-retry"
    >
      {retrying ? "Retrying…" : "Retry"}
    </button>
  );
}

/** What this Mac dropped of workspaces deleted elsewhere (unsent messages, unsaved edits), said once and dismissed by hand. */
function PurgeNotices() {
  const { notices } = useCloudCatalog();
  if (!notices.length) return null;
  return (
    <div className="mb-3 flex min-w-0 flex-col gap-1">
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
