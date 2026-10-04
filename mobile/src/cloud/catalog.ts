import { CloudApiError, type CloudApi, type CloudOrganization, type CloudWorkspace, type CloudWorkspaceItem } from "./api";
import { keyItemName, type SecretStorage } from "./keys";
import type { CloudLinkOptions } from "./link";
import type { BlobStorage } from "./transcripts";
import { CloudWorkspaceSession } from "./workspace";

/**
 * The cloud organizations and workspaces of the signed-in account, as the
 * phone lists them, and the open workspace sessions.
 *
 * Reading the list never starts compute: it is one GET per organization.
 * What the list says is what the server lets this person see, so a private
 * workspace not shared with them is simply not here.
 *
 * The list also decides what this phone may keep. A workspace the server
 * says is deleted, no longer lists for this person, or lists with role
 * `none` (a share was revoked on a workspace the organization can still
 * see) has its key, its cached transcripts and its outbox removed from the
 * phone, and its open session closed, at once. A list that could not be read
 * removes nothing.
 *
 * While an open workspace is changing state (starting, stopping, or asked to
 * start by a message) the list is read every few seconds until it settles,
 * so the screen goes live by itself. Reading the list starts nothing.
 */

export interface CatalogOrganization {
  organization: CloudOrganization;
  /** Newest activity first; archived and deleted ones are not listed. */
  workspaces: CloudWorkspaceItem[];
  /** Why this organization's list could not be read just now (a code); what was shown stays. */
  error: string | null;
  loaded: boolean;
}

export interface CatalogSnapshot {
  organizations: CatalogOrganization[];
  loading: boolean;
  /** Why the organizations themselves could not be read (a code). */
  error: string | null;
  refreshedAt: number | null;
}

/** Storage that can also name what it holds, to forget a workspace's items. */
export interface CatalogStorage extends BlobStorage {
  getAllKeys(): Promise<readonly string[]>;
}

export interface CloudCatalogOptions {
  api: CloudApi;
  secrets: SecretStorage;
  storage: CatalogStorage;
  /** A stable, non-secret name for this phone's attachments. */
  clientInstallationId: string;
  appVersion: string;
  link?: Partial<Pick<CloudLinkOptions, "createSocket" | "random" | "now">>;
  now?: () => number;
}

/** Which workspaces have data on this phone. Kept beside the keys, so that it survives exactly what they survive (a reinstall). */
const HELD = "terminalx.cloud.held.v1";
/** How often the list is read while an open workspace is changing, and for how long at most. */
export const CHANGING_POLL_MS = 3_000;
export const CHANGING_POLL_LIMIT_MS = 10 * 60_000;
/** Why a workspace that was open is not available any more. */
export type CloudAccess = "ok" | "not-shared" | "deleted" | "gone" | "unknown";
const sessionKey = (orgId: string, workspaceId: string) => `${orgId}\0${workspaceId}`;
/** Everything this phone keeps for a workspace in plain storage starts with one of these. */
const blobPrefixes = (orgId: string, workspaceId: string) => [`terminalx:cloud-checkpoint:${orgId}:${workspaceId}:`, `terminalx:cloud-outbox:${orgId}:${workspaceId}`];

export class CloudCatalog {
  private organizations: CatalogOrganization[] = [];
  private loading = false;
  private error: string | null = null;
  private refreshedAt: number | null = null;
  private snapshot: CatalogSnapshot = { organizations: [], loading: false, error: null, refreshedAt: null };
  private readonly listeners = new Set<() => void>();
  private readonly sessions = new Map<string, CloudWorkspaceSession>();
  private readonly retained = new Map<string, number>();
  private flight: Promise<void> | null = null;
  private closed = false;
  private paused = false;
  private readonly deleted = new Set<string>();
  private changingTimer: ReturnType<typeof setTimeout> | null = null;
  private changingSince: number | null = null;
  /** One change to the held list at a time. */
  private heldChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CloudCatalogOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CatalogSnapshot => this.snapshot;

  workspace(orgId: string, workspaceId: string): CloudWorkspace | null {
    return this.organizations.find((entry) => entry.organization.orgId === orgId)?.workspaces.find((item) => item.workspace.id === workspaceId)?.workspace ?? null;
  }

  /**
   * Whether this person may open the workspace, by the last list: `ok`,
   * `not-shared` (listed, role `none`), `deleted`, `gone` (no longer listed:
   * access was taken away), or `unknown` while its organization has not been read.
   */
  access(orgId: string, workspaceId: string): CloudAccess {
    const organization = this.organizations.find((entry) => entry.organization.orgId === orgId);
    const workspace = organization?.workspaces.find((item) => item.workspace.id === workspaceId)?.workspace;
    if (workspace) return notShared(workspace) ? "not-shared" : "ok";
    if (this.deleted.has(sessionKey(orgId, workspaceId))) return "deleted";
    if (organization ? organization.loaded : this.refreshedAt !== null) return "gone";
    return "unknown";
  }

