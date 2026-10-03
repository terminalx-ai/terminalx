import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// PRO-40: the `terminalx` CLI's cloud commands, run in the window through the
// real stores. What matters most here: the CLI can do what the signed-in
// person can do in the app and nothing more, and looking never wakes compute.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: null as unknown as AccountStatus,
  api: {
    cloudWorkspaceResume: vi.fn(),
    cloudWorkspaceSuspend: vi.fn(),
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudProviders: vi.fn(),
    cloudWorkspaceSetup: vi.fn(),
    cloudWorkspaceQuote: vi.fn(),
    cloudWorkspacePreflight: vi.fn(),
    cloudWorkspaceCreate: vi.fn(),
    cloudWorkspaceOperation: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudRemoteAttach: vi.fn(),
  },
  workspaceConnection: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, api: { ...original.api, ...mocks.api }, workspaceConnection: mocks.workspaceConnection, closeWorkspaceConnection: vi.fn() };
});
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));
vi.mock("@/lib/cloudConnections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cloudConnections")>();
  return {
    ...original,
    wakeCloudConnection: vi.fn(async () => ({ release: vi.fn() })),
    retainCloudConnection: vi.fn(async () => ({ release: vi.fn() })),
    connectedCloudClient: vi.fn(() => null),
  };
});
vi.mock("@/lib/cloudNewSession", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cloudNewSession")>();
  return { ...original, startInWorkspace: vi.fn(async (plan: { node: { key: string } }) => `${plan.node.key}:new-session`), prepareCloudCreate: vi.fn(), confirmCloudCreate: vi.fn() };
});

const { answerCloudControl, handleCloudControl, waitForCloudTab, CloudControlError } = await import("./cloudControl");
const catalog = await import("@/lib/cloudCatalog");
const connections = await import("@/lib/cloudConnections");
const newSession = await import("@/lib/cloudNewSession");
const sessions = await import("@/lib/sessions");
const { resetCloudAgents } = await import("@/lib/cloudAgents");
const { resetCloudSessions } = await import("@/lib/cloudSessions");
const { resetCloudDashboard } = await import("@/lib/cloudDashboard");
const { resetCollab } = await import("@/lib/cloudCollab");
const { resetCloudWakes } = await import("@/lib/sessionBackend");

