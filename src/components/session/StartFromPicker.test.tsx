import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { StartFromPicker, branchByline, updatedLine, type StartFromTab } from "./StartFromPicker";
import { api, gh, issues, type Issue, type PullRequest } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { listBranches: vi.fn() }, gh: { search: vi.fn() }, issues: { list: vi.fn(), linearStatus: vi.fn() }, errorMessage: String }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => ({ issueProvider: "github" }), setPrefs: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  refreshWorkspaces: vi.fn(async () => {}),
  useSessionStore: () => ({ workspaces: { "/repo": [{ path: "/repo/wt", branch: "feature/in-use", name: "wt" }] }, sessions: [{ id: "existing", title: "Continue parser work", projectPath: "/repo", cwd: "/repo/wt", modified: "2026-01-01" }] }),
}));
const pr = { number: 12, title: "Fix parser", author: "alice", state: "OPEN" } as PullRequest;
const issue = { id: "i", identifier: "PRO-12", title: "Fix issue", state: "Todo" } as Issue;
const branch = vi.fn(), pickIssue = vi.fn(), pickPr = vi.fn(), session = vi.fn();
function Harness({ tab = "branches" }: { tab?: StartFromTab }) {
  const [open, setOpen] = useState(true);
  return <StartFromPicker projectPath="/repo" defaultBranch="main" initialTab={tab} open={open} onOpenChange={setOpen} onBranch={branch} onIssue={pickIssue} onPr={pickPr} onSession={session} disabled={false} />;
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

it("opens on Pull requests, in the order Pull requests, Branches, Issues, and Tab in the search goes to the next list", async () => {
  render(<Harness tab="prs" />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Pull requests", "Branches", "Issues"]);
  expect(screen.getByRole("tab", { name: "Pull requests" }).getAttribute("aria-selected")).toBe("true");
  const input = screen.getByRole("combobox", { name: "Search branches, issues or pull requests" });
  for (const next of ["Branches", "Issues", "Pull requests"]) {
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(screen.getByRole("tab", { name: next }).getAttribute("aria-selected")).toBe("true");
  }
  // Shift+Tab is left alone: it walks back to the tabs and the tracker buttons.
  expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(true);
  expect(screen.getByTestId("start-from-keys").textContent).toBe("↑↓ move↵ selectTab next listesc close");
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
  fireEvent.mouseDown(issuesTab, { button: 0 });
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
  expect(screen.getByRole("alert").textContent).toContain("GitHub issues couldn’t load");
  expect(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Issue tracker" })).toBeNull();
  fireEvent.click(within(screen.getByRole("group", { name: "Issue tracker" })).getByRole("button", { name: "Linear" }));
  await screen.findByTestId("connect-linear");
  expect(screen.getAllByRole("combobox", { name: "Search branches, issues or pull requests" })).toHaveLength(1);
});

it("says who has an in-use branch, marks the default branch and gives the others their author and age", async () => {
  const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
  vi.mocked(api.listBranches).mockResolvedValue([
    { name: "main", remote: false, current: true, updated: hours(2), author: "Paresh Dudhat" },
    { name: "feature/other", remote: false, current: false, updated: hours(72), author: "alex-kim" },
  ]);
  render(<Harness />);
  const main = await screen.findByRole("option", { name: "main New worktree" });
  expect(main.textContent).toBe("maindefault branch · updated 2h agoPD · 2h");
  expect(screen.getByRole("option", { name: "feature/other New worktree" }).textContent).toBe("feature/otherAK · 3d");
  const used = screen.getByRole("option", { name: "feature/in-use In use · Open session" });
  expect(used.textContent).toBe("feature/in-useIn use by “Continue parser work”In use · Open session");
  // Branch names are code: set in the mono face.
  expect(within(used).getByText("feature/in-use").className).toContain("font-mono");
});

it("gives a pull request its number, branch and checks, where a fork's comes from, and opens the session that has it", async () => {
  vi.mocked(gh.search).mockResolvedValue([
    { number: 12, title: "Fix parser", author: "alice", state: "OPEN", isDraft: false, head: "alice/parser", headRepository: "alice/app", checks: [{ name: "ci", state: "failure" }, { name: "lint", state: "failure" }] },
    { number: 14, title: "Continue parser work", author: "bob", state: "OPEN", isDraft: false, head: "feature/in-use", checks: [{ name: "ci", state: "success" }] },
    { number: 15, title: "Sketch", author: "bob", state: "OPEN", isDraft: true, head: "bob/sketch", checks: [] },
  ] as unknown as PullRequest[]);
  render(<Harness tab="prs" />);
  const fork = await screen.findByRole("option", { name: /#12 Fix parser/ });
  expect(fork.textContent).toBe("#12Fix parserfrom alice/appalice/parser · 2 checks failingOpenAL");
  expect(fork.querySelector("[data-pr-state]")?.getAttribute("data-pr-state")).toBe("failing");
  expect(screen.getByRole("option", { name: /#15 Sketch/ }).textContent).toBe("#15Sketchbob/sketchDraftBO");
  const used = screen.getByRole("option", { name: /#14 Continue parser work/ });
  expect(used.textContent).toBe("#14Continue parser workfeature/in-use · checks passedIn use · Open sessionBO");
  fireEvent.click(used);
  expect(session).toHaveBeenCalledWith("existing");
  expect(pickPr).not.toHaveBeenCalled();
});

it("says an empty list and a failed one as cards, and reads a failed list again on Try again", async () => {
  vi.mocked(gh.search).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("HTTP 401: Bad credentials")).mockResolvedValue([pr]);
  render(<Harness tab="prs" />);
  const empty = await screen.findByTestId("start-from-state");
  expect(empty.getAttribute("role")).toBe("status");
  expect(empty.textContent).toBe("No pull requests foundThis repository has no open pull requests.");
  fireEvent.change(screen.getByRole("combobox", { name: "Search branches, issues or pull requests" }), { target: { value: "relay" } });
  const failed = await screen.findByRole("alert");
  expect(failed.textContent).toContain("GitHub isn’t connected");
  expect(failed.textContent).toContain("Bad credentials");
  fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  await screen.findByRole("option", { name: /#12 Fix parser/ });
});

it("words a branch's age and its last author", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  expect(updatedLine("2026-11-16T10:00:00Z", now)).toBe("updated 2h ago");
  expect(updatedLine("2026-11-16T11:59:50Z", now)).toBe("updated just now");
  expect(updatedLine(undefined, now)).toBeNull();
  expect(branchByline({ author: "Alex Kim", updated: "2026-11-13T12:00:00Z" }, now)).toBe("AK · 3d");
  expect(branchByline({}, now)).toBe("");
});
