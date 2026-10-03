import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, closeWorkspaceConnections, closeWorkspaceConnectionsIn, errorMessage, type AccountStatus } from "@/lib/api";
import { registerAccountRoles } from "@/lib/accountRoles";
import { isMultiOrg, keptCloudOrgs, mayStartCloudSessions } from "@/lib/multiOrg";
import { dropCloudAgentsIn } from "@/lib/cloudAgents";
import { closeCloudConnectionsIn, resetCloudConnections } from "@/lib/cloudConnections";
import { dropCloudTerminalsIn, resetCloudTerminals } from "@/lib/cloudTerminals";
import { forgetPendingCreates, setPendingCreateUser } from "@/lib/cloudCreate";
import { forgetOtherSetups, forgetSetups } from "@/lib/organizationSetup";
import { dropCollabIn, resetCollab } from "@/lib/cloudCollab";
import { resetPeople } from "@/lib/cloudPeople";
import { dropEditors } from "@/lib/editors";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { resetCloudFiles, resetCloudFilesIn } from "@/lib/workspaceFiles";

interface AccountState {
  status: AccountStatus;
  ready: boolean;
  busy: boolean;
}

const signedOut: AccountStatus = {
  state: "signed-out",
  identity: null,
  expiresAt: null,
  lastError: null,
};

let state: AccountState = { status: signedOut, ready: false, busy: false };
const listeners = new Set<() => void>();
let refreshTimer: number | null = null;

function set(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** The status as the native side last reported it; `state.status` is this with newer role signals applied. */
let reported: AccountStatus = signedOut;

function applyStatus(status: AccountStatus) {
  // What a list implied about one account's role says nothing about another's.
  if (status.identity?.email !== reported.identity?.email) roleHints.clear();
  reported = status;
  status = withRoleHints(status);
  const change = cloudChange(state.status, status);
  if (change.kind === "all") {
    // A new account (or, without every organization live, a new default
    // organization) never reuses cloud connections, or what they cached,
    // from the previous one.
    resetCloudConnections();
    closeWorkspaceConnections();
    resetCloudTerminals();
    resetCollab();
    resetPeople();
    resetCloudFiles();
    dropEditors((entry) => !!entry.source);
  } else {
    // Every member organization is live (CS-18): a change of the default
    // organization closes nothing; only an organization the user left loses
    // its connections and what they cached.
    for (const orgId of change.left) dropCloudOrg(orgId);
  }
  for (const orgId of leftMemberships(state.status, status)) forgetCloudOrg(orgId, status.state === "signed-in" ? (status.identity?.email ?? null) : null);
  // Signing out here (not a launch that finds nobody signed in) forgets the
  // setup records: they name organizations and hold a prepared prompt.
  if (state.status.state === "signed-in" && status.state === "signed-out") forgetOtherSetups(null);
  followUser(status);
  set({ status, ready: true });
  scheduleRefresh(status);
}

/** Close one organization's cloud connections and drop what they cached in memory. */
function dropCloudOrg(orgId: string) {
  closeCloudConnectionsIn(orgId);
  closeWorkspaceConnectionsIn(orgId);
  dropCloudTerminalsIn(orgId);
  resetCloudFilesIn(orgId);
  dropCloudAgentsIn(orgId);
  dropCollabIn(orgId);
  const prefix = `cloud:${orgId}:`;
  dropEditors((entry) => !!entry.source && (entry.source.startsWith(prefix) || entry.sessionId.startsWith(prefix)));
}

const CLOUD_PREFS = ["cloudPinned", "cloudProjects", "cloudBlankProjects"] as const;

/** Drop the per-organization cloud prefs of organizations `keep` does not name. */
function pruneCloudPrefs(keep: (orgId: string) => boolean) {
  const prefs = getPrefs();
  const patch: Partial<Record<(typeof CLOUD_PREFS)[number], Record<string, string[]>>> = {};
  for (const key of CLOUD_PREFS) {
    const current = prefs[key] ?? {};
    if (Object.keys(current).every(keep)) continue;
    patch[key] = Object.fromEntries(Object.entries(current).filter(([orgId]) => keep(orgId)));
  }
  if (Object.keys(patch).length) setPrefs(patch);
}

/** What is left of an organization the user left: its pending creates (with their prompts) and its sidebar prefs. */
function forgetCloudOrg(orgId: string, user: string | null) {
  forgetPendingCreates((_user, organizationId) => organizationId === orgId);
  if (user) forgetSetups(user, (organizationId) => organizationId === orgId);
  pruneCloudPrefs((id) => id !== orgId);
}

/** Organizations the same signed-in account was a member of and no longer is. Unknown lists count as unchanged. */
export function leftMemberships(before: AccountStatus, after: AccountStatus): string[] {
  if (before.state !== "signed-in" || after.state !== "signed-in" || !before.organizations || !after.organizations) return [];
  if (before.identity?.email !== after.identity?.email) return [];
  const members = new Set(after.organizations.map((org) => org.id));
  if (after.identity?.organizationId) members.add(after.identity.organizationId);
  return before.organizations.map((org) => org.id).filter((orgId) => !members.has(orgId));
}

const LAST_USER_KEY = "terminalx.cloud.lastUser";

/**
 * Scope pending creates to the signed-in user, and when a different user
 * signs in on this Mac, remove the previous user's pending creates and the
 * sidebar prefs of organizations the new user is not a member of. Signing
 * out removes nothing: the same user may sign in again.
 */
function followUser(status: AccountStatus) {
  const user = status.state === "signed-in" ? (status.identity?.email ?? null) : null;
  setPendingCreateUser(user);
  if (!user) return;
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_USER_KEY);
  } catch {
    /* storage unavailable */
  }
  if (last === user) return;
  // Pending creates of anyone else (and unscoped ones from before) go, and
  // so do their organization setup records.
  forgetPendingCreates((owner) => last !== null && owner !== user);
  if (last !== null) forgetOtherSetups(user);
  if (last !== null && status.organizations) {
    const members = new Set(status.organizations.map((org) => org.id));
    pruneCloudPrefs((orgId) => members.has(orgId));
  }
  try {
    localStorage.setItem(LAST_USER_KEY, user);
  } catch {
    /* storage unavailable */
  }
}

