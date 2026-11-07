import { RemoteGit } from "@terminalx/portable/workspaceGit";
import { WorkspaceRpcError, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { cloudGitSource } from "@/lib/gitSource";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequest } from "@/lib/api";
import type { WorkspaceDisposition } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { PrPanel } = await import("./PrPanel");

const cwd = "/repos/raccoon/.raccoon/worktrees/65-delete-workspace";
const projectPath = "/repos/raccoon";
const mergedPr: PullRequest = {
  number: 62,
  title: "Show delete workspace",
  url: "https://example.test/pull/62",
  state: "MERGED",
  isDraft: false,
  base: "main",
  head: "raccoon/65-delete-workspace",
  additions: 12,
  deletions: 3,
  mergeable: "UNKNOWN",
  reviewDecision: null,
  checks: [],
  body: "",
  author: "terminalx",
};

const cleanMerged: WorkspaceDisposition = {
  exists: true,
  checked: true,
  isMain: false,
  branch: mergedPr.head,
  uncommitted: 0,
  unpushed: 0,
  aheadOfBase: 0,
  pr: {
    number: mergedPr.number,
    title: mergedPr.title,
    url: mergedPr.url,
    state: "MERGED",
    isDraft: false,
  },
  prChecked: true,
  sessions: 0,
  sessionTitles: [],
  sessionIds: [],
};

function mockBackend(disposition: WorkspaceDisposition, shouldFailDisposition: () => boolean = () => false) {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "pr_list") return [mergedPr];
    if (command === "work_status") {
      return {
        isRepo: true,
        dirty: false,
        branch: mergedPr.head,
        upstream: `origin/${mergedPr.head}`,
        ahead: 0,
        behind: 0,
        defaultBranch: "main",
        aheadOfBase: 0,
        head: "abc123",
      };
    }
    if (command === "workspace_disposition") {
      if (shouldFailDisposition()) throw new Error("Unable to verify workspace");
      return disposition;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.invoke.mockReset();
});

it.each([false, true])("renders one description and does not reload a terminal conversation on discovery ticks (inline=%s)", async (inline) => {
  vi.useFakeTimers();
  mockBackend(cleanMerged);
  const backend = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === "pr_conversation" ? {
    ...mergedPr, body: "The only PR description.", viewer: "reviewer", canEdit: true, reviewers: [], unresolvedThreads: 0, activity: [],
  } : backend(command, ...args));
  await act(async () => { render(<PrPanel cwd={cwd} branch={mergedPr.head} active busy={false} inline={inline} />); });
  expect(screen.getAllByText("The only PR description.")).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_conversation")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_list").length).toBeGreaterThan(1);
});

describe("merged workspace action", () => {
  it("offers guarded workspace deletion when a managed workspace is merged and clean", async () => {
    mockBackend(cleanMerged);
    const openDelete = vi.fn();

    render(
      <PrPanel
        cwd={cwd}
        branch={mergedPr.head}
        active
        busy={false}
        onSettle={() => {}}
        workspace={{ projectPath, onDelete: openDelete }}
      />,
    );

    const button = await screen.findByRole("button", { name: "Delete workspace" });
    fireEvent.click(button);

    expect(openDelete).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("workspace_disposition", { projectPath, path: cwd, fetch: false });
    });
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  });

  it.each([
    ["has uncommitted changes", { ...cleanMerged, uncommitted: 1 }],
    ["has unpushed commits", { ...cleanMerged, unpushed: 1 }],
    ["has no confirmed pull-request status", { ...cleanMerged, pr: null, prChecked: false }],
    ["has an unknown pull-request state", { ...cleanMerged, pr: { ...cleanMerged.pr!, state: "UNKNOWN" } }],
    ["is the main workspace", { ...cleanMerged, isMain: true }],
    ["changed branches during refresh", { ...cleanMerged, branch: "another-branch" }],
    ["returned a different PR during refresh", { ...cleanMerged, pr: { ...cleanMerged.pr!, url: "https://example.test/pull/999" } }],
  ])("does not offer deletion when the workspace %s", async (_case, disposition) => {
    mockBackend(disposition);

    render(
      <PrPanel
        cwd={cwd}
        branch={mergedPr.head}
        active
        busy={false}
        onSettle={() => {}}
        workspace={{ projectPath, onDelete: vi.fn() }}
      />,
    );

    await screen.findByText("This branch has been merged.");
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("workspace_disposition", { projectPath, path: cwd, fetch: false });
    });
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  });

  it("removes deletion eligibility when a workspace safety recheck fails", async () => {
    let failDisposition = false;
    mockBackend(cleanMerged, () => failDisposition);
    const workspace = { projectPath, onDelete: vi.fn() };
    const view = render(
      <PrPanel cwd={cwd} branch={mergedPr.head} active busy={false} onSettle={() => {}} workspace={workspace} />,
    );
    await screen.findByRole("button", { name: "Delete workspace" });

    failDisposition = true;
    view.rerender(<PrPanel cwd={cwd} branch={mergedPr.head} active busy onSettle={() => {}} workspace={workspace} />);

    await screen.findByText("Unable to verify workspace");
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });
});