const ORG = "org-a";
const OTHER = "org-b";
const acmeApi = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
const acmeWeb = { identity: "github.com/acme/web", fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git", primary: true };
const PROJECT = `cloud:${ORG}:github.com/acme/api`;

function item(id: string, orgId: string, fields: Record<string, unknown> = {}): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [acmeApi], authority: "manage", you: { role: "manager", canApprove: true, canManageShares: true }, ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

const tabInfo = (sessionId: string, status = "idle") => ({
  sessionId,
  tabId: `${sessionId}-tab`,
  title: null,
  harness: "claude",
  model: "opus",
  effort: null,
  permissionMode: "default",
  status,
  process: "stopped",
  pendingPermissions: [],
  followUps: [],
  lastSeq: 2,
  created: "2026-09-30T10:00:00.000Z",
  modified: "2026-09-30T10:00:00.000Z",
});
const session = (id: string, title: string) => ({
  id,
  projectPath: "/workspace",
  cwd: "/workspace",
  title,
  created: "2026-09-30T10:00:00.000Z",
  modified: "2026-09-30T11:00:00.000Z",
  archived: false,
  pinned: false,
  tabs: [{ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "default", status: "idle", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
});
const events = [
  { id: "e1", sessionId: "s1", tabId: "s1-tab", seq: 1, ts: 1, payload: { type: "user_message", text: "fix the login" } },
  { id: "e2", sessionId: "s1", tabId: "s1-tab", seq: 2, ts: 2, payload: { type: "assistant_message", text: "done" } },
];
/** What this desktop saved of each workspace's agent tabs. */
let cached: Record<string, Record<string, unknown>> = {};
let enqueued: Record<string, unknown>[] = [];

function signIn(roles: Record<string, string> = { [ORG]: "admin", [OTHER]: "member" }) {
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    multiOrg: true,
    organizations: [
      { id: ORG, name: "Acme", role: roles[ORG], isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: OTHER, name: "Beta", role: roles[OTHER], isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
}

async function list(orgId: string, workspaces: CloudWorkspaceListItem[]) {
  await catalog.ingestCloudList({ workspaces, quota: { used: workspaces.length, limit: 3 } }, orgId);
}

/** Nothing resumed, attached or woken: what "looking" must cost. */
function expectNoWake() {
  expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
  expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
  expect(connections.retainCloudConnection).not.toHaveBeenCalled();
}

const refusal = async (action: string, params: Record<string, unknown>) => {
  const answer = await answerCloudControl(action, params);
  if (answer.ok) throw new Error(`expected ${action} to be refused, got ${JSON.stringify(answer.result)}`);
  return answer.error;
};

beforeEach(async () => {
  signIn();
  cached = { "ws-1": { "s1-tab": { tab: tabInfo("s1"), events, cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 } }, "ws-stopped": { "s2-tab": { tab: tabInfo("s2"), events: [], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 } } };
  enqueued = [];
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "cloud_agent_cache_load") return { tabs: cached[args.workspaceId as string] ?? {} };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_outbox_sync" || command === "cloud_agent_checkpoints") return [];
    if (command === "cloud_agent_checkpoint") return null;
    if (command === "cloud_agent_enqueue") {
      enqueued.push(args);
      return { clientCommandId: `cmd-${enqueued.length}`, tabId: args.tabId, kind: args.kind, state: "queued", wake: args.workspaceId === "ws-stopped" ? "requested" : "not-requested", createdAt: 1, updatedAt: 1 };
    }
    return undefined;
  });
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.workspaceConnection.mockReset();
  for (const fn of [connections.wakeCloudConnection, connections.retainCloudConnection, connections.connectedCloudClient, newSession.startInWorkspace, newSession.prepareCloudCreate, newSession.confirmCloudCreate]) vi.mocked(fn).mockClear();
  // A refresh after an action reads back what the catalog holds.
  mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => ({ workspaces: catalog.getCloudCatalog().orgs[orgId ?? ORG]?.workspaces ?? [] }));
  await list(ORG, [item("ws-1", ORG), item("ws-stopped", ORG, { state: "suspended", repositories: [acmeWeb] })]);
  await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "viewer", canApprove: false, canManageShares: false } })]);
  catalog.cacheCloudSessions(ORG, "ws-1", [session("s1", "Fix login redirect")] as never, ["session/2"]);
  catalog.cacheCloudSessions(ORG, "ws-stopped", [session("s2", "Sleeping work")] as never, ["session/2"]);
  catalog.cacheCloudSessions(OTHER, "ws-b", [session("sb", "Landing page")] as never, ["session/2"]);
  cached["ws-b"] = { "sb-tab": { tab: tabInfo("sb"), events: [{ ...events[0], sessionId: "sb", tabId: "sb-tab" }], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 } };
});

afterEach(() => {
  catalog.resetCloudCatalog();
  resetCloudAgents();
  resetCloudSessions();
  resetCloudDashboard();
  resetCollab();
  resetCloudWakes();
  sessions.selectSession(null);
});

describe("discovery", () => {
  it("says what this app supports and which organizations are reachable", async () => {
    const status = (await handleCloudControl("status")) as { version: number; capabilities: string[]; organizations: Record<string, unknown>[] };
    expect(status.version).toBe(1);
    expect(status.capabilities).toEqual(["projects.list", "sessions.list", "sessions.create", "send", "read", "wait", "stop", "resume"]);
    expect(status.organizations).toEqual([
      { id: ORG, name: "Acme", role: "admin", live: true, mayStartSessions: true },
      { id: OTHER, name: "Beta", role: "member", live: true, mayStartSessions: false },
    ]);
  });

  it("answers an unknown command as unsupported, so an older app and a newer CLI disagree in words", async () => {
    expect(await refusal("workspaces.delete", {})).toMatchObject({ code: "unsupported" });
  });

  it("refuses everything while signed out", async () => {
    mocks.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null } as unknown as AccountStatus;
    for (const [action, params] of [["status", {}], ["projects.list", {}], ["sessions.list", {}], ["read", { target: `cloud:${ORG}:ws-1:s1` }], ["send", { target: `cloud:${ORG}:ws-1:s1`, text: "hi" }]] as const) {
      expect(await refusal(action, params)).toMatchObject({ code: "account_signed_out" });
    }
    expect(enqueued).toEqual([]);
  });
});

