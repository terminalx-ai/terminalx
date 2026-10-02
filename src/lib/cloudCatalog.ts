import { useSyncExternalStore } from "react";
import type { RuntimeSession } from "@terminalx/portable/workspace";
import { normalizeRepositoryIdentity } from "@terminalx/portable/repositoryIdentity";
import {
  api,
  type AccountStatus,
  type CloudSelectedRepository,
  type CloudWorkspace,
  type CloudWorkspaceList,
  type CloudWorkspaceListItem,
  type CloudWorkspaceRepositoryInput,
  type CloudWorkspaceSnapshot,
  type OrganizationSummary,
} from "@/lib/api";
import { getAccount, refreshAccount, subscribeAccount } from "@/lib/account";
import { noteListedOrgRole, refreshAccountRoles } from "@/lib/accountRoles";
import { isMultiOrg } from "@/lib/multiOrg";
import { phaseOf, settled } from "@/lib/cloudCreate";
import { isArchived, isOpen, purgeTombstones, type PurgeNotice } from "@/lib/cloudLifecycle";
import { onAccessChanged } from "@/lib/cloudCollab";
import { cloudProjectKey, cloudWorkspaceKey, type CloudProject, type CloudWorkspaceNode } from "@/types/target";

/**
 * The cloud catalog (PRO-57): per organization, its workspaces, selected
 * repositories, tombstones and quota, kept in one store every surface reads
 * and saved per user so a relaunch renders it before the network answers.
 *
 * - Looking never costs money. Nothing here attaches to a workspace or
 *   resumes one: the store only lists (`cloudWorkspaces`,
 *   `cloudWorkspaceRepositories`) and, for a tombstone, purges what this
 *   desktop kept.
 * - An error never replaces valid cached data: a failed refresh keeps the
 *   rows and says when they were last known.
 * - Every cloud-enabled member organization is listed and polled on a server
 *   that authorizes desktop cloud routes by membership (CS-18,
 *   `cloud.desktop.multi-org.v1`). On an older server only the default
 *   (active) organization is, and the others keep what was saved for them.
 * - `createMemory` is what this desktop recorded when it created a workspace:
 *   the repositories it was built from, so it is placed under its project on a
 *   server that does not list them yet (S1).
 */

export interface OrgCatalog {
  orgId: string;
  workspaces: CloudWorkspaceListItem[];
  /** The organization's selected repositories; null until first listed. */
  repositories: CloudSelectedRepository[] | null;
  repositoriesAt: number | null;
  quota: { used: number; limit: number } | null;
  /** When the workspace list last answered; null for never. */
  fetchedAt: number | null;
  /**
   * When the list now shown was asked for (this launch only). What it says
   * was true no earlier than this, so something learned later than it (a
   * revocation seen live) is not contradicted by it.
   */
  requestedAt?: number | null;
  /** `cache` until this launch's first list answers. */
  source: "cache" | "live";
  /** Why the last refresh failed; the rows above are then last known. */
  error: string | null;
  /** Per workspace id, the sessions last read from its runtime (CS-8), so a stopped workspace still lists them. */
  sessions: Record<string, CachedWorkspaceSessions>;
}

/** A workspace's session list as its runtime last reported it. Paths in it are VM paths. */
export interface CachedWorkspaceSessions {
  sessions: RuntimeSession[];
  /** The runtime's capabilities when it was read; decides which session actions show. */
  capabilities: string[] | null;
  at: number;
}

export interface CreateMemoryEntry {
  /** Repository identities, primary first. */
  repositories: string[];
  createdAt: number;
}

export interface CloudCatalogState {
  /** Whose catalog this is (the account email); null while signed out. */
  owner: string | null;
  /** The account context revision the saved file is fenced by. */
  revision: string | null;
  /** The saved catalog was read (or there was none). */
  loaded: boolean;
  orgs: Record<string, OrgCatalog>;
  /** `${orgId}:${workspaceId}` → what this desktop created it from. */
  createMemory: Record<string, CreateMemoryEntry>;
  /** What went with a workspace deleted elsewhere, until dismissed. */
  notices: PurgeNotice[];
}

const EMPTY: CloudCatalogState = { owner: null, revision: null, loaded: false, orgs: {}, createMemory: {}, notices: [] };

let state: CloudCatalogState = EMPTY;
const listeners = new Set<() => void>();

function set(next: CloudCatalogState, persist = true) {
  state = next;
  for (const listener of listeners) listener();
  if (persist) scheduleSave();
}

export function getCloudCatalog(): CloudCatalogState {
  return state;
}

export function subscribeCloudCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCloudCatalog(): CloudCatalogState {
  return useSyncExternalStore(subscribeCloudCatalog, getCloudCatalog, getCloudCatalog);
}

