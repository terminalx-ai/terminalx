import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeIssuePipeline, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { IssuePipeline } from "@/types/issuePipeline";

// #433, the cloud half: what this desktop knows of the pipelines a cloud
// workspace's runtime carries, and what it does with them. The runtime is a
// fake client; the catalog is the real one.

type Connected = (target: { orgId: string; workspaceId: string }, client: WorkspaceRpcClient) => void | (() => void);

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: null as unknown as AccountStatus,
  connected: [] as Connected[],
  access: [] as ((key: string, access: "lost" | "regained") => void)[],
  connectedClient: null as WorkspaceRpcClient | null,
  notePipelineState: vi.fn(),
  lease: { release: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({ notePipelineState: mocks.notePipelineState }));
vi.mock("@/lib/cloudCollab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudCollab")>()),
  onWorkspaceAccess: (listener: (key: string, access: "lost" | "regained") => void) => {
    mocks.access.push(listener);
    return () => undefined;
  },
}));
vi.mock("@/lib/cloudConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudConnections")>()),
  onCloudConnected: (listener: Connected) => {
    mocks.connected.push(listener);
    return () => undefined;
  },
  connectedCloudClient: vi.fn(() => mocks.connectedClient),
  wakeCloudConnection: vi.fn(async () => mocks.lease),
  retainCloudConnection: vi.fn(async () => mocks.lease),
  waitCloudConnected: vi.fn(async () => mocks.connectedClient),
}));

const catalog = await import("@/lib/cloudCatalog");
const connections = await import("@/lib/cloudConnections");
const { actOnCloudPipeline, bootCloudPipelines, getCloudPipelines, lookAtCloudPipeline, mergeCloudPipeline, resetCloudPipelines } = await import("./cloudPipelines");

const ORG = "org-a";
const TARGET = { orgId: ORG, workspaceId: "ws-1" };
const C1 = "1111111111111111111111111111111111111111";

function signIn() {
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    multiOrg: true,
    organizations: [{ id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } }],
  } as AccountStatus;
}

function item(id: string): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId: ORG, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true }], authority: "manage" },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

/** A pipeline as the runtime reports it: session ids are the runtime's own. */
function raw(patch: Record<string, unknown> = {}): RuntimeIssuePipeline {
  return {
    id: "p1",
    projectPath: "/workspace",
    cloud: true,
    issueBody: "Sessions stop at code.",
    issue: { provider: "github", id: "433", identifier: "#433", title: "Carry issue sessions on", url: "https://github.com/acme/api/issues/433" },
    branch: "raccoon/433-carry",
    author: { sessionId: "s1", tabId: "t1" },
    reviewer: { sessionId: "s2", tabId: "t2" },
    autoMerge: false,
    stopped: false,
    stage: "merge",
    state: "readyToMerge",
    reason: { kind: "cloudWorkspace" },
    pr: { number: 7, url: "https://github.com/acme/api/pull/7", base: "main" },
    round: 1,
    maxRounds: 3,
    verdict: { commit: C1, decision: "merge", securityPass: "notNeeded", findings: [], round: 1, at: "2026-10-18T10:00:00Z" },
    securityAreas: [],
    events: [{ at: "2026-10-18T10:00:00Z", stage: "work", kind: "started", message: "Session started.", sessionId: "s1" }],
    created: "2026-10-18T09:00:00Z",
    modified: "2026-10-18T10:00:00Z",
    ...patch,
  };
}

interface FakeRuntime {
  client: WorkspaceRpcClient;
  calls: string[];
  announce: (pipeline: RuntimeIssuePipeline) => void;
  listed: RuntimeIssuePipeline[];
}

