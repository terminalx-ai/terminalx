import { TooltipProvider } from "@/components/ui/tooltip";
import { RemoteGit } from "@terminalx/portable/workspaceGit";
import { WorkspaceRpcError, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { cloudGitSource } from "@/lib/gitSource";
import { useFixCheckErrors } from "@/lib/fixCheckErrors";
import { closeWorkspaceRemove, useDialogs } from "@/lib/dialogs";
import { useState } from "react";
import { act, cleanup, fireEvent, render as rtlRender, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrAssociation, PullRequest } from "@/lib/api";
import type { WorkspaceDisposition } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { PrPanel } = await import("./PrPanel");
const { RightPanel } = await import("@/components/layout/RightPanel");
const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

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
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
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
  closeWorkspaceRemove();
  vi.useRealTimers();
  mocks.invoke.mockReset();
});

it.each([false, true])("once merged shows the merged card and summaries, not the conversation, and does not reload it on discovery ticks (inline=%s)", async (inline) => {
  vi.useFakeTimers();
  mockBackend(cleanMerged);
  const backend = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === "pr_conversation" ? {
    ...mergedPr, body: "The only PR description.", viewer: "reviewer", canEdit: true, unresolvedThreads: 0, activity: [], base: "main",
    reviewers: [{ login: "aisha-khan", name: "Aisha Khan", kind: "user", state: "APPROVED", requested: false }],
    merged: { at: null, by: "alexkim", commit: "a91c3e0123", mergeCommit: false, branchDeleted: true },
  } : backend(command, ...args));
  await act(async () => { render(<PrPanel cwd={cwd} branch={mergedPr.head} active busy={false} inline={inline} />); });
  const card = screen.getByTestId("pr-merged-card");
  expect(card.textContent).toContain(`Merged into main#${mergedPr.number}`);
  expect(card.textContent).toContain("Merged by alexkim · a91c3e0");
  expect(card.textContent).toContain("Remote branch deleted on GitHub");
  expect(screen.getByText("Approved by Aisha Khan")).toBeTruthy();
  // After the merge, no description, activity or reviewer controls (design 05.12).
  expect(screen.queryByText("The only PR description.")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_conversation")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_list").length).toBeGreaterThan(1);
});

function machinePrPanel(disposition: () => Promise<WorkspaceDisposition>, pendingCreation = false) {
  const projectKey = "machine:mini:project";
  const sessionId = `${projectKey}:session`;
  mocks.invoke.mockImplementation(async (command: string, args: { additions: unknown[] }) => {
    if (command === "pr_associations") return args.additions;
    throw Error(command);
  });
  let pr = mergedPr;
  const call = vi.fn(async (method: string) => {
    if (method === "git.status") return workStatus(mergedPr.head, 0);
    if (method === "git.prs") return { prs: [pr] };
    if (method === "git.prAssociations") return { pendingCreation, associations: [{ url: mergedPr.url, number: mergedPr.number, head: mergedPr.head, repo: "app" }] };
    if (method === "git.prConversation") return { ...pr, reviewers: [], activity: [] };
    throw Error(method);
  });
  const source = cloudGitSource({ workspaceKey: projectKey, remote: new RemoteGit({ call } as unknown as WorkspaceRpcClient, "app"), canWrite: true, author: async () => null });
  const workspace = {
    projectPath: projectKey, path: cwd, name: "feature",
    host: { key: "machine:mini|session", disposition: vi.fn(disposition), remove: vi.fn(), turnRunning: () => false },
  };
  return {
    workspace,
    setPr: (next: PullRequest) => { pr = next; },
    panel: (branch: string | null = mergedPr.head) => (
      <PrPanel cwd="machine://mini:project/worktree" source={source} sessionId={sessionId} branch={branch} active busy={false} inline machineWorkspace={workspace} />
    ),
  };
}

