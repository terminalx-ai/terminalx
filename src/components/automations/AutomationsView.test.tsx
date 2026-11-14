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
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  BYPASS_MODE: "bypassPermissions",
  DEFAULT_AUTOMATION_MODE: "bypassPermissions",
  PERMISSION_MODES: [
    { id: "manual", label: "Ask every time" },
    { id: "auto", label: "Auto" },
    { id: "bypassPermissions", label: "Bypass permissions" },
  ],
  bypassEffect: () => ({ flag: "--dangerously-skip-permissions", effect: "Claude Code stops asking about anything." }),
  refreshModels,
  useModels: (harness?: string) => catalog.models.filter((m) => !harness || m.harness === harness),
}));
// The interactive-session preference is deliberately "auto" (and "manual" in
// one test) so a leak from prefs.lastMode into a new automation is visible.
const { catalog, refreshModels, setPrefs } = vi.hoisted(() => ({
  catalog: { models: [
    { id: "sonnet", label: "Sonnet", harness: "claude", isDefault: true, efforts: ["low", "high"], defaultEffort: "high", alias: true },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", harness: "claude", isDefault: false, efforts: ["low", "high"], defaultEffort: "high", alias: false },
    { id: "gpt-6-astra", label: "GPT-6 Astra", harness: "codex", isDefault: true, efforts: ["low", "medium"], defaultEffort: "medium", alias: false },
  ] },
  refreshModels: vi.fn(async () => {}),
  setPrefs: vi.fn(),
}));
const discovery = vi.hoisted(() => ({
  harnesses: [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }],
}));
const prefs = vi.hoisted(() => ({ lastProject: "/repo", lastAgent: "claude", lastModel: {} as Record<string, string>, lastMode: "auto", lastEffort: {} as Record<string, string> }));
vi.mock("@/lib/prefs", () => ({
  setPrefs,
  usePrefs: () => prefs,
  getPrefs: () => prefs,
  subscribePrefs: () => () => {},
}));
// The store lists archived sessions too, flagged: only the sidebar filters them out.
const sessionList = vi.hoisted(() => ({ archived: false }));
vi.mock("@/lib/sessions", () => ({
  selectSession,
  useSessionStore: () => ({
    projects: [{ path: "/repo", name: "Raccoon" }, { path: "/docs", name: "Docs", kind: "folder" }],
    harnesses: discovery.harnesses,
    sessions: [{ id: "session-7", title: "Automation run 7", projectPath: "/repo", archived: sessionList.archived }],
  }),
}));

const { AutomationsView } = await import("./AutomationsView");
const initialModels = structuredClone(catalog.models);
const initialHarnesses = structuredClone(discovery.harnesses);

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
    archiveOnComplete: false,
    keepLatestRunVisible: false,
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
  catalog.models = structuredClone(initialModels);
  discovery.harnesses = structuredClone(initialHarnesses);
  automationStore.automations = [
    automation("automation-1", "Dependency audit"),
    { ...automation("automation-2", "Release notes"), projectPath: "/docs" },
  ];
  automationStore.runs = { "automation-1": [run()] };
  automationStore.loadingRuns = {};
  sessionList.archived = false;
  prefs.lastMode = "auto";
  prefs.lastModel = {};
  prefs.lastEffort = {};
  refreshModels.mockClear();
  setPrefs.mockClear();
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
  const permissions = () => screen.getByTitle("Permissions");
  const trigger = (name: string) => screen.getByRole("radio", { name });
  const bypassWarning = () => screen.queryByRole("note", { name: "Bypass permissions warning" });

  it.each(["auto", "manual"])("defaults a new scheduled automation to Bypass permissions when the interactive-session mode is %s", async (lastMode) => {
    prefs.lastMode = lastMode;
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    await screen.findByRole("heading", { name: "New automation" });

    expect(permissions().textContent).toBe("Bypass permissions");
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
    expect(permissions().textContent).toBe("Bypass permissions");
    expect(bypassWarning()).toBeTruthy();
    expect(screen.getByText(/Issue titles and descriptions can be untrusted/).textContent).toContain("each run uses the Permissions mode chosen above");
    expect(screen.queryByText(/start in Auto permissions/)).toBeNull();

    // An explicit choice survives too, both ways, and the warning follows the mode.
    await pick("Permissions", "Ask every time");
    expect(bypassWarning()).toBeNull();
    fireEvent.click(trigger("Schedule"));
    expect(permissions().textContent).toBe("Ask every time");
    fireEvent.click(trigger("GitHub issues"));
    expect(permissions().textContent).toBe("Ask every time");
    expect(bypassWarning()).toBeNull();

    await pick("Permissions", "Bypass permissions");
    expect(bypassWarning()).toBeTruthy();
    fireEvent.click(trigger("Schedule"));
    expect(permissions().textContent).toBe("Bypass permissions");
  });

  it("preserves an explicitly configured non-bypass mode through edit, disable, re-enable and Run now", async () => {
    automationStore.automations[0] = { ...automationStore.automations[0], mode: "manual" };
    const { rerender } = render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));

    // Edit: the saved mode is shown, not the interactive default, and is saved back untouched.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit automation" });
    expect(permissions().textContent).toBe("Ask every time");
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
    expect(permissions().textContent).toBe("Bypass permissions");
    expect(bypassWarning()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("switch", { name: "Enable automation" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ enabled: true, mode: "bypassPermissions" })));
  });
});


