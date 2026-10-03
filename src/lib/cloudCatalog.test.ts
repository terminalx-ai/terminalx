import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudCatalogFeed, CloudSelectedRepository, CloudWorkspaceList, CloudWorkspaceListItem } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaces: vi.fn(),
    cloudCatalogFeed: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudWorkspaceResume: vi.fn(),
    cloudWorkspaceUnarchive: vi.fn(),
    cloudRemoteAttach: vi.fn(),
    cloudRemoteActivate: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
  },
  workspaceConnection: vi.fn(),
  closeWorkspaceConnection: vi.fn(),
  account: { status: { state: "signed-out", identity: null, expiresAt: null, lastError: null } as AccountStatus, ready: true, busy: false },
  listeners: new Set<() => void>(),
  refreshAccount: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  workspaceConnection: mocks.workspaceConnection,
  closeWorkspaceConnection: mocks.closeWorkspaceConnection,
}));
vi.mock("@/lib/account", () => ({
  refreshAccount: mocks.refreshAccount,
  getAccount: () => mocks.account,
  subscribeAccount: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

import {
  applyCloudSnapshot,
  bootCloudCatalog,
  cacheCloudSessions,
  cloudOrgArg,
  cloudOrganizations,
  defaultOrgId,
  flushCloudCatalogSave,
  getCloudCatalog,
  ingestCloudList,
  lastKnownWorkspace,
  listedOrgManages,
  liveCloudOrgIds,
  mergeFeedDelta,
  parseCatalog,
  placeCloudProjects,
  pollDelay,
  ACCESS_REFRESH_DELAY_MS,
  FEED_FAILURES_BEFORE_FALLBACK,
  FEED_RETRY_AFTER_MS,
  POLL_BACKGROUND_MS,
  POLL_CHANGING_MS,
  POLL_FOCUSED_MS,
  REFRESH_ON_RETURN_FLOOR_MS,
  refreshCloudCatalog,
  refreshCloudFeed,
  refreshCloudWorkspaces,
  rememberCreatedWorkspace,
  resetCloudCatalog,
  serializeCatalog,
  subscribeCloudCatalog,
  usesCatalogFeed,
  type OrgCatalog,
} from "./cloudCatalog";
import { resetPurged } from "./cloudLifecycle";
import { registerAccountRoles } from "./accountRoles";
import { notifyAccessChanged } from "./cloudCollab";
import { createWorkspace, type CreateApi } from "./cloudCreate";
// What the Rust `cloud_workspaces` command hands the webview for a saas #137/#139
// list; cloud_workspaces.rs asserts it serializes exactly this.
import rustShapedList from "./fixtures/cloudWorkspaceList.webview.json";

const ORG = "org-a";

function item(id: string, fields: Record<string, unknown> = {}, latestOperation: unknown = null): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId: ORG, name: `ws ${id}`, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, ...fields },
    latestOperation,
  } as CloudWorkspaceListItem;
}

const repo = (fullName: string, fields: Partial<CloudSelectedRepository> = {}): CloudSelectedRepository => ({
  fullName,
  cloneUrl: `https://github.com/${fullName}.git`,
  defaultBranch: "main",
  private: true,
  state: "accessible",
  reason: null,
  ...fields,
});

const org = (workspaces: CloudWorkspaceListItem[], repositories: CloudSelectedRepository[] | null = []): OrgCatalog => ({
  orgId: ORG,
  workspaces,
  repositories,
  repositoriesAt: null,
  quota: null,
  fetchedAt: 1,
  source: "live",
  error: null,
  sessions: {},
});

function signIn(orgs = [{ id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } }]) {
  mocks.account.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    organizations: orgs,
  };
  for (const listener of mocks.listeners) listener();
}

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.workspaceConnection.mockReset();
  mocks.closeWorkspaceConnection.mockReset();
  mocks.refreshAccount.mockReset().mockResolvedValue(undefined);
  mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ configured: true, repositories: [] });
  mocks.api.cloudCatalogLoad.mockResolvedValue(null);
  mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [] });
  mocks.api.cloudCatalogSave.mockResolvedValue(undefined);
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: true, unsentCommands: 0, cachedTabs: 1 });
  mocks.account.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
  resetPurged();
});

afterEach(() => {
  resetCloudCatalog();
  vi.useRealTimers();
});

describe("placement", () => {
  it("places by the server's repositories first, then createMemory, then as a blank project", () => {
    const server = item("s1", { repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: null, primary: true }] });
    const remembered = item("m1");
    const image = item("i1", { repositories: [] });
    const unknown = item("u1");
    // The server's word wins over what this desktop remembered.
    const both = item("b1", { repositories: [{ identity: null, fullName: "acme/web", cloneUrl: "git@github.com:Acme/Web.git", primary: true }] });
    const memory = {
      [`${ORG}:m1`]: { repositories: ["github.com/acme/api"], createdAt: 1 },
      [`${ORG}:b1`]: { repositories: ["github.com/acme/api"], createdAt: 1 },
      [`${ORG}:i1`]: { repositories: ["github.com/acme/api"], createdAt: 1 },
    };
    const placed = placeCloudProjects(org([server, remembered, image, unknown, both], [repo("acme/api"), repo("acme/web")]), memory);
    expect(placed.projects.filter((p) => !p.blank).map((p) => [p.fullName, p.workspaces.map((w) => [w.item.workspace.id, w.placedBy])])).toEqual([
      ["acme/api", [["s1", "server"], ["m1", "createMemory"]]],
      ["acme/web", [["b1", "server"]]],
    ]);
    // No repository (the server lists none, or none is known): a blank project named after the workspace, never placed from memory.
    expect(placed.projects.filter((p) => p.blank).map((p) => [p.key, p.fullName, p.workspaces.map((w) => w.item.workspace.id)])).toEqual([
      [`cloud:${ORG}:blank/ws i1`, "ws i1", ["i1"]],
      [`cloud:${ORG}:blank/ws u1`, "ws u1", ["u1"]],
    ]);
    expect(placed.projects[0].key).toBe(`cloud:${ORG}:github.com/acme/api`);
    expect(placed.projects[0].workspaces[0].key).toBe(`cloud:${ORG}:s1`);
  });

  it("puts selected repositories without workspaces under More, and pinned ones in view", () => {
    const placed = placeCloudProjects(org([], [repo("acme/zeta"), repo("acme/alpha"), repo("acme/pinned")]), {}, { pinned: ["github.com/acme/pinned"] });
    expect(placed.projects.map((p) => [p.fullName, p.pinned])).toEqual([["acme/pinned", true]]);
    expect(placed.more.map((p) => p.fullName)).toEqual(["acme/alpha", "acme/zeta"]);
  });

  it("orders pinned projects first, then by name, and workspaces by last activity", () => {
    const a = item("a", { repositories: [{ identity: "github.com/acme/b", fullName: "acme/b", cloneUrl: null }], lastActivityAt: 5 });
    const b = item("b", { repositories: [{ identity: "github.com/acme/b", fullName: "acme/b", cloneUrl: null }], lastActivityAt: 50 });
    const c = item("c", { repositories: [{ identity: "github.com/acme/a", fullName: "acme/a", cloneUrl: null }] });
    const d = item("d", { repositories: [{ identity: "github.com/acme/z", fullName: "acme/z", cloneUrl: null }] });
    const placed = placeCloudProjects(org([a, b, c, d], [repo("acme/a"), repo("acme/b"), repo("acme/z")]), {}, { pinned: ["github.com/acme/z"] });
    expect(placed.projects.map((p) => p.fullName)).toEqual(["acme/z", "acme/a", "acme/b"]);
    expect(placed.projects[2].workspaces.map((w) => w.item.workspace.id)).toEqual(["b", "a"]);
  });

  it("keeps archived workspaces apart, and marks a deselected repository that still has workspaces", () => {
    const archived = item("old", { state: "archived", archivedAt: 1, repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: null }] });
    const orphan = item("o", { repositories: [{ identity: "github.com/acme/gone", fullName: null, cloneUrl: null }] });
    const placed = placeCloudProjects(org([archived, orphan], [repo("acme/api")]), {});
    expect(placed.archived.map((w) => w.item.workspace.id)).toEqual(["old"]);
    expect(placed.projects.map((p) => [p.fullName, p.selected])).toEqual([["acme/gone", false]]);
    expect(placed.more.map((p) => p.fullName)).toEqual(["acme/api"]);
  });

  it("does not call a repository inaccessible before the organization's list is known", () => {
    const placed = placeCloudProjects(org([item("w", { repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: null }] })], null), {});
    expect(placed.projects[0].selected).toBe(true);
  });
});