// ---- Organizations ---------------------------------------------------------

/** Organizations with cloud workspaces enabled, as the desktop session reports them (PRO-69). */
export function cloudOrganizations(status: AccountStatus): OrganizationSummary[] {
  if (status.state !== "signed-in") return [];
  return (status.organizations ?? []).filter((org) => org.cloud?.enabled === true);
}

/**
 * The organizations whose sections are live: listed, polled and able to open
 * sessions. Every cloud-enabled one on a server with the capability (CS-18);
 * otherwise the default organization only, as before.
 */
export function liveCloudOrgIds(status: AccountStatus): string[] {
  const enabled = cloudOrganizations(status).map((org) => org.id);
  if (isMultiOrg(status)) return enabled;
  const orgId = defaultOrgId(status);
  return orgId && enabled.includes(orgId) ? [orgId] : [];
}

/**
 * The organization to name in a cloud call: the given one on a server that
 * authorizes by membership (the native side checks it against the membership
 * list), and none (the active organization, exactly as before) otherwise.
 */
export function cloudOrgArg(orgId: string | null | undefined): string | null {
  return orgId && isMultiOrg(getAccount().status) ? orgId : null;
}

/** Today's active organization: the one the server lists workspaces for. */
export function defaultOrgId(status: AccountStatus): string | null {
  if (status.state !== "signed-in" || !status.identity) return null;
  if (status.identity.organizationId) return status.identity.organizationId;
  const name = status.identity.organization;
  return (name && status.organizations?.find((org) => org.name === name)?.id) || null;
}

// ---- Placement -------------------------------------------------------------

export interface CloudPlacement {
  /**
   * Shown: repositories with a non-archived workspace, those the user pinned
   * or added, and blank projects (workspaces with no repository, and blank
   * projects added but not created yet).
   */
  projects: CloudProject[];
  /** Other selected repositories: what "+ Add project" offers. */
  more: CloudProject[];
  /** Archived workspaces, only ever under the organization's "Archived workspaces". */
  archived: CloudWorkspaceNode[];
}

function memoryKey(orgId: string, workspaceId: string): string {
  return `${orgId}:${workspaceId}`;
}

/**
 * A blank project's identity: `blank/<name>`, lower case. It has a slash, so
 * its key (`cloud:<orgId>:blank/<name>`) is a project key and never parses as
 * a workspace key. A blank project is known by its workspace's name, which is
 * what every device sees once it is created.
 */
export function blankIdentity(name: string): string {
  return `blank/${name.trim().toLowerCase()}`;
}

export function isBlankIdentity(identity: string): boolean {
  return identity.startsWith("blank/");
}

function selectedIdentity(repository: CloudSelectedRepository): string | null {
  return normalizeRepositoryIdentity(repository.cloneUrl) ?? normalizeRepositoryIdentity(`github.com/${repository.fullName}`);
}

/**
 * Where a workspace belongs: its primary repository from the server's list
 * (S1) when the server sends one, else from what this desktop recorded when
 * it created it, else nowhere (a blank project named after it). A server that
 * lists the field with no repositories means no repository: blank.
 */
export function repositoryOf(
  item: CloudWorkspaceListItem,
  memory: Record<string, CreateMemoryEntry>,
): { identity: string; fullName: string | null; placedBy: "server" | "createMemory" } | null {
  const listed = item.workspace.repositories;
  if (Array.isArray(listed)) {
    const primary = listed.find((repository) => repository.primary) ?? listed[0];
    const identity = primary ? (normalizeRepositoryIdentity(primary.identity) ?? normalizeRepositoryIdentity(primary.cloneUrl)) : null;
    return identity ? { identity, fullName: primary?.fullName ?? null, placedBy: "server" } : null;
  }
  const remembered = memory[memoryKey(item.workspace.orgId, item.workspace.id)]?.repositories[0];
  return remembered ? { identity: remembered, fullName: null, placedBy: "createMemory" } : null;
}

export function lastActivity(workspace: CloudWorkspace): number {
  return workspace.lastActivityAt ?? workspace.updatedAt ?? workspace.createdAt ?? 0;
}

function byActivity(a: CloudWorkspaceNode, b: CloudWorkspaceNode): number {
  return lastActivity(b.item.workspace) - lastActivity(a.item.workspace);
}

/** `owner/name` from `host/owner/name`. */
function nameOfIdentity(identity: string): string {
  return identity.split("/").slice(1).join("/");
}

