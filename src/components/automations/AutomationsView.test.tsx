import "@testing-library/dom";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationRun } from "@/types/automations";

const { automationStore, createAutomation, updateAutomation, runAutomationNow, selectSession, openUrl } = vi.hoisted(() => ({
  automationStore: {
    loaded: true,
    automations: [] as Automation[],
    runs: {} as Record<string, AutomationRun[]>,
    loadingRuns: {} as Record<string, boolean>,
    issueStates: {},
  },
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  runAutomationNow: vi.fn(),
  selectSession: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/components/AgentMark", () => ({ AgentMark: () => <span aria-hidden>agent</span> }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/automations", () => ({
  createAutomation,
  deleteAutomation: vi.fn(),
  loadAutomationRuns: vi.fn(async () => []),
  refreshAutomations: vi.fn(async () => undefined),
  runAutomationNow,
  updateAutomation,
  useAutomationStore: () => automationStore,
}));
vi.mock("@/lib/models", () => ({
  BYPASS_MODE: "bypassPermissions",
  DEFAULT_AUTOMATION_MODE: "bypassPermissions",
  EFFORT_LABEL: {},
  PERMISSION_MODES: [
    { id: "manual", label: "Ask every time" },
    { id: "auto", label: "Auto" },
    { id: "bypassPermissions", label: "Bypass permissions" },
  ],
  bypassEffect: () => ({ flag: "--permission-mode bypassPermissions", effect: "Claude Code stops asking about anything." }),
  useModels: () => [{ id: "sonnet", label: "Sonnet", harness: "claude", isDefault: true, efforts: [], defaultEffort: null }],
}));
// The interactive-session preference is deliberately "auto" (and "manual" in
// one test) so a leak from prefs.lastMode into a new automation is visible.
const prefs = vi.hoisted(() => ({ lastProject: "/repo", lastAgent: "claude", lastModel: {} as Record<string, string>, lastMode: "auto" }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => prefs,
}));
vi.mock("@/lib/sessions", () => ({
  selectSession,
  useSessionStore: () => ({
    projects: [{ path: "/repo", name: "Raccoon" }, { path: "/docs", name: "Docs" }],
    harnesses: [{ id: "claude", name: "Claude Code", available: true }],
    sessions: [{ id: "session-7", title: "Automation run 7", projectPath: "/repo", archived: false }],
  }),
}));

const { AutomationsView } = await import("./AutomationsView");

function automation(id: string, name: string): Automation {
  return {
    id,
    name,
    enabled: true,
    projectPath: "/repo",
    harness: "claude",
    model: "sonnet",
    effort: null,
    mode: "auto",
    prompt: "Review the repository and report what changed.",
    workspace: "newWorktree",
    sessionId: null,
    reuseSession: false,
    baseRef: null,
    schedule: {
      kind: "preset",
      preset: "weekdays",
      hour: 9,
      minute: 0,
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      timezone: "UTC",
      dtstart: "2026-09-01T09:00:00Z",
    },
    precheck: null,
    missedRunGraceMinutes: 60,
    runTimeoutMinutes: null,
    nextRunAt: "2026-09-07T09:00:00Z",
    lastRunAt: "2026-09-04T09:00:00Z",
    lastOutcome: "completed",
    issueTrigger: null,
    created: "2026-09-01T00:00:00Z",
    modified: "2026-09-04T09:00:00Z",
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    runId: "run-7",
    runNumber: 7,
    automationId: "automation-1",
    trigger: "scheduled",
    scheduledFor: "2026-09-04T09:00:00Z",
    startedAt: "2026-09-04T09:00:00Z",
    endedAt: "2026-09-04T09:04:30Z",
    status: "completed",
    sessionId: "session-7",
    tabId: "tab-7",
    worktreeName: "automation/run-7",
    issue: null,
    finalMessage: "All checks passed.",
    changedFiles: 3,
    usage: null,
    precheck: null,
    error: null,
    reported: { prUrl: "https://example.test/pr/7", comment: null, labels: [] },
    repeatCount: 1,
    lastRepeatAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  automationStore.automations = [
    automation("automation-1", "Dependency audit"),
    { ...automation("automation-2", "Release notes"), projectPath: "/docs" },
  ];
  automationStore.runs = { "automation-1": [run()] };
  automationStore.loadingRuns = {};
  prefs.lastMode = "auto";
  selectSession.mockReset();
  openUrl.mockReset();
  createAutomation.mockReset();
  updateAutomation.mockReset();
  runAutomationNow.mockReset();
  runAutomationNow.mockImplementation(async (id: string) => run({ runId: "run-8", runNumber: 8, automationId: id, trigger: "manual", status: "running", endedAt: null }));
  createAutomation.mockImplementation(async (input) => {
    const saved = { ...automation("automation-3", input.name), ...input };
    automationStore.automations.push(saved);
    return saved;
  });
  updateAutomation.mockImplementation(async (id, input) => {
    const saved = { ...automationStore.automations.find((value) => value.id === id)!, ...input };
    automationStore.automations = automationStore.automations.map((value) => value.id === id ? saved : value);
    return saved;
  });
});

afterEach(cleanup);

describe("automation workspace navigation", () => {
  it("opens a selected automation in a dedicated run-table view and returns to the list", async () => {
    render(<AutomationsView />);

    expect(screen.queryByRole("table", { name: "Automation runs" })).toBeNull();
    expect(screen.getByText("Raccoon")).toBeTruthy();
    expect(screen.getByText("Docs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));

    expect(await screen.findByRole("table", { name: "Automation runs" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Run" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Trigger or issue" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Timing" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Worktree or session" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Result or PR" })).toBeTruthy();
    expect(screen.queryByText("Release notes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to automations" }));
    expect(screen.getByText("Release notes")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Automation runs" })).toBeNull();
  });

  it("keeps every run status and expanded run actions available from the table", async () => {
    const statuses = [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "timedOut",
      "skippedPrecheck",
      "skippedMissed",
      "skippedUnavailable",
    ] as const;
    automationStore.runs["automation-1"] = statuses.map((status, index) => run({
      runId: `run-${index + 1}`,
      runNumber: index + 1,
      status,
      sessionId: index === 0 ? "session-7" : null,
      issue: index === 0 ? { provider: "github", id: "69", identifier: "#69", title: "Full-screen automation runs", url: "https://example.test/issues/69" } : null,
      finalMessage: index === 0 ? "Expanded output" : null,
      reported: index === 0 ? { prUrl: "https://example.test/pr/7", comment: null, labels: [] } : null,
    }));

    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));

    for (const label of ["Starting", "Running", "Completed", "Failed", "Cancelled", "Timed out", "Precheck skipped", "Missed", "Unavailable"]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: "Expand run 1" }));
    expect(screen.getByText("Expanded output")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open run session" }));
    expect(selectSession).toHaveBeenCalledWith("session-7");
    fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.test/pr/7");
    fireEvent.click(screen.getByRole("button", { name: /#69/ }));
    expect(openUrl).toHaveBeenCalledWith("https://example.test/issues/69");
  });

  it("uses full-screen new and edit surfaces with predictable cancel navigation", async () => {
    render(<AutomationsView />);

    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    expect(await screen.findByRole("heading", { name: "New automation" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: /Dependency audit/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("heading", { name: "Edit automation" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("table", { name: "Automation runs" })).toBeTruthy();
  });

  it("returns to the saved automation detail after create and edit", async () => {
    render(<AutomationsView />);

    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Nightly audit" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Run the nightly audit." } });
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

    expect(await screen.findByRole("heading", { name: "Nightly audit" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Automation runs" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Nightly repository audit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("heading", { name: "Nightly repository audit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to automations" })).toBeTruthy();
  });
});

describe("automation permission mode", () => {
  const permissions = () => screen.getByRole("combobox", { name: "Permissions" }) as HTMLSelectElement;
  const trigger = (name: string) => screen.getByRole("radio", { name });
  const bypassWarning = () => screen.queryByRole("note", { name: "Bypass permissions warning" });

  it.each(["auto", "manual"])("defaults a new scheduled automation to Bypass permissions when the interactive-session mode is %s", async (lastMode) => {
    prefs.lastMode = lastMode;
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    await screen.findByRole("heading", { name: "New automation" });

    expect(permissions().value).toBe("bypassPermissions");
    expect(bypassWarning()).toBeTruthy();
    expect(bypassWarning()!.textContent).toContain("Claude Code stops asking about anything.");

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Nightly audit" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Run the nightly audit." } });
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await screen.findByRole("heading", { name: "Nightly audit" });
    expect(createAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "bypassPermissions", issueTrigger: null }));
  });

  it("keeps the chosen mode when the trigger changes in either direction", async () => {
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    await screen.findByRole("heading", { name: "New automation" });

    // The default survives the switch to GitHub issues (it used to reset to Auto).
    fireEvent.click(trigger("GitHub issues"));
    expect(permissions().value).toBe("bypassPermissions");
    expect(bypassWarning()).toBeTruthy();
    expect(screen.getByText(/Issue titles and descriptions can be untrusted/).textContent).toContain("each run uses the Permissions mode chosen above");
    expect(screen.queryByText(/start in Auto permissions/)).toBeNull();

    // An explicit choice survives too, both ways, and the warning follows the mode.
    fireEvent.change(permissions(), { target: { value: "manual" } });
    expect(bypassWarning()).toBeNull();
    fireEvent.click(trigger("Schedule"));
    expect(permissions().value).toBe("manual");
    fireEvent.click(trigger("GitHub issues"));
    expect(permissions().value).toBe("manual");
    expect(bypassWarning()).toBeNull();

    fireEvent.change(permissions(), { target: { value: "bypassPermissions" } });
    expect(bypassWarning()).toBeTruthy();
    fireEvent.click(trigger("Schedule"));
    expect(permissions().value).toBe("bypassPermissions");
  });

  it("preserves an explicitly configured non-bypass mode through edit, disable, re-enable and Run now", async () => {
    automationStore.automations[0] = { ...automationStore.automations[0], mode: "manual" };
    const { rerender } = render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));

    // Edit: the saved mode is shown, not the interactive default, and is saved back untouched.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit automation" });
    expect(permissions().value).toBe("manual");
    expect(bypassWarning()).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Dependency audit (manual)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("heading", { name: "Dependency audit (manual)" });
    expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ mode: "manual" }));

    // Disable, then re-enable: only `enabled` changes. The mocked store has no
    // subscription, so the view is re-rendered by hand to pick up the saved state.
    fireEvent.click(screen.getByRole("switch", { name: "Disable automation" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ enabled: false, mode: "manual" })));
    rerender(<AutomationsView />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable automation" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ enabled: true, mode: "manual" })));

    // Run now: the view only names the automation; the backend launches with its saved mode.
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runAutomationNow).toHaveBeenCalledWith("automation-1"));
    expect(automationStore.automations[0].mode).toBe("manual");
  });

  it("does not rewrite a saved Bypass mode on edit or re-enable either", async () => {
    automationStore.automations[0] = { ...automationStore.automations[0], mode: "bypassPermissions", enabled: false };
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit automation" });
    expect(permissions().value).toBe("bypassPermissions");
    expect(bypassWarning()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("switch", { name: "Enable automation" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ enabled: true, mode: "bypassPermissions" })));
  });
});
