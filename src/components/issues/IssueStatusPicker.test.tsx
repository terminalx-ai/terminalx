import { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrefs } from "@/lib/prefs";
import type { Issue } from "@/lib/api";
import type { IssueProvider } from "@/lib/issueOps";
import { createIssueOpsMock, githubIssueFixture, linearIssueFixture, type IssueOpsMock } from "@/test/issueOpsMock";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { Project } from "@/types/session";

const { invoke, pipelineStore, sessionStore } = vi.hoisted(() => ({
  invoke: vi.fn(),
  pipelineStore: { pipelines: [] as IssuePipeline[] },
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
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  MicButton: () => null,
  useDictationInto: () => ({ dictating: false, toggle: vi.fn() }),
  useDictationShortcuts: vi.fn(),
}));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn(), useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
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
  useIssuePipelines: () => pipelineStore.pipelines,
}));
vi.mock("@/lib/sessions", () => ({
  openAutomation: vi.fn(),
  selectProject: vi.fn(),
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  useSessionStore: () => sessionStore,
}));

const { IssuesView } = await import("./IssuesView");
const { groupWorkflowStates } = await import("./IssueStatusPicker");

let tracker: IssueOpsMock;

/** What the list answers: the tracker's issues as list rows, without what only the full read has. */
function rows(provider: IssueProvider): Issue[] {
  return [...tracker.issues.values()]
    .map(({ issue }) => issue)
    .filter((issue) => issue.provider === provider)
    .map(({ provider, id, identifier, number, title, url, state, stateType, labels, assignee, updatedAt, body, team }) =>
      ({ provider, id, identifier, number, title, url, state, stateType, labels, assignee, updatedAt, body: provider === "linear" ? body : null, team }));
}