export function placeCloudProjects(
  org: Pick<OrgCatalog, "orgId" | "workspaces" | "repositories">,
  memory: Record<string, CreateMemoryEntry>,
  options: { pinned?: readonly string[]; added?: readonly string[]; blank?: readonly string[] } = {},
): CloudPlacement {
  const pinned = new Set(options.pinned ?? []);
  const added = new Set(options.added ?? []);
  const selected = new Map<string, string>();
  for (const repository of org.repositories ?? []) {
    const identity = selectedIdentity(repository);
    if (identity && !selected.has(identity)) selected.set(identity, repository.fullName);
  }
  // Until the organization's repositories are known, nothing reads "not accessible".
  const known = org.repositories !== null;
  const projects = new Map<string, CloudProject>();
  const project = (identity: string, fullName: string | null, blank = false): CloudProject => {
    let found = projects.get(identity);
    if (!found) {
      found = {
        key: cloudProjectKey(org.orgId, identity),
        orgId: org.orgId,
        identity,
        fullName: blank ? (fullName ?? identity.slice("blank/".length)) : (selected.get(identity) ?? fullName ?? nameOfIdentity(identity)),
        selected: blank || !known || selected.has(identity),
        pinned: pinned.has(identity),
        blank,
        workspaces: [],
      };
      projects.set(identity, found);
    }
    return found;
  };
  const archived: CloudWorkspaceNode[] = [];
  for (const item of org.workspaces) {
    const repository = repositoryOf(item, memory);
    const node: CloudWorkspaceNode = { key: cloudWorkspaceKey(org.orgId, item.workspace.id), item, placedBy: repository?.placedBy ?? null };
    if (isArchived(item.workspace)) archived.push(node);
    else if (repository) project(repository.identity, repository.fullName).workspaces.push(node);
    // No repository: a blank project, known by the workspace's name.
    else project(blankIdentity(item.workspace.name), item.workspace.name.trim(), true).workspaces.push(node);
  }
  // Pinned and added projects show while their repository is selected (or before the selection is known).
  for (const identity of [...pinned, ...added]) if (!isBlankIdentity(identity) && (selected.has(identity) || !known)) project(identity, null);
  for (const name of options.blank ?? []) if (name.trim()) project(blankIdentity(name), name.trim(), true);
  const more: CloudProject[] = [];
  for (const [identity, fullName] of selected) {
    if (projects.has(identity)) continue;
    more.push({ key: cloudProjectKey(org.orgId, identity), orgId: org.orgId, identity, fullName, selected: true, pinned: false, blank: false, workspaces: [] });
  }
  const shown = [...projects.values()];
  for (const item of shown) item.workspaces.sort(byActivity);
  shown.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.fullName.localeCompare(b.fullName));
  more.sort((a, b) => a.fullName.localeCompare(b.fullName));
  archived.sort(byActivity);
  return { projects: shown, more, archived };
}

// ---- Merging lists ---------------------------------------------------------

function emptyOrg(orgId: string): OrgCatalog {
  return { orgId, workspaces: [], repositories: null, repositoriesAt: null, quota: null, fetchedAt: null, source: "cache", error: null, sessions: {} };
}

/** Names seen in earlier lists, so a tombstone's notice can say which workspace went. */
const names = new Map<string, string>();
/** The project each workspace was last listed under, by workspace id (this launch only). */
const projectNames = new Map<string, string>();

/**
 * What a workspace no longer in this person's list was last called here: its
 * name and its project, as their own sidebar showed them earlier in this
 * launch. Nothing is read from the server for it and nothing is saved, so
 * after a relaunch there is no name to show. Null when it was never listed.
 */
export function lastKnownWorkspace(workspaceId: string): { name: string; project: string } | null {
  const name = names.get(workspaceId);
  return name ? { name, project: projectNames.get(workspaceId) ?? name } : null;
}
/** Per organization, when the list now shown was asked for. */
const listedAt = new Map<string, number>();

/**
 * Take a workspace list: tombstoned workspaces leave the rows, and what this
 * desktop kept of them is purged (their agent data, keys, outbox, terminals,
 * editors and connection). `orgId` is the organization the list is for; the
 * full-window page passes null and the default organization is used.
 * Returns the rows to show and any purge notices.
 */