  /** Read the list now; true when `orgId`'s workspaces were read, so what `workspace()` says is current. */
  async fresh(orgId: string): Promise<boolean> {
    await this.refresh();
    const organization = this.organizations.find((entry) => entry.organization.orgId === orgId);
    return this.error === null && !!organization && organization.loaded && organization.error === null;
  }

  /** The app left the foreground: every connection is let go, and nothing is read until it is back. */
  pause(): void {
    this.paused = true;
    if (this.changingTimer) clearTimeout(this.changingTimer);
    this.changingTimer = null;
    for (const session of this.sessions.values()) session.pause();
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    for (const session of this.sessions.values()) session.resume();
    void this.refresh();
  }

  /** Read the organizations and each one's workspaces. One read at a time. */
  refresh(): Promise<void> {
    return (this.flight ??= this.read().finally(() => {
      this.flight = null;
    }));
  }

  /** The session for a listed workspace, started on first use. */
  session(orgId: string, workspaceId: string): CloudWorkspaceSession {
    const key = sessionKey(orgId, workspaceId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new CloudWorkspaceSession({
        scope: { organizationId: orgId, workspaceId },
        api: this.options.api,
        secrets: this.options.secrets,
        storage: this.options.storage,
        listed: () => this.workspace(orgId, workspaceId),
        refreshList: () => this.fresh(orgId),
        clientInstallationId: this.options.clientInstallationId,
        appVersion: this.options.appVersion,
        link: this.options.link,
      });
      this.sessions.set(key, session);
      void this.remember(orgId, workspaceId);
      // A message sent, or a state learned, may mean the list should be followed for a while.
      session.subscribe(() => this.followChanges());
      void session.start();
    }
    return session;
  }

  /** The session of a workspace some screen is showing; null when none is. */
  opened(orgId: string, workspaceId: string): CloudWorkspaceSession | null {
    return this.sessions.get(sessionKey(orgId, workspaceId)) ?? null;
  }

