import type { CloudApi, CloudMember } from "./api";

/**
 * Names for the user ids a shared cloud workspace reports (presence, notes,
 * leases, shares): from the organization's member list and the workspace's
 * share list, else a short id. Kept in memory only.
 */
export class CloudPeople {
  private readonly names = new Map<string, string>();
  private readonly rosters = new Map<string, Promise<CloudMember[]>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly api: Pick<CloudApi, "members">) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever a name was learned. */
  getVersion = (): number => this.version;

  /** The organization's members, read once; rejects when they cannot be read, so a screen can say so. */
  roster(orgId: string): Promise<CloudMember[]> {
    let pending = this.rosters.get(orgId);
    if (!pending) {
      pending = this.api.members(orgId).then((members) => {
        this.remember(members);
        return members;
      });
      this.rosters.set(orgId, pending);
      pending.catch(() => {
        if (this.rosters.get(orgId) === pending) this.rosters.delete(orgId);
      });
    }
    return pending;
  }

  remember(people: { userId: string; name?: string | null; displayName?: string | null; email?: string | null }[]): void {
    let any = false;
    for (const person of people) {
      const name = person.name?.trim() || person.displayName?.trim() || person.email?.trim();
      if (!name || this.names.get(person.userId) === name) continue;
      this.names.set(person.userId, name);
      any = true;
    }
    if (!any) return;
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  name = (userId: string | null | undefined): string => {
    if (!userId) return "Someone";
    return this.names.get(userId) ?? `User ${userId.slice(0, 8)}`;
  };
}