export async function ingestCloudList(
  list: CloudWorkspaceList,
  orgId: string | null = null,
  now = Date.now(),
  /** When the list was asked for; a list asked for before the one already taken is older and is not taken. */
  requestedAt = now,
): Promise<{ workspaces: CloudWorkspaceListItem[]; notices: PurgeNotice[] }> {
  const tombstones = list.tombstones ?? [];
  const deleted = new Set(tombstones.map((tombstone) => tombstone.id));
  const workspaces = list.workspaces.filter((item) => !deleted.has(item.workspace.id));
  for (const item of list.workspaces) {
    names.set(item.workspace.id, item.workspace.name);
    const repository = repositoryOf(item, state.createMemory);
    projectNames.set(item.workspace.id, repository ? (repository.fullName ?? nameOfIdentity(repository.identity)) : item.workspace.name);
  }
  const org = orgId ?? defaultOrgId(getAccount().status) ?? list.workspaces[0]?.workspace.orgId ?? null;
  const newer = org !== null && (listedAt.get(org) ?? -Infinity) > requestedAt;
  if (org && !newer) {
    listedAt.set(org, requestedAt);
    const current = state.orgs[org] ?? emptyOrg(org);
    const createMemory = { ...state.createMemory };
    for (const tombstone of tombstones) delete createMemory[memoryKey(tombstone.orgId, tombstone.id)];
    const sessions = { ...current.sessions };
    for (const tombstone of tombstones) delete sessions[tombstone.id];
    // Session lists kept for a workspace this person can no longer open (not
    // shared with them now, or no longer listed for them at all) go too: no
    // title, tab or terminal of it is shown, or saved for the next launch.
    const readable = new Set(workspaces.filter((item) => item.workspace.you?.role !== "none").map((item) => item.workspace.id));
    for (const id of Object.keys(sessions)) if (!readable.has(id)) delete sessions[id];
    set({
      ...state,
      orgs: { ...state.orgs, [org]: { ...current, workspaces, quota: list.quota ?? current.quota, fetchedAt: now, requestedAt, source: "live", error: null, sessions } },
      createMemory,
    });
  }
  const notices = await purgeTombstones(tombstones, names);
  if (notices.length) set({ ...state, notices: [...state.notices, ...notices] }, false);
  return { workspaces, notices };
}

/** A snapshot from a create, lifecycle or operation poll replaces its row at once. */
export function applyCloudSnapshot(snapshot: CloudWorkspaceSnapshot) {
  const orgId = snapshot.workspace.orgId;
  const current = state.orgs[orgId];
  if (!current) return;
  const item: CloudWorkspaceListItem = { workspace: snapshot.workspace, latestOperation: snapshot.operation };
  const known = current.workspaces.some((row) => row.workspace.id === item.workspace.id);
  const workspaces = known ? current.workspaces.map((row) => (row.workspace.id === item.workspace.id ? item : row)) : [item, ...current.workspaces];
  set({ ...state, orgs: { ...state.orgs, [orgId]: { ...current, workspaces } } });
  schedulePoll(orgId);
}

/** The organization's selected repositories, as a picker just read them. */
export function setCloudRepositories(orgId: string, repositories: CloudSelectedRepository[], now = Date.now()) {
  const current = state.orgs[orgId] ?? emptyOrg(orgId);
  set({ ...state, orgs: { ...state.orgs, [orgId]: { ...current, repositories, repositoriesAt: now } } });
}

/** Keep a workspace's session list (CS-8) with the catalog, so it is on disk for the next launch. */
export function cacheCloudSessions(orgId: string, workspaceId: string, sessions: RuntimeSession[], capabilities: string[] | null, now = Date.now()) {
  const current = state.orgs[orgId];
  if (!current) return;
  const previous = current.sessions[workspaceId];
  if (previous && JSON.stringify(previous.sessions) === JSON.stringify(sessions) && JSON.stringify(previous.capabilities) === JSON.stringify(capabilities)) return;
  set({ ...state, orgs: { ...state.orgs, [orgId]: { ...current, sessions: { ...current.sessions, [workspaceId]: { sessions, capabilities, at: now } } } } });
}

/** Forget a workspace's saved session list: this person lost access to it. */
export function dropCachedCloudSessions(orgId: string, workspaceId: string) {
  const current = state.orgs[orgId];
  if (!current?.sessions[workspaceId]) return;
  const sessions = { ...current.sessions };
  delete sessions[workspaceId];
  set({ ...state, orgs: { ...state.orgs, [orgId]: { ...current, sessions } } });
}

/** The create flow records the repositories a new workspace was built from. */
export function rememberCreatedWorkspace(snapshot: CloudWorkspaceSnapshot, repositories: readonly CloudWorkspaceRepositoryInput[] | null | undefined, now = Date.now()) {
  const identities = (repositories ?? []).map((repository) => normalizeRepositoryIdentity(repository.cloneUrl)).filter((identity): identity is string => !!identity);
  const key = memoryKey(snapshot.workspace.orgId, snapshot.workspace.id);
  set({ ...state, createMemory: { ...state.createMemory, [key]: { repositories: identities, createdAt: now } } });
  applyCloudSnapshot(snapshot);
}

export function dismissCloudNotice(notice: PurgeNotice) {
  set({ ...state, notices: state.notices.filter((other) => other !== notice) }, false);
}

// ---- Lifecycle -------------------------------------------------------------

