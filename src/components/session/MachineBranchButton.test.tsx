import { act, cleanup, fireEvent, render as renderView, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PullRequest } from "@/lib/api";
import { closeWorkspaceRemove, useDialogs } from "@/lib/dialogs";
import type { GitSource, SourceStatus } from "@/lib/gitSource";
import type { SessionBackend } from "@/lib/sessionBackend";
import type { FileSource } from "@/lib/workspaceFiles";
import type { RemovableWorkspace } from "@/lib/workspaceRemoval";
import type { SessionEntry, TabEntry } from "@/types/session";
import { WorkspaceRpcError } from "@terminalx/portable/workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
const { MACHINE_STATUS_EVERY_MS, MachineBranchButton, MachineDiffSize, useMachineBranch } = await import("./MachineBranchButton");

const HEAD = "1".repeat(40);
const MOVED = "2".repeat(40);

let status: SourceStatus;
let prs: PullRequest[];
let prsFail: Error | null;
let canWrite: boolean;
let watchers: ((paths: string[] | null) => void)[];
let git: Record<string, ReturnType<typeof vi.fn>>;
let send: ReturnType<typeof vi.fn>;

function pr(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7, title: "Read markers", url: "https://github.com/octo/app/pull/7", state: "OPEN", isDraft: false, base: "main", head: "feature",
    headSha: HEAD, additions: 142, deletions: 9, mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: "APPROVED",
    checks: [{ name: "test", state: "success" }], body: "", author: "octocat", ...patch,
  } as PullRequest;
}

function makeSource(): GitSource {
  git = {
    workStatus: vi.fn(async () => ({ ...status })),
    fetch: vi.fn(async () => null),
    prs: vi.fn(async () => { if (prsFail) throw prsFail; return prs; }),
    branchBase: vi.fn(async () => ({ aheadOfBase: status.aheadOfBase, head: status.head })),
    branchDiffSize: vi.fn(async () => ({ additions: 142, deletions: 9, head: status.head })),
    commitForPush: vi.fn(async () => { status = { ...status, dirty: false, ahead: 1, head: MOVED }; return MOVED; }),
    push: vi.fn(async () => { status = { ...status, ahead: 0, upstream: "origin/feature" }; return null; }),
    pull: vi.fn(async () => null),
    createPr: vi.fn(async () => { prs = [pr()]; return null; }),
    createPrWithPush: vi.fn(async () => {
      status = { ...status, ahead: 0, upstream: "origin/feature" };
      prs = [pr()];
      return null;
    }),
    readyPr: vi.fn(async () => undefined),
    mergePr: vi.fn(async () => { prs = [pr({ state: "MERGED" })]; }),
    conversation: vi.fn(() => ({ read: async () => ({ mergeMethods: { default: "REBASE", merge: true, squash: true, rebase: true } }) })),
  };
  return { key: "machine:m1:p1|.", cloud: true, canWrite, errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)), ...git } as unknown as GitSource;
}

const fileSource = { watch: (listener: (paths: string[] | null) => void) => { watchers.push(listener); return () => {}; } } as unknown as FileSource;

function Harness({ tabs, source, baseRef = null, workspace }: { tabs: TabEntry[]; source?: GitSource; baseRef?: string | null; workspace?: RemovableWorkspace }) {
  const session = { id: "machine:m1:p1:s1", cwd: "/work/app", projectPath: "", title: "Add read markers to the catalog feed", tabs } as unknown as SessionEntry;
  const branch = useMachineBranch({
    session, machineName: "Mac mini", backend: { send } as unknown as SessionBackend, gitSource: source, fileSource,
    remote: "git@github.com:octo/app.git", connected: true, tabId: "t1", baseRef,
  });
  return <div>
    <span data-testid="current-branch">{branch.currentBranch}</span>
    <span data-testid="pr-count">{branch.prCount}</span>
    <MachineDiffSize branch={branch} />
    <MachineBranchButton branch={branch} workspace={workspace} />
  </div>;
}