describe("a list as the Rust command passes it on (saas #137)", () => {
  it("places the workspace by repositories[0].identity and keeps runtimeActivity, authority and quota", async () => {
    const list = structuredClone(rustShapedList) as unknown as CloudWorkspaceList;
    for (const entry of list.workspaces) entry.workspace.orgId = ORG;
    for (const tombstone of list.tombstones ?? []) tombstone.orgId = ORG;
    mocks.api.cloudWorkspaces.mockResolvedValue(list);
    signIn();
    bootCloudCatalog();
    await refreshCloudCatalog(ORG);
    const catalog = getCloudCatalog().orgs[ORG];
    const placed = placeCloudProjects(catalog, {});
    expect(placed.projects.map((p) => [p.identity, p.fullName, p.blank, p.workspaces.map((w) => [w.item.workspace.id, w.placedBy])])).toEqual([
      ["github.com/acme/api", "acme/api", false, [["workspace-1", "server"]]],
    ]);
    const workspace = catalog.workspaces[0].workspace;
    expect(workspace.runtimeActivity).toMatchObject({ online: true, activeTurns: 1, pendingApprovals: 2 });
    expect(workspace.authority).toBe("participate");
    expect(workspace.lastActivityAt).toBe(1790000006000);
    expect(catalog.quota).toMatchObject({ used: 1, limit: 2, running: { used: 1, limit: 2 }, total: { used: 5, limit: 20 } });
  });
});

