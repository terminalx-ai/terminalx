import "@testing-library/dom";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrefs } from "@/lib/prefs";
import { registerHotkey } from "@/lib/hotkeys";
import type { Issue } from "@/lib/api";
import type { IssueProvider } from "@/lib/issueOps";
import { createIssueOpsMock, type IssueOpsMock } from "@/test/issueOpsMock";
import type { Project } from "@/types/session";

// The Issues view against the issue-operations mock, with the window's real
// key binder: Escape in an editor has to win over every other Escape.
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
  useSessionStore: () => sessionStore,
}));

const { IssuesView } = await import("./IssuesView");

let mock: IssueOpsMock;

/** What the list answers: the row, without what only a full read brings. GitHub rows have no body. */
function row(provider: IssueProvider): Issue {
  const { provider: p, id, nodeId, identifier, number, title, url, state, stateType, labels, assignee, updatedAt, body, team } = [...mock.issues.values()].find((each) => each.issue.provider === provider)!.issue;
  return { provider: p, id, nodeId, identifier, number, title, url, state, stateType, labels: labels.map(({ name, color }) => ({ name, color })), assignee, updatedAt, body: provider === "linear" ? body : null, team };
}

beforeEach(() => {
  mock = createIssueOpsMock();
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "issues_list") return [row(args?.provider as IssueProvider)];
    const answered = mock.handle(command, args);
    if (answered) return answered;
    if (command === "linear_status") return { connected: true };
    if (command === "linear_teams") return [];
    if (command === "gh_available") return true;
    if (command === "github_repo") return "acme/widgets";
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TITLES: Record<IssueProvider, string> = { github: "Repair the login timeout", linear: "Fix login timeout" };
const ids = (provider: IssueProvider) => [...mock.issues.values()].find((each) => each.issue.provider === provider)!.issue.id;
const stored = (provider: IssueProvider) => mock.issue(provider, ids(provider));
const writes = (command: string) => mock.calls.filter((call) => call.command === command);
const listRow = () => screen.getAllByRole("button").find((button) => button.closest("ul") && button.textContent?.includes(stored(provider_).identifier))!;
let provider_: IssueProvider = "github";

async function openIssue(provider: IssueProvider) {
  provider_ = provider;
  setPrefs({ issueProvider: provider });
  render(<IssuesView />);
  fireEvent.click(await screen.findByText(TITLES[provider]));
  // The whole issue is read before anything can be edited.
  return screen.findByRole("button", { name: "Edit title" });
}

/** Another Escape binding, as a tab's interrupt would have, and a listener on the page behind it. */
function otherEscapes() {
  const binding = vi.fn(() => true);
  const page = vi.fn();
  const off = registerHotkey("escape", binding, { global: true, priority: 10 });
  document.addEventListener("keydown", page);
  return {
    binding,
    page,
    off: () => {
      off();
      document.removeEventListener("keydown", page);
    },
  };
}

describe.each(["github", "linear"] as const)("%s title", (provider) => {
  it("saves on Enter, and the heading and its row follow", async () => {
    fireEvent.click(await openIssue(provider));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Keep sessions alive during long commands" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(writes("issue_set_title")).toHaveLength(1));
    expect(writes("issue_set_title")[0].args).toMatchObject({ provider, id: ids(provider), title: "Keep sessions alive during long commands" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull());
    expect(screen.getByRole("button", { name: "Edit title" }).textContent).toBe("Keep sessions alive during long commands");
    expect(listRow().textContent).toContain("Keep sessions alive during long commands");
  });

  it("cancels on Escape, and the Escape goes no further", async () => {
    fireEvent.click(await openIssue(provider));
    const others = otherEscapes();
    try {
      const input = screen.getByRole("textbox", { name: "Title" });
      fireEvent.change(input, { target: { value: "Something else" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
      expect(screen.getByRole("button", { name: "Edit title" }).textContent).toBe(TITLES[provider]);
      expect(others.binding).not.toHaveBeenCalled();
      expect(others.page).not.toHaveBeenCalled();
      expect(writes("issue_set_title")).toHaveLength(0);
      // Once the editor is gone, Escape is everyone else's again.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(others.binding).toHaveBeenCalledTimes(1);
    } finally {
      others.off();
    }
  });

  it("goes back, with the reason, when the write fails", async () => {
    fireEvent.click(await openIssue(provider));
    mock.fail("issue_set_title", "forbidden");
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Not allowed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Your account doesn't have permission to do that.")).toBeTruthy();
    expect(listRow().textContent).toContain(TITLES[provider]);
    // The draft stays, to try again or cancel.
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Not allowed");
  });
});

describe("labels", () => {
  it("GitHub: picks from the repository's labels by search, and sends the set once the picker closes", async () => {
    await openIssue("github");
    fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
    const search = await screen.findByRole("textbox", { name: "Search labels" });
    expect(within(screen.getByRole("listbox", { name: "Labels" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["bug", "enhancement"]);
    fireEvent.change(search, { target: { value: "enh" } });
    const options = within(screen.getByRole("listbox", { name: "Labels" })).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["enhancement"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(writes("issue_set_labels")).toHaveLength(0);
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(writes("issue_set_labels")).toHaveLength(1));
    expect(writes("issue_set_labels")[0].args.labels).toEqual(["bug", "enhancement"]);
    await waitFor(() => expect(within(screen.getByTestId("issue-labels")).getByText("enhancement")).toBeTruthy());
    expect(listRow().textContent).toContain("enhancement");
    expect(stored("github").labels.map((label) => label.name)).toEqual(["bug", "enhancement"]);
  });

  it("sends nothing when the choice ends where it started", async () => {
    await openIssue("github");
    fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
    const bug = await screen.findByRole("option", { name: "bug" });
    fireEvent.click(bug);
    fireEvent.click(bug);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Labels" })).toBeNull());
    expect(writes("issue_set_labels")).toHaveLength(0);
  });

  it("Linear: shows label groups, holds one label per group, and sends ids", async () => {
    mock.options.linear.labels.push({ id: "label-backend", name: "Backend", color: "26b5ce", group: "Area", isGroup: false });
    await openIssue("linear");
    fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
    const area = await screen.findByRole("group", { name: "Area" });
    expect(within(area).getAllByRole("option").map((option) => option.textContent)).toEqual(["Frontend", "Backend"]);
    fireEvent.click(within(area).getByRole("option", { name: "Frontend" }));
    fireEvent.click(within(area).getByRole("option", { name: "Backend" }));
    expect(within(area).getByRole("option", { name: "Frontend" }).getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    await waitFor(() => expect(writes("issue_set_labels")).toHaveLength(1));
    expect(writes("issue_set_labels")[0].args.labels).toEqual(["label-bug", "label-backend"]);
    await waitFor(() => expect(within(screen.getByTestId("issue-labels")).getByText("Backend")).toBeTruthy());
  });

  it("puts the labels back, and says why, when the write fails", async () => {
    await openIssue("github");
    mock.fail("issue_set_labels", "missing_scope");
    fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
    fireEvent.click(await screen.findByRole("option", { name: "enhancement" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search labels" }), { key: "Escape" });
    expect(await screen.findByText(/Run gh auth refresh -s repo/)).toBeTruthy();
    expect(within(screen.getByTestId("issue-labels")).queryByText("enhancement")).toBeNull();
    expect(listRow().textContent).not.toContain("enhancement");
  });
});

describe("priority", () => {
  it("is offered on Linear with its five levels", async () => {
    await openIssue("linear");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Priority: High" }), { button: 0, ctrlKey: false });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["No priority", "Urgent", "High", "Medium", "Low"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Urgent" }));
    await waitFor(() => expect(writes("issue_set_priority")).toHaveLength(1));
    expect(writes("issue_set_priority")[0].args.priority).toBe(1);
    expect(await screen.findByRole("button", { name: "Priority: Urgent" })).toBeTruthy();
    expect(stored("linear").priority).toBe(1);
  });

  it("is not shown on GitHub, which has none", async () => {
    await openIssue("github");
    expect(screen.queryByRole("button", { name: /^Priority/ })).toBeNull();
  });
});

describe.each(["github", "linear"] as const)("%s description", (provider) => {
  const startEditing = async () => {
    await openIssue(provider);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return screen.getByRole("textbox", { name: "Description" });
  };

  it("edits in Write, shows Preview, and saves against the issue it started from", async () => {
    const before = stored(provider).updatedAt;
    const area = await startEditing();
    expect((area as HTMLTextAreaElement).value).toBe(stored(provider).description);
    fireEvent.change(area, { target: { value: "## Steps\n\nRun a long command." } });
    fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
    expect(screen.getByTestId("markdown-preview").textContent).toContain("Run a long command.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByTestId("description-editor")).toBeNull());
    expect(writes("issue_set_description")[0].args.edit).toEqual({ description: "## Steps\n\nRun a long command.", expectedUpdatedAt: before });
    expect(screen.getByText(/Run a long command\./)).toBeTruthy();
  });

  it("cancels on Escape, and the Escape goes no further", async () => {
    const area = await startEditing();
    const others = otherEscapes();
    try {
      fireEvent.change(area, { target: { value: "Thrown away" } });
      fireEvent.keyDown(area, { key: "Escape" });
      expect(screen.queryByTestId("description-editor")).toBeNull();
      expect(others.binding).not.toHaveBeenCalled();
      expect(others.page).not.toHaveBeenCalled();
      expect(writes("issue_set_description")).toHaveLength(0);
    } finally {
      others.off();
    }
  });

  it("does not overwrite someone else's edit, shows theirs, and replaces it only when asked", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const area = await startEditing();
    fireEvent.change(area, { target: { value: "Mine" } });
    // Someone edits it on the website meanwhile.
    Object.assign(stored(provider), { description: "Theirs", body: "Theirs", updatedAt: "2026-10-05T00:00:00Z" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This issue changed since you started editing");
    expect(stored(provider).description).toBe("Theirs");
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe("Mine");

    fireEvent.click(screen.getByRole("button", { name: "Show their text" }));
    expect(screen.getByTestId("their-description").textContent).toBe("Theirs");
    fireEvent.click(screen.getByRole("button", { name: /Copy theirs/ }));
    expect(writeText).toHaveBeenCalledWith("Theirs");

    fireEvent.click(screen.getByRole("button", { name: "Replace theirs with mine" }));
    await waitFor(() => expect(screen.queryByTestId("description-editor")).toBeNull());
    expect(stored(provider).description).toBe("Mine");
  });

  it("can start again from their text instead", async () => {
    const area = await startEditing();
    fireEvent.change(area, { target: { value: "Mine" } });
    Object.assign(stored(provider), { description: "Theirs", updatedAt: "2026-10-05T00:00:00Z" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start again from theirs" }));
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe("Theirs");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Theirs, and mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored(provider).description).toBe("Theirs, and mine"));
  });

  it("saves through a newer issue whose description is still the one it started from", async () => {
    const area = await startEditing();
    fireEvent.change(area, { target: { value: "Mine" } });
    // A comment or a label moved the issue on, not its description.
    stored(provider).updatedAt = "2026-10-05T00:00:00Z";
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByTestId("description-editor")).toBeNull());
    expect(stored(provider).description).toBe("Mine");
    expect(writes("issue_set_description").map((call) => (call.args.edit as { expectedUpdatedAt: string }).expectedUpdatedAt)[1]).toBe("2026-10-05T00:00:00Z");
  });

  it("keeps the draft and says why when the save fails", async () => {
    const area = await startEditing();
    fireEvent.change(area, { target: { value: "Mine" } });
    mock.fail("issue_set_description", "network");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(await screen.findByText("Couldn't reach the provider. Check your connection, then try again.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe("Mine");
  });
});
