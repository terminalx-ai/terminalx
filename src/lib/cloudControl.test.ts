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
  setting: vi.fn<() => Promise<boolean>>(),
  /** The runtime a lease connects to: who it says this person is, and its own tab list. */
  runtime: { you: undefined as unknown, listAgentTabs: vi.fn() },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, open: vi.fn() }));
// The native question, answered by `mocks.ask` with the text the person would read (commands.rs builds the same).
vi.mock("@/lib/cloudControlNative", () => ({
  cloudControlNative: {
    setting: mocks.setting,
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
    retainCloudConnection: vi.fn(async (at?: { orgId: string; workspaceId: string }) => {
      const client = {
        get connection() {
          return { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority: "manage", you: mocks.runtime.you };
        },
        listAgentTabs: mocks.runtime.listAgentTabs,
      };
      // The connection closes with its lease: what it listed is last known from then on, as `cloudSessions` marks it.
      const { markCloudAgentsOffline } = await import("@/lib/cloudAgents");
      const release = vi.fn(() => at && markCloudAgentsOffline({ organizationId: at.orgId, workspaceId: at.workspaceId }));
      return { release, client, current: () => ({ client }), state: () => client.connection, ended: () => false };
    }),
    connectedCloudClient: vi.fn(() => null),
  };
});
vi.mock("@/lib/cloudNewSession", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cloudNewSession")>();
  return { ...original, startInWorkspace: vi.fn(async (plan: { node: { key: string } }) => `${plan.node.key}:new-session`), prepareCloudCreate: vi.fn(), confirmCloudCreate: vi.fn() };
});

const {
  answerCloudControl,
  handleCloudControl,
  waitForCloudTab,
  cloudLifecycleCommands,
  CloudControlError,
  setCloudControlPolicy,
  setCloudControlEnabled,
  cloudControlEnabled,
  CLOUD_CONTROL_POLICY,
  LIFECYCLE_SETTLE_MS,
  LOOKUP_WITHIN_MS,
  SEND_LOOKUP_WITHIN_MS,
  WAIT_CHUNK_SECONDS,
  settledReason,
} = await import("./cloudControl");
// The lifecycle refusal is the app's own sentence, whatever it currently says (PRO-73 rewords it).
const { LIFECYCLE_ADMIN_REASON, NEW_SESSION_ADMIN_REASON } = await import("@/lib/cloudCollab");
const catalog = await import("@/lib/cloudCatalog");
const connections = await import("@/lib/cloudConnections");
const newSession = await import("@/lib/cloudNewSession");
const sessions = await import("@/lib/sessions");
const { applyLiveTabs, resetCloudAgents } = await import("@/lib/cloudAgents");
const { mergeTabEvents } = await import("@/lib/agentEvents");
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
  mocks.setting.mockReset().mockResolvedValue(true);
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
  mocks.runtime.you = undefined;
  mocks.runtime.listAgentTabs.mockReset().mockResolvedValue([]);
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

  /** An event of the s1 tab's transcript. */
  const said = (seq: number, payload: Record<string, unknown>) => ({ id: `e${seq}`, sessionId: "s1", tabId: "s1-tab", seq, ts: seq, payload });
  const ask = { requestId: "r1", toolName: "Bash", input: { command: "rm -rf build" }, options: ["allow", "deny"] };

  it("says a tab waits for a permission only when there is one to answer", async () => {
    cached["ws-1"]["s1-tab"] = { ...(cached["ws-1"]["s1-tab"] as object), tab: { ...tabInfo("s1", "waiting"), pendingPermissions: [ask] } };
    resetCloudAgents();
    expect(await handleCloudControl("wait", { target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 1 })).toMatchObject({ reason: "permission", status: "waiting" });

    // Waiting with nothing to answer and no error behind it (#668): what it waits on is not shown here.
    cached["ws-1"]["s1-tab"] = { ...(cached["ws-1"]["s1-tab"] as object), tab: tabInfo("s1", "waiting") };
    resetCloudAgents();
    const { now, sleep } = fakeSleep();
    expect(await waitForCloudTab({ target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 5 }, sleep, now)).toMatchObject({ reason: "timeout", status: "waiting" });
  });

  it("says a tab whose agent failed to start stopped on an error, and which one", async () => {
    cached["ws-1"]["s1-tab"] = { ...(cached["ws-1"]["s1-tab"] as object), tab: { ...tabInfo("s1", "waiting"), lastSeq: 3 }, events: [...events, said(3, { type: "recovery", kind: "failed" })] };
    resetCloudAgents();
    expect(await handleCloudControl("wait", { target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 1 })).toEqual({
      session: `cloud:${ORG}:ws-1:s1`,
      tabId: "s1-tab",
      reason: "recovery",
      recovery: "failed",
      status: "waiting",
    });
  });

  it("reads why a connected tab waits from its checkpoint when its transcript is behind its status", async () => {
    // Connected: the runtime's list says waiting, at an event this desktop has not been streamed.
    vi.mocked(connections.connectedCloudClient).mockReturnValue({ connection: { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority: "manage" } } as never);
    const scope = { organizationId: ORG, workspaceId: "ws-1" };
    await handleCloudControl("read", { target: `cloud:${ORG}:ws-1:s1` });
    applyLiveTabs(scope, [{ ...tabInfo("s1", "waiting"), lastSeq: 3 } as never]);
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command !== "cloud_agent_checkpoint") return base(command, args);
      const projection = { v: 1, sessionId: "s1", tabId: "s1-tab", title: null, harness: "claude", model: "opus", effort: null, permissionMode: "default", status: "waiting", process: "exited", truncated: false, followUps: [], updatedAt: 5 };
      return { epoch: 1, version: 1, projection: { ...projection, events: [...events, said(3, { type: "recovery", kind: "usage_limit" })] } };
    });
    try {
      const { now, sleep } = fakeSleep();
      expect(await waitForCloudTab({ target: `cloud:${ORG}:ws-1:s1`, timeoutSeconds: 30 }, sleep, now)).toMatchObject({ reason: "recovery", recovery: "usage_limit", status: "waiting" });
    } finally {
      vi.mocked(connections.connectedCloudClient).mockReturnValue(null);
    }
  });

  it.each([
    ["whose agent failed to start", "waiting", said(3, { type: "recovery", kind: "failed" })],
    ["whose last turn has ended", "completed", said(3, { type: "turn_completed", status: "ok" })],
  ])("waits right after a send to a tab %s for the new turn, and says when that ends", async (_, before, last) => {
    const target = `cloud:${ORG}:ws-1:s1`;
    const scope = { organizationId: ORG, workspaceId: "ws-1" };
    cached["ws-1"]["s1-tab"] = { ...(cached["ws-1"]["s1-tab"] as object), tab: { ...tabInfo("s1", before), lastSeq: 3 }, events: [...events, last] };
    resetCloudAgents();
    // The mailbox's receipts: none until the runtime has taken the message.
    let taken = false;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command !== "cloud_agent_outbox_sync") return base(command, args);
      return taken ? enqueued.map((_, index) => ({ clientCommandId: `cmd-${index + 1}`, tabId: "s1-tab", kind: "send", state: "applied", receipt: { queued: false }, createdAt: 1, updatedAt: 2 })) : [];
    });
    vi.useFakeTimers();
    try {
      await handleCloudControl("send", { target, text: "try again" });
      // What the runtime does while the wait pauses, a step per pause.
      const steps = [
        // It takes the message. The receipt comes in; nothing newer of the tab has yet.
        () => void (taken = true),
        // Its new turn, and the status it reports with it.
        () => {
          mergeTabEvents("s1", "s1-tab", [said(4, { type: "user_message", text: "try again" }), said(5, { type: "recovery", kind: null })] as never);
          applyLiveTabs(scope, [{ ...tabInfo("s1", "in_progress"), lastSeq: 5 } as never]);
        },
        () => {
          mergeTabEvents("s1", "s1-tab", [said(6, { type: "assistant_message", text: "it starts now" }), said(7, { type: "turn_completed", status: "ok" })] as never);
          applyLiveTabs(scope, [{ ...tabInfo("s1", "completed"), lastSeq: 7 } as never]);
        },
      ];
      const sleep = async (ms: number) => {
        steps.shift()?.();
        await vi.advanceTimersByTimeAsync(ms);
      };
      expect(await waitForCloudTab({ target, timeoutSeconds: 30 }, sleep, () => Date.now())).toMatchObject({ reason: "stop", status: "completed" });
      expect(steps).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is refused to someone the workspace is not shared with", async () => {
    await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "none", canApprove: false, canManageShares: false } })]);
    expect(await refusal("wait", { target: `cloud:${OTHER}:ws-b:sb`, timeoutSeconds: 1 })).toMatchObject({ code: "forbidden" });
    expect(connections.retainCloudConnection).not.toHaveBeenCalled();
  });
});