describe("organizations", () => {
  it("re-derives its organizations when a silent refresh brings cloud capabilities", async () => {
    signIn([{ id: ORG, name: "Acme", role: "admin", isPersonal: false } as never]);
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().loaded).toBe(true));
    expect(mocks.api.cloudWorkspaces).not.toHaveBeenCalled();
    // The native side announces the refreshed status; the same user, now with cloud enabled.
    signIn();
    await vi.waitFor(() => expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1));
  });

  it("follows the session's active organization when it changes", async () => {
    signIn([
      { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-box", name: "E2E Box", role: "owner", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ]);
    expect(defaultOrgId(mocks.account.status)).toBe(ORG);
    mocks.account.status = { ...mocks.account.status, identity: { ...mocks.account.status.identity!, organization: "E2E Box", organizationId: "org-box" } };
    expect(defaultOrgId(mocks.account.status)).toBe("org-box");
  });

  it("lists only organizations with cloud enabled, and none while signed out", () => {
    expect(cloudOrganizations(mocks.account.status)).toEqual([]);
    signIn([
      { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-b", name: "Beta", role: "member", isPersonal: false, cloud: { enabled: false, flags: {} } },
      { id: "org-old", name: "Old", role: "member" } as never,
    ]);
    expect(cloudOrganizations(mocks.account.status).map((o) => o.id)).toEqual([ORG]);
    expect(defaultOrgId(mocks.account.status)).toBe(ORG);
  });

  it("finds the default organization by name from an older desktop session", () => {
    signIn();
    mocks.account.status = { ...mocks.account.status, identity: { ...mocks.account.status.identity!, organizationId: undefined } };
    expect(defaultOrgId(mocks.account.status)).toBe(ORG);
  });
});

describe("merging and tombstones", () => {
  it("does not take a list asked for before the one already shown", async () => {
    await ingestCloudList({ workspaces: [item("new")] }, ORG, 20, 20);
    await ingestCloudList({ workspaces: [item("old")] }, ORG, 21, 10);
    expect(getCloudCatalog().orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["new"]);
  });

  it("drops a tombstoned workspace and purges what this desktop kept of it", async () => {
    signIn();
    bootCloudCatalog();
    await refreshCloudCatalog(ORG);
    rememberCreatedWorkspace({ workspace: item("gone").workspace, operation: {} as never }, [{ cloneUrl: "https://github.com/acme/api" }]);
    const result = await ingestCloudList(
      { workspaces: [item("keep"), item("gone")], tombstones: [{ id: "gone", orgId: ORG, deletedAt: 1, expiresAt: 2 }] },
      ORG,
    );
    expect(result.workspaces.map((w) => w.workspace.id)).toEqual(["keep"]);
    expect(getCloudCatalog().orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["keep"]);
    expect(getCloudCatalog().createMemory[`${ORG}:gone`]).toBeUndefined();
    expect(mocks.api.cloudAgentPurgeWorkspace).toHaveBeenCalledWith(ORG, "gone");
    expect(mocks.closeWorkspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: ORG, workspaceId: "gone" });
    expect(result.notices).toEqual([{ workspaceId: "gone", name: "ws gone", unsentCommands: 0, unsavedFiles: 0 }]);
    expect(getCloudCatalog().notices).toHaveLength(1);
  });

  it("tells the connection manager what each list says, so a held connection follows its workspace back with connect", async () => {
    const { retainCloudConnection, resetCloudConnections } = await import("./cloudConnections");
    const attached: { emit(state: { state: string }): void; close: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn> }[] = [];
    mocks.workspaceConnection.mockReset().mockImplementation(async () => {
      const listeners = new Set<(state: unknown) => void>();
      let current: unknown = { state: "connecting", attempt: 1 };
      const connection = {
        client: { onState: (listener: (state: unknown) => void) => (listeners.add(listener), listener(current), () => listeners.delete(listener)) },
        activate: vi.fn(async () => undefined),
        close: vi.fn(),
        emit(state: { state: string }) {
          current = state;
          for (const listener of [...listeners]) listener(state);
        },
      };
      attached.push(connection);
      return connection;
    });
    try {
      const lease = await retainCloudConnection({ orgId: ORG, workspaceId: "w1" });
      attached[0]!.emit({ state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority: "manage" } as never);
      const asked = Date.now();
      // Stopped from here: the list has the suspend operation, then the stopped workspace.
      await ingestCloudList({ workspaces: [item("w1", {}, { id: "op", action: "suspend", state: "running" })] }, ORG, asked, asked);
      attached[0]!.emit({ state: "suspended" });
      await ingestCloudList({ workspaces: [item("w1", { state: "suspended" })] }, ORG, asked + 1, asked + 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(attached).toHaveLength(1);
      // Someone else woke it: the next list says ready.
      const later = Date.now() + 1_000;
      await ingestCloudList({ workspaces: [item("w1")] }, ORG, later, later);
      await vi.waitFor(() => expect(attached).toHaveLength(2));
      expect(attached[0]!.close).toHaveBeenCalledTimes(1);
      expect(lease.current()).toBe(attached[1]);
      expect(mocks.workspaceConnection.mock.calls.map((call) => call[1])).toEqual(["connect", "connect"]);
      expect(attached.flatMap((connection) => connection.activate.mock.calls)).toEqual([]);
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
      lease.release();
    } finally {
      resetCloudConnections();
    }
  });

  it("a snapshot is as old as its request: one asked for before a stop never makes a connection attach", async () => {
    const { retainCloudConnection, resetCloudConnections } = await import("./cloudConnections");
    const attached: { emit(state: unknown): void; close: ReturnType<typeof vi.fn> }[] = [];
    mocks.workspaceConnection.mockReset().mockImplementation(async () => {
      const listeners = new Set<(state: unknown) => void>();
      let current: unknown = { state: "connecting", attempt: 1 };
      const connection = {
        client: { onState: (listener: (state: unknown) => void) => (listeners.add(listener), listener(current), () => listeners.delete(listener)) },
        activate: vi.fn(async () => undefined),
        close: vi.fn(),
        emit(state: unknown) {
          current = state;
          for (const listener of [...listeners]) listener(state);
        },
      };
      attached.push(connection);
      return connection;
    });
    try {
      signIn();
      mocks.api.cloudWorkspaces.mockResolvedValueOnce({ workspaces: [item("w1")] });
      bootCloudCatalog();
      await refreshCloudCatalog(ORG);
      const lease = await retainCloudConnection({ orgId: ORG, workspaceId: "w1" });
      attached[0]!.emit({ state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority: "manage" });
      const before = Date.now() - 5_000;
      attached[0]!.emit({ state: "suspended" });
      // A resume answered "ready" to a call made before the transport stopped, applied only now.
      applyCloudSnapshot({ workspace: item("w1").workspace, operation: { id: "op", action: "resume", state: "succeeded" } as never }, before);
      // A snapshot with no request time (a create poll) says nothing to connections.
      applyCloudSnapshot({ workspace: item("w1").workspace, operation: { id: "op", action: "resume", state: "succeeded" } as never });
      // The old page's list, asked for before the stop and arriving after it.
      await ingestCloudList({ workspaces: [item("w1")] }, ORG, Date.now(), before + 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(attached).toHaveLength(1);
      expect(lease.state()).toEqual({ state: "suspended" });
      // Asked for after it: this one counts.
      applyCloudSnapshot({ workspace: item("w1").workspace, operation: { id: "op", action: "resume", state: "succeeded" } as never }, Date.now() + 1_000);
      await vi.waitFor(() => expect(attached).toHaveLength(2));
      lease.release();
    } finally {
      resetCloudConnections();
    }
  });

  it("keeps cached rows when a refresh fails, and says so", async () => {
    signIn();
    mocks.api.cloudWorkspaces.mockResolvedValueOnce({ workspaces: [item("w1")] });
    bootCloudCatalog();
    await refreshCloudCatalog(ORG);
    mocks.api.cloudWorkspaces.mockRejectedValueOnce({ code: "cloud_workspace_network_unavailable" });
    await refreshCloudCatalog(ORG);
    const catalog = getCloudCatalog().orgs[ORG];
    expect(catalog.workspaces.map((w) => w.workspace.id)).toEqual(["w1"]);
    expect(catalog.error).toBe("cloud_workspace_network_unavailable");
  });

  it("replaces one row from a snapshot, and ignores a list for another organization", async () => {
    signIn();
    mocks.api.cloudWorkspaces.mockResolvedValueOnce({ workspaces: [item("w1")] });
    bootCloudCatalog();
    await refreshCloudCatalog(ORG);
    applyCloudSnapshot({ workspace: { ...item("w1").workspace, state: "suspended" }, operation: { id: "op" } as never });
    expect(getCloudCatalog().orgs[ORG].workspaces[0].workspace.state).toBe("suspended");
    mocks.api.cloudWorkspaces.mockResolvedValueOnce({ workspaces: [{ ...item("x"), workspace: { ...item("x").workspace, orgId: "org-b" } }] });
    await refreshCloudCatalog(ORG);
    expect(getCloudCatalog().orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["w1"]);
    // The server lists another organization: the account status here is stale, so it is read again.
    expect(mocks.refreshAccount).toHaveBeenCalledTimes(1);
  });

  it("records the repositories a created workspace came from", async () => {
    signIn();
    bootCloudCatalog();
    const createApi: CreateApi = {
      cloudWorkspacePreflight: async () => ({ ready: true, checks: [] }),
      cloudWorkspaceSetup: async () => ({ provider: "box", defaults: {} }) as never,
      cloudWorkspaceQuote: async () => ({ id: "quote" }) as never,
      cloudWorkspaceCreate: async () => ({ workspace: item("new").workspace, operation: { id: "op" } as never }),
    };
    await createWorkspace(
      createApi,
      {
        name: "n",
        provider: "box",
        accessMode: "organization",
        repositories: [{ cloneUrl: "https://github.com/Acme/API.git", fullName: "Acme/API", ref: "" }],
        prompt: "go",
        agent: "claude",
        model: null,
        effort: null,
        mode: null,
      } as never,
      { onCreated: (snapshot, request) => rememberCreatedWorkspace(snapshot, request.repositories) },
    );
    expect(getCloudCatalog().createMemory[`${ORG}:new`]?.repositories).toEqual(["github.com/acme/api"]);
  });
});

describe("saved cache", () => {
  it("renders the saved catalog before the network answers after a relaunch", async () => {
    const saved = serializeCatalog({
      owner: "a@example.com",
      revision: "s:1",
      loaded: true,
      orgs: { [ORG]: org([item("cached")], [repo("acme/api")]) },
      createMemory: { [`${ORG}:cached`]: { repositories: ["github.com/acme/api"], createdAt: 1 } },
      notices: [],
    });
    mocks.api.cloudCatalogLoad.mockResolvedValue(saved);
    // The network never answers during this test.
    mocks.api.cloudWorkspaces.mockReturnValue(new Promise(() => undefined));
    mocks.api.cloudWorkspaceRepositories.mockReturnValue(new Promise(() => undefined));
    signIn();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().loaded).toBe(true));
    const catalog = getCloudCatalog();
    expect(mocks.api.cloudCatalogLoad).toHaveBeenCalledWith("s:1");
    expect(catalog.orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["cached"]);
    expect(catalog.orgs[ORG].source).toBe("cache");
    expect(placeCloudProjects(catalog.orgs[ORG], catalog.createMemory).projects[0].workspaces[0].placedBy).toBe("createMemory");
  });

  it("a live list that lands before the saved one is not overwritten by it", async () => {
    let answer!: (value: unknown) => void;
    mocks.api.cloudCatalogLoad.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("live")] });
    signIn();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().orgs[ORG]?.source).toBe("live"));
    answer(serializeCatalog({ owner: "x", revision: "s:1", loaded: true, orgs: { [ORG]: org([item("old")]) }, createMemory: {}, notices: [] }));
    await vi.waitFor(() => expect(getCloudCatalog().loaded).toBe(true));
    expect(getCloudCatalog().orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["live"]);
  });

  it("saves rows, repositories and createMemory fenced by the account revision, never errors", async () => {
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("w1")], quota: { used: 1, limit: 2 } });
    signIn();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().loaded).toBe(true));
    await refreshCloudCatalog(ORG);
    await flushCloudCatalogSave();
    const [revision, written] = mocks.api.cloudCatalogSave.mock.calls.at(-1)!;
    expect(revision).toBe("s:1");
    const parsed = parseCatalog(JSON.parse(JSON.stringify(written)))!;
    expect(parsed.orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["w1"]);
    expect(parsed.orgs[ORG].quota).toEqual({ used: 1, limit: 2 });
    expect(JSON.stringify(written)).not.toContain("error");
  });

  it("reads nothing it cannot trust", () => {
    expect(parseCatalog(null)).toBeNull();
    expect(parseCatalog({ version: 2, orgs: {} })).toBeNull();
    const parsed = parseCatalog({ version: 1, orgs: { [ORG]: { workspaces: [{ nope: 1 }, item("ok"), { ...item("x"), workspace: { ...item("x").workspace, orgId: "other" } }] } } });
    expect(parsed!.orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["ok"]);
  });

  it("forgets everything in memory on sign-out, and loads nothing while signed out", async () => {
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("w1")] });
    signIn();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().orgs[ORG]?.workspaces).toHaveLength(1));
    mocks.account.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
    for (const listener of mocks.listeners) listener();
    expect(getCloudCatalog().orgs).toEqual({});
    expect(getCloudCatalog().owner).toBeNull();
  });
});

