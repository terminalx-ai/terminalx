import "@testing-library/dom";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrefs } from "@/lib/prefs";
import type { Issue } from "@/lib/api";
import type { IssueCreate, IssueProvider } from "@/lib/issueOps";
import { clearIssueDraft, emptyIssueDraft, getIssueDraft, setIssueDraft } from "@/lib/newIssueDrafts";
import { createIssueOpsMock, githubOptionsFixture, issueOpError, issueTemplatesFixture, type IssueOpsMock } from "@/test/issueOpsMock";
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
vi.mock("@/components/session/AgentMenu", () => ({ AgentMenu: () => null }));
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
const { NewIssueForm, applyTemplate, createInput } = await import("./NewIssueForm");

let mock: IssueOpsMock;
let gate: { release: () => void; promise: Promise<void> } | null;
// Whether the list reads hold the issues made here; by default they are too new to.
let listsNew = false;

/** The list answers rows, without what only a full read brings. */
function rows(provider: IssueProvider): Issue[] {
  return [...mock.issues.values()]
    .filter((each) => each.issue.provider === provider && (listsNew || (!each.issue.id.startsWith("linear-new") && Number(each.issue.number) < 100)))
    .map(({ issue: { provider: p, id, identifier, number, title, url, state, stateType, labels, assignee, updatedAt, body, team } }) => ({ provider: p, id, identifier, number, title, url, state, stateType, labels, assignee, updatedAt, body, team }));
}

