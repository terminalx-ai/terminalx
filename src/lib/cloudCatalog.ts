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
import { phaseOf, settled } from "@/lib/cloudCreate";
import { isArchived, isOpen, purgeTombstones, type PurgeNotice } from "@/lib/cloudLifecycle";
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
 * - Only the default (active) organization is listed until the server lets a
 *   desktop list every member organization (CS-17); the others keep what was
 *   saved for them.
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
  for (const item of list.workspaces) names.set(item.workspace.id, item.workspace.name);
  const org = orgId ?? defaultOrgId(getAccount().status) ?? list.workspaces[0]?.workspace.orgId ?? null;
  const newer = org !== null && (listedAt.get(org) ?? -Infinity) > requestedAt;
  if (org && !newer) {
    listedAt.set(org, requestedAt);
    const current = state.orgs[org] ?? emptyOrg(org);
    const createMemory = { ...state.createMemory };
    for (const tombstone of tombstones) delete createMemory[memoryKey(tombstone.orgId, tombstone.id)];
    const sessions = { ...current.sessions };
    for (const tombstone of tombstones) delete sessions[tombstone.id];
    set({
      ...state,
      orgs: { ...state.orgs, [org]: { ...current, workspaces, quota: list.quota ?? current.quota, fetchedAt: now, source: "live", error: null, sessions } },
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
  schedulePoll();
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
  const snapshot = await api.cloudWorkspaceUnarchive(item.workspace.id);
  if (snapshot?.workspace) applyCloudSnapshot(snapshot);
}

/** Resume, asked for explicitly from a workspace's menu. Nothing that only looks calls this. */
export async function resumeCloudWorkspace(item: CloudWorkspaceListItem): Promise<void> {
  const snapshot = await api.cloudWorkspaceResume(item.workspace.id);
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
 * List the default organization's workspaces (and, every few minutes, its
 * selected repositories). Another organization is not listed: the server
 * answers for the active organization only until CS-17.
 */
export function refreshCloudCatalog(orgId: string | null = defaultOrgId(getAccount().status), now: () => number = Date.now): Promise<void> {
  if (!orgId || orgId !== defaultOrgId(getAccount().status)) return Promise.resolve();
  const running = flights.get(orgId);
  if (running) return running;
  const owner = state.owner;
  const flight = (async () => {
    const current = state.orgs[orgId];
    const requestedAt = now();
    const wantRepositories = !current?.repositoriesAt || now() - current.repositoriesAt > REPOSITORIES_MAX_AGE_MS;
    const [list, repositories] = await Promise.allSettled([
      api.cloudWorkspaces(),
      wantRepositories ? api.cloudWorkspaceRepositories() : Promise.resolve(null),
    ]);
    // Signed out or another user while it ran: nothing lands.
    if (state.owner !== owner) return;
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
        void refreshAccount();
        return;
      }
      await ingestCloudList(list.value, orgId, now(), requestedAt);
    } else {
      patchOrg(orgId, { error: errorText(list.reason) });
    }
  })().finally(() => {
    flights.delete(orgId);
    schedulePoll();
  });
  flights.set(orgId, flight);
  return flight;
}

// ---- Poll policy -----------------------------------------------------------

export const POLL_FOCUSED_MS = 30_000;
export const POLL_CHANGING_MS = 3_000;

/** Starting, or a stop, resume, archive or delete still running. */
export function isChanging(item: CloudWorkspaceListItem): boolean {
  return ((item.workspace.state === "provisioning" || !!item.workspace.launch) && !settled(phaseOf(item))) || isOpen(item.latestOperation);
}

/**
 * How long until the next list: every 3 s while anything is changing state,
 * every 30 s while the window is focused, and never while it is hidden (or
 * visible but in the background with nothing changing; focusing it lists at
 * once when the rows are stale).
 */
export function pollDelay(org: OrgCatalog | undefined, window: { visible: boolean; focused: boolean }): number | null {
  if (!window.visible) return null;
  if (org?.workspaces.some(isChanging)) return POLL_CHANGING_MS;
  return window.focused ? POLL_FOCUSED_MS : null;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function windowState(): { visible: boolean; focused: boolean } {
  if (typeof document === "undefined") return { visible: false, focused: false };
  return { visible: document.visibilityState !== "hidden", focused: typeof document.hasFocus === "function" ? document.hasFocus() : true };
}

function schedulePoll() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const orgId = defaultOrgId(getAccount().status);
  if (!booted || !orgId || !cloudOrganizations(getAccount().status).some((org) => org.id === orgId)) return;
  const delay = pollDelay(state.orgs[orgId], windowState());
  if (delay === null) return;
  timer = setTimeout(() => {
    timer = null;
    void refreshCloudCatalog(orgId);
  }, delay);
}

function onWindowChange() {
  const orgId = defaultOrgId(getAccount().status);
  const org = orgId ? state.orgs[orgId] : undefined;
  const { visible, focused } = windowState();
  const stale = !org?.fetchedAt || Date.now() - org.fetchedAt >= POLL_FOCUSED_MS;
  if (visible && focused && stale && orgId && cloudOrganizations(getAccount().status).some((item) => item.id === orgId)) void refreshCloudCatalog(orgId);
  else schedulePoll();
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
}

// ---- Account ---------------------------------------------------------------

let booted = false;
let unsubscribe: (() => void) | null = null;

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
    set({ ...EMPTY, owner, revision }, false);
    if (owner && revision) void loadSaved(owner, revision);
  } else if (revision !== state.revision) {
    set({ ...state, revision }, false);
  }
  const orgId = defaultOrgId(status);
  if (owner && orgId && cloudOrganizations(status).some((org) => org.id === orgId)) void refreshCloudCatalog(orgId);
  else schedulePoll();
}

export function bootCloudCatalog() {
  if (booted) return;
  booted = true;
  unsubscribe = subscribeAccount(syncAccount);
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
  if (typeof window !== "undefined") {
    window.removeEventListener("focus", onWindowChange);
    window.removeEventListener("blur", onWindowChange);
    document.removeEventListener("visibilitychange", onWindowChange);
  }
  if (timer !== null) clearTimeout(timer);
  if (saveTimer !== null) clearTimeout(saveTimer);
  timer = null;
  saveTimer = null;
  booted = false;
  flights.clear();
  names.clear();
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
