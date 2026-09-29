// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "@terminalx/portable/workspace";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { CloudGitView } = await import("./CloudGit");

type Handler = (params: Record<string, unknown>) => unknown;

const manage: WorkspaceConnectionState = {
  state: "connected",
  runtimeGeneration: 1,
  runtimeEpoch: "e1",
  runtimeVersion: "0.3.0",
  capabilities: ["git/1", "lifecycle/1"],
  authority: "manage",
};

class FakeRuntime implements WorkspaceTransport {
  sent: RpcWireRequest[] = [];
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();
  constructor(public handlers: Record<string, Handler>) {}
  send(frame: RpcWireRequest): boolean {
    this.sent.push(frame);
    queueMicrotask(() => {
      try {
        const handler = this.handlers[frame.method];
        if (!handler) throw Object.assign(new Error(`no ${frame.method}`), { code: "method_not_found" });
        this.deliver({ id: frame.id, ok: true, result: handler((frame.params ?? {}) as Record<string, unknown>) ?? {} });
      } catch (error) {
        this.deliver({ id: frame.id, ok: false, error: { code: (error as { code?: string }).code ?? "internal", message: (error as Error).message } });
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

const refusal = (code: string, message = code) => Object.assign(new Error(message), { code });

const status = (repo: string, branch = "feature/x") => ({
  repository: true,
  repo,
  branch,
  head: "abc1234def",
  upstream: null,
  ahead: 0,
  behind: 0,
  defaultBranch: "main",
  aheadOfBase: 1,
  dirty: true,
  operation: null,
  conflicted: [],
  files: [],
});

function runtime(overrides: Record<string, Handler> = {}) {
  return new FakeRuntime({
    "git.repositories": () => ({
      repositories: [
        { repo: "app", branch: "feature/x", head: "abc", remote: "https://github.com/o/app.git", defaultBranch: "main" },
        { repo: "libs/core", branch: "main", head: "def", remote: "https://github.com/o/core.git", defaultBranch: "main" },
      ],
    }),
    "git.status": (params) => status(String(params.repo)),
    "git.workingChanges": (params) => ({ repo: params.repo, head: "tree1234", files: [{ path: `${String(params.repo).split("/").pop()}.txt`, status: "modified", additions: 1, deletions: 0 }] }),
    "git.fileContents": () => ({ before: "a\n", after: "b\n" }),
    "git.commit": () => ({ commit: "new", branch: "feature/x" }),
    "git.push": () => ({ repo: "app", branch: "feature/x", head: "abc1234def", pushed: false, reconciled: true }),
    "git.prs": () => ({ branch: "feature/x", prs: [] }),
    "git.branches": () => ({
      branches: [
        { name: "feature/x", current: true, remote: false },
        { name: "origin/main", current: false, remote: true },
        { name: "origin/develop", current: false, remote: true },
      ],
    }),
    "lifecycle.dispositionFacts": () => ({
      v: 1,
      repositories: [
        { path: "app", branch: "feature/x", dirtyFiles: 2, untrackedFiles: 1, unpushedCommits: 1, hasUpstream: true, localOnlyCommits: 1, openPullRequests: [{ number: 4, url: "u", state: "open" }] },
        { path: "libs/core", branch: "main", dirtyFiles: 0, untrackedFiles: 0, unpushedCommits: 0, hasUpstream: true, localOnlyCommits: 0, openPullRequests: [] },
      ],
      activeTasks: [{ sessionId: "s", kind: "agent-turn", startedAt: "t" }],
      runningProcesses: 1,
      observedAt: 1,
    }),
    ...overrides,
  });
}

function mount(fake: FakeRuntime, state: WorkspaceConnectionState = manage) {
  const client = new WorkspaceRpcClient(fake);
  fake.setState(state);
  render(
    <TooltipProvider>
      <CloudGitView workspaceKey="cloud:org-1:ws-1" client={client} state={state} active />
    </TooltipProvider>,
  );
  return client;
}

beforeEach(() => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "git_identity") return { name: "Ada Lovelace", email: "ada@example.com" };
    throw new Error(`unexpected ${command}`);
  });
});

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

describe("Git in a cloud workspace", () => {
  it("never picks one of several repositories by itself, then commits as the person", async () => {
    const fake = runtime();
    mount(fake);
    await screen.findByTestId("cloud-git-choose");
    expect(fake.calls("git.status")).toEqual([]);
    expect(fake.calls("git.workingChanges")).toEqual([]);

    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "libs/core" } });
    await screen.findByText("core.txt");
    expect(fake.calls("git.workingChanges").every((params) => params.repo === "libs/core")).toBe(true);
    await screen.findByText("Committing as Ada Lovelace <ada@example.com>");

    fireEvent.change(screen.getByPlaceholderText("Commit message (⌘⏎ to commit)"), { target: { value: "Fix core" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit/ }));
    await waitFor(() => expect(fake.calls("git.commit")).toHaveLength(1));
    expect(fake.calls("git.commit")[0]).toMatchObject({ repo: "libs/core", message: "Fix core", author: { name: "Ada Lovelace", email: "ada@example.com" } });
  });

  it("says what a reconciled push found, and why a refused one failed", async () => {
    const fake = runtime({ "git.repositories": () => ({ repositories: [{ repo: "app", branch: "feature/x" }] }) });
    mount(fake);
    await screen.findByText("app.txt");
    fireEvent.click(screen.getByRole("button", { name: /Push/ }));
    await screen.findByText(/GitHub already has feature\/x at abc1234; nothing was pushed again/);

    fake.handlers["git.push"] = () => {
      throw refusal("auth_failed", "push feature/x: GitHub refused");
    };
    fireEvent.click(screen.getByRole("button", { name: /Push/ }));
    await screen.findByText(/GitHub refused this workspace's access/);

    fake.handlers["git.push"] = () => {
      throw refusal("conflict", "push feature/x: the remote branch has commits");
    };
    fireEvent.click(screen.getByRole("button", { name: /Push/ }));
    await screen.findByText(/Pull \(or fetch and merge\) first; nothing was forced/);
  });

  it("creates a pull request into the chosen base and links an existing one instead of duplicating it", async () => {
    const fake = runtime({
      "git.repositories": () => ({ repositories: [{ repo: "app", branch: "feature/x" }] }),
      "git.prCreate": () => ({
        repo: "app",
        created: false,
        existing: true,
        pr: { number: 4, title: "Existing", url: "https://github.test/pull/4", state: "OPEN", isDraft: true, base: "develop", head: "feature/x", additions: 1, deletions: 0, mergeable: "CONFLICTING", reviewDecision: null, checks: [], body: "", author: "ada" },
      }),
    });
    mount(fake);
    await screen.findByText("app.txt");
    fireEvent.click(screen.getByRole("radio", { name: "Pull request" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create pull request" }));
    const base = (await screen.findByLabelText("Base branch")) as HTMLSelectElement;
    await waitFor(() => expect([...base.options].map((option) => option.value)).toContain("develop"));
    fireEvent.change(base, { target: { value: "develop" } });
    fireEvent.change(screen.getByPlaceholderText("Title"), { target: { value: "Add x" } });
    fireEvent.click(screen.getByLabelText(/Draft/));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText(/#4 for this branch already exists; it is linked below, not duplicated/);
    expect(fake.calls("git.prCreate")[0]).toMatchObject({ repo: "app", title: "Add x", base: "develop", draft: true });
  });

  it("shows unpublished work before archive or delete, and gives a participant no commit box", async () => {
    const fake = runtime({ "git.repositories": () => ({ repositories: [{ repo: "app", branch: "feature/x" }] }) });
    mount(fake, { ...manage, authority: "participate" });
    const repo = await screen.findByTestId("cloud-unpublished-repo");
    expect(repo.textContent).toContain("app · feature/x");
    expect(repo.textContent).toContain("2 uncommitted files (1 untracked)");
    expect(repo.textContent).toContain("1 unpushed commit");
    expect(repo.textContent).toContain("PR #4 open");
    expect(screen.getAllByTestId("cloud-unpublished-repo")).toHaveLength(1);
    expect(screen.getByText("1 agent turn is running.")).toBeTruthy();
    await screen.findByText("app.txt");
    expect(screen.queryByPlaceholderText("Commit message (⌘⏎ to commit)")).toBeNull();
  });
});
