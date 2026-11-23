import { TooltipProvider } from "@/components/ui/tooltip";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText } from "@/lib/clipboard";
import { type PullRequest } from "@/lib/api";
import type { PrConversation, PrConversationAction } from "@terminalx/portable/workspaceGit";
import { localGitSource } from "@/lib/gitSource";
import { runSignature, withPendingChecks } from "@/lib/checks";
import { mergeReadiness, PrPanel } from "./PrPanel";
import { dropEditors, getEditors } from "@/lib/editors";
import { dismissError, getErrorToasts } from "@/lib/errorToasts";

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

const pr: PullRequest = { number: 1, url: "https://github.com/owner/repo/pull/1", title: "Fix CI", state: "OPEN", isDraft: false, head: "feature", base: "main", additions: 1, deletions: 0, body: "", author: "dev", mergeable: "MERGEABLE", reviewDecision: null, checks: [
  { name: "test", state: "failure", url: "https://github.com/owner/repo/actions/runs/12/job/34", actions: { runId: 12, jobId: 34 } },
  { name: "lint", state: "failure", url: "https://github.com/owner/repo/actions/runs/12/job/35", actions: { runId: 12, jobId: 35 } },
  { name: "deploy", state: "success", url: "https://github.com/owner/repo/actions/runs/56/job/78", actions: { runId: 56, jobId: 78 } },
  { name: "external CI", state: "failure", url: "https://ci.example.com/check/4" },
] };
let current: PullRequest;
beforeEach(() => {
  vi.clearAllMocks();
  current = structuredClone(pr);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "gh_connection_status") return { state: "connected", details: null };
    if (command === "git_has_remote") return true;
    if (command === "work_status") return { branch: "feature", defaultBranch: "main", aheadOfBase: 1 };
    if (command === "pr_list") return [current];
    if (command === "pr_conversation") return { url: current.url, title: current.title, body: current.body, author: current.author, viewer: "reviewer", state: current.state, canEdit: true, reviewers: [], unresolvedThreads: 0, activity: [] } satisfies PrConversation;
    if (command === "pr_check_log") return { text: "^[[31merror: assertion failed^[[0m", truncated: true };
    if (command === "pr_check_authority") return { owner: "test-policy", epoch: 0 };
    if (command === "pr_check_rerun") return;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => {
  cleanup();
  dropEditors(() => true);
  for (const toast of getErrorToasts()) dismissError(toast.id);
});
const show = (inline = true) => render(<PrPanel cwd="/repo" branch="feature" active busy={false} inline={inline} />);

it.each([true, false])("keeps queued checks and deployments when the conversation edits the PR (inline=%s)", async (inline) => {
  current.deployments = [{ name: "Preview", state: "success", url: "https://preview.example.test/" }];
  const conversation: PrConversation = { url: pr.url, title: pr.title, body: "Original description", author: pr.author, viewer: "reviewer", state: "OPEN", canEdit: true, reviewers: [], unresolvedThreads: 0, activity: [] };
  const backend = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === "pr_conversation") return structuredClone(conversation);
    if (command === "pr_conversation_action") {
      const { action } = args[0] as { action: PrConversationAction };
      if (action.kind === "edit") {
        conversation.title = action.title;
        conversation.body = action.body;
      }
      return { conversation: structuredClone(conversation), error: null };
    }
    return backend(command, ...args);
  });
  show(inline);
  const rerun = await screen.findByRole("button", { name: "Re-run failed" });
  await waitFor(() => expect((rerun as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.click(rerun); });
  await screen.findByLabelText("test: queued");
  // Only the external check still fails; another re-run waits for this one.
  expect(screen.getByText("1 of 4 checks failed")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Re-run failed" }) as HTMLButtonElement).disabled).toBe(true);
  const discoveryReads = mocks.invoke.mock.calls.filter(([command]) => command === "pr_list").length;
  fireEvent.click(screen.getByRole("button", { name: "Edit title and description" }));
  fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "Updated title" } });
  fireEvent.change(screen.getByLabelText("Pull request description"), { target: { value: "Updated description" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Updated description");
  expect(screen.getByRole("button", { name: /Updated title/ })).toBeTruthy();
  expect(screen.getAllByLabelText("test: queued")).toHaveLength(1);
  expect(screen.getAllByLabelText("lint: queued")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Deployments" })).toBeTruthy();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_list")).toHaveLength(discoveryReads);
  expect(mocks.invoke).toHaveBeenCalledWith("pr_conversation_action", { url: pr.url, action: { kind: "edit", title: "Updated title", body: "Updated description", expectedTitle: pr.title, expectedBody: "Original description" } });
});

