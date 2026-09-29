import { useEffect, useSyncExternalStore } from "react";
import { organizationMembers, type OrganizationMember } from "@/lib/organizationMembers";

/**
 * Names for the user ids a shared cloud workspace reports (presence, notes,
 * leases, terminal controllers, follow-ups): from the organization roster and
 * the workspace's share list, else a short id.
 */
const known = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let roster: Promise<OrganizationMember[]> | null = null;

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

/** The organization's members, loaded once per session (and remembered as names). */
export function loadRoster(): Promise<OrganizationMember[]> {
  roster ??= Promise.resolve()
    .then(() => organizationMembers.list())
    .then((listed) => {
      rememberPeople(listed?.members ?? []);
      return listed?.members ?? [];
    })
    .catch(() => {
      roster = null;
      return [];
    });
  return roster;
}

export function personName(userId: string | null | undefined): string {
  if (!userId) return "Someone";
  return known.get(userId) ?? `User ${userId.slice(0, 8)}`;
}

/** Forget names and the roster (sign-out, organization switch, tests). */
export function resetPeople() {
  known.clear();
  roster = null;
  changed();
}

/** A name resolver that re-renders when more names become known. */
export function usePeople(): (userId: string | null | undefined) => string {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  useEffect(() => {
    void loadRoster();
  }, []);
  return personName;
}

/** Up to two letters for an avatar. */
export function initials(name: string): string {
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
