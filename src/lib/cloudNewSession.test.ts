import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// CS-13 subset (PRO-61): `+` on a cloud project. Reuse the latest running
// workspace, else wake a stopped one exactly once, else create one only after
// a cost confirmation; then `session.create` on the runtime, with a worktree
// when the local preference asks, and select the new session.

const mocks = vi.hoisted(() => ({
  api: {
    cloudProviders: vi.fn(),
    cloudWorkspacePreflight: vi.fn(),
    cloudWorkspaceSetup: vi.fn(),
    cloudWorkspaceQuote: vi.fn(),
    cloudWorkspaceCreate: vi.fn(),
    cloudWorkspaceResume: vi.fn(),
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
  },
  workspaceConnection: vi.fn(),
  invoke: vi.fn(),
  status: null as unknown as AccountStatus,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  workspaceConnection: mocks.workspaceConnection,
  hasWorkspaceConnection: () => true,
  closeWorkspaceConnection: vi.fn(),
}));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));

const flow = await import("./cloudNewSession");
const catalog = await import("./cloudCatalog");
const connections = await import("./cloudConnections");
const cloudSessions = await import("./cloudSessions");
const sessions = await import("./sessions");
const { resetCloudAgents } = await import("./cloudAgents");

const ORG = "org-a";
const connected: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: ["session/1", "session/2"], authority: "manage" };