beforeEach(() => {
  tracker = createIssueOpsMock();
  pipelineStore.pipelines = [];
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    const answered = tracker.handle(command, args);
    if (answered) return answered;
    if (command === "linear_status") return { connected: true };
    if (command === "linear_teams") return [];
    if (command === "gh_available") return true;
    if (command === "github_repo") return "acme/widgets";
    if (command === "work_status") return { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", ahead: 0, behind: 0, aheadOfBase: 0, head: "abc" };
    if (command === "preview_workspace_name") return "fix-login-timeout";
    if (command === "issues_list") return rows(args?.provider as IssueProvider);
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

async function openIssue(provider: IssueProvider, title: string, state: string) {
  setPrefs({ issueProvider: provider });
  render(<IssuesView />);
  fireEvent.click(await screen.findByText(title));
  return screen.findByRole("button", { name: `Status: ${state}` });
}

function openPicker(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

/** The list row's state chip. */
const rowOf = (title: string) => screen.getAllByText(title).find((node) => node.closest("li"))!.closest("li")!;

const stateCalls = () => tracker.calls.filter((call) => call.command === "issue_set_state").map((call) => call.args.change);

describe("the Linear status picker", () => {
  it("lists the team's states grouped by type in Linear's order, with the current one checked", async () => {
    await openPicker(await openIssue("linear", "Fix login timeout", "In Progress"));
    await screen.findByRole("menuitemradio", { name: "Done" });
    const groups = screen.getAllByRole("group").filter((group) => group.hasAttribute("aria-label")).map((group) => [group.getAttribute("aria-label"), within(group).getAllByRole("menuitemradio").map((item) => item.textContent)]);
    expect(groups).toEqual([
      ["Backlog", ["Backlog"]],
      ["Unstarted", ["Todo"]],
      ["Started", ["In Progress", "In Review"]],
      ["Completed", ["Done"]],
      ["Canceled", ["Canceled"]],
    ]);
    expect(screen.getByRole("menuitemradio", { name: "In Progress" }).getAttribute("aria-checked")).toBe("true");
  });

  it("sets every state of the team, and the header and the list row show each one", async () => {
    let trigger = await openIssue("linear", "Fix login timeout", "In Progress");
    for (const state of tracker.options.linear.states.filter((each) => each.name !== "In Progress")) {
      await openPicker(trigger);
      fireEvent.click(await screen.findByRole("menuitemradio", { name: state.name }));
      trigger = await screen.findByRole("button", { name: `Status: ${state.name}` });
      await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
      expect(within(rowOf("Fix login timeout")).getByText(state.name)).toBeTruthy();
      expect(tracker.issue("linear", "8a1c2e9e-0000-4000-8000-000000000042").stateId).toBe(state.id);
    }
    expect(stateCalls()).toEqual(["state-backlog", "state-todo", "state-review", "state-done", "state-canceled"].map((stateId) => ({ kind: "workflow_state", stateId })));
  });

  it("puts back the provider's real state, with the reason, when the change is refused", async () => {
    const trigger = await openIssue("linear", "Fix login timeout", "In Progress");
    tracker.fail("issue_set_state", "forbidden", "Your Linear key can't edit issues in this team.");
    await openPicker(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Done" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Your Linear key can't edit issues in this team.");
    await screen.findByRole("button", { name: "Status: In Progress" });
    expect(within(rowOf("Fix login timeout")).getByText("In Progress")).toBeTruthy();
    expect(within(rowOf("Fix login timeout")).queryByText("Done")).toBeNull();
  });

  it("opens from the keyboard while the detail pane has the focus, and picks with the arrows and Enter", async () => {
    await openIssue("linear", "Fix login timeout", "In Progress");
    const pane = screen.getByTestId("issue-detail");
    pane.focus();
    fireEvent.keyDown(pane, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
    const menu = await screen.findByRole("menu");
    await screen.findByRole("menuitemradio", { name: "Backlog" });
    // The arrows move the focus down the states; Radix moves it a tick after the key.
    const focused = () => document.activeElement?.textContent ?? "";
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await waitFor(() => expect(focused()).toBe("Backlog"));
    for (const next of ["Todo", "In Progress", "In Review"]) {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      await waitFor(() => expect(focused()).toBe(next));
    }
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await screen.findByRole("button", { name: "Status: In Review" });
    expect(stateCalls()).toEqual([{ kind: "workflow_state", stateId: "state-review" }]);
  });
});

describe("the GitHub status picker", () => {
  it("closes as completed or not planned, shows the reason, and reopens", async () => {
    let trigger = await openIssue("github", "Repair the login timeout", "Open");
    await openPicker(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Close as completed", "Close as not planned"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close as completed" }));
    trigger = await screen.findByRole("button", { name: "Status: Closed as completed" });
    expect(within(rowOf("Repair the login timeout")).getByText("Closed")).toBeTruthy();

    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    await openPicker(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Reopen"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reopen" }));
    trigger = await screen.findByRole("button", { name: "Status: Open" });

    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    await openPicker(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close as not planned" }));
    await screen.findByRole("button", { name: "Status: Closed as not planned" });
    expect(stateCalls()).toEqual([{ kind: "close", reason: "completed" }, { kind: "reopen" }, { kind: "close", reason: "not_planned" }]);
    expect(tracker.issue("github", "41")).toMatchObject({ state: "Closed", closeReason: "not_planned" });
  });

  it("shows what was there when the issue is gone and cannot be read again", async () => {
    const trigger = await openIssue("github", "Repair the login timeout", "Open");
    tracker.fail("issue_set_state", "not_found");
    tracker.fail("issue_details", "not_found");
    await openPicker(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close as not planned" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't find that issue/);
    await screen.findByRole("button", { name: "Status: Open" });
    expect(within(rowOf("Repair the login timeout")).getByText("Open")).toBeTruthy();
  });
});

describe("Close with comment", () => {
  it("posts the comment, then closes the GitHub issue: the header and the row show it, the status waiting on it", async () => {
    const trigger = await openIssue("github", "Repair the login timeout", "Open");
    const box = (await screen.findByRole("textbox", { name: "Comment" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Shipped in 1.4" } });
    const release = holdNext("issue_set_state");
    fireEvent.click(screen.getByRole("button", { name: "Close with comment" }));
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(true));
    release();
    await screen.findByRole("button", { name: "Status: Closed as completed" });
    expect(within(rowOf("Repair the login timeout")).getByText("Closed")).toBeTruthy();
    expect(stateCalls()).toEqual([{ kind: "close", reason: "completed" }]);
    expect(tracker.issues.get("github:41")?.comments.at(-1)?.body).toBe("Shipped in 1.4");
    expect(screen.queryByRole("button", { name: "Close with comment" })).toBeNull();
  });
});

/** Holds back the next answer to `command`, as it was when asked, until `release` is called. */
function holdNext(command: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inner = invoke.getMockImplementation()!;
  let held = false;
  invoke.mockImplementation((name: string, args?: Record<string, unknown>) => {
    if (name !== command || held) return inner(name, args);
    held = true;
    const answer = Promise.resolve(inner(name, args));
    // A refusal is held too; it is not unhandled while it waits.
    answer.catch(() => {});
    return gate.then(() => answer);
  });
  return () => release();
}

const shortcut = (target: HTMLElement) => fireEvent.keyDown(target, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
/** Lets held answers and Radix's timers settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("a status change still on its way", () => {
  it("lands on its own issue's row, not on the issue opened since", async () => {
    tracker = createIssueOpsMock({ issues: [githubIssueFixture(), { ...githubIssueFixture(), id: "42", number: 42, identifier: "#42", title: "Tidy the settings page", url: "https://github.com/acme/widgets/issues/42" }, linearIssueFixture()] });
    const trigger = await openIssue("github", "Repair the login timeout", "Open");
    const release = holdNext("issue_set_state");
    tracker.fail("issue_set_state", "forbidden");
    await openPicker(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close as completed" }));
    await screen.findByRole("button", { name: "Status: Closed as completed" });

    fireEvent.click(screen.getByText("Tidy the settings page"));
    await screen.findByRole("button", { name: "Status: Open" });
    release();
    // The refusal puts #41's row back; #42's page shows no message and no change.
    await waitFor(() => expect(within(rowOf("Repair the login timeout")).getByText("Open")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Status: Open" }).hasAttribute("disabled")).toBe(false);
    expect(tracker.issue("github", "42").state).toBe("Open");
  });

  it("is not undone by a read that started before it", async () => {
    const trigger = await openIssue("github", "Repair the login timeout", "Open");
    // A refresh reads the issue as it was; its answer comes after the change's.
    const release = holdNext("issue_details");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "issue_details")).toHaveLength(2));
    await openPicker(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close as completed" }));
    await screen.findByRole("button", { name: "Status: Closed as completed" });
    await waitFor(() => expect(tracker.issue("github", "41").state).toBe("Closed"));
    release();
    await settle();
    expect(screen.getByRole("button", { name: "Status: Closed as completed" })).toBeTruthy();
  });

  it("is not undone on the list row by a list read that started before it", async () => {
    const trigger = await openIssue("github", "Repair the login timeout", "Open");
    const release = holdNext("issues_list");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "issues_list")).toHaveLength(2));
    await openPicker(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close as completed" }));
    await waitFor(() => expect(tracker.issue("github", "41").state).toBe("Closed"));
    await waitFor(() => expect(within(rowOf("Repair the login timeout")).getByText("Closed")).toBeTruthy());
    // The list read as it was before the change answers last.
    release();
    await settle();
    expect(within(rowOf("Repair the login timeout")).getByText("Closed")).toBeTruthy();
    expect(within(rowOf("Repair the login timeout")).queryByText("Open")).toBeNull();
  });

  it("keeps the picker shut, and the issue busy, until the answer comes, even across a switch away and back", async () => {
    tracker = createIssueOpsMock({ issues: [githubIssueFixture(), { ...githubIssueFixture(), id: "42", number: 42, identifier: "#42", title: "Tidy the settings page", url: "https://github.com/acme/widgets/issues/42" }, linearIssueFixture()] });
    const trigger = await openIssue("github", "Repair the login timeout", "Open");
    const release = holdNext("issue_set_state");
    await openPicker(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close as completed" }));
    const busy = await screen.findByRole("button", { name: "Status: Closed as completed" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    shortcut(screen.getByTestId("issue-detail"));
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();

    // A read while the change is on its way does not put the old state back either.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(screen.getByRole("button", { name: "Status: Closed as completed" })).toBeTruthy();

    fireEvent.click(screen.getByText("Tidy the settings page"));
    await screen.findByRole("button", { name: "Status: Open" });
    fireEvent.click(screen.getAllByText("Repair the login timeout").find((node) => node.closest("li"))!);
    expect((await screen.findByRole("button", { name: /^Status: / })).hasAttribute("disabled")).toBe(true);
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Status: Closed as completed" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the status shortcut", () => {
  it("does nothing before the issue is read whole, and no menu opens on its own later", async () => {
    setPrefs({ issueProvider: "github" });
    render(<IssuesView />);
    const release = holdNext("issue_details");
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    const pane = screen.getByTestId("issue-detail");
    pane.focus();
    shortcut(pane);
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();
    release();
    await screen.findByRole("button", { name: "Status: Open" });
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is never taken while typing in the pane", async () => {
    await openIssue("github", "Repair the login timeout", "Open");
    const pane = screen.getByTestId("issue-detail");
    const field = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    pane.append(field, editable);
    for (const target of [field, editable]) {
      target.focus();
      shortcut(target);
    }
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();
    shortcut(pane);
    expect(await screen.findByRole("menu")).toBeTruthy();
  });
});

describe("the status picker beside a running pipeline", () => {
  const pipelineOn = (patch: Partial<IssuePipeline> = {}): IssuePipeline => {
    const issue = tracker.issue("linear", "8a1c2e9e-0000-4000-8000-000000000042");
    return {
      id: "pipeline-1", projectPath: "/repo",
      issue: { provider: "linear", id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
      branch: "raccoon/eng-42-fix-login-timeout",
      author: { sessionId: "session-1", tabId: "tab-1" },
      autoMerge: false, stopped: false, stage: "work", state: "working",
      round: 0, maxRounds: 3, securityAreas: [], events: [],
      created: "2026-10-01T00:00:00Z", modified: "2026-10-01T00:00:00Z",
      ...patch,
    };
  };

  it("still changes the state, and says the pipeline may move the issue when it reaches review", async () => {
    pipelineStore.pipelines = [pipelineOn()];
    await openPicker(await openIssue("linear", "Fix login timeout", "In Progress"));
    expect(screen.getByText("The issue pipeline may move this issue to review when its pull request opens.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Done" }));
    await screen.findByRole("button", { name: "Status: Done" });
    expect(tracker.issue("linear", "8a1c2e9e-0000-4000-8000-000000000042").state).toBe("Done");
  });

  it("says nothing once the pipeline has moved the issue, or has stopped", async () => {
    pipelineStore.pipelines = [pipelineOn({ stage: "review", state: "waiting", events: [{ at: "2026-10-01T00:00:00Z", stage: "pullRequest", kind: "tracker", message: "Moved ENG-42 to In Review in Linear." }] })];
    await openPicker(await openIssue("linear", "Fix login timeout", "In Progress"));
    await screen.findByRole("menuitemradio", { name: "Done" });
    expect(screen.queryByText(/pipeline may move/)).toBeNull();
  });
});

describe("groupWorkflowStates", () => {
  it("puts triage first, a type it does not know last, each group in the team's order, and leaves Duplicate out", () => {
    const state = (id: string, type: string, position: number) => ({ id, name: id, type, color: "", position });
    expect(groupWorkflowStates([state("Dup", "duplicate", 9), state("R", "review", 8), state("B", "started", 3), state("A", "started", 2), state("T", "triage", 0), state("Todo", "unstarted", 1)])
      .map((group) => [group.label, group.states.map((each) => each.id)]))
      .toEqual([["Triage", ["T"]], ["Unstarted", ["Todo"]], ["Started", ["A", "B"]], ["Review", ["R"]]]);
  });
});
