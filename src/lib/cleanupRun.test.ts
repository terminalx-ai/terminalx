import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupCandidate, CleanupProgress, CleanupRemoveItem, CleanupResult } from "@terminalx/portable/workspace";

const setQuitWarning = vi.fn(async (_warning: string | null) => undefined);
const forgetWorkspaceSize = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { setQuitWarning: (warning: string | null) => setQuitWarning(warning) },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/lib/cloudConnections", () => ({ connectedCloudClient: () => null }));
vi.mock("@/lib/cloudSessions", () => ({ managesOf: () => true }));
vi.mock("@/lib/workspaceSizes", () => ({ forgetWorkspaceSize: (path: string) => forgetWorkspaceSize(path) }));

import { clearCleanupRun, getCleanupRun, resetCleanupRun, startCleanupRun, stopCleanupRun, summarize } from "./cleanupRun";
import { LOCAL_HOST, STOPPED, type CleanupHost, type CleanupSelection, type RemoveOptions } from "./worktreeCleanup";

function candidate(name: string): CleanupCandidate {
  return { projectPath: "/p", path: `/p/.raccoon/worktrees/${name}`, name, branch: `raccoon/${name}`, head: "abc", managed: true, verdict: "eligible", reason: null, lastActivity: null, sessions: [], disposable: [], ignoredData: [], token: `token-${name}` };
}

const result = (item: { path: string }, patch: Partial<CleanupResult> = {}): CleanupResult => ({ projectPath: "/p", path: item.path, outcome: "removed", reason: null, freedBytes: 1_000, keptBranch: "b", sessionsKept: [], sessionsDeleted: [], ...patch });

/** A host whose removal is answered by hand, and that reports what it is told to. */
function host(id: string, kind: CleanupHost["kind"] = "local") {
  const calls: { items: CleanupRemoveItem[]; options: RemoveOptions; answer: (results: CleanupResult[]) => void; fail: (error: Error) => void }[] = [];
  const entry: CleanupHost = {
    id,
    kind,
    name: kind === "local" ? "This computer" : "Build box",
    unavailable: null,
    scan: async () => [],
    size: async () => null,
    cancelSizes: async () => undefined,
    remove: (items, options = {}) => new Promise((answer, fail) => calls.push({ items, options, answer, fail })),
  };
  return { entry, calls, tell: (progress: CleanupProgress) => calls.at(-1)!.options.onProgress?.(progress) };
}