describe("listing", () => {
  it("lists cloud projects with their workspaces, from the catalog alone", async () => {
    const { projects } = (await handleCloudControl("projects.list")) as { projects: { key: string; name: string; orgName: string; mayStartSessions: boolean; workspaces: { key: string; state: string; status: string; role: string }[] }[] };
    expect(projects.map((project) => [project.key, project.orgName, project.mayStartSessions])).toEqual([
      [PROJECT, "Acme", true],
      [`cloud:${ORG}:github.com/acme/web`, "Acme", true],
      [`cloud:${OTHER}:github.com/acme/api`, "Beta", false],
    ]);
    expect(projects[1].workspaces).toEqual([expect.objectContaining({ key: `cloud:${ORG}:ws-stopped`, state: "suspended", status: "Stopped", role: "manager" })]);
    expectNoWake();
  });

  it("lists sessions across organizations, or one project's, without attaching to or waking anything", async () => {
    const all = (await handleCloudControl("sessions.list")) as { sessions: { key: string; title: string; stopped: boolean; tabs: { id: string; agent: string }[] }[] };
    expect(all.sessions.map((entry) => [entry.key, entry.title, entry.stopped]).sort()).toEqual(
      [
        [`cloud:${ORG}:ws-1:s1`, "Fix login redirect", false],
        [`cloud:${ORG}:ws-stopped:s2`, "Sleeping work", true],
        [`cloud:${OTHER}:ws-b:sb`, "Landing page", false],
      ].sort(),
    );
    expect(all.sessions.find((entry) => entry.key === `cloud:${ORG}:ws-1:s1`)?.tabs).toEqual([{ id: "s1-tab", agent: "claude", title: null, status: "idle" }]);
    const one = (await handleCloudControl("sessions.list", { project: PROJECT })) as { sessions: { key: string }[] };
    expect(one.sessions.map((entry) => entry.key)).toEqual([`cloud:${ORG}:ws-1:s1`]);
    const beta = (await handleCloudControl("sessions.list", { org: "beta" })) as { sessions: { key: string }[] };
    expect(beta.sessions.map((entry) => entry.key)).toEqual([`cloud:${OTHER}:ws-b:sb`]);
    expectNoWake();
  });

  it("names the workspaces whose sessions this desktop has never loaded instead of listing nothing", async () => {
    await list(ORG, [item("ws-1", ORG), item("ws-new", ORG)]);
    const { sessions: listed, workspacesNotLoaded } = (await handleCloudControl("sessions.list", { org: ORG })) as { sessions: { key: string }[]; workspacesNotLoaded: { key: string }[] };
    expect(listed.map((entry) => entry.key)).toEqual([`cloud:${ORG}:ws-1:s1`]);
    expect(workspacesNotLoaded).toEqual([{ key: `cloud:${ORG}:ws-new`, name: "ws-new", projectKey: PROJECT }]);
    expectNoWake();
  });

  it("answers an organization the person is not in, and a local project, like something that is not there", async () => {
    expect(await refusal("projects.list", { org: "org-nope" })).toMatchObject({ code: "not_found" });
    expect(await refusal("sessions.list", { project: "/Users/me/code/api" })).toMatchObject({ code: "invalid_arguments" });
  });
});