function scopeOf(status: AccountStatus): string | null {
  return status.state === "signed-in" ? (status.context?.scope ?? null) : null;
}

/**
 * What a status change means for cloud state. Without the capability on
 * either side, today's rule: any change of the scope (user, profile or
 * default organization) drops everything. With it on both sides, only a new
 * user or profile drops everything, and an organization that left the
 * membership list is dropped alone.
 */
export function cloudChange(before: AccountStatus, after: AccountStatus): { kind: "all" } | { kind: "orgs"; left: string[] } {
  const account = (status: AccountStatus) => status.context?.account ?? status.context?.scope ?? null;
  const both = isMultiOrg(before) && isMultiOrg(after);
  if (both ? account(before) !== account(after) : scopeOf(before) !== scopeOf(after)) return { kind: "all" };
  // Organizations no longer kept: one the user left, or (the server dropped
  // the capability) every one but the default. Without the capability on
  // either side and the same scope, nothing is left.
  const kept = keptCloudOrgs(after);
  return { kind: "orgs", left: [...keptCloudOrgs(before)].filter((orgId) => !kept.has(orgId)) };
}

function scheduleRefresh(status: AccountStatus) {
  if (typeof window === "undefined") return;
  if (refreshTimer != null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
  if (status.state !== "signed-in" || status.expiresAt == null) return;

  const untilRefresh = status.expiresAt - Date.now() - 60_000;
  // An offline expired session remains visible and retries gently rather than
  // turning a transient network failure into a local sign-out.
  const delay = Math.min(Math.max(untilRefresh, 60_000), 2_147_000_000);
  refreshTimer = window.setTimeout(() => void refreshAccount(), delay);
}

/** For stores outside React (the cloud catalog). */
export function getAccount(): AccountState {
  return state;
}

export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccount(): AccountState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

let booted: Promise<void> | null = null;
export function bootAccount(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<AccountStatus>("account_status", (event) => applyStatus(event.payload));
      applyStatus(await api.accountStatus());
      // The saved session's organizations and roles are as old as its last
      // token refresh (or the last launch): read them again, without holding up the first paint.
      void refreshAccountRoles(true);
      // A silent token refresh can bring new organizations, capabilities or a
      // new active organization; the native side announces it, and a focus
      // re-reads it too, in case an announcement was missed.
      if (typeof window !== "undefined") window.addEventListener("focus", refreshOnFocus);
    } catch (error) {
      set({ status: { ...signedOut, lastError: errorMessage(error) }, ready: true });
    }
  })());
}