const followup: PullRequest = {
  ...mergedPr, number: 63, title: "Follow-up work", url: "https://example.test/pull/63", head: "followup", state: "OPEN",
  mergeable: "MERGEABLE", checks: [{ name: "Follow-up CI", state: "pending" }],
};
const association = (pr: PullRequest) => ({ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd } });
const workStatus = (branch: string, aheadOfBase = 0) => ({ isRepo: true, dirty: false, branch, upstream: `origin/${branch}`, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase, head: "abc123" });

describe("session PR history", () => {
  it("loads recorded follow-up creation despite stale session metadata and refreshes its checks", async () => {
    let check = "pending";
    mocks.invoke.mockImplementation(async (command: string, args: { branch?: string }) => {
      if (command === "gh_available") return true;
      if (command === "pr_associations") return [association(mergedPr), association(followup)];
      if (command === "work_status") return workStatus(followup.head, 1);
      if (command === "pr_list") return args.branch === mergedPr.head ? [mergedPr] : [{ ...followup, checks: [{ name: "Follow-up CI", state: check }] }];
      if (command === "pr_details") return mergedPr;
      throw Error(command);
    });
    render(<PrPanel cwd={cwd} sessionId="author" branch={mergedPr.head} active busy={false} onSettle={() => {}} />);
    await screen.findByText("Follow-up work");
    expect(screen.getByText(mergedPr.title)).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("pr_list", { cwd, branch: followup.head });
    expect(screen.queryByText("This branch has been merged.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
    expect(screen.getByLabelText("Follow-up CI: pending")).toBeTruthy();
    check = "success";
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
    await screen.findByLabelText("Follow-up CI: success");
  });

  it("never offers settle for new commits on a reused merged branch", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "gh_available") return true;
      if (command === "pr_associations") return [association(mergedPr)];
      if (command === "work_status") return workStatus(mergedPr.head, 2);
      if (command === "pr_landed") return { safe: false, merged: null, branch: mergedPr.head, head: "abc123" };
      if (command === "pr_list") return [mergedPr];
      throw Error(command);
    });
    render(<PrPanel cwd={cwd} sessionId="author" branch={mergedPr.head} active busy={false} onSettle={() => {}} />);
    await screen.findByRole("button", { name: "Create pull request" });
    expect(screen.queryByText("This branch has been merged.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  });

  it("keeps the create action scoped to current work when another branch has an open PR", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "gh_available") return true;
      if (command === "pr_associations") return [association(followup)];
      if (command === "work_status") return workStatus("third-branch", 1);
      if (command === "pr_list") return [];
      if (command === "pr_details") return followup;
      throw Error(command);
    });
    render(<PrPanel cwd={cwd} sessionId="author" branch="third-branch" active busy={false} onSettle={() => {}} />);
    await screen.findByText("Follow-up work");
    expect(screen.getByRole("button", { name: "Create pull request" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  });

  it("keeps an unavailable association visible and blocks cleanup when its state is unknown", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "gh_available") return true;
      if (command === "pr_associations") return [association(followup)];
      if (command === "work_status") return workStatus(mergedPr.head);
      if (command === "pr_list") return [mergedPr];
      if (command === "pr_details") throw Error("PR unavailable");
      throw Error(command);
    });
    render(<PrPanel cwd={cwd} sessionId="author" branch={mergedPr.head} active busy={false} onSettle={() => {}} />);
    await screen.findByText("Could not refresh: PR unavailable");
    expect(screen.getByText(followup.url)).toBeTruthy();
    expect(screen.queryByText("This branch has been merged.")).toBeNull();
  });

  it("ignores an old refresh completing after a session switch, even with the same checkout and branch", async () => {
    let finishOld!: (value: ReturnType<typeof association>[]) => void;
    const delayed = new Promise<ReturnType<typeof association>[]>((resolve) => { finishOld = resolve; });
    mocks.invoke.mockImplementation(async (command: string, args: { sessionKey?: string }) => {
      if (command === "gh_available") return true;
      if (command === "pr_associations") return args.sessionKey === "old" ? delayed : [];
      if (command === "work_status") return workStatus("main");
      if (command === "pr_details") return mergedPr;
      throw Error(command);
    });
    const view = render(<PrPanel cwd={cwd} sessionId="old" branch="main" active busy={false} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pr_associations", { sessionKey: "old", additions: [] }));
    view.rerender(<PrPanel cwd={cwd} sessionId="new" branch="main" active busy={false} />);
    await screen.findByText("On the default branch; nothing to open a pull request from.");
    await act(async () => {
      finishOld([association(mergedPr)]);
      await delayed;
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("pr_details", expect.anything());
    expect(screen.queryByText(mergedPr.title)).toBeNull();
  });
});

it("does not overwrite a newer refresh when an older request finishes last", async () => {
  let finishOld!: (value: PullRequest[]) => void;
  const delayed = new Promise<PullRequest[]>((resolve) => { finishOld = resolve; });
  let reads = 0;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "work_status") return workStatus(followup.head, 1);
    if (command === "pr_list") return ++reads === 1 ? delayed : [followup];
    throw Error(command);
  });
  const view = render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} />);
  await waitFor(() => expect(reads).toBe(1));
  view.rerender(<PrPanel cwd={cwd} branch={followup.head} active busy />);
  await screen.findByText(followup.title);
  finishOld([mergedPr]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(mergedPr.title)).toBeNull();
  expect(screen.getByText(followup.title)).toBeTruthy();
});