describe("read", () => {
  it("returns the transcript kept here, with --since and --tail, and never wakes a stopped workspace", async () => {
    const all = (await handleCloudControl("read", { target: `cloud:${ORG}:ws-1:s1` })) as { tabId: string; events: { seq: number }[]; source: string };
    expect(all.tabId).toBe("s1-tab");
    expect(all.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(all.source).toBe("cache");
    expect(((await handleCloudControl("read", { target: `cloud:${ORG}:ws-1:s1`, since: 1 })) as { events: { seq: number }[] }).events.map((event) => event.seq)).toEqual([2]);
    expect(((await handleCloudControl("read", { target: `cloud:${ORG}:ws-1:s1`, tail: 1 })) as { events: { seq: number }[] }).events.map((event) => event.seq)).toEqual([2]);
    // A stopped workspace reads from the cache and the checkpoint, and stays stopped.
    await handleCloudControl("read", { target: `cloud:${ORG}:ws-stopped:s2` });
    expect(mocks.invoke).toHaveBeenCalledWith("cloud_agent_checkpoint", expect.objectContaining({ workspaceId: "ws-stopped", tabId: "s2-tab" }));
    expectNoWake();
    expect(enqueued).toEqual([]);
  });

  it("lets a viewer read, and shows someone the workspace is not shared with nothing", async () => {
    const viewed = (await handleCloudControl("read", { target: `cloud:${OTHER}:ws-b:sb` })) as { events: unknown[] };
    expect(viewed.events).toHaveLength(1);
    await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "none", canApprove: false, canManageShares: false } })]);
    const refused = await refusal("read", { target: `cloud:${OTHER}:ws-b:sb` });
    expect(refused.code).toBe("forbidden");
    expect(refused.message).toContain("has not been shared with you");
    expect(JSON.stringify(refused)).not.toContain("fix the login");
  });

  it("answers a session of a workspace that is not listed for this person exactly like one that does not exist", async () => {
    const missing = await refusal("read", { target: `cloud:${ORG}:ws-private-of-someone:s9` });
    const unknown = await refusal("read", { target: `cloud:${ORG}:no-such-workspace:s9` });
    expect(missing.code).toBe("not_found");
    expect({ ...missing, message: "" }).toEqual({ ...unknown, message: "" });
    expect(await refusal("read", { target: "cloud:org-nope:ws-1:s1" })).toMatchObject({ code: "not_found" });
    expect(await refusal("read", { target: "not-a-cloud-key" })).toMatchObject({ code: "invalid_arguments" });
    expect(await refusal("read", { target: `cloud:${ORG}:ws-1:s1`, tab: "no-such-tab" })).toMatchObject({ code: "not_found" });
  });
});

describe("send", () => {
  it("sends through the mailbox like the composer, without waking a running workspace", async () => {
    const sent = (await handleCloudControl("send", { target: `cloud:${ORG}:ws-1:s1`, text: "run the tests" })) as Record<string, unknown>;
    expect(sent).toEqual({ session: `cloud:${ORG}:ws-1:s1`, tabId: "s1-tab", commandId: "cmd-1", state: "queued", wake: "not-requested" });
    expect(enqueued).toEqual([expect.objectContaining({ organizationId: ORG, workspaceId: "ws-1", tabId: "s1-tab", kind: "send", payload: expect.objectContaining({ text: "run the tests" }) })]);
    expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("wakes a stopped workspace exactly once for a send, however many are sent while it resumes", async () => {
    const target = `cloud:${ORG}:ws-stopped:s2`;
    const sent = (await handleCloudControl("send", { target, text: "continue" })) as { wake: string };
    await handleCloudControl("send", { target, text: "and then deploy" });
    expect(sent.wake).toBe("requested");
    expect(enqueued).toHaveLength(2);
    expect(connections.wakeCloudConnection).toHaveBeenCalledTimes(1);
    expect(connections.wakeCloudConnection).toHaveBeenCalledWith({ orgId: ORG, workspaceId: "ws-stopped" });
  });

  it("refuses a viewer and someone it is not shared with, with the app's own reasons, and sends nothing", async () => {
    const viewer = await refusal("send", { target: `cloud:${OTHER}:ws-b:sb`, text: "hello" });
    expect(viewer.code).toBe("forbidden");
    expect(viewer.message).toMatch(/view/i);
    await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "none", canApprove: false, canManageShares: false } })]);
    expect((await refusal("send", { target: `cloud:${OTHER}:ws-b:sb`, text: "hello" })).message).toContain("has not been shared with you");
    // An older server reports no role: a participate attachment is view only, as in the app.
    await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: undefined })]);
    expect((await refusal("send", { target: `cloud:${OTHER}:ws-b:sb`, text: "hello" })).message).toMatch(/^View only/);
    expect(enqueued).toEqual([]);
    expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
  });

  it("lets a driver on a participate attachment send, as the composer does", async () => {
    await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "driver", canApprove: false, canManageShares: false } })]);
    await handleCloudControl("send", { target: `cloud:${OTHER}:ws-b:sb`, text: "hello" });
    expect(enqueued).toHaveLength(1);
  });

  it("refuses an archived workspace and an empty message", async () => {
    await list(ORG, [item("ws-1", ORG, { state: "archived", archivedAt: 1 })]);
    expect((await refusal("send", { target: `cloud:${ORG}:ws-1:s1`, text: "hello" })).message).toMatch(/^Archived/);
    expect(await refusal("send", { target: `cloud:${ORG}:ws-1:s1`, text: "  " })).toMatchObject({ code: "invalid_arguments" });
    expect(enqueued).toEqual([]);
  });

  it("keeps the API's own refusal code when the mailbox refuses", async () => {
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "cloud_agent_cache_load") return { tabs: cached[args.workspaceId as string] ?? {} };
      if (command === "cloud_agent_enqueue") throw { code: "cloud_workspace_collaboration_forbidden" };
      return command === "cloud_agent_checkpoint" ? null : [];
    });
    expect(await refusal("send", { target: `cloud:${ORG}:ws-1:s1`, text: "hello" })).toMatchObject({ code: "cloud_workspace_collaboration_forbidden" });
  });
});

