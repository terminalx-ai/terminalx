import "@testing-library/dom";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrefs } from "@/lib/prefs";
import type { Issue } from "@/lib/api";
import type { IssueCreate, IssueProvider } from "@/lib/issueOps";
import { emptyIssueDraft, getIssueDraft } from "@/lib/issueDrafts";
import { createIssueOpsMock, githubOptionsFixture, issueTemplatesFixture, type IssueOpsMock } from "@/test/issueOpsMock";
import type { Project } from "@/types/session";

// The new-issue form in the Issues view, against the issue-operations mock.
const { invoke, sessionStore, takeNewIssueRequest } = vi.hoisted(() => ({
  invoke: vi.fn(),
  takeNewIssueRequest: vi.fn(),
  sessionStore: {
    projects: [{ path: "/repo", name: "Widgets" }] as Project[],
    harnesses: [{ id: "claude", name: "Claude Code", available: true, installHint: "", caps: {} }],
    selectedProject: "/repo",
    sessions: [],
    newSessionPreset: null,
    newIssueRequested: false,
    workspaces: {},
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/session/SessionAgentControls", () => ({ SessionAgentControls: () => null }));
vi.mock("@/lib/useSessionAgent", () => ({ useSessionAgent: () => ({ harness: sessionStore.harnesses[0], modelId: null, effort: null }) }));
vi.mock("@/lib/issuePipeline", async (original) => ({
  ...(await original<typeof import("@/lib/issuePipeline")>()),
  useIssuePipelines: () => [],
  startPipeline: vi.fn(),
}));
vi.mock("@/lib/sessions", () => ({
  openAutomation: vi.fn(),
  selectProject: vi.fn(),
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  takeNewIssueRequest,
  useSessionStore: () => sessionStore,
}));

const { IssuesView } = await import("./IssuesView");
const { applyTemplate, createInput } = await import("./NewIssueForm");

let mock: IssueOpsMock;
let gate: { release: () => void; promise: Promise<void> } | null;

/** The list answers rows, without what only a full read brings. */
function rows(provider: IssueProvider): Issue[] {
  return [...mock.issues.values()]
    .filter((each) => each.issue.provider === provider && !each.issue.id.startsWith("linear-new") && Number(each.issue.number) < 100)
    .map(({ issue: { provider: p, id, identifier, number, title, url, state, stateType, labels, assignee, updatedAt, body, team } }) => ({ provider: p, id, identifier, number, title, url, state, stateType, labels, assignee, updatedAt, body, team }));
}

beforeEach(() => {
  localStorage.clear();
  mock = createIssueOpsMock();
  gate = null;
  sessionStore.newIssueRequested = false;
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "issues_list") return rows(args?.provider as IssueProvider);
    if (command === "issue_create" && gate) await gate.promise;
    const answered = mock.handle(command, args);
    if (answered) return answered;
    if (command === "linear_status") return { connected: true };
    if (command === "linear_teams") return [{ id: "team-eng", key: "ENG", name: "Engineering" }, { id: "team-ops", key: "OPS", name: "Operations" }];
    if (command === "gh_available") return true;
    if (command === "github_repo") return "acme/widgets";
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const creates = () => mock.calls.filter((call) => call.command === "issue_create").map((call) => call.args.input as IssueCreate);

async function openForm(provider: IssueProvider) {
  setPrefs({ issueProvider: provider });
  render(<IssuesView />);
  fireEvent.click(await screen.findByRole("button", { name: /New issue/ }));
  return screen.findByTestId("new-issue");
}

const menu = async (name: string | RegExp) => {
  fireEvent.pointerDown(await screen.findByRole("button", { name }), { button: 0, ctrlKey: false });
};

describe("NewIssueForm", () => {
  it("creates a GitHub issue from a template with every field, then has it open in the list", async () => {
    const form = await openForm("github");
    expect(within(form).getByText("acme/widgets")).toBeTruthy();

    await menu("Template: None");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Bug report/ }));
    const description = within(form).getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    expect(description.value).toContain("**Steps to reproduce**");
    // The template's label is the repository's own, once its labels are read.
    await waitFor(() => expect(within(form).getByRole("button", { name: "Labels: bug" })).toBeTruthy());

    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "  The timeout is too short  " } });
    fireEvent.click(within(form).getByRole("button", { name: "Assign" }));
    fireEvent.click(await screen.findByRole("option", { name: "alex" }));
    fireEvent.click(screen.getByRole("option", { name: "kim" }));
    fireEvent.click(within(form).getByRole("button", { name: "Labels: bug" }));
    fireEvent.click(await screen.findByRole("option", { name: "enhancement" }));

    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());

    expect(creates()).toEqual([
      { teamId: null, title: "The timeout is too short", description: issueTemplatesFixture()[0].body, assignees: ["alex", "kim"], labels: ["bug", "enhancement"], stateId: null, priority: null },
    ]);
    const made = mock.issue("github", "101");
    expect(made.assignees.map((person) => person.id)).toEqual(["alex", "kim"]);
    expect(made.labels.map((label) => label.name)).toEqual(["bug", "enhancement"]);
    // Open beside the list, selected in it, ready to start a session on, with its identifier to copy.
    const detail = screen.getByTestId("issue-detail");
    expect(within(detail).getByRole("button", { name: "Copy #101" })).toBeTruthy();
    expect(within(detail).getByRole("button", { name: "Start session" })).toBeTruthy();
    expect(within(detail).getByRole("button", { name: "Edit title" }).textContent).toBe("The timeout is too short");
    const listed = screen.getAllByRole("button").find((button) => button.closest("ul") && button.textContent?.includes("#101"));
    expect(listed).toBeTruthy();
    // The draft goes once the issue exists.
    expect(getIssueDraft("/repo", "github")).toBeNull();
  });

  it("copies the identifier", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Copy me" } });
    fireEvent.keyDown(within(form).getByRole("textbox", { name: "Title" }), { key: "Enter", metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Copy #101" }));
    expect(writeText).toHaveBeenCalledWith("#101");
  });

  it("creates a Linear issue in the team the list is narrowed to, with state, priority, label and assignee", async () => {
    setPrefs({ issueProvider: "linear" });
    render(<IssuesView />);
    await menu("All teams");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Operations/ }));
    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    const form = await screen.findByTestId("new-issue");
    expect(within(form).getByRole("button", { name: "Team: Operations" })).toBeTruthy();
    // Templates are GitHub's.
    expect(within(form).queryByRole("button", { name: /Template/ })).toBeNull();

    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Rotate the keys" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Description" }), { target: { value: "Every **90** days." } });
    await menu("Status: Team default");
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "In Progress" }));
    await menu("Priority: No priority");
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
    fireEvent.click(within(form).getByRole("button", { name: "Assign" }));
    // The reader, as the team has them.
    fireEvent.click(await screen.findByRole("button", { name: "Assign to me" }));
    fireEvent.click(within(form).getByRole("button", { name: "Add labels" }));
    fireEvent.click(await screen.findByRole("option", { name: "Frontend" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    expect(creates()).toEqual([
      { teamId: "team-ops", title: "Rotate the keys", description: "Every **90** days.", assignees: ["user-kim"], labels: ["label-frontend"], stateId: "state-started", priority: 2 },
    ]);
    const made = mock.issue("linear", "linear-new-101");
    expect([made.state, made.priority, made.assignees[0]?.name, made.labels[0]?.name]).toEqual(["In Progress", 2, "Kim", "Frontend"]);
    expect(within(screen.getByTestId("issue-detail")).getByRole("button", { name: "Copy ENG-101" })).toBeTruthy();
  });

  it("asks for a team when the list shows them all, and changing team lets go of that team's picks", async () => {
    const form = await openForm("linear");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Somewhere" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    expect(within(form).getByRole("alert").textContent).toBe("Choose a team.");
    expect(creates()).toEqual([]);

    await menu("Choose a team");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Engineering/ }));
    await menu("Status: Team default");
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Todo" }));
    await menu("Team: Engineering");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Operations/ }));
    expect(within(form).getByRole("button", { name: "Status: Team default" })).toBeTruthy();
  });

  it("keeps everything typed when the create fails, and says why", async () => {
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "No access" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Description" }), { target: { value: "Body stays" } });
    mock.fail("issue_create", "forbidden", "You can't create issues in this repository.");
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("You can't create issues in this repository.");
    expect((within(form).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("No access");
    expect((within(form).getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe("Body stays");
    expect(getIssueDraft("/repo", "github")?.title).toBe("No access");

    // Tried again, it goes through.
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    expect(mock.issue("github", "101").description).toBe("Body stays");
  });

  it("keeps the fields read-only, not disabled, while the create is on its way", async () => {
    let release!: () => void;
    gate = { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
    const form = await openForm("github");
    const title = within(form).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Slow" } });
    title.focus();
    fireEvent.keyDown(title, { key: "Enter", metaKey: true });
    await waitFor(() => expect(title.readOnly).toBe(true));
    expect(title.disabled).toBe(false);
    expect(document.activeElement).toBe(title);
    // A second press while busy creates nothing more.
    fireEvent.keyDown(title, { key: "Enter", metaKey: true });
    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    expect(creates()).toHaveLength(1);
  });

  it("does not create on a plain Enter in the title, nor while composing", async () => {
    const form = await openForm("github");
    const title = within(form).getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Not yet" } });
    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.keyDown(title, { key: "Enter", metaKey: true, isComposing: true });
    expect(creates()).toEqual([]);
  });

  it("keeps the draft when the form is closed, by the button or by Escape", async () => {
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Half written" } });
    fireEvent.click(within(form).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("new-issue")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    const again = await screen.findByTestId("new-issue");
    const title = within(again).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    expect(title.value).toBe("Half written");
    title.focus();
    fireEvent.keyDown(title, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());

    // Even across a restart of the view.
    cleanup();
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: /New issue/ }));
    expect((within(await screen.findByTestId("new-issue")).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Half written");
  });

  it("asks before a template replaces a typed description", async () => {
    const form = await openForm("github");
    const description = within(form).getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "My own words" } });
    await menu("Template: None");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Feature request/ }));
    expect(description.value).toBe("My own words");
    fireEvent.click(within(form).getByRole("button", { name: "Keep mine" }));
    expect(description.value).toBe("My own words");

    await menu("Template: None");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Feature request/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Replace" }));
    expect(description.value).toBe("**What are you trying to do?**\n");

    // One template for another needs no asking: nothing of the reader's is lost.
    await menu("Template: Feature request");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Bug report/ }));
    expect(description.value).toContain("**Steps to reproduce**");
  });

  it("opens from the command palette's request", async () => {
    sessionStore.newIssueRequested = true;
    setPrefs({ issueProvider: "github" });
    render(<IssuesView />);
    expect(await screen.findByTestId("new-issue")).toBeTruthy();
    expect(takeNewIssueRequest).toHaveBeenCalled();
  });

  it("selecting an issue in the list closes the form and keeps the draft", async () => {
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Later" } });
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    expect(screen.queryByTestId("new-issue")).toBeNull();
    expect(getIssueDraft("/repo", "github")?.title).toBe("Later");
  });
});

describe("createInput and applyTemplate", () => {
  it("sends only the labels and people the provider still offers", () => {
    const options = githubOptionsFixture();
    const draft = { ...emptyIssueDraft(), title: " T ", labels: ["bug", "gone"], assignees: [{ id: "alex", name: "alex" }, { id: "left", name: "left" }] };
    expect(createInput(draft, "github", options)).toEqual({ teamId: null, title: "T", description: "", assignees: ["alex"], labels: ["bug"], stateId: null, priority: null });
  });

  it("fills an empty title from the template and adds its labels by the repository's spelling", () => {
    const options = githubOptionsFixture();
    const template = { ...issueTemplatesFixture()[0], title: "[Bug] ", labels: ["BUG", "missing"] };
    const next = applyTemplate(emptyIssueDraft(), template, options);
    expect([next.title, next.labels, next.template]).toEqual(["[Bug] ", ["bug"], "bug_report.md"]);
    expect(applyTemplate({ ...emptyIssueDraft(), title: "Mine" }, template, options).title).toBe("Mine");
  });
});