describe("merged workspace action", () => {
  it("holds removal of a merged branch while another PR creation is awaiting verification", async () => {
    const { panel, workspace } = machinePrPanel(async () => cleanMerged, true);
    render(panel());
    await screen.findByText(/A recently created pull request is awaiting verification/);
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
    expect(workspace.host.disposition).not.toHaveBeenCalled();
  });
  it.each([
    { uncommitted: 0, unpushed: 0 },
    { uncommitted: 1, unpushed: 0 },
    { uncommitted: 0, unpushed: 1 },
  ])("uses only the machine's verdict (uncommitted=$uncommitted, unpushed=$unpushed)", async (counts) => {
    const { panel, workspace } = machinePrPanel(async () => ({ ...cleanMerged, ...counts }));
    const { result } = renderHook(useDialogs);
    render(panel());
    await screen.findByTestId("pr-merged-card");
    expect(workspace.host.disposition).toHaveBeenCalled();
    if (counts.uncommitted || counts.unpushed) {
      expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
    } else {
      fireEvent.click(await screen.findByRole("button", { name: "Delete workspace" }));
      expect(result.current.workspaceRemove).toEqual({ ...workspace, mode: "delete" });
    }
    expect(mocks.invoke.mock.calls.map(([command]) => command)).not.toContain("workspace_disposition");
    expect(workspace.host.remove).not.toHaveBeenCalled();
  });

  it("publishes the PR and updates its actions without waiting for the machine's cleanup check", async () => {
    let finishCheck!: (value: WorkspaceDisposition) => void;
    const pendingCheck = new Promise<WorkspaceDisposition>((resolve) => { finishCheck = resolve; });
    const { panel, setPr, workspace } = machinePrPanel(() => pendingCheck);
    setPr({ ...mergedPr, state: "OPEN", isDraft: true });
    const view = render(panel());
    expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Mark ready" })).disabled).toBe(false);
    expect(workspace.host.disposition).not.toHaveBeenCalled();

    setPr(mergedPr);
    view.rerender(panel(null));
    await screen.findByTestId("pr-merged-card");
    expect(workspace.host.disposition).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();

    setPr({ ...mergedPr, state: "OPEN", isDraft: true });
    view.rerender(panel());
    expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Mark ready" })).disabled).toBe(false);
    await act(async () => finishCheck(cleanMerged));
    expect(workspace.host.disposition).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });

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

    const button = await screen.findByRole("button", { name: "Archive the session" });
    fireEvent.click(button);

    expect(openDelete).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("workspace_disposition", { projectPath, path: cwd, fetch: false });
    });
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  });

  it("still says the branch merged while a pull request linked from another branch is open (PRO-294)", async () => {
    mockBackend(cleanMerged);
    const backend = mocks.invoke.getMockImplementation()!;
    const linked: PullRequest = { ...mergedPr, number: 70, title: "Someone else's work", url: "https://example.test/pull/70", head: "elsewhere", state: "OPEN", mergeable: "MERGEABLE",
      checks: [{ name: "CI", state: "failure", url: "https://github.com/acme/api/actions/runs/1/job/2", actions: { runId: 1, jobId: 2 } }] };
    mocks.invoke.mockImplementation(async (command: string, args: { url?: string }) => {
      if (command === "pr_associations") return [{ url: mergedPr.url, number: mergedPr.number, head: mergedPr.head, scope: { kind: "local", cwd } }, { url: linked.url, number: linked.number, head: linked.head, scope: { kind: "local", cwd }, linked: true }];
      if (command === "pr_details") return args.url === linked.url ? linked : mergedPr;
      return backend(command, args);
    });
    const onFixErrors = vi.fn(async () => {});
    render(<PrPanel cwd={cwd} sessionId="author" branch={mergedPr.head} active busy={false} onSettle={() => {}} onFixErrors={onFixErrors} workspace={{ projectPath, onDelete: vi.fn() }} />);
    await screen.findByText("Someone else's work");
    expect(await screen.findByText("This branch has been merged.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Archive the session" })).toBeTruthy();
    // Its failing checks are shown, but not sent to this session's agent to fix.
    expect(screen.queryByRole("button", { name: /Fix errors/ })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Archive the session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  });

  it("removes deletion eligibility when a workspace safety recheck fails", async () => {
    let failDisposition = false;
    mockBackend(cleanMerged, () => failDisposition);
    const workspace = { projectPath, onDelete: vi.fn() };
    const view = render(
      <PrPanel cwd={cwd} branch={mergedPr.head} active busy={false} onSettle={() => {}} workspace={workspace} />,
    );
    await screen.findByRole("button", { name: "Archive the session" });

    failDisposition = true;
    view.rerender(<PrPanel cwd={cwd} branch={mergedPr.head} active busy onSettle={() => {}} workspace={workspace} />);

    await screen.findByText("Could not complete Git operation");
    fireEvent.click(screen.getByText("Show details"));
    await screen.findByText("Unable to verify workspace");
    expect(screen.queryByRole("button", { name: "Archive the session" })).toBeNull();
  });
});