it("updates a follow-up's state and offers settle only after current work is confirmed merged", async () => {
  let merged = false;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "pr_associations") return [association(mergedPr), association(followup)];
    if (command === "work_status") return workStatus(followup.head, merged ? 0 : 1);
    if (command === "pr_list") return [{ ...followup, state: merged ? "MERGED" : "OPEN" }];
    if (command === "pr_details") return mergedPr;
    throw Error(command);
  });
  render(<PrPanel cwd={cwd} sessionId="author" branch={followup.head} active busy={false} onSettle={() => {}} />);
  await screen.findByText(followup.title);
  expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  merged = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
  await screen.findByRole("button", { name: "Settle worktree" });
  expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  expect(screen.getByText(mergedPr.title)).toBeTruthy();
  expect(screen.getByText(followup.title)).toBeTruthy();
});

it.each(["squash", "rebase"])("recognizes %s-merged work despite commits outside base ancestry", async (method) => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "pr_associations") return [association(mergedPr)];
    if (command === "work_status") return workStatus(mergedPr.head, 3);
    if (command === "pr_list") return [mergedPr];
    if (command === "pr_landed") return { safe: true, merged: method, branch: mergedPr.head, head: "abc123" };
    throw Error(command);
  });
  render(<PrPanel cwd={cwd} sessionId="author" branch={mergedPr.head} active busy={false} onSettle={() => {}} />);
  await screen.findByRole("button", { name: "Settle worktree" });
  expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
});

