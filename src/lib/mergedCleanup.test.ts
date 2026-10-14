import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergedRemoval, MergedStatus } from "@terminalx/portable/workspace";
import type { MergedCleanupSettings } from "@/lib/api";

// #432: a workspace is removed by itself once its pull request has merged.
// The hosts do the removing; this is what runs their passes and shows the result.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  catalog: { orgs: {} as Record<string, { workspaces: { workspace: { orgId: string; id: string; name: string; state: string } }[] }> },
  clients: new Map<string, unknown>(),
  manages: true,
  forgetWorkspaceSize: vi.fn(),
  forgetCloudSessions: vi.fn(),
  refreshCloudSessions: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@/lib/cloudCatalog", () => ({ getCloudCatalog: () => mocks.catalog }));
vi.mock("@/lib/cloudConnections", () => ({ connectedCloudClient: (key: string) => mocks.clients.get(key) ?? null }));
vi.mock("@/lib/cloudSessions", () => ({ managesOf: () => mocks.manages, forgetCloudSessions: mocks.forgetCloudSessions, refreshCloudSessions: mocks.refreshCloudSessions }));
vi.mock("@/lib/workspaceSizes", () => ({ forgetWorkspaceSize: mocks.forgetWorkspaceSize }));

const lib = await import("./mergedCleanup");
const { setAppWindowForTest } = await import("@/lib/appWindow");

const START = Date.parse("2026-10-12T10:00:00Z");
const worktree = "/repos/app/.raccoon/worktrees/quiet-amber-fox";
const record: MergedRemoval = {
  id: "removal-1",
  removedAt: "2026-10-12T10:11:00Z",
  projectPath: "/repos/app",
  path: worktree,
  name: "quiet-amber-fox",
  branch: "raccoon/quiet-amber-fox",
  commit: "a".repeat(40),
  pr: { number: 62, title: "Fix login", url: "https://github.com/o/r/pull/62", head: "a".repeat(40) },
  localBranch: { outcome: "deleted" },
  remoteBranch: { outcome: "deleted" },
  sessionsKept: ["s1"],
  sessionsDeleted: [],
};
const status = (patch: Partial<MergedStatus> = {}): MergedStatus => ({
  projectPath: "/repos/app",
  path: worktree,
  name: "quiet-amber-fox",
  branch: "raccoon/quiet-amber-fox",
  pr: record.pr,
  phase: "scheduled",
  reason: null,
  detail: null,
  due: null,
  fresh: false,
  sessions: ["s1"],
  record: null,
  ...patch,
});
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

let settings: MergedCleanupSettings;
/** What each pass on this computer answers, in turn; the last one repeats. */
let passes: MergedStatus[][];
/** The projects whose pull requests a pass on this computer could not read. */
let unreadable: { projectPath: string; reason: string }[];

const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  settings = { enabled: false, projects: {}, deleteConversations: false, graceMinutes: 10 };
  passes = [[]];
  unreadable = [];
  mocks.catalog.orgs = {};
  mocks.clients.clear();
  mocks.manages = true;
  mocks.listeners.clear();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: { patch?: Partial<MergedCleanupSettings> & { project?: { key: string; enabled: boolean | null } } }) => {
    if (command === "merged_cleanup_settings") return settings;
    if (command === "set_merged_cleanup_settings") {
      const { project, ...rest } = args?.patch ?? {};
      const projects = { ...settings.projects };
      if (project) {
        if (project.enabled === null) delete projects[project.key];
        else projects[project.key] = project.enabled;
      }
      settings = { ...settings, ...rest, projects };
      return settings;
    }
    if (command === "merged_cleanup_sweep") return { statuses: passes.length > 1 ? passes.shift() : passes[0], unreadable };
    if (command === "merged_cleanup_restore") return { record: { ...record, restoredAt: "2026-10-12T10:12:00Z" }, notes: [] };
    if (command === "merged_cleanup_records") return [{ ...record, blocked: null }];
    return undefined;
  });
  mocks.forgetWorkspaceSize.mockClear();
  mocks.forgetCloudSessions.mockClear();
  mocks.refreshCloudSessions.mockClear();
});