describe("why a wait ends (#668)", () => {
  const info = (status: string, fields: Record<string, unknown> = {}) => ({ status, pendingPermissions: [], followUps: [], ...fields }) as never;
  const said = (seq: number, payload: Record<string, unknown>) => ({ id: `e${seq}`, sessionId: "s1", tabId: "s1-tab", seq, ts: seq, payload }) as never;
  const ask = { requestId: "r1", toolName: "Bash", input: {}, options: ["allow", "deny"] };
  const followUp = { clientCommandId: "cmd-9", text: "then the docs" };
  const prompt = said(1, { type: "user_message", text: "fix the login" });
  const failed = [prompt, said(2, { type: "recovery", kind: "failed" })];
  const asked = said(2, { type: "questions_asked", requestId: "q1", toolUseId: "", questions: [] });

  it("says permission only for what someone can answer", () => {
    expect(settledReason(info("waiting", { pendingPermissions: [ask] }), [prompt], false)).toEqual({ reason: "permission" });
    // A question the transcript shows open, before the runtime's list does.
    expect(settledReason(info("in_progress"), [prompt, asked], false)).toEqual({ reason: "permission" });
    // Answered, or gone with its turn: open no longer.
    expect(settledReason(info("in_progress"), [prompt, asked, said(3, { type: "permission_decided", requestId: "q1", allowed: true, label: "Answered" })], false)).toBeNull();
    expect(settledReason(info("completed"), [prompt, asked, said(3, { type: "turn_completed", status: "ok" })], false)).toEqual({ reason: "stop" });
    // Nothing to answer and no error: not a permission, whatever the status says.
    expect(settledReason(info("waiting"), [prompt], false)).toBeNull();
    // A message on its way waits behind the request; the request is still someone's to answer.
    expect(settledReason(info("waiting", { pendingPermissions: [ask] }), failed, true)).toEqual({ reason: "permission" });
  });

  it("names the error a waiting tab stopped on, unless a message to it is on its way", () => {
    expect(settledReason(info("waiting"), failed, false)).toEqual({ reason: "recovery", recovery: "failed" });
    expect(settledReason(info("waiting"), [prompt, said(2, { type: "recovery", kind: "signed_out" })], false)).toEqual({ reason: "recovery", recovery: "signed_out" });
    expect(settledReason(info("waiting"), failed, true)).toBeNull();
    // A new prompt took the error away: a status that still says waiting is from before it.
    expect(settledReason(info("waiting"), [...failed, said(3, { type: "user_message", text: "try again" }), said(4, { type: "recovery", kind: null })], false)).toBeNull();
    // A follow-up held by the runtime goes nowhere until the error is dealt with.
    expect(settledReason(info("waiting", { followUps: [followUp] }), failed, false)).toEqual({ reason: "recovery", recovery: "failed" });
  });

  it("ends on a finished turn or a stopped tab only when nothing is queued behind it", () => {
    expect(settledReason(info("completed"), [prompt], false)).toEqual({ reason: "stop" });
    expect(settledReason(info("idle"), [prompt], false)).toEqual({ reason: "stopped" });
    expect(settledReason(info("in_progress"), [prompt], false)).toBeNull();
    expect(settledReason(info("completed"), [prompt], true)).toBeNull();
    expect(settledReason(info("completed", { followUps: [followUp] }), [prompt], false)).toBeNull();
    expect(settledReason(info("idle", { followUps: [followUp] }), [prompt], false)).toBeNull();
  });
});

