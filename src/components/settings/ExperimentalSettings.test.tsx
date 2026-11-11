import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  setNativeCodex: vi.fn(),
  setOrchestratorRuns: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", () => ({
  experimental: { settings: mocks.settings, setNativeCodex: mocks.setNativeCodex, setOrchestratorRuns: mocks.setOrchestratorRuns },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

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
  mocks.setOrchestratorRuns.mockReset();
});
afterEach(cleanup);

const toggle = () => screen.getByRole("switch", { name: "Native Codex" });

describe("Settings → Experimental (#644)", () => {
  it("offers Native Codex off by default and says what it changes in plain words", async () => {
    render(<ExperimentalTab />);
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    const text = screen.getByTestId("experimental-settings").textContent ?? "";
    for (const said of ["compacting its context", "The chat is the main view", "Codex's own terminal for good", "Codex 0.164.0 or newer", "Existing sessions and other agents are not changed"]) {
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
    for (const said of ["each piece goes to a worker session on its own branch", "you approve the lead's plan before any worker starts", "Settings → Orchestrator", "The terminalx runs commands work either way"]) {
      expect(text).toContain(said);
    }
  });

  it("saves through its own command, leaves Native Codex as it is, and shows the feature at once", async () => {
    mocks.settings.mockResolvedValue({ nativeCodex: true, orchestratorRuns: false });
    mocks.setOrchestratorRuns.mockResolvedValue({ nativeCodex: true, orchestratorRuns: true });
    const { useExperimental, resetExperimentalForTests } = await import("@/lib/experimental");
    resetExperimentalForTests();
    const Shown = () => <output data-testid="runs-shown">{String(useExperimental().orchestratorRuns)}</output>;
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
    resetExperimentalForTests();
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