describe("wait", () => {
  const fakeSleep = () => {
    let clock = 0;
    return { now: () => clock, sleep: async (ms: number) => void (clock += ms) };
  };

  it("returns at once for a tab that is not working, and times out on one that is, without waking a stopped workspace", async () => {
    const idle = await waitForCloudTab({ target: `cloud:${ORG}:ws-stopped:s2`, timeoutSeconds: 30 });
    expect(idle).toMatchObject({ reason: "stopped", status: "idle", tabId: "s2-tab" });
    expect(connections.retainCloudConnection).not.toHaveBeenCalled();
    expect(connections.wakeCloudConnection).not.toHaveBeenCalled();

    cached["ws-1"]["s1-tab"] = { ...(cached["ws-1"]["s1-tab"] as object), tab: tabInfo("s1", "in_progress") };
    resetCloudAgents();
    const { now, sleep } = fakeSleep();
    const working = await waitForCloudTab({ target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 5 }, sleep, now);
    expect(working).toMatchObject({ reason: "timeout", status: "in_progress" });
    // A running workspace is followed with `connect`, which attaches and never resumes; the lease is given back.
    expect(connections.retainCloudConnection).toHaveBeenCalledWith({ orgId: ORG, workspaceId: "ws-1" }, "connect");
    const lease = await vi.mocked(connections.retainCloudConnection).mock.results[0].value;
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("says a tab waits for a permission", async () => {
    cached["ws-1"]["s1-tab"] = { ...(cached["ws-1"]["s1-tab"] as object), tab: tabInfo("s1", "waiting") };
    resetCloudAgents();
    expect(await handleCloudControl("wait", { target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 1 })).toMatchObject({ reason: "permission", status: "waiting" });
  });

  it("is refused to someone the workspace is not shared with", async () => {
    await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "none", canApprove: false, canManageShares: false } })]);
    expect(await refusal("wait", { target: `cloud:${OTHER}:ws-b:sb`, timeoutSeconds: 1 })).toMatchObject({ code: "forbidden" });
    expect(connections.retainCloudConnection).not.toHaveBeenCalled();
  });
});