/**
 * Unarchive: the workspace comes back stopped and stays stopped until it is
 * opened. Stop, archive and delete go through `CloudWorkspaceLifecycleDialog`,
 * which reports its snapshot to `applyCloudSnapshot`. None of these resume.
 */
export async function unarchiveCloudWorkspace(item: CloudWorkspaceListItem): Promise<void> {
  const snapshot = await api.cloudWorkspaceUnarchive(item.workspace.id, cloudOrgArg(item.workspace.orgId));
  if (snapshot?.workspace) applyCloudSnapshot(snapshot);
}

/** Resume, asked for explicitly from a workspace's menu. Nothing that only looks calls this. */
export async function resumeCloudWorkspace(item: CloudWorkspaceListItem): Promise<void> {
  const snapshot = await api.cloudWorkspaceResume(item.workspace.id, cloudOrgArg(item.workspace.orgId));
  if (snapshot?.workspace) applyCloudSnapshot(snapshot);
}

/** The workspace a `cloud:<orgId>:<workspaceId>` key names, from the catalog. */
export function findCloudWorkspace(catalog: CloudCatalogState, orgId: string, workspaceId: string): CloudWorkspaceListItem | null {
  return catalog.orgs[orgId]?.workspaces.find((item) => item.workspace.id === workspaceId) ?? null;
}

// ---- Refresh ---------------------------------------------------------------

const REPOSITORIES_MAX_AGE_MS = 5 * 60 * 1000;
const flights = new Map<string, Promise<void>>();

function patchOrg(orgId: string, patch: Partial<OrgCatalog>) {
  const current = state.orgs[orgId] ?? emptyOrg(orgId);
  set({ ...state, orgs: { ...state.orgs, [orgId]: { ...current, ...patch } } });
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") return (error as { code: string }).code;
  return error instanceof Error ? error.message : String(error);
}

/**
 * List an organization's workspaces (and, every few minutes, its selected
 * repositories). Only a live organization is listed: every cloud-enabled one
 * on a server with the capability, else the default one alone.
 */
export function refreshCloudCatalog(orgId: string | null = defaultOrgId(getAccount().status), now: () => number = Date.now): Promise<void> {
  if (!orgId || !liveCloudOrgIds(getAccount().status).includes(orgId)) return Promise.resolve();
  const running = flights.get(orgId);
  if (running) return running;
  const owner = state.owner;
  const flight = (async () => {
    const current = state.orgs[orgId];
    const requestedAt = now();
    const wantRepositories = !current?.repositoriesAt || now() - current.repositoriesAt > REPOSITORIES_MAX_AGE_MS;
    const [list, repositories] = await Promise.allSettled([
      api.cloudWorkspaces(cloudOrgArg(orgId)),
      wantRepositories ? api.cloudWorkspaceRepositories(cloudOrgArg(orgId)) : Promise.resolve(null),
    ]);
    // Signed out or another user while it ran, or (CS-18) the user left the organization: nothing lands.
    if (state.owner !== owner) return;
    if (isMultiOrg(getAccount().status) && !liveCloudOrgIds(getAccount().status).includes(orgId)) return;
    if (repositories.status === "fulfilled" && repositories.value) {
      patchOrg(orgId, { repositories: repositories.value.repositories, repositoriesAt: now() });
    }
    if (list.status === "fulfilled" && !Array.isArray(list.value?.workspaces)) {
      patchOrg(orgId, { error: "cloud_workspace_invalid_response" });
    } else if (list.status === "fulfilled") {
      // A list for another organization is not this one's: the server's
      // active organization differs from the one shown as default, so the
      // account status here is stale. Read it again rather than show the
      // wrong organization's rows.
      if (list.value.workspaces.some((item) => item.workspace.orgId !== orgId)) {
        // A list named by its organization (CS-18) that answers for another is simply invalid.
        if (isMultiOrg(getAccount().status)) patchOrg(orgId, { error: "cloud_workspace_invalid_response" });
        else void refreshAccount();
        return;
      }
      await ingestCloudList(list.value, orgId, now(), requestedAt);
      // The list is read every 30 s and names this person's role on every
      // workspace: a role changed by an owner shows here before the account
      // session is next renewed.
      noteListedOrgRole(orgId, listedOrgManages(list.value), requestedAt);
    } else {
      patchOrg(orgId, { error: errorText(list.reason) });
      // A list answers "not found" only to someone who is not a member of the
      // organization: the organizations held are older than the server's.
      if (errorText(list.reason) === "cloud_workspace_not_found") void refreshAccountRoles(true);
    }
  })().finally(() => {
    flights.delete(orgId);
    schedulePoll(orgId);
  });
  flights.set(orgId, flight);
  return flight;
}

/**
 * What a workspace list says about this person's role in its organization:
 * true for an owner or admin (the API's `manager`, or a `manage` authority on
 * a server that does not report roles), false for a member, and null when the
 * list does not say (no workspaces, an older server, or rows that disagree).
 */