describe("creating a session", () => {
  describe.each(["saved", "explicit"] as const)("%s permission modes", (source) => {
    it.each([
      ["default", "manual"],
      ["ask", "manual"],
      ["accept_edits", "acceptEdits"],
      ["bypass", "bypassPermissions"],
      ["", "bypassPermissions"],
      ["   ", "bypassPermissions"],
      ...(source === "saved" ? [["unknown", "bypassPermissions"]] : []),
      ["plan", "plan"],
      ["manual", "manual"],
      ["auto", "auto"],
      ["acceptEdits", "acceptEdits"],
      ["bypassPermissions", "bypassPermissions"],
    ])("sends %j as %s when starting an issue", async (mode, expected) => {
      const { getPrefs, setPrefs } = await import("@/lib/prefs");
      const previousMode = getPrefs().lastMode;
      setPrefs({ lastMode: source === "saved" ? mode : "plan" });
      try {
        await handleCloudControl("sessions.create", {
          project: PROJECT,
          prompt: "Work on GitHub issue #433",
          issue: { provider: "github", id: "433", identifier: "#433", title: "Carry issue sessions on", url: "https://github.com/acme/api/issues/433" },
          ...(source === "explicit" ? { mode } : {}),
        });
        expect(vi.mocked(newSession.startInWorkspace).mock.calls[0][1]).toMatchObject({ mode: expected });
      } finally {
        setPrefs({ lastMode: previousMode });
      }
    });
  });

  it.each(["unknown", "manuaI"])("rejects unknown explicit mode %j before starting anything", async (mode) => {
    const { getPrefs, setPrefs } = await import("@/lib/prefs");
    const previousMode = getPrefs().lastMode;
    setPrefs({ lastMode: "manual" });
    try {
      expect(await refusal("sessions.create", { project: PROJECT, prompt: "fix the login", mode })).toMatchObject({
        code: "invalid_arguments",
        message: `Unknown permission mode ${mode}.`,
      });
      expect(newSession.startInWorkspace).not.toHaveBeenCalled();
      expect(newSession.prepareCloudCreate).not.toHaveBeenCalled();
      expect(newSession.confirmCloudCreate).not.toHaveBeenCalled();
    } finally {
      setPrefs({ lastMode: previousMode });
    }
  });

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

  it("starts an issue's session with the issue the native side read, and says what became of its pipeline", async () => {
    const issue = { provider: "github", id: "433", identifier: "#433", title: "Carry issue sessions on", url: "https://github.com/acme/api/issues/433" };
    vi.mocked(newSession.startInWorkspace).mockImplementation(async (plan, _request, options) => {
      options?.onIssue?.({ supported: true, pipeline: { id: "p1", cloud: true }, note: null });
      return `${plan.node.key}:new-session`;
    });
    const created = await handleCloudControl("sessions.create", { project: PROJECT, prompt: "Work on GitHub issue #433", issue, issueBody: "Sessions stop at code.", useWorktree: true });
    expect(created).toMatchObject({ created: "session", pipeline: { id: "p1" }, pipelineNote: null });
    const [, request] = vi.mocked(newSession.startInWorkspace).mock.calls[0];
    expect(request).toMatchObject({
      prompt: "Work on GitHub issue #433",
      title: "#433 Carry issue sessions on",
      useWorktree: true,
      issue: { ref: issue, body: "Sessions stop at code.", worktreeName: "433-carry-issue-sessions-on", pipeline: true, settings: { autoMerge: false, requirePerson: false } },
    });
    // --no-pipeline starts it plain; a runtime from before pipelines is said to be one.
    vi.mocked(newSession.startInWorkspace).mockImplementation(async (plan, _request, options) => {
      options?.onIssue?.({ supported: false, pipeline: null, note: null });
      return `${plan.node.key}:new-session`;
    });
    const older = await handleCloudControl("sessions.create", { project: PROJECT, prompt: "go", issue, noPipeline: true });
    expect(older).toMatchObject({ pipeline: null, pipelineNote: expect.stringContaining("older TerminalX") });
    expect(vi.mocked(newSession.startInWorkspace).mock.calls[1][1].issue).toMatchObject({ pipeline: false });
    // An issue is never started in a new machine: that one would start without its pipeline.
    await list(ORG, []);
    const { setPrefs, getPrefs } = await import("@/lib/prefs");
    setPrefs({ cloudProjects: { ...getPrefs().cloudProjects, [ORG]: ["github.com/acme/api"] } });
    try {
      const refused = await refusal("sessions.create", { project: PROJECT, prompt: "go", issue, confirmSpend: true });
      expect(refused).toMatchObject({ code: "cloud_workspace_required", message: expect.stringContaining("#433") });
      expect(newSession.prepareCloudCreate).not.toHaveBeenCalled();
      expect(newSession.confirmCloudCreate).not.toHaveBeenCalled();
    } finally {
      setPrefs({ cloudProjects: {} });
    }
  });

  it("does not wake a workspace the list calls running but which has stopped, unless --wake was given", async () => {
    setCloudControlPolicy("both");
    setCloudControlEnabled(true);
    mocks.ask.mockResolvedValue(false);
    // A stopped runtime requires the caller's wake flag, not another dialog.
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
    expect(mocks.ask).not.toHaveBeenCalled();
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
    // The shipped Settings grant covers this wake without another dialog.
    setCloudControlPolicy("both");
    setCloudControlEnabled(true);
    mocks.ask.mockResolvedValue(false);
    vi.mocked(newSession.startInWorkspace).mockClear();
    expect(await handleCloudControl("sessions.create", { project: PROJECT, prompt: "go", wake: true })).toMatchObject({ created: "session", resumed: true });
    expect(newSession.startInWorkspace).toHaveBeenCalledOnce();
    expect(mocks.ask).not.toHaveBeenCalled();
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
    setCloudControlPolicy("both");
    setCloudControlEnabled(true);
    mocks.ask.mockResolvedValue(false);
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
      expect(mocks.ask).not.toHaveBeenCalled();
    } finally {
      setPrefs({ cloudProjects: {} });
    }
  });

  it("is refused to a plain member, as the project's + is, before anything is asked of the server", async () => {
    setCloudControlPolicy("both");
    signIn({ [ORG]: "member", [OTHER]: "member" });
    const refused = await refusal("sessions.create", { project: PROJECT, prompt: "go", wake: true, confirmSpend: true });
    expect(refused).toEqual({ code: "forbidden", message: NEW_SESSION_ADMIN_REASON, recovery: null });
    expect(newSession.startInWorkspace).not.toHaveBeenCalled();
    expect(newSession.prepareCloudCreate).not.toHaveBeenCalled();
    expectNoWake();
  });

  it("does not know a project in an organization the person is not in", async () => {
    setCloudControlPolicy("both");
    expect(await refusal("sessions.create", { project: "cloud:org-nope:github.com/acme/api", prompt: "go" })).toMatchObject({ code: "not_found" });
    expect(await refusal("sessions.create", { project: "/Users/me/code/api", prompt: "go" })).toMatchObject({ code: "invalid_arguments" });
  });
});

