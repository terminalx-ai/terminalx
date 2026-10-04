import "@testing-library/dom";
import { StrictMode, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";
import type { ModelInfo } from "@/lib/api";
import { issuePrompt, issueWorktreeName } from "@/lib/issueSession";

const { invoke, openAutomation, catalog, sessionStore } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openAutomation: vi.fn(),
  catalog: { models: [] as ModelInfo[] },
  sessionStore: {
    projects: [{ path: "/repo", name: "Raccoon" }],
    harnesses: [
      {
        id: "claude",
        name: "Claude Code",
        available: true,
        installHint: "",
        caps: {},
      },
      { id: "codex", name: "Codex", available: true, installHint: "", caps: {} },
    ],
    selectedProject: "/repo",
    sessions: [],
    newSessionPreset: null,
    workspaces: {},
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/chat/Dictation", () => ({
  NEW_SESSION_TARGET: "new",
  DictationStatus: () => null,
  MicButton: () => null,
  useDictationInto: () => ({ dictating: false, toggle: vi.fn() }),
  useDictationShortcuts: vi.fn(),
}));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonScene: () => null }));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn(), useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  BYPASS_MODE: "bypassPermissions",
  DEFAULT_AUTOMATION_MODE: "bypassPermissions",
  PERMISSION_MODES: [
    { id: "manual", label: "Ask every time", hint: "" },
    { id: "auto", label: "Auto", hint: "" },
    { id: "bypassPermissions", label: "Bypass permissions", hint: "" },
  ],
  bypassEffect: () => ({ flag: "--dangerously-skip-permissions", effect: "Claude Code stops asking about anything." }),
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: (harness: string) => catalog.models.filter((m) => m.harness === harness),
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  addProject: vi.fn(),
  clearNewSessionPreset: vi.fn(),
  openAutomation,
  selectProject: vi.fn(),
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  useSessionStore: () => sessionStore,
}));

const { NewSessionView } = await import("@/components/session/NewSessionView");
const { clearNewSessionPreset, selectSession, upsertSession } = await import("@/lib/sessions");
const { refreshModels } = await import("@/lib/models");
const { IssuesView } = await import("./IssuesView");

const issues = [
  {
    provider: "github" as const,
    id: "11",
    identifier: "#11",
    number: 11,
    title: "Fix login timeout",
    url: "https://example.test/issues/11",
    state: "OPEN",
    stateType: "open" as const,
    labels: [{ name: "raccoon", color: "1D76DB" }],
    updatedAt: "2026-09-02T00:00:00Z",
    body: "First issue body.",
  },
  {
    provider: "github" as const,
    id: "12",
    identifier: "#12",
    number: 12,
    title: "Repair session target",
    url: "https://example.test/issues/12",
    state: "OPEN",
    stateType: "open" as const,
    labels: [],
    updatedAt: "2026-09-02T00:00:00Z",
    body: "Second issue body.",
  },
];

const linearIssues = issues.map((issue, index) => ({
  ...issue,
  provider: "linear" as const,
  id: `linear-${index + 1}`,
  identifier: `DEMO-${index + 1}`,
  number: index + 1,
  url: `https://example.test/linear/DEMO-${index + 1}`,
}));

const model = (id: string, label: string, harness: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id, label, harness, efforts: [], defaultEffort: null, acceptsImages: true,
  isDefault: false, upgrade: null, description: null, ...extra,
});
const models = [
  model("sonnet", "Sonnet", "claude", { alias: true }),
  model("opus", "Opus", "claude", { alias: true, resolved: "claude-opus-5-5", isDefault: true, efforts: ["low", "high", "max"], defaultEffort: "high" }),
  model("claude-opus-5", "Opus 5", "claude"),
  model("gpt-5.6-sol", "GPT-5.6 Sol", "codex", { efforts: ["medium", "high"], defaultEffort: "high" }),
  model("gpt-6-astra", "GPT-6 Astra", "codex", { isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }),
  model("fixed-model", "Fixed effort model", "codex"),
];