export function listedOrgManages(list: Pick<CloudWorkspaceList, "workspaces">): boolean | null {
  const signals = list.workspaces
    .map(({ workspace }) => (workspace.you ? workspace.you.role === "manager" : workspace.authority === "manage" ? true : workspace.authority === "participate" ? false : null))
    .filter((signal): signal is boolean => signal !== null);
  if (!signals.length) return null;
  const manages = signals[0];
  return signals.every((signal) => signal === manages) ? manages : null;
}

/**
 * "Refresh cloud workspaces" and "Refresh all": the organization's list, and
 * the account's organizations and roles from the server, which decide what
 * the menus offer.
 */
export function refreshCloudWorkspaces(orgId: string | null = defaultOrgId(getAccount().status)): Promise<void> {
  return Promise.all([refreshAccountRoles(true), refreshCloudCatalog(orgId)]).then(() => undefined);
}

// ---- Poll policy -----------------------------------------------------------

/** While the window can be seen or has the focus. */
export const POLL_FOCUSED_MS = 30_000;
export const POLL_CHANGING_MS = 3_000;
/** While the window is hidden: minimized, on another space, or wholly covered by other windows. */
export const POLL_BACKGROUND_MS = 120_000;
/** A burst of access changes (a share dialog, several role notifications) lists once. */
export const ACCESS_REFRESH_DELAY_MS = 400;
/** Coming back to the window lists at once, unless a list was asked for this recently (focus and visibility often change together). */
export const REFRESH_ON_RETURN_FLOOR_MS = 2_000;

/** Starting, or a stop, resume, archive or delete still running. */
export function isChanging(item: CloudWorkspaceListItem): boolean {
  return ((item.workspace.state === "provisioning" || !!item.workspace.launch) && !settled(phaseOf(item))) || isOpen(item.latestOperation);
}

/**
 * How long until an organization's next list.
 *
 * - Seen or focused: every 30 s, and every 3 s while anything in it is
 *   changing state. A window another app has the focus over is still seen, so
 *   a workspace someone just shared with this person shows within 30 s.
 * - Hidden and not focused: every 2 min, never paused. WKWebView reports
 *   `visibilityState` "hidden" for a window that is minimized, on another
 *   space, or wholly covered by other windows (its occlusion detection), and
 *   WebKit throttles a hidden page's timers, so this is a floor, not a
 *   promise. That is why coming back (focus, or visible again) lists at once.
 *
 * "Seen" is never taken from visibility alone: a window with the focus polls
 * fast whatever `visibilityState` says. Each live organization follows this
 * on its own timer (until the cross-organization feed, CS-21). Listing never
 * wakes compute.
 */
export function pollDelay(org: OrgCatalog | undefined, window: { visible: boolean; focused: boolean }): number {
  if (!window.visible && !window.focused) return POLL_BACKGROUND_MS;
  if (org?.workspaces.some(isChanging)) return POLL_CHANGING_MS;
  return POLL_FOCUSED_MS;
}

/** Per live organization, its next list. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function windowState(): { visible: boolean; focused: boolean } {
  if (typeof document === "undefined") return { visible: false, focused: false };
  return { visible: document.visibilityState !== "hidden", focused: typeof document.hasFocus === "function" ? document.hasFocus() : true };
}

function clearTimers(keep: ReadonlySet<string> = new Set()) {
  for (const [orgId, timer] of timers) {
    if (keep.has(orgId)) continue;
    clearTimeout(timer);
    timers.delete(orgId);
  }
}

/** Schedule the next list of one organization, or (none named) of every live one; an organization no longer live stops. */
function schedulePoll(only?: string) {
  const live = booted ? liveCloudOrgIds(getAccount().status) : [];
  clearTimers(new Set(live));
  for (const orgId of live) {
    if (only && orgId !== only) continue;
    const existing = timers.get(orgId);
    if (existing) clearTimeout(existing);
    timers.delete(orgId);
    timers.set(
      orgId,
      setTimeout(() => {
        timers.delete(orgId);
        void refreshCloudCatalog(orgId);
      }, pollDelay(state.orgs[orgId], windowState())),
    );
  }
}

/**
 * The window got the focus, lost it, or its visibility changed. Coming back
 * (focused, or visible again) lists every live organization at once, so
 * nobody waits out a timer that ran slow, or not at all, while the window
 * was hidden. Going away only moves the timers to the slower pace.
 */