describe("poll policy", () => {
  const changing = item("c", { state: "provisioning" }, { state: "running", action: null });
  it("polls every 30 s while seen or focused, every 3 s while something changes, and every 2 min while hidden", () => {
    expect(POLL_FOCUSED_MS).toBe(30_000);
    expect(POLL_BACKGROUND_MS).toBe(120_000);
    expect(pollDelay(org([item("w")]), { visible: true, focused: true })).toBe(POLL_FOCUSED_MS);
    // Seen, but another app has the focus (the other person's window in a two-person test): still 30 s.
    expect(pollDelay(org([item("w")]), { visible: true, focused: false })).toBe(POLL_FOCUSED_MS);
    // Focused whatever visibility says: the fast poll never depends on visibility alone.
    expect(pollDelay(org([item("w")]), { visible: false, focused: true })).toBe(POLL_FOCUSED_MS);
    // Hidden (minimized, or wholly covered by other windows): slow, never paused.
    expect(pollDelay(org([item("w")]), { visible: false, focused: false })).toBe(POLL_BACKGROUND_MS);
    expect(pollDelay(org([changing]), { visible: true, focused: false })).toBe(POLL_CHANGING_MS);
    expect(pollDelay(org([changing]), { visible: false, focused: false })).toBe(POLL_BACKGROUND_MS);
    const stopping = item("s", {}, { state: "running", action: "suspend" });
    expect(pollDelay(org([stopping]), { visible: true, focused: true })).toBe(POLL_CHANGING_MS);
  });

  it("lists again on the timer while focused", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("w")] });
    signIn();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
  });
});

describe("share state without a focused window", () => {
  it("lists every 30 s while seen in the background, and every 2 min while hidden or covered", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("w")] });
    signIn();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1);
    // A workspace shared with this person a moment ago is listed within 30 s, with no focus and no manual refresh.
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("w"), item("shared-just-now", { you: { role: "viewer", canApprove: false } })] });
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
    expect(getCloudCatalog().orgs[ORG].workspaces.map((row) => row.workspace.id)).toContain("shared-just-now");
    // Hidden (WKWebView says so for a window wholly covered by others, not only a minimized one): every 2 min, never paused.
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS * 3);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_BACKGROUND_MS - POLL_FOCUSED_MS * 3);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(POLL_BACKGROUND_MS * 3);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(6);
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  it("lists at once when the window is seen again or gets the focus, however fresh its rows are", async () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("w")] });
    signIn();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1);
    // Rows 5 s old: uncovered, it lists now rather than at the next timer.
    await vi.advanceTimersByTimeAsync(5_000);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
    // The focus that comes with it a moment later is the same return: one list, not two.
    focus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
    // Focus on its own, later: at once again.
    await vi.advanceTimersByTimeAsync(REFRESH_ON_RETURN_FLOOR_MS);
    focus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
    focus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(3);
    // Hiding it lists nothing by itself.
    await vi.advanceTimersByTimeAsync(REFRESH_ON_RETURN_FLOOR_MS);
    focus.mockReturnValue(false);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(3);
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  it("lists once, soon, when a workspace's access changes, focused or not, and never attaches or resumes", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [item("w")] });
    signIn();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1);
    // A burst (the runtime's role and member notifications, a share made here) is one list.
    notifyAccessChanged(ORG);
    notifyAccessChanged(ORG);
    notifyAccessChanged(ORG);
    await vi.advanceTimersByTimeAsync(ACCESS_REFRESH_DELAY_MS);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
    // An organization that is not live is not listed for it.
    notifyAccessChanged("org-elsewhere");
    await vi.advanceTimersByTimeAsync(ACCESS_REFRESH_DELAY_MS);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
  });
});