describe("a session this desktop holds no tab of yet (PRO-109)", () => {
  const launch = (sessionId: string, phase: string, state = "pending", fields: Record<string, unknown> = {}) => ({
    launchId: "launch-1",
    phase,
    state,
    workBranch: "main",
    agent: "claude",
    model: null,
    effort: null,
    mode: null,
    hasPrompt: true,
    category: null,
    sessionId,
    tabId: `${sessionId}-tab`,
    timings: { requestedAt: Date.now(), bootingAt: null, authenticatingAt: null, syncingAt: null, startingAgentAt: null, runningAt: null, failedAt: null },
    ...fields,
  });
  const said = (sessionId: string, texts: string[]) =>
    texts.map((text, index) => ({ id: `${sessionId}-e${index + 1}`, sessionId, tabId: `${sessionId}-tab`, seq: index + 1, ts: index + 1, payload: { type: index % 2 ? "assistant_message" : "user_message", text } }));
  const checkpointOf = (sessionId: string, texts: string[]) => ({
    epoch: 1,
    version: 1,
    projection: { v: 1, sessionId, tabId: `${sessionId}-tab`, title: null, harness: "claude", model: "opus", effort: null, permissionMode: "default", status: "idle", process: "running", events: said(sessionId, texts), truncated: false, followUps: [], updatedAt: 5 },
  });
  /** Every lease taken was given back. */
  const leasesReleased = async () => {
    for (const result of vi.mocked(connections.retainCloudConnection).mock.results) expect((await result.value).release).toHaveBeenCalledTimes(1);
  };

  it("follows a session the CLI just created with send, wait and read, the window untouched and the tab cache empty", async () => {
    await list(ORG, []);
    catalog.setCloudRepositories(ORG, [{ fullName: "acme/api", cloneUrl: acmeApi.cloneUrl, defaultBranch: "main", private: true, state: "accessible", reason: null } as never]);
    const { setPrefs, getPrefs } = await import("@/lib/prefs");
    setPrefs({ cloudProjects: { ...getPrefs().cloudProjects, [ORG]: ["github.com/acme/api"] } });
    vi.mocked(newSession.prepareCloudCreate).mockResolvedValue({ orgId: ORG, providerLabel: "Boat", quote: { currency: "USD", activeHourlyMicros: 120_000 }, pending: { idempotencyKey: "k", createdAt: 1, request: { idempotencyKey: "k" } } } as never);
    vi.mocked(newSession.confirmCloudCreate).mockResolvedValue({ workspace: { id: "ws-new", orgId: ORG, state: "provisioning" }, operation: { id: "op-1" } } as never);
    // The mailbox hands the runtime each message; its checkpoint then holds the turn.
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (args.workspaceId !== "ws-new") return base(command, args);
      if (command === "cloud_agent_outbox_sync") return enqueued.map((_, index) => ({ clientCommandId: `cmd-${index + 1}`, tabId: "s-new-tab", kind: "send", state: "applied", createdAt: 1, updatedAt: 2 }));
      if (command === "cloud_agent_checkpoint") return checkpointOf("s-new", ["fix the login", "fixed", "now run the tests", "they pass"]);
      return base(command, args);
    });
    try {
      expect(await handleCloudControl("sessions.create", { project: PROJECT, prompt: "fix the login", confirmSpend: true })).toMatchObject({ created: "workspace", workspace: `cloud:${ORG}:ws-new` });
      // What the window holds right after: the new workspace, still booting, its first session named by the launch.
      await list(ORG, [item("ws-new", ORG, { state: "provisioning", launch: launch("s-new", "booting") })]);
      const target = `cloud:${ORG}:ws-new:s-new`;
      const { sessions: listed } = (await handleCloudControl("sessions.list", { org: ORG })) as { sessions: { key: string; tabs: { id: string }[] }[] };
      expect(listed.find((entry) => entry.key === target)?.tabs).toEqual([expect.objectContaining({ id: "s-new-tab" })]);
      // Still booting: starting, not missing, and nothing attached to or woken.
      expect(await refusal("read", { target })).toMatchObject({ code: "cloud_workspace_starting", message: expect.stringContaining("(booting)") });
      expectNoWake();
      // Listed as ready before its runtime has started the agent: its runtime has no tab yet, and that too is starting.
      mocks.api.cloudWorkspaces.mockImplementation(async () => ({ workspaces: [item("ws-new", ORG, { launch: launch("s-new", "starting-agent") })] }));
      for (const action of ["read", "send", "wait"]) {
        expect(await refusal(action, { target, text: "hello", timeoutSeconds: 1 })).toMatchObject({ code: "cloud_workspace_starting", message: expect.stringContaining("(starting agent)") });
      }
      expect(await refusal("read", { target, tab: "s-new-tab" })).toMatchObject({ code: "cloud_workspace_starting" });
      expect(enqueued).toEqual([]);

      // The agent has started. Its runtime has the tab; this desktop's cache still has nothing.
      await list(ORG, [item("ws-new", ORG, { launch: launch("s-new", "running", "running") })]);
      mocks.runtime.listAgentTabs.mockResolvedValue([tabInfo("s-new")]);
      vi.useFakeTimers();
      const sent = await handleCloudControl("send", { target, text: "now run the tests" });
      expect(sent).toMatchObject({ session: target, tabId: "s-new-tab", state: "queued" });
      expect(enqueued).toEqual([expect.objectContaining({ workspaceId: "ws-new", tabId: "s-new-tab", kind: "send", payload: expect.objectContaining({ text: "now run the tests" }) })]);
      // The runtime was asked over `connect`, which attaches and never resumes.
      expect(connections.retainCloudConnection).toHaveBeenCalledWith({ orgId: ORG, workspaceId: "ws-new" }, "connect");

      const waited = await waitForCloudTab({ target, timeoutSeconds: 30 }, (ms) => vi.advanceTimersByTimeAsync(ms).then(() => undefined), () => Date.now());
      expect(waited).toMatchObject({ session: target, tabId: "s-new-tab", reason: "stopped", status: "idle" });

      const read = (await handleCloudControl("read", { target, tail: 2 })) as { tabId: string; events: { payload: { text: string } }[] };
      expect(read.tabId).toBe("s-new-tab");
      expect(read.events.map((event) => event.payload.text)).toEqual(["now run the tests", "they pass"]);
      expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
      expect(sessions.getSessionStore().selectedSessionId).toBeNull();
      await leasesReleased();
    } finally {
      vi.useRealTimers();
      setPrefs({ cloudProjects: {} });
    }
  });

  it("says why a launch started no agent, rather than that its session does not exist", async () => {
    const target = `cloud:${ORG}:ws-1:s-new`;
    await list(ORG, [item("ws-1", ORG, { launch: launch("s-new", "failed", "failed", { category: "agent-start-failed" }) })]);
    expect(await refusal("read", { target })).toMatchObject({ code: "not_found", message: expect.stringContaining("The agent could not be started.") });
    // Ready for long with its launch never claimed: the runtime cannot start it.
    await list(ORG, [item("ws-1", ORG, { launch: launch("s-new", "authenticating-runtime", "pending", { timings: { ...launch("s-new", "x").timings, requestedAt: 1, authenticatingAt: 1 } }) })]);
    expect(await refusal("read", { target })).toMatchObject({ code: "not_found", message: expect.stringContaining("has not picked up the first task") });
    expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("still answers not_found for a session the workspace's runtime does not have, and gives the connection back", async () => {
    mocks.runtime.listAgentTabs.mockResolvedValue([tabInfo("s1")]);
    for (const action of ["read", "send", "wait"]) {
      expect(await refusal(action, { target: `cloud:${ORG}:ws-1:no-such-session`, text: "hello", timeoutSeconds: 1 })).toMatchObject({ code: "not_found" });
    }
    expect(await refusal("read", { target: `cloud:${ORG}:ws-1:s1`, tab: "no-such-tab" })).toMatchObject({ code: "not_found" });
    expect(connections.retainCloudConnection).toHaveBeenCalledWith({ orgId: ORG, workspaceId: "ws-1" }, "connect");
    await leasesReleased();
    expect(enqueued).toEqual([]);
    expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    // The session the runtime does have reads as before.
    expect(((await handleCloudControl("read", { target: `cloud:${ORG}:ws-1:s1` })) as { tabId: string }).tabId).toBe("s1-tab");
  });

  it("reads a stopped workspace's session from a checkpoint saved after this desktop listed them, and connects to nothing", async () => {
    let saved: { tabId: string; epoch: number; version: number }[] = [];
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (args.workspaceId === "ws-stopped" && command === "cloud_agent_checkpoints") return saved;
      if (args.workspaceId === "ws-stopped" && command === "cloud_agent_checkpoint" && args.tabId === "s3-tab") return checkpointOf("s3", ["deploy it", "deployed"]);
      return base(command, args);
    });
    // Listing sessions loads every workspace's tabs here, its checkpoint list included: none names s3 yet.
    await handleCloudControl("sessions.list", { org: ORG });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_agent_checkpoints", expect.objectContaining({ workspaceId: "ws-stopped" })));
    // The session ran its first prompt and the workspace stopped before the CLI looked.
    saved = [{ tabId: "s3-tab", epoch: 1, version: 1 }];
    const read = (await handleCloudControl("read", { target: `cloud:${ORG}:ws-stopped:s3` })) as { tabId: string; source: string; events: unknown[] };
    expect(read).toMatchObject({ tabId: "s3-tab", source: "checkpoint" });
    expect(read.events).toHaveLength(2);
    expect(await refusal("read", { target: `cloud:${ORG}:ws-stopped:no-such-session` })).toMatchObject({ code: "not_found", message: expect.stringContaining("not running") });
    expectNoWake();
  });

  it("keeps the whole lookup inside its time, and gives back a connection that comes too late", async () => {
    vi.useFakeTimers();
    try {
      // The runtime never answers its tab list.
      mocks.runtime.listAgentTabs.mockReturnValue(new Promise(() => undefined));
      for (const [action, within] of [["read", LOOKUP_WITHIN_MS], ["send", SEND_LOOKUP_WITHIN_MS]] as const) {
        let answer: unknown = null;
        const pending = answerCloudControl(action, { target: `cloud:${ORG}:ws-1:s-new`, text: "hello" }).then((result) => (answer = result));
        await vi.advanceTimersByTimeAsync(within - 1);
        expect(answer).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(answer).toMatchObject({ ok: false, error: { code: "cloud_workspace_unreachable" } });
      }
      expect(enqueued).toEqual([]);
      await leasesReleased();
      // The connection itself takes longer than the lookup may.
      let connect: (lease: unknown) => void = () => undefined;
      const late = { release: vi.fn(), client: {}, current: () => null, state: () => ({ state: "opening" }), ended: () => false };
      vi.mocked(connections.retainCloudConnection).mockImplementationOnce(() => new Promise((resolve) => (connect = resolve)) as never);
      const pending = answerCloudControl("read", { target: `cloud:${ORG}:ws-1:s-new` });
      await vi.advanceTimersByTimeAsync(LOOKUP_WITHIN_MS);
      expect(await pending).toMatchObject({ ok: false, error: { code: "cloud_workspace_unreachable" } });
      connect(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a workspace this person has no role in before its own lookup asks for any tab, by the list's word or the runtime's", async () => {
    await list(OTHER, [item("ws-b", OTHER, { authority: "participate", you: { role: "none", canApprove: false, canManageShares: false } })]);
    for (const action of ["read", "send", "wait"]) {
      expect(await refusal(action, { target: `cloud:${OTHER}:ws-b:s-other`, text: "hello", timeoutSeconds: 1 })).toMatchObject({ code: "forbidden" });
    }
    // By the list's word: not even connected.
    expect(connections.retainCloudConnection).not.toHaveBeenCalled();
    // The list still says manager; the runtime says this person has no role now. The lookup asks it for no tab list. (What
    // the app's own connected listeners ask of a connection, the runtime refuses to someone with no role.)
    mocks.runtime.you = { userId: "u-1", role: "none", canApprove: false };
    mocks.runtime.listAgentTabs.mockResolvedValue([tabInfo("s-new")]);
    for (const action of ["read", "send"]) {
      const refused = await refusal(action, { target: `cloud:${ORG}:ws-1:s-new`, text: "hello" });
      expect(refused).toMatchObject({ code: "forbidden", message: expect.stringContaining("has not been shared with you") });
    }
    expect(mocks.runtime.listAgentTabs).not.toHaveBeenCalled();
    await leasesReleased();
    expect(enqueued).toEqual([]);
  });
});

