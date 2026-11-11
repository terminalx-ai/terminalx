import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { StartFromPicker } from "./StartFromPicker";
import { api, gh, issues, type Issue, type PullRequest } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { listBranches: vi.fn() }, gh: { search: vi.fn() }, issues: { list: vi.fn(), linearStatus: vi.fn() }, errorMessage: String }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => ({ issueProvider: "github" }), setPrefs: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  refreshWorkspaces: vi.fn(async () => {}),
  useSessionStore: () => ({ workspaces: { "/repo": [{ path: "/repo/wt", branch: "feature/in-use", name: "wt" }] }, sessions: [{ id: "existing", projectPath: "/repo", cwd: "/repo/wt", modified: "2026-01-01" }] }),
}));
const pr = { number: 12, title: "Fix parser", author: "alice", state: "OPEN" } as PullRequest;
const issue = { id: "i", identifier: "PRO-12", title: "Fix issue", state: "Todo" } as Issue;
const branch = vi.fn(), pickIssue = vi.fn(), pickPr = vi.fn(), session = vi.fn();
function Harness() {
  const [open, setOpen] = useState(true);
  return <StartFromPicker projectPath="/repo" defaultBranch="main" label="New branch" open={open} onOpenChange={setOpen} onBranch={branch} onIssue={pickIssue} onPr={pickPr} onSession={session} disabled={false} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.listBranches).mockResolvedValue([{ name: "feature/other", remote: false, current: false }, { name: "origin/feature/other", remote: true, current: false }]);
  vi.mocked(gh.search).mockResolvedValue([pr]);
  vi.mocked(issues.list).mockResolvedValue([issue]);
});
afterEach(cleanup);

it("opens an in-use branch's session with the keyboard and deduplicates remote branches", async () => {
  render(<Harness />);
  const input = screen.getByRole("combobox", { name: "Search branches, issues or pull requests" });
  await screen.findByRole("option", { name: "feature/other New worktree" });
  expect(screen.queryByText("origin/feature/other")).toBeNull();
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "feature/in-use In use · Open session" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(session).toHaveBeenCalledWith("existing");
  expect(branch).not.toHaveBeenCalled();
});

it("chooses an unused branch with search and Enter", async () => {
  render(<Harness />);
  fireEvent.change(screen.getByRole("combobox", { name: "Search branches, issues or pull requests" }), { target: { value: "other" } });
  await screen.findByRole("option", { name: "feature/other New worktree" });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search branches, issues or pull requests" }), { key: "Enter" });
  expect(branch).toHaveBeenCalledWith({ kind: "existing", branch: "feature/other" });
});

it("reaches Issues and Pull requests from the tab strip using only keys", async () => {
  render(<Harness />);
  const branches = screen.getByRole("tab", { name: "Branches" });
  branches.focus();
  fireEvent.keyDown(branches, { key: "ArrowRight" });
  await waitFor(() => expect(screen.getByRole("tab", { name: "Issues" }).getAttribute("aria-selected")).toBe("true"));
  await screen.findByRole("option", { name: /PRO-12 Fix issue/ });
  const input = screen.getByRole("combobox", { name: "Search branches, issues or pull requests" });
  input.focus();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(pickIssue).toHaveBeenCalledWith(issue);
  fireEvent.click(screen.getByRole("button", { name: "Start from" }));
  const issuesTab = screen.getByRole("tab", { name: "Issues" });
  issuesTab.focus();
  fireEvent.keyDown(issuesTab, { key: "ArrowRight" });
  await waitFor(() => expect(screen.getByRole("tab", { name: "Pull requests" }).getAttribute("aria-selected")).toBe("true"));
  fireEvent.change(screen.getByRole("combobox", { name: "Search branches, issues or pull requests" }), { target: { value: "12" } });
  await screen.findByRole("option", { name: /#12 Fix parser/ });
  expect(gh.search).toHaveBeenLastCalledWith("/repo", "12");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search branches, issues or pull requests" }), { key: "Enter" });
  expect(pickPr).toHaveBeenCalledWith(pr);
});

it("shows provider errors and lets Linear connect without a second search field", async () => {
  vi.mocked(issues.list).mockRejectedValue(new Error("GitHub offline"));
  vi.mocked(issues.linearStatus).mockResolvedValue({ connected: false } as Awaited<ReturnType<typeof issues.linearStatus>>);
  render(<Harness />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Issues" }), { button: 0 });
  expect((await screen.findByRole("alert")).textContent).toContain("GitHub offline");
  fireEvent.change(screen.getByRole("combobox", { name: "Issue tracker" }), { target: { value: "linear" } });
  await screen.findByTestId("connect-linear");
  expect(screen.getAllByRole("combobox", { name: "Search branches, issues or pull requests" })).toHaveLength(1);
});