describe("looking never costs money", () => {
  it("booting, refreshing, polling and taking lists never attach to or resume a workspace", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mocks.api.cloudWorkspaces.mockResolvedValue({
      workspaces: [item("ready"), item("stopped", { state: "suspended" }), item("starting", { state: "provisioning" }, { state: "running", action: null })],
      tombstones: [{ id: "gone", orgId: ORG, deletedAt: 1, expiresAt: 2 }],
    });
    signIn();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(10 * POLL_CHANGING_MS);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    expect(mocks.api.cloudWorkspaces.mock.calls.length).toBeGreaterThan(3);
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteActivate).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  });
});

describe("every organization live (CS-18)", () => {
  const ORG_B = "org-b";
  const orgs = [
    { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
    { id: ORG_B, name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    { id: "org-off", name: "Off", role: "member", isPersonal: false, cloud: { enabled: false, flags: {} } },
  ];
  const inB = (id: string): CloudWorkspaceListItem => ({ ...item(id), workspace: { ...item(id).workspace, orgId: ORG_B } });
  const multi = (patch: Partial<AccountStatus> = {}) => {
    signIn(orgs);
    mocks.account.status = { ...mocks.account.status, multiOrg: true, context: { scope: "s", revision: "s:1", account: "acct" }, ...patch };
    for (const listener of mocks.listeners) listener();
  };
  const listFor = (orgId: string | null) => (orgId === ORG_B ? { workspaces: [inB("b1")] } : { workspaces: [item("a1")] });

  it("without the capability, only the default organization is live, listed with no organization named", async () => {
    signIn(orgs);
    expect(liveCloudOrgIds(mocks.account.status)).toEqual([ORG]);
    expect(cloudOrgArg(ORG_B)).toBeNull();
    bootCloudCatalog();
    await vi.waitFor(() => expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1));
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledWith(null);
    await refreshCloudCatalog(ORG_B);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("with it, lists every cloud-enabled organization by name, and each keeps its own rows", async () => {
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => listFor(orgId));
    multi();
    expect(liveCloudOrgIds(mocks.account.status)).toEqual([ORG, ORG_B]);
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().orgs[ORG_B]?.workspaces.map((w) => w.workspace.id)).toEqual(["b1"]));
    expect(getCloudCatalog().orgs[ORG].workspaces.map((w) => w.workspace.id)).toEqual(["a1"]);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledWith(ORG);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledWith(ORG_B);
    expect(mocks.api.cloudWorkspaces).not.toHaveBeenCalledWith("org-off");
    expect(mocks.api.cloudWorkspaceRepositories).toHaveBeenCalledWith(ORG_B);
  });

  it("polls each live organization on its own 30 s timer, never attaching to or resuming anything", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => listFor(orgId));
    multi();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    const calls = (orgId: string) => mocks.api.cloudWorkspaces.mock.calls.filter(([id]) => id === orgId).length;
    expect([calls(ORG), calls(ORG_B)]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    // The budget: one list per organization per interval while idle and focused.
    expect([calls(ORG), calls(ORG_B)]).toEqual([2, 2]);
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  });

  it("a change of the default organization keeps both organizations' rows", async () => {
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => listFor(orgId));
    multi();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().orgs[ORG_B]).toBeDefined());
    multi({ identity: { name: "A", email: "a@example.com", organization: "Beta", organizationId: ORG_B } });
    expect(getCloudCatalog().orgs[ORG].workspaces).toHaveLength(1);
    expect(getCloudCatalog().orgs[ORG_B].workspaces).toHaveLength(1);
  });

  it("losing a membership purges only that organization's cache", async () => {
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => listFor(orgId));
    multi();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().orgs[ORG_B]).toBeDefined());
    rememberCreatedWorkspace({ workspace: inB("b2").workspace, operation: {} as never }, [{ cloneUrl: "https://github.com/beta/api" }]);
    rememberCreatedWorkspace({ workspace: item("a2").workspace, operation: {} as never }, [{ cloneUrl: "https://github.com/acme/api" }]);
    multi({ organizations: orgs.filter((org) => org.id !== ORG_B) });
    expect(getCloudCatalog().orgs[ORG_B]).toBeUndefined();
    expect(getCloudCatalog().createMemory[`${ORG_B}:b2`]).toBeUndefined();
    expect(getCloudCatalog().orgs[ORG].workspaces.map((w) => w.workspace.id)).toContain("a1");
    expect(getCloudCatalog().createMemory[`${ORG}:a2`]).toBeDefined();
  });

  it("a list named by its organization that answers for another is invalid, not a stale account", async () => {
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => (orgId === ORG_B ? { workspaces: [item("wrong")] } : { workspaces: [] }));
    multi();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().orgs[ORG_B]?.error).toBe("cloud_workspace_invalid_response"));
    expect(mocks.refreshAccount).not.toHaveBeenCalled();
  });
});