const idle = [{ id: "t1", status: "completed" }] as TabEntry[];
function render(tabs: TabEntry[] = idle, baseRef: string | null = null) {
  const source = makeSource();
  const view = renderView(<TooltipProvider delayDuration={0}><Harness tabs={tabs} source={source} baseRef={baseRef} /></TooltipProvider>);
  return {
    ...view,
    retab: (next: TabEntry[]) => view.rerender(<TooltipProvider delayDuration={0}><Harness tabs={next} source={source} baseRef={baseRef} /></TooltipProvider>),
  };
}
beforeEach(() => {
  status = { isRepo: true, dirty: false, branch: "feature", upstream: null, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 2, head: HEAD, conflicted: [], operation: null };
  prs = [];
  prsFail = null;
  canWrite = true;
  watchers = [];
  send = vi.fn(async () => ({ accepted: true }));
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); closeWorkspaceRemove(); vi.useRealTimers(); });

describe("machine session header Git step (PRO-404, 21.08)", () => {
  it("opens checked removal for the machine worktree even without a Git status", async () => {
    const workspace = {
      projectPath: "machine:m1:p1", path: "/work/app/feature", name: "feature",
      host: { key: "machine:m1|s1", disposition: vi.fn(), remove: vi.fn(), turnRunning: () => false },
    };
    const { result } = renderHook(useDialogs);
    const view = renderView(<TooltipProvider><Harness tabs={idle} workspace={workspace} /></TooltipProvider>);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Git actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete workspace…" }));
    expect(result.current.workspaceRemove).toEqual({ ...workspace, mode: "delete" });
    expect(workspace.host.remove).not.toHaveBeenCalled();

    view.rerender(<TooltipProvider><Harness tabs={idle} /></TooltipProvider>);
    expect(screen.queryByRole("button", { name: "Git actions" })).toBeNull();
  });

  it("compares against the selected base and opens a PR for an already pushed branch", async () => {
    status = { ...status, upstream: "origin/feature", ahead: 0 };
    render(idle, "origin/release/2.x");
    expect((await screen.findByTestId("machine-diff-size")).textContent).toContain("+142 −9");
    expect(git.branchDiffSize).toHaveBeenCalledWith("release/2.x");
    fireEvent.click(await screen.findByRole("button", { name: "Create PR" }));
    const dialog = await screen.findByRole("dialog");
    expect((dialog).textContent).toContain("Runs on Mac mini with its Git sign-in.");
    expect(dialog.textContent).toContain("open a pull request into release/2.x");
    expect(((within(dialog).getByLabelText("PR title")) as HTMLInputElement).value).toBe("Add read markers to the catalog feed");
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Adds markers." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(git.createPr).toHaveBeenCalledWith({ title: "Add read markers to the catalog feed", body: "Adds markers.", base: "release/2.x", draft: false, sessionId: "machine:m1:p1:s1", branch: "feature" }));
    // Already on the remote: nothing is pushed again.
    expect(git.push).not.toHaveBeenCalled();
    // The PR state follows: the new PR is read back and is ready to merge.
    expect((await screen.findByRole("button", { name: "Merge" })).hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("pr-count").textContent).toBe("1");
  });

  it("keeps Create PR available for a release branch when its worktree diff times out", async () => {
    status = { ...status, upstream: "origin/feature" };
    render(idle, "release/2.x");
    git.branchDiffSize.mockRejectedValue(new Error("timeout"));
    expect(await screen.findByRole("button", { name: "Create PR" })).toBeTruthy();
    expect(git.branchBase).toHaveBeenCalledWith("release/2.x");
    expect(screen.queryByTestId("machine-diff-size")).toBeNull();
  });

  it("falls back to the default for a missing recorded base before a PR exists", async () => {
    status = { ...status, upstream: "origin/feature" };
    render(idle, "origin/deleted/release");
    git.branchBase.mockRejectedValue(new WorkspaceRpcError("base_not_found", "Missing branch", "git.branchBase"));
    fireEvent.click(await screen.findByRole("button", { name: "Create PR" }));
    expect((await screen.findByRole("dialog")).textContent).toContain("open a pull request into main");
    expect(git.branchDiffSize).toHaveBeenCalledWith("main");
  });

  it("keeps an open PR's base even when the runtime cannot find the ref", async () => {
    status = { ...status, upstream: "origin/feature" };
    prs = [pr({ base: "deleted/release" })];
    render();
    git.branchBase.mockRejectedValue(new WorkspaceRpcError("base_not_found", "Missing branch", "git.branchBase"));
    await screen.findByTestId("machine-diff-size");
    expect(git.branchDiffSize.mock.calls).toEqual([["deleted/release"]]);
  });

  it("offers no publishing action on a fresh branch from a release base", async () => {
    render(idle, "origin/release/2.x");
    git.branchBase.mockResolvedValue({ aheadOfBase: 0, head: HEAD });
    await waitFor(() => expect(screen.getByTestId("current-branch").textContent).toBe("feature"));
    expect(screen.queryByTestId("machine-branch-button")).toBeNull();
    expect(git.push).not.toHaveBeenCalled();
  });

  it("rechecks the selected base before publishing from a Create PR dialog", async () => {
    render(idle, "origin/release/2.x");
    await screen.findByRole("button", { name: "Push" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Git actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Create PR/ }));
    const dialog = await screen.findByRole("dialog");
    git.branchBase.mockResolvedValue({ aheadOfBase: 0, head: HEAD });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create PR" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The branch changed");
    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPr).not.toHaveBeenCalled();
    expect(git.createPrWithPush).not.toHaveBeenCalled();
  });

  it("shows a diff-specific update indication for an older machine", async () => {
    status = { ...status, upstream: "origin/feature" };
    render();
    git.branchDiffSize.mockResolvedValue("unsupported");
    expect((await screen.findByRole("status")).textContent).toBe("Update Mac mini for diff totals");
    expect(screen.queryByTestId("machine-diff-size")).toBeNull();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeTruthy();
  });

  it("uses verified publishing for a branch the machine never pushed", async () => {
    render();
    // Never pushed: Push leads, Create PR is in the menu.
    expect((await screen.findByRole("button", { name: "Push" })).hasAttribute("disabled")).toBe(false);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Git actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Create PR/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(git.createPrWithPush).toHaveBeenCalledExactlyOnceWith({
      title: "Add read markers to the catalog feed", body: "", base: "main", draft: false, sessionId: "machine:m1:p1:s1", branch: "feature",
    }, HEAD));
    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPr).not.toHaveBeenCalled();
  });

  it("commits and pushes on the machine with the message given", async () => {
    status = { ...status, upstream: "origin/feature", dirty: true };
    prs = [pr()];
    render();
    fireEvent.click(await screen.findByRole("button", { name: "Commit and push" }));
    const dialog = await screen.findByRole("dialog");
    expect((dialog).textContent).toContain("on Mac mini, then push to origin");
    fireEvent.change(within(dialog).getByLabelText("Commit message"), { target: { value: "Add markers" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit and push" }));
    await waitFor(() => expect(git.push).toHaveBeenCalled());
    expect(git.commitForPush).toHaveBeenCalledWith("Add markers", "feature", HEAD);
    expect(git.push).toHaveBeenCalledWith("feature", MOVED);
  });

  it("says the commit is safe on the machine when only its push failed", async () => {
    status = { ...status, upstream: "origin/feature", dirty: true };
    prs = [pr()];
    render();
    git.push.mockRejectedValueOnce(new Error("rejected: fetch first."));
    fireEvent.click(await screen.findByRole("button", { name: "Commit and push" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Commit message"), { target: { value: "Add markers" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit and push" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Committed on Mac mini, but the push failed: rejected: fetch first.");
    expect(alert.textContent).toContain("Your commit is safe");
  });

  it("reads the branch again as soon as an agent's own turn ends", async () => {
    status = { ...status, upstream: "origin/feature" };
    prs = [pr()];
    const view = render([{ id: "t1", status: "in_progress" }] as TabEntry[]);
    expect((await screen.findByRole("button", { name: "Agent working" })).hasAttribute("disabled")).toBe(true);
    const reads = git.workStatus.mock.calls.length;
    status = { ...status, ahead: 1 };
    view.retab(idle);
    await waitFor(() => expect(git.workStatus.mock.calls.length).toBeGreaterThan(reads));
    expect((await screen.findByRole("button", { name: "Push" })).hasAttribute("disabled")).toBe(false);
  });

  it("asks once before a push publishes from the machine, then pushes directly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    status = { ...status, upstream: "origin/feature", ahead: 1 };
    prs = [pr()];
    render();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    const dialog = screen.getByRole("dialog");
    expect((dialog).textContent).toContain("Push feature to origin. Runs on Mac mini with its Git sign-in.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Push" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(git.push).toHaveBeenCalledTimes(1);
    status = { ...status, ahead: 1 };
    await act(async () => { watchers.forEach((watch) => watch(["a.ts"])); await vi.advanceTimersByTimeAsync(900); });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(git.push).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("merges with the repository's method, pinned to the head it read", async () => {
    status = { ...status, upstream: "origin/feature" };
    prs = [pr()];
    render();
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("dialog");
    expect((dialog).textContent).toContain("Merge #7 into main using rebase.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(git.mergePr).toHaveBeenCalledWith(7, "rebase", HEAD));
    // Merged: the button gives way.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Merge" })).toBeNull());
  });

  it("refuses a merge when the machine's branch moved after the dialog opened", async () => {
    status = { ...status, upstream: "origin/feature" };
    prs = [pr()];
    render();
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("dialog");
    status = { ...status, head: MOVED };
    prs = [pr({ headSha: MOVED })];
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The branch changed on the machine");
    expect(git.mergePr).not.toHaveBeenCalled();
  });

  it("follows the machine's changes live: a file change there re-reads the branch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    status = { ...status, upstream: "origin/feature" };
    prs = [pr()];
    render();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    status = { ...status, dirty: true };
    git.branchDiffSize.mockResolvedValue({ additions: 150, deletions: 9, aheadOfBase: 2, head: HEAD });
    await act(async () => { watchers.forEach((watch) => watch(["src/app.ts"])); await vi.advanceTimersByTimeAsync(900); });
    expect(screen.getByRole("button", { name: "Commit and push" }).hasAttribute("disabled")).toBe(false);
    expect((screen.getByTestId("machine-diff-size")).textContent).toContain("+150 −9");
  });

  it("refreshes edits to an already dirty checkout even if the file watch misses them", async () => {
    vi.useFakeTimers();
    status = { ...status, dirty: true };
    await act(async () => { render(); });
    expect(screen.getByTestId("machine-diff-size").textContent).toContain("+142 −9");
    git.branchDiffSize.mockResolvedValue({ additions: 150, deletions: 9, aheadOfBase: 2, head: HEAD });
    await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_STATUS_EVERY_MS); });
    expect(screen.getByTestId("machine-diff-size").textContent).toContain("+150 −9");
  });

  it("reads the new branch and its PRs when the machine changes checkout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    status = { ...status, upstream: "origin/feature" };
    prs = [pr()];
    render();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    status = { ...status, branch: "follow-up", head: MOVED, upstream: "origin/follow-up" };
    await act(async () => { watchers.forEach((watch) => watch(null)); await vi.advanceTimersByTimeAsync(900); });
    expect(git.prs).toHaveBeenLastCalledWith("follow-up");
    expect(screen.getByTestId("current-branch").textContent).toBe("follow-up");
    expect(screen.getByTestId("pr-count").textContent).toBe("0");
    expect(screen.getByRole("button", { name: "Create PR" }).hasAttribute("disabled")).toBe(false);
  });

  it("sends Fix checks to the agent tab on the machine and waits for it", async () => {
    status = { ...status, upstream: "origin/feature" };
    prs = [pr({ mergeState: "UNSTABLE", checks: [{ name: "test", state: "failure" }] })];
    const view = render();
    fireEvent.click(await screen.findByRole("button", { name: "Fix checks" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const [tab, text] = send.mock.calls[0];
    expect(tab).toBe("t1");
    expect(text).toContain("failing checks");
    expect(text).toContain("Do not push, merge a pull request or open a new pull request.");
    expect((await screen.findByRole("button", { name: "Agent working" })).hasAttribute("disabled")).toBe(true);
    view.retab([{ id: "t1", status: "in_progress" }] as TabEntry[]);
    view.retab(idle);
    expect((await screen.findByRole("status")).textContent).toContain("Agent finished");
  });

  it("keeps the local steps but offers no Create PR while GitHub cannot be read", async () => {
    prsFail = new Error("auth_failed");
    status = { ...status, upstream: "origin/feature", ahead: 1 };
    render();
    expect((await screen.findByRole("button", { name: "Push" })).hasAttribute("disabled")).toBe(false);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Git actions" }), { button: 0, ctrlKey: false });
    expect((await screen.findByRole("menuitem", { name: /Create PR/ })).getAttribute("aria-disabled") ?? (await screen.findByRole("menuitem", { name: /Create PR/ })).getAttribute("data-disabled")).toBeTruthy();
  });

  it("shows the step but runs nothing for a reader who may not write the machine's Git", async () => {
    canWrite = false;
    status = { ...status, upstream: "origin/feature" };
    prs = [pr()];
    render();
    expect((await screen.findByRole("button", { name: "Merge" })).hasAttribute("disabled")).toBe(true);
    // Fetch is a write on git/1: a reader's refresh does not fetch.
    expect(git.fetch).not.toHaveBeenCalled();
  });
});