const followup: PullRequest = {
  ...mergedPr, number: 63, title: "Follow-up work", url: "https://example.test/pull/63", head: "followup", state: "OPEN",
  mergeable: "MERGEABLE", checks: [{ name: "Follow-up CI", state: "pending" }],
};
const association = (pr: PullRequest): PrAssociation => ({ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd } });
const workStatus = (branch: string, aheadOfBase = 0) => ({ isRepo: true, dirty: false, branch, upstream: `origin/${branch}`, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase, head: "abc123" });

it("pins inline publishing to the selected checkout and fixes checks through the session checkout after a picker change", async () => {
  const workspaceKey = "machine:mini:project";
  const sessionId = `${workspaceKey}:session`;
  const otherRepo = "worktrees/other";
  const own = { ...mergedPr, url: "https://github.com/acme/widgets/pull/62", state: "OPEN" as const, head: "feature", checks: [
    { name: "build", state: "failure", url: "https://github.com/acme/widgets/actions/runs/12/job/34", actions: { runId: 12, jobId: 34 } },
  ] };
  const other = { ...own, number: 63, title: "Other worktree PR", url: "https://github.com/acme/widgets/pull/63", head: "picker-branch" };
  let created = false;
  const call = vi.fn(async (method: string, params: { repo?: string; branch?: string; number?: number }) => {
    const sessionCheckout = params.repo === ".";
    if (method === "git.status") {
      return { ...workStatus(sessionCheckout ? own.head : other.head, 1), upstream: sessionCheckout && created ? `origin/${own.head}` : null,
        ahead: sessionCheckout && created ? 0 : 1, head: (sessionCheckout ? "a" : "b").repeat(40) };
    }
    if (method === "git.prAssociations") {
      return { associations: created ? [{ url: own.url, number: own.number, head: own.head, repo: ".", linked: false }] : [] };
    }
    if (method === "git.prs") return { prs: !created ? [] : sessionCheckout ? [own] : [other] };
    if (method === "git.prConversation") return { ...own, reviewers: [], activity: [] };
    throw Error(method);
  });
  const mutate = vi.fn(async (method: string, params: { repo: string }) => {
    if (method !== "git.prCreateForSession") throw Error(`Unexpected mutation ${method}`);
    if (params.repo !== ".") throw new WorkspaceRpcError("conflict", "Select this session's checkout before creating a pull request.", method);
    created = true;
    return { pr: own, created: true, existing: false, sessionAssociated: true };
  });
  const client = { call, mutate } as unknown as WorkspaceRpcClient;
  const source = (repo: string) => cloudGitSource({ workspaceKey, remote: new RemoteGit(client, repo), canWrite: true, author: async () => null });
  const checkoutSource = source(".");
  const pickerSource = source(otherRepo);
  const attach = vi.fn(async () => ({ path: "/attachments/failures.log", truncated: false }));
  const send = vi.fn(async () => ({ events: [], queued: false }));
  function Panel() {
    const [repo, select] = useState<string | null>(".");
    const fix = useFixCheckErrors({ sessionId, tabId: "agent", cwd, branch: own.head, enabled: true,
      machine: { name: "Mac mini", source: checkoutSource, generation: "1", attach, send } });
    return <RightPanel cwd={cwd} isGit sessionId={sessionId} key={repo} gitSource={repo === "." ? checkoutSource : pickerSource}
      onFixErrors={fix.fix} fixBusy={fix.busy} repositories={{ list: [".", otherRepo], selected: repo, onSelect: select }} />;
  }
  const showChecks = () => fireEvent.click(screen.getByRole("button", { name: /^Checks/ }));
  const submit = async () => {
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "New PR" } });
    fireEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
  };

  render(<Panel />);
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: otherRepo } });
  showChecks();
  await submit();
  await screen.findByText("Select this session's checkout before creating a pull request.");
  expect(mutate).toHaveBeenCalledExactlyOnceWith("git.prCreateForSession", expect.objectContaining({ repo: otherRepo, sessionId: "session", branch: other.head, pushHead: "b".repeat(40) }));

  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "." } });
  showChecks();
  await submit();
  await screen.findByRole("button", { name: "Fix errors" });
  expect(mutate).toHaveBeenLastCalledWith("git.prCreateForSession", expect.objectContaining({ repo: ".", sessionId: "session", branch: own.head, pushHead: "a".repeat(40) }));
  expect(mutate).toHaveBeenCalledTimes(2);

  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: otherRepo } });
  showChecks();
  const fix = await screen.findByRole("button", { name: "Fix errors" });
  expect(screen.queryByText(other.title)).toBeNull();
  call.mockClear();
  fireEvent.click(fix);
  await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith("agent", expect.stringContaining(own.url)));
  expect(call).toHaveBeenCalledWith("git.status", { repo: "." });
  expect(call).toHaveBeenCalledWith("git.prs", { repo: ".", branch: own.head });
  expect(attach).toHaveBeenCalledExactlyOnceWith("agent", own.url);
});

