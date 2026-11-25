import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  setNativeCodex: vi.fn(),
  setSessionCost: vi.fn(),
  setOrchestratorRuns: vi.fn(),
  setOpenCode: vi.fn(),
  setBots: vi.fn(),
  unsupported: vi.fn(),
  refreshHarnesses: vi.fn(async () => {}),
  refreshModels: vi.fn(async () => {}),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", () => ({
  experimental: { settings: mocks.settings, setNativeCodex: mocks.setNativeCodex, setSessionCost: mocks.setSessionCost, setOrchestratorRuns: mocks.setOrchestratorRuns, setOpenCode: mocks.setOpenCode, setBots: mocks.setBots, unsupported: mocks.unsupported },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/lib/sessions", () => ({ refreshHarnesses: mocks.refreshHarnesses }));
vi.mock("@/lib/models", () => ({ refreshModels: mocks.refreshModels }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));

const { ExperimentalTab } = await import("./ExperimentalSettings");

beforeEach(() => {
  mocks.settings.mockReset().mockResolvedValue({ nativeCodex: false });
  mocks.setNativeCodex.mockReset();
  mocks.setSessionCost.mockReset();
  mocks.setOrchestratorRuns.mockReset();
  mocks.setOpenCode.mockReset();
  mocks.setBots.mockReset();
  mocks.unsupported.mockReset().mockResolvedValue({});
  mocks.refreshHarnesses.mockClear();
  mocks.refreshModels.mockClear();
});
afterEach(cleanup);

const toggle = () => screen.getByRole("switch", { name: "Native Codex" });

describe("Settings → Experimental: session cost (PRO-273)", () => {
  const cost = () => screen.getByRole("switch", { name: "Session cost" });

  it("is off by default, says the figure is not a bill, and saves only its own switch", async () => {
    mocks.setSessionCost.mockResolvedValue({ nativeCodex: false, sessionCost: true });
    render(<ExperimentalTab />);
    await waitFor(() => expect(cost().hasAttribute("disabled")).toBe(false));
    expect(cost().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("experimental-settings").textContent).toContain("not what you are billed");
    fireEvent.click(cost());
    await waitFor(() => expect(mocks.setSessionCost).toHaveBeenCalledWith(true));
    await waitFor(() => expect(cost().getAttribute("aria-checked")).toBe("true"));
    expect(mocks.setNativeCodex).not.toHaveBeenCalled();
  });
});

describe("Settings → Experimental: no Machines switch (PRO-360)", () => {
  it("offers no Machines switch: Machines is on for everyone, in Settings → Machines", async () => {
    render(<ExperimentalTab />);
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("switch", { name: "Machines" })).toBeNull();
    expect(screen.getByTestId("experimental-settings").textContent).not.toContain("Settings → Machines");
  });
});

describe("Settings → Experimental (#644)", () => {
  it("offers Native Codex off by default and says what it changes in plain words", async () => {
    render(<ExperimentalTab />);
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    const text = screen.getByTestId("experimental-settings").textContent ?? "";
    for (const said of ["connect to Codex directly", "shows when it compacts", "Codex 0.164.0 or newer", "Codex’s own terminal"]) {
      expect(text).toContain(said);
    }
  });

  it("turns it on for the next new session and shows what the Mac saved", async () => {
    mocks.setNativeCodex.mockResolvedValue({ nativeCodex: true });
    render(<ExperimentalTab />);
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle());
    await waitFor(() => expect(mocks.setNativeCodex).toHaveBeenCalledWith(true));
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  });

  it("puts the switch back and says why when saving fails", async () => {
    mocks.settings.mockResolvedValue({ nativeCodex: true });
    mocks.setNativeCodex.mockRejectedValue(new Error("settings.json is not writable"));
    render(<ExperimentalTab />);
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("settings.json is not writable"));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("follows a change made from a paired phone while it is open", async () => {
    render(<ExperimentalTab />);
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    await waitFor(() => expect(mocks.listeners.has("experimental_settings_changed")).toBe(true));
    mocks.listeners.get("experimental_settings_changed")!({ payload: { nativeCodex: true } });
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    cleanup();
    await waitFor(() => expect(mocks.listeners.has("experimental_settings_changed")).toBe(false));
  });
});

const runs = () => screen.getByRole("switch", { name: "Orchestration runs" });

describe("Settings → Experimental: orchestration runs (PRO-274)", () => {
  it("is off until turned on, and says what it shows and what works either way", async () => {
    render(<ExperimentalTab />);
    await waitFor(() => expect(runs().hasAttribute("disabled")).toBe(false));
    expect(runs().getAttribute("aria-checked")).toBe("false");
    const text = screen.getByTestId("experimental-settings").textContent ?? "";
    for (const said of ["splitting one goal into pieces for worker sessions", "the Run view", "Settings → Orchestrator"]) {
      expect(text).toContain(said);
    }
  });

  it("saves through its own command, leaves Native Codex as it is, and shows the feature at once", async () => {
    mocks.settings.mockResolvedValue({ nativeCodex: true, orchestratorRuns: false });
    mocks.setOrchestratorRuns.mockResolvedValue({ nativeCodex: true, orchestratorRuns: true });
    const { useExperimentalSettings, resetExperimentalSettingsForTests } = await import("@/lib/experimentalSettings");
    resetExperimentalSettingsForTests();
    const Shown = () => <output data-testid="runs-shown">{String(useExperimentalSettings()?.orchestratorRuns === true)}</output>;
    render(<><ExperimentalTab /><Shown /></>);
    await waitFor(() => expect(runs().hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("runs-shown").textContent).toBe("false");
    fireEvent.click(runs());
    await waitFor(() => expect(mocks.setOrchestratorRuns).toHaveBeenCalledWith(true));
    await waitFor(() => expect(runs().getAttribute("aria-checked")).toBe("true"));
    expect(mocks.setNativeCodex).not.toHaveBeenCalled();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    // The rest of the app reads the saved answer without waiting for the settings file to be watched.
    await waitFor(() => expect(screen.getByTestId("runs-shown").textContent).toBe("true"));
    resetExperimentalSettingsForTests();
  });

  it("puts the switch back and says why when saving fails", async () => {
    mocks.setOrchestratorRuns.mockRejectedValue(new Error("settings.json is not writable"));
    render(<ExperimentalTab />);
    await waitFor(() => expect(runs().hasAttribute("disabled")).toBe(false));
    fireEvent.click(runs());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("settings.json is not writable"));
    expect(runs().getAttribute("aria-checked")).toBe("false");
  });
});