it("offers existing-session automations without Git actions for folders", async () => {
  prefs.lastProject = "/docs";
  try {
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    await screen.findByRole("heading", { name: "New automation" });
    expect(screen.queryByRole("radio", { name: "New worktree per run" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "GitHub issues" })).toBeNull();
    expect(await screen.findByLabelText("Session")).toBeTruthy();
  } finally {
    prefs.lastProject = "/repo";
  }
});

async function pick(title: string, name: string) {
  fireEvent.click(screen.getByTitle(title));
  fireEvent.click(await screen.findByRole(title === "Agent" ? "menuitem" : "menuitemradio", { name }));
}

describe("automation launch controls", () => {
  async function edit() {
    const view = render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit automation" });
    return view;
  }

  it.each([false, true])("seeds a discovered agent without clearing the draft (models arrive later: %s)", async (lateModels) => {
    discovery.harnesses = [];
    prefs.lastModel = { claude: "claude-sonnet-4-6" };
    if (lateModels) catalog.models = [];
    const view = render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Draft before discovery" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Keep this prompt." } });
    await pick("Permissions", "Ask every time");
    expect((screen.getByRole("button", { name: "Create automation" }) as HTMLButtonElement).disabled).toBe(true);

    // Only one installed agent: there is no other agent to switch through.
    discovery.harnesses = [structuredClone(initialHarnesses[0])];
    view.rerender(<AutomationsView />);
    if (lateModels) {
      catalog.models = structuredClone(initialModels);
      view.rerender(<AutomationsView />);
    }
    expect(screen.getByTitle("Agent").textContent).toContain("Claude Code");
    expect(screen.getByTitle("Model").textContent).toBe("Sonnet 4.6");
    expect(screen.getByTitle("Permissions").textContent).toBe("Ask every time");
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Draft before discovery");
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("Keep this prompt.");
    expect((screen.getByRole("button", { name: "Create automation" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({
      name: "Draft before discovery", prompt: "Keep this prompt.", harness: "claude",
      model: "claude-sonnet-4-6", effort: null, mode: "manual",
    })));
    expect(setPrefs).not.toHaveBeenCalled();
  });

  it("uses a valid saved preference when models arrive after opening a new draft", async () => {
    prefs.lastModel = { claude: "claude-sonnet-4-6" };
    catalog.models = [];
    const view = render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved draft" } });
    catalog.models = structuredClone(initialModels);
    view.rerender(<AutomationsView />);
    expect(screen.getByTitle("Model").textContent).toBe("Sonnet 4.6");
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unsaved draft");
    expect(setPrefs).not.toHaveBeenCalled();
  });

  it("keeps the draft when a refresh removes its model", async () => {
    const view = await edit();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved draft" } });
    catalog.models = catalog.models.filter((m) => m.id !== "sonnet");
    view.rerender(<AutomationsView />);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unsaved draft");
    expect(screen.getByTitle("Model").textContent).toBe("Unavailable: sonnet");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refreshes grouped, annotated models without resetting the edit and saves Default effort", async () => {
    await edit();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Changed audit" } });
    fireEvent.click(screen.getByTitle("Model"));
    expect(refreshModels).toHaveBeenCalledOnce();
    expect(await screen.findByText("Pinned version")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Sonnetlatest" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet 4.6" }));
    await pick("Effort", "High");
    await pick("Effort", "Default");
    await pick("Permissions", "Bypass permissions");
    expect(screen.getByRole("note", { name: "Bypass permissions warning" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenCalledWith("automation-1", expect.objectContaining({
      name: "Changed audit", model: "claude-sonnet-4-6", effort: null, mode: "bypassPermissions",
    })));
    expect(setPrefs).not.toHaveBeenCalled();
    expect(prefs.lastMode).toBe("auto");
  });

  it.each(["retired-model", "gpt-6-astra"])("flags saved unavailable model %s until explicitly replaced", async (model) => {
    automationStore.automations[0].model = model;
    await edit();
    expect(screen.getByTitle("Model").textContent).toBe(`Unavailable: ${model}`);
    expect(screen.getByRole("alert").textContent).toContain("Model no longer available");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    await pick("Model", "Sonnetlatest");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenCalledWith("automation-1", expect.objectContaining({ model: "sonnet" })));
  });

  it("validates retired preferences for a new automation and resets model and effort on agent switch", async () => {
    prefs.lastModel = { claude: "retired", codex: "sonnet" };
    prefs.lastEffort = { codex: "max" };
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    expect(screen.getByTitle("Model").textContent).toContain("Sonnet");
    await pick("Effort", "High");
    await pick("Agent", "Codex");
    expect(screen.getByTitle("Model").textContent).toBe("GPT-6 Astra");
    expect(screen.getByTitle("Effort").textContent).toBe("Default");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Codex audit" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Audit" } });
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({
      harness: "codex", model: "gpt-6-astra", effort: null, mode: "bypassPermissions",
    })));
    expect(setPrefs).not.toHaveBeenCalled();
    expect(prefs.lastModel).toEqual({ claude: "retired", codex: "sonnet" });
  });
});