const FOCUS_REFRESH_MS = 5_000;
let lastFocusRefresh = 0;
function refreshOnFocus() {
  const now = Date.now();
  if (now - lastFocusRefresh < FOCUS_REFRESH_MS) return;
  lastFocusRefresh = now;
  // The status, and (at most once a minute, throttled natively) the
  // organizations and roles from the server.
  void refreshAccountRoles();
}

// ---- Organizations and roles ------------------------------------------------

/** When the roles the server last answered with were asked for. */
let rolesAskedAt = 0;
let rolesFlight: Promise<void> | null = null;
let rolesFlightFresh = false;

export function refreshAccountRoles(force = false, now: () => number = Date.now): Promise<void> {
  if (rolesFlight) {
    // A forced read that found a throttled one running asks again after it.
    const running = rolesFlight;
    return force ? running.then(() => (rolesFlightFresh ? undefined : refreshAccountRoles(true, now))) : running;
  }
  const askedAt = now();
  const flight: Promise<void> = api
    .accountRefreshRoles(force)
    .then((result) => {
      rolesFlightFresh = result?.fresh === true;
      if (!result?.status) return;
      if (rolesFlightFresh) {
        rolesAskedAt = askedAt;
        // The server's answer is newer than what any earlier list implied.
        for (const [orgId, hint] of roleHints) if (hint.at <= askedAt) roleHints.delete(orgId);
      }
      applyStatus(result.status);
    })
    .catch(() => {
      // The roles shown stay the last known ones; the next trigger asks again.
      rolesFlightFresh = false;
    })
    .finally(() => {
      if (rolesFlight === flight) rolesFlight = null;
    });
  rolesFlight = flight;
  return flight;
}

/** Per organization, what a workspace list newer than the account's roles says: whether this person manages it. */
const roleHints = new Map<string, { manages: boolean; at: number }>();

/** The status with the role a newer workspace list implies, until the account service is read again. */
function withRoleHints(status: AccountStatus): AccountStatus {
  if (status.state !== "signed-in" || !status.organizations || !roleHints.size) return status;
  let changed = false;
  const organizations = status.organizations.map((org) => {
    const hint = roleHints.get(org.id);
    if (!hint || hint.at <= rolesAskedAt) return org;
    const manages = org.role === "owner" || org.role === "admin";
    if (manages === hint.manages) return org;
    changed = true;
    // Which of owner or admin a promotion made is the account service's to say; admin until it answers.
    return { ...org, role: hint.manages ? "admin" : "member" };
  });
  return changed ? { ...status, organizations } : status;
}

/**
 * What a workspace list says about this person's role (see `accountRoles`).
 * `askedAt` is when the list was asked for: a list older than the roles' own
 * answer says nothing new.
 */
export function noteListedOrgRole(orgId: string, manages: boolean | null, askedAt: number) {
  if (manages === null || askedAt <= rolesAskedAt) return;
  const known = mayStartCloudSessions(reported, orgId);
  if (known === null) return;
  if (known === manages) {
    if (roleHints.delete(orgId)) set({ status: withRoleHints(reported) });
    return;
  }
  roleHints.set(orgId, { manages, at: askedAt });
  set({ status: withRoleHints(reported) });
  void refreshAccountRoles(true);
}

// How the API layer (a refused call) and the catalog (a list) reach this store; see `accountRoles`.
registerAccountRoles({ refresh: (force) => refreshAccountRoles(force), listed: noteListedOrgRole });

let statusFlight: Promise<void> | null = null;
export function refreshAccount(): Promise<void> {
  if (statusFlight) return statusFlight;
  return (statusFlight = api
    .accountStatus()
    .then(applyStatus)
    .catch((error) => set({ status: { ...state.status, lastError: errorMessage(error) }, ready: true }))
    .finally(() => {
      statusFlight = null;
      scheduleRefresh(state.status);
    }));
}

export async function signIn(): Promise<void> {
  set({ busy: true, status: { ...state.status, lastError: null } });
  try {
    applyStatus(await api.accountSignIn());
  } catch (error) {
    set({ status: { ...state.status, lastError: errorMessage(error) }, ready: true });
  } finally {
    set({ busy: false });
  }
}

export async function signOut(): Promise<void> {
  set({ busy: true });
  try {
    applyStatus(await api.accountSignOut());
  } catch (error) {
    set({ status: { ...state.status, lastError: errorMessage(error) } });
  } finally {
    set({ busy: false });
  }
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
