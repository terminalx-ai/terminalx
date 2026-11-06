import { useEffect, useSyncExternalStore } from "react";
import { organizationMembers, type OrganizationMember } from "@/lib/organizationMembers";
import { cachedOrganizationRosters, readOrganizationRoster, resetOrganizationRosters, rosterCacheEnabled, subscribeOrganizationRosters } from "@/lib/organizationRoster";

/**
 * Names for the user ids a shared cloud workspace reports (presence, notes,
 * leases, terminal controllers, follow-ups): from the organization roster and
 * the workspace's share list, else a short id.
 */
const known = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let roster: Promise<OrganizationMember[]> | null = null;
let epoch = 0;

function changed() {
  version++;
  for (const listener of [...listeners]) listener();
}

export function rememberPeople(people: { userId: string; name?: string | null; displayName?: string | null; email?: string | null }[]) {
  let any = false;
  for (const person of people) {
    const name = person.name?.trim() || person.displayName?.trim() || person.email?.trim();
    if (!name || known.get(person.userId) === name) continue;
    known.set(person.userId, name);
    any = true;
  }
  if (any) changed();
}

/**
 * The organization's members, loaded once per session (and remembered as
 * names). `fresh` reads them again: a list that offers people to share with
 * must not offer someone removed since (#501).
 */
export function loadRoster(options: { fresh?: boolean } = {}): Promise<OrganizationMember[]> {
  if (rosterCacheEnabled()) return readOrganizationRoster(null, { ...options, active: true }).then((listed) => listed.members, () => []);
  if (roster && !options.fresh) return roster;
  const current = epoch;
  const pending: Promise<OrganizationMember[]> = Promise.resolve()
    .then(() => organizationMembers.list())
    .then((listed) => {
      if (current !== epoch) return [];
      rememberPeople(listed?.members ?? []);
      return listed?.members ?? [];
    })
    .catch(() => {
      // Only this read is forgotten: a newer one that started meanwhile stays.
      if (roster === pending) roster = null;
      return [];
    });
  roster = pending;
  return pending;
}

/** Rosters of organizations other than the default one, per organization, for this session. */
const rosters = new Map<string, Promise<OrganizationMember[]>>();

/**
 * The members of the organization a workspace is in, which need not be the
 * default one (every organization is live, PRO-71), read once per session
 * unless `fresh`. Rejects with the reason when they cannot be read (an older
 * server, or the organization was left), so a dialog can say so instead of
 * offering nobody.
 */
export function loadRosterIn(orgId: string, options: { fresh?: boolean } = {}): Promise<OrganizationMember[]> {
  if (rosterCacheEnabled(orgId)) return readOrganizationRoster(orgId, options).then((listed) => listed.members);
  const current = epoch;
  let pending = options.fresh ? undefined : rosters.get(orgId);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => organizationMembers.listIn(orgId))
      .then((listed) => {
        if (current !== epoch) return [];
        rememberPeople(listed?.members ?? []);
        return listed?.members ?? [];
      });
    rosters.set(orgId, pending);
    pending.catch(() => {
      if (rosters.get(orgId) === pending) rosters.delete(orgId);
    });
  }
  return pending;
}

subscribeOrganizationRosters(changed);

export function personName(userId: string | null | undefined): string {
  if (!userId) return "Someone";
  const member = cachedOrganizationRosters().flatMap((roster) => roster.members).find((person) => person.userId === userId);
  return member?.displayName?.trim() || member?.email || known.get(userId) || `User ${userId.slice(0, 8)}`;
}

/** Forget names and the roster (sign-out, organization switch, tests). */
export function resetPeople() {
  epoch++;
  known.clear();
  resetOrganizationRosters();
  roster = null;
  rosters.clear();
  changed();
}

/**
 * A name resolver that re-renders when more names become known. `load`
 * false: names already known only (a local session never fetches a roster).
 */
export function usePeople(load = true): (userId: string | null | undefined) => string {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  useEffect(() => {
    if (load) void loadRoster();
  }, [load]);
  return personName;
}

/** Up to two letters for an avatar. */
export function initials(name: string): string {
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
