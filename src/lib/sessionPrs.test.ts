import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteGit } from "@terminalx/portable/workspaceGit";
import { WorkspaceRpcError, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { PrAssociation, PullRequest } from "@/lib/api";
import { cloudGitSource, localGitSource } from "@/lib/gitSource";
import { sessionPrs } from "./sessionPrs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const a: PullRequest = {
  number: 1, title: "Initial work", url: "https://github.com/acme/widgets/pull/1", state: "MERGED", isDraft: false,
  base: "main", head: "initial", additions: 2, deletions: 0, mergeable: "UNKNOWN", reviewDecision: null, checks: [], body: "", author: "author",
};
const b: PullRequest = { ...a, number: 2, title: "Follow-up", url: "https://github.com/acme/widgets/pull/2", state: "OPEN", head: "followup", checks: [{ name: "build", state: "pending" }] };
const reference = (pr: PullRequest): PrAssociation => ({ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: "/fixture" } });

beforeEach(() => { invoke.mockReset(); });

describe("session PR transport", () => {
  it.each(["MERGED", "CLOSED"] as const)("keeps %s history and an open follow-up on the same branch, deduplicating identities", async (state) => {
    const history = { ...a, state };
    const followup = { ...b, head: a.head };
    invoke.mockImplementation(async (command) => {
      if (command === "pr_associations") return [reference(history), reference(followup)];
      if (command === "pr_list") return [history, followup, history];
      throw Error(command);
    });
    const { rows } = await sessionPrs(localGitSource("/fixture"), "session", a.head);
    expect(rows.map((row) => row.pr?.number)).toEqual([2, 1]);
    expect(rows[1]?.pr?.state).toBe(state);
    expect(invoke).toHaveBeenCalledWith("pr_associations", { sessionKey: "session", additions: [] });
  });

  it("refreshes retained different-branch PRs by URL after reload, including identical numbers in another repository", async () => {
    const other = { ...b, number: 1, url: "https://github.com/acme/other/pull/1" };
    invoke.mockImplementation(async (command, args) => {
      if (command === "pr_associations") return [reference(a), reference(b), reference(other)];
      if (command === "pr_list") return [b];
      if (command === "pr_details") return args.url === a.url ? a : other;
      if (command === "pr_ready" || command === "pr_merge") return;
      throw Error(command);
    });
    const source = localGitSource("/new-checkout");
    const { rows } = await sessionPrs(source, "session", b.head);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.current).map((row) => row.pr?.number)).toEqual([2]);
    expect(invoke).toHaveBeenCalledWith("pr_details", { cwd: "/new-checkout", number: 1, url: other.url });
    await source.prAccess!(reference(other)).ready();
    await source.prAccess!(reference(other)).merge("squash");
    expect(invoke).toHaveBeenCalledWith("pr_ready", { cwd: "/new-checkout", number: 1, url: other.url });
    expect(invoke).toHaveBeenCalledWith("pr_merge", { cwd: "/new-checkout", number: 1, url: other.url, method: "squash" });
  });

  it("refreshes healthy PRs even if discovery or another PR fails, retaining an unavailable identity", async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === "pr_associations") return [reference(a), reference(b)];
      if (command === "pr_list") throw Error("Discovery offline");
      if (command === "pr_details" && args.url === a.url) throw Error("History unavailable");
      if (command === "pr_details") return { ...b, checks: [{ name: "build", state: "success" }] };
      throw Error(command);
    });
    const result = await sessionPrs(localGitSource("/fixture"), "session", "followup");
    expect(result.error).toContain("Discovery offline");
    expect(result.rows.find((row) => row.identity === a.url)?.error).toContain("History unavailable");
    expect(result.rows.find((row) => row.identity === b.url)?.pr?.checks[0]?.state).toBe("success");
  });

  it("uses cloud repository transport for saved identities without importing other PRs on historical branches", async () => {
    const saved: PrAssociation = { ...reference(a), scope: { kind: "cloud", workspace: "cloud:org:workspace", repo: "old-repo" } };
    invoke.mockImplementation(async (command) => {
      if (command === "pr_associations") return [saved, { ...reference(b), scope: { kind: "cloud", workspace: "cloud:org:workspace", repo: "new-repo" } }];
      throw Error(`Cloud PRs must not use native gh: ${command}`);
    });
    const call = vi.fn(async (method: string, args: { repo: string }) => method === "git.prAssociations" ? { associations: [] } : ({ prs: args.repo === "old-repo" ? [a, { ...b, number: 99, url: "https://github.com/acme/widgets/pull/99", head: a.head }] : [b] }));
    const mutate = vi.fn(async () => ({}));
    const remote = new RemoteGit({ call, mutate } as unknown as WorkspaceRpcClient, "new-repo");
    const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote, canWrite: true });
    const { rows } = await sessionPrs(source, "cloud:org:workspace:session", "followup");
    expect(rows.map((row) => row.identity)).toEqual([b.url, a.url]);
    expect(call).toHaveBeenCalledWith("git.prs", expect.objectContaining({ repo: "old-repo", branch: "initial", number: 1 }));
    await source.prAccess!(saved).ready();
    expect(mutate).toHaveBeenCalledWith("git.prReady", expect.objectContaining({ repo: "old-repo", number: 1 }));
  });

  it("persists local PR creation with explicit session identity", async () => {
    invoke.mockResolvedValue(b.url);
    await localGitSource("/fixture").createPr({ title: "Follow-up", body: "", base: "main", draft: false, sessionId: "author" });
    expect(invoke).toHaveBeenCalledWith("pr_create", { cwd: "/fixture", title: "Follow-up", body: "", base: "main", draft: false, sessionId: "author" });
  });
});