/** A runtime: session.create makes a session with one tab. */
function fakeRuntime(workspaceId: string, initial: WorkspaceConnectionState) {
  const listeners = new Set<(state: WorkspaceConnectionState) => void>();
  let current = initial;
  let next = 0;
  const created: Record<string, unknown>[] = [];
  const client = {
    get connection() {
      return current;
    },
    onState: (listener: (state: WorkspaceConnectionState) => void) => {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    hasCapability: (capability: string) => current.state === "connected" && current.capabilities.includes(capability),
    createAgentTab: vi.fn(async (params: Record<string, unknown>) => {
      created.push(params);
      next++;
      const sessionId = `${workspaceId}-s${next}`;
      const tabId = `${workspaceId}-t${next}`;
      return {
        sessionId,
        tabId,
        tab: { sessionId, tabId, title: null, harness: String(params.agent), model: "", effort: null, permissionMode: "bypassPermissions", status: "in_progress", process: "running", pendingPermissions: [], followUps: [], lastSeq: 0, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" },
      };
    }),
    listSessions: vi.fn(async () =>
      created.map((params, index) => ({ id: `${workspaceId}-s${index + 1}`, projectPath: "/workspace", cwd: "/workspace", title: String(params.title ?? ""), created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z", archived: false, pinned: false, tabs: [] })),
    ),
    listAgentTabs: vi.fn(async () => []),
    onSessions: () => () => undefined,
    onNotification: () => () => undefined,
    nudgeMailbox: vi.fn(async () => undefined),
  };
  return {
    connection: { target: { kind: "cloud", organizationId: ORG, workspaceId }, client, activate: vi.fn(async () => set(connected)), close: vi.fn() },
    created,
    set,
  };
  function set(state: WorkspaceConnectionState) {
    current = state;
    for (const listener of [...listeners]) listener(state);
  }
}

const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();

function item(id: string, fields: Record<string, unknown> = {}): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId: ORG, name: id, provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 10, releaseDisposition: null, ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

const api = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };

function signIn() {
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    organizations: [{ id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } }],
  };
}

async function place(workspaces: CloudWorkspaceListItem[], quota: { used: number; limit: number } | null = { used: workspaces.length, limit: 2 }) {
  await catalog.ingestCloudList({ workspaces, quota }, ORG);
}

function project(identity: string, blank: string[] = []) {
  const org = catalog.getCloudCatalog().orgs[ORG];
  return catalog.placeCloudProjects(org, {}, { blank }).projects.find((p) => p.identity === identity)!;
}

const request = { agent: "claude", model: "opus", effort: null, mode: "bypassPermissions", prompt: "Fix the login redirect\nand add a test", useWorktree: true };

beforeEach(() => {
  signIn();
  runtimes.clear();
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.workspaceConnection.mockReset().mockImplementation(async (target: { workspaceId: string }, activation: string) => {
    let runtime = runtimes.get(target.workspaceId);
    if (!runtime) {
      const listed = catalog.findCloudWorkspace(catalog.getCloudCatalog(), ORG, target.workspaceId);
      const stopped = listed?.workspace.state === "suspended";
      runtimes.set(target.workspaceId, (runtime = fakeRuntime(target.workspaceId, stopped && activation !== "wake" ? { state: "suspended" } : { state: "connecting", attempt: 1 })));
      // The native side resumes a stopped workspace on a wake attach, then the runtime connects.
      if (!stopped || activation === "wake") queueMicrotask(() => runtime!.set(connected));
    }
    return runtime.connection;
  });
  mocks.api.cloudProviders.mockResolvedValue({ providers: [{ id: "box", displayName: "Box", availability: "available" }] });
  mocks.api.cloudWorkspacePreflight.mockResolvedValue({ ready: true, checks: [] });
  mocks.api.cloudWorkspaceSetup.mockResolvedValue({ defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 30, retentionDays: 7, networkPolicy: "open" } });
  mocks.api.cloudWorkspaceQuote.mockResolvedValue({
    id: "quote-1",
    currency: "USD",
    pricing: "provider-rate",
    activeHourlyMicros: 120_000,
    estimatedSuspendedMonthlyMicros: 2_000_000,
    configuration: { machineClassLabel: "Small", vcpu: 2, memoryMiB: 4096, locationLabel: "Frankfurt", idleSuspendMinutes: 30 },
  });
  cloudSessions.bootCloudSessions();
});

afterEach(() => {
  connections.resetCloudConnections();
  cloudSessions.resetCloudSessions();
  catalog.resetCloudCatalog();
  resetCloudAgents();
  sessions.selectSession(null);
});

describe("new session in a cloud project", () => {
  it("reuses the most recently active running workspace, with a worktree, and selects the new session", async () => {
    await place([item("old", { repositories: [api], lastActivityAt: 5 }), item("recent", { repositories: [api], lastActivityAt: 50 })]);
    const plan = flow.planCloudStart(project("github.com/acme/api"));
    expect(plan).toMatchObject({ kind: "reuse", node: { key: `cloud:${ORG}:recent` } });
    const key = await flow.startInWorkspace(plan as never, request);
    expect(key).toBe(`cloud:${ORG}:recent:recent-s1`);
    expect(sessions.getSessionStore().selectedSessionId).toBe(key);
    expect(runtimes.get("recent")!.created[0]).toMatchObject({ agent: "claude", model: "opus", useWorktree: true, prompt: request.prompt, title: "Fix the login redirect" });
    expect(mocks.workspaceConnection.mock.calls).toEqual([[{ kind: "cloud", organizationId: ORG, workspaceId: "recent" }, "connect"]]);
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  });

  it("follows the local worktree preference when it is off", async () => {
    await place([item("recent", { repositories: [api] })]);
    await flow.startInWorkspace(flow.planCloudStart(project("github.com/acme/api")) as never, { ...request, useWorktree: false });
    expect(runtimes.get("recent")!.created[0].useWorktree).toBe(false);
  });

  it("makes exactly one wake for new sessions on a stopped workspace, however many start at once", async () => {
    await place([item("sleepy", { state: "suspended", repositories: [api] })]);
    const plan = flow.planCloudStart(project("github.com/acme/api"));
    expect(plan.kind).toBe("wake");
    const keys = await Promise.all([flow.startInWorkspace(plan as never, request), flow.startInWorkspace(plan as never, { ...request, prompt: "Second" })]);
    expect([...keys].sort()).toEqual([`cloud:${ORG}:sleepy:sleepy-s1`, `cloud:${ORG}:sleepy:sleepy-s2`]);
    const wakes = mocks.workspaceConnection.mock.calls.filter((call) => call[1] === "wake").length + runtimes.get("sleepy")!.connection.activate.mock.calls.length;
    expect(wakes).toBe(1);
    // The native attach resumes it; nothing here calls resume on its own.
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("puts two sessions in one project on the same workspace and connection", async () => {
    await place([item("recent", { repositories: [api] })]);
    const node = project("github.com/acme/api");
    await flow.startInWorkspace(flow.planCloudStart(node) as never, request);
    await flow.startInWorkspace(flow.planCloudStart(node) as never, { ...request, prompt: "Add tests" });
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(runtimes.get("recent")!.created.map((params) => params.title)).toEqual(["Fix the login redirect", "Add tests"]);
    // Both are listed under the project once the runtime's list is read.
    await vi.waitFor(() => {
      const rows = cloudSessions.buildCloudSessions({ item: catalog.findCloudWorkspace(catalog.getCloudCatalog(), ORG, "recent")!, cached: catalog.getCloudCatalog().orgs[ORG].sessions.recent });
      expect(rows.map((row) => row.title).sort()).toEqual(["Add tests", "Fix the login redirect"]);
    });
  });

  it("a create needs the cost confirmation: nothing is created until it is confirmed, and the quota is shown", async () => {
    await place([], { used: 1, limit: 2 });
    const target = catalog.placeCloudProjects(catalog.getCloudCatalog().orgs[ORG], {}, { added: [] }).projects[0] ?? {
      key: `cloud:${ORG}:github.com/acme/web`,
      orgId: ORG,
      identity: "github.com/acme/web",
      fullName: "acme/web",
      selected: true,
      pinned: false,
      blank: false,
      workspaces: [],
    };
    expect(flow.planCloudStart(target)).toEqual({ kind: "create" });
    const prepared = await flow.prepareCloudCreate(target, request);
    expect(prepared.quota).toEqual({ used: 1, limit: 2 });
    expect(prepared.quote.activeHourlyMicros).toBe(120_000);
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();

    const created = item("fresh", { state: "provisioning", repositories: [{ ...api, identity: "github.com/acme/web", fullName: "acme/web" }], launch: { launchId: "l", phase: "allocating", state: "pending", workBranch: "terminalx/x", agent: "claude", sessionId: null, tabId: null, timings: {} } });
    mocks.api.cloudWorkspaceCreate.mockResolvedValue({ workspace: created.workspace, operation: { id: "op", state: "running", type: "create", stage: "queued" } });
    sessions.startCloudSessionIn(target.key);
    await flow.confirmCloudCreate(prepared);
    expect(mocks.api.cloudWorkspaceCreate).toHaveBeenCalledTimes(1);
    const sent = mocks.api.cloudWorkspaceCreate.mock.calls[0][0];
    expect(sent).toMatchObject({ confirmProviderSpend: true, quoteId: "quote-1", repositories: [{ cloneUrl: "https://github.com/acme/web.git", ref: null }], launch: { agent: "claude", prompt: request.prompt } });
    expect(sent.idempotencyKey).toBe(prepared.pending.idempotencyKey);
    // The first session is selected once the runtime names it.
    await place([{ ...created, workspace: { ...created.workspace, state: "ready", launch: { ...created.workspace.launch!, phase: "running", state: "started", sessionId: "first", tabId: "t" } } }]);
    expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:fresh:first`);
  });

  it("at the limit, sends no quote and no create", async () => {
    await place([], { used: 2, limit: 2 });
    const target = { key: `cloud:${ORG}:github.com/acme/web`, orgId: ORG, identity: "github.com/acme/web", fullName: "acme/web", selected: true, pinned: false, blank: false, workspaces: [] } as never;
    await expect(flow.prepareCloudCreate(target, request)).rejects.toMatchObject({ code: "cloud_workspace_quota_exceeded" });
    expect(mocks.api.cloudWorkspaceQuote).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  });
});

describe("blank projects", () => {
  it("the first session creates one workspace with no repository, named after the project; a second session reuses it", async () => {
    await place([], { used: 0, limit: 2 });
    const pending = project("blank/scratch", ["scratch"]);
    expect(pending).toMatchObject({ blank: true, fullName: "scratch", workspaces: [] });
    expect(flow.planCloudStart(pending)).toEqual({ kind: "create" });
    const prepared = await flow.prepareCloudCreate(pending, request);
    // No repository to check: only that the prompt's agent has a login (PRO-78).
    expect(mocks.api.cloudWorkspacePreflight).toHaveBeenCalledTimes(1);
    const [checked, , agent] = mocks.api.cloudWorkspacePreflight.mock.calls[0]!;
    expect([checked, agent]).toEqual([[], "claude"]);
    const created = item("scratch-ws", { name: "scratch", repositories: [], state: "ready" });
    mocks.api.cloudWorkspaceCreate.mockResolvedValue({ workspace: created.workspace, operation: { id: "op", state: "succeeded", type: "create", stage: "ready" } });
    await flow.confirmCloudCreate(prepared);
    expect(mocks.api.cloudWorkspaceCreate).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceCreate.mock.calls[0][0]).toMatchObject({ name: "scratch", repositories: [] });

    // The server lists it: the same project, now with its workspace; the next `+` reuses it.
    await place([created]);
    const again = project("blank/scratch", ["scratch"]);
    expect(again.workspaces.map((node) => node.item.workspace.id)).toEqual(["scratch-ws"]);
    const plan = flow.planCloudStart(again);
    expect(plan.kind).toBe("reuse");
    await flow.startInWorkspace(plan as never, { ...request, prompt: "Second task" });
    expect(mocks.api.cloudWorkspaceCreate).toHaveBeenCalledTimes(1);
    expect(runtimes.get("scratch-ws")!.created).toHaveLength(1);
  });

  it("falls back to working in the folder when the runtime cannot cut a worktree there", async () => {
    await place([item("old-blank", { name: "notes", repositories: [] })]);
    const node = project("blank/notes");
    const runtime = () => runtimes.get("old-blank")!;
    const plan = flow.planCloudStart(node);
    const started = flow.startInWorkspace(plan as never, request);
    await vi.waitFor(() => expect(runtimes.has("old-blank")).toBe(true));
    runtime().connection.client.createAgentTab.mockRejectedValueOnce(new Error("not a git repository"));
    await started;
    const calls = runtime().connection.client.createAgentTab.mock.calls.map((call) => (call[0] as { useWorktree: boolean }).useWorktree);
    expect(calls.at(-1)).toBe(false);
  });
});

describe("every organization live (CS-18)", () => {
  const ORG_B = "org-b";
  const target = { key: `cloud:${ORG_B}:github.com/beta/web`, orgId: ORG_B, identity: "github.com/beta/web", fullName: "beta/web", selected: true, pinned: false, blank: false, workspaces: [] } as never;

  beforeEach(async () => {
    mocks.status = {
      ...mocks.status,
      multiOrg: true,
      organizations: [
        { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
        { id: ORG_B, name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: { "cloud.workspaces.provider.machine0.v1": false, "cloud.workspaces.provider.box.v1": true } } },
      ],
    };
    await catalog.ingestCloudList({ workspaces: [], quota: { used: 0, limit: 2 } }, ORG_B);
  });

  it("creates in another organization without switching: every call names it, and its provider comes from its flags", async () => {
    const prepared = await flow.prepareCloudCreate(target, request);
    // That organization's provider list is answered only while it is the default one.
    expect(mocks.api.cloudProviders).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceSetup).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceSetup).toHaveBeenCalledWith("box", ORG_B);
    expect(mocks.api.cloudWorkspacePreflight).toHaveBeenCalledWith(expect.any(Array), ORG_B, "claude");
    expect(mocks.api.cloudWorkspaceQuote).toHaveBeenCalledWith(expect.objectContaining({ provider: "box" }), ORG_B);
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();

    const created = { ...item("fresh-b", { state: "provisioning" }), workspace: { ...item("fresh-b", { state: "provisioning" }).workspace, orgId: ORG_B } };
    mocks.api.cloudWorkspaceCreate.mockResolvedValue({ workspace: created.workspace, operation: { id: "op", state: "running", type: "create", stage: "queued" } });
    await flow.confirmCloudCreate(prepared);
    expect(mocks.api.cloudWorkspaceCreate).toHaveBeenCalledWith(expect.objectContaining({ confirmProviderSpend: true }), ORG_B);
  });

  it("says a provider is needed when none offered by the organization is connected in it", async () => {
    mocks.api.cloudWorkspaceSetup.mockRejectedValue({ code: "cloud_provider_connection_required" });
    await expect(flow.prepareCloudCreate(target, request)).rejects.toMatchObject({ code: "cloud_provider_connection_required" });
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  });

  it("moves past a provider only when it is not connected there, and names it for people", async () => {
    mocks.status = {
      ...mocks.status,
      organizations: mocks.status.organizations!.map((org) =>
        org.id === ORG_B ? { ...org, cloud: { enabled: true, flags: { "cloud.workspaces.provider.machine0.v1": true, "cloud.workspaces.provider.box.v1": true } } } : org,
      ),
    };
    mocks.api.cloudWorkspaceSetup.mockImplementation(async (provider: string) => {
      if (provider === "machine0") throw { code: "cloud_provider_connection_required" };
      return { defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 30, retentionDays: 7, networkPolicy: "open" } };
    });
    const prepared = await flow.prepareCloudCreate(target, request);
    expect(mocks.api.cloudWorkspaceSetup.mock.calls.map(([provider]) => provider)).toEqual(["machine0", "box"]);
    expect(prepared.form.provider).toBe("box");
    expect(prepared.providerLabel).toBe("Box");
  });

  it.each(["organization_admin_required", "cloud_workspace_network_unavailable", "cloud_workspace_rate_limited"])("shows the real setup error (%s) instead of trying the next provider", async (code) => {
    mocks.api.cloudWorkspaceSetup.mockRejectedValue({ code, retryable: true });
    await expect(flow.prepareCloudCreate(target, request)).rejects.toMatchObject({ code });
    expect(mocks.api.cloudWorkspaceSetup).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceQuote).not.toHaveBeenCalled();
  });

  it("the default organization still reads its provider list, and names itself", async () => {
    await place([], { used: 0, limit: 2 });
    const own = { ...(target as object), key: `cloud:${ORG}:github.com/acme/web`, orgId: ORG, identity: "github.com/acme/web", fullName: "acme/web" } as never;
    await flow.prepareCloudCreate(own, request);
    expect(mocks.api.cloudProviders).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceSetup).toHaveBeenCalledWith("box", ORG);
  });
});
