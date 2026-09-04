import "@testing-library/dom";
import { StrictMode, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";

const { invoke, sessionStore } = vi.hoisted(() => ({
  invoke: vi.fn(),
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
}));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonScene: () => null }));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn() }));
vi.mock("@/lib/models", () => ({
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "auto", label: "Auto", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [],
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  addProject: vi.fn(),
  clearNewSessionPreset: vi.fn(),
  selectProject: vi.fn(),
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  useSessionStore: () => sessionStore,
}));

const { NewSessionView } = await import("@/components/session/NewSessionView");
const { clearNewSessionPreset } = await import("@/lib/sessions");
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

function mockBackend() {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "linear_status") return { connected: false };
    if (command === "gh_available") return true;
    if (command === "github_repo") return "terminalx-ai/raccoon";
    if (command === "work_status") {
      return { isRepo: true, dirty: false, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 0, head: "abc" };
    }
    if (command === "preview_workspace_name") {
      const requested = String(args?.requested ?? "").trim();
      return requested ? requested.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "quiet-amber-fox";
    }
    if (command === "issues_list") return issues;
    if (command === "automation_issue_preview") return issues;
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
        tabs: [{ id: "tab-1" }],
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
    expect(args.req).toMatchObject({ useWorktree: true, onMain: false, worktreeName: "12-repair-session-target" });
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
    expect(args.req).toMatchObject({ useWorktree: false, onMain: true, worktreeName: "11-fix-login-timeout" });
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
  });
});
