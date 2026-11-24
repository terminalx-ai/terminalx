import { phase2Ready } from "@/lib/phase2Readiness";
import { useSyncExternalStore } from "react";
import { api, type PresencePerson, type PresenceReadResponse, type PresencePutInput } from "./api";
import { getAccount, subscribeAccount } from "./account";
import { getCloudCatalog, liveCloudOrgIds, subscribeCloudCatalog } from "./cloudCatalog";
import { cloudConnectionInfo, liveCloudConnections, subscribeCloudConnections } from "./cloudConnections";
import { privacyEnabled, subscribeDataPrivacy } from "./dataPrivacy";
import { getSessionStore, subscribeSessionStore } from "./sessions";
import { parseCloudWorkspaceKey } from "@/types/target";

export const PRESENCE_INTERVAL_MS = 15_000;
export const PRESENCE_TTL_MS = 45_000;
export const PRESENCE_REQUEST_TIMEOUT_MS = 10_000;
function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Presence request timed out")), PRESENCE_REQUEST_TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
}
export type PresenceSnapshot = {
  state: "loading" | "live" | "stale" | "unavailable";
  at: number | null;
  activeMembers: PresencePerson[];
  workspaces: PresenceReadResponse["workspaces"];
};
const EMPTY: PresenceSnapshot = { state: "unavailable", at: null, activeMembers: [], workspaces: [] };
type Target = { orgId: string; workspaceId: string };
export interface PresenceTransport {
  put(orgId: string, input: PresencePutInput): Promise<unknown>;
  read(orgId: string, workspaceIds: string[]): Promise<PresenceReadResponse>;
}

/** Injected enabled mode is for local mocked acceptance. Production uses native readiness.
 * One UUID per attachment launch, one monotonically increasing safe sequence. No history. */
export class PresenceController {
  private scope: string | null = null;
  private generation = 0;
  private desired: Target | null = null;
  private launch: (Target & { deviceId: string; sequence: number; leaving: boolean }) | null = null;
  private writing = false;
  private retryAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private reads = new Map<string, number>();
  private readSequence = 0;
  private requests = new Map<string, string>();
  private snapshots = new Map<string, PresenceSnapshot>();
  private listeners = new Set<() => void>();
  version = 0;
  constructor(private transport: PresenceTransport, private now = Date.now, private uuid = () => crypto.randomUUID().toLowerCase()) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (orgId: string) => this.snapshots.get(orgId) ?? EMPTY;
  private publish(orgId: string, value: PresenceSnapshot) {
    this.version++;
    this.snapshots.set(orgId, value);
    for (const listener of this.listeners) listener();
  }
  setScope(scope: string | null) {
    if (scope === this.scope) return;
    ++this.generation;
    this.scope = scope; this.launch = null; this.desired = null; this.retryAt = 0;
    this.version++; this.reads.clear(); this.requests.clear(); this.snapshots.clear();
    for (const listener of this.listeners) listener();
    clearInterval(this.timer);
    if (scope) this.timer = setInterval(() => {
      for (const [orgId, ids] of this.requests) void this.refresh(orgId, JSON.parse(ids));
      void this.write();
    }, PRESENCE_INTERVAL_MS);
  }
  /** Stop while the captured auth context is still valid. Account changes instead use TTL. */
  leave() {
    this.desired = null;
    if (this.launch) this.launch.leaving = true;
    void this.write();
  }
  setTarget(target: Target | null) {
    if (this.desired?.orgId === target?.orgId && this.desired?.workspaceId === target?.workspaceId) return;
    this.desired = target;
    // Latch departure before write's in-flight/backoff guard. Returning to the
    // same workspace cannot cancel a queued leave or reuse that launch.
    if (this.launch && (!target || this.launch.orgId !== target.orgId || this.launch.workspaceId !== target.workspaceId)) this.launch.leaving = true;
    void this.write();
  }
  private async write() {
    if (!this.scope || this.writing || this.now() < this.retryAt) return;
    if (!this.launch && this.desired) {
      const deviceId = this.uuid();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deviceId)) throw new Error("Invalid launch UUID");
      this.launch = { ...this.desired, deviceId, sequence: 0, leaving: false };
    }
    const launch = this.launch;
    if (!launch) return;
    // Once a leave is sent it stays pending, even if selection returns to this workspace.
    // A late/uncertain leave must never resurrect the retired launch.
    const leaving = launch.leaving || !this.desired || launch.orgId !== this.desired.orgId || launch.workspaceId !== this.desired.workspaceId;
    launch.leaving = leaving;
    const generation = this.generation;
    if (!Number.isSafeInteger(launch.sequence + 1)) { this.desired = null; this.launch = null; return; }
    const input = { deviceId: launch.deviceId, sequence: ++launch.sequence, workspaceId: leaving ? null : launch.workspaceId };
    this.writing = true;
    try {
      await bounded(this.transport.put(launch.orgId, input));
      if (generation !== this.generation) return;
      if (leaving) this.launch = null;
    } catch (error) {
      if (generation !== this.generation) return;
      const seconds = error && typeof error === "object" && "retryAfterSeconds" in error ? Number(error.retryAfterSeconds) : 0;
      this.retryAt = this.now() + Math.max(PRESENCE_INTERVAL_MS, Number.isFinite(seconds) ? seconds * 1000 : 0);
      // A refused leave remains pending; never allocate a new UUID to evade backoff.
    } finally {
      this.writing = false;
      if (generation !== this.generation || (leaving && !this.launch) || (!leaving && launch.leaving)) void this.write();
    }
  }
  watch(orgId: string, workspaceIds: string[]) {
    const ids = JSON.stringify([...new Set(workspaceIds)].sort());
    if (this.requests.get(orgId) === ids) return;
    this.requests.set(orgId, ids);
    // Invalidate immediately: a removed/private workspace must not stay visible during a read.
    this.publish(orgId, { state: "loading", at: null, activeMembers: [], workspaces: [] });
    void this.refresh(orgId, JSON.parse(ids));
  }
  forget(orgId: string) { this.version++; this.requests.delete(orgId); this.reads.delete(orgId); this.snapshots.delete(orgId); for (const listener of this.listeners) listener(); }
  hint(orgId: string) { const ids = this.requests.get(orgId); if (ids) void this.refresh(orgId, JSON.parse(ids)); }
  private async refresh(orgId: string, ids: string[]) {
    if (!this.scope) return;
    const scope = this.generation;
    const sequence = ++this.readSequence;
    this.reads.set(orgId, sequence);
    const current = () => scope === this.generation && this.reads.get(orgId) === sequence && this.requests.has(orgId);
    const previous = this.snapshot(orgId);
    if (previous.at !== null && this.now() - previous.at >= PRESENCE_INTERVAL_MS) this.publish(orgId, { ...EMPTY, state: "stale" });
    try {
      const rows: PresenceReadResponse["workspaces"] = [];
      let activeMembers: PresencePerson[] = [];
      // Empty reads return the authorized aggregate. Each batch has at most 100 distinct IDs.
      for (let offset = 0; offset < Math.max(1, ids.length); offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const response = await bounded(this.transport.read(orgId, batch));
        if (!current()) return;
        if (response.ttlSeconds !== 45 || response.workspaces.some((row) => !batch.includes(row.workspaceId))) throw new Error("Invalid presence response");
        rows.push(...response.workspaces); activeMembers = response.activeMembers;
      }
      if (current()) this.publish(orgId, { state: "live", at: this.now(), activeMembers: [...new Map(activeMembers.map((person) => [person.userId, person])).values()], workspaces: rows });
    } catch {
      if (current()) this.publish(orgId, { ...EMPTY, state: "unavailable" });
    }
  }
  dispose() { this.leave(); this.setScope(null); }
}