it.each([true, false])("keeps one checks list with summaries, requirements, queue details and log actions (inline=%s)", async (inline) => {
  current.requiredChecks = ["test", "lint"];
  current.mergeQueueEntry = { position: 3, state: "AWAITING_CHECKS" };
  current.deployments = [{ name: "Preview", state: "success", url: "https://preview.example.test/" }];
  // A source without a checkout path: the log opens under the list, as a cloud workspace's does.
  render(<PrPanel source={localGitSource("/repo")} branch="feature" active busy={false} inline={inline} />);
  fireEvent.click(await screen.findByRole("button", { name: "View logs for test" }));
  await screen.findByText("error: assertion failed");
  expect(screen.getAllByText("3 of 4 checks failed")).toHaveLength(1);
  expect(screen.getAllByLabelText("test: failure")).toHaveLength(1);
  // Only a check the merge needs is marked; an optional one carries nothing (PRO-394).
  expect(screen.getAllByText("required")).toHaveLength(2);
  expect(screen.queryByText(/^optional$/i)).toBeNull();
  expect(screen.getByText("Queue position 3")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Deployments" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Re-run failed" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Re-run test" })).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledWith("pr_check_log", { cwd: "/repo", prUrl: pr.url, checkUrl: pr.checks[0].url, failed: true });
  fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith("error: assertion failed"));
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(expect.stringContaining("Run: 12 · Job: 34")));
  fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
  expect(openUrl).toHaveBeenCalledWith(pr.checks[0].url);
  expect(screen.queryByRole("button", { name: "View logs for external CI" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open on GitHub: external CI" }));
  expect(openUrl).toHaveBeenCalledWith("https://ci.example.com/check/4");
});

it("opens a check's log in a centre tab of the session, and marks the check while it is shown (PRO-394)", async () => {
  const backend = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === "pr_associations" ? [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: "/repo" } }]
    : command === "pr_details" ? current : backend(command, ...args));
  render(<PrPanel cwd="/repo" sessionId="s1" branch="feature" active busy={false} inline />);
  fireEvent.click(await screen.findByRole("button", { name: "View logs for test" }));
  const tab = getEditors().editors.find((entry) => entry.kind === "checkLog");
  expect(tab).toMatchObject({ sessionId: "s1", root: "/repo", name: "test · log", failures: 3, check: { prUrl: pr.url, prNumber: 1, name: "test", url: pr.checks[0].url, runId: 12, jobId: 34, state: "failure" } });
  // Nothing opened under the list.
  expect(screen.queryByRole("region", { name: "Logs for test" })).toBeNull();
});
it("reruns each failing workflow once and keeps it queued through stale GitHub responses", async () => {
  show(false);
  const button = await screen.findByRole("button", { name: "Re-run failed" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByLabelText("test: queued");
  await screen.findByLabelText("lint: queued");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_rerun")).toEqual([["pr_check_rerun", { cwd: "/repo", prUrl: pr.url, checkUrl: pr.checks[1].url, failed: true, authority: { owner: "test-policy", epoch: 0 } }]]);
  expect(screen.getByLabelText("deploy: success")).toBeTruthy();
  current = { ...pr, checks: pr.checks.map((c) => c.actions?.runId === 12 ? { ...c, state: "in_progress", url: c.url + "0" } : c) };
  fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
  await screen.findByLabelText("test: in_progress");
});

it("reruns all includes successful workflows, and a refusal says GitHub's reason in a toast, never queued", async () => {
  current.checks = current.checks.filter((check) => check.actions).map((check) => ({ ...check, state: "success" }));
  const source = { ...localGitSource("/repo"), rerunCheck: vi.fn().mockRejectedValueOnce(new Error("gh run rerun 12 --repo owner/repo: run 12 cannot be rerun; its workflow file may be broken (HTTP 403)")).mockResolvedValue(undefined) };
  render(<PrPanel source={source} branch="feature" active busy={false} />);
  const button = await screen.findByRole("button", { name: "Re-run" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  // PRO-394 (design 05.17): not a Git error card, a toast naming the PR with GitHub's own reason and the run.
  await waitFor(() => expect(getErrorToasts()).toHaveLength(1));
  expect(getErrorToasts()[0]).toMatchObject({ title: "Couldn't re-run checks on #1", action: "Run 12 cannot be rerun; its workflow file may be broken", tone: "error" });
  expect(getErrorToasts()[0].actions?.map((action) => action.label)).toEqual(["Open run on GitHub"]);
  expect(screen.queryByText("Could not complete Git operation")).toBeNull();
  expect(screen.queryByLabelText("test: queued")).toBeNull();
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByLabelText("deploy: queued");
  expect(source.rerunCheck).toHaveBeenLastCalledWith(pr.url, pr.checks[2].url, false, { owner: "test-policy", epoch: 0 });
});

it("discards late log responses after a different check is selected", async () => {
  let resolve!: (log: { text: string; truncated: boolean }) => void;
  const source = { ...localGitSource("/repo"), checkLog: vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue({ text: "lint error", truncated: false }) };
  render(<PrPanel source={source} branch="feature" active busy={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "View logs for test" }));
  fireEvent.click(screen.getByRole("button", { name: "View logs for lint" }));
  await screen.findByText("lint error");
  await act(async () => resolve({ text: "stale test error", truncated: false }));
  expect(screen.queryByText("stale test error")).toBeNull();
});

it("clears a clipboard error after retry without hiding a failed log download", async () => {
  const source = { ...localGitSource("/repo"), checkLog: vi.fn().mockRejectedValue(new Error("Logs expired")) };
  vi.mocked(copyText).mockRejectedValueOnce(new Error("Clipboard unavailable"));
  render(<PrPanel source={source} branch="feature" active busy={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "View logs for test" }));
  await screen.findByText("Logs expired");
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await screen.findByText("Clipboard unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await screen.findByText("Details copied");
  expect(screen.queryByText("Clipboard unavailable")).toBeNull();
  expect(screen.getByText("Logs expired")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("selects the clicked check when several checks share a run-only details URL", async () => {
  current.checks[0].url = current.checks[1].url = "https://github.com/owner/repo/actions/runs/12";
  current.checks[0].actions!.jobId = current.checks[1].actions!.jobId = null;
  render(<PrPanel source={localGitSource("/repo")} branch="feature" active busy={false} inline />);
  fireEvent.click(await screen.findByRole("button", { name: "View logs for lint" }));
  await screen.findByRole("region", { name: "Logs for lint" });
  expect(screen.queryByRole("region", { name: "Logs for test" })).toBeNull();
});

it("expires optimistic running state instead of concealing a failed attempt forever", () => {
  const pending = [{ prUrl: pr.url, runId: 12, failedOnly: true, signature: runSignature(pr, 12), until: 100 }];
  expect(withPendingChecks(pr, pending, 99).checks[0].state).toBe("queued");
  expect(withPendingChecks(pr, pending, 101)).toBe(pr);
  const passing = { ...pr, checks: pr.checks.filter((c) => c.actions).map((c) => ({ ...c, state: "success" })) };
  expect(mergeReadiness(passing).ok).toBe(true);
  expect(mergeReadiness(withPendingChecks(passing, [{ ...pending[0], failedOnly: false, signature: runSignature(passing, 12) }], 99))).toEqual({ ok: false, label: "Waiting for 2 checks", waiting: 2 });
});