function mockBackend() {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "linear_status") return { connected: true };
    if (command === "linear_teams") return [];
    if (command === "gh_available") return true;
    if (command === "github_repo") return "terminalx-ai/raccoon";
    if (command === "work_status") {
      return { isRepo: true, dirty: false, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 0, head: "abc" };
    }
    if (command === "preview_workspace_name") {
      const requested = String(args?.requested ?? "").trim();
      return requested ? requested.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "quiet-amber-fox";
    }
    if (command === "issues_list") return args?.provider === "linear" ? linearIssues : issues;
    if (command === "automation_issue_preview") return issues;
    if (command === "automation_create") {
      return {
        id: "automation-99",
        ...((args as { input: Record<string, unknown> }).input),
        nextRunAt: "2026-09-07T09:00:00Z",
        lastRunAt: null,
        lastOutcome: null,
        created: "2026-09-04T00:00:00Z",
        modified: "2026-09-04T00:00:00Z",
      };
    }
    if (command === "issue_details") return issues.find((issue) => issue.id === args?.id);
    if (command === "create_session") {
      const req = (args as { req: Record<string, unknown> }).req;
      return {
        id: "session-1",
        projectPath: "/repo",
        cwd: "/repo/.raccoon/worktrees/12-repair-session-target",
        worktreeName: req.worktreeName,
        branch: "raccoon/12-repair-session-target",
        worktreeRemoved: false,
        title: req.title,
        created: "2026-09-02T00:00:00Z",
        modified: "2026-09-02T00:00:00Z",
        archived: false,
        pinned: false,
        issue: req.issue,
        tabs: [{ id: "tab-1", ...(req.tab as object) }],
      };
    }
    return undefined;
  });
}

function issueSwitch() {
  return screen.getByRole("switch", { name: "Start issue in a new worktree" });
}

beforeEach(() => {
  invoke.mockReset();
  openAutomation.mockReset();
  vi.mocked(upsertSession).mockClear();
  vi.mocked(selectSession).mockClear();
  vi.mocked(refreshModels).mockReset();
  catalog.models = models;
  mockBackend();
  setPrefs({
    lastProject: "/repo",
    lastAgent: "claude",
    lastModel: {},
    lastEffort: {},
    lastMode: "auto",
    issueProvider: "github",
    useWorktree: true,
  });
});

afterEach(cleanup);