const pick = (hostId: string, name: string, estimatedBytes: number | null = 2_000): CleanupSelection => ({ hostId, candidate: candidate(name), deleteSessions: false, estimatedBytes });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the clean-up run", () => {
  beforeEach(() => {
    setQuitWarning.mockClear();
    forgetWorkspaceSize.mockClear();
  });
  afterEach(() => resetCleanupRun());

  it("is followed from outside any view: where it is, what it freed, and what it came to", async () => {
    const here = host(LOCAL_HOST);
    expect(getCleanupRun()).toBeNull();
    expect(startCleanupRun([here.entry], [pick(LOCAL_HOST, "a"), pick(LOCAL_HOST, "b", null)])).toBe(true);
    let run = getCleanupRun()!;
    expect(run).toMatchObject({ status: "running", stopping: false, outcomes: [] });
    expect(run.items.map((item) => `${item.name} on ${item.hostName} ${item.estimatedBytes}`)).toEqual(["a on This computer 2000", "b on This computer null"]);
    expect(run.current).toEqual({ key: run.items[0]!.key, step: null });
    expect(summarize(run)).toMatchObject({ total: 2, done: 0, expectedBytes: 2_000, unsized: 1, problems: 0 });
    // The review's size goes to the host; one that was never measured is left for it to measure.
    expect(here.calls[0]!.items.map((item) => item.estimatedBytes)).toEqual([2_000, undefined]);

    const [a, b] = run.items;
    here.tell({ kind: "step", index: 0, total: 2, path: a!.path, step: "removing" });
    expect(getCleanupRun()!.current).toEqual({ key: a!.key, step: "removing" });
    here.tell({ kind: "finished", index: 0, total: 2, result: result(a!, { freedBytes: 2_000, freedEstimated: true }) });
    here.tell({ kind: "started", index: 1, total: 2, projectPath: "/p", path: b!.path });
    run = getCleanupRun()!;
    expect(run.status).toBe("running");
    expect(run.current).toEqual({ key: b!.key, step: null });
    expect(summarize(run)).toMatchObject({ done: 1, removed: 1, freedBytes: 2_000, freedEstimated: true });

    here.calls[0]!.answer([result(a!, { freedBytes: 2_000, freedEstimated: true }), result(b!, { outcome: "failed", reason: "Could not remove the worktree", freedBytes: 0 })]);
    await flush();
    run = getCleanupRun()!;
    expect(run).toMatchObject({ status: "done", stopping: false, current: null });
    expect(summarize(run)).toMatchObject({ done: 2, removed: 1, failed: 1, problems: 1 });
    // Only what this computer really removed has its remembered size dropped.
    expect(forgetWorkspaceSize.mock.calls).toEqual([[a!.path]]);
  });

  it("only one runs at a time, and a finished one stays until it is read", async () => {
    const here = host(LOCAL_HOST);
    expect(startCleanupRun([here.entry], [])).toBe(false);
    expect(startCleanupRun([here.entry], [pick(LOCAL_HOST, "a")])).toBe(true);
    const first = getCleanupRun();
    // A second confirmation while it runs starts nothing and sends nothing.
    expect(startCleanupRun([here.entry], [pick(LOCAL_HOST, "z")])).toBe(false);
    expect(here.calls).toHaveLength(1);
    expect(getCleanupRun()).toBe(first);
    // It cannot be forgotten while it runs either: hiding the dialog leaves it be.
    clearCleanupRun();
    expect(getCleanupRun()?.status).toBe("running");

    here.calls[0]!.answer([result(candidate("a"))]);
    await flush();
    expect(getCleanupRun()?.status).toBe("done");
    clearCleanupRun();
    expect(getCleanupRun()).toBeNull();
    // Once it is over the next one may start.
    expect(startCleanupRun([here.entry], [pick(LOCAL_HOST, "z")])).toBe(true);
    here.calls[1]!.answer([result(candidate("z"))]);
    await flush();
    expect(getCleanupRun()?.status).toBe("done");
  });

  it("warns before a quit for exactly as long as it runs", async () => {
    const here = host(LOCAL_HOST);
    startCleanupRun([here.entry], [pick(LOCAL_HOST, "a")]);
    await flush();
    expect(setQuitWarning).toHaveBeenLastCalledWith(expect.stringMatching(/worktree clean-up is still running/));
    here.calls[0]!.answer([result(candidate("a"))]);
    await flush();
    expect(setQuitWarning).toHaveBeenLastCalledWith(null);
  });

  it("stopping leaves what was not started, on every host, and never cuts short the one under way", async () => {
    const here = host(LOCAL_HOST);
    const box = host("cloud:org:box", "cloud");
    startCleanupRun([here.entry, box.entry], [pick("cloud:org:box", "c"), pick(LOCAL_HOST, "a"), pick(LOCAL_HOST, "b")]);
    // Listed in the order the hosts are asked, whatever order they were selected in.
    expect(getCleanupRun()!.items.map((item) => item.name)).toEqual(["a", "b", "c"]);
    stopCleanupRun();
    expect(getCleanupRun()).toMatchObject({ status: "running", stopping: true });
    // The host is told through its signal; the call that is under way is still waited for.
    expect(here.calls[0]!.options.signal?.aborted).toBe(true);
    stopCleanupRun();
    here.calls[0]!.answer([result(candidate("a")), result(candidate("b"), { outcome: "skipped", reason: STOPPED, freedBytes: 0 })]);
    await flush();
    const run = getCleanupRun()!;
    expect(run.status).toBe("done");
    expect(run.outcomes.map((outcome) => `${outcome.outcome} ${outcome.reason ?? ""}`.trim())).toEqual(["removed", `skipped ${STOPPED}`, `skipped ${STOPPED}`]);
    expect(box.calls).toHaveLength(0);
    expect(summarize(run)).toMatchObject({ removed: 1, skipped: 2, problems: 2 });
  });
});
