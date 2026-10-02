import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudSelectedRepository, CloudWorkspaceList, CloudWorkspaceListItem } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaces: vi.fn(),
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
  cloudOrgArg,
  cloudOrganizations,
  defaultOrgId,
  flushCloudCatalogSave,
  getCloudCatalog,
  ingestCloudList,
  lastKnownWorkspace,
  listedOrgManages,
  liveCloudOrgIds,
  parseCatalog,
  placeCloudProjects,
  pollDelay,
  ACCESS_REFRESH_DELAY_MS,
  POLL_BACKGROUND_MS,
  POLL_CHANGING_MS,
  POLL_FOCUSED_MS,
  REFRESH_ON_RETURN_FLOOR_MS,
  refreshCloudCatalog,
  refreshCloudWorkspaces,
  rememberCreatedWorkspace,
  resetCloudCatalog,
  serializeCatalog,
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
