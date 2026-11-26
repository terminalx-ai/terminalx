import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

// A read of the repository that fails says so where it was asked for, and its Retry reads it again (3.6).
const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./FileDiff", () => ({ FileDiff: () => null }));
const { RepoPanel } = await import("./RepoPanel");

const cwd = "/repos/alpha";
const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const commit = (sha: string, parent: string | null, subject: string) => ({ sha, shortSha: sha.slice(0, 7), subject, body: "", author: "Ann", email: "ann@x.io", date: "2026-10-01T00:00:00Z", parent, tree: `${sha.slice(0, 4)}tree` });
const fails = new Set<string>();
const calls = (command: string) => backend.invoke.mock.calls.filter(([name]) => name === command).length;

beforeEach(() => {
  fails.clear();
  backend.invoke.mockImplementation(async (command: string, args?: { range?: string | null }) => {
    if (fails.has(command)) throw new Error(`${command} failed`);
    switch (command) {
      case "git_has_remote": return true;
      case "work_status": return { isRepo: true, branch: "feature", upstream: null, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 0, head: "abc", dirty: false };
      case "working_changes": return ["abc", []];
      case "working_change_sets": return ["abc", "index", [], []];
      case "log_commits": return args?.range === PARENT ? [commit(PARENT, null, "Base")] : [commit(SHA, PARENT, "Add form")];
      case "changes_between": return fails.has("commit_files") ? Promise.reject(new Error("diff failed")) : [{ path: "src/form.ts", status: "modified", additions: 1, deletions: 0 }];
      default: return null;
    }
  });
});
afterEach(async () => { await act(async () => cleanup()); backend.invoke.mockReset(); });

it("says the branch status could not be read, and reads it again on Retry", async () => {
  fails.add("work_status");
  render(<TooltipProvider><RepoPanel cwd={cwd} active view="uncommitted" onViewChange={() => {}} /></TooltipProvider>);
  const alert = (await screen.findByText(/Couldn’t read the branch status. work_status failed/)).closest("[role=alert]") as HTMLElement;
  const before = calls("work_status");
  fails.delete("work_status");
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(calls("work_status")).toBeGreaterThan(before));
  await waitFor(() => expect(screen.queryByText(/Couldn’t read the branch status/)).toBeNull());
});

it("says a commit's files could not be read, and reads them again on Retry", async () => {
  fails.add("commit_files");
  render(<TooltipProvider><RepoPanel cwd={cwd} active view="history" onViewChange={() => {}} /></TooltipProvider>);
  fireEvent.click(await screen.findByText("Add form"));
  const alert = (await screen.findByText(/Couldn’t read this commit. diff failed/)).closest("[role=alert]") as HTMLElement;
  const before = calls("changes_between");
  fails.delete("commit_files");
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(calls("changes_between")).toBeGreaterThan(before));
  await waitFor(() => expect(screen.queryByText(/Couldn’t read this commit/)).toBeNull());
});
