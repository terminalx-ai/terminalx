import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorPatch, OrchestratorSettings } from "@/types/orchestration";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  setSettings: vi.fn(),
  projects: [] as { path: string; name: string; kind?: string; archived?: boolean }[],
}));

vi.mock("@/lib/api", () => ({
  orchestration: { settings: mocks.settings, setSettings: mocks.setSettings },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/lib/settingsFile", () => ({ useSettingsFile: () => ({ revision: 0 }) }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: mocks.projects }) }));

const { OrchestratorTab, RepositoryOrchestratorSettings } = await import("./OrchestratorSettings");

let stored: OrchestratorSettings;
beforeEach(() => {
  stored = { requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions", workersPerRun: 4, workersAtOnce: 8, budgetDollars: 15, budgetPoints: 25, windowCeiling: 85, stallMinutes: 10, projects: {} };
  mocks.projects = [{ path: "/repo", name: "terminalx" }, { path: "/notes", name: "notes", kind: "folder" }];
  mocks.settings.mockReset().mockImplementation(async () => stored);
  // The native side's own rule: a project's `null` follows the app again, and an empty answer is no entry.
  mocks.setSettings.mockReset().mockImplementation(async ({ project, ...rest }: OrchestratorPatch) => {
    if (!project) return (stored = { ...stored, ...(rest as Partial<OrchestratorSettings>) });
    const own: Record<string, unknown> = { ...stored.projects[project] };
    for (const [key, value] of Object.entries(rest)) value === null ? delete own[key] : (own[key] = value);
    const projects = { ...stored.projects, [project]: own };
    if (!Object.keys(own).length) delete projects[project];
    return (stored = { ...stored, projects });
  });
});
afterEach(cleanup);

const limit = (name: RegExp | string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;

describe("Settings → Orchestrator (PRO-274)", () => {
  it("shows the three limits as stored and says what each does", async () => {
    render(<OrchestratorTab />);
    const ask = screen.getByRole("switch", { name: "Ask before a run starts" });
    await waitFor(() => expect(ask.hasAttribute("disabled")).toBe(false));
    expect(ask.getAttribute("aria-checked")).toBe("true");
    expect(limit("Pieces per run, at most").value).toBe("8");
    expect((screen.getByRole("combobox", { name: "Workers run in" }) as HTMLSelectElement).value).toBe("bypassPermissions");
    const text = screen.getByTestId("orchestrator-settings").textContent ?? "";
    for (const said of ["Show the plan and wait for Approve.", "A larger plan is refused, and the lead is told the limit. From 1 to 50.", "Push, merge and deploy stay blocked by deny rules in every mode."]) {
      expect(text).toContain(said);
    }
  });

  it("saves each setting by itself, and shows what the Mac saved", async () => {
    render(<OrchestratorTab />);
    const ask = screen.getByRole("switch", { name: "Ask before a run starts" });
    await waitFor(() => expect(ask.hasAttribute("disabled")).toBe(false));
    fireEvent.click(ask);
    await waitFor(() => expect(ask.getAttribute("aria-checked")).toBe("false"));
    fireEvent.change(limit("Pieces per run, at most"), { target: { value: "12" } });
    fireEvent.blur(limit("Pieces per run, at most"));
    await waitFor(() => expect(limit("Pieces per run, at most").value).toBe("12"));
    fireEvent.change(screen.getByRole("combobox", { name: "Workers run in" }), { target: { value: "acceptEdits" } });
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledTimes(3));
    expect(mocks.setSettings.mock.calls.map(([patch]) => patch)).toEqual([{ requireApproval: false }, { pieceLimit: 12 }, { workerMode: "acceptEdits" }]);
  });

  it("does not save a limit that is not a number of pieces from 1 to 50", async () => {
    render(<OrchestratorTab />);
    await waitFor(() => expect(limit("Pieces per run, at most").disabled).toBe(false));
    for (const typed of ["0", "51", "2.5", "", "many"]) {
      fireEvent.change(limit("Pieces per run, at most"), { target: { value: typed } });
      fireEvent.blur(limit("Pieces per run, at most"));
      // The field goes back to what is stored.
      expect(limit("Pieces per run, at most").value).toBe("8");
    }
    // The stored value typed again is not a change.
    fireEvent.change(limit("Pieces per run, at most"), { target: { value: "8" } });
    fireEvent.blur(limit("Pieces per run, at most"));
    expect(mocks.setSettings).not.toHaveBeenCalled();
  });

  it("says why when a save fails, and keeps showing what is stored", async () => {
    mocks.setSettings.mockRejectedValue(new Error("settings.json is not writable"));
    render(<OrchestratorTab />);
    const ask = screen.getByRole("switch", { name: "Ask before a run starts" });
    await waitFor(() => expect(ask.hasAttribute("disabled")).toBe(false));
    fireEvent.click(ask);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("settings.json is not writable"));
    expect(ask.getAttribute("aria-checked")).toBe("true");
  });
});

describe("a repository's own orchestrator settings (PRO-274)", () => {
  it("follows the app until it answers for itself, one setting at a time", async () => {
    stored = { ...stored, pieceLimit: 10, workerMode: "acceptEdits" };
    render(<RepositoryOrchestratorSettings projectPath="/repo" />);
    const own = within(await screen.findByTestId("repository-orchestrator-settings"));
    await waitFor(() => expect(own.getByRole("radio", { name: "Default (on)" }).getAttribute("aria-checked")).toBe("true"));
    // What it follows is shown where its own answer would be.
    expect(limit(/Pieces per run in terminalx/).value).toBe("");
    expect(limit(/Pieces per run in terminalx/).placeholder).toBe("10");
    const mode = own.getByRole("combobox", { name: "Workers of terminalx run in" }) as HTMLSelectElement;
    expect([mode.value, mode.options[0].textContent]).toEqual(["", "Default (Accept edits)"]);

    fireEvent.click(own.getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(own.getByRole("radio", { name: "Off" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.change(limit(/Pieces per run in terminalx/), { target: { value: "3" } });
    fireEvent.blur(limit(/Pieces per run in terminalx/));
    await waitFor(() => expect(limit(/Pieces per run in terminalx/).value).toBe("3"));
    fireEvent.change(mode, { target: { value: "manual" } });
    await waitFor(() => expect(stored.projects["/repo"]).toEqual({ requireApproval: false, pieceLimit: 3, workerMode: "manual" }));
    expect(mocks.setSettings.mock.calls.map(([patch]) => patch)).toEqual([
      { project: "/repo", requireApproval: false },
      { project: "/repo", pieceLimit: 3 },
      { project: "/repo", workerMode: "manual" },
    ]);

    // Each goes back to following the app by itself: the field emptied, Default chosen.
    fireEvent.change(limit(/Pieces per run in terminalx/), { target: { value: "" } });
    fireEvent.blur(limit(/Pieces per run in terminalx/));
    fireEvent.click(own.getByRole("radio", { name: "Default (on)" }));
    fireEvent.change(mode, { target: { value: "" } });
    await waitFor(() => expect(stored.projects).toEqual({}));
    expect(mocks.setSettings.mock.calls.slice(3).map(([patch]) => patch)).toEqual([
      { project: "/repo", pieceLimit: null },
      { project: "/repo", requireApproval: null },
      { project: "/repo", workerMode: null },
    ]);
  });

  it("is not offered for a folder that is not a git repository, or a project that is gone", () => {
    const { container } = render(<><RepositoryOrchestratorSettings projectPath="/notes" /><RepositoryOrchestratorSettings projectPath="/removed" /></>);
    expect(container.textContent).toBe("");
  });
});

describe("Settings → Orchestrator, limits and budget (PRO-280)", () => {
  it("shows the worker limits, the budget and the stall time as stored", async () => {
    render(<OrchestratorTab />);
    await waitFor(() => expect(limit("Workers at once, per run").hasAttribute("disabled")).toBe(false));
    expect(limit("Workers at once, per run").value).toBe("4");
    expect(limit("Workers at once, whole app").value).toBe("8");
    expect(limit("Budget per run, API key").value).toBe("15");
    expect(limit("Budget per run, subscription").value).toBe("25");
    expect(limit("Pause when a window passes").value).toBe("85");
    expect(limit("Mark a worker stalled after").value).toBe("10");
    const text = screen.getByTestId("orchestrator-settings").textContent ?? "";
    for (const said of ["Budget and stalls", "Sessions you start by hand are never counted or queued.", "A long build is not a stall."]) expect(text).toContain(said);
  });

  it("saves a changed points budget and window level, and refuses a value out of range", async () => {
    render(<OrchestratorTab />);
    await waitFor(() => expect(limit("Budget per run, subscription").hasAttribute("disabled")).toBe(false));
    fireEvent.change(limit("Budget per run, subscription"), { target: { value: "40" } });
    fireEvent.blur(limit("Budget per run, subscription"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ budgetPoints: 40 }));
    fireEvent.change(limit("Pause when a window passes"), { target: { value: "90" } });
    fireEvent.keyDown(limit("Pause when a window passes"), { key: "Enter" });
    fireEvent.blur(limit("Pause when a window passes"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ windowCeiling: 90 }));
    fireEvent.change(limit("Budget per run, API key"), { target: { value: "7.5" } });
    fireEvent.blur(limit("Budget per run, API key"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ budgetDollars: 7.5 }));
    mocks.setSettings.mockClear();
    fireEvent.change(limit("Workers at once, per run"), { target: { value: "0" } });
    fireEvent.blur(limit("Workers at once, per run"));
    fireEvent.change(limit("Pause when a window passes"), { target: { value: "120" } });
    fireEvent.blur(limit("Pause when a window passes"));
    expect(mocks.setSettings).not.toHaveBeenCalled();
    expect(limit("Workers at once, per run").value).toBe("4");
  });

  it("lets a repository set its own budget, and follow the default again when emptied", async () => {
    render(<RepositoryOrchestratorSettings projectPath="/repo" />);
    const points = await screen.findByRole("spinbutton", { name: "Budget per run, subscription in terminalx" });
    await waitFor(() => expect(points.hasAttribute("disabled")).toBe(false));
    expect((points as HTMLInputElement).placeholder).toBe("25");
    fireEvent.change(points, { target: { value: "10" } });
    fireEvent.blur(points);
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ project: "/repo", budgetPoints: 10 }));
    await waitFor(() => expect((points as HTMLInputElement).value).toBe("10"));
    fireEvent.change(points, { target: { value: "" } });
    fireEvent.blur(points);
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ project: "/repo", budgetPoints: null }));
    await waitFor(() => expect(stored.projects["/repo"]).toBeUndefined());
  });
});