describe("issue session targets", () => {
  it("does not clear the workspace destination during Strict Mode effect replay", async () => {
    vi.mocked(clearNewSessionPreset).mockClear();
    render(<StrictMode><NewSessionView /></StrictMode>);
    await screen.findByRole("button", { name: /Workspace quiet-amber-fox/ });
    expect(clearNewSessionPreset).not.toHaveBeenCalled();
  });

  it("previews and customises the workspace name for a new session", async () => {
    render(<NewSessionView />);

    const preview = await screen.findByRole("button", { name: /Workspace quiet-amber-fox/ });
    fireEvent.doubleClick(preview);
    const input = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(input, { target: { value: "My Focused Workspace" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: /Workspace my-focused-workspace/ });

    fireEvent.change(screen.getByPlaceholderText("Describe the task. A worktree is created when you send."), {
      target: { value: "Build the feature" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(true));
    const [, args] = invoke.mock.calls.find(([command]) => command === "create_session") as [string, { req: Record<string, unknown> }];
    expect(args.req).toMatchObject({ useWorktree: true, worktreeName: "my-focused-workspace" });
  });

  it("ignores a composer's one-off choice and resets the choice for the next issue", async () => {
    const composer = render(<NewSessionView />);
    const composerSwitch = screen.getByRole("switch");
    fireEvent.click(composerSwitch);
    expect(composerSwitch.getAttribute("aria-checked")).toBe("false");
    expect(getPrefs().useWorktree).toBe(true);
    composer.unmount();

    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Fix login timeout"));
    await screen.findByText("First issue body.");
    expect(issueSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("11-fix-login-timeout")).toBeTruthy();
    expect(screen.getByText("main", { selector: "span.font-mono" })).toBeTruthy();

    fireEvent.click(issueSwitch());
    expect(issueSwitch().getAttribute("aria-checked")).toBe("false");
    expect(getPrefs().useWorktree).toBe(true);

    fireEvent.click(screen.getByText("Repair session target"));
    await screen.findByText("Second issue body.");
    expect(issueSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("12-repair-session-target")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(true));
    const [, args] = invoke.mock.calls.find(([command]) => command === "create_session") as [string, { req: Record<string, unknown> }];
    expect(args.req).toMatchObject({ title: "#12 Repair session target", useWorktree: true, onMain: false, worktreeName: "12-repair-session-target" });
  });

  it("uses the Settings default when the issue start surface opens", async () => {
    setPrefs({ useWorktree: false });
    render(<IssuesView />);
    fireEvent.click(await screen.findByText("Fix login timeout"));
    await screen.findByText("First issue body.");

    expect(issueSwitch().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(true));
    const [, args] = invoke.mock.calls.find(([command]) => command === "create_session") as [string, { req: Record<string, unknown> }];
    expect(args.req).toMatchObject({ title: "#11 Fix login timeout", useWorktree: false, onMain: true, worktreeName: "11-fix-login-timeout" });
  });

  it("opens the shared automation editor from an issue label", async () => {
    render(<IssuesView />);
    const row = (await screen.findByText("Fix login timeout")).closest("button")!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Automate this label: raccoon…"));

    expect(await screen.findByRole("heading", { name: "New automation" })).toBeTruthy();
    expect(screen.getByDisplayValue("terminalx-ai/raccoon")).toBeTruthy();
    expect(screen.getByDisplayValue("label:raccoon")).toBeTruthy();
    expect(await screen.findByText("2 matching issues")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to issues" }));
    expect(await screen.findByRole("button", { name: /#11Fix login timeout/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "New automation" })).toBeNull();
  });

  it("opens the saved automation detail after creating from an issue", async () => {
    render(<IssuesView />);
    const row = (await screen.findByText("Fix login timeout")).closest("button")!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Automate this label: raccoon…"));

    await screen.findByText("2 matching issues");
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

    await waitFor(() => expect(openAutomation).toHaveBeenCalledWith("automation-99"));
  });

  it("defaults an issue automation to Bypass permissions, not the interactive-session mode, and says so", async () => {
    // The interactive preference is "auto" (see beforeEach); it must not leak in.
    render(<IssuesView />);
    const row = (await screen.findByText("Fix login timeout")).closest("button")!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Automate this label: raccoon…"));
    await screen.findByRole("heading", { name: "New automation" });

    const permissions = screen.getByRole("combobox", { name: "Permissions" }) as HTMLSelectElement;
    expect(permissions.value).toBe("bypassPermissions");
    const warning = screen.getByRole("note", { name: "Bypass permissions warning" });
    expect(warning.textContent).toContain("Claude Code stops asking about anything.");
    expect(screen.getByText(/Issue titles and descriptions can be untrusted/).textContent).toContain("quoted as context");
    expect(screen.queryByText(/start in Auto permissions/)).toBeNull();

    await screen.findByText("2 matching issues");
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(openAutomation).toHaveBeenCalledWith("automation-99"));
    const [, args] = invoke.mock.calls.find(([command]) => command === "automation_create") as [string, { input: Record<string, unknown> }];
    expect(args.input).toMatchObject({ mode: "bypassPermissions", issueTrigger: expect.objectContaining({ repo: "terminalx-ai/raccoon", query: "label:raccoon" }) });
  });

  it("saves a different mode chosen for an issue automation", async () => {
    render(<IssuesView />);
    const row = (await screen.findByText("Fix login timeout")).closest("button")!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Automate this label: raccoon…"));
    await screen.findByRole("heading", { name: "New automation" });

    fireEvent.change(screen.getByRole("combobox", { name: "Permissions" }), { target: { value: "manual" } });
    expect(screen.queryByRole("note", { name: "Bypass permissions warning" })).toBeNull();
    await screen.findByText("2 matching issues");
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(openAutomation).toHaveBeenCalledWith("automation-99"));
    const [, args] = invoke.mock.calls.find(([command]) => command === "automation_create") as [string, { input: Record<string, unknown> }];
    expect(args.input).toMatchObject({ mode: "manual" });
  });
});

function launchRequest() {
  const call = invoke.mock.calls.find(([command]) => command === "create_session");
  expect(call).toBeDefined();
  return call![1].req;
}

async function pickModel(name: string) {
  fireEvent.click(screen.getByTitle("Model"));
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

async function pickEffort(name: string) {
  fireEvent.click(screen.getByTitle("Effort"));
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

async function openIssue(provider: "github" | "linear", onCreated = vi.fn()) {
  setPrefs({ issueProvider: provider });
  const view = render(<IssuesView onCreated={onCreated} />);
  fireEvent.click(await screen.findByText("Fix login timeout"));
  await screen.findByText("First issue body.");
  return view;
}

async function startIssue() {
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(upsertSession).toHaveBeenCalled());
  return launchRequest();
}

describe.each(["github", "linear"] as const)("%s issue agent choices", (provider) => {
  it.each(["claude", "codex"])("matches New Session defaults and launch choices for %s", async (agent) => {
    setPrefs({ lastAgent: agent });
    const composer = render(<NewSessionView useWorktree={false} />);
    const labels = ["Agent", "Model", "Effort"].map((title) => screen.getByTitle(title).textContent);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Synthetic task" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(upsertSession).toHaveBeenCalled());
    const tab = launchRequest().tab;
    expect(tab).toEqual(agent === "codex"
      ? { harness: "codex", model: "gpt-6-astra", effort: "medium", permissionMode: "auto" }
      : { harness: "claude", model: "opus", effort: "high", permissionMode: "auto" });
    composer.unmount();
    invoke.mockClear();
    vi.mocked(upsertSession).mockClear();

    await openIssue(provider);
    expect(["Agent", "Model", "Effort"].map((title) => screen.getByTitle(title).textContent)).toEqual(labels);
    expect((await startIssue()).tab).toEqual(tab);
    // Merely showing defaults does not overwrite saved preferences.
    expect(getPrefs().lastModel).toEqual({});
    expect(getPrefs().lastEffort).toEqual({});
  });

  it("persists explicit choices and sends them with the issue context and target", async () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol", claude: "sonnet" }, lastEffort: { codex: "high", claude: "max" }, lastMode: "manual" });
    const onCreated = vi.fn();
    const view = await openIssue(provider, onCreated);
    expect(screen.getByTitle("Model").textContent).toBe("GPT-5.6 Sol");
    expect(screen.getByTitle("Effort").textContent).toBe("High");
    await pickModel("GPT-6 Astra");
    await pickEffort("Medium");
    expect(getPrefs().lastModel).toEqual({ codex: "gpt-6-astra", claude: "sonnet" });
    expect(getPrefs().lastEffort).toEqual({ codex: "medium", claude: "max" });
    const issue = provider === "github" ? issues[0] : linearIssues[0];
    const tab = { harness: "codex", model: "gpt-6-astra", effort: "medium", permissionMode: "manual" };
    expect(await startIssue()).toMatchObject({
      projectPath: "/repo", title: `${issue.identifier} ${issue.title}`,
      useWorktree: true, onMain: false, worktreeName: issueWorktreeName(issue.identifier, issue.title),
      issue: { provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }, tab,
    });
    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({ tabs: [{ id: "tab-1", ...tab }] }));
    expect(selectSession).toHaveBeenCalledWith("session-1");
    expect(onCreated).toHaveBeenCalledWith("session-1", "tab-1", issuePrompt(issue));
    view.unmount();
    render(<NewSessionView />);
    expect(screen.getByTitle("Agent").textContent).toBe("Codex");
    expect(screen.getByTitle("Model").textContent).toBe("GPT-6 Astra");
    expect(screen.getByTitle("Effort").textContent).toBe("Medium");
  });

  it("switches agents using each provider's saved model and supported efforts", async () => {
    setPrefs({ lastModel: { claude: "opus", codex: "gpt-5.6-sol" }, lastEffort: { claude: "max", codex: "medium" } });
    await openIssue(provider);
    fireEvent.click(screen.getByTitle("Agent"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Codex" }));
    expect(screen.getByTitle("Model").textContent).toBe("GPT-5.6 Sol");
    expect(screen.getByTitle("Effort").textContent).toBe("Medium");
    fireEvent.click(screen.getByTitle("Model"));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["GPT-5.6 Sol", "GPT-6 Astra", "Fixed effort model"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByTitle("Agent"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    expect(screen.getByTitle("Model").textContent).toBe("Opus (latest · Opus 5.5)");
    expect(screen.getByTitle("Effort").textContent).toBe("Max");
    expect(getPrefs().lastAgent).toBe("claude");
    expect((await startIssue()).tab).toMatchObject({ harness: "claude", model: "opus", effort: "max" });
  });

  it("retains compatible effort and replaces unsupported effort when models change", async () => {
    setPrefs({ lastAgent: "codex", lastEffort: { codex: "high" } });
    await openIssue(provider);
    await pickModel("GPT-5.6 Sol");
    expect(screen.getByTitle("Effort").textContent).toBe("High");
    await pickModel("GPT-6 Astra");
    await pickEffort("Extra high");
    await pickModel("GPT-5.6 Sol");
    expect(screen.getByTitle("Effort").textContent).toBe("High");
    fireEvent.click(screen.getByTitle("Effort"));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["Medium", "High"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect((await startIssue()).tab).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("hides effort and sends null for a model without configurable effort", async () => {
    setPrefs({ lastAgent: "codex", lastEffort: { codex: "xhigh" } });
    await openIssue(provider);
    await pickModel("Fixed effort model");
    expect(screen.queryByTitle("Effort")).toBeNull();
    expect((await startIssue()).tab).toMatchObject({ model: "fixed-model", effort: null });
  });

  it.each(["retired-model", "opus"])("replaces stale model %s and unsupported saved effort with valid defaults", async (saved) => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: saved }, lastEffort: { codex: "max" } });
    await openIssue(provider);
    expect(screen.getByTitle("Model").textContent).toBe("GPT-6 Astra");
    expect(screen.getByTitle("Effort").textContent).toBe("Medium");
    expect((await startIssue()).tab).toMatchObject({ harness: "codex", model: "gpt-6-astra", effort: "medium" });
  });

  it("opens, navigates, and selects model and effort with the keyboard", async () => {
    setPrefs({ lastAgent: "codex" });
    await openIssue(provider);
    const modelButton = screen.getByTitle("Model");
    modelButton.focus();
    fireEvent.keyDown(modelButton, { key: "ArrowDown" });
    const sol = await screen.findByRole("menuitemradio", { name: "GPT-5.6 Sol" });
    await waitFor(() => expect(document.activeElement).toBe(sol));
    fireEvent.keyDown(sol, { key: "ArrowDown" });
    const astra = screen.getByRole("menuitemradio", { name: "GPT-6 Astra" });
    await waitFor(() => expect(document.activeElement).toBe(astra));
    fireEvent.keyDown(astra, { key: "Enter" });
    expect(vi.mocked(refreshModels)).toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(modelButton));
    const effortButton = screen.getByTitle("Effort");
    effortButton.focus();
    fireEvent.keyDown(effortButton, { key: " " });
    const low = await screen.findByRole("menuitemradio", { name: "Low" });
    await waitFor(() => expect(document.activeElement).toBe(low));
    fireEvent.keyDown(low, { key: "End" });
    const extraHigh = screen.getByRole("menuitemradio", { name: "Extra high" });
    await waitFor(() => expect(document.activeElement).toBe(extraHigh));
    fireEvent.keyDown(extraHigh, { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(effortButton));
    expect((await startIssue()).tab).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("revalidates after the model catalog refreshes", async () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-6-astra" }, lastEffort: { codex: "xhigh" } });
    const view = await openIssue(provider);
    catalog.models = models.filter((m) => m.id !== "gpt-6-astra");
    view.rerender(<IssuesView />);
    expect(screen.getByTitle("Model").textContent).toBe("GPT-5.6 Sol");
    expect(screen.getByTitle("Effort").textContent).toBe("High");
    expect((await startIssue()).tab).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("uses the agent default without leaking stale choices when no models are listed", async () => {
    catalog.models = [];
    setPrefs({ lastAgent: "codex", lastModel: { codex: "opus" }, lastEffort: { codex: "max" } });
    await openIssue(provider);
    expect(screen.queryByTitle("Model")).toBeNull();
    expect(screen.queryByTitle("Effort")).toBeNull();
    expect((await startIssue()).tab).toMatchObject({ harness: "codex", model: "", effort: null });
  });
});
