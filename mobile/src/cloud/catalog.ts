import { CloudApiError, type CloudApi, type CloudOrganization, type CloudWorkspace, type CloudWorkspaceItem } from "./api";
import { CloudPeople } from "./people";
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
 * says is deleted, or no longer lists for this person (access removed), has
 * its key, its cached transcripts and its outbox removed from the phone. A
 * list that could not be read removes nothing.
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

const HELD = "terminalx:cloud-held:v1";
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

  /** Names for the user ids a shared workspace reports. */
  readonly people: CloudPeople;

  constructor(private readonly options: CloudCatalogOptions) {
    this.people = new CloudPeople(options.api);
  }

  get api(): CloudApi {
    return this.options.api;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CatalogSnapshot => this.snapshot;

  workspace(orgId: string, workspaceId: string): CloudWorkspace | null {
    return this.organizations.find((entry) => entry.organization.orgId === orgId)?.workspaces.find((item) => item.workspace.id === workspaceId)?.workspace ?? null;
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
        clientInstallationId: this.options.clientInstallationId,
        appVersion: this.options.appVersion,
        // A share revoked while this phone was connected: the list says so, and what is kept here goes.
        onRefused: () => void this.refresh(),
        link: this.options.link,
      });
      this.sessions.set(key, session);
      void this.remember(orgId, workspaceId);
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
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    for (const [orgId, workspaceId] of await this.held()) await this.forget(orgId, workspaceId);
    await this.options.storage.removeItem(HELD).catch(() => undefined);
    this.organizations = [];
    this.publish();
  }

  /** The app went away for now: connections are closed, nothing is forgotten. */
  close(): void {
    this.closed = true;
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

    // What this phone keeps for workspaces it may no longer see goes away:
    // deleted ones, ones no longer listed for this person, and organizations
    // the account left. Only where the list was actually read.
    const read = new Map(results.filter((entry) => entry.gone !== null).map((entry) => [entry.organization.orgId, new Set(entry.workspaces.map((item) => item.workspace.id))]));
    const member = new Set(organizations.map((organization) => organization.orgId));
    for (const [orgId, workspaceId] of await this.held()) {
      const listed = read.get(orgId);
      if (member.has(orgId) && (!listed || listed.has(workspaceId))) continue;
      const key = sessionKey(orgId, workspaceId);
      const session = this.sessions.get(key);
      this.sessions.delete(key);
      if (session) await session.purge();
      await this.forget(orgId, workspaceId);
    }
    for (const session of this.sessions.values()) session.listChanged();
  }

  private async held(): Promise<[string, string][]> {
    try {
      const raw = await this.options.storage.getItem(HELD);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((entry): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") : [];
    } catch {
      return [];
    }
  }

  private async remember(orgId: string, workspaceId: string): Promise<void> {
    const held = await this.held();
    if (held.some(([org, workspace]) => org === orgId && workspace === workspaceId)) return;
    await this.options.storage.setItem(HELD, JSON.stringify([...held, [orgId, workspaceId]])).catch(() => undefined);
  }

  private async forget(orgId: string, workspaceId: string): Promise<void> {
    await this.options.secrets.delete(keyItemName({ organizationId: orgId, workspaceId })).catch(() => undefined);
    const prefixes = blobPrefixes(orgId, workspaceId);
    const names = await this.options.storage.getAllKeys().catch(() => [] as readonly string[]);
    await Promise.all(names.filter((name) => prefixes.some((prefix) => name.startsWith(prefix))).map((name) => this.options.storage.removeItem(name).catch(() => undefined)));
    const held = (await this.held()).filter(([org, workspace]) => !(org === orgId && workspace === workspaceId));
    await this.options.storage.setItem(HELD, JSON.stringify(held)).catch(() => undefined);
  }

  private publish(): void {
    this.snapshot = { organizations: this.organizations, loading: this.loading, error: this.error, refreshedAt: this.refreshedAt };
    for (const listener of [...this.listeners]) listener();
  }
}
