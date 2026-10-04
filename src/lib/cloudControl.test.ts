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
  ask: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, open: vi.fn() }));
// The native question, answered by `mocks.ask` with the text the person would read (commands.rs builds the same).
vi.mock("@/lib/cloudControlNative", () => ({
  cloudControlNative: {
    setting: vi.fn(async () => false),
    setSetting: vi.fn(async (enabled: boolean) => ({ enabled, refused: null })),
    confirm: async (what: string, okLabel: string) =>
      (await mocks.ask(`A terminalx command (run by you or by an agent in a local session) asks to ${what}`, { title: "Cloud workspace request", kind: "warning", okLabel, cancelLabel: "Refuse" })) ? "accepted" : "declined",
  },
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

const { answerCloudControl, handleCloudControl, waitForCloudTab, CloudControlError, setCloudControlPolicy, setCloudControlEnabled, cloudControlEnabled, CLOUD_CONTROL_POLICY, WAIT_CHUNK_SECONDS } = await import("./cloudControl");
// The lifecycle refusal is the app's own sentence, whatever it currently says (PRO-73 rewords it).
const { LIFECYCLE_ADMIN_REASON, NEW_SESSION_ADMIN_REASON } = await import("@/lib/cloudCollab");
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
  // The person turned the setting on; "off" and the other option have their own tests below.
  setCloudControlPolicy("setting");
  setCloudControlEnabled(true);
  mocks.ask.mockReset().mockResolvedValue(true);
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
  // As the real one answers when nothing needs waking.
  vi.mocked(newSession.startInWorkspace).mockReset().mockImplementation(async (plan) => `${plan.node.key}:new-session`);
  mocks.api.cloudWorkspaces.mockImplementation(async (orgId: string | null) => ({ workspaces: catalog.getCloudCatalog().orgs[orgId ?? ORG]?.workspaces ?? [] }));
  await list(ORG, [item("ws-1", ORG), item("ws-stopped", ORG, { state: "suspended", repositories: [acmeWeb] })]);
  await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "viewer", canApprove: false, canManageShares: false } })]);
  catalog.cacheCloudSessions(ORG, "ws-1", [session("s1", "Fix login redirect")] as never, ["session/2"]);
  catalog.cacheCloudSessions(ORG, "ws-stopped", [session("s2", "Sleeping work")] as never, ["session/2"]);
  catalog.cacheCloudSessions(OTHER, "ws-b", [session("sb", "Landing page")] as never, ["session/2"]);
  cached["ws-b"] = { "sb-tab": { tab: tabInfo("sb"), events: [{ ...events[0], sessionId: "sb", tabId: "sb-tab" }], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 } };
});