it("saves cloud creation immediately, before a later branch change or refresh", async () => {
  invoke.mockResolvedValue([]);
  const mutate = vi.fn(async () => ({ pr: b, created: true, existing: false }));
  const remote = new RemoteGit({ mutate } as unknown as WorkspaceRpcClient, "repo/path");
  const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote, canWrite: true });
  await source.createPr({ title: b.title, body: "", base: "main", draft: false, sessionId: "author" });
  expect(invoke).toHaveBeenCalledWith("pr_associations", { sessionKey: "author", additions: [{ url: b.url, number: b.number, head: b.head, scope: { kind: "cloud", workspace: "cloud:org:workspace", repo: "repo/path" } }] });
});

it.each([a.head, b.head])("does not import another session’s PR from checkout branch %s", async (branch) => {
  invoke.mockImplementation(async (command) => {
    if (command === "pr_associations") return [reference(a)];
    if (command === "pr_list") return [{ ...b, head: branch }];
    if (command === "pr_details") return a;
    throw Error(command);
  });
  const { rows } = await sessionPrs(localGitSource("/fixture"), "author", branch);
  expect(rows.map((row) => [row.pr?.number, row.current])).toEqual([[1, false]]);
  expect(invoke).toHaveBeenCalledWith("pr_associations", { sessionKey: "author", additions: [] });
});

it("includes associations recorded concurrently with branch discovery", async () => {
  invoke.mockImplementation(async (command) => {
    if (command === "pr_associations") return [reference(a), reference(b)];
    if (command === "pr_list") return [a];
    if (command === "pr_details") return b;
    throw Error(command);
  });
  const { rows } = await sessionPrs(localGitSource("/fixture"), "author", a.head);
  expect(rows.map((row) => row.pr?.number)).toEqual([2, 1]);
});

it("does not persist a superseded discovery into the previously selected session", async () => {
  let finish!: (prs: PullRequest[]) => void;
  const delayed = new Promise<PullRequest[]>((resolve) => { finish = resolve; });
  let current = true;
  invoke.mockImplementation(async (command) => {
    if (command === "pr_associations") return [];
    if (command === "pr_list") return delayed;
    throw Error(command);
  });
  const request = sessionPrs(localGitSource("/fixture"), "previous-session", a.head, () => current);
  current = false;
  finish([a]);
  expect((await request).rows).toEqual([]);
  expect(invoke.mock.calls.filter(([command, args]) => command === "pr_associations" && args.additions.length)).toHaveLength(0);
});