describe("stop and resume", () => {
  // As the server answers both: "provisioning" while the operation runs, whichever it is.
  const snapshot = (id: string, action: "suspend" | "resume") => ({ workspace: item(id, ORG, { state: "provisioning" }).workspace, operation: { id: "op-9", workspaceId: id, action, state: "queued" } });
  const underway = (id: string, action: "suspend" | "resume", fields: Record<string, unknown> = {}) =>
    ({ ...item(id, ORG, { state: "provisioning", ...fields }), latestOperation: { id: `op-${action}`, workspaceId: id, action, state: "running" } }) as CloudWorkspaceListItem;
  const finished = (id: string, action: "suspend" | "resume", fields: Record<string, unknown> = {}) =>
    ({ ...item(id, ORG, { state: action === "suspend" ? "suspended" : "ready", ...fields }), latestOperation: { id: `op-${action}`, workspaceId: id, action, state: "succeeded" } }) as CloudWorkspaceListItem;
  /** What the server lists from now on, whatever this window last held. */
  const serverSays = (...workspaces: CloudWorkspaceListItem[]) => mocks.api.cloudWorkspaces.mockImplementation(async () => ({ workspaces }));
  /** A clock that only the sleeps move. */
  const clock = (onSleep: () => void = () => undefined) => {
    let at = 0;
    const sleep = vi.fn(async (ms: number) => {
      at += ms;
      onSleep();
    });
    return { sleep, now: () => at };
  };

  it("stops a running workspace only after --yes, and answers stopping, never the server's provisioning", async () => {
    const target = `cloud:${ORG}:ws-1`;
    const asked = await refusal("stop", { workspace: target });
    expect(asked.code).toBe("confirmation_required");
    expect(asked.recovery).toContain("--yes");
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
    mocks.api.cloudWorkspaceSuspend.mockResolvedValue(snapshot("ws-1", "suspend"));
    expect(await handleCloudControl("stop", { workspace: target, confirmed: true })).toEqual({ workspace: target, state: "stopping", operationId: "op-9", changed: true });
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledWith("ws-1", ORG);
    // Already stopped: nothing is sent.
    mocks.api.cloudWorkspaceSuspend.mockClear();
    expect(await handleCloudControl("stop", { workspace: `cloud:${ORG}:ws-stopped`, confirmed: true })).toEqual({ workspace: `cloud:${ORG}:ws-stopped`, state: "stopped", changed: false });
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
  });

  it("resumes a stopped workspace with the menu's Resume, once, and answers resuming", async () => {
    mocks.api.cloudWorkspaceResume.mockResolvedValue(snapshot("ws-stopped", "resume"));
    const resumed = (await handleCloudControl("resume", { workspace: `cloud:${ORG}:ws-stopped` })) as { changed: boolean; state: string };
    expect(resumed).toEqual({ workspace: `cloud:${ORG}:ws-stopped`, state: "resuming", operationId: "op-9", changed: true });
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledWith("ws-stopped", ORG);
    mocks.api.cloudWorkspaceResume.mockClear();
    expect(await handleCloudControl("resume", { workspace: `cloud:${ORG}:ws-1` })).toEqual({ workspace: `cloud:${ORG}:ws-1`, state: "running", changed: false });
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("resumes straight after a stop: the server's word, not the stop this window last saw running (PRO-113)", async () => {
    // This window still holds the stop's own answer; the server has finished it.
    mocks.api.cloudWorkspaceSuspend.mockResolvedValue(snapshot("ws-1", "suspend"));
    await handleCloudControl("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true });
    expect(catalog.findCloudWorkspace(catalog.getCloudCatalog(), ORG, "ws-1")?.workspace.state).toBe("provisioning");
    serverSays(finished("ws-1", "suspend"), item("ws-stopped", ORG, { state: "suspended" }));
    mocks.api.cloudWorkspaces.mockClear();
    mocks.api.cloudWorkspaceResume.mockResolvedValue(snapshot("ws-1", "resume"));
    const { sleep, now } = clock();
    expect(await cloudLifecycleCommands.resume({ workspace: `cloud:${ORG}:ws-1` }, sleep, now)).toMatchObject({ state: "resuming", changed: true });
    expect(mocks.api.cloudWorkspaces).toHaveBeenCalledWith(ORG);
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops straight after a resume, as the server has it", async () => {
    await list(ORG, [underway("ws-1", "resume")]);
    serverSays(finished("ws-1", "resume"));
    mocks.api.cloudWorkspaceSuspend.mockResolvedValue(snapshot("ws-1", "suspend"));
    expect(await handleCloudControl("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true })).toMatchObject({ state: "stopping", changed: true });
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledTimes(1);
  });

  it("waits a moment for a stop that is still running, then resumes", async () => {
    serverSays(underway("ws-1", "suspend"));
    const { sleep, now } = clock(() => sleep.mock.calls.length === 2 && serverSays(finished("ws-1", "suspend")));
    mocks.api.cloudWorkspaceResume.mockResolvedValue(snapshot("ws-1", "resume"));
    expect(await cloudLifecycleCommands.resume({ workspace: `cloud:${ORG}:ws-1` }, sleep, now)).toMatchObject({ state: "resuming", changed: true });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledTimes(1);
  });

  it("refuses a stop still running after the wait, says when to try again, and resumes nothing", async () => {
    serverSays(underway("ws-1", "suspend"));
    const { sleep, now } = clock();
    mocks.ask.mockClear();
    const refused = await cloudLifecycleCommands.resume({ workspace: `cloud:${ORG}:ws-1` }, sleep, now).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CloudControlError);
    expect(refused).toMatchObject({ code: "cloud_workspace_not_stopped", message: expect.stringContaining("stopping"), recovery: expect.stringContaining("once it has stopped") });
    expect(now()).toBe(LIFECYCLE_SETTLE_MS);
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("answers what is already on its way, and sends nothing again", async () => {
    serverSays(underway("ws-1", "suspend"), underway("ws-stopped", "resume"));
    const { sleep, now } = clock();
    expect(await cloudLifecycleCommands.stop({ workspace: `cloud:${ORG}:ws-1`, confirmed: true }, sleep, now)).toEqual({ workspace: `cloud:${ORG}:ws-1`, state: "stopping", operationId: "op-suspend", changed: false });
    expect(await cloudLifecycleCommands.resume({ workspace: `cloud:${ORG}:ws-stopped` }, sleep, now)).toEqual({ workspace: `cloud:${ORG}:ws-stopped`, state: "resuming", operationId: "op-resume", changed: false });
    expect(sleep).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("goes by the row it holds when the list cannot be read: the server still has the last word", async () => {
    mocks.api.cloudWorkspaces.mockRejectedValue({ code: "cloud_workspace_unavailable" });
    mocks.api.cloudWorkspaceResume.mockRejectedValue({ code: "cloud_workspace_operation_in_progress" });
    expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` })).toMatchObject({ code: "cloud_workspace_operation_in_progress" });
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledTimes(1);
  });

  it("does not act on a workspace the server no longer lists", async () => {
    serverSays(item("ws-1", ORG));
    expect(await refusal("resume", { workspace: `cloud:${ORG}:ws-stopped` })).toMatchObject({ code: "not_found" });
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

  it("ships with the setting, off by default, and confirmation for stopping", () => {
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

  describe("both together (what ships): the setting authorizes routine compute, stop still asks", () => {
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

    it("with the setting on, routine sends, resumes and session launches do not ask again", async () => {
      setCloudControlEnabled(true);
      mocks.ask.mockResolvedValue(false);
      for (const [action, params] of [
        ["send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "continue" }],
        ["resume", { workspace: `cloud:${ORG}:ws-stopped` }],
        ["sessions.create", { project: PROJECT, prompt: "go" }],
        ["sessions.create", { project: `cloud:${ORG}:github.com/acme/web`, prompt: "go", wake: true }],
      ] as [string, Record<string, unknown>][]) {
        await handleCloudControl(action, params);
      }
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(1);
      expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledOnce();
      expect(newSession.startInWorkspace).toHaveBeenCalledTimes(2);
      expect((await refusal("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true })).code).toBe("declined");
      expect(mocks.ask).toHaveBeenCalledOnce();
      expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
    });

    it("keeps role checks on every routine compute route", async () => {
      setCloudControlEnabled(true);
      signIn({ [ORG]: "member", [OTHER]: "member" });
      await list(ORG, [item("ws-1", ORG, { you: { role: "viewer", canApprove: false, canManageShares: false } }), item("ws-stopped", ORG, { state: "suspended", you: { role: "viewer", canApprove: false, canManageShares: false } })]);
      for (const [action, params] of [
        ["resume", { workspace: `cloud:${ORG}:ws-stopped` }],
        ["send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "hi" }],
        ["sessions.create", { project: PROJECT, prompt: "go", wake: true, confirmSpend: true }],
      ] as [string, Record<string, unknown>][]) expect(await refusal(action, params)).toMatchObject({ code: "forbidden" });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toEqual([]);
      expect(newSession.startInWorkspace).not.toHaveBeenCalled();
      expect(newSession.confirmCloudCreate).not.toHaveBeenCalled();
      expectNoWake();
    });

    it("starts an issue in a stopped workspace with --wake and no repeated dialog", async () => {
      setCloudControlEnabled(true);
      mocks.ask.mockResolvedValue(false);
      const issue = { provider: "github", id: "433", identifier: "#433", title: "Fix it", url: "https://github.com/acme/web/issues/433" };
      vi.mocked(newSession.startInWorkspace).mockImplementation(async (plan, _request, options) => {
        options?.onIssue?.({ supported: true, pipeline: { id: "p1", cloud: true }, note: null });
        return `${plan.node.key}:new-session`;
      });
      const created = await handleCloudControl("sessions.create", { project: `cloud:${ORG}:github.com/acme/web`, prompt: "Fix issue #433", issue, wake: true });
      expect(created).toMatchObject({ created: "session", resumed: true, pipeline: { id: "p1" } });
      expect(vi.mocked(newSession.startInWorkspace).mock.calls[0][1].issue).toMatchObject({ ref: issue, pipeline: true });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(newSession.confirmCloudCreate).not.toHaveBeenCalled();
    });

    it.each(["false", "error", "true"] as const)("rechecks native %s after the awaited resume catalog read", async (nativeAnswer) => {
      setCloudControlEnabled(true);
      mocks.ask.mockResolvedValue(false);
      let releaseList!: (value: { workspaces: CloudWorkspaceListItem[] }) => void;
      let enteredList!: () => void;
      const entered = new Promise<void>((resolve) => { enteredList = resolve; });
      const pendingList = new Promise<{ workspaces: CloudWorkspaceListItem[] }>((resolve) => { releaseList = resolve; });
      mocks.api.cloudWorkspaces.mockImplementationOnce(() => {
        enteredList();
        return pendingList;
      });
      mocks.api.cloudWorkspaceResume.mockResolvedValue({ workspace: item("ws-stopped", ORG, { state: "provisioning" }).workspace, operation: { id: "op-resume" } });
      const pending = answerCloudControl("resume", { workspace: `cloud:${ORG}:ws-stopped` });
      await entered;
      // Native was disabled elsewhere while this window still caches true.
      expect(cloudControlEnabled()).toBe(true);
      expect(mocks.setting).not.toHaveBeenCalled();
      if (nativeAnswer === "error") mocks.setting.mockRejectedValueOnce(new Error("unreadable"));
      else mocks.setting.mockResolvedValueOnce(nativeAnswer === "true");
      releaseList({ workspaces: [item("ws-stopped", ORG, { state: "suspended", repositories: [acmeWeb] })] });
      const result = await pending;
      expect(mocks.setting).toHaveBeenCalledOnce();
      expect(mocks.ask).not.toHaveBeenCalled();
      if (nativeAnswer === "true") {
        expect(result).toMatchObject({ ok: true, result: { changed: true } });
        expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: "cloud_control_disabled" } });
        expect(cloudControlEnabled()).toBe(false);
        expectNoWake();
      }
      expect(newSession.startInWorkspace).not.toHaveBeenCalled();
      expect(newSession.confirmCloudCreate).not.toHaveBeenCalled();
      expect(enqueued).toEqual([]);
    });

    it("does not authorize from an older native true read after a local disable", async () => {
      setCloudControlEnabled(true);
      let resolveNative!: (enabled: boolean) => void;
      let enteredNative!: () => void;
      const entered = new Promise<void>((resolve) => { enteredNative = resolve; });
      const read = new Promise<boolean>((resolve) => { resolveNative = resolve; });
      mocks.setting.mockImplementationOnce(() => { enteredNative(); return read; });
      const pending = answerCloudControl("resume", { workspace: `cloud:${ORG}:ws-stopped` });
      await entered;
      setCloudControlEnabled(false);
      resolveNative(true);
      expect(await pending).toMatchObject({ ok: false, error: { code: "cloud_control_disabled" } });
      expect(cloudControlEnabled()).toBe(false);
      expect(mocks.ask).not.toHaveBeenCalled();
      expectNoWake();
    });
  });

  describe("send does not trust the list it holds (review: a stop the app has not heard of)", () => {
    const TARGET = `cloud:${ORG}:ws-1:s1`;
    beforeEach(() => {
      setCloudControlPolicy("both");
      setCloudControlEnabled(true);
    });

    it("reads the list again and uses the Settings grant when the workspace has stopped since", async () => {
      // The catalog still says ready; the server now says it idle-stopped.
      mocks.api.cloudWorkspaces.mockImplementation(async () => ({ workspaces: [item("ws-1", ORG, { state: "suspended" })] }));
      mocks.ask.mockResolvedValue(false);
      await handleCloudControl("send", { target: TARGET, text: "still there?" });
      expect(mocks.api.cloudWorkspaces).toHaveBeenCalled();
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(1);
    });

    it("uses the Settings grant for a workspace on its way down", async () => {
      const midStop = { ...item("ws-1", ORG), latestOperation: { id: "op-stop", action: "suspend", state: "running" } } as CloudWorkspaceListItem;
      mocks.api.cloudWorkspaces.mockImplementation(async () => ({ workspaces: [midStop] }));
      mocks.ask.mockResolvedValue(false);
      await handleCloudControl("send", { target: TARGET, text: "one more thing" });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(1);
    });

    it("uses the Settings grant when a send may wake and the list cannot be read", async () => {
      mocks.api.cloudWorkspaces.mockRejectedValue({ code: "cloud_workspace_unavailable" });
      mocks.ask.mockResolvedValue(false);
      await handleCloudControl("send", { target: TARGET, text: "hello" });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(1);
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

  describe("send to a server that takes wake: false (PRO-89): the server decides, not a list read a moment ago", () => {
    const TARGET = `cloud:${ORG}:ws-1:s1`;
    /** Whether the server has the workspace running, whatever the catalog here says. */
    let running = true;
    beforeEach(() => {
      setCloudControlPolicy("both");
      setCloudControlEnabled(true);
      mocks.status = { ...mocks.status, agentCommandWake: true };
      running = true;
      const answer = mocks.invoke.getMockImplementation()!;
      mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "cloud_agent_enqueue" && args.wake === false && !running) {
          enqueued.push(args);
          // As native code answers: the refusal's code, and nothing kept in the outbox.
          return Promise.reject("cloud_workspace_stopped");
        }
        return answer(command, args);
      });
    });

    it("sends to a running workspace with wake: false, and neither reads the list nor asks", async () => {
      const sent = (await handleCloudControl("send", { target: TARGET, text: "run the tests" })) as Record<string, unknown>;
      expect(sent).toMatchObject({ commandId: "cmd-1", state: "queued" });
      expect(enqueued).toEqual([expect.objectContaining({ workspaceId: "ws-1", kind: "send", wake: false })]);
      expect(mocks.api.cloudWorkspaces).not.toHaveBeenCalled();
      expect(mocks.ask).not.toHaveBeenCalled();
      expectNoWake();
    });

    it("uses the Settings grant when the server reports a stopped workspace", async () => {
      // The catalog, and a list read just now, still say ready: only the server knows.
      running = false;
      mocks.ask.mockResolvedValue(false);
      await handleCloudControl("send", { target: TARGET, text: "still there?" });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(2);
      expect(enqueued[0]).toMatchObject({ wake: false });
      expect("wake" in enqueued[1]).toBe(false);
      expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    });

    it("sends again with wake allowed by the Settings grant", async () => {
      running = false;
      const sent = (await handleCloudControl("send", { target: TARGET, text: "still there?" })) as Record<string, unknown>;
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(2);
      expect(enqueued[0]).toMatchObject({ wake: false });
      expect("wake" in enqueued[1]).toBe(false);
      expect(sent).toMatchObject({ commandId: "cmd-2", state: "queued" });
    });

    it("passes any other refusal on without asking", async () => {
      mocks.invoke.mockImplementation(async (command: string) => {
        if (command === "cloud_agent_enqueue") return Promise.reject("cloud_workspace_agent_mailbox_full");
        return command === "cloud_agent_cache_load" ? { tabs: cached["ws-1"] } : [];
      });
      await refusal("send", { target: TARGET, text: "hello" });
      expect(mocks.ask).not.toHaveBeenCalled();
    });
  });

  it("never sends the wake key to a server that does not say it takes it", async () => {
    await handleCloudControl("send", { target: `cloud:${ORG}:ws-1:s1`, text: "run the tests" });
    await handleCloudControl("send", { target: `cloud:${ORG}:ws-stopped:s2`, text: "continue" });
    expect(enqueued).toHaveLength(2);
    expect(enqueued.every((args) => !("wake" in args))).toBe(true);
  });

  describe("the switch is native code's to keep", () => {
    it("does not let a delayed boot/settings refresh undo a newer disable", async () => {
      const { loadCloudControlSetting } = await import("./cloudControl");
      let resolveNative!: (enabled: boolean) => void;
      mocks.setting.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveNative = resolve; }));
      const refresh = loadCloudControlSetting();
      setCloudControlEnabled(false);
      // A repeated known disable also invalidates an outstanding read.
      setCloudControlEnabled(false);
      resolveNative(true);
      expect(await refresh).toBe(false);
      expect(cloudControlEnabled()).toBe(false);
    });

    it("does not let an older refresh overwrite a newer native false result", async () => {
      const { loadCloudControlSetting } = await import("./cloudControl");
      let resolveOlder!: (enabled: boolean) => void;
      mocks.setting.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveOlder = resolve; }));
      const older = loadCloudControlSetting();
      mocks.setting.mockResolvedValueOnce(false);
      expect(await loadCloudControlSetting()).toBe(false);
      resolveOlder(true);
      expect(await older).toBe(false);
      expect(cloudControlEnabled()).toBe(false);
    });

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
      const refused = await refusal("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true });
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
        const refused = await refusal("stop", { workspace: `cloud:${ORG}:ws-1`, confirmed: true });
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
      mocks.setting.mockResolvedValue(false);
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
      expect(mocks.setting).not.toHaveBeenCalled();
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
