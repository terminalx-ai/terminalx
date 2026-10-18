import { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";
import type { Issue, IssueFilter } from "@/lib/api";
import type { IssueDetails, IssueProvider } from "@/lib/issueOps";
import { forgetIssueViewers } from "@/lib/issueViewer";
import { createIssueOpsMock, githubIssueFixture, linearIssueFixture, type IssueOpsMock } from "@/test/issueOpsMock";
import type { Project } from "@/types/session";

const { invoke, sessionStore } = vi.hoisted(() => ({
  invoke: vi.fn(),
  sessionStore: {
    projects: [{ path: "/repo", name: "Widgets" }] as Project[],
    harnesses: [{ id: "claude", name: "Claude Code", available: true, installHint: "", caps: {} }],
    selectedProject: "/repo",
    sessions: [],
    newSessionPreset: null,
    workspaces: {},
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/hotkeys", () => ({ hasEscapeOverlay: () => false, useHeldShortcut: vi.fn(), useHotkey: vi.fn(), useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [],
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
vi.mock("@/lib/issuePipeline", async (original) => ({
  ...(await original<typeof import("@/lib/issuePipeline")>()),
  useIssuePipelines: () => [],
}));
vi.mock("@/lib/sessions", () => ({
  openAutomation: vi.fn(),
  selectProject: vi.fn(),
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  useSessionStore: () => sessionStore,
}));

const { IssuesView } = await import("./IssuesView");

let tracker: IssueOpsMock;

const githubIssue = (id: number, title: string, patch: Partial<IssueDetails> = {}): IssueDetails => ({
  ...githubIssueFixture(),
  id: String(id), number: id, identifier: `#${id}`, title, url: `https://github.com/acme/widgets/issues/${id}`, ...patch,
});
const shipDocs = (): IssueDetails => ({
  ...linearIssueFixture(),
  id: "linear-7", identifier: "ENG-7", number: 7, title: "Ship the docs", url: "https://linear.app/acme/issue/ENG-7",
  state: "Done", stateType: "completed", workflowStateType: "completed", stateId: "state-done", labels: [],
});

/**
 * The list as each tracker filters it, from the mock's issues: GitHub by open
 * or closed and every label, Linear by state type and any label.
 */
function list(provider: IssueProvider, filter: IssueFilter): Issue[] {
  const closed = (issue: Issue) => issue.stateType === "completed" || issue.stateType === "canceled";
  return [...tracker.issues.values()]
    .map(({ issue }) => issue)
    .filter((issue) => issue.provider === provider)
    .filter((issue) => {
      const state = filter.state ?? "open";
      if (state === "open" && closed(issue)) return false;
      if (state === "closed" && !closed(issue)) return false;
      if (!["open", "closed", "all"].includes(state) && issue.workflowStateType !== state) return false;
      const assignee = filter.assignee;
      if (assignee?.kind === "me" && !issue.assignees.some((person) => person.id === tracker.viewer[provider].id)) return false;
      if (assignee?.kind === "unassigned" && issue.assignees.length) return false;
      if (assignee?.kind === "person" && !issue.assignees.some((person) => person.id === assignee.id)) return false;
      const labels = filter.labels ?? [];
      const has = (name: string) => issue.labels.some((label) => label.name === name);
      return !labels.length || (provider === "github" ? labels.every(has) : labels.some(has));
    })
    .map(({ provider, id, identifier, number, title, url, state, stateType, workflowStateType, labels, assignee, assignees, updatedAt, body, team }) =>
      ({ provider, id, identifier, number, title, url, state, stateType, workflowStateType, labels, assignee, assignees, updatedAt, body: provider === "linear" ? body : null, team }));
}

beforeEach(() => {
  forgetIssueViewers();
  tracker = createIssueOpsMock({
    issues: [
      githubIssueFixture(),
      githubIssue(44, "Tidy the settings page", { labels: [], assignees: [], assignee: null }),
      githubIssue(43, "Old crash on launch", { state: "Closed", stateType: "completed", closeReason: "completed" }),
      linearIssueFixture(),
      shipDocs(),
    ],
  });
  setPrefs({ issueProvider: "github", issueFilters: {}, lastProject: "/repo" });
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    const answered = tracker.handle(command, args);
    if (answered) return answered;
    if (command === "linear_status") return { connected: true };
    if (command === "linear_teams") return [{ id: "team-eng", key: "ENG", name: "Engineering" }];
    if (command === "gh_available") return true;
    if (command === "github_repo") return "acme/widgets";
    if (command === "work_status") return { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", ahead: 0, behind: 0, aheadOfBase: 0, head: "abc" };
    if (command === "preview_workspace_name") return "fix-login-timeout";
    if (command === "issues_list") return list(args?.provider as IssueProvider, args?.filter as IssueFilter);
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

/** The filter the list was last read with. */
const lastAsked = () => {
  const calls = invoke.mock.calls.filter(([command]) => command === "issues_list");
  return calls[calls.length - 1]?.[1] as { provider: string; filter: IssueFilter } | undefined;
};
const row = (title: string) => screen.getAllByText(title).find((node) => node.closest("li"))!.closest("li")!.querySelector("button")!;
const listed = (title: string) => screen.queryAllByText(title).some((node) => node.closest("li"));

/** Waits for a popover to close, and for the focus to go back where it came from. */
const closed = (name: string) => waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull()).then(() => act(() => new Promise((resolve) => setTimeout(resolve, 0))));

async function pick(menu: RegExp, item: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: menu }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: item }));
}

describe("the issue list's filters", () => {
  it("narrow and sort the list on the tracker, and are kept per project and tracker", async () => {
    render(<IssuesView />);
    await screen.findByText("Repair the login timeout");
    expect(listed("Old crash on launch")).toBe(false);

    await pick(/^State: /, "Closed");
    await waitFor(() => expect(lastAsked()?.filter.state).toBe("closed"));
    await waitFor(() => expect(listed("Old crash on launch")).toBe(true));
    expect(listed("Repair the login timeout")).toBe(false);

    // GitHub has no priority to sort by.
    fireEvent.keyDown(screen.getByRole("button", { name: "Sort: Recently updated" }), { key: "Enter" });
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["Recently updated", "Newest", "Oldest"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Oldest" }));
    await waitFor(() => expect(lastAsked()?.filter.sort).toBe("created_asc"));

    fireEvent.click(screen.getByRole("button", { name: "Labels: any" }));
    const labels = await screen.findByRole("dialog", { name: "Filter by labels" });
    fireEvent.click(await within(labels).findByRole("option", { name: "bug" }));
    fireEvent.click(within(labels).getByRole("option", { name: "enhancement" }));
    expect(within(labels).getByText("Issues with all of these")).toBeTruthy();
    await waitFor(() => expect(lastAsked()?.filter.labels).toEqual(["bug", "enhancement"]));
    fireEvent.keyDown(within(labels).getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    await closed("Filter by labels");

    fireEvent.click(screen.getByRole("button", { name: "Assignee: Anyone" }));
    const people = await screen.findByRole("dialog", { name: "Filter by assignee" });
    fireEvent.click(await within(people).findByRole("option", { name: "alex" }));
    await waitFor(() => expect(lastAsked()?.filter.assignee).toEqual({ kind: "person", id: "alex" }));
    expect(screen.getByRole("button", { name: "Assignee: alex" })).toBeTruthy();

    expect(getPrefs().issueFilters["/repo\ngithub"]).toEqual({
      state: "closed", sort: "created_asc", labels: ["bug", "enhancement"], assignee: { kind: "person", id: "alex", name: "alex" }, teamId: null,
    });

    // Linear starts from its own default, with its state types and priority.
    fireEvent.click(screen.getByRole("radio", { name: "Linear" }));
    await screen.findByText("Fix login timeout");
    expect(lastAsked()).toMatchObject({ provider: "linear", filter: { state: "open", sort: "updated", labels: [], assignee: null } });
    fireEvent.keyDown(screen.getByRole("button", { name: "State: Open" }), { key: "Enter" });
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["Open", "Triage", "Backlog", "Unstarted", "Started", "Completed", "Canceled", "All"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await pick(/^Sort: /, "Priority");
    await waitFor(() => expect(lastAsked()?.filter.sort).toBe("priority"));
    fireEvent.click(screen.getByRole("button", { name: "Labels: any" }));
    expect(await screen.findByText("Issues with any of these")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    await closed("Filter by labels");

    // And GitHub's comes back as it was left.
    fireEvent.click(screen.getByRole("radio", { name: "GitHub" }));
    expect(await screen.findByRole("button", { name: "State: Closed" })).toBeTruthy();
    await waitFor(() => expect(lastAsked()).toMatchObject({ provider: "github", filter: { state: "closed", sort: "created_asc" } }));
  });

  it("lists closed GitHub issues and reopens one, which stays in place, dimmed and selected, until the refresh", async () => {
    setPrefs({ issueFilters: { "/repo\ngithub": { state: "closed" } } });
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Old crash on launch"));
    const status = await screen.findByRole("button", { name: "Status: Closed as completed" });
    fireEvent.keyDown(status, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reopen" }));
    await screen.findByRole("button", { name: "Status: Open" });
    expect(tracker.issue("github", "43").state).toBe("Open");

    const reopened = row("Old crash on launch");
    expect(within(reopened).getByText("Now Open")).toBeTruthy();
    expect(within(reopened).getByText("Open")).toBeTruthy();
    expect(reopened.className).toContain("opacity-60");
    expect(reopened.getAttribute("aria-current")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listed("Old crash on launch")).toBe(false));
    // The issue is still the one open on the right.
    expect(screen.getByTestId("issue-detail").textContent).toContain("Old crash on launch");
    expect(screen.getByRole("button", { name: "Status: Open" })).toBeTruthy();
  });

  it("lists completed Linear issues and moves one back to work, keeping the selection", async () => {
    setPrefs({ issueProvider: "linear", issueFilters: { "/repo\nlinear": { state: "completed" } } });
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Ship the docs"));
    await waitFor(() => expect(lastAsked()?.filter.state).toBe("completed"));
    expect(listed("Fix login timeout")).toBe(false);
    const status = await screen.findByRole("button", { name: "Status: Done" });
    fireEvent.keyDown(status, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "In Progress" }));
    await screen.findByRole("button", { name: "Status: In Progress" });
    const moved = row("Ship the docs");
    expect(within(moved).getByText("Now In Progress")).toBeTruthy();
    expect(moved.getAttribute("aria-current")).toBe("true");
  });

  it("dims a row whose labels no longer match, and leaves one that still does", async () => {
    setPrefs({ issueFilters: { "/repo\ngithub": { labels: ["bug"] } } });
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit labels" }));
    fireEvent.click(await screen.findByRole("option", { name: "enhancement" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    await waitFor(() => expect(tracker.issue("github", "41").labels.map((label) => label.name)).toEqual(["bug", "enhancement"]));
    expect(within(row("Repair the login timeout")).queryByText("Labels changed")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
    fireEvent.click(await screen.findByRole("option", { name: "bug" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    expect(await within(row("Repair the login timeout")).findByText("Labels changed")).toBeTruthy();
  });
});

describe("a list read that is older than a change made here", () => {
  /** Holds the next `issues_list` until the returned function is called; its answer is what the tracker held when it was asked. */
  function holdNextList() {
    const answer = invoke.getMockImplementation()!;
    let release = () => {};
    let held = false;
    invoke.mockImplementation((name: string, args?: Record<string, unknown>) => {
      if (name !== "issues_list" || held) return answer(name, args);
      held = true;
      const then = answer(name, args);
      return new Promise((resolve) => (release = () => resolve(then)));
    });
    return {
      /** Once the read is out (the list's GitHub read waits a moment first). */
      asked: () => waitFor(() => expect(held).toBe(true)),
      release: () => act(async () => release()),
    };
  }

  async function removeBug() {
    fireEvent.click(await screen.findByRole("button", { name: "Edit labels" }));
    fireEvent.click(await screen.findByRole("option", { name: "bug" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    await waitFor(() => expect(tracker.issue("github", "41").labels).toEqual([]));
  }

  it("does not put back a label removed while it was on its way", async () => {
    setPrefs({ issueFilters: { "/repo\ngithub": { labels: ["bug"] } } });
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    await screen.findByRole("button", { name: "Edit labels" });
    const read = holdNextList();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await read.asked();
    await removeBug();
    await read.release();
    const listedRow = row("Repair the login timeout");
    expect(within(listedRow).queryByText("bug")).toBeNull();
    expect(within(listedRow).getByText("Labels changed")).toBeTruthy();
  });

  it("keeps a change the provider's list doesn't show yet, until a read that does", async () => {
    setPrefs({ issueFilters: { "/repo\ngithub": { labels: ["bug"] } } });
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    await screen.findByRole("button", { name: "Edit labels" });
    // GitHub's lists lag a write by a few seconds: a read made just after it still has the label.
    const before = structuredClone(tracker.issue("github", "41"));
    await removeBug();
    const answer = invoke.getMockImplementation()!;
    invoke.mockImplementation((name: string, args?: Record<string, unknown>) =>
      name === "issues_list" ? Promise.resolve(answer(name, args)).then((rows) => (rows as Issue[]).concat(rows && !(rows as Issue[]).some((each) => each.id === "41") ? [{ ...before, body: null }] : [])) : answer(name, args));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "issues_list").length).toBeGreaterThan(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const listedRow = row("Repair the login timeout");
    expect(within(listedRow).queryByText("bug")).toBeNull();
    expect(within(listedRow).getByText("Labels changed")).toBeTruthy();

    // Once the list has caught up, the issue is no longer in it.
    invoke.mockImplementation(answer);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listed("Repair the login timeout")).toBe(false));
  });
});

describe("the issue list's keys", () => {
  const view = () => screen.getByTestId("issues-view");
  const current = () => screen.getAllByRole("button").find((button) => button.getAttribute("aria-current") === "true")?.textContent ?? "";

  it("move through the list with Up and Down, but not while typing", async () => {
    render(<IssuesView />);
    await screen.findByText("Tidy the settings page");
    view().focus();
    fireEvent.keyDown(view(), { key: "ArrowDown" });
    await waitFor(() => expect(current()).toContain("Repair the login timeout"));
    expect(document.activeElement).toBe(row("Repair the login timeout"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(current()).toContain("Tidy the settings page"));
    // The last row stays where it is.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(current()).toContain("Tidy the settings page");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    await waitFor(() => expect(current()).toContain("Repair the login timeout"));

    const search = screen.getByRole("textbox", { name: "Search issues" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "s" });
    expect(current()).toContain("Repair the login timeout");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leave Up and Down to the detail pane while it has the focus, where they scroll the issue", async () => {
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    await screen.findByRole("button", { name: "Status: Open" });
    const pane = screen.getByTestId("issue-detail");
    pane.focus();
    // Not taken: the browser scrolls the pane.
    expect(fireEvent.keyDown(pane, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(pane, { key: "ArrowUp" })).toBe(true);
    expect(current()).toContain("Repair the login timeout");
    expect(document.activeElement).toBe(pane);
  });

  it("open the status, assignee and label pickers and go to the comment box, but not mid-composition", async () => {
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    await screen.findByRole("button", { name: "Status: Open" });
    await screen.findByRole("button", { name: "Edit labels" });
    const listedRow = row("Repair the login timeout");
    listedRow.focus();

    fireEvent.keyDown(listedRow, { key: "a", isComposing: true });
    expect(screen.queryByRole("dialog", { name: "Assignees" })).toBeNull();

    fireEvent.keyDown(listedRow, { key: "s", code: "KeyS" });
    await screen.findByRole("menuitem", { name: "Close as completed" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    listedRow.focus();
    fireEvent.keyDown(listedRow, { key: "a", code: "KeyA" });
    const assignees = await screen.findByRole("dialog", { name: "Assignees" });
    fireEvent.keyDown(within(assignees).getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Assignees" })).toBeNull());

    listedRow.focus();
    fireEvent.keyDown(listedRow, { key: "l", code: "KeyL" });
    const search = await screen.findByRole("textbox", { name: "Search labels" });
    // Typing in the picker's own box is not a shortcut.
    fireEvent.keyDown(search, { key: "a", code: "KeyA" });
    expect(screen.queryByRole("dialog", { name: "Assignees" })).toBeNull();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Search labels" })).toBeNull());

    // The comment box under the thread, also while a comment above it is being edited.
    fireEvent.keyDown(await screen.findByRole("button", { name: "Actions for comment by sam" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Edit comment" });
    const box = screen.getByRole("textbox", { name: "Comment" });
    act(() => listedRow.focus());
    fireEvent.keyDown(listedRow, { key: "c", code: "KeyC" });
    expect(document.activeElement).toBe(box);
  });
});