describe("Settings → Experimental: Bots (PRO-466)", () => {
  const bots = () => screen.getByRole("switch", { name: "Bots" });

  it("is off by default and says what it turns on", async () => {
    render(<ExperimentalTab />);
    await waitFor(() => expect(bots().hasAttribute("disabled")).toBe(false));
    expect(bots().getAttribute("aria-checked")).toBe("false");
    const text = screen.getByTestId("experimental-settings").textContent ?? "";
    for (const said of ["AI employees with standing roles", "the terminalx bots commands"]) expect(text).toContain(said);
  });

  it("saves only its own switch and tells the rest of the app at once", async () => {
    mocks.settings.mockResolvedValue({ nativeCodex: true, bots: false });
    mocks.setBots.mockResolvedValue({ nativeCodex: true, bots: true });
    const { useExperimentalSettings, resetExperimentalSettingsForTests } = await import("@/lib/experimentalSettings");
    resetExperimentalSettingsForTests();
    const Shown = () => <output data-testid="bots-on">{String(useExperimentalSettings()?.bots === true)}</output>;
    render(<><ExperimentalTab /><Shown /></>);
    await waitFor(() => expect(bots().hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("bots-on").textContent).toBe("false");
    fireEvent.click(bots());
    await waitFor(() => expect(mocks.setBots).toHaveBeenCalledWith(true));
    await waitFor(() => expect(bots().getAttribute("aria-checked")).toBe("true"));
    expect(mocks.setNativeCodex).not.toHaveBeenCalled();
    expect(mocks.setOrchestratorRuns).not.toHaveBeenCalled();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("bots-on").textContent).toBe("true"));
    resetExperimentalSettingsForTests();
  });

  it("follows a change made elsewhere, and goes back with the reason when saving fails", async () => {
    mocks.setBots.mockRejectedValue(new Error("settings.json is not writable"));
    render(<ExperimentalTab />);
    await waitFor(() => expect(bots().hasAttribute("disabled")).toBe(false));
    await waitFor(() => expect(mocks.listeners.has("experimental_settings_changed")).toBe(true));
    mocks.listeners.get("experimental_settings_changed")!({ payload: { nativeCodex: false, bots: true } });
    await waitFor(() => expect(bots().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(bots());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("settings.json is not writable"));
    expect(bots().getAttribute("aria-checked")).toBe("true");
  });
});

describe("Settings → Experimental: OpenCode (PRO-157)", () => {
  const openCode = () => screen.getByRole("switch", { name: "OpenCode" });

  it("is off until turned on, then offers OpenCode in the agent and model pickers at once", async () => {
    mocks.setOpenCode.mockResolvedValue({ nativeCodex: false, opencode: true });
    render(<ExperimentalTab />);
    await waitFor(() => expect(openCode().hasAttribute("disabled")).toBe(false));
    expect(openCode().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("experimental-settings").textContent).toContain("Tabs already on OpenCode run either way.");
    fireEvent.click(openCode());
    await waitFor(() => expect(openCode().getAttribute("aria-checked")).toBe("true"));
    expect(mocks.setOpenCode).toHaveBeenCalledWith(true);
    expect(mocks.setNativeCodex).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.refreshHarnesses).toHaveBeenCalledTimes(1));
    expect(mocks.refreshModels).toHaveBeenCalledTimes(1);
  });

  it("puts the switch back and says why when saving fails", async () => {
    mocks.setOpenCode.mockRejectedValue(new Error("The settings file has a problem."));
    render(<ExperimentalTab />);
    await waitFor(() => expect(openCode().hasAttribute("disabled")).toBe(false));
    fireEvent.click(openCode());
    expect((await screen.findByRole("alert")).textContent).toBe("The settings file has a problem.");
    expect(openCode().getAttribute("aria-checked")).toBe("false");
    expect(mocks.refreshHarnesses).not.toHaveBeenCalled();
  });
});

describe("Settings → Experimental: switches this computer cannot run", () => {
  it("keeps a switch the runtime says cannot run here off and disabled, and says why", async () => {
    mocks.settings.mockResolvedValue({ nativeCodex: false, localVmTasks: true, bots: true });
    mocks.unsupported.mockResolvedValue({ localVmTasks: "Local VM tasks need a Mac with Apple silicon, or Linux." });
    render(<ExperimentalTab />);
    const vm = () => screen.getByRole("switch", { name: "Local VM tasks" });
    await waitFor(() => expect(screen.getByTestId("experimental-unsupported-note").textContent).toBe("Local VM tasks need a Mac with Apple silicon, or Linux."));
    expect(vm().hasAttribute("disabled")).toBe(true);
    expect(vm().getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Bots" }).hasAttribute("disabled")).toBe(false));
  });

  it("says nothing where every switch can run", async () => {
    render(<ExperimentalTab />);
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    expect(screen.queryByTestId("experimental-unsupported-note")).toBeNull();
  });
});
