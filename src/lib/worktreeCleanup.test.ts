import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupCandidate, CleanupProject, CleanupRemoveItem, CleanupResult, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CloudCatalogState } from "@/lib/cloudCatalog";

const local = {
  scan: vi.fn(),
  size: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
};

vi.mock("@/lib/api", () => ({
  api: {
    worktreeCleanupScan: () => local.scan(),
    worktreeCleanupSize: (job: string, projectPath: string, path: string) => local.size(job, projectPath, path),
    worktreeCleanupCancelSizes: (prefix: string) => local.cancel(prefix),
    worktreeCleanupRemove: (items: CleanupRemoveItem[]) => local.remove(items),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/lib/cloudConnections", () => ({ connectedCloudClient: () => null }));
vi.mock("@/lib/cloudSessions", () => ({ managesOf: (client: { manage?: boolean }) => client.manage !== false }));

import { LOCAL_HOST, candidateKey, cleanupHosts, estimateSizes, runCleanup, scanHosts, selectable, totals, type CleanupSelection } from "./worktreeCleanup";

function candidate(projectPath: string, name: string, verdict: CleanupCandidate["verdict"] = "eligible"): CleanupCandidate {
  return {
    projectPath,
    path: `${projectPath}/.raccoon/worktrees/${name}`,
    name,
    branch: `raccoon/${name}`,
    head: "abc",
    managed: true,
    verdict,
    reason: verdict === "eligible" ? null : "why",
    lastActivity: null,
    sessions: [],
    disposable: [],
    ignoredData: verdict === "ignoredData" ? [".env"] : [],
    token: `token-${name}`,
  };
}

function project(path: string, ...candidates: CleanupCandidate[]): CleanupProject {
  return { path, name: path.split("/").pop()!, note: null, candidates };
}

function removed(item: CleanupRemoveItem, freedBytes = 100): CleanupResult {
  return { projectPath: item.projectPath, path: item.path, outcome: "removed", reason: null, freedBytes, keptBranch: "b", sessionsKept: [], sessionsDeleted: [] };
}

/** A cloud workspace's client, as far as the clean-up uses it. */
function runtime(options: { capabilities?: string[]; manage?: boolean; projects?: CleanupProject[] } = {}) {
  const client = {
    manage: options.manage,
    hasCapability: (capability: string) => (options.capabilities ?? ["cleanup/1"]).includes(capability),
    scanCleanup: vi.fn(async () => options.projects ?? []),
    cleanupSize: vi.fn(async () => 2_000 as number | null),
    cancelCleanupSizes: vi.fn(async () => undefined),
    removeCleanup: vi.fn(async (items: CleanupRemoveItem[]) => items.map((item) => removed(item))),
  };
  return client;
}

function catalog(...workspaces: { id: string; name: string; state?: string }[]): CloudCatalogState {
  return {
    owner: "a@example.com",
    revision: null,
    loaded: true,
    orgs: { org: { orgId: "org", workspaces: workspaces.map((workspace) => ({ workspace: { orgId: "org", state: "ready", ...workspace }, latestOperation: null })), sessions: {} } },
    createMemory: {},
    notices: [],
  } as unknown as CloudCatalogState;
}

const asClients = (clients: Record<string, ReturnType<typeof runtime> | null>) => (key: string) => (clients[key] ?? null) as unknown as WorkspaceRpcClient | null;

describe("worktree clean-up across hosts", () => {
  beforeEach(() => {
    for (const mock of Object.values(local)) mock.mockReset();
  });

  it("lists this computer and every live cloud workspace, and says why one cannot be asked", () => {
    const hosts = cleanupHosts(
      catalog({ id: "ready", name: "Ready" }, { id: "asleep", name: "Asleep" }, { id: "old", name: "Old" }, { id: "viewer", name: "Viewer" }, { id: "gone", name: "Gone", state: "archived" }),
      asClients({ "cloud:org:ready": runtime(), "cloud:org:old": runtime({ capabilities: ["fs/1"] }), "cloud:org:viewer": runtime({ manage: false }) }),
    );
    expect(hosts.map((host) => host.name)).toEqual(["This computer", "Asleep", "Old", "Ready", "Viewer"]);
    const why = Object.fromEntries(hosts.map((host) => [host.name, host.unavailable]));
    expect(why["This computer"]).toBeNull();
    expect(why.Ready).toBeNull();
    expect(why.Asleep).toMatch(/Not connected.*never assumed clean/);
    expect(why.Old).toMatch(/older than this clean-up/);
    expect(why.Viewer).toMatch(/manager access/);
  });

  it("scans hosts side by side; an unreachable or failing one is unverifiable and offers nothing", async () => {
    const failing = runtime();
    failing.scanCleanup.mockRejectedValue(new Error("RPC timed out: cleanup.scan"));
    const ready = runtime({ projects: [project("/workspace/repo", candidate("/workspace/repo", "a"))] });
    const hosts = cleanupHosts(catalog({ id: "ready", name: "Ready" }, { id: "asleep", name: "Asleep" }, { id: "failing", name: "Failing" }), asClients({ "cloud:org:ready": ready, "cloud:org:failing": failing }));
    local.scan.mockResolvedValue([project("/Users/me/repo", candidate("/Users/me/repo", "a"))]);
    const scans = await scanHosts(hosts);
    const by = Object.fromEntries(scans.map((scan) => [scan.host.name, scan]));
    expect(by["This computer"]!.projects).toHaveLength(1);
    expect(by.Ready!.projects).toHaveLength(1);
    expect(by.Asleep).toMatchObject({ projects: null, error: expect.stringMatching(/Not connected/) });
    expect(by.Failing).toMatchObject({ projects: null, error: expect.stringMatching(/could not be scanned.*timed out/) });
  });

  it("sends a worktree back only to the host that reported it, even when two hosts report the same path", async () => {
    const shared = candidate("/home/dev/repo", "same-name");
    const one = runtime({ projects: [project("/home/dev/repo", shared)] });
    const two = runtime({ projects: [project("/home/dev/repo", { ...shared, token: "token-two" })] });
    const hosts = cleanupHosts(catalog({ id: "one", name: "One" }, { id: "two", name: "Two" }), asClients({ "cloud:org:one": one, "cloud:org:two": two }));
    expect(candidateKey("cloud:org:one", shared.path)).not.toBe(candidateKey("cloud:org:two", shared.path));

    const outcomes = await runCleanup(hosts, [{ hostId: "cloud:org:two", candidate: { ...shared, token: "token-two" }, deleteSessions: false }]);
    expect(two.removeCleanup).toHaveBeenCalledWith([{ projectPath: "/home/dev/repo", path: shared.path, token: "token-two", deleteSessions: false, acceptIgnored: false }]);
    expect(one.removeCleanup).not.toHaveBeenCalled();
    // A VM path is never handed to this computer.
    expect(local.remove).not.toHaveBeenCalled();
    expect(outcomes).toEqual([expect.objectContaining({ hostId: "cloud:org:two", outcome: "removed" })]);
  });

  it("only passes acceptIgnored for a worktree that was shown with ignored local files", async () => {
    local.remove.mockImplementation(async (items: CleanupRemoveItem[]) => items.map((item) => removed(item)));
    const hosts = cleanupHosts(catalog());
    const plain = candidate("/p", "plain");
    const withEnv = candidate("/p", "with-env", "ignoredData");
    expect(selectable(withEnv, false)).toBe(false);
    expect(selectable(withEnv, true)).toBe(true);
    expect(selectable(candidate("/p", "main", "protected"), true)).toBe(false);
    expect(selectable(candidate("/p", "busy", "active"), true)).toBe(false);
    await runCleanup(hosts, [
      { hostId: LOCAL_HOST, candidate: plain, deleteSessions: false },
      { hostId: LOCAL_HOST, candidate: withEnv, deleteSessions: true },
    ]);
    expect(local.remove).toHaveBeenCalledWith([
      { projectPath: "/p", path: plain.path, token: "token-plain", deleteSessions: false, acceptIgnored: false },
      { projectPath: "/p", path: withEnv.path, token: "token-with-env", deleteSessions: true, acceptIgnored: true },
    ]);
  });

  it("a host that drops mid-way leaves one unknown and the rest skipped, and the other hosts still finish", async () => {
    const flaky = runtime();
    flaky.removeCleanup
      .mockImplementationOnce(async (items: CleanupRemoveItem[]) => items.map((item) => removed(item, 500)))
      .mockRejectedValueOnce(new Error("Workspace runtime did not reconnect"));
    const steady = runtime();
    const hosts = cleanupHosts(catalog({ id: "flaky", name: "Flaky" }, { id: "steady", name: "Steady" }), asClients({ "cloud:org:flaky": flaky, "cloud:org:steady": steady }));
    local.remove.mockResolvedValue([{ ...removed({ projectPath: "/p", path: "/p/.raccoon/worktrees/l", token: "" }, 1_000), outcome: "skipped", reason: "It changed since it was reviewed, so it was left alone.", freedBytes: 0 }]);
    const pick = (hostId: string, name: string, root = "/w"): CleanupSelection => ({ hostId, candidate: candidate(root, name), deleteSessions: false });
    const progress: number[] = [];
    const outcomes = await runCleanup(
      hosts,
      [pick("cloud:org:flaky", "a"), pick("cloud:org:flaky", "b"), pick("cloud:org:flaky", "c"), pick("cloud:org:steady", "d"), pick(LOCAL_HOST, "l", "/p")],
      (done) => progress.push(done.length),
    );
    const by = Object.fromEntries(outcomes.map((outcome) => [outcome.path.split("/").pop(), outcome]));
    expect(by.a).toMatchObject({ outcome: "removed", freedBytes: 500 });
    expect(by.b).toMatchObject({ outcome: "unknown", reason: expect.stringMatching(/may or may not have been removed/) });
    expect(by.c).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/Not attempted/) });
    expect(by.d).toMatchObject({ outcome: "removed" });
    expect(by.l).toMatchObject({ outcome: "skipped" });
    // The third was never sent to the host that stopped answering.
    expect(flaky.removeCleanup).toHaveBeenCalledTimes(2);
    expect(totals(outcomes)).toEqual({ removed: 2, skipped: 2, failed: 1, freedBytes: 600 });
    expect(progress.at(-1)).toBe(5);

    // Tried again once it is back: the host says what it finds, and that is what is reported.
    flaky.removeCleanup.mockImplementation(async (items: CleanupRemoveItem[]) => items.map((item) => ({ ...removed(item, 0), outcome: "alreadyRemoved" as const, reason: "It was already removed." })));
    const retry = await runCleanup(hosts, [pick("cloud:org:flaky", "b")]);
    expect(retry).toEqual([expect.objectContaining({ outcome: "alreadyRemoved", freedBytes: 0 })]);
    expect(totals(retry).removed).toBe(1);
  });

  it("a host that is already gone when asked was never sent anything, and says so", async () => {
    const clients: Record<string, ReturnType<typeof runtime> | null> = { "cloud:org:box": runtime() };
    const hosts = cleanupHosts(catalog({ id: "box", name: "Box" }), asClients(clients));
    clients["cloud:org:box"] = null;
    const outcomes = await runCleanup(hosts, [
      { hostId: "cloud:org:box", candidate: candidate("/w", "a"), deleteSessions: false },
      { hostId: "cloud:org:box", candidate: candidate("/w", "b"), deleteSessions: false },
    ]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["skipped", "skipped"]);
    expect(outcomes[0]!.reason).toMatch(/Not attempted: Not connected/);
    expect(totals(outcomes)).toEqual({ removed: 0, skipped: 2, failed: 0, freedBytes: 0 });
  });

  it("an answer that leaves a worktree out is not taken as success", async () => {
    local.remove.mockResolvedValue([]);
    const outcomes = await runCleanup(cleanupHosts(catalog()), [{ hostId: LOCAL_HOST, candidate: candidate("/p", "silent"), deleteSessions: false }]);
    expect(outcomes).toEqual([expect.objectContaining({ outcome: "unknown" })]);
  });

  it("estimates sizes one at a time, skips protected directories, and stops when told to", async () => {
    const pending: ((bytes: number | null) => void)[] = [];
    local.size.mockImplementation(() => new Promise<number | null>((resolve) => pending.push(resolve)));
    local.cancel.mockResolvedValue(undefined);
    const hosts = cleanupHosts(catalog());
    const scans = [{ host: hosts[0]!, error: null, projects: [project("/p", candidate("/p", "main", "protected"), candidate("/p", "a"), candidate("/p", "b", "dirty"), candidate("/p", "c"))] }];
    const sizes: Record<string, number> = {};
    const done = vi.fn();
    const stop = estimateSizes(scans, (key, bytes) => (sizes[key] = bytes), done);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(local.size.mock.calls[0]!.slice(1)).toEqual(["/p", "/p/.raccoon/worktrees/a"]);
    pending[0]!(4_096);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(sizes).toEqual({ [candidateKey(LOCAL_HOST, "/p/.raccoon/worktrees/a")]: 4_096 });

    stop();
    expect(local.cancel).toHaveBeenCalledTimes(1);
    // The one under way comes back cancelled; nothing further is asked for or recorded.
    pending[1]!(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.size).toHaveBeenCalledTimes(2);
    expect(Object.keys(sizes)).toHaveLength(1);
    expect(done).not.toHaveBeenCalled();
    expect(local.remove).not.toHaveBeenCalled();
  });
});