describe("session PR history", () => {
  it("loads recorded follow-up creation despite stale session metadata and refreshes its checks", async () => {
    let check = "pending";
    mocks.invoke.mockImplementation(async (command: string, args: { branch?: string }) => {
      if (command === "gh_available") return true;
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
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
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
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
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
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

  it("shows a pull request linked from another branch with its checks, and can unlink it (PRO-294)", async () => {
    let linked = true;
    mocks.invoke.mockImplementation(async (command: string, args: { url?: string; sessionKey?: string }) => {
      if (command === "gh_available") return true;
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
      if (command === "pr_associations") return linked ? [{ ...association(followup), linked: true }] : [];
      if (command === "work_status") return workStatus("raccoon/approval-diff", 1);
      if (command === "pr_list") return [];
      if (command === "pr_details") return { ...followup, checks: [{ name: "Follow-up CI", state: "success" }] };
      if (command === "pr_unlink") {
        expect(args).toEqual({ sessionKey: "author", url: followup.url });
        linked = false;
        return [];
      }
      throw Error(command);
    });
    render(<PrPanel cwd={cwd} sessionId="author" branch="raccoon/approval-diff" active busy={false} />);
    await screen.findByText("Follow-up work");
    expect(screen.getByTestId("pr-linked").textContent).toBe("Linked");
    // Its checks are read from the linked PR, not the session's branch.
    expect(await screen.findByText("Follow-up CI")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("pr_details", { cwd, number: followup.number, url: followup.url });
    // Creating a PR for the session's own branch is still offered: the link does not replace it.
    expect(screen.getByRole("button", { name: "Create pull request" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Unlink #${followup.number}` }));
    await waitFor(() => expect(screen.queryByText("Follow-up work")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain(`Unlinked #${followup.number}.`);
  });

  it("offers no Unlink for a pull request the session opened itself", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "gh_available") return true;
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
      if (command === "pr_associations") return [association(followup)];
      if (command === "work_status") return workStatus("followup", 1);
      if (command === "pr_list") return [followup];
      if (command === "pr_details") return followup;
      throw Error(command);
    });
    render(<PrPanel cwd={cwd} sessionId="author" branch="followup" active busy={false} />);
    await screen.findByText("Follow-up work");
    expect(screen.queryByTestId("pr-linked")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unlink/ })).toBeNull();
  });

  it("keeps an unavailable association visible and blocks cleanup when its state is unknown", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "gh_available") return true;
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
      if (command === "pr_associations") return [association(followup)];
      if (command === "work_status") return workStatus(mergedPr.head);
      if (command === "pr_list") return [mergedPr];
      if (command === "pr_details") throw Error("PR unavailable");
      throw Error(command);
    });
    render(<PrPanel cwd={cwd} sessionId="author" branch={mergedPr.head} active busy={false} onSettle={() => {}} />);
    await screen.findByText("Could not refresh this pull request.");
    fireEvent.click(screen.getByText("Show details"));
    await screen.findByText("PR unavailable");
    expect(screen.getByText(followup.url)).toBeTruthy();
    expect(screen.queryByText("This branch has been merged.")).toBeNull();
  });

  it("ignores an old refresh completing after a session switch, even with the same checkout and branch", async () => {
    let finishOld!: (value: ReturnType<typeof association>[]) => void;
    const delayed = new Promise<ReturnType<typeof association>[]>((resolve) => { finishOld = resolve; });
    mocks.invoke.mockImplementation(async (command: string, args: { sessionKey?: string }) => {
      if (command === "gh_available") return true;
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
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
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
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
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
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
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
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
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
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

it.each([true, false])("shows a linked machine PR without offering a desktop unlink (inline: %s)", async (inline) => {
  const workspaceKey = "machine:mini:project";
  const call = vi.fn(async (method: string) => {
    if (method === "git.status") return workStatus("feature", 3);
    if (method === "git.prAssociations") return {
      associations: [{ url: followup.url, head: followup.head, number: followup.number, repo: "app", linked: true }],
    };
    if (method === "git.prs") return { prs: [followup] };
    throw Error(method);
  });
  const source = cloudGitSource({ workspaceKey, remote: new RemoteGit({ call } as unknown as WorkspaceRpcClient, "app"), canWrite: true, author: async () => null });
  render(<PrPanel source={source} sessionId={`${workspaceKey}:author`} branch="feature" active busy={false} inline={inline} />);
  expect((await screen.findByTestId("pr-linked")).textContent).toBe("Linked");
  expect(screen.queryByRole("button", { name: `Unlink #${followup.number}` })).toBeNull();
  expect(mocks.invoke.mock.calls.some(([method]) => method === "pr_unlink")).toBe(false);
});

it.each([false, true])("links an existing Enterprise PR and ignores a withdrawn cache entry (URL capability: %s)", async (urlCapability) => {
  const workspaceKey = "machine:mini:project";
  const sessionId = `${workspaceKey}:author`;
  const legacy = { ...followup, head: "feature", isDraft: true, url: `https://github.enterprise.test/acme/widgets/pull/${followup.number}` };
  const withdrawn = { ...legacy, number: 99, title: "Withdrawn PR", url: "https://github.enterprise.test/acme/widgets/pull/99" };
  const runtimeRow = (pr: PullRequest) => ({ url: pr.url, number: pr.number, head: pr.head, repo: "feature-tree" });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "pr_associations") return [legacy, withdrawn].map((pr) => ({
      ...runtimeRow(pr), scope: { kind: "cloud", workspace: workspaceKey, repo: "feature-tree" },
    }));
    throw Error(command);
  });
  let saved = false;
  let pr = legacy;
  const call = vi.fn(async (method: string) => {
    if (method === "git.status") return workStatus(legacy.head, 3);
    if (method === "git.prAssociations") return {
      associations: saved ? [{ ...runtimeRow(legacy), linked: true }] : [],
      branchPrLinks: true,
    };
    if (method === "git.prs") return { prs: [pr, withdrawn] };
    if (method === "git.prConversation") return { ...pr, reviewers: [], activity: [] };
    throw Error(method);
  });
  const mutate = vi.fn(async (method: string) => {
    if (method === "git.prLinkBranch") { saved = true; return { sessionAssociated: true }; }
    if (method === "git.prReady") { pr = { ...pr, isDraft: false }; return {}; }
    if (method === "git.prUnlink") { saved = false; return {}; }
    throw Error(method);
  });
  const client = { call, mutate, hasCapability: (capability: string) => urlCapability && capability === "git-pr-target/1" } as unknown as WorkspaceRpcClient;
  const source = cloudGitSource({ workspaceKey, remote: new RemoteGit(client, "feature-tree"), canWrite: true, author: async () => null, sessionCheckout: true });
  const panel = <PrPanel source={source} sessionId={sessionId} branch={legacy.head} active busy={false} inline />;
  const view = render(panel);
  fireEvent.click(await screen.findByRole("button", { name: "Link existing branch PR" }));
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Pull request URL" });
  expect(input.value).toBe("");
  expect(screen.queryByText(withdrawn.title)).toBeNull();
  expect(screen.queryByRole("button", { name: "Mark ready" })).toBeNull();
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: legacy.url } });
  fireEvent.click(screen.getByRole("button", { name: "Link pull request" }));
  expect(await screen.findByRole("button", { name: "Mark ready" })).toBeTruthy();
  expect(mutate).toHaveBeenCalledExactlyOnceWith("git.prLinkBranch", {
    sessionId: "author", repo: "feature-tree", url: legacy.url, branch: legacy.head,
  });
  view.unmount();
  render(panel);
  fireEvent.click(await screen.findByRole("button", { name: "Mark ready" }));
  await waitFor(() => expect(mutate).toHaveBeenLastCalledWith("git.prReady", {
    repo: "feature-tree", url: legacy.url, ...(urlCapability ? {} : { number: legacy.number }),
  }));
  const unlink = await screen.findByRole("button", { name: `Unlink #${legacy.number}` });
  await waitFor(() => expect((unlink as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(unlink);
  expect(await screen.findByRole("button", { name: "Link existing branch PR" })).toBeTruthy();
  expect(mutate).toHaveBeenLastCalledWith("git.prUnlink", {
    sessionId: "author", repo: "feature-tree", url: legacy.url,
  });
  expect(mocks.invoke.mock.calls.some(([method]) => method === "pr_associations")).toBe(false);
});

it("links an existing machine branch PR while retained history is unavailable", async () => {
  const workspaceKey = "machine:mini:project";
  const branchPr = { ...followup, head: "feature", url: `https://github.com/acme/widgets/pull/${followup.number}` };
  const history = { number: 97, url: "https://github.com/acme/old/pull/97", head: "previous", repo: null, linked: false };
  let linked = false;
  const call = vi.fn(async (method: string) => {
    if (method === "git.status") return workStatus(branchPr.head, 3);
    if (method === "git.prs") return { prs: [branchPr] };
    if (method === "git.prAssociations") return {
      associations: linked ? [history, { ...branchPr, repo: "app", linked: true }] : [history],
      branchPrLinks: true,
    };
    if (method === "git.prConversation") return { ...branchPr, reviewers: [], activity: [] };
    throw Error(method);
  });
  const mutate = vi.fn(async () => {
    linked = true;
    return { sessionAssociated: true };
  });
  const source = cloudGitSource({ workspaceKey, remote: new RemoteGit({ call, mutate } as unknown as WorkspaceRpcClient, "app"), canWrite: true, author: async () => null, sessionCheckout: true });
  render(<PrPanel source={source} sessionId={`${workspaceKey}:author`} branch={branchPr.head} active busy={false} inline />);

  expect(await screen.findByText("Could not refresh this pull request.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Unlink #97" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Link existing branch PR" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Pull request URL" }), { target: { value: branchPr.url } });
  fireEvent.click(screen.getByRole("button", { name: "Link pull request" }));

  expect(await screen.findByText(branchPr.title)).toBeTruthy();
  expect(screen.getByText("Could not refresh this pull request.")).toBeTruthy();
  expect(mutate).toHaveBeenCalledExactlyOnceWith("git.prLinkBranch", {
    sessionId: "author", repo: "app", url: branchPr.url, branch: branchPr.head,
  });
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

it("opens a PR from its header and refreshes the same identity after the checkout changes", async () => {
  const { getEditors, dropEditors } = await import("@/lib/editors");
  let title = "Review this PR";
  let checks = "pending";
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
    if (command === "work_status") return { isRepo: true, dirty: false, branch: "new-branch", defaultBranch: "main", ahead: 0, behind: 0, aheadOfBase: 1 };
    if (command === "pr_list" || command === "pr_details") {
      const pr = { ...mergedPr, title, state: "OPEN", checks: [{ name: "CI", state: checks }] };
      return command === "pr_list" ? [pr] : pr;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const panel = render(<PrPanel cwd={cwd} branch="new-branch" active busy={false} inline />);
  fireEvent.click(await screen.findByRole("button", { name: "Open PR #62 in centre tab" }));
  const entry = getEditors().editors.find((e) => e.kind === "pr" && e.root === cwd)!;
  expect(entry.name).toBe("PR #62");
  if (entry.kind !== "pr") throw new Error("Expected PR entry");
  panel.unmount();
  render(<PrPanel cwd={cwd} branch={entry.pr.head} selectedPr={entry.pr} active busy={false} />);
  await screen.findByRole("button", { name: "Review this PR" });
  expect(screen.getByLabelText("CI: pending")).toBeTruthy();
  title = "Updated review";
  checks = "success";
  fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
  await screen.findByRole("button", { name: "Updated review" });
  expect(screen.getByLabelText("CI: success")).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledWith("pr_details", { cwd, number: 62, url: mergedPr.url });
  expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  dropEditors((e) => e.id === entry.id);
});

it("renders a centre PR description with the same restrictions as review threads", async () => {
  const pr = { ...followup, body: '[website](https://example.test/docs) [local](/Applications/Terminal.app)\n\n![pixel](https://untrusted.example/pixel.png)' };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
    if (command === "work_status") return workStatus(pr.head);
    if (command === "pr_details") return pr;
    // The description is drawn by the PR conversation, from its own read.
    if (command === "pr_conversation") return { url: pr.url, title: pr.title, body: pr.body, author: "author", viewer: "reviewer", state: "OPEN", canEdit: false, reviewers: [], unresolvedThreads: 0, activity: [] };
    if (command === "pr_review_threads") return { url: pr.url, headOid: "head", baseOid: "base", threads: [] };
    throw Error(command);
  });
  const { container } = render(<PrPanel cwd={cwd} selectedPr={association(pr)} branch={pr.head} active busy={false} />);
  await screen.findByRole("link", { name: "website" });
  expect(screen.queryByRole("link", { name: "local" })).toBeNull();
  fireEvent.click(screen.getByText("local"));
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("pixel (image blocked)")).toBeTruthy();
  expect(mocks.invoke.mock.calls.map(([command]) => command)).not.toContain("inspect_local_path");
});

it.each(["panel", "inline", "centre"])("loads review threads for the selected PR URL (%s)", async (surface) => {
  const { reviewSnapshot } = await import("@/test/reviewThreads");
  const pr = { ...followup, url: reviewSnapshot.url, number: 1 };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
    if (command === "pr_associations") return [association(pr)];
    if (command === "work_status") return workStatus(pr.head);
    if (command === "pr_list") return [pr];
    if (command === "pr_details") return pr;
    if (command === "pr_review_threads") return { ...reviewSnapshot, threads: [] };
    throw Error(command);
  });
  render(<PrPanel cwd={cwd} sessionId="author" branch={pr.head} selectedPr={surface === "centre" ? association(pr) : undefined} active busy={false} inline={surface === "inline"} />);
  // Read as soon as the PR is shown (PRO-234). With none, no empty row: REVIEW's summary says "0 unresolved" (PRO-395).
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pr_review_threads", { url: pr.url }));
  await act(async () => {});
  expect(screen.queryByTestId("review-threads")).toBeNull();
  expect(screen.queryByText("No review threads.")).toBeNull();
});

