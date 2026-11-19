import { CloudApiError, SUPPORTED_PROVIDERS, type CloudApi, type CloudOrganization, type CloudWorkspace, type CloudWorkspaceItem } from "./api";
import { CloudPeople } from "./people";
import { listedAsStarting, mayBeUnderWay, resumeFailure, resumeLogDetail } from "./resume";
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
 * so the screen goes live by itself. While a screen that shows workspaces is
 * in front (`watch`), the list is also read now and then: someone else may
 * start or stop one from elsewhere (#500). Reading the list starts nothing.
 *
 * The last list read is kept on the phone, so the Cloud tab shows it at once
 * the next time while the list is read again (#988). It is only shown: what
 * it says of access opens nothing until the list was read again. An
 * organization whose list was never read is kept as not read, not as empty,
 * and a list read while the phone asked for other providers is not shown at
 * all (PRO-456): either would put an organization with workspaces under "no
 * workspaces". Each
 * workspace's generated title (its agent tab's, learned when it was open) is
 * kept beside the keys, since it comes from the encrypted conversation.
 */

export interface CatalogOrganization {
  organization: CloudOrganization;
  /** Newest activity first; archived and deleted ones are not listed. */
  workspaces: CloudWorkspaceItem[];
  /** Why this organization's list could not be read just now (a code); what was shown stays. */
  error: string | null;
  /** Read in this run. False for what the phone kept from before (`saved`): it is shown, but decides nothing. */
  loaded: boolean;
}

export interface CatalogSnapshot {
  organizations: CatalogOrganization[];
  loading: boolean;
  /** Why the organizations themselves could not be read (a code). */
  error: string | null;
  refreshedAt: number | null;
  /** The list shown is the one kept from before; it has not been read again yet. */
  saved: boolean;
  /** Generated titles this phone learned, by `titleKey`. */
  titles: Readonly<Record<string, string>>;
}

/** Where a workspace's generated title is found in `CatalogSnapshot.titles`. */
export const titleKey = (orgId: string, workspaceId: string) => `${orgId}/${workspaceId}`;

/** What a workspace is called: its generated title when this phone learned one, else its name. */
export function workspaceTitle(snapshot: Pick<CatalogSnapshot, "titles">, workspace: Pick<CloudWorkspace, "orgId" | "id" | "name">): string {
  return snapshot.titles[titleKey(workspace.orgId, workspace.id)] ?? workspace.name;
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
  link?: Partial<Pick<CloudLinkOptions, "createSocket" | "random" | "now" | "log">>;
  now?: () => number;
  /** The phone's connection log: a failed resume's stage and code are written there (#1290). */
  log?: CloudLog;
}

export type CloudLog = (level: "info" | "warning" | "error", message: string, detail?: string) => void;

/** What came of asking to start a workspace: started, or under way although the answer did not come. */
export type StartOutcome = "started" | "in-progress";

/** Which workspaces have data on this phone. Kept beside the keys, so that it survives exactly what they survive (a reinstall). */
const HELD = "terminalx.cloud.held.v1";
/** The generated titles this phone learned (secure storage: they come from the encrypted conversation). */
const TITLES = "terminalx.cloud.titles.v1";
/** The last list read (plain storage: it is what the server says, nothing of a conversation). */
export const SAVED_LIST = "terminalx:cloud-list:v1";
const TITLE_MAX_CHARS = 200;
/** How often the list is read while an open workspace is changing, and for how long at most. */
export const CHANGING_POLL_MS = 3_000;
export const CHANGING_POLL_LIMIT_MS = 10 * 60_000;
/** How often the list is read while a screen that shows workspaces is in front (`watch`). */
export const WATCH_POLL_MS = 15_000;
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
  private saved = false;
  private titles: Record<string, string> = {};
  /** Organizations whose workspaces came from a successful read, in this run or the saved one: what is shown for them is a list, not a guess. */
  private everRead = new Set<string>();
  private snapshot: CatalogSnapshot = { organizations: [], loading: false, error: null, refreshedAt: null, saved: false, titles: {} };
  private readonly listeners = new Set<() => void>();
  private readonly sessions = new Map<string, CloudWorkspaceSession>();
  private readonly retained = new Map<string, number>();
  private flight: Promise<void> | null = null;
  private closed = false;
  private paused = false;
  private readonly deleted = new Set<string>();
  private changingTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the pending read is due: a sooner one replaces it, a later one waits for it. */
  private changingDue = 0;
  private changingSince: number | null = null;
  /** Screens in front that show workspaces (`watch`). */
  private watchers = 0;
  /** One change to the held list at a time. */
  private heldChain: Promise<unknown> = Promise.resolve();
  /** Resumes this phone asked for, by workspace, until the list says how they ended. */
  private readonly resumes = new Map<string, string>();

  /** Names for the user ids a shared workspace reports. */
  readonly people: CloudPeople;

  /** Done once what the phone kept from before is shown (or there was none). */
  readonly restored: Promise<void>;

  constructor(private readonly options: CloudCatalogOptions) {
    this.people = new CloudPeople(options.api);
    this.restored = this.restore();
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

  /**
   * Whether this person may open the workspace, by the last list: `ok`,
   * `not-shared` (listed, role `none`), `deleted`, `gone` (no longer listed:
   * access was taken away), or `unknown` while its organization has not been read.
   */
  access(orgId: string, workspaceId: string): CloudAccess {
    const organization = this.organizations.find((entry) => entry.organization.orgId === orgId);
    const workspace = organization?.workspaces.find((item) => item.workspace.id === workspaceId)?.workspace;
    // Kept from before: who may open it is known only once the list was read again.
    if (workspace && !organization!.loaded) return "unknown";
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
      // Also after a read that failed: the next one is still due (#500).
      this.followChanges();
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
        // A share revoked while this phone was connected: the list says so, and what is kept here goes.
        onRefused: () => void this.refresh(),
        link: { ...this.options.link, ...(this.options.log ? { log: this.options.log } : {}) },
      });
      this.sessions.set(key, session);
      void this.remember(orgId, workspaceId);
      // A message sent, or a state learned, may mean the list should be followed for a while.
      // And the runtime may have named the agent tab: that is the workspace's title.
      const opened = session;
      session.subscribe(() => {
        this.followChanges();
        this.learnTitle(orgId, workspaceId, opened);
      });
      // Opened while the app is in the background (a screen that mounts late): it connects when the app is back.
      if (this.paused) session.pause();
      void session.start();
    }
    return session;
  }

  /**
   * A screen that shows workspaces (the list, or one workspace) is in front:
   * the list is read again now and then until the returned function is
   * called, so a workspace started or stopped from elsewhere shows as such.
   */
  watch(): () => void {
    this.watchers += 1;
    this.followChanges();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.watchers -= 1;
      this.followChanges();
    };
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
    this.followChanges();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.retained.get(key) ?? 1) - 1;
      if (left > 0) return void this.retained.set(key, left);
      this.retained.delete(key);
      this.release(orgId, workspaceId);
      this.publish();
      this.followChanges();
    };
  }

  /** Let go of a workspace's connection (its screen closed). What is kept stays. */
  release(orgId: string, workspaceId: string): void {
    const key = sessionKey(orgId, workspaceId);
    this.sessions.get(key)?.close();
    this.sessions.delete(key);
  }

  /**
   * Start a stopped workspace, as the person asked (only its managers may).
   * What the server answers is shown at once, and the list is followed until
   * it runs; then the workspace's screen connects by itself.
   */
  async start(orgId: string, workspaceId: string): Promise<StartOutcome> {
    let answer;
    try {
      answer = await this.options.api.resume(orgId, workspaceId);
    } catch (error) {
      if (this.closed) throw error;
      // No answer, or one that says something already runs: the list says whether it is starting (#1290).
      if (mayBeUnderWay(error) && await this.fresh(orgId).catch(() => false) && listedAsStarting(this.item(orgId, workspaceId))) {
        this.options.log?.("warning", "Cloud workspace resume not confirmed, but under way", resumeLogDetail(resumeFailure(error), workspaceId));
        const operation = this.item(orgId, workspaceId)?.latestOperation;
        if (operation?.action === "resume" && operation.state !== "succeeded") this.resumes.set(sessionKey(orgId, workspaceId), operation.id);
        this.sessions.get(sessionKey(orgId, workspaceId))?.listChanged();
        this.followChanges();
        return "in-progress";
      }
      this.options.log?.("error", "Cloud workspace resume failed", resumeLogDetail(resumeFailure(error), workspaceId));
      // What the workspace is doing now is shown, whatever asking said.
      void this.refresh();
      throw error;
    }
    if (this.closed) return "started";
    // Followed until it runs: if this resume fails on the service, the log says so too.
    this.resumes.set(sessionKey(orgId, workspaceId), answer.operation.id);
    this.organizations = this.organizations.map((entry) => entry.organization.orgId !== orgId ? entry : {
      ...entry,
      workspaces: entry.workspaces.map((item) => item.workspace.id === workspaceId ? { ...item, workspace: answer.workspace, latestOperation: answer.operation } : item),
    });
    this.publish();
    this.sessions.get(sessionKey(orgId, workspaceId))?.listChanged();
    this.followChanges();
    void this.refresh();
    return "started";
  }

  private item(orgId: string, workspaceId: string): CloudWorkspaceItem | null {
    return this.organizations.find((entry) => entry.organization.orgId === orgId)?.workspaces.find((item) => item.workspace.id === workspaceId) ?? null;
  }

  /** A resume this phone asked for that the list now shows failed (or done) is written to the log once, then forgotten. */
  private noteResumes(): void {
    for (const [key, operationId] of [...this.resumes]) {
      const [orgId, workspaceId] = key.split("\0") as [string, string];
      const operation = this.item(orgId, workspaceId)?.latestOperation;
      if (!operation) continue;
      // A newer operation took its place: how this one ended is no longer listed.
      if (operation.id !== operationId) {
        this.resumes.delete(key);
        continue;
      }
      if (operation.state === "failed") {
        this.options.log?.("error", "Cloud workspace resume failed", resumeLogDetail({ stage: "operation", code: operation.errorCode ?? "none", status: null }, workspaceId));
      } else if (operation.state !== "succeeded" && operation.state !== "canceled") continue;
      this.resumes.delete(key);
    }
  }

  /** Signed out: close everything and remove every key, transcript and outbox from the phone. */
  async signOut(): Promise<void> {
    this.closed = true;
    if (this.changingTimer) clearTimeout(this.changingTimer);
    this.changingTimer = null;
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.resumes.clear();
    for (const [orgId, workspaceId] of await this.held()) await this.forget(orgId, workspaceId);
    await this.options.secrets.delete(HELD).catch(() => undefined);
    await this.options.secrets.delete(TITLES).catch(() => undefined);
    await this.options.storage.removeItem(SAVED_LIST).catch(() => undefined);
    this.organizations = [];
    this.everRead = new Set();
    this.titles = {};
    this.saved = false;
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
          this.everRead.add(organization.orgId);
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
    this.saved = false;
    this.refreshedAt = (this.options.now ?? Date.now)();
    this.publish();
    this.noteResumes();
    void this.saveList();

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
  }

  /**
   * Read the list again shortly while an open workspace is changing (until
   * all have settled, or for the limit at most), and now and then while a
   * screen that shows workspaces is in front.
   */
  private followChanges(): void {
    if (this.closed || this.paused) return this.unfollow();
    const now = (this.options.now ?? Date.now)();
    const changing = [...this.sessions.values()].some((session) => session.changing);
    if (changing) this.changingSince ??= now;
    else this.changingSince = null;
    const fast = changing && now - (this.changingSince ?? now) <= CHANGING_POLL_LIMIT_MS;
    const watched = this.watchers > 0;
    if (!fast && !watched) return this.unfollow();
    const delay = fast ? CHANGING_POLL_MS : WATCH_POLL_MS;
    if (this.changingTimer) {
      if (this.changingDue <= now + delay) return;
      clearTimeout(this.changingTimer);
    }
    this.changingDue = now + delay;
    this.changingTimer = setTimeout(() => {
      this.changingTimer = null;
      void this.refresh();
    }, delay);
  }

  private unfollow(): void {
    if (this.changingTimer) clearTimeout(this.changingTimer);
    this.changingTimer = null;
  }

  /** What the phone kept from the last run: shown until the list is read, if it is not read first. */
  private async restore(): Promise<void> {
    const [list, titles] = await Promise.all([
      this.options.storage.getItem(SAVED_LIST).catch(() => null),
      this.options.secrets.get(TITLES).catch(() => null),
    ]);
    if (this.closed) return;
    this.titles = { ...parseTitles(titles), ...this.titles };
    const saved = parseSavedList(list);
    if (saved && this.refreshedAt === null && !this.organizations.length) {
      this.organizations = saved.organizations;
      // Merged: a read in flight may already have marked an organization.
      for (const orgId of saved.read) this.everRead.add(orgId);
      this.saved = true;
    }
    this.publish();
  }

  /**
   * The list as it was read, for the next time the tab opens. An organization
   * whose list could not be read is kept as it was shown; one that was never
   * read keeps why, so it is not taken for one with no workspaces.
   */
  private async saveList(): Promise<void> {
    const organizations = this.organizations.map((entry) =>
      this.everRead.has(entry.organization.orgId)
        ? { organization: entry.organization, workspaces: entry.workspaces }
        : { organization: entry.organization, workspaces: entry.workspaces, unread: entry.error ?? "cloud_workspace_unavailable" },
    );
    await this.options.storage.setItem(SAVED_LIST, JSON.stringify({ v: 1, providers: SUPPORTED_PROVIDERS, organizations })).catch(() => undefined);
  }

  /** The runtime named the workspace's agent tab: that is its title, here and in the list. */
  private learnTitle(orgId: string, workspaceId: string, session: CloudWorkspaceSession): void {
    if (this.sessions.get(sessionKey(orgId, workspaceId)) !== session) return;
    const tabs = session.getSnapshot().tabs;
    const launchTab = this.workspace(orgId, workspaceId)?.launch?.tabId ?? null;
    const raw = (tabs.find((tab) => tab.tabId === launchTab) ?? tabs.find((tab) => tab.title))?.title?.trim();
    if (!raw) return;
    const title = Array.from(raw).slice(0, TITLE_MAX_CHARS).join("");
    const key = titleKey(orgId, workspaceId);
    if (this.titles[key] === title) return;
    this.titles = { ...this.titles, [key]: title };
    this.publish();
    void this.saveTitles();
  }

  private saveTitles(): Promise<void> {
    const titles = this.titles;
    return this.options.secrets.set(TITLES, JSON.stringify(titles)).catch(() => undefined);
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
    const key = titleKey(orgId, workspaceId);
    if (key in this.titles) {
      const { [key]: _gone, ...rest } = this.titles;
      this.titles = rest;
      this.publish();
      await this.saveTitles();
    }
  }

  private publish(): void {
    this.snapshot = { organizations: this.organizations, loading: this.loading, error: this.error, refreshedAt: this.refreshedAt, saved: this.saved, titles: this.titles };
    for (const listener of [...this.listeners]) listener();
  }
}