function runtime(options: { capable?: boolean; role?: string } = {}): FakeRuntime {
  const calls: string[] = [];
  let announce: (pipeline: RuntimeIssuePipeline) => void = () => undefined;
  const fake: FakeRuntime = {
    calls,
    listed: [raw()],
    announce: (pipeline) => announce(pipeline),
    client: {
      connection: { state: "connected", authority: options.role === "none" || options.role === "viewer" ? "participate" : "manage", capabilities: [], runtimeGeneration: 1, you: options.role ? { userId: "u", role: options.role, canApprove: false, listed: true } : undefined },
      hasCapability: (capability: string) => capability === "pipeline/1" && options.capable !== false,
      listPipelines: async () => {
        calls.push("list");
        return fake.listed;
      },
      onPipeline: (listener: (pipeline: RuntimeIssuePipeline) => void) => {
        announce = listener;
        return () => {
          announce = () => undefined;
        };
      },
      actOnPipeline: async (id: string, action: string) => {
        calls.push(`act:${action}`);
        return raw({ id, state: action === "stop" ? "stopped" : "readyToMerge" });
      },
      noteMerge: async (id: string, commit: string) => {
        calls.push(`noteMerge:${commit}`);
        return raw({ id, state: "merged", merged: { commit, at: "2026-10-18T11:00:00Z", by: "person" } });
      },
      noteTracker: async (id: string, message: string) => {
        calls.push(`noteTracker:${message}`);
        const listed = fake.listed.find((pipeline) => pipeline.id === id) ?? raw({ id });
        return { ...listed, events: [...((listed.events as unknown[]) ?? []), { at: "2026-10-18T10:30:00Z", stage: "pullRequest", kind: "tracker", message }] };
      },
    } as unknown as WorkspaceRpcClient,
  };
  return fake;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function connect(fake: FakeRuntime) {
  for (const listener of mocks.connected) listener(TARGET, fake.client);
  await settle();
}

const shown = (): IssuePipeline | undefined => getCloudPipelines().find((pipeline) => pipeline.id === "p1");

const SETTINGS = { enabled: true, autoMerge: false, requirePerson: false, maxRounds: 3, mergeMethod: "squash" as const, protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [] };

beforeEach(async () => {
  signIn();
  mocks.connected = [];
  mocks.access = [];
  mocks.connectedClient = null;
  mocks.notePipelineState.mockReset();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  vi.mocked(connections.wakeCloudConnection).mockClear();
  vi.mocked(connections.retainCloudConnection).mockClear();
  vi.mocked(connections.waitCloudConnected).mockClear();
  resetCloudPipelines();
  await catalog.ingestCloudList({ workspaces: [item("ws-1")], quota: { used: 1, limit: 3 } }, ORG);
  bootCloudPipelines();
});

afterEach(() => {
  resetCloudPipelines();
  catalog.resetCloudCatalog();
});

describe("a cloud workspace's pipelines on this desktop", () => {
  it("are read when its runtime connects, and shown under its cloud project with cloud session keys", async () => {
    await connect(runtime());
    const pipeline = shown()!;
    expect(pipeline.projectPath).toBe(`cloud:${ORG}:github.com/acme/api`);
    expect(pipeline.cloud).toBe(true);
    expect(pipeline.author.sessionId).toBe(`cloud:${ORG}:ws-1:s1`);
    expect(pipeline.reviewer?.sessionId).toBe(`cloud:${ORG}:ws-1:s2`);
    expect(pipeline.events[0].sessionId).toBe(`cloud:${ORG}:ws-1:s1`);
    expect(pipeline.place).toMatchObject({ orgId: ORG, workspaceId: "ws-1", projectKey: `cloud:${ORG}:github.com/acme/api`, repository: "acme/api" });
    // Kept with the catalog for when the workspace sleeps; the issue's text is the reviewer's, not kept here.
    const kept = catalog.getCloudCatalog().orgs[ORG].pipelines?.["ws-1"]?.pipelines ?? [];
    expect(kept.map((each) => each.id)).toEqual(["p1"]);
    expect("issueBody" in kept[0]).toBe(false);
  });

  it("follow what the runtime announces, and one that comes to rest is news", async () => {
    const fake = runtime();
    fake.listed = [raw({ state: "working", stage: "review" })];
    await connect(fake);
    expect(mocks.notePipelineState).not.toHaveBeenCalled();
    fake.announce(raw({ state: "readyToMerge" }));
    expect(shown()?.state).toBe("readyToMerge");
    expect(mocks.notePipelineState).toHaveBeenCalledTimes(1);
    expect(mocks.notePipelineState.mock.calls[0][0]).toMatchObject({ id: "p1", place: { workspaceId: "ws-1" } });
    // The same state again is not.
    fake.announce(raw({ state: "readyToMerge", note: "Still ready." }));
    expect(mocks.notePipelineState).toHaveBeenCalledTimes(1);
  });

  it("are not asked of a runtime from before pipelines, and are forgotten when access to the workspace ends", async () => {
    const older = runtime({ capable: false });
    await connect(older);
    expect(older.calls).toEqual([]);
    expect(shown()).toBeUndefined();

    await connect(runtime());
    expect(shown()).toBeDefined();
    for (const listener of mocks.access) listener(`cloud:${ORG}:ws-1`, "lost");
    expect(shown()).toBeUndefined();
    // A connection that says this person has no role is not read, and drops what was kept.
    await connect(runtime());
    expect(shown()).toBeDefined();
    const unshared = runtime({ role: "none" });
    await connect(unshared);
    expect(unshared.calls).toEqual([]);
    expect(shown()).toBeUndefined();
  });

  it("are acted on in their runtime: a button wakes the workspace, the look on opening never does", async () => {
    const fake = runtime();
    await connect(fake);
    mocks.connectedClient = fake.client;
    await actOnCloudPipeline(shown()!, "stop");
    expect(connections.wakeCloudConnection).toHaveBeenCalledWith(TARGET);
    expect(fake.calls).toContain("act:stop");
    expect(shown()?.state).toBe("stopped");
    expect(mocks.lease.release).toHaveBeenCalled();

    await lookAtCloudPipeline(shown()!);
    expect(connections.retainCloudConnection).toHaveBeenCalledWith(TARGET, "connect");
    expect(vi.mocked(connections.waitCloudConnected).mock.calls.at(-1)?.[2]).toEqual({ stoppedIsError: true });
    expect(connections.wakeCloudConnection).toHaveBeenCalledTimes(1);
  });
});

describe("merging a cloud workspace's pull request from this computer", () => {
  it("merges with the reader's own gh, shows it merged at once, and tells a connected runtime", async () => {
    const fake = runtime();
    await connect(fake);
    mocks.connectedClient = fake.client;
    mocks.invoke.mockImplementation(async (command: string) => (command === "issue_pipeline_merge_cloud" ? { outcome: "merged", commit: C1 } : undefined));
    expect(await mergeCloudPipeline(shown()!, SETTINGS)).toBeNull();
    const [, args] = mocks.invoke.mock.calls.find(([command]) => command === "issue_pipeline_merge_cloud")!;
    expect(args).toMatchObject({ repository: "acme/api", settings: { mergeMethod: "squash" }, pipeline: { id: "p1", cloud: true } });
    await settle();
    expect(fake.calls).toContain(`noteMerge:${C1}`);
    expect(shown()).toMatchObject({ state: "merged", merged: { commit: C1, by: "person" } });
  });

  it("tells a runtime that was asleep as soon as it next connects, before it is read", async () => {
    await connect(runtime());
    mocks.invoke.mockImplementation(async (command: string) => (command === "issue_pipeline_merge_cloud" ? { outcome: "merged", commit: C1 } : undefined));
    expect(await mergeCloudPipeline(shown()!, SETTINGS)).toBeNull();
    // Shown as made, with the line the runtime would write.
    expect(shown()).toMatchObject({ state: "merged", note: "Merged from the issue page: pull request #7 at 1111111111 into main." });
    const woken = runtime();
    // What it still says, until it is told.
    woken.listed = [raw({ state: "merged", merged: { commit: C1, by: "person" } })];
    await connect(woken);
    expect(woken.calls).toEqual([`noteMerge:${C1}`, "list"]);
    // Told once.
    const again = runtime();
    await connect(again);
    expect(again.calls).toEqual(["list"]);
  });

  it("says why nothing was merged, and has the runtime look again", async () => {
    const fake = runtime();
    await connect(fake);
    mocks.connectedClient = fake.client;
    mocks.invoke.mockImplementation(async (command: string) => (command === "issue_pipeline_merge_cloud" ? { outcome: "notMerged", reason: "The branch moved to 2222222222 after the review of 1111111111." } : undefined));
    expect(await mergeCloudPipeline(shown()!, SETTINGS)).toContain("moved to 2222222222");
    await settle();
    expect(fake.calls).toContain("act:refresh");
    expect(fake.calls.some((call) => call.startsWith("noteMerge"))).toBe(false);
    expect(shown()?.state).toBe("readyToMerge");
  });
});

describe("a cloud workspace's Linear issue", () => {
  const linear = (patch: Record<string, unknown> = {}) =>
    raw({ issue: { provider: "linear", id: "uuid-42", identifier: "ENG-42", title: "Fix login timeout", url: "https://linear.app/acme/issue/ENG-42" }, stage: "review", state: "working", ...patch });

  it("is moved to review by a desktop that manages the workspace, with its own Linear key, and the runtime records it once", async () => {
    mocks.invoke.mockImplementation(async (command: string) => (command === "issue_pipeline_linear_to_review" ? "Moved ENG-42 to In Review in Linear." : undefined));
    const fake = runtime();
    fake.listed = [linear()];
    await connect(fake);
    await settle();
    const moves = mocks.invoke.mock.calls.filter(([command]) => command === "issue_pipeline_linear_to_review");
    expect(moves).toEqual([["issue_pipeline_linear_to_review", { id: "uuid-42", identifier: "ENG-42" }]]);
    expect(fake.calls).toContain("noteTracker:Moved ENG-42 to In Review in Linear.");
    expect(shown()?.events.some((event) => event.kind === "tracker")).toBe(true);
    // Announced again, or read again on the next connect: not moved twice.
    fake.announce(linear({ note: "Review 1 of 3." }));
    await connect(fake);
    await settle();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "issue_pipeline_linear_to_review")).toHaveLength(1);
  });

  it("is left alone before its pull request, once recorded, and by a desktop that only views the workspace", async () => {
    mocks.invoke.mockResolvedValue("Moved ENG-42 to In Review in Linear.");
    const early = runtime();
    early.listed = [linear({ id: "p-early", pr: null, stage: "work" })];
    await connect(early);
    const recorded = runtime();
    recorded.listed = [linear({ id: "p-recorded", events: [{ at: "2026-10-18T10:00:00Z", stage: "pullRequest", kind: "tracker", message: "Moved ENG-42 to In Review in Linear." }] })];
    await connect(recorded);
    const viewer = runtime({ role: "viewer" });
    viewer.listed = [linear({ id: "p-viewed" })];
    await connect(viewer);
    await settle();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "issue_pipeline_linear_to_review")).toEqual([]);
    expect([...early.calls, ...recorded.calls, ...viewer.calls].some((call) => call.startsWith("noteTracker"))).toBe(false);
  });
});
