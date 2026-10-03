import { describe, expect, it } from "vitest";
import type { RpcWireRequest } from "./rpc";
import { WorkspaceRpcClient, WorkspaceRpcError, type WorkspaceConnectionState, type WorkspaceTransport } from "./workspace";
import { RemoteGit, dispositionFacts, gitErrorMessage, hasUnpublishedWork, listRepositories, runtimeResources } from "./workspaceGit";

const connected: WorkspaceConnectionState = {
  state: "connected",
  runtimeGeneration: 1,
  runtimeEpoch: "e1",
  runtimeVersion: "0.3.0",
  capabilities: ["git/1", "lifecycle/1"],
  authority: "manage",
};

type Handler = (params: Record<string, unknown>) => unknown;

/** A runtime answering from handlers; a handler returning `HOLD` never answers that frame. */
const HOLD = Symbol("hold");

class FakeRuntime implements WorkspaceTransport {
  sent: RpcWireRequest[] = [];
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();

  constructor(private handlers: Record<string, Handler>) {}

  send(frame: RpcWireRequest): boolean {
    this.sent.push(frame);
    queueMicrotask(() => {
      try {
        const result = this.handlers[frame.method]?.((frame.params ?? {}) as Record<string, unknown>);
        if (result === HOLD) return;
        this.deliver({ id: frame.id, ok: true, result: result ?? {} });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "internal";
        this.deliver({ id: frame.id, ok: false, error: { code, message: (error as Error).message } });
      }
    });
    return true;
  }
  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  close() {}
  setState(state: WorkspaceConnectionState) {
    for (const listener of this.states) listener(state);
  }
  deliver(message: unknown) {
    for (const listener of this.messages) listener(message);
  }
  calls(method: string) {
    return this.sent.filter((frame) => frame.method === method).map((frame) => frame.params as Record<string, unknown>);
  }
}

function connect(handlers: Record<string, Handler>) {
  const runtime = new FakeRuntime(handlers);
  const client = new WorkspaceRpcClient(runtime);
  runtime.setState(connected);
  return { runtime, client };
}

const refusal = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("workspace git", () => {
  it("names the repository on every call and sends the author with a commit, never credentials", async () => {
    const { runtime, client } = connect({
      "git.repositories": () => ({ repositories: [{ repo: "app" }, { repo: "libs/core" }] }),
      "git.status": () => ({ repository: true, repo: "app", files: [] }),
      "git.commit": () => ({ commit: "abc", branch: "main" }),
      "git.push": () => ({ repo: "app", branch: "main", head: "abc", pushed: true, reconciled: false }),
    });
    expect((await listRepositories(client)).map((repo) => repo.repo)).toEqual(["app", "libs/core"]);
    const git = new RemoteGit(client, "libs/core");
    await git.status();
    await git.commit("message", { name: "Ada", email: "ada@example.com" });
    await git.push();
    expect(runtime.calls("git.status")[0]).toEqual({ repo: "libs/core" });
    const commit = runtime.calls("git.commit")[0]!;
    expect(commit).toMatchObject({ repo: "libs/core", message: "message", author: { name: "Ada", email: "ada@example.com" } });
    expect(typeof commit.clientRequestId).toBe("string");
    expect(Object.keys(commit).sort()).toEqual(["author", "clientRequestId", "message", "repo"]);
    expect(runtime.calls("git.push")[0]).toMatchObject({ repo: "libs/core" });
  });

  it("resends a push whose answer was lost with the same request id, so the runtime answers it once", async () => {
    let pushes = 0;
    const { runtime, client } = connect({
      "git.push": () => (++pushes === 1 ? HOLD : { repo: "app", branch: "main", head: "abc", pushed: true, reconciled: false }),
    });
    const pushed = new RemoteGit(client, "app").push();
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.setState({ state: "reconnecting", attempt: 1 });
    runtime.setState(connected);
    expect(await pushed).toMatchObject({ pushed: true });
    const ids = runtime.calls("git.push").map((params) => params.clientRequestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("chooses a base for a pull request only when one is given", async () => {
    const { runtime, client } = connect({
      "git.prCreate": (params) => ({ repo: "app", pr: { number: 3, base: params.base ?? "main" }, created: true, existing: false }),
    });
    const git = new RemoteGit(client, "app");
    await git.createPr({ title: "T", body: "", base: "develop", draft: true });
    await git.createPr({ title: "T", body: "", base: null, draft: false });
    expect(runtime.calls("git.prCreate")[0]).toMatchObject({ base: "develop", draft: true });
    expect(runtime.calls("git.prCreate")[1]).not.toHaveProperty("base");
  });

  it("reads disposition facts, and reports none from a runtime without them", async () => {
    const facts = {
      v: 1,
      repositories: [
        { path: "app", branch: "f", dirtyFiles: 0, untrackedFiles: 0, unpushedCommits: 0, hasUpstream: true, localOnlyCommits: 0, openPullRequests: [] },
        { path: "lib", branch: "x", dirtyFiles: 0, untrackedFiles: 0, unpushedCommits: null, hasUpstream: false, localOnlyCommits: 2, openPullRequests: null },
      ],
      activeTasks: [],
      runningProcesses: 0,
      observedAt: 1,
    };
    const { client } = connect({ "lifecycle.dispositionFacts": () => facts });
    const read = await dispositionFacts(client);
    expect(read?.repositories.map(hasUnpublishedWork)).toEqual([false, true]);
    const old = connect({
      "lifecycle.dispositionFacts": () => {
        throw refusal("method_not_found");
      },
    });
    expect(await dispositionFacts(old.client)).toBeNull();
  });

  it("reads the machine's free memory and disk, or null from a runtime that does not report them", async () => {
    const resources = { v: 1, memory: { totalBytes: 4096, availableBytes: 1024 }, storage: { totalBytes: 100, availableBytes: 5, totalInodes: 10, availableInodes: 9 }, observedAt: 1 };
    const { client, runtime } = connect({ "lifecycle.resources": () => resources });
    expect(await runtimeResources(client)).toEqual(resources);
    // A read: no clientRequestId, nothing to replay.
    expect(runtime.sent.at(-1)).toMatchObject({ method: "lifecycle.resources" });
    const old = connect({
      "lifecycle.resources": () => {
        throw refusal("method_not_found");
      },
    });
    expect(await runtimeResources(old.client)).toBeNull();
  });

  it("explains refusals by code", () => {
    const error = (code: string, message = code) => new WorkspaceRpcError(code, message, "git.push");
    expect(gitErrorMessage(error("auth_failed"))).toMatch(/GitHub refused/);
    expect(gitErrorMessage(error("outcome_unknown"))).toMatch(/checks the remote first/);
    expect(gitErrorMessage(error("conflict", "push main: rejected"))).toMatch(/Pull .* first; nothing was forced/);
    expect(gitErrorMessage(error("ambiguous_repository"))).toMatch(/Choose one/);
    expect(gitErrorMessage(new Error("Workspace connection dropped"))).toMatch(/unknown whether/);
  });
});