describe("creating a session", () => {
  it("adds it to the project's running workspace, without moving the window's selection", async () => {
    const created = await handleCloudControl("sessions.create", { project: PROJECT, prompt: "fix the login", agent: "codex", useWorktree: false });
    expect(created).toEqual({ created: "session", session: `cloud:${ORG}:ws-1:new-session`, workspace: `cloud:${ORG}:ws-1`, resumed: false });
    const [plan, request, options] = vi.mocked(newSession.startInWorkspace).mock.calls[0];
    expect(plan.kind).toBe("reuse");
    expect(request).toMatchObject({ agent: "codex", prompt: "fix the login", useWorktree: false });
    expect(options).toEqual({ select: false });
    expect(sessions.getSessionStore().selectedSessionId).toBeNull();
    expect(newSession.prepareCloudCreate).not.toHaveBeenCalled();
  });

  it("resumes a stopped workspace only when asked to with --wake", async () => {
    const project = `cloud:${ORG}:github.com/acme/web`;
    const refused = await refusal("sessions.create", { project, prompt: "go" });
    expect(refused).toMatchObject({ code: "cloud_workspace_stopped" });
    expect(refused.recovery).toContain("--wake");
    expect(newSession.startInWorkspace).not.toHaveBeenCalled();
    const created = await handleCloudControl("sessions.create", { project, prompt: "go", wake: true });
    expect(created).toMatchObject({ created: "session", resumed: true, workspace: `cloud:${ORG}:ws-stopped` });
    expect(vi.mocked(newSession.startInWorkspace).mock.calls[0][0].kind).toBe("wake");
  });

  it("creates a new machine only with --confirm-spend, and reuses the given idempotency key", async () => {
    await list(ORG, []);
    catalog.setCloudRepositories(ORG, [{ fullName: "acme/api", cloneUrl: acmeApi.cloneUrl, defaultBranch: "main", private: true, state: "accessible", reason: null } as never]);
    const { setPrefs, getPrefs } = await import("@/lib/prefs");
    setPrefs({ cloudProjects: { ...getPrefs().cloudProjects, [ORG]: ["github.com/acme/api"] } });
    const pending = { idempotencyKey: "generated", createdAt: 1, request: { idempotencyKey: "generated" } };
    vi.mocked(newSession.prepareCloudCreate).mockResolvedValue({ orgId: ORG, providerLabel: "Boat", quote: { currency: "USD", activeHourlyMicros: 120_000 }, pending } as never);
    vi.mocked(newSession.confirmCloudCreate).mockResolvedValue({ workspace: { id: "ws-new", orgId: ORG, state: "provisioning" }, operation: { id: "op-1" } } as never);
    try {
      const refused = await refusal("sessions.create", { project: PROJECT, prompt: "go" });
      expect(refused).toMatchObject({ code: "spend_confirmation_required" });
      expect(refused.message).toContain("Boat");
      expect(newSession.confirmCloudCreate).not.toHaveBeenCalled();

      const created = await handleCloudControl("sessions.create", { project: PROJECT, prompt: "go", confirmSpend: true, idempotencyKey: "retry-1" });
      expect(created).toEqual({ created: "workspace", workspace: `cloud:${ORG}:ws-new`, operationId: "op-1", state: "provisioning", quote: { provider: "Boat", currency: "USD", activeHourlyMicros: 120_000 } });
      expect(vi.mocked(newSession.confirmCloudCreate).mock.calls[0][1]).toEqual({ follow: false });
      expect(pending).toMatchObject({ idempotencyKey: "retry-1", request: { idempotencyKey: "retry-1" } });
    } finally {
      setPrefs({ cloudProjects: {} });
    }
  });

  it("is refused to a plain member, as the project's + is, before anything is asked of the server", async () => {
    signIn({ [ORG]: "member", [OTHER]: "member" });
    const refused = await refusal("sessions.create", { project: PROJECT, prompt: "go", wake: true, confirmSpend: true });
    expect(refused).toEqual({ code: "forbidden", message: "Only an organization owner or admin can start a new cloud session", recovery: null });
    expect(newSession.startInWorkspace).not.toHaveBeenCalled();
    expect(newSession.prepareCloudCreate).not.toHaveBeenCalled();
    expectNoWake();
  });

  it("does not know a project in an organization the person is not in", async () => {
    expect(await refusal("sessions.create", { project: "cloud:org-nope:github.com/acme/api", prompt: "go" })).toMatchObject({ code: "not_found" });
    expect(await refusal("sessions.create", { project: "/Users/me/code/api", prompt: "go" })).toMatchObject({ code: "invalid_arguments" });
  });
});

