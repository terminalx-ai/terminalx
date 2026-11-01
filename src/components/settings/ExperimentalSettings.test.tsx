import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  setNativeCodex: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  experimental: { settings: mocks.settings, setNativeCodex: mocks.setNativeCodex },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const { ExperimentalTab } = await import("./ExperimentalSettings");

beforeEach(() => {
  mocks.settings.mockReset().mockResolvedValue({ nativeCodex: false });
  mocks.setNativeCodex.mockReset();
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
});