describe("the cross-organization catalog feed (PRO-74)", () => {
  const ORG_B = "org-b";
  const ORG_C = "org-c";
  const orgs = [ORG, ORG_B, ORG_C].map((id) => ({ id, name: id, role: id === ORG ? "admin" : "member", isPersonal: false, cloud: { enabled: true, flags: {} } }));
  const inOrg = (orgId: string, id: string, fields: Record<string, unknown> = {}): CloudWorkspaceListItem => ({ ...item(id, fields), workspace: { ...item(id, fields).workspace, orgId } });
  // 3 organizations, 30 workspaces.
  const rows = (orgId: string) => Array.from({ length: 10 }, (_, index) => inOrg(orgId, `${orgId}-w${index}`));
  const whole = (cursor: string, patch: Partial<Record<string, CloudWorkspaceListItem[]>> = {}): CloudCatalogFeed => ({
    changed: true,
    cursor,
    reset: true,
    organizations: [ORG, ORG_B, ORG_C].map((orgId) => ({ orgId, workspaces: patch[orgId] ?? rows(orgId), tombstones: [], quota: { used: 1, limit: 2 } })),
    deletedWorkspaceIds: [],
  });
  const unchanged = (cursor: string): CloudCatalogFeed => ({ changed: false, cursor, reset: false, organizations: [], deletedWorkspaceIds: [] });
  // One status, announced once: a server with the feed never reports a status without it in between.
  const withFeed = (patch: Partial<AccountStatus> = {}) => {
    mocks.account.status = {
      state: "signed-in",
      identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
      expiresAt: null,
      lastError: null,
      organizations: orgs,
      multiOrg: true,
      catalogFeed: true,
      context: { scope: "s", revision: "s:1", account: "acct" },
      ...patch,
    };
    for (const listener of mocks.listeners) listener();
  };
  const idsIn = (orgId: string) => getCloudCatalog().orgs[orgId]?.workspaces.map((w) => w.workspace.id);
  /** The server as it behaves: the whole catalog once, then 304 while the cursor is current. */
  const serve = (current: () => CloudCatalogFeed) => mocks.api.cloudCatalogFeed.mockImplementation(async (cursor: string | null) => (cursor === current().cursor ? unchanged(cursor!) : current()));

  it("is used only on a server that advertises it, with every organization live", () => {
    signIn(orgs);
    expect(usesCatalogFeed()).toBe(false);
    mocks.account.status = { ...mocks.account.status, catalogFeed: true };
    // The feed spans organizations: without membership authorization it is not used.
    expect(usesCatalogFeed()).toBe(false);
    mocks.account.status = { ...mocks.account.status, multiOrg: true };
    expect(usesCatalogFeed()).toBe(true);
  });

  it("with 3 organizations and 30 workspaces, an idle desktop sends one request per interval, mostly answered 304, and no per-organization list", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    serve(() => whole("c1"));
    withFeed();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenLastCalledWith(null);
    expect([ORG, ORG_B, ORG_C].map((orgId) => idsIn(orgId)?.length)).toEqual([10, 10, 10]);
    const answers: boolean[] = [];
    const feed = mocks.api.cloudCatalogFeed.getMockImplementation()!;
    mocks.api.cloudCatalogFeed.mockImplementation(async (cursor: string | null) => {
      const answer = await feed(cursor);
      answers.push(answer.changed);
      return answer;
    });
    const before = getCloudCatalog().orgs;
    for (let interval = 1; interval <= 5; interval++) {
      await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
      expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(1 + interval);
      expect(mocks.api.cloudCatalogFeed).toHaveBeenLastCalledWith("c1");
    }
    expect(answers).toEqual([false, false, false, false, false]);
    expect(mocks.api.cloudWorkspaces).not.toHaveBeenCalled();
    // A 304 keeps every row object as it was: nothing is redrawn.
    for (const orgId of [ORG, ORG_B, ORG_C]) expect(getCloudCatalog().orgs[orgId].workspaces).toBe(before[orgId].workspaces);
    // The selected repositories are read once per organization (and again only after five minutes), not per interval.
    expect(mocks.api.cloudWorkspaceRepositories).toHaveBeenCalledTimes(3);
    // Looking never wakes compute.
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  });

  it("shows a change made on another device within one interval", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let current = whole("c1");
    serve(() => current);
    withFeed();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(idsIn(ORG_B)).not.toContain("made-elsewhere");
    // Someone creates a workspace in Beta from another machine.
    current = whole("c2", { [ORG_B]: [inOrg(ORG_B, "made-elsewhere"), ...rows(ORG_B)] });
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    expect(idsIn(ORG_B)).toContain("made-elsewhere");
    expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(2);
    // The new cursor is the one sent from now on.
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenLastCalledWith("c2");
  });

  it("polls every 3 s while a workspace in any organization is changing state", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    serve(() => whole("c1", { [ORG_C]: [inOrg(ORG_C, "starting", { state: "provisioning" })] }));
    withFeed();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_CHANGING_MS);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(2);
  });

  it("a reset rebuilds the catalog in one step per organization, keeps the session lists, and never passes through an empty state", async () => {
    let current = whole("c1");
    serve(() => current);
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG_C)).toHaveLength(10));
    const kept = `${ORG_B}-w3`;
    cacheCloudSessions(ORG_B, kept, [{ id: "s1", title: "Selected session" }] as never, null);
    const seen: (number | undefined)[] = [];
    const stop = subscribeCloudCatalog(() => seen.push(getCloudCatalog().orgs[ORG_B]?.workspaces.length));
    // The whole catalog again, with a row renamed and one gone.
    current = whole("c2", { [ORG_B]: rows(ORG_B).filter((row) => row.workspace.id !== `${ORG_B}-w9`).map((row) => (row.workspace.id === kept ? inOrg(ORG_B, kept, { name: "renamed" }) : row)) });
    await refreshCloudFeed();
    stop();
    expect(idsIn(ORG_B)).toHaveLength(9);
    expect(getCloudCatalog().orgs[ORG_B].workspaces.find((w) => w.workspace.id === kept)?.workspace.name).toBe("renamed");
    // The selected session's workspace is still there with its cached sessions: what is selected stays openable.
    expect(getCloudCatalog().orgs[ORG_B].sessions[kept]?.sessions.map((session) => session.id)).toEqual(["s1"]);
    // No listener ever saw the organization without rows.
    expect(seen.every((count) => count !== undefined && count >= 9)).toBe(true);
    expect(mocks.closeWorkspaceConnection).not.toHaveBeenCalled();
  });

  it("applies a delta: changed rows replace theirs, deleted ones leave, the rest stay", async () => {
    serve(() => whole("c1"));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG)).toHaveLength(10));
    mocks.api.cloudCatalogFeed.mockResolvedValueOnce({
      changed: true,
      cursor: "c2",
      reset: false,
      organizations: [{ orgId: ORG, workspaces: [inOrg(ORG, `${ORG}-w1`, { state: "suspended" }), inOrg(ORG, "new")], tombstones: [] }],
      deletedWorkspaceIds: [`${ORG}-w2`],
    } satisfies CloudCatalogFeed);
    await refreshCloudFeed();
    expect(idsIn(ORG)).toHaveLength(10);
    expect(idsIn(ORG)).toContain("new");
    expect(idsIn(ORG)).not.toContain(`${ORG}-w2`);
    expect(getCloudCatalog().orgs[ORG].workspaces.find((w) => w.workspace.id === `${ORG}-w1`)?.workspace.state).toBe("suspended");
    // An organization the delta does not mention is untouched.
    expect(idsIn(ORG_B)).toHaveLength(10);
    expect(getCloudCatalog().orgs[ORG_B].error).toBeNull();

    const merged = mergeFeedDelta([item("a"), item("b"), item("c")], { workspaces: [item("b", { name: "B2" }), item("d")], tombstones: [{ id: "c", orgId: ORG, deletedAt: 1, expiresAt: 2 }] }, ["a"]);
    expect(merged.workspaces.map((w) => [w.workspace.id, w.workspace.name])).toEqual([["d", "ws d"], ["b", "B2"]]);
  });

  it("purges what this desktop kept of a workspace the feed reports deleted", async () => {
    serve(() => whole("c1"));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG)).toHaveLength(10));
    const gone = `${ORG}-w4`;
    const next = whole("c2", { [ORG]: rows(ORG) });
    next.organizations[0].tombstones = [{ id: gone, orgId: ORG, deletedAt: 1, expiresAt: 2 }];
    next.deletedWorkspaceIds = [gone];
    mocks.api.cloudCatalogFeed.mockResolvedValueOnce(next);
    await refreshCloudFeed();
    expect(idsIn(ORG)).not.toContain(gone);
    expect(mocks.api.cloudAgentPurgeWorkspace).toHaveBeenCalledWith(ORG, gone);
  });

  it("keeps what an organization showed when the server could not list it, and the others update", async () => {
    serve(() => whole("c1"));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG_C)).toHaveLength(10));
    const partial = whole("c2", { [ORG]: [inOrg(ORG, "only")] });
    partial.organizations[1] = { orgId: ORG_B, workspaces: [], tombstones: [], error: "cloud_provider_unavailable" };
    mocks.api.cloudCatalogFeed.mockResolvedValueOnce(partial).mockResolvedValue({ changed: false, cursor: "c2", reset: false, organizations: [], deletedWorkspaceIds: [] });
    await refreshCloudFeed();
    expect(idsIn(ORG)).toEqual(["only"]);
    expect(idsIn(ORG_B)).toHaveLength(10);
    expect(getCloudCatalog().orgs[ORG_B].error).toBe("cloud_provider_unavailable");
    // A 304 for that same answer does not say the organization is listed now.
    await refreshCloudFeed();
    expect(getCloudCatalog().orgs[ORG_B].error).toBe("cloud_provider_unavailable");
    expect(getCloudCatalog().orgs[ORG].error).toBeNull();
  });

  it("a failed request never replaces valid rows, and the next one reads on", async () => {
    serve(() => whole("c1"));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG)).toHaveLength(10));
    mocks.api.cloudCatalogFeed.mockRejectedValueOnce({ code: "cloud_workspace_unavailable" });
    await refreshCloudFeed();
    for (const orgId of [ORG, ORG_B, ORG_C]) {
      expect(idsIn(orgId)).toHaveLength(10);
      expect(getCloudCatalog().orgs[orgId].error).toBe("cloud_workspace_unavailable");
    }
    expect(usesCatalogFeed()).toBe(true);
    serve(() => whole("c1"));
    await refreshCloudFeed();
    expect(getCloudCatalog().orgs[ORG].error).toBeNull();
  });

  it("drops rows that name another organization than the one they were listed under", async () => {
    mocks.api.cloudCatalogFeed.mockResolvedValue(whole("c1", { [ORG_B]: [inOrg(ORG, "misfiled")] }));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(getCloudCatalog().orgs[ORG_B]?.error).toBe("cloud_workspace_invalid_response"));
    expect(idsIn(ORG_B)).toEqual([]);
    expect(idsIn(ORG)).toHaveLength(10);
  });

  it("gives nothing to an organization the user left while the request was in flight, or after signing out", async () => {
    let answer!: (feed: CloudCatalogFeed) => void;
    mocks.api.cloudCatalogFeed.mockImplementation(() => new Promise<CloudCatalogFeed>((resolve) => (answer = resolve)));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(1));
    const first = answer;
    withFeed({ organizations: orgs.filter((org) => org.id !== ORG_C) });
    first(whole("c1"));
    await vi.waitFor(() => expect(idsIn(ORG)).toHaveLength(10));
    expect(getCloudCatalog().orgs[ORG_C]).toBeUndefined();

    resetCloudCatalog();
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(2));
    const second = answer;
    mocks.account.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
    for (const listener of mocks.listeners) listener();
    second(whole("c1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(getCloudCatalog().orgs).toEqual({});
  });

  it("an older server keeps per-organization polling, and a server that refuses the feed falls back to it", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => ({ workspaces: [inOrg(orgId!, `${orgId}-listed`)] }));
    // No capability: the feed is never asked.
    signIn(orgs);
    mocks.account.status = { ...mocks.account.status, multiOrg: true, context: { scope: "s", revision: "s:1", account: "acct" } };
    for (const listener of mocks.listeners) listener();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    expect(mocks.api.cloudCatalogFeed).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(6);
    resetCloudCatalog();

    // Advertised, but the native side says it is not there after all.
    mocks.api.cloudWorkspaces.mockClear();
    mocks.api.cloudCatalogFeed.mockRejectedValue({ code: "cloud_catalog_feed_unavailable" });
    withFeed();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(1);
    expect(usesCatalogFeed()).toBe(false);
    expect([ORG, ORG_B, ORG_C].map((orgId) => idsIn(orgId))).toEqual([[`${ORG}-listed`], [`${ORG_B}-listed`], [`${ORG_C}-listed`]]);
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    // Per-organization polling from then on; the feed is not tried again for this account.
    expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(6);
  });

  it("a server that advertises the feed and answers 404 falls back to per-organization lists at once", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => ({ workspaces: [inOrg(orgId!, `${orgId}-listed`)] }));
    // What the native side hands over for an unknown 404: its own code, with the status beside it.
    mocks.api.cloudCatalogFeed.mockRejectedValue({ code: "cloud_workspace_unavailable", status: 404, retryable: true });
    withFeed();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(usesCatalogFeed()).toBe(false);
    expect([ORG, ORG_B, ORG_C].map((orgId) => idsIn(orgId))).toEqual([[`${ORG}-listed`], [`${ORG_B}-listed`], [`${ORG_C}-listed`]]);
    expect([ORG, ORG_B, ORG_C].map((orgId) => getCloudCatalog().orgs[orgId].error)).toEqual([null, null, null]);
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS * 3);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(1);
  });

  it("after a few feed failures in a row each organization is listed on its own, and the feed is tried again later", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    serve(() => whole("c1"));
    mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => ({ workspaces: [inOrg(orgId!, `${orgId}-listed`)] }));
    withFeed();
    bootCloudCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(idsIn(ORG)).toHaveLength(10);

    // The feed starts failing (a 5xx, or a catalog over the size cap).
    mocks.api.cloudCatalogFeed.mockRejectedValue({ code: "cloud_provider_unavailable", status: 503 });
    for (let failure = 1; failure < FEED_FAILURES_BEFORE_FALLBACK; failure++) {
      await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
      // Still the feed's job: the rows stay, with the reason.
      expect(usesCatalogFeed()).toBe(true);
      expect(idsIn(ORG)).toHaveLength(10);
      expect(getCloudCatalog().orgs[ORG].error).toBe("cloud_provider_unavailable");
      expect(mocks.api.cloudWorkspaces).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS);
    // The third failure: per-organization lists take over and the rows are current again.
    expect(usesCatalogFeed()).toBe(false);
    expect([ORG, ORG_B, ORG_C].map((orgId) => idsIn(orgId))).toEqual([[`${ORG}-listed`], [`${ORG_B}-listed`], [`${ORG_C}-listed`]]);
    expect(getCloudCatalog().orgs[ORG].error).toBeNull();
    const feedCalls = mocks.api.cloudCatalogFeed.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_FOCUSED_MS * 2);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenCalledTimes(feedCalls);
    expect(mocks.api.cloudWorkspaces.mock.calls.length).toBeGreaterThanOrEqual(9);

    // Later the feed is tried again, from the start (no stale cursor), and takes over when it answers.
    serve(() => whole("c9"));
    await vi.advanceTimersByTimeAsync(FEED_RETRY_AFTER_MS + POLL_FOCUSED_MS);
    expect(mocks.api.cloudCatalogFeed.mock.calls.length).toBeGreaterThan(feedCalls);
    expect(mocks.api.cloudCatalogFeed.mock.calls[feedCalls]).toEqual([null]);
    expect(usesCatalogFeed()).toBe(true);
    expect(idsIn(ORG)).toHaveLength(10);
  });

  it("a delta that only names deleted workspaces removes them, in an organization it has no entry for", async () => {
    serve(() => whole("c1"));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG_B)).toHaveLength(10));
    mocks.api.cloudCatalogFeed.mockResolvedValueOnce({ changed: true, cursor: "c2", reset: false, organizations: [], deletedWorkspaceIds: [`${ORG_B}-w3`] } satisfies CloudCatalogFeed);
    await refreshCloudFeed();
    expect(idsIn(ORG_B)).toHaveLength(9);
    expect(idsIn(ORG_B)).not.toContain(`${ORG_B}-w3`);
    expect(idsIn(ORG)).toHaveLength(10);
  });

  it("does not keep the cursor of an answer it could not take whole, so the next request reads everything again", async () => {
    let answer!: (feed: CloudCatalogFeed) => void;
    serve(() => whole("c1"));
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG_B)).toHaveLength(10));
    // A feed request is in flight; meanwhile Beta is listed on its own (asked later, answered first).
    mocks.api.cloudCatalogFeed.mockImplementationOnce(() => new Promise<CloudCatalogFeed>((resolve) => (answer = resolve)));
    const later = Date.now() + 60_000;
    const flight = refreshCloudFeed(() => later);
    await vi.waitFor(() => expect(answer).toBeDefined());
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [inOrg(ORG_B, "own-list")] });
    await refreshCloudCatalog(ORG_B, () => later + 1_000);
    answer(whole("c2", { [ORG_B]: [inOrg(ORG_B, "from-the-feed")] }));
    await flight;
    // The newer per-organization rows stand.
    expect(idsIn(ORG_B)).toEqual(["own-list"]);
    // The desktop does not hold catalog c2, so it does not claim to: the next request sends no cursor.
    mocks.api.cloudCatalogFeed.mockResolvedValueOnce(whole("c3", { [ORG_B]: [inOrg(ORG_B, "from-the-feed")] }));
    await refreshCloudFeed(() => later + 5_000);
    expect(mocks.api.cloudCatalogFeed).toHaveBeenLastCalledWith(null);
    expect(idsIn(ORG_B)).toEqual(["from-the-feed"]);
  });

  it("one organization's own refresh still lists that organization directly", async () => {
    serve(() => whole("c1"));
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [inOrg(ORG_B, "fresh")] });
    withFeed();
    bootCloudCatalog();
    await vi.waitFor(() => expect(idsIn(ORG_B)).toHaveLength(10));
    await refreshCloudCatalog(ORG_B);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledWith(ORG_B);
    expect(idsIn(ORG_B)).toEqual(["fresh"]);
  });
});