describe("stop and resume", () => {
  const snapshot = (id: string, state: string) => ({ workspace: item(id, ORG, { state }).workspace, operation: { id: "op-9", workspaceId: id, action: state === "suspended" ? "suspend" : "resume", state: "queued" } });

  it("stops a running workspace only after --yes, and says what stopping does first", async () => {
    const target = `cloud:${ORG}:ws-1`;
    const asked = await refusal("stop", { workspace: target });
    expect(asked.code).toBe("confirmation_required");
    expect(asked.recovery).toContain("--yes");
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
    mocks.api.cloudWorkspaceSuspend.mockResolvedValue(snapshot("ws-1", "suspended"));
    expect(await handleCloudControl("stop", { workspace: target, confirmed: true })).toEqual({ workspace: target, state: "suspended", operationId: "op-9", changed: true });
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledWith("ws-1", ORG);
    // Already stopped: nothing is sent.
    mocks.api.cloudWorkspaceSuspend.mockClear();
    expect(await handleCloudControl("stop", { workspace: `cloud:${ORG}:ws-stopped`, confirmed: true })).toEqual({ workspace: `cloud:${ORG}:ws-stopped`, state: "suspended", changed: false });
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
  });

  it("resumes a stopped workspace with the menu's Resume, once", async () => {
    mocks.api.cloudWorkspaceResume.mockResolvedValue(snapshot("ws-stopped", "provisioning"));
    const resumed = (await handleCloudControl("resume", { workspace: `cloud:${ORG}:ws-stopped` })) as { changed: boolean; state: string };
    expect(resumed).toMatchObject({ changed: true, state: "provisioning" });
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledWith("ws-stopped", ORG);
    mocks.api.cloudWorkspaceResume.mockClear();
    expect(await handleCloudControl("resume", { workspace: `cloud:${ORG}:ws-1` })).toMatchObject({ changed: false, state: "ready" });
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("is refused to anyone the workspace menu would not offer it to, without calling the server", async () => {
    for (const you of [{ role: "driver", canApprove: true, canManageShares: true }, { role: "viewer", canApprove: false, canManageShares: false }, { role: "none", canApprove: false, canManageShares: false }]) {
      await list(ORG, [item("ws-1", ORG, { you }), item("ws-stopped", ORG, { state: "suspended", you })]);
      expect(await refusal("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true })).toMatchObject({ code: "forbidden", message: "Only an organization owner or admin can stop, archive or delete a cloud workspace." });
      expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` })).toMatchObject({ code: "forbidden" });
    }
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("passes the server's refusal on with its code (the running limit, a lost role)", async () => {
    mocks.api.cloudWorkspaceResume.mockRejectedValue({ code: "cloud_workspace_concurrency_exceeded" });
    expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` })).toMatchObject({ code: "cloud_workspace_concurrency_exceeded" });
    mocks.api.cloudWorkspaceSuspend.mockRejectedValue({ code: "organization_admin_required" });
    expect(await refusal("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true })).toMatchObject({ code: "organization_admin_required" });
  });

  it("does not know a workspace that is not listed for this person, and refuses an archived one", async () => {
    expect(await refusal("stop", { workspace: `cloud:${ORG}:someone-elses-private`, confirmed: true })).toMatchObject({ code: "not_found" });
    expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-1:s1:extra` })).toMatchObject({ code: "invalid_arguments" });
    await list(ORG, [item("ws-1", ORG, { state: "archived", archivedAt: 1 })]);
    expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-1` })).toMatchObject({ code: "cloud_workspace_archived" });
  });
});

it("a refusal is an error object the CLI can print, never a thrown exception", async () => {
  expect(new CloudControlError("forbidden", "no").recovery).toBeNull();
  expect(await answerCloudControl("status", {})).toMatchObject({ ok: true });
  expect(await answerCloudControl("send", { target: "x", text: "y" })).toEqual({ ok: false, error: { code: "invalid_arguments", message: expect.any(String), recovery: expect.any(String) } });
});