afterEach(() => {
  lib.resetMergedCleanupForTest();
  setAppWindowForTest(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("with the setting off", () => {
  it("no pass is ever run, so nothing can be removed", async () => {
    await lib.bootMergedCleanup();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls("merged_cleanup_sweep")).toEqual([]);
    expect(lib.getMergedCleanup()).toMatchObject({ ready: true, statuses: {}, unreadable: {}, notices: [] });
  });
});

describe("with the setting on for this computer", () => {
  beforeEach(() => {
    settings.enabled = true;
  });

  it("says once that a workspace will go, runs the next pass when its grace period ends, and says what kept it", async () => {
    passes = [[status({ fresh: true, due: inMinutes(10) })], [status({ phase: "kept", reason: "2 uncommitted files", detail: "It has 2 untracked files." })], [status({ due: inMinutes(5.5) })], [status({ phase: "removed", record })], []];
    await lib.bootMergedCleanup();
    await flush();
    expect(calls("merged_cleanup_sweep")).toHaveLength(1);
    const key = lib.statusKey(lib.LOCAL_HOST, worktree);
    expect(lib.getMergedCleanup().statuses[key]).toMatchObject({ hostId: "local", phase: "scheduled" });
    expect(lib.mergedNote(lib.getMergedCleanup().statuses[key])).toBe("merged: deleting in 10 min");
    expect(lib.getMergedCleanup().notices).toMatchObject([{ kind: "scheduled", hostId: "local" }]);

    // Nothing is due for ten minutes: the usual interval.
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS - 1_000);
    expect(calls("merged_cleanup_sweep")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls("merged_cleanup_sweep")).toHaveLength(2);
    // It has uncommitted files now: it stays, its row says why, and the notice is withdrawn.
    expect(lib.mergedNote(lib.getMergedCleanup().statuses[key])).toBe("kept: 2 uncommitted files");
    expect(lib.getMergedCleanup().notices).toEqual([]);

    // Clean again, four minutes in, with a minute and a half to go: said again, and
    // the pass after that is timed to the moment it is due, not to the usual interval.
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(calls("merged_cleanup_sweep")).toHaveLength(3);
    expect(lib.getMergedCleanup().notices).toMatchObject([{ kind: "scheduled" }]);
    expect(lib.mergedNote(lib.getMergedCleanup().statuses[key])).toBe("merged: deleting in 2 min");
    await vi.advanceTimersByTimeAsync(85_000);
    expect(calls("merged_cleanup_sweep")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(calls("merged_cleanup_sweep")).toHaveLength(4);
    // Gone: no row is left to say anything, and a notice offers to undo it.
    expect(lib.getMergedCleanup().statuses).toEqual({});
    expect(lib.getMergedCleanup().notices).toMatchObject([{ id: "removal-1", kind: "removed", status: { record: { id: "removal-1" } } }]);
    expect(mocks.forgetWorkspaceSize).toHaveBeenCalledWith(worktree);
  });

  it("does not announce again what was already waiting when the app started", async () => {
    passes = [[status({ due: inMinutes(4) })]];
    await lib.bootMergedCleanup();
    await flush();
    expect(Object.values(lib.getMergedCleanup().statuses)).toHaveLength(1);
    expect(lib.getMergedCleanup().notices).toEqual([]);
  });

  it("keeps a workspace when asked, and looks again at once", async () => {
    passes = [[status({ fresh: true, due: inMinutes(10) })], [status({ phase: "held" })]];
    await lib.bootMergedCleanup();
    await flush();
    await lib.holdMergedWorkspace(lib.LOCAL_HOST, worktree, true);
    expect(calls("merged_cleanup_hold")).toEqual([["merged_cleanup_hold", { path: worktree, held: true }]]);
    expect(calls("merged_cleanup_sweep")).toHaveLength(2);
    const held = lib.getMergedCleanup().statuses[lib.statusKey(lib.LOCAL_HOST, worktree)];
    expect(lib.mergedNote(held)).toBe("kept: your choice");
    expect(lib.getMergedCleanup().notices).toEqual([]);
  });

  it("undoes a removal on the host that made it", async () => {
    await lib.bootMergedCleanup();
    await flush();
    const restored = await lib.restoreMergedRemoval(lib.LOCAL_HOST, "removal-1");
    expect(calls("merged_cleanup_restore")).toEqual([["merged_cleanup_restore", { id: "removal-1" }]]);
    expect(restored.record.restoredAt).toBeTruthy();
  });

  it("turned off, it runs one last pass so the backend forgets, and then none", async () => {
    passes = [[status({ fresh: true, due: inMinutes(10) })], []];
    await lib.bootMergedCleanup();
    await flush();
    expect(calls("merged_cleanup_sweep")).toHaveLength(1);
    await lib.saveMergedCleanupSettings({ enabled: false });
    await flush();
    expect(calls("merged_cleanup_sweep")).toHaveLength(2);
    expect(lib.getMergedCleanup()).toMatchObject({ settings: { enabled: false }, statuses: {}, notices: [] });
    // The backend sends the change to every window, this one included: no pass for that.
    mocks.listeners.get("merged_cleanup_settings")?.({ payload: { ...settings } });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls("merged_cleanup_sweep")).toHaveLength(2);
    // Changed from elsewhere, it is mirrored and takes effect.
    settings = { ...settings, projects: { "/repos/app": true } };
    mocks.listeners.get("merged_cleanup_settings")?.({ payload: settings });
    await flush();
    expect(lib.mergedCleanupOn(lib.getMergedCleanup().settings, "/repos/app")).toBe(true);
    expect(lib.mergedCleanupOn(lib.getMergedCleanup().settings, "/repos/other")).toBe(false);
    expect(calls("merged_cleanup_sweep")).toHaveLength(3);
  });

  it("says which project's pull requests could not be read, until they can", async () => {
    unreadable = [{ projectPath: "/repos/app", reason: "GitHub CLI (gh) is not installed or not on PATH." }];
    await lib.bootMergedCleanup();
    await flush();
    expect(lib.getMergedCleanup().unreadable).toEqual({ [lib.statusKey(lib.LOCAL_HOST, "/repos/app")]: "GitHub CLI (gh) is not installed or not on PATH." });
    unreadable = [];
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(lib.getMergedCleanup().unreadable).toEqual({});
  });

  it("a host that does not answer keeps what was known of it", async () => {
    passes = [[status({ phase: "kept", reason: "1 unpushed commit" })]];
    unreadable = [{ projectPath: "/repos/other", reason: "gh: not logged in" }];
    await lib.bootMergedCleanup();
    await flush();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "merged_cleanup_sweep") throw new Error("The session index could not be read");
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(Object.values(lib.getMergedCleanup().statuses)).toMatchObject([{ phase: "kept", reason: "1 unpushed commit" }]);
    expect(Object.values(lib.getMergedCleanup().unreadable)).toEqual(["gh: not logged in"]);
  });

  it("looks at once when an issue's pipeline merges its pull request, and once only", async () => {
    await lib.bootMergedCleanup();
    await flush();
    expect(calls("merged_cleanup_sweep")).toHaveLength(1);
    const heard = (state: string) => mocks.listeners.get("issue_pipeline")!({ payload: { id: "p1", state } });
    heard("readyToMerge");
    await flush();
    expect(calls("merged_cleanup_sweep")).toHaveLength(1);
    heard("merged");
    await flush();
    expect(calls("merged_cleanup_sweep")).toHaveLength(2);
    // Whatever else the pipeline says once merged is not a reason to ask GitHub again.
    heard("merged");
    await flush();
    expect(calls("merged_cleanup_sweep")).toHaveLength(2);
  });

  it("only the main window runs passes; the floating window mirrors the setting", async () => {
    setAppWindowForTest("floating");
    await lib.bootMergedCleanup();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lib.getMergedCleanup().settings.enabled).toBe(true);
    expect(calls("merged_cleanup_sweep")).toEqual([]);
    expect(mocks.listeners.has("issue_pipeline")).toBe(false);
  });

  it("a notice waits for the reader to be at the app before it goes by itself", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    passes = [[status({ fresh: true, due: inMinutes(10) })]];
    await lib.bootMergedCleanup();
    await flush();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(lib.getMergedCleanup().notices).toHaveLength(1);
    // Back at the app: it is seen for a while, then goes.
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(lib.getMergedCleanup().notices).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lib.getMergedCleanup().notices).toEqual([]);
  });
});

