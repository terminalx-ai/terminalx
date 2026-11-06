import { useCallback, useSyncExternalStore } from "react";
import { organizationMembers, type OrganizationRoster } from "@/lib/organizationMembers";

/** Shared in memory only: member details never survive sign-out. */
export const ROSTER_MAX_AGE_MS = 60_000;
const ACTIVE = "@active";
const EMPTY: RosterSnapshot = { roster: null, loading: false, error: null };
interface RosterSnapshot {
  roster: OrganizationRoster | null;
  loading: boolean;
  error: unknown;
}
interface ReadOptions { fresh?: boolean; active?: boolean; contextRevision?: string }
interface Entry {
  snapshot: RosterSnapshot;
  updatedAt: number;
  sequence: number;
  generation: number;
  request?: Promise<OrganizationRoster>;
  contextRevision?: string;
  options: ReadOptions;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
}
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let activeOrg: string | null = null;
let activeRevision = "";
let enabledOrganizations = new Set<string>();
const keyOf = (orgId?: string | null) => orgId || activeOrg || ACTIVE;

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: EMPTY, updatedAt: 0, sequence: 0, generation: 0, options: {}, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}
function publish(entry: Entry, snapshot: RosterSnapshot) {
  entry.snapshot = snapshot;
  for (const listener of [...entry.listeners, ...listeners]) listener();
}
export function subscribeOrganizationRosters(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function cachedOrganizationRosters(): OrganizationRoster[] {
  return [...entries.values()].flatMap((entry) => entry.snapshot.roster ? [entry.snapshot.roster] : []);
}

export function rosterCacheEnabled(orgId?: string | null): boolean {
  return enabledOrganizations.has(keyOf(orgId));
}

/** Account refreshes reconcile rollout kills even when the context revision is unchanged. */
export function setRosterContext(orgId: string | null, revision: string, enabledOrgIds: readonly string[] = []) {
  const contextChanged = activeOrg !== orgId || activeRevision !== revision;
  const previous = enabledOrganizations;
  enabledOrganizations = new Set(enabledOrgIds);
  activeOrg = orgId;
  activeRevision = revision;
  for (const [key, entry] of entries) {
    if (!rosterCacheEnabled(key)) {
      forgetOrganizationRoster(key);
      continue;
    }
    if (!contextChanged && previous.has(key)) continue;
    entry.generation++;
    entry.contextRevision = undefined;
    entry.sequence++;
    entry.request = undefined;
    entry.updatedAt = 0;
    entry.options = { active: key === orgId || key === ACTIVE, contextRevision: revision };
    if (entry.listeners.size) void readOrganizationRoster(key, entry.options).catch(() => {});
  }
}

export function readOrganizationRoster(orgId?: string | null, options: ReadOptions = {}): Promise<OrganizationRoster> {
  const key = keyOf(orgId);
  const active = options.active ?? (key === activeOrg || key === ACTIVE);
  if (!rosterCacheEnabled(key)) return active ? organizationMembers.list() : organizationMembers.listIn(key);
  const entry = entryFor(key);
  const generation = entry.generation;
  const contextRevision = active ? options.contextRevision ?? activeRevision : undefined;
  const compatible = !active || entry.contextRevision === contextRevision;
  if (!options.fresh && compatible) {
    if (entry.request) return entry.request;
    if (entry.snapshot.roster && Date.now() - entry.updatedAt < ROSTER_MAX_AGE_MS) return Promise.resolve(entry.snapshot.roster);
  }
  const sequence = ++entry.sequence;
  entry.options = { active, contextRevision };
  entry.contextRevision = contextRevision;
  const current = () => entries.get(key) === entry && entry.sequence === sequence;
  const superseded = (): OrganizationRoster | Promise<OrganizationRoster> => {
    if (entry.generation !== generation || !rosterCacheEnabled(key)) throw { code: "account_context_changed" };
    if (entry.request && entry.request !== request) return entry.request;
    if (entry.updatedAt > 0 && entry.snapshot.roster) return entry.snapshot.roster;
    throw { code: "organization_roster_superseded" };
  };
  const request: Promise<OrganizationRoster> = Promise.resolve()
    .then(() => active ? organizationMembers.list() : organizationMembers.listIn(key))
    .then((roster) => {
      if (!current()) return superseded();
      entry.updatedAt = Date.now();
      entry.request = undefined;
      publish(entry, { roster, loading: false, error: null });
      return roster;
    }, (error: unknown) => {
      if (!current()) return superseded();
      if (current()) {
        entry.request = undefined;
        // A refusal may mean membership ended: do not keep exposing old details.
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        const denied = ["forbidden", "not_found", "unauthorized", "account_signed_out", "cloud_organization_unavailable"].includes(String(code));
        publish(entry, { roster: denied ? null : entry.snapshot.roster, loading: false, error });
      }
      throw error;
    });
  entry.request = request;
  publish(entry, { ...entry.snapshot, loading: true, error: null });
  return request;
}

/** A mutation's authoritative result retires any older read. */
export function replaceOrganizationRoster(orgId: string | null | undefined, roster: OrganizationRoster, contextRevision: string) {
  if (!rosterCacheEnabled(orgId)) return;
  const entry = entryFor(keyOf(orgId));
  entry.sequence++;
  entry.request = undefined;
  entry.updatedAt = Date.now();
  entry.contextRevision = contextRevision;
  publish(entry, { roster, loading: false, error: null });
}

/** Reconcile committed changes independently of the Members component's lifetime. */
export async function mutateOrganizationRoster(orgId: string | null | undefined, contextRevision: string, run: () => Promise<OrganizationRoster>) {
  const key = keyOf(orgId);
  const entry = entryFor(key);
  const generation = entry.generation;
  const current = () => entry.generation === generation && rosterCacheEnabled(key);
  try {
    const roster = await run();
    if (current()) replaceOrganizationRoster(key, roster, contextRevision);
    return roster;
  } catch (error) {
    if (current()) invalidateOrganizationRoster(key);
    throw error;
  }
}

/** Membership/access events refresh mounted consumers and expire idle caches. */
export function invalidateOrganizationRoster(orgId: string) {
  if (!rosterCacheEnabled(orgId)) return;
  const entry = entries.get(keyOf(orgId));
  if (!entry) return;
  entry.updatedAt = 0;
  entry.sequence++;
  entry.request = undefined;
  if (entry.listeners.size) void readOrganizationRoster(orgId, { ...entry.options, fresh: true }).catch(() => {});
}
export function forgetOrganizationRoster(orgId: string) {
  const entry = entries.get(keyOf(orgId));
  if (!entry) return;
  entry.generation++;
  entry.sequence++;
  entry.request = undefined;
  entry.updatedAt = 0;
  if (entry.timer) { clearInterval(entry.timer); entry.timer = undefined; }
  publish(entry, EMPTY);
}
export function resetOrganizationRosters() {
  enabledOrganizations.clear();
  for (const entry of entries.values()) {
    entry.generation++;
    if (entry.timer) { clearInterval(entry.timer); entry.timer = undefined; }
    entry.sequence++;
    entry.request = undefined;
    entry.updatedAt = 0;
    entry.contextRevision = undefined;
    publish(entry, EMPTY);
  }
  activeOrg = null;
  activeRevision = "";
}
export function useOrganizationRoster(orgId?: string | null, enabled = true): RosterSnapshot {
  const key = keyOf(orgId);
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled || !rosterCacheEnabled(key)) return () => {};
    const entry = entryFor(key);
    entry.listeners.add(listener);
    if (!entry.timer) entry.timer = setInterval(() => {
      if (rosterCacheEnabled(key) && entry.snapshot.roster) void readOrganizationRoster(key, entry.options).catch(() => {});
    }, ROSTER_MAX_AGE_MS);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.timer) {
        clearInterval(entry.timer);
        entry.timer = undefined;
      }
    };
  }, [key, enabled]);
  return useSyncExternalStore(subscribe, () => enabled ? entries.get(key)?.snapshot ?? EMPTY : EMPTY, () => EMPTY);
}