describe("archiving a run when it completes", () => {
  const archive = () => screen.getByRole("switch", { name: "Archive each run when it completes" });
  const keepLatest = () => screen.queryByRole("switch", { name: "Keep the latest run visible" });

  it("is on for a new automation and saves with it", async () => {
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    await screen.findByRole("heading", { name: "New automation" });
    expect(archive().getAttribute("aria-checked")).toBe("true");
    expect(keepLatest()?.getAttribute("aria-checked")).toBe("false");

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Nightly audit" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Run the nightly audit." } });
    fireEvent.click(keepLatest()!);
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
    await screen.findByRole("heading", { name: "Nightly audit" });
    expect(createAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ archiveOnComplete: true, keepLatestRunVisible: true }));
  });

  it("leaves an existing automation as it was until the switch is turned on", async () => {
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit automation" });
    expect(archive().getAttribute("aria-checked")).toBe("false");
    expect(keepLatest()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("table", { name: "Automation runs" });
    expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ archiveOnComplete: false, keepLatestRunVisible: false }));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit automation" });
    fireEvent.click(archive());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("table", { name: "Automation runs" });
    expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ archiveOnComplete: true }));
  });

  it("keeps the switches through Disable and Enable in the list", async () => {
    automationStore.automations[0] = { ...automationStore.automations[0], archiveOnComplete: true, keepLatestRunVisible: true };
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Disable automation" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenLastCalledWith("automation-1", expect.objectContaining({ enabled: false, archiveOnComplete: true, keepLatestRunVisible: true })));
  });

  it("says there is nothing to archive when every run reuses one session", async () => {
    automationStore.automations[0] = { ...automationStore.automations[0], workspace: "session", sessionId: "session-7", reuseSession: true, archiveOnComplete: true };
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit automation" });
    expect(screen.queryByRole("switch", { name: "Archive each run when it completes" })).toBeNull();
    expect(screen.getByText(/nothing to archive/)).toBeTruthy();
  });

  it("lists an archived run in the history and opens its session", async () => {
    sessionList.archived = true;
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));
    expect(await screen.findByText("Archived")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand run 7" }));
    fireEvent.click(screen.getByRole("button", { name: "Open run session" }));
    expect(selectSession).toHaveBeenCalledWith("session-7");
  });

  it("marks no run archived while its session is in the sidebar", async () => {
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: /Dependency audit/ }));
    await screen.findByRole("table", { name: "Automation runs" });
    expect(screen.queryByText("Archived")).toBeNull();
  });
});