describe("a cloud workspace", () => {
  const key = "cloud:org-1:ws-1";
  const remote = "/workspace/.raccoon/worktrees/calm-teal-owl";
  const client = (capabilities = ["workspace/1", "workspace/2"]) => ({
    hasCapability: (capability: string) => capabilities.includes(capability),
    sweepMergedWorkspaces: vi.fn(async (_: { enabled?: boolean; deleteSessions: boolean; graceSeconds: number }) => ({
      statuses: [status({ path: remote, name: "calm-teal-owl", phase: "kept", reason: "an agent is running in \"Fix login\"" })],
      unreadable: [] as { projectPath: string; reason: string }[],
    })),
    holdMergedWorkspace: vi.fn(async () => undefined),
    removedWorkspaceRecords: vi.fn(async () => []),
    restoreRemovedWorkspace: vi.fn(async () => ({ record, notes: [] })),
  });

  beforeEach(() => {
    mocks.catalog.orgs = { "org-1": { workspaces: [{ workspace: { orgId: "org-1", id: "ws-1", name: "api", state: "ready" } }, { workspace: { orgId: "org-1", id: "ws-old", name: "archive", state: "archived" } }] } };
    settings.projects = { [key]: true };
  });

  it("is asked by its runtime's own pass, as a manager, with the grace period, and nothing local is run for it", async () => {
    const runtime = client();
    mocks.clients.set(key, runtime);
    settings.graceMinutes = 30;
    await lib.bootMergedCleanup();
    await flush();
    expect(runtime.sweepMergedWorkspaces.mock.calls).toEqual([[{ deleteSessions: false, graceSeconds: 1800 }]]);
    expect(calls("merged_cleanup_sweep")).toEqual([]);
    // Its row is a session's: the status is found by the session in the worktree.
    expect(lib.getMergedCleanup().statuses[lib.statusKey(key, remote)]).toMatchObject({ hostId: key, sessions: ["s1"], phase: "kept" });

    // A removal there: the sessions deleted with it are dropped, and its list is read again.
    runtime.sweepMergedWorkspaces.mockResolvedValueOnce({ statuses: [status({ path: remote, phase: "removed", record: { ...record, path: remote, sessionsKept: [], sessionsDeleted: ["s1"] } })], unreadable: [] });
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(mocks.forgetCloudSessions).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1" }, ["s1"]);
    expect(mocks.refreshCloudSessions).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1" }, runtime);
    expect(mocks.forgetWorkspaceSize).not.toHaveBeenCalled();
    expect(lib.getMergedCleanup().notices).toMatchObject([{ kind: "removed", hostId: key }]);
  });

  it("is left alone when it is not connected, its runtime is older, or the reader does not manage it", async () => {
    await lib.bootMergedCleanup();
    await flush();
    const targets = () => lib.cloudMergedTargets(mocks.catalog as never);
    // An archived workspace is not offered at all; a stopped one is never woken.
    expect(targets()).toEqual([{ key, orgId: "org-1", workspaceId: "ws-1", name: "api", unavailable: "Runs while the workspace is connected." }]);

    const older = client(["workspace/1"]);
    mocks.clients.set(key, older);
    expect(targets()[0].unavailable).toBe("Its runtime is older than this setting. Restart the workspace to update it.");
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(older.sweepMergedWorkspaces).not.toHaveBeenCalled();

    const viewed = client();
    mocks.clients.set(key, viewed);
    mocks.manages = false;
    expect(targets()[0].unavailable).toBe("Needs manager access to the workspace.");
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(viewed.sweepMergedWorkspaces).not.toHaveBeenCalled();
    await expect(lib.holdMergedWorkspace(key, remote, true)).rejects.toThrow("Needs manager access");

    // Managed and current: asked, and a status that was shown goes when it no longer can be.
    mocks.manages = true;
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(viewed.sweepMergedWorkspaces).toHaveBeenCalledTimes(1);
    expect(Object.keys(lib.getMergedCleanup().statuses)).toHaveLength(1);
    mocks.clients.delete(key);
    await vi.advanceTimersByTimeAsync(lib.SWEEP_MS);
    expect(lib.getMergedCleanup().statuses).toEqual({});
  });

  it("turned off, its runtime is told once, so that it forgets what it had seen", async () => {
    const runtime = client();
    mocks.clients.set(key, runtime);
    await lib.bootMergedCleanup();
    await flush();
    await lib.saveMergedCleanupSettings({ project: { key, enabled: false } });
    await flush();
    expect(runtime.sweepMergedWorkspaces.mock.calls.map(([options]) => options.enabled)).toEqual([undefined, false]);
    expect(lib.getMergedCleanup().statuses).toEqual({});
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runtime.sweepMergedWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("keeps, lists and undoes on the runtime that holds the worktree", async () => {
    const runtime = client();
    mocks.clients.set(key, runtime);
    await lib.bootMergedCleanup();
    await flush();
    await lib.holdMergedWorkspace(key, remote, true);
    expect(runtime.holdMergedWorkspace).toHaveBeenCalledWith(remote, true);
    expect(calls("merged_cleanup_hold")).toEqual([]);
    await lib.restoreMergedRemoval(key, "removal-1");
    expect(runtime.restoreRemovedWorkspace).toHaveBeenCalledWith("removal-1");
    expect(mocks.refreshCloudSessions).toHaveBeenCalled();
    expect(await lib.mergedRecords()).toEqual([
      { hostId: "local", name: null, records: [{ ...record, blocked: null }] },
      { hostId: key, name: "api", records: [] },
    ]);
    // A host that cannot be asked says so, and the others still answer.
    runtime.removedWorkspaceRecords.mockRejectedValueOnce(new Error("dropped"));
    expect((await lib.mergedRecords()).map((host) => host.records?.length ?? null)).toEqual([1, null]);
  });
});

describe("what is said", () => {
  it("of a workspace: why it stays or when it goes", () => {
    const now = Date.parse("2026-10-12T10:00:00Z");
    expect(lib.mergedNote(status({ phase: "kept", reason: "2 uncommitted files" }), now)).toBe("kept: 2 uncommitted files");
    expect(lib.mergedNote(status({ phase: "held" }), now)).toBe("kept: your choice");
    expect(lib.mergedNote(status({ due: "2026-10-12T10:08:10Z" }), now)).toBe("merged: deleting in 9 min");
    expect(lib.mergedNote(status({ due: "2026-10-12T10:00:20Z" }), now)).toBe("merged: deleting shortly");
    expect(lib.mergedNote(status({ due: "2026-10-12T09:59:00Z" }), now)).toBe("merged: deleting shortly");
  });

  it("of its branches once it is gone, including a remote branch that moved", () => {
    expect(lib.branchOutcome(record)).toBe("The local branch raccoon/quiet-amber-fox was deleted. Its branch on the remote was deleted.");
    expect(lib.branchOutcome({ ...record, remoteBranch: { outcome: "moved", at: "b".repeat(40) } })).toBe(
      "The local branch raccoon/quiet-amber-fox was deleted. Its branch on the remote was kept: it has moved to bbbbbbb since the merge.",
    );
    expect(lib.branchOutcome({ ...record, remoteBranch: { outcome: "alreadyGone" } })).toContain("was already gone.");
    expect(lib.branchOutcome({ ...record, remoteBranch: { outcome: "kept", reason: "it could not be deleted: no answer in time" } })).toContain("was kept: it could not be deleted: no answer in time.");
  });
});