describe("the account's role, as the workspace list reports it", () => {
  const roles = { refresh: vi.fn(async () => undefined), listed: vi.fn() };
  beforeEach(() => {
    roles.refresh.mockClear();
    roles.listed.mockClear();
    registerAccountRoles(roles);
  });
  afterEach(() => registerAccountRoles(null));
  const you = (role: string) => ({ you: { role, canApprove: role === "manager" } });

  it("reads manager as an owner or admin, anything else as a member, and nothing from a list that does not say", () => {
    expect(listedOrgManages({ workspaces: [item("w1", you("manager")), item("w2", you("manager"))] })).toBe(true);
    expect(listedOrgManages({ workspaces: [item("w1", you("driver")), item("w2", you("none"))] })).toBe(false);
    // A server that reports no roles still says what opening would grant.
    expect(listedOrgManages({ workspaces: [item("w1", { authority: "manage" })] })).toBe(true);
    expect(listedOrgManages({ workspaces: [item("w1", { authority: "participate" })] })).toBe(false);
    // The role wins over the authority.
    expect(listedOrgManages({ workspaces: [item("w1", { ...you("viewer"), authority: "manage" })] })).toBe(false);
    expect(listedOrgManages({ workspaces: [] })).toBeNull();
    expect(listedOrgManages({ workspaces: [item("w1")] })).toBeNull();
    expect(listedOrgManages({ workspaces: [item("w1", you("manager")), item("w2", you("driver"))] })).toBeNull();
  });

  it("tells the account what each list says, with when the list was asked for", async () => {
    signIn();
    let now = 1_000;
    mocks.api.cloudWorkspaces.mockResolvedValueOnce({ workspaces: [item("w1", you("driver"))] });
    bootCloudCatalog();
    await refreshCloudCatalog(ORG, () => now++);
    await vi.waitFor(() => expect(roles.listed).toHaveBeenCalled());
    const [orgId, manages, askedAt] = roles.listed.mock.calls.at(-1)!;
    expect([orgId, manages]).toEqual([ORG, false]);
    expect(askedAt).toBeGreaterThan(0);
    // A list alone never asks the account service; the account store decides.
    expect(roles.refresh).not.toHaveBeenCalled();
  });

  it("a list refused as not found means this account is not a member: the organizations are read again", async () => {
    signIn();
    bootCloudCatalog();
    await refreshCloudCatalog(ORG);
    roles.refresh.mockClear();
    mocks.api.cloudWorkspaces.mockRejectedValueOnce({ code: "cloud_workspace_not_found", status: 404 });
    await refreshCloudCatalog(ORG);
    expect(roles.refresh).toHaveBeenCalledExactlyOnceWith(true);
    // An ordinary failure does not.
    roles.refresh.mockClear();
    mocks.api.cloudWorkspaces.mockRejectedValueOnce({ code: "cloud_workspace_unavailable" });
    await refreshCloudCatalog(ORG);
    expect(roles.refresh).not.toHaveBeenCalled();
  });

  it("Refresh cloud workspaces reads the roles from the server and lists", async () => {
    signIn();
    bootCloudCatalog();
    await refreshCloudCatalog(ORG);
    roles.refresh.mockClear();
    mocks.api.cloudWorkspaces.mockClear();
    await refreshCloudWorkspaces(ORG);
    expect(roles.refresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1);
  });
});

describe("a workspace no longer in this person's list", () => {
  it("keeps the names their sidebar showed for it, for this launch only", async () => {
    signIn();
    expect(lastKnownWorkspace("never-listed")).toBeNull();
    await ingestCloudList({ workspaces: [item("w-repo", { name: "api work", repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: null, primary: true }] }), item("w-blank", { name: "share-demo", repositories: [] })] }, ORG, 10, 10);
    // Made private again: the next list no longer has them.
    await ingestCloudList({ workspaces: [] }, ORG, 20, 20);
    expect(getCloudCatalog().orgs[ORG].workspaces).toEqual([]);
    expect(lastKnownWorkspace("w-repo")).toEqual({ name: "api work", project: "acme/api" });
    expect(lastKnownWorkspace("w-blank")).toEqual({ name: "share-demo", project: "share-demo" });
    // Nothing of it is saved for the next launch.
    expect(JSON.stringify(serializeCatalog(getCloudCatalog()))).not.toContain("share-demo");
  });
});