export const cloudPresence = new PresenceController({
  put: (org, input) => api.desktopPresencePut(org, input),
  read: (org, workspaceIds) => api.desktopPresenceRead(org, { workspaceIds }),
});
export function useCloudPresenceVersion() { return useSyncExternalStore(cloudPresence.subscribe, () => cloudPresence.version, () => 0); }
export function useCloudPresence(orgId: string) { return useSyncExternalStore(cloudPresence.subscribe, () => cloudPresence.snapshot(orgId), () => EMPTY); }
let stop: (() => void) | null = null;
export function bootCloudPresence() {
  if (stop) return;
  let scope: string | null = null;
  let readyOrgs = new Set<string>();
  let watched = new Set<string>();
  const syncTarget = () => {
    if (!scope) return;
    const store = getSessionStore();
    const key = store.selectedCloudWorkspace ?? (store.selectedSessionId?.startsWith("cloud:") ? store.selectedSessionId.split(":").slice(0, 3).join(":") : null);
    const target = key ? parseCloudWorkspaceKey(key) : null;
    const connected = key && liveCloudConnections().includes(key) && cloudConnectionInfo(key).state === "connected";
    const org = target ? getCloudCatalog().orgs[target.orgId] : undefined;
    const authorized = org?.source === "live" && !org.error && org.workspaces.some((item) => item.workspace.id === target?.workspaceId);
    cloudPresence.setTarget(connected && target && readyOrgs.has(target.orgId) && authorized ? target : null);
  };
  const syncCatalog = () => {
    if (!scope) return;
    const catalog = getCloudCatalog();
    const orgs = [...readyOrgs].filter((org) => catalog.orgs[org]?.source === "live" && !catalog.orgs[org]?.error);
    for (const old of watched) if (!orgs.includes(old)) cloudPresence.forget(old);
    watched = new Set(orgs);
    for (const org of orgs) cloudPresence.watch(org, (catalog.orgs[org]?.workspaces ?? []).map((item) => item.workspace.id));
    syncTarget();
  };
  const sync = () => {
    const status = getAccount().status;
    const orgs = liveCloudOrgIds(status).filter((org) => phase2Ready(status, org, "presence")).sort();
    const next = !privacyEnabled() && status.context && orgs.length
      ? JSON.stringify([status.context.account, status.context.revision, orgs]) : null;
    if (next !== scope) {
      scope = next;
      readyOrgs = new Set(orgs);
      watched.clear();
      cloudPresence.setScope(next);
    }
    syncCatalog();
  };
  const subscriptions = [subscribeAccount(sync), subscribeDataPrivacy(sync), subscribeCloudCatalog(syncCatalog), subscribeCloudConnections(syncTarget), subscribeSessionStore(syncTarget)];
  const leave = () => cloudPresence.leave();
  window.addEventListener("pagehide", leave);
  stop = () => { scope = null; cloudPresence.dispose(); subscriptions.forEach((unsubscribe) => unsubscribe()); window.removeEventListener("pagehide", leave); stop = null; };
  sync();
}
export function resetCloudPresence() { stop?.(); }