function onWindowChange(event?: Event) {
  const { visible, focused } = windowState();
  const returned = event?.type === "focus" || (event?.type === "visibilitychange" && visible);
  for (const orgId of liveCloudOrgIds(getAccount().status)) {
    const asked = state.orgs[orgId]?.requestedAt ?? null;
    const justAsked = asked !== null && Date.now() - asked < REFRESH_ON_RETURN_FLOOR_MS;
    if (returned && (visible || focused) && !justAsked) void refreshCloudCatalog(orgId);
    else schedulePoll(orgId);
  }
}

/** Lists asked for by an access change, per organization, not yet sent. */
const accessTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Who may open a workspace of `orgId` changed (this person's role, the
 * runtime's member list, or a share made here): list the organization again
 * soon, focused or not, so rows lock, unlock or disappear. Only a list: it
 * never attaches to or resumes anything.
 */
function onAccessChange(orgId: string) {
  if (!booted || accessTimers.has(orgId)) return;
  if (!liveCloudOrgIds(getAccount().status).includes(orgId)) return;
  accessTimers.set(
    orgId,
    setTimeout(() => {
      accessTimers.delete(orgId);
      void refreshCloudCatalog(orgId);
    }, ACCESS_REFRESH_DELAY_MS),
  );
}

// ---- Saved cache -----------------------------------------------------------

const CATALOG_VERSION = 1;
const SAVE_DELAY_MS = 500;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (!state.revision || !state.loaded) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, SAVE_DELAY_MS);
}