it("does not apply landed evidence from a different checkout HEAD", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "pr_associations") return [association(mergedPr)];
    if (command === "work_status") return workStatus(mergedPr.head, 3);
    if (command === "pr_list") return [mergedPr];
    if (command === "pr_landed") return { safe: true, merged: "squash", branch: mergedPr.head, head: "different" };
    throw Error(command);
  });
  render(<PrPanel cwd={cwd} sessionId="author" branch={mergedPr.head} active busy={false} onSettle={() => {}} />);
  await screen.findByRole("button", { name: "Create pull request" });
  expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
});

it.each(["squash", "rebase"])("uses runtime landed evidence for a cloud panel-created %s merge", async () => {
  const sessionId = "cloud:org:workspace:author";
  let saved: unknown[] = [];
  let safe = true;
  mocks.invoke.mockImplementation(async (command: string, args: { additions: unknown[] }) => {
    if (command !== "pr_associations") throw Error(`Cloud must not use native Git: ${command}`);
    if (args.additions.length) saved = args.additions;
    return saved;
  });
  const call = vi.fn(async (method: string) => {
    if (method === "git.status") return workStatus(mergedPr.head, 3);
    if (method === "git.prs") return { prs: [mergedPr] };
    if (method === "git.prAssociations") return { associations: [] };
    if (method === "git.prLanded") return { safe, head: "abc123", branch: mergedPr.head };
    throw Error(method);
  });
  const mutate = vi.fn(async () => ({ pr: { ...mergedPr, state: "OPEN" }, created: true }));
  const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote: new RemoteGit({ call, mutate } as unknown as WorkspaceRpcClient, "app"), canWrite: true, author: async () => null });
  await source.createPr({ title: "Work", body: "", base: "main", draft: false, sessionId });
  render(<PrPanel source={source} sessionId={sessionId} branch={mergedPr.head} active busy={false} />);
  await screen.findByText(mergedPr.title);
  expect(call).toHaveBeenCalledWith("git.prLanded", { repo: "app" });
  expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  safe = false; // New follow-up work after the rewritten merge.
  fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
  await screen.findByRole("button", { name: "Create pull request" });
});


it("keeps a merged cloud PR visible without offering creation when landed verification is unsupported", async () => {
  mocks.invoke.mockResolvedValue([{ url: mergedPr.url, number: mergedPr.number, head: mergedPr.head, scope: { kind: "cloud", workspace: "cloud:org:workspace", repo: "app" } }]);
  const call = vi.fn(async (method: string) => {
    if (method === "git.status") return workStatus(mergedPr.head, 3);
    if (method === "git.prs") return { prs: [mergedPr] };
    if (method === "git.prAssociations") return { associations: [] };
    throw new WorkspaceRpcError("method_not_found", "old runtime", method);
  });
  const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote: new RemoteGit({ call } as unknown as WorkspaceRpcClient, "app"), canWrite: true, author: async () => null });
  render(<PrPanel source={source} sessionId="cloud:org:workspace:author" branch={mergedPr.head} active busy={false} />);
  await screen.findByText(mergedPr.title);
  expect(call).toHaveBeenCalledWith("git.prLanded", { repo: "app" });
  expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  expect(screen.queryByText(/Could not refresh/)).toBeNull();
});

const { mergeReadiness, checkCounts, checkSummary } = await import("./PrPanel");
const openPr: PullRequest = { ...followup, mergeState: "CLEAN", checks: [], requiredChecks: [] };

function panelBackend(read: () => PullRequest) {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "work_status") return workStatus(followup.head, read().state === "MERGED" ? 0 : 1);
    if (command === "pr_list") return [read()];
    if (command === "pr_merge") return;
    throw Error(command);
  });
}