/** Listed, but not shared with this person: role `none` from a server that keeps a member list (`listed` is not false). */
function notShared(workspace: CloudWorkspace): boolean {
  const you = workspace.you as ({ role?: string; listed?: boolean } & Record<string, unknown>) | null | undefined;
  return you?.role === "none" && you.listed !== false;
}

function parseTitles(raw: string | null): Record<string, string> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
  } catch {
    return {};
  }
}

/**
 * The list kept from before, with the organizations it had read, or null when
 * there is none this app can use. A list read while this app asked for other
 * providers is none: it may lack whole providers' workspaces (PRO-456).
 */
function parseSavedList(raw: string | null): { organizations: CatalogOrganization[]; read: Set<string> } | null {
  try {
    const parsed = raw ? (JSON.parse(raw) as { v?: unknown; providers?: unknown; organizations?: unknown }) : null;
    if (!parsed || parsed.v !== 1 || parsed.providers !== SUPPORTED_PROVIDERS || !Array.isArray(parsed.organizations)) return null;
    const organizations: CatalogOrganization[] = [];
    const read = new Set<string>();
    for (const entry of parsed.organizations as { organization?: CloudOrganization; workspaces?: CloudWorkspaceItem[]; unread?: unknown }[]) {
      const organization = entry?.organization;
      if (!organization || typeof organization.orgId !== "string" || typeof organization.name !== "string" || !Array.isArray(entry.workspaces)) return null;
      const workspaces = entry.workspaces.filter((item) => item?.workspace && typeof item.workspace.id === "string" && item.workspace.orgId === organization.orgId && typeof item.workspace.name === "string" && typeof item.workspace.state === "string");
      // Never read: shown as not read (its code), never as an organization with no workspaces.
      const unread = entry.unread === undefined ? null : typeof entry.unread === "string" && /^[a-z0-9_.-]{1,96}$/i.test(entry.unread) ? entry.unread : "cloud_workspace_unavailable";
      if (unread === null) read.add(organization.orgId);
      organizations.push({ organization, workspaces, error: unread, loaded: false });
    }
    return { organizations, read };
  } catch {
    return null;
  }
}