/** What goes on disk: rows and repositories, never errors or notices. */
export function serializeCatalog(catalog: CloudCatalogState): unknown {
  const orgs: Record<string, unknown> = {};
  for (const [orgId, org] of Object.entries(catalog.orgs)) {
    orgs[orgId] = { workspaces: org.workspaces, repositories: org.repositories, repositoriesAt: org.repositoriesAt, quota: org.quota, fetchedAt: org.fetchedAt, sessions: org.sessions };
  }
  return { version: CATALOG_VERSION, orgs, createMemory: catalog.createMemory };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validItem(value: unknown): value is CloudWorkspaceListItem {
  if (!isObject(value) || !isObject(value.workspace)) return false;
  const workspace = value.workspace;
  return typeof workspace.id === "string" && typeof workspace.orgId === "string" && typeof workspace.name === "string" && typeof workspace.state === "string";
}

function validSession(value: unknown): value is RuntimeSession {
  return isObject(value) && typeof value.id === "string" && typeof value.title === "string" && Array.isArray(value.tabs);
}

/** Saved session lists, for workspaces the saved catalog still lists. */
function parseSessions(value: unknown, workspaces: ReadonlySet<string>): Record<string, CachedWorkspaceSessions> {
  const out: Record<string, CachedWorkspaceSessions> = {};
  if (!isObject(value)) return out;
  for (const [workspaceId, raw] of Object.entries(value)) {
    if (!workspaces.has(workspaceId) || !isObject(raw) || !Array.isArray(raw.sessions)) continue;
    out[workspaceId] = {
      sessions: raw.sessions.filter(validSession),
      capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((c): c is string => typeof c === "string") : null,
      at: typeof raw.at === "number" ? raw.at : 0,
    };
  }
  return out;
}

/** A saved catalog, or null for anything this version cannot read. */
export function parseCatalog(value: unknown): Pick<CloudCatalogState, "orgs" | "createMemory"> | null {
  if (!isObject(value) || value.version !== CATALOG_VERSION || !isObject(value.orgs)) return null;
  const orgs: Record<string, OrgCatalog> = {};
  for (const [orgId, raw] of Object.entries(value.orgs)) {
    if (!isObject(raw) || !Array.isArray(raw.workspaces)) continue;
    const workspaces = raw.workspaces.filter(validItem).filter((item) => item.workspace.orgId === orgId);
    orgs[orgId] = {
      ...emptyOrg(orgId),
      workspaces,
      repositories: Array.isArray(raw.repositories) ? (raw.repositories as CloudSelectedRepository[]) : null,
      repositoriesAt: typeof raw.repositoriesAt === "number" ? raw.repositoriesAt : null,
      quota: isObject(raw.quota) && typeof raw.quota.used === "number" && typeof raw.quota.limit === "number" ? { used: raw.quota.used, limit: raw.quota.limit } : null,
      fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : null,
      sessions: parseSessions(raw.sessions, new Set(workspaces.map((item) => item.workspace.id))),
    };
  }
  const createMemory: Record<string, CreateMemoryEntry> = {};
  if (isObject(value.createMemory)) {
    for (const [key, raw] of Object.entries(value.createMemory)) {
      if (!isObject(raw) || !Array.isArray(raw.repositories)) continue;
      createMemory[key] = {
        repositories: raw.repositories.filter((identity): identity is string => typeof identity === "string"),
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      };
    }
  }
  return { orgs, createMemory };
}

async function saveNow() {
  const revision = state.revision;
  if (!revision) return;
  try {
    await api.cloudCatalogSave(revision, serializeCatalog(state));
  } catch {
    /* the account changed or the disk refused; the next change tries again */
  }
}

/** Read the saved catalog; organizations the network already answered for keep the live rows. */
async function loadSaved(owner: string, revision: string) {
  let saved: Pick<CloudCatalogState, "orgs" | "createMemory"> | null = null;
  try {
    saved = parseCatalog(await api.cloudCatalogLoad(revision));
  } catch {
    saved = null;
  }
  if (state.owner !== owner) return;
  const orgs = { ...(saved?.orgs ?? {}) };
  for (const [orgId, org] of Object.entries(state.orgs)) if (org.source === "live" || !orgs[orgId]) orgs[orgId] = org;
  set({ ...state, loaded: true, orgs, createMemory: { ...(saved?.createMemory ?? {}), ...state.createMemory } });
  // What was saved for an organization the user has since left is not shown again.
  if (isMultiOrg(getAccount().status)) dropLeftOrganizations(getAccount().status);
}

// ---- Account ---------------------------------------------------------------

let booted = false;
let unsubscribe: (() => void) | null = null;
let unsubscribeAccess: (() => void) | null = null;

/** Follow the account: load the saved catalog for a signed-in user, list the default organization, and poll. */
function syncAccount() {
  const { status } = getAccount();
  const signedIn = status.state === "signed-in" && !!status.identity;
  const owner = signedIn ? status.identity!.email : null;
  const revision = signedIn ? (status.context?.revision ?? null) : null;
  if (owner !== state.owner) {
    // Signed out, or another user: nothing of the previous one stays in memory.
    // The file stays for the same user and is deleted natively if another signs in.
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    flights.clear();
    listedAt.clear();
    names.clear();
    projectNames.clear();
    set({ ...EMPTY, owner, revision }, false);
    if (owner && revision) void loadSaved(owner, revision);
  } else if (revision !== state.revision) {
    set({ ...state, revision }, false);
  }
  if (owner && isMultiOrg(status)) dropLeftOrganizations(status);
  const live = owner ? liveCloudOrgIds(status) : [];
  // Listing never wakes compute. With several live organizations, one listed
  // moments ago keeps its timer rather than listing again on every status
  // read; the default organization alone (no capability) lists as before.
  const multi = isMultiOrg(status);
  for (const orgId of live) {
    const org = state.orgs[orgId];
    if (multi && org?.source === "live" && org.fetchedAt !== null && Date.now() - org.fetchedAt < POLL_CHANGING_MS) continue;
    void refreshCloudCatalog(orgId);
  }
  schedulePoll();
}

/**
 * The user left an organization (CS-18): its saved rows, session lists and
 * create memory go. Other organizations are untouched, and nothing goes on a
 * change of the default organization.
 */
function dropLeftOrganizations(status: AccountStatus) {
  const members = new Set((status.organizations ?? []).map((org) => org.id));
  if (status.identity?.organizationId) members.add(status.identity.organizationId);
  const left = Object.keys(state.orgs).filter((orgId) => !members.has(orgId));
  const leftMemory = Object.keys(state.createMemory).filter((key) => !members.has(key.split(":")[0]));
  if (!left.length && !leftMemory.length) return;
  const orgs = { ...state.orgs };
  for (const orgId of left) {
    delete orgs[orgId];
    listedAt.delete(orgId);
    flights.delete(orgId);
  }
  const createMemory = { ...state.createMemory };
  for (const key of leftMemory) delete createMemory[key];
  set({ ...state, orgs, createMemory });
}

export function bootCloudCatalog() {
  if (booted) return;
  booted = true;
  unsubscribe = subscribeAccount(syncAccount);
  unsubscribeAccess = onAccessChanged(onAccessChange);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onWindowChange);
    window.addEventListener("blur", onWindowChange);
    document.addEventListener("visibilitychange", onWindowChange);
  }
  syncAccount();
}

/** For tests. */
export function resetCloudCatalog() {
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeAccess?.();
  unsubscribeAccess = null;
  for (const timer of accessTimers.values()) clearTimeout(timer);
  accessTimers.clear();
  if (typeof window !== "undefined") {
    window.removeEventListener("focus", onWindowChange);
    window.removeEventListener("blur", onWindowChange);
    document.removeEventListener("visibilitychange", onWindowChange);
  }
  clearTimers();
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  booted = false;
  flights.clear();
  names.clear();
  projectNames.clear();
  listedAt.clear();
  state = EMPTY;
  for (const listener of listeners) listener();
}

/** For tests: write now instead of after the debounce. */
export function flushCloudCatalogSave(): Promise<void> {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  return saveNow();
}
