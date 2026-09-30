import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudSelectedRepository, CloudWorkspaceListItem } from "@/lib/api";

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
  cloudOrganizations,
  defaultOrgId,
  flushCloudCatalogSave,
  getCloudCatalog,
  ingestCloudList,
  parseCatalog,
  placeCloudProjects,
  pollDelay,
  POLL_CHANGING_MS,
  POLL_FOCUSED_MS,
  refreshCloudCatalog,
  rememberCreatedWorkspace,
  resetCloudCatalog,
  serializeCatalog,
  type OrgCatalog,
} from "./cloudCatalog";
import { resetPurged } from "./cloudLifecycle";
import { createWorkspace, type CreateApi } from "./cloudCreate";

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
  it("polls every 30 s while focused, every 3 s while something changes, and pauses while hidden", () => {
    expect(pollDelay(org([item("w")]), { visible: true, focused: true })).toBe(POLL_FOCUSED_MS);
    expect(pollDelay(org([item("w")]), { visible: true, focused: false })).toBeNull();
    expect(pollDelay(org([changing]), { visible: true, focused: false })).toBe(POLL_CHANGING_MS);
    expect(pollDelay(org([changing]), { visible: false, focused: false })).toBeNull();
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