  /**
   * A screen shows this workspace: its session exists until the last such
   * screen lets go (the returned function), and then its connection is closed.
   */
  retain(orgId: string, workspaceId: string): () => void {
    const key = sessionKey(orgId, workspaceId);
    this.retained.set(key, (this.retained.get(key) ?? 0) + 1);
    this.session(orgId, workspaceId);
    this.publish();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.retained.get(key) ?? 1) - 1;
      if (left > 0) return void this.retained.set(key, left);
      this.retained.delete(key);
      this.release(orgId, workspaceId);
      this.publish();
    };
  }

  /** Let go of a workspace's connection (its screen closed). What is kept stays. */
  release(orgId: string, workspaceId: string): void {
    const key = sessionKey(orgId, workspaceId);
    this.sessions.get(key)?.close();
    this.sessions.delete(key);
  }

  /** Signed out: close everything and remove every key, transcript and outbox from the phone. */
  async signOut(): Promise<void> {
    this.closed = true;
    if (this.changingTimer) clearTimeout(this.changingTimer);
    this.changingTimer = null;
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    for (const [orgId, workspaceId] of await this.held()) await this.forget(orgId, workspaceId);
    await this.options.secrets.delete(HELD).catch(() => undefined);
    this.organizations = [];
    this.publish();
  }

  /** The app went away for now: connections are closed, nothing is forgotten. */
  close(): void {
    this.closed = true;
    if (this.changingTimer) clearTimeout(this.changingTimer);
    this.changingTimer = null;
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private async read(): Promise<void> {
    this.loading = true;
    this.publish();
    let organizations: CloudOrganization[];
    try {
      organizations = await this.options.api.organizations();
    } catch (error) {
      if (this.closed) return;
      this.error = error instanceof CloudApiError ? error.code : "cloud_workspace_unavailable";
      this.loading = false;
      this.publish();
      return;
    }
    const results = await Promise.all(
      organizations.map(async (organization): Promise<CatalogOrganization & { gone: string[] | null }> => {
        const before = this.organizations.find((entry) => entry.organization.orgId === organization.orgId);
        try {
          const list = await this.options.api.workspaces(organization.orgId);
          const workspaces = list.workspaces.filter((item) => !item.workspace.deletedAt).sort((left, right) => (right.workspace.lastActivityAt ?? 0) - (left.workspace.lastActivityAt ?? 0));
          for (const tombstone of list.tombstones) this.deleted.add(sessionKey(organization.orgId, tombstone.id));
          for (const item of list.workspaces) if (item.workspace.deletedAt) this.deleted.add(sessionKey(organization.orgId, item.workspace.id));
          return { organization, workspaces, error: null, loaded: true, gone: list.tombstones.map((tombstone) => tombstone.id) };
        } catch (error) {
          // Not read: what was shown stays, and nothing is concluded from the silence.
          return { organization, workspaces: before?.workspaces ?? [], error: error instanceof CloudApiError ? error.code : "cloud_workspace_unavailable", loaded: before?.loaded ?? false, gone: null };
        }
      }),
    );
    if (this.closed) return;
    this.organizations = results.map(({ gone: _gone, ...entry }) => entry);
    this.error = null;
    this.loading = false;
    this.refreshedAt = (this.options.now ?? Date.now)();
    this.publish();

    // What this phone keeps for workspaces it may no longer open goes away:
    // deleted ones, ones no longer listed for this person, ones listed with
    // role `none`, and organizations the account left. Only where the list
    // was actually read.
    const read = new Map(results.filter((entry) => entry.gone !== null).map((entry) => [entry.organization.orgId, new Map(entry.workspaces.map((item) => [item.workspace.id, item.workspace]))]));
    const member = new Set(organizations.map((organization) => organization.orgId));
    const mayKeep = (orgId: string, workspaceId: string) => {
      if (!member.has(orgId)) return false;
      const listed = read.get(orgId);
      if (!listed) return true;
      const workspace = listed.get(workspaceId);
      return !!workspace && !notShared(workspace);
    };
    // Open sessions first, whether or not anything was kept for them: the screen is cleared before the storage is.
    for (const [key, session] of [...this.sessions]) {
      const [orgId, workspaceId] = key.split("\0") as [string, string];
      if (mayKeep(orgId, workspaceId)) continue;
      this.sessions.delete(key);
      await session.purge();
    }
    this.publish();
    for (const [orgId, workspaceId] of await this.held()) if (!mayKeep(orgId, workspaceId)) await this.forget(orgId, workspaceId);
    for (const session of this.sessions.values()) session.listChanged();
    this.followChanges();
  }

  /** Read the list again shortly while an open workspace is changing; stop when all have settled, or after the limit. */
  private followChanges(): void {
    if (this.closed || this.paused) return;
    const changing = [...this.sessions.values()].some((session) => session.changing);
    if (!changing) {
      this.changingSince = null;
      if (this.changingTimer) clearTimeout(this.changingTimer);
      this.changingTimer = null;
      return;
    }
    const now = (this.options.now ?? Date.now)();
    this.changingSince ??= now;
    if (this.changingTimer || now - this.changingSince > CHANGING_POLL_LIMIT_MS) return;
    this.changingTimer = setTimeout(() => {
      this.changingTimer = null;
      void this.refresh();
    }, CHANGING_POLL_MS);
  }

  private async held(): Promise<[string, string][]> {
    try {
      const raw = await this.options.secrets.get(HELD);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((entry): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") : [];
    } catch {
      return [];
    }
  }

  /** Read, change and write the held list as one step, so two changes never lose one another. */
  private changeHeld(change: (held: [string, string][]) => [string, string][] | null): Promise<void> {
    const next = this.heldChain.then(async () => {
      const changed = change(await this.held());
      if (changed) await this.options.secrets.set(HELD, JSON.stringify(changed)).catch(() => undefined);
    });
    this.heldChain = next.catch(() => undefined);
    return next;
  }

  private remember(orgId: string, workspaceId: string): Promise<void> {
    return this.changeHeld((held) => (held.some(([org, workspace]) => org === orgId && workspace === workspaceId) ? null : [...held, [orgId, workspaceId]]));
  }

  private async forget(orgId: string, workspaceId: string): Promise<void> {
    await this.options.secrets.delete(keyItemName({ organizationId: orgId, workspaceId })).catch(() => undefined);
    const prefixes = blobPrefixes(orgId, workspaceId);
    const names = await this.options.storage.getAllKeys().catch(() => [] as readonly string[]);
    await Promise.all(names.filter((name) => prefixes.some((prefix) => name.startsWith(prefix))).map((name) => this.options.storage.removeItem(name).catch(() => undefined)));
    await this.changeHeld((held) => held.filter(([org, workspace]) => !(org === orgId && workspace === workspaceId)));
  }

  private publish(): void {
    this.snapshot = { organizations: this.organizations, loading: this.loading, error: this.error, refreshedAt: this.refreshedAt };
    for (const listener of [...this.listeners]) listener();
  }
}

/** Listed, but not shared with this person: role `none` from a server that keeps a member list (`listed` is not false). */
function notShared(workspace: CloudWorkspace): boolean {
  const you = workspace.you as ({ role?: string; listed?: boolean } & Record<string, unknown>) | null | undefined;
  return you?.role === "none" && you.listed !== false;
}