beforeEach(() => {
  localStorage.clear();
  mock = createIssueOpsMock();
  gate = null;
  listsNew = false;
  // The list's filter is kept per project in the preferences.
  setPrefs({ issueFilters: {} });
  sessionStore.newIssueRequested = false;
  clearIssueDraft("/repo", "github");
  clearIssueDraft("/repo", "linear");
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

const listed = (identifier: string) => screen.queryAllByRole("button").find((button) => button.closest("ul") && button.textContent?.includes(identifier));
const listReads = () => invoke.mock.calls.filter(([command]) => command === "issues_list").length;
/** Refresh, and wait for that read's answer to be in. */
async function refresh() {
  const before = listReads();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(listReads()).toBeGreaterThan(before));
  await act(async () => {});
}
const gated = () => {
  let release!: () => void;
  gate = { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
  return gate;
};

const menu = async (name: string | RegExp) => {
  fireEvent.pointerDown(await screen.findByRole("button", { name }), { button: 0, ctrlKey: false });
};

describe("NewIssueForm", () => {
  it("opens creation from the compact empty detail pane", async () => {
    render(<IssuesView />);
    expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create an issue" }));
    expect(await screen.findByTestId("new-issue")).toBeTruthy();
  });

  it("loads and applies templates using a cloud repository key", async () => {
    const projectPath = "cloud:org-a:github.com/acme/widgets";
    clearIssueDraft(projectPath, "github");
    render(<NewIssueForm projectPath={projectPath} provider="github" repo="acme/widgets" teams={[]} defaultTeamId={null} onProviderChange={vi.fn()} onCreated={vi.fn()} onClose={vi.fn()} />);
    await menu("Template: None");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Bug report/ }));
    expect(invoke).toHaveBeenCalledWith("issue_templates", { projectPath });
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toContain("**Steps to reproduce**");
    await waitFor(() => expect(screen.getByRole("button", { name: "Labels: bug" })).toBeTruthy());
    clearIssueDraft(projectPath, "github");
  });

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

  it("clears a draft whose team was filled in from the list's filter once its issue is created", async () => {
    // Written before, with all teams shown: no team yet.
    setIssueDraft("/repo", "linear", { ...emptyIssueDraft(), title: "From before" });
    setPrefs({ issueProvider: "linear" });
    render(<IssuesView />);
    await menu("All teams");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Operations/ }));
    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    const form = await screen.findByTestId("new-issue");
    expect(within(form).getByRole("button", { name: "Team: Operations" })).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    expect(creates()).toEqual([expect.objectContaining({ teamId: "team-ops", title: "From before" })]);
    expect(getIssueDraft("/repo", "linear")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    expect((within(await screen.findByTestId("new-issue")).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("");
  });

  it("clears the draft when the only team arrives after the typing, once its issue is created", async () => {
    let teamsCame!: () => void;
    const teamsGate = new Promise<void>((resolve) => (teamsCame = resolve));
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "linear_teams") {
        await teamsGate;
        return [{ id: "team-eng", key: "ENG", name: "Engineering" }];
      }
      return base(command, args);
    });
    const form = await openForm("linear");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Typed first" } });
    await act(async () => teamsCame());
    await waitFor(() => expect(within(form).getByRole("button", { name: "Team: Engineering" })).toBeTruthy());
    expect(getIssueDraft("/repo", "linear")?.teamId).toBe("team-eng");
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    expect(getIssueDraft("/repo", "linear")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    expect((within(await screen.findByTestId("new-issue")).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("");
  });

  it("finds the issue a create made though its answer was lost, and opens it rather than offer to make it again", async () => {
    listsNew = true;
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "issue_create") return base(command, args);
      await mock.handle(command, args);
      // Made just now, by the reader; then the connection dropped.
      mock.issue("github", "101").createdAt = new Date().toISOString();
      throw issueOpError("network");
    });
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Made anyway" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    expect(creates()).toHaveLength(1);
    expect(within(screen.getByTestId("issue-detail")).getByRole("button", { name: "Copy #101" })).toBeTruthy();
    expect(getIssueDraft("/repo", "github")).toBeNull();
  });

  it("says a create whose answer was lost may have made the issue, and offers to create it again", async () => {
    // An issue with the same title, but an old one: not the one this create could have made.
    mock.issue("github", "41").title = "Lost answer";
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Lost answer" } });
    mock.fail("issue_create", "network");
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("may have been created all the same");
    expect(alert.textContent).toContain("Nothing was lost");
    expect(getIssueDraft("/repo", "github")?.title).toBe("Lost answer");
    // A refusal is not in doubt.
    fireEvent.click(within(form).getByRole("button", { name: "Create again" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    expect(creates()).toHaveLength(2);
  });

  it("does not close on Escape while creating, and says a failure that came after the form was closed when it opens again", async () => {
    const slow = gated();
    const form = await openForm("github");
    const title = within(form).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Closed meanwhile" } });
    title.focus();
    fireEvent.keyDown(title, { key: "Enter", metaKey: true });
    await waitFor(() => expect(title.readOnly).toBe(true));
    fireEvent.keyDown(title, { key: "Escape" });
    expect(screen.getByTestId("new-issue")).toBeTruthy();

    // Opening another issue closes it all the same.
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    expect(screen.queryByTestId("new-issue")).toBeNull();
    mock.fail("issue_create", "forbidden", "You can't create issues in this repository.");
    await act(async () => slow.release());

    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    const again = await screen.findByTestId("new-issue");
    expect((await within(again).findByRole("alert")).textContent).toContain("You can't create issues in this repository.");
    expect((within(again).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Closed meanwhile");
  });

  it("keeps the open issue's keys off while the form is shown in its place", async () => {
    setPrefs({ issueProvider: "github" });
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Repair the login timeout"));
    await screen.findByRole("button", { name: "Status: Open" });
    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    const create = within(await screen.findByTestId("new-issue")).getByRole("button", { name: "Create issue" });
    create.focus();
    fireEvent.keyDown(create, { key: "s", code: "KeyS" });
    fireEvent.keyDown(create, { key: "a", code: "KeyA" });
    expect(screen.getByTestId("new-issue")).toBeTruthy();
    // Nor are the pickers left to open by themselves once the issue is back.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByRole("button", { name: "Status: Open" });
    await act(async () => {});
    expect(screen.queryByRole("menuitem", { name: "Close as completed" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Assignees" })).toBeNull();
  });

  it("keeps the form open on an Escape that ends an input method's composition", async () => {
    const form = await openForm("github");
    const title = within(form).getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.keyDown(title, { key: "Escape", isComposing: true });
    expect(screen.getByTestId("new-issue")).toBeTruthy();
    fireEvent.keyDown(title, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
  });

  it("lets go of the issue pinned at the top once a list read holds it, or the filter changes", async () => {
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Pinned for now" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());

    // A read too soon to hold it: still listed, as the detail pane last had it.
    fireEvent.click(within(screen.getByTestId("issue-detail")).getByRole("button", { name: "Edit title" }));
    const edit = within(screen.getByTestId("issue-detail")).getByRole("textbox", { name: "Title" });
    fireEvent.change(edit, { target: { value: "Renamed since" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    await waitFor(() => expect(mock.issue("github", "101").title).toBe("Renamed since"));
    await refresh();
    expect(listed("#101")?.textContent).toContain("Renamed since");

    // Once a read holds it, it is the list's like any other.
    listsNew = true;
    await refresh();
    expect(listed("#101")).toBeTruthy();
    listsNew = false;
    await refresh();
    await waitFor(() => expect(listed("#101")).toBeUndefined());
  });

  it("does not pin the created issue into a list filtered since", async () => {
    const form = await openForm("github");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Under no filter" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(listed("#101")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "login" } });
    await waitFor(() => expect(listed("#101")).toBeUndefined());
  });

  it("keeps the created issue listed under a work filter that hides the rest, while it is pinned (#441)", async () => {
    setPrefs({ issueProvider: "github" });
    render(<IssuesView />);
    await waitFor(() => expect(listed("#41")).toBeTruthy());
    // Nobody here works on anything, so Only mine leaves nothing listed.
    await menu(/^Working: /);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Only mine" }));
    await waitFor(() => expect(listed("#41")).toBeUndefined());

    fireEvent.click(screen.getByRole("button", { name: /New issue/ }));
    const form = await screen.findByTestId("new-issue");
    fireEvent.change(within(form).getByRole("textbox", { name: "Title" }), { target: { value: "Made under Only mine" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(screen.queryByTestId("new-issue")).toBeNull());
    // Open beside the list and selected in it, as with no filter.
    expect(listed("#101")?.getAttribute("aria-current")).toBe("true");
    expect(listed("#41")).toBeUndefined();

    // Once a read holds it, the filter applies to it like any other row.
    listsNew = true;
    await refresh();
    await waitFor(() => expect(listed("#101")).toBeUndefined());
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