const { mergeReadiness, afterMerge } = await import("./PrPanel");

it("acts on 'Archive this session after merge' only for the session's own pull request", () => {
  const off = { archive: false, deleteBranch: false };
  const on = { archive: true, deleteBranch: false };
  // A linked PR: the menu did not offer the choice, so this session's workspace is left alone.
  expect(afterMerge(false, off, true)).toBeNull();
  expect(afterMerge(false, on, false)).toBeNull();
  expect(afterMerge(true, off, true)).toBe("hold");
  expect(afterMerge(true, on, false)).toBe("archive");
  expect(afterMerge(true, on, true)).toBeNull();
  expect(afterMerge(true, off, false)).toBeNull();
  expect(afterMerge(true, undefined, true)).toBeNull();
});
const { checkCounts, checkSummary } = await import("@/lib/checks");
const openPr: PullRequest = { ...followup, mergeState: "CLEAN", checks: [], requiredChecks: [] };

function panelBackend(read: () => PullRequest) {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
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
    [{ checks: [{ name: "ci", state: "pending" }], requiredChecks: ["ci"] }, "Waiting for 1 check", false],
    // PRO-394: GitHub says BLOCKED while required checks run; that is a wait, not a block.
    [{ mergeState: "BLOCKED", reviewDecision: "APPROVED", checks: [{ name: "a", state: "in_progress" }, { name: "b", state: "queued" }, { name: "c", state: "success" }], requiredChecks: ["a", "b", "c"] }, "Waiting for 2 checks", false],
    // The wait is said only when checks are all that holds the PR: a review still needed or a stale base comes first.
    [{ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", checks: [{ name: "a", state: "pending" }], requiredChecks: ["a"] }, "Blocked", false],
    [{ mergeState: "BLOCKED", reviewDecision: "CHANGES_REQUESTED", checks: [{ name: "a", state: "in_progress" }], requiredChecks: ["a"] }, "Blocked", false],
    [{ mergeState: "BEHIND", reviewDecision: "APPROVED", checks: [{ name: "a", state: "in_progress" }], requiredChecks: ["a"] }, "Behind base", false],
    [{ checks: [{ name: "ci", state: "new_state" }], requiredChecks: ["ci"] }, "Checking mergeability", false],
    [{ detailsError: "offline" }, "Merge details unavailable", false],
    [{ mergeQueueEnabled: true, autoMergeEnabled: true }, "Waiting to enter merge queue", false],
    [{}, "Ready to merge", true],
  ] as [Partial<PullRequest>, string, boolean][])("chooses %s → %s", (changes, label, ok) => {
    expect(mergeReadiness({ ...openPr, ...changes })).toMatchObject({ label, ok });
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
    // PRO-394: a red band says how many failed; only required checks carry a chip, and every check is listed.
    await screen.findByText("2 of 5 checks failed");
    expect(screen.getByText("· 1 running · 1 skipped")).toBeTruthy();
    for (const check of checks) expect(screen.getByLabelText(`${check.name}: ${check.state}`)).toBeTruthy();
    expect(screen.getAllByText("required")).toHaveLength(2);
    expect(screen.queryByText(/^optional$/i)).toBeNull();
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Deployments" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "https://preview.example.test/" }));
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    expect(openUrl).toHaveBeenCalledWith("https://preview.example.test/");
  });

  it("keeps unread requirements unknown and refuses non-web provider links", async () => {
    panelBackend(() => ({ ...openPr, requiredChecks: null, checks: [{ name: "ci", state: "success", url: "file:///tmp/run" }], deployments: [{ name: "unsafe", state: "success", url: "javascript:alert(1)" }] }));
    render(<PrPanel cwd={cwd} branch={followup.head} active busy={false} />);
    await screen.findByLabelText("ci: success");
    // Requirements GitHub has not said are not guessed at: no chip.
    expect(screen.queryByText("required")).toBeNull();
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
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
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

describe("PrPanel load failure states", () => {
  afterEach(cleanup);
  it("names an offline failure instead of the raw error", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "gh_connection_status") return { state: "connected", details: null };
      if (command === "git_has_remote") return true;
      if (command === "work_status") throw "error connecting to api.github.com";
      return null;
    });
    render(<PrPanel cwd={cwd} branch="feature" busy={false} active />);
    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.queryByText("Could not complete Git operation")).toBeNull();
  });
});
