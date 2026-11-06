import { useEffect, useSyncExternalStore } from "react";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { cachedOrganizationRosters, readOrganizationRoster, resetOrganizationRosters, subscribeOrganizationRosters } from "@/lib/organizationRoster";

/**
 * Names for the user ids a shared cloud workspace reports (presence, notes,
 * leases, terminal controllers, follow-ups): from the organization roster and
 * the workspace's share list, else a short id.
 */
const known = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

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

/** Compatibility for name-only consumers; all surfaces share the roster store. */
export async function loadRoster(options: { fresh?: boolean } = {}): Promise<OrganizationMember[]> {
  try { return (await readOrganizationRoster(null, { ...options, active: true })).members; }
  catch { return []; }
}

export async function loadRosterIn(orgId: string, options: { fresh?: boolean } = {}): Promise<OrganizationMember[]> {
  return (await readOrganizationRoster(orgId, options)).members;
}

subscribeOrganizationRosters(changed);

export function personName(userId: string | null | undefined): string {
  if (!userId) return "Someone";
  const member = cachedOrganizationRosters().flatMap((roster) => roster.members).find((person) => person.userId === userId);
  return member?.displayName?.trim() || member?.email || known.get(userId) || `User ${userId.slice(0, 8)}`;
}

/** Forget names and the roster (sign-out, organization switch, tests). */
export function resetPeople() {
  known.clear();
  resetOrganizationRosters();
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