describe("merge state labels", () => {
  it.each([
    [{ mergeState: "BLOCKED" }, "Blocked", false],
    [{ mergeState: "BEHIND" }, "Behind base", false],
    [{ mergeState: "UNSTABLE", checks: [{ name: "optional", state: "failure" }] }, "Unstable: optional checks failing", true],
    [{ mergeState: "DIRTY" }, "Has conflicts", false],
    [{ mergeState: "UNKNOWN" }, "Checking mergeability", false],
    [{ isDraft: true, mergeState: "BLOCKED" }, "Draft", false],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "Blocked", false],
    [{ checks: [{ name: "ci", state: "failure" }], requiredChecks: ["ci"] }, "Checks failing", false],
    [{ checks: [{ name: "ci", state: "pending" }], requiredChecks: ["ci"] }, "Checks running", false],
    [{ checks: [{ name: "ci", state: "new_state" }], requiredChecks: ["ci"] }, "Checking mergeability", false],
    [{ detailsError: "offline" }, "Merge details unavailable", false],
    [{ mergeQueueEnabled: true, autoMergeEnabled: true }, "Waiting to enter merge queue", false],
    [{}, "Ready to merge", true],
  ] as [Partial<PullRequest>, string, boolean][])("chooses %s → %s", (changes, label, ok) => {
    expect(mergeReadiness({ ...openPr, ...changes })).toEqual({ label, ok });
  });

  it.each([
    ["QUEUED", "Queued (position 3)"],
    ["MERGEABLE", "Queued (position 3)"],
    ["AWAITING_CHECKS", "Checks running in queue"],
    ["UNMERGEABLE", "Blocked in queue"],
    ["LOCKED", "Locked"],
  ])("shows %s before branch checks and rules", (state, label) => {
    const pr = { ...openPr, mergeState: "BLOCKED", checks: [{ name: "optional", state: "failure" }], mergeQueueEntry: { position: 3, state } };
    expect(mergeReadiness(pr)).toEqual({ ok: false, label });
    expect(mergeReadiness({ ...pr, state: "MERGED" }).label).toBe("Merged");
    expect(mergeReadiness({ ...pr, state: "CLOSED" }).label).toBe("Closed");
  });
});

describe("check summaries and deployments", () => {
  const checks = [
    { name: "build", state: "success" },
    { name: "lint", state: "failure" },
    { name: "test", state: "in_progress" },
    { name: "docs", state: "skipped" },
    { name: "preview", state: "error" },
  ];

  it("counts each displayed check once, with skipped distinct from passing", () => {
    expect(checkCounts(checks)).toEqual({ total: 5, passed: 1, failed: 2, running: 1, skipped: 1, unknown: 0 });
    expect(checkSummary(checks)).toBe("2 of 5 failed · 1 running · 1 skipped");
    expect(checkSummary([{ name: "ci", state: "success" }, { name: "docs", state: "neutral" }])).toBe("1 of 2 passed · 1 skipped");
    expect(checkSummary([{ name: "ci", state: "future" }])).toBe("0 of 1 passed · 1 unknown");
  });

  it.each([false, true])("renders matching counts, required/optional labels and deployment links (inline=%s)", async (inline) => {
    panelBackend(() => ({ ...openPr, checks, requiredChecks: ["build", "test"], deployments: [{ name: "Vercel preview", state: "success", url: "https://preview.example.test/" }] }));
    render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} inline={inline} />);
    await screen.findByText("2 of 5 failed · 1 running · 1 skipped");
    for (const check of checks) expect(screen.getByLabelText(`${check.name}: ${check.state}`)).toBeTruthy();
    expect(screen.getAllByText("Required")).toHaveLength(2);
    expect(screen.getAllByText("Optional")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Deployments" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "https://preview.example.test/" }));
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    expect(openUrl).toHaveBeenCalledWith("https://preview.example.test/");
  });

  it("keeps unread requirements unknown and refuses non-web provider links", async () => {
    panelBackend(() => ({ ...openPr, requiredChecks: null, checks: [{ name: "ci", state: "success", url: "file:///tmp/run" }], deployments: [{ name: "unsafe", state: "success", url: "javascript:alert(1)" }] }));
    render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} />);
    await screen.findByText("Requirement unknown");
    expect(screen.queryByRole("button", { name: "ci" })).toBeNull();
    expect(screen.queryByRole("button", { name: /javascript/ })).toBeNull();
    expect(screen.queryByText("Optional")).toBeNull();
  });
});

