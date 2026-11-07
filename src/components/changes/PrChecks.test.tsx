import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText } from "@/lib/clipboard";
import { type PullRequest } from "@/lib/api";
import { localGitSource } from "@/lib/gitSource";
import { runSignature, withPendingChecks } from "@/lib/checks";
import { mergeReadiness, PrPanel } from "./PrPanel";

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
    if (command === "work_status") return { branch: "feature", defaultBranch: "main", aheadOfBase: 1 };
    if (command === "pr_list") return [current];
    if (command === "pr_check_log") return { text: "^[[31merror: assertion failed^[[0m", truncated: true };
    if (command === "pr_check_rerun") return;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);
const show = (inline = true) => render(<PrPanel cwd="/repo" branch="feature" active busy={false} inline={inline} />);

it.each([true, false])("keeps one checks list with summaries, requirements, queue details and log actions (inline=%s)", async (inline) => {
  current.requiredChecks = ["test", "lint"];
  current.mergeQueueEntry = { position: 3, state: "AWAITING_CHECKS" };
  current.deployments = [{ name: "Preview", state: "success", url: "https://preview.example.test/" }];
  show(inline);
  fireEvent.click(await screen.findByRole("button", { name: "View logs for test" }));
  await screen.findByText("error: assertion failed");
  expect(screen.getAllByText("3 of 4 failed")).toHaveLength(1);
  expect(screen.getAllByLabelText("test: failure")).toHaveLength(1);
  expect(screen.getAllByText("Required")).toHaveLength(2);
  expect(screen.getAllByText("Optional")).toHaveLength(2);
  expect(screen.getByText("Queue position 3")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Deployments" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Re-run failed" })).toHaveLength(1);
  expect(mocks.invoke).toHaveBeenCalledWith("pr_check_log", { cwd: "/repo", prUrl: pr.url, checkUrl: pr.checks[0].url, failed: true });
  fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith("error: assertion failed"));
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(expect.stringContaining("Run: 12 · Job: 34")));
  fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
  expect(openUrl).toHaveBeenCalledWith(pr.checks[0].url);
  expect(screen.queryByRole("button", { name: "View logs for external CI" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open on GitHub: external CI" }));
  expect(openUrl).toHaveBeenCalledWith(pr.url + "/checks");
});

it("reruns each failing workflow once and keeps it queued through stale GitHub responses", async () => {
  show(false);
  const button = await screen.findByRole("button", { name: "Re-run failed" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByLabelText("test: queued");
  await screen.findByLabelText("lint: queued");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_rerun")).toEqual([["pr_check_rerun", { cwd: "/repo", prUrl: pr.url, checkUrl: pr.checks[1].url, failed: true }]]);
  expect(screen.getByLabelText("deploy: success")).toBeTruthy();
  current = { ...pr, checks: pr.checks.map((c) => c.actions?.runId === 12 ? { ...c, state: "in_progress", url: c.url + "0" } : c) };
  fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
  await screen.findByLabelText("test: in_progress");
});

it("reruns all includes successful workflows, and a refusal never shows queued", async () => {
  const source = { ...localGitSource("/repo"), rerunCheck: vi.fn().mockRejectedValueOnce(new Error("GitHub denied re-run")).mockResolvedValue(undefined) };
  render(<PrPanel source={source} branch="feature" active busy={false} />);
  const button = await screen.findByRole("button", { name: "Re-run all" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByText("GitHub denied re-run");
  expect(screen.queryByLabelText("test: queued")).toBeNull();
  // The refusal remains readable while a fresh snapshot enables another try.
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByLabelText("deploy: queued");
  expect(source.rerunCheck).toHaveBeenLastCalledWith(pr.url, pr.checks[2].url, false);
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
  show();
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
  expect(mergeReadiness(withPendingChecks(passing, [{ ...pending[0], failedOnly: false, signature: runSignature(passing, 12) }], 99))).toEqual({ ok: false, label: "Checks running" });
});
