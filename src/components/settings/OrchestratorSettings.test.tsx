import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorPatch, OrchestratorSettings, PieceKind, Route, RoutedAgent, RoutingRows, TierModels } from "@/types/orchestration";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  setSettings: vi.fn(),
  tierModels: vi.fn(),
  projects: [] as { path: string; name: string; kind?: string; archived?: boolean }[],
}));

vi.mock("@/lib/api", () => ({
  orchestration: { settings: mocks.settings, setSettings: mocks.setSettings, tierModels: mocks.tierModels },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/lib/settingsFile", () => ({ useSettingsFile: () => ({ revision: 0 }) }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: mocks.projects }) }));

const { OrchestratorTab, RepositoryOrchestratorSettings } = await import("./OrchestratorSettings");
const { defaultRoute, sameRoute } = await import("@/lib/orchestration");

const tierModel = (id: string, label: string, efforts: string[], defaultEffort: string | null = null) => ({ id, label, efforts, defaultEffort });
const FULL = ["low", "medium", "high", "xhigh", "max"];
/** Every tier installed on both agents, as `orchestrator_tier_models` answers. */
const installed = (): TierModels => ({
  claude: { small: tierModel("haiku", "Haiku 5.5", []), mid: tierModel("sonnet", "Sonnet 5.5", FULL, "high"), large: tierModel("opus", "Opus 5.5", FULL, "high"), top: tierModel("fable", "Fable 5.2", FULL, "high") },
  codex: { small: tierModel("gpt-6-luna", "GPT-6 Luna", ["low", "medium"], "low"), mid: tierModel("gpt-6.1-terra", "GPT-6.1 Terra", FULL, "low"), large: tierModel("gpt-6.1-sol", "GPT-6.1 Sol", FULL, "low"), top: tierModel("gpt-6-astra", "GPT-6 Astra", FULL, "medium") },
});

/** The native side's rule for routing cells: `null` takes an override away, and the app keeps only what differs from the built-in table. */
function routed(rows: RoutingRows | undefined, patch: OrchestratorPatch): RoutingRows | undefined {
  const next: Record<string, Record<string, Route>> = patch.resetRouting ? {} : JSON.parse(JSON.stringify(rows ?? {}));
  for (const [kind, cells] of Object.entries(patch.routing ?? {})) {
    for (const [agent, route] of Object.entries(cells ?? {})) {
      const keep = route && (patch.project || !sameRoute(route, defaultRoute(kind as PieceKind)));
      if (keep) (next[kind] ??= {})[agent] = route;
      else if (next[kind]) {
        delete next[kind][agent];
        if (!Object.keys(next[kind]).length) delete next[kind];
      }
    }
  }
  return Object.keys(next).length ? (next as RoutingRows) : undefined;
}

let stored: OrchestratorSettings;
beforeEach(() => {
  stored = { requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions", workersPerRun: 4, workersAtOnce: 8, budgetDollars: 15, budgetPoints: 25, windowCeiling: 85, stallMinutes: 10, reviewDiffLines: 400, projects: {} };
  mocks.projects = [{ path: "/repo", name: "terminalx" }, { path: "/notes", name: "notes", kind: "folder" }];
  mocks.settings.mockReset().mockImplementation(async () => stored);
  mocks.tierModels.mockReset().mockImplementation(async () => installed());
  // The native side's own rule: a project's `null` follows the app again, and an empty answer is no entry.
  mocks.setSettings.mockReset().mockImplementation(async (patch: OrchestratorPatch) => {
    const { project, routing: _cells, resetRouting: _reset, ...rest } = patch;
    if (!project) {
      const { routing: _before, ...kept } = stored;
      const routing = routed(stored.routing, patch);
      return (stored = { ...kept, ...(rest as Partial<OrchestratorSettings>), ...(routing ? { routing } : {}) });
    }
    const own: Record<string, unknown> = { ...stored.projects[project] };
    for (const [key, value] of Object.entries(rest)) value === null ? delete own[key] : (own[key] = value);
    const routing = routed(stored.projects[project]?.routing, patch);
    routing ? (own.routing = routing) : delete own.routing;
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

  it("sets over how many changed lines a verifier reads a result, for the app and for one repository (PRO-278)", async () => {
    const lines = "Changed lines a result is accepted at without a verifier, at most";
    const view = render(<OrchestratorTab />);
    await waitFor(() => expect(limit(lines).disabled).toBe(false));
    expect(limit(lines).value).toBe("400");
    const text = screen.getByTestId("orchestrator-settings").textContent ?? "";
    for (const said of ["Checking results", "None of that uses a model.", "A result this size or smaller whose commands pass is accepted without a model"]) expect(text).toContain(said);
    fireEvent.change(limit(lines), { target: { value: "1000" } });
    fireEvent.blur(limit(lines));
    await waitFor(() => expect(limit(lines).value).toBe("1000"));
    expect(mocks.setSettings.mock.calls.map(([patch]) => patch)).toEqual([{ reviewDiffLines: 1000 }]);
    // Out of its bounds, or not a whole number: not saved, and what is stored is shown again.
    for (const typed of ["0", "100001", "12.5", ""]) {
      fireEvent.change(limit(lines), { target: { value: typed } });
      fireEvent.blur(limit(lines));
    }
    expect(mocks.setSettings).toHaveBeenCalledTimes(1);
    expect(limit(lines).value).toBe("1000");
    view.unmount();

    // A repository's own: empty follows the app's, shown as the placeholder.
    render(<RepositoryOrchestratorSettings projectPath="/repo" />);
    const own = () => limit("Changed lines a result in terminalx is accepted at without a verifier, at most");
    await waitFor(() => expect(own().disabled).toBe(false));
    expect([own().value, own().placeholder]).toEqual(["", "1000"]);
    fireEvent.change(own(), { target: { value: "250" } });
    fireEvent.blur(own());
    await waitFor(() => expect(stored.projects["/repo"]).toEqual({ reviewDiffLines: 250 }));
    fireEvent.change(own(), { target: { value: "" } });
    fireEvent.blur(own());
    await waitFor(() => expect(stored.projects["/repo"]).toBeUndefined());
    expect(mocks.setSettings.mock.calls.slice(1).map(([patch]) => patch)).toEqual([{ project: "/repo", reviewDiffLines: 250 }, { project: "/repo", reviewDiffLines: null }]);
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

describe("No limit for a run's budget and window level (PRO-335)", () => {
  const off = (name: string) => screen.getByRole("switch", { name }) as HTMLElement;

  it("turns the dollar and points budgets off and on again, and shows No limit in place of the field", async () => {
    render(<OrchestratorTab />);
    await waitFor(() => expect(off("Budget per run, API key: No limit").hasAttribute("disabled")).toBe(false));
    expect(off("Budget per run, API key: No limit").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(off("Budget per run, API key: No limit"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ budgetDollars: "none" }));
    await waitFor(() => expect(screen.queryByRole("spinbutton", { name: "Budget per run, API key" })).toBeNull());
    expect(off("Budget per run, API key: No limit").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(off("Budget per run, subscription: No limit"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ budgetPoints: "none" }));
    await waitFor(() => expect(screen.queryByRole("spinbutton", { name: "Budget per run, subscription" })).toBeNull());
    // The window level stays on by itself.
    expect(limit("Pause when a window passes").value).toBe("85");

    // Back on, a budget starts from the default.
    fireEvent.click(off("Budget per run, API key: No limit"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenLastCalledWith({ budgetDollars: 15 }));
    await waitFor(() => expect(limit("Budget per run, API key").value).toBe("15"));
  });

  it("turns the window level off, saying a run can then use the whole window", async () => {
    render(<OrchestratorTab />);
    await waitFor(() => expect(off("Pause when a window passes: Off").hasAttribute("disabled")).toBe(false));
    fireEvent.click(off("Pause when a window passes: Off"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ windowCeiling: "none" }));
    await waitFor(() => expect(screen.getByTestId("orchestrator-settings").textContent).toContain("Off: a run can use the whole window"));
    expect(screen.queryByRole("spinbutton", { name: "Pause when a window passes" })).toBeNull();
  });

  it("shows settings stored with No limit as such", async () => {
    stored = { ...stored, budgetDollars: "none", windowCeiling: "none" };
    render(<OrchestratorTab />);
    await waitFor(() => expect(off("Budget per run, API key: No limit").getAttribute("aria-checked")).toBe("true"));
    expect(off("Pause when a window passes: Off").getAttribute("aria-checked")).toBe("true");
    expect(off("Budget per run, subscription: No limit").getAttribute("aria-checked")).toBe("false");
    expect(limit("Budget per run, subscription").value).toBe("25");
  });

  it("lets a repository choose No limit, shows the default's No limit as its placeholder, and follows the default again", async () => {
    stored = { ...stored, budgetPoints: "none" };
    render(<RepositoryOrchestratorSettings projectPath="/repo" />);
    const points = await screen.findByRole("spinbutton", { name: "Budget per run, subscription in terminalx" });
    await waitFor(() => expect(points.hasAttribute("disabled")).toBe(false));
    expect((points as HTMLInputElement).placeholder).toBe("No limit");

    fireEvent.click(off("Budget per run, API key in terminalx: No limit"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenCalledWith({ project: "/repo", budgetDollars: "none" }));
    await waitFor(() => expect(stored.projects["/repo"]).toEqual({ budgetDollars: "none" }));
    // Off again, the repository has no value of its own: it follows the default.
    fireEvent.click(off("Budget per run, API key in terminalx: No limit"));
    await waitFor(() => expect(mocks.setSettings).toHaveBeenLastCalledWith({ project: "/repo", budgetDollars: null }));
    await waitFor(() => expect(stored.projects["/repo"]).toBeUndefined());
  });
});

const cell = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
const chosen = (select: HTMLSelectElement) => select.selectedOptions[0]?.textContent;
/** The table shows a tier by the model it runs on: wait until that is read. */
const tableRead = () => waitFor(() => expect(chosen(cell("Claude Code model for search"))).toBe("Haiku 5.5"));
const patches = () => mocks.setSettings.mock.calls.map(([patch]) => patch as OrchestratorPatch);

describe("the routing table in Settings → Orchestrator (PRO-275)", () => {
  it("shows the starting model and effort of every kind, a column per agent, as the built-in table has them", async () => {
    render(<OrchestratorTab />);
    await tableRead();
    const table = within(screen.getByRole("table", { name: "Routing table" }));
    expect(table.getAllByRole("columnheader").map((head) => head.textContent)).toEqual(["Kind", "Used for", "Claude Code workers", "Codex workers"]);
    const rows = table.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.dataset.kind)).toEqual(["search", "logs", "scoped-code", "review", "code", "refactor", "research", "verify"]);
    const shown = (kind: string) => [chosen(cell(`Claude Code model for ${kind}`)), chosen(cell(`Claude Code effort for ${kind}`)), chosen(cell(`Codex model for ${kind}`)), chosen(cell(`Codex effort for ${kind}`))];
    // Small on the model's own default; mid, large and top at medium. The same tiers for both agents.
    for (const kind of ["search", "logs"]) expect(shown(kind)).toEqual(["Haiku 5.5", "Default", "GPT-6 Luna", "Default"]);
    for (const kind of ["scoped-code", "review", "verify"]) expect(shown(kind)).toEqual(["Sonnet 5.5", "Medium", "GPT-6.1 Terra", "Medium"]);
    expect(shown("code")).toEqual(["Opus 5.5", "Medium", "GPT-6.1 Sol", "Medium"]);
    for (const kind of ["refactor", "research"]) expect(shown(kind)).toEqual(["Fable 5.2", "Medium", "GPT-6 Astra", "Medium"]);
    // A row names a tier, not a version: the value is the tier, the text is what it runs on today.
    expect(cell("Claude Code model for code").value).toBe("large");
    expect([...cell("Codex model for code").options].map((option) => [option.value, option.textContent])).toEqual([["small", "GPT-6 Luna"], ["mid", "GPT-6.1 Terra"], ["large", "GPT-6.1 Sol"], ["top", "GPT-6 Astra"]]);
    expect(screen.getByText(/Rows name a tier, so a new release of a model takes its place/)).toBeTruthy();
    // Nothing was changed: there is nothing to reset.
    expect(screen.getByRole("button", { name: "Reset to defaults" }).hasAttribute("disabled")).toBe(true);
  });

  it("saves one cell at a time, for the agent whose column it is in", async () => {
    render(<OrchestratorTab />);
    await tableRead();
    fireEvent.change(cell("Claude Code model for code"), { target: { value: "mid" } });
    await waitFor(() => expect(chosen(cell("Claude Code model for code"))).toBe("Sonnet 5.5"));
    // The Codex column is its own.
    expect(chosen(cell("Codex model for code"))).toBe("GPT-6.1 Sol");
    fireEvent.change(cell("Codex effort for review"), { target: { value: "high" } });
    await waitFor(() => expect(chosen(cell("Codex effort for review"))).toBe("High"));
    fireEvent.change(cell("Codex effort for review"), { target: { value: "" } });
    await waitFor(() => expect(chosen(cell("Codex effort for review"))).toBe("Default"));
    expect(patches()).toEqual([
      { routing: { code: { claude: { tier: "mid", effort: "medium" } } } },
      { routing: { review: { codex: { tier: "mid", effort: "high" } } } },
      { routing: { review: { codex: { tier: "mid" } } } },
    ]);
    expect(stored.routing).toEqual({ code: { claude: { tier: "mid", effort: "medium" } }, review: { codex: { tier: "mid" } } });
    // Choosing what a cell already shows saves nothing.
    fireEvent.change(cell("Claude Code model for logs"), { target: { value: "small" } });
    expect(patches()).toHaveLength(3);
  });

  it("offers a tier's model only the efforts that model has, and drops one it does not", async () => {
    render(<OrchestratorTab />);
    await tableRead();
    // Haiku has no effort levels; Luna has two.
    expect([...cell("Claude Code effort for search").options].map((option) => option.textContent)).toEqual(["Default"]);
    expect([...cell("Codex effort for search").options].map((option) => option.textContent)).toEqual(["Default", "Low", "Medium"]);
    expect([...cell("Claude Code effort for code").options].map((option) => option.textContent)).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
    // Code moved down to the small tier: medium is not Haiku's to run at.
    fireEvent.change(cell("Claude Code model for code"), { target: { value: "small" } });
    await waitFor(() => expect(chosen(cell("Claude Code model for code"))).toBe("Haiku 5.5"));
    expect(patches()).toEqual([{ routing: { code: { claude: { tier: "small" } } } }]);
    expect(chosen(cell("Claude Code effort for code"))).toBe("Default");
  });

  it("puts every row back with Reset to defaults", async () => {
    stored = { ...stored, routing: { code: { claude: { tier: "top", effort: "high" } }, search: { codex: { tier: "mid" } } } };
    render(<OrchestratorTab />);
    await waitFor(() => expect(chosen(cell("Claude Code model for code"))).toBe("Fable 5.2"));
    expect([chosen(cell("Claude Code effort for code")), chosen(cell("Codex model for search"))]).toEqual(["High", "GPT-6.1 Terra"]);
    const reset = screen.getByRole("button", { name: "Reset to defaults" });
    expect(reset.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reset);
    await waitFor(() => expect(chosen(cell("Claude Code model for code"))).toBe("Opus 5.5"));
    expect(patches()).toEqual([{ resetRouting: true }]);
    expect([chosen(cell("Claude Code effort for code")), chosen(cell("Codex model for search")), stored.routing]).toEqual(["Medium", "GPT-6 Luna", undefined]);
    expect(reset.hasAttribute("disabled")).toBe(true);
  });

  it("says so where an agent has no model of a tier installed", async () => {
    const models = installed();
    models.codex.top = null;
    mocks.tierModels.mockImplementation(async () => models);
    render(<OrchestratorTab />);
    await tableRead();
    expect(chosen(cell("Codex model for refactor"))).toBe("Astra (not installed)");
    const refactor = within(document.querySelector<HTMLElement>('[data-kind="refactor"]')!);
    expect(refactor.getByRole("note").textContent).toBe("No top model installed: runs on the lead's model");
    // Claude Code has one: nothing is said in its cell, or in a row whose tiers are installed.
    expect(refactor.getAllByRole("note")).toHaveLength(1);
    expect(within(document.querySelector<HTMLElement>('[data-kind="code"]')!).queryByRole("note")).toBeNull();
  });

  it("names a tier by its family until the installed models are read", async () => {
    mocks.tierModels.mockImplementation(() => new Promise(() => {}));
    render(<OrchestratorTab />);
    await waitFor(() => expect(cell("Claude Code model for code").hasAttribute("disabled")).toBe(false));
    expect([chosen(cell("Claude Code model for code")), chosen(cell("Codex model for code")), chosen(cell("Codex model for research"))]).toEqual(["Opus", "Sol", "Astra"]);
  });
});

describe("a repository's own routing table (PRO-275)", () => {
  const agents: RoutedAgent[] = ["claude", "codex"];

  it("follows the app's row until it names a tier of its own, and goes back to following it", async () => {
    stored = { ...stored, routing: { code: { claude: { tier: "mid", effort: "high" } } } };
    render(<RepositoryOrchestratorSettings projectPath="/repo" />);
    const own = within(await screen.findByRole("region", { name: "Starting model by kind of piece in terminalx" }));
    const select = (name: string) => own.getByRole("combobox", { name }) as HTMLSelectElement;
    // What it follows is the app's row where the app changed one, the built-in one elsewhere.
    await waitFor(() => expect(chosen(select("Claude Code model for code"))).toBe("Default (Sonnet 5.5)"));
    expect([select("Claude Code model for code").value, chosen(select("Claude Code effort for code")), chosen(select("Codex model for code"))]).toEqual(["", "High", "Default (GPT-6.1 Sol)"]);
    // A cell that follows the app takes its effort with its tier.
    for (const agent of agents) expect(select(`${agent === "claude" ? "Claude Code" : "Codex"} effort for code`).hasAttribute("disabled")).toBe(true);
    expect(own.getByRole("button", { name: "Follow the defaults" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(select("Claude Code model for code"), { target: { value: "top" } });
    await waitFor(() => expect(chosen(select("Claude Code model for code"))).toBe("Fable 5.2"));
    expect(select("Claude Code effort for code").hasAttribute("disabled")).toBe(false);
    fireEvent.change(select("Claude Code effort for code"), { target: { value: "medium" } });
    await waitFor(() => expect(stored.projects["/repo"]).toEqual({ routing: { code: { claude: { tier: "top", effort: "medium" } } } }));
    // The app's own table is untouched.
    expect(stored.routing).toEqual({ code: { claude: { tier: "mid", effort: "high" } } });

    fireEvent.change(select("Claude Code model for code"), { target: { value: "" } });
    await waitFor(() => expect(stored.projects).toEqual({}));
    expect(patches()).toEqual([
      { project: "/repo", routing: { code: { claude: { tier: "top", effort: "high" } } } },
      { project: "/repo", routing: { code: { claude: { tier: "top", effort: "medium" } } } },
      { project: "/repo", routing: { code: { claude: null } } },
    ]);
    // The select follows the saved table one render after the store has it.
    await waitFor(() => expect(chosen(select("Claude Code model for code"))).toBe("Default (Sonnet 5.5)"));
  });

  it("drops every row of its own with Follow the defaults", async () => {
    stored = { ...stored, projects: { "/repo": { pieceLimit: 3, routing: { search: { claude: { tier: "mid", effort: "low" } }, verify: { codex: { tier: "large" } } } } } };
    render(<RepositoryOrchestratorSettings projectPath="/repo" />);
    const own = within(await screen.findByRole("region", { name: "Starting model by kind of piece in terminalx" }));
    await waitFor(() => expect(chosen(own.getByRole("combobox", { name: "Claude Code model for search" }) as HTMLSelectElement)).toBe("Sonnet 5.5"));
    fireEvent.click(own.getByRole("button", { name: "Follow the defaults" }));
    // Its other answers stay.
    await waitFor(() => expect(stored.projects["/repo"]).toEqual({ pieceLimit: 3 }));
    expect(patches()).toEqual([{ project: "/repo", resetRouting: true }]);
  });
});