describe("merge queue refresh and actions", () => {
  it.each([false, true])("adds using the queue method and shows position after refresh (inline=%s)", async (inline) => {
    let pr = { ...openPr, mergeQueueEnabled: true, mergeState: "BLOCKED" };
    panelBackend(() => pr);
    render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} inline={inline} />);
    const add = await screen.findByRole("button", { name: "Add to merge queue" });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    pr = { ...pr, mergeQueueEntry: { position: 4, state: "QUEUED" } };
    fireEvent.click(add);
    await screen.findByText("Queued (position 4)");
    expect(mocks.invoke).toHaveBeenCalledWith("pr_merge", { cwd, number: followup.number, method: "queue" });
    expect(screen.queryByRole("button", { name: "Add to merge queue" })).toBeNull();
  });

  it.each(["removed", "merged"])("leaves the queue when %s on refresh", async (transition) => {
    let pr: PullRequest = { ...openPr, mergeQueueEnabled: true, mergeQueueEntry: { position: 4, state: "AWAITING_CHECKS" } };
    panelBackend(() => pr);
    render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} />);
    await screen.findByText("Checks running in queue");
    expect(screen.getByText("Queue position 4")).toBeTruthy();
    pr = { ...pr, mergeQueueEntry: null, state: transition === "merged" ? "MERGED" : "OPEN" };
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
    await waitFor(() => expect(screen.queryByText("Checks running in queue")).toBeNull());
    expect(screen.queryByText("Queue position 4")).toBeNull();
    expect(!!screen.queryByRole("button", { name: "Add to merge queue" })).toBe(transition === "removed");
  });

  it.each([
    { isDraft: true }, { detailsError: "timed out" }, { mergeable: "CONFLICTING" as const },
    { autoMergeEnabled: true }, { mergeQueueEntry: { position: 1, state: "LOCKED" } },
  ])("does not enqueue drafts, conflicts, unread details or an existing request: %s", async (changes) => {
    panelBackend(() => ({ ...openPr, mergeQueueEnabled: true, ...changes }));
    render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} />);
    await screen.findByText(followup.title);
    expect(screen.queryByRole("button", { name: "Add to merge queue" })).toBeNull();
  });
});

it("keeps a queued PR's position visible while branch work holds its actions", async () => {
  panelBackend(() => ({ ...openPr, mergeQueueEnabled: true, mergeQueueEntry: { position: 8, state: "QUEUED" } }));
  render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} inline held />);
  await screen.findByText("Queued (position 8)");
  expect(screen.queryByRole("button", { name: "Add to merge queue" })).toBeNull();
});

it("queues an associated PR by its own URL after the checkout changes branches", async () => {
  const pr = { ...openPr, mergeQueueEnabled: true };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "work_status") return workStatus("main");
    if (command === "pr_associations") return [association(pr)];
    if (command === "pr_details") return pr;
    if (command === "pr_merge") return;
    throw Error(command);
  });
  render(<PrPanel cwd={cwd} sessionId="author" branch="main" active busy={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add to merge queue" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pr_merge", { cwd, number: pr.number, method: "queue", url: pr.url }));
});

it.each([false, true])("respects cloud write permission for queue actions (canWrite=%s)", async (canWrite) => {
  const call = vi.fn(async (method: string) => {
    if (method === "git.status") return workStatus(followup.head, 1);
    if (method === "git.prs") return { prs: [{ ...openPr, mergeQueueEnabled: true }] };
    throw Error(method);
  });
  const mutate = vi.fn(async () => ({}));
  const source = cloudGitSource({ workspaceKey: "cloud:org:workspace", remote: new RemoteGit({ call, mutate } as unknown as WorkspaceRpcClient, "app"), canWrite, author: async () => null });
  render(<PrPanel source={source} branch={followup.head} active busy={false} />);
  await screen.findByText(followup.title);
  const add = screen.queryByRole("button", { name: "Add to merge queue" });
  expect(!!add).toBe(canWrite);
  if (add) {
    fireEvent.click(add);
    await waitFor(() => expect(mutate).toHaveBeenCalledWith("git.prMerge", { repo: "app", number: followup.number, method: "queue" }));
  } else expect(mutate).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalledWith("pr_merge", expect.anything());
});