it("recovers runtime agent and pipeline PRs on a fresh desktop, retaining each cloud repository", async () => {
  const other = { ...a, url: "https://github.com/acme/other/pull/1" };
  const refs = [{ ...reference(b), repo: "app" }, { ...reference(other), repo: "libs/other" }];
  const sessionId = "cloud:org:workspace:author";
  let saved: PrAssociation[] = [];
  invoke.mockImplementation(async (command, args) => {
    if (command !== "pr_associations") throw Error(`Unexpected native PR access: ${command}`);
    saved = [...new Map([...saved, ...args.additions].map((entry) => [entry.url, entry])).values()] as PrAssociation[];
    return saved;
  });
  const call = vi.fn(async (method: string, args: { sessionId?: string; repo?: string; number?: number }) => {
    if (method === "git.prAssociations") {
      expect(args.sessionId).toBe("author");
      return { associations: refs };
    }
    if (method === "git.prs") return { prs: args.number ? [args.repo === "app" ? b : other] : [] };
    throw Error(method);
  });
  const source = () => cloudGitSource({ workspaceKey: "cloud:org:workspace", remote: new RemoteGit({ call } as unknown as WorkspaceRpcClient, "app"), canWrite: true });
  for (let restart = 0; restart < 2; restart++) {
    saved = []; // A new desktop has none of the runtime's creation evidence.
    const { rows } = await sessionPrs(source(), sessionId, "next-branch");
    expect(rows.map((row) => row.identity)).toEqual([b.url, other.url]);
    expect(saved.map((entry) => entry.scope)).toEqual([
      { kind: "cloud", workspace: "cloud:org:workspace", repo: "app" },
      { kind: "cloud", workspace: "cloud:org:workspace", repo: "libs/other" },
    ]);
  }
  const requests = call.mock.calls.length;
  await expect(sessionPrs(source(), "cloud:other:workspace:author", null)).rejects.toThrow("different cloud workspace");
  expect(call.mock.calls).toHaveLength(requests);
});

it("does not offer a fetching landed check to a read-only cloud viewer", () => {
  const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote: new RemoteGit({} as WorkspaceRpcClient, "app"), canWrite: false });
  expect(source.landed).toBeUndefined();
});


it("keeps legacy runtime branch discovery and cached history without adopting branch PRs", async () => {
  const sessionId = "cloud:org:workspace:author";
  const cached = { ...reference(a), scope: { kind: "cloud", workspace: "cloud:org:workspace", repo: "history" } };
  invoke.mockResolvedValue([cached]);
  const call = vi.fn(async (method: string, params: { repo: string }) => {
    if (method === "git.prAssociations" || method === "git.prLanded") throw new WorkspaceRpcError("method_not_found", "old runtime", method);
    if (method === "git.prs") return { prs: params.repo === "history" ? [a] : [b] };
    throw Error(method);
  });
  const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote: new RemoteGit({ call } as unknown as WorkspaceRpcClient, "app"), canWrite: true });
  for (let refresh = 0; refresh < 2; refresh++) {
    const result = await sessionPrs(source, sessionId, b.head);
    expect(result.rows.map((row) => row.pr?.number)).toEqual([2, 1]);
    expect(result.rows[0]?.association).toBeUndefined();
    expect(result.rows[1]?.association).toEqual(cached);
    expect(result.error).toContain("Update the workspace runtime");
    expect(await source.landed!()).toBeNull();
  }
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledWith("pr_associations", { sessionKey: sessionId, additions: [] });
});

it.each(["permission_denied", "capability_not_granted", "network_error", "internal_error"])("does not downgrade %s to legacy runtime support", async (code) => {
  const call = vi.fn(async (method: string) => {
    if (method === "git.prs") return { prs: [b] };
    throw new WorkspaceRpcError(code, "failure", method);
  });
  const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote: new RemoteGit({ call } as unknown as WorkspaceRpcClient, "app"), canWrite: true });
  await expect(sessionPrs(source, "cloud:org:workspace:author", b.head)).rejects.toMatchObject({ code });
  await expect(source.landed!()).rejects.toMatchObject({ code });
  expect(invoke).not.toHaveBeenCalled();
});
