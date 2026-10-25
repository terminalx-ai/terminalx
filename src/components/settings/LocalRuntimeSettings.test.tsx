import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ status: vi.fn(), settings: vi.fn(), setQuitBehavior: vi.fn() }));
vi.mock("@/lib/api", () => ({ localRuntime: native, errorMessage: (error: unknown) => String(error) }));
import { LocalRuntimeSettings } from "./LocalRuntimeSettings";

beforeEach(() => {
  native.status.mockReset().mockResolvedValue({ state: "connected", epoch: "owner", runningAgents: 0, terminals: 0 });
  native.settings.mockReset().mockResolvedValue({ quitBehavior: null });
  native.setQuitBehavior.mockReset().mockImplementation(async (quitBehavior: string) => ({ quitBehavior }));
});
afterEach(cleanup);

it("shows keep-running as the default without silently answering the first-quit choice", async () => {
  render(<LocalRuntimeSettings />);
  const choice = await screen.findByRole("combobox", { name: "When quitting TerminalX" });
  expect((choice as HTMLSelectElement).value).toBe("keepRunning");
  expect(native.setQuitBehavior).not.toHaveBeenCalled();
});

it("saves an explicit stop-all choice and permits returning to keep-running", async () => {
  render(<LocalRuntimeSettings />);
  const choice = await screen.findByRole("combobox");
  fireEvent.change(choice, { target: { value: "stopAll" } });
  await waitFor(() => expect((choice as HTMLSelectElement).value).toBe("stopAll"));
  expect(native.setQuitBehavior).toHaveBeenLastCalledWith("stopAll");
  fireEvent.change(choice, { target: { value: "keepRunning" } });
  await waitFor(() => expect((choice as HTMLSelectElement).value).toBe("keepRunning"));
  expect(native.setQuitBehavior.mock.calls).toEqual([["stopAll"], ["keepRunning"]]);
});

it("retains the saved preference when a write fails instead of claiming it changed", async () => {
  native.settings.mockResolvedValue({ quitBehavior: "stopAll" });
  native.setQuitBehavior.mockRejectedValue("Settings could not be saved.");
  render(<LocalRuntimeSettings />);
  const choice = await screen.findByRole("combobox");
  fireEvent.change(choice, { target: { value: "keepRunning" } });
  expect((await screen.findByRole("alert")).textContent).toContain("could not be saved");
  expect((choice as HTMLSelectElement).value).toBe("stopAll");
});

it("does not advertise background quitting before startup ownership has moved", async () => {
  native.status.mockResolvedValue({ state: "inProcess" });
  render(<LocalRuntimeSettings />);
  await waitFor(() => expect(native.settings).toHaveBeenCalledOnce());
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(native.setQuitBehavior).not.toHaveBeenCalled();
});
