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
const keyOf = (orgId?: string | null) => orgId || activeOrg || ACTIVE;

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: EMPTY, updatedAt: 0, sequence: 0, options: {}, listeners: new Set() };
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

/** Called by the account store before publishing a new account context. */
export function setRosterContext(orgId: string | null, revision: string) {
  if (activeOrg === orgId && activeRevision === revision) return;
  activeOrg = orgId;
  activeRevision = revision;
  for (const [key, entry] of entries) {
    // Context revisions authorize mutations only in the context that read them.
    entry.contextRevision = undefined;
    entry.sequence++;
    entry.request = undefined;
    entry.updatedAt = 0;
    entry.options = { active: key === orgId || key === ACTIVE, contextRevision: revision };
    if (orgId && entry.listeners.size) void readOrganizationRoster(key, entry.options).catch(() => {});
  }
}

export function readOrganizationRoster(orgId?: string | null, options: ReadOptions = {}): Promise<OrganizationRoster> {
  const key = keyOf(orgId);
  const entry = entryFor(key);
  const active = options.active ?? (key === activeOrg || key === ACTIVE);
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
  const request = Promise.resolve()
    .then(() => active ? organizationMembers.list() : organizationMembers.listIn(key))
    .then((roster) => {
      if (!current()) throw { code: "account_context_changed" };
      entry.updatedAt = Date.now();
      entry.request = undefined;
      publish(entry, { roster, loading: false, error: null });
      return roster;
    }, (error: unknown) => {
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
  const entry = entryFor(keyOf(orgId));
  entry.sequence++;
  entry.request = undefined;
  entry.updatedAt = Date.now();
  entry.contextRevision = contextRevision;
  publish(entry, { roster, loading: false, error: null });
}

/** Membership/access events refresh mounted consumers and expire idle caches. */
export function invalidateOrganizationRoster(orgId: string) {
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
  entry.sequence++;
  entry.request = undefined;
  entry.updatedAt = 0;
  publish(entry, EMPTY);
}
export function resetOrganizationRosters() {
  for (const entry of entries.values()) {
    entry.sequence++;
    entry.request = undefined;
    entry.updatedAt = 0;
    entry.contextRevision = undefined;
    publish(entry, EMPTY);
  }
  activeOrg = null;
  activeRevision = "";
}
export function useOrganizationRoster(orgId?: string | null): RosterSnapshot {
  const key = keyOf(orgId);
  const subscribe = useCallback((listener: () => void) => {
    const entry = entryFor(key);
    entry.listeners.add(listener);
    if (!entry.timer) entry.timer = setInterval(() => {
      if (entry.snapshot.roster) void readOrganizationRoster(key, entry.options).catch(() => {});
    }, ROSTER_MAX_AGE_MS);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.timer) {
        clearInterval(entry.timer);
        entry.timer = undefined;
      }
    };
  }, [key]);
  return useSyncExternalStore(subscribe, () => entries.get(key)?.snapshot ?? EMPTY, () => EMPTY);
}