afterEach(() => {
  setCloudControlPolicy();
  setCloudControlEnabled(false);
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
    expect(status).toMatchObject({ version: 1, enabled: true, policy: "setting" });
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
    expect(mocks.ask).not.toHaveBeenCalled();
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

  it("with --idempotency-key, a retry gets the first answer and nothing is sent twice", async () => {
    const target = `cloud:${ORG}:ws-1:s1`;
    const first = await handleCloudControl("send", { target, text: "deploy", idempotencyKey: "k-1" });
    const retry = await handleCloudControl("send", { target, text: "deploy", idempotencyKey: "k-1" });
    expect(retry).toEqual(first);
    expect(enqueued).toHaveLength(1);
    // Another key, or none, is another message.
    await handleCloudControl("send", { target, text: "deploy", idempotencyKey: "k-2" });
    await handleCloudControl("send", { target, text: "deploy" });
    expect(enqueued).toHaveLength(3);
    // A refused send may be asked for again with its key.
    await list(ORG, [item("ws-1", ORG, { state: "archived", archivedAt: 1 })]);
    await refusal("send", { target, text: "later", idempotencyKey: "k-3" });
    await list(ORG, [item("ws-1", ORG)]);
    await handleCloudControl("send", { target, text: "later", idempotencyKey: "k-3" });
    expect(enqueued).toHaveLength(4);
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
    const refused = await refusal("send", { target: `cloud:${ORG}:ws-1:s1`, text: "hello" });
    expect(refused.code).toBe("cloud_workspace_collaboration_forbidden");
    // Never the bare code as the message.
    expect(refused.message).not.toBe(refused.code);
    expect(refused.message.length).toBeGreaterThan(10);
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

  it("waits at most one short chunk per call, however long the caller asked for", async () => {
    cached["ws-1"]["s1-tab"] = { ...(cached["ws-1"]["s1-tab"] as object), tab: tabInfo("s1", "in_progress") };
    resetCloudAgents();
    const { now, sleep } = fakeSleep();
    const working = await waitForCloudTab({ target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 86_400 }, sleep, now);
    expect(working).toMatchObject({ reason: "timeout" });
    expect(now()).toBeLessThanOrEqual(WAIT_CHUNK_SECONDS * 1000);
    // Nothing is left behind when the call returns: the lease is given back.
    const lease = await vi.mocked(connections.retainCloudConnection).mock.results[0].value;
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("reads the checkpoint only while not connected, and at a gentle pace", async () => {
    cached["ws-stopped"]["s2-tab"] = { ...(cached["ws-stopped"]["s2-tab"] as object), tab: tabInfo("s2", "in_progress") };
    resetCloudAgents();
    const { now, sleep } = fakeSleep();
    await waitForCloudTab({ target: `cloud:${ORG}:ws-stopped:s2`, timeoutSeconds: 30 }, sleep, now);
    const reads = mocks.invoke.mock.calls.filter(([command]) => command === "cloud_agent_checkpoint").length;
    // Every 5 s over 30 s, not every 2 s.
    expect(reads).toBeLessThanOrEqual(8);
    expect(reads).toBeGreaterThanOrEqual(6);
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
    expect(options).toMatchObject({ select: false });
    expect(sessions.getSessionStore().selectedSessionId).toBeNull();
    expect(newSession.prepareCloudCreate).not.toHaveBeenCalled();
  });

  it("does not wake a workspace the list calls running but which has stopped, unless --wake was given", async () => {
    // The window's start flow asks before waking; the list still says ready.
    vi.mocked(newSession.startInWorkspace).mockImplementation(async (plan, _request, options) => {
      const wake = options?.wakeIfStopped;
      if (!(typeof wake === "function" ? await wake() : wake)) throw new Error("cloud_workspace_stopped");
      return `${plan.node.key}:new-session`;
    });
    const refused = await refusal("sessions.create", { project: PROJECT, prompt: "go" });
    expect(refused.code).toBe("cloud_workspace_stopped");
    expect(refused.message).toContain("has stopped");
    expect(refused.recovery).toContain("--wake");
    expect(await handleCloudControl("sessions.create", { project: PROJECT, prompt: "go", wake: true })).toMatchObject({ created: "session", resumed: true });
  });

  it("treats a workspace that is on its way down as stopped: no session, and nothing woken, without --wake", async () => {
    // Still listed as ready, with a stop running: connecting to it now would bring it back up.
    const midStop = { ...item("ws-1", ORG), latestOperation: { id: "op-stop", action: "suspend", state: "running" } } as CloudWorkspaceListItem;
    await list(ORG, [midStop]);
    const refused = await refusal("sessions.create", { project: PROJECT, prompt: "go" });
    expect(refused).toMatchObject({ code: "cloud_workspace_stopped" });
    expect(refused.recovery).toContain("--wake");
    expect(newSession.startInWorkspace).not.toHaveBeenCalled();
    expectNoWake();
    // Asked for: it goes ahead, and says it resumed.
    expect(await handleCloudControl("sessions.create", { project: PROJECT, prompt: "go", wake: true })).toMatchObject({ created: "session", resumed: true });
    // And where the window confirms, that too is asked before anything is woken.
    setCloudControlPolicy("both");
    setCloudControlEnabled(true);
    mocks.ask.mockResolvedValue(false);
    vi.mocked(newSession.startInWorkspace).mockClear();
    expect((await refusal("sessions.create", { project: PROJECT, prompt: "go", wake: true })).code).toBe("declined");
    expect(newSession.startInWorkspace).not.toHaveBeenCalled();
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
    expect(refused).toEqual({ code: "forbidden", message: NEW_SESSION_ADMIN_REASON, recovery: null });
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
      expect(await refusal("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true })).toMatchObject({ code: "forbidden", message: `${LIFECYCLE_ADMIN_REASON}.` });
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

describe("the owner's switch (PRO-40): the command line may be an agent, not the person", () => {
  const everything: [string, Record<string, unknown>][] = [
    ["projects.list", {}],
    ["sessions.list", {}],
    ["read", { target: `cloud:${ORG}:ws-1:s1` }],
    ["wait", { target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 1 }],
    ["send", { target: `cloud:${ORG}:ws-1:s1`, text: "hi" }],
    ["sessions.create", { project: PROJECT, prompt: "go", wake: true, confirmSpend: true }],
    ["stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true }],
    ["resume", { workspace: `cloud:${ORG}:ws-stopped` }],
  ];

  it("ships with both: the setting, which is off by default, and the question in the window", () => {
    expect(CLOUD_CONTROL_POLICY).toBe("both");
    setCloudControlEnabled(false);
    expect(cloudControlEnabled()).toBe(false);
  });

  describe("option (a), the setting, while it is off", () => {
    beforeEach(() => setCloudControlEnabled(false));

    it("refuses every cloud command and does nothing: no list, no transcript, no message, no wake, no stop", async () => {
      for (const [action, params] of everything) {
        const refused = await refusal(action, params);
        expect(refused.code).toBe("cloud_control_disabled");
        expect(refused.recovery).toContain("Let agents in local sessions control cloud workspaces");
        // Nothing of the account leaks into the refusal.
        expect(JSON.stringify(refused)).not.toMatch(/Acme|ws-1|fix the login/);
      }
      expect(enqueued).toEqual([]);
      expect(newSession.startInWorkspace).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
      expectNoWake();
    });

    it("status says it is off and how to turn it on, and names no organization", async () => {
      expect(await handleCloudControl("status")).toEqual({ version: 1, policy: "setting", enabled: false, capabilities: [], organizations: [], enable: expect.stringContaining("Settings") });
    });

    it("turning it on in Settings makes the commands work, with no question asked", async () => {
      setCloudControlEnabled(true);
      await handleCloudControl("send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "continue" });
      expect(enqueued).toHaveLength(1);
      expect(mocks.ask).not.toHaveBeenCalled();
    });
  });

  describe("both together (what ships): the setting lets agents ask, the person still decides", () => {
    beforeEach(() => setCloudControlPolicy("both"));

    it("refuses everything while the setting is off, and asks nothing", async () => {
      setCloudControlEnabled(false);
      for (const [action, params] of everything) expect((await refusal(action, params)).code).toBe("cloud_control_disabled");
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toEqual([]);
      expectNoWake();
      expect(await handleCloudControl("status")).toMatchObject({ policy: "both", enabled: false, organizations: [] });
    });

    it("with the setting on, looking and a send to a running workspace ask nothing", async () => {
      setCloudControlEnabled(true);
      await handleCloudControl("projects.list");
      await handleCloudControl("sessions.list");
      await handleCloudControl("read", { target: `cloud:${ORG}:ws-1:s1` });
      await handleCloudControl("send", { target: `cloud:${ORG}:ws-1:s1`, text: "run the tests" });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(1);
    });

    it("with the setting on, spend, wake and stop still ask in the window, and a refusal there does nothing", async () => {
      setCloudControlEnabled(true);
      mocks.ask.mockResolvedValue(false);
      for (const [action, params] of [
        ["send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "continue" }],
        ["resume", { workspace: `cloud:${ORG}:ws-stopped` }],
        ["stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true }],
        ["sessions.create", { project: `cloud:${ORG}:github.com/acme/web`, prompt: "go", wake: true }],
      ] as [string, Record<string, unknown>][]) {
        expect((await refusal(action, params)).code).toBe("declined");
      }
      expect(mocks.ask).toHaveBeenCalledTimes(4);
      expect(enqueued).toEqual([]);
      expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
      expect(newSession.startInWorkspace).not.toHaveBeenCalled();
      expectNoWake();

      // Agreed to: the stopped workspace is sent to.
      mocks.ask.mockResolvedValue(true);
      await handleCloudControl("send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "continue" });
      expect(enqueued).toHaveLength(1);
    });
  });

  describe("send does not trust the list it holds (review: a stop the app has not heard of)", () => {
    const TARGET = `cloud:${ORG}:ws-1:s1`;
    beforeEach(() => {
      setCloudControlPolicy("both");
      setCloudControlEnabled(true);
    });

    it("reads the list again when not connected, and asks when the workspace has stopped since", async () => {
      // The catalog still says ready; the server now says it idle-stopped.
      mocks.api.cloudWorkspaces.mockImplementation(async () => ({ workspaces: [item("ws-1", ORG, { state: "suspended" })] }));
      mocks.ask.mockResolvedValue(false);
      const refused = await refusal("send", { target: TARGET, text: "still there?" });
      expect(refused.code).toBe("declined");
      expect(mocks.api.cloudWorkspaces).toHaveBeenCalled();
      expect(mocks.ask.mock.calls[0][0]).toContain("send a message to the stopped cloud workspace ws-1");
      expect(enqueued).toEqual([]);
      expectNoWake();
    });

    it("asks for a workspace that is on its way down, though it is still listed as ready", async () => {
      const midStop = { ...item("ws-1", ORG), latestOperation: { id: "op-stop", action: "suspend", state: "running" } } as CloudWorkspaceListItem;
      mocks.api.cloudWorkspaces.mockImplementation(async () => ({ workspaces: [midStop] }));
      mocks.ask.mockResolvedValue(false);
      expect((await refusal("send", { target: TARGET, text: "one more thing" })).code).toBe("declined");
      expect(mocks.ask).toHaveBeenCalledTimes(1);
      expect(enqueued).toEqual([]);
    });

    it("asks when the list cannot be read: not knowing is not the same as running", async () => {
      mocks.api.cloudWorkspaces.mockRejectedValue({ code: "cloud_workspace_unavailable" });
      mocks.ask.mockResolvedValue(false);
      expect((await refusal("send", { target: TARGET, text: "hello" })).code).toBe("declined");
      expect(mocks.ask).toHaveBeenCalledTimes(1);
      expect(enqueued).toEqual([]);
    });

    it("asks nothing when the list, read just now, says running, or when connected to it", async () => {
      await handleCloudControl("send", { target: TARGET, text: "run the tests" });
      expect(mocks.api.cloudWorkspaces).toHaveBeenCalled();
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(1);
      // Connected: it is running, and the list is not read for this.
      mocks.api.cloudWorkspaces.mockClear();
      vi.mocked(connections.connectedCloudClient).mockReturnValue({ connection: { state: "connected", runtimeGeneration: 1, runtimeVersion: "x", capabilities: [], authority: "manage" }, nudgeMailbox: vi.fn(async () => undefined), hasCapability: () => false } as never);
      await handleCloudControl("send", { target: TARGET, text: "and lint" });
      expect(mocks.api.cloudWorkspaces).not.toHaveBeenCalled();
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(2);
      vi.mocked(connections.connectedCloudClient).mockReturnValue(null as never);
    });
  });

  describe("the switch is native code's to keep", () => {
    it("shows what native code says after asking it to change, and says why it did not turn on", async () => {
      const { requestCloudControlSetting, loadCloudControlSetting } = await import("./cloudControl");
      const native = await import("@/lib/cloudControlNative");
      const set = vi.mocked(native.cloudControlNative.setSetting);
      setCloudControlEnabled(false);
      // The person refused the native dialog.
      set.mockResolvedValueOnce({ enabled: false, refused: "declined" });
      expect(await requestCloudControlSetting(true)).toEqual({ enabled: false, reason: "Not turned on: you refused the confirmation." });
      expect(cloudControlEnabled()).toBe(false);
      expect(set).toHaveBeenLastCalledWith(true);
      // Asked again too soon, not answered, or another question is up: each says so, never a silent no.
      set.mockResolvedValueOnce({ enabled: false, refused: "backoff:95" });
      expect((await requestCloudControlSetting(true)).reason).toBe("Not turned on: a confirmation was refused or left unanswered a moment ago. Try again in 2 minutes.");
      set.mockResolvedValueOnce({ enabled: false, refused: "expired" });
      expect((await requestCloudControlSetting(true)).reason).toBe("Not turned on: the confirmation was not answered in time.");
      set.mockResolvedValueOnce({ enabled: false, refused: "busy" });
      expect((await requestCloudControlSetting(true)).reason).toContain("another TerminalX question is waiting");
      // They agreed.
      set.mockResolvedValueOnce({ enabled: true, refused: null });
      expect(await requestCloudControlSetting(true)).toEqual({ enabled: true, reason: null });
      // A native call that fails changes nothing shown, and says so.
      set.mockRejectedValueOnce(new Error("unwritable"));
      expect(await requestCloudControlSetting(false)).toEqual({ enabled: true, reason: "The setting could not be changed. Try again." });
      // At boot it is read from native code; unreadable means off.
      vi.mocked(native.cloudControlNative.setting).mockRejectedValueOnce(new Error("no file"));
      expect(await loadCloudControlSetting()).toBe(false);
    });
  });

  describe("a refusal is not asked about again right away", () => {
    it("answers declined without a question while the app is backing off, and says when to try again", async () => {
      setCloudControlPolicy("both");
      setCloudControlEnabled(true);
      const native = await import("@/lib/cloudControlNative");
      const confirm = vi.spyOn(native.cloudControlNative, "confirm").mockResolvedValue("backoff:95");
      const refused = await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` });
      expect(refused.code).toBe("declined");
      expect(refused.message).toContain("refused or left unanswered in the TerminalX window a moment ago");
      expect(refused.recovery).toContain("2 minutes");
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
      confirm.mockRestore();
    });

    it("acts only on an explicit yes: no answer in time, a question already on screen, a dialog that failed, and any other answer all do nothing", async () => {
      setCloudControlPolicy("both");
      setCloudControlEnabled(true);
      const native = await import("@/lib/cloudControlNative");
      const confirm = vi.spyOn(native.cloudControlNative, "confirm");
      for (const [answer, words] of [
        ["expired", "did not answer in the TerminalX window in time"],
        ["busy", "Another request is waiting"],
        ["declined", "was refused in the TerminalX window"],
        ["", "was refused in the TerminalX window"],
        ["yes", "was refused in the TerminalX window"],
      ] as const) {
        confirm.mockResolvedValueOnce(answer as never);
        const refused = await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` });
        expect(refused.code).toBe("declined");
        expect(refused.message).toContain(words);
      }
      confirm.mockRejectedValueOnce(new Error("no window"));
      expect((await refusal("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true })).code).toBe("declined");
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
      expectNoWake();
      confirm.mockRestore();
    });
  });

  describe("option (b), a confirmation in the window", () => {
    beforeEach(() => {
      setCloudControlPolicy("confirm");
      // The setting plays no part under this option.
      setCloudControlEnabled(false);
    });

    it("looking asks nothing: lists, read, wait and a send to a running workspace", async () => {
      await handleCloudControl("projects.list");
      await handleCloudControl("sessions.list");
      await handleCloudControl("read", { target: `cloud:${ORG}:ws-1:s1` });
      await handleCloudControl("wait", { target: `cloud:${ORG}:ws-stopped:s2`, timeoutSeconds: 1 });
      await handleCloudControl("send", { target: `cloud:${ORG}:ws-1:s1`, text: "run the tests" });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(1);
    });

    it("asks the person before anything that starts billed compute or stops a workspace, and says where the request came from", async () => {
      mocks.api.cloudWorkspaceResume.mockResolvedValue({ workspace: item("ws-stopped", ORG, { state: "provisioning" }).workspace, operation: { id: "op" } });
      mocks.api.cloudWorkspaceSuspend.mockResolvedValue({ workspace: item("ws-1", ORG, { state: "suspended" }).workspace, operation: { id: "op" } });
      await handleCloudControl("sessions.create", { project: `cloud:${ORG}:github.com/acme/web`, prompt: "go", wake: true });
      await handleCloudControl("send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "continue" });
      await handleCloudControl("resume", { workspace: `cloud:${ORG}:ws-stopped` });
      await handleCloudControl("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true });
      expect(mocks.ask).toHaveBeenCalledTimes(4);
      for (const [message, options] of mocks.ask.mock.calls) {
        expect(message).toMatch(/^A terminalx command \(run by you or by an agent in a local session\) asks to /);
        expect(options).toMatchObject({ title: "Cloud workspace request", cancelLabel: "Refuse" });
      }
      expect(mocks.ask.mock.calls.map(([message]) => message).join("\n")).toMatch(/ws-stopped[\s\S]*resume the cloud workspace ws-stopped[\s\S]*stop the cloud workspace ws-1/);
    });

    it("does nothing when the person refuses, whatever flags the caller passed", async () => {
      mocks.ask.mockResolvedValue(false);
      for (const [action, params] of [
        ["send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "continue" }],
        ["resume", { workspace: `cloud:${ORG}:ws-stopped` }],
        ["stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true }],
        ["sessions.create", { project: `cloud:${ORG}:github.com/acme/web`, prompt: "go", wake: true }],
      ] as const) {
        expect(await refusal(action, params)).toMatchObject({ code: "declined" });
      }
      expect(enqueued).toEqual([]);
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
      expect(newSession.startInWorkspace).not.toHaveBeenCalled();
      expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
    });

    it("a dialog that cannot be shown counts as a refusal", async () => {
      mocks.ask.mockRejectedValue(new Error("no window"));
      expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` })).toMatchObject({ code: "declined" });
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    });

    it("still applies every role check before asking: someone who may not is refused without a dialog", async () => {
      signIn({ [ORG]: "member", [OTHER]: "member" });
      await list(ORG, [item("ws-1", ORG, { you: { role: "viewer", canApprove: false, canManageShares: false } }), item("ws-stopped", ORG, { state: "suspended", you: { role: "viewer", canApprove: false, canManageShares: false } })]);
      expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` })).toMatchObject({ code: "forbidden" });
      expect(await refusal("send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "hi" })).toMatchObject({ code: "forbidden" });
      expect(await refusal("sessions.create", { project: PROJECT, prompt: "go", wake: true, confirmSpend: true })).toMatchObject({ code: "forbidden" });
      expect(mocks.ask).not.toHaveBeenCalled();
    });
  });
});
