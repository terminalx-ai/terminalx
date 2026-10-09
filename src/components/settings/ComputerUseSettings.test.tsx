import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerPermissionStatus } from "@/lib/api";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { ComputerUseRows } from "./ComputerUseSettings";

const helper = "/Applications/TerminalX.app/Contents/Resources/TerminalX Computer Use Helper.app";
const status = (accessibility: string, screenshots: string, reason: string | null = null): ComputerPermissionStatus => ({
  platform: "macos",
  helperAppPath: reason ? null : helper,
  helperUnavailableReason: reason,
  permissions: [
    { id: "accessibility", status: accessibility as "granted" },
    { id: "screenshots", status: screenshots as "granted" },
  ],
});

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

describe("ComputerUseRows", () => {
  it("shows one Grant button per missing permission and opens the prompt through the helper", async () => {
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "computer_permission_status") return status("granted", "not-granted");
      if (command === "computer_open_permission") {
        expect(args).toEqual({ id: "screenshots" });
        return { ...status("granted", "not-granted"), openedSettings: true, launchedHelper: true, nextStep: "Grant Screen Recording" };
      }
      throw new Error(`unexpected ${command}`);
    });
    render(<ComputerUseRows />);
    await screen.findByRole("button", { name: "Accessibility granted" });
    const grant = screen.getByRole("button", { name: "Grant Screen Recording" });
    expect((screen.getByRole("button", { name: "Accessibility granted" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(grant);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("computer_open_permission", { id: "screenshots" }));
    await screen.findByText(/Waiting for the macOS prompt/);
  });

  it("explains a missing helper instead of offering grants", async () => {
    mocks.invoke.mockResolvedValue(status("not-granted", "not-granted", "TerminalX Computer Use Helper.app was not found"));
    render(<ComputerUseRows />);
    await screen.findByText(/Helper app is missing/);
    expect(screen.queryByRole("button", { name: /Grant/ })).toBeNull();
  });

  it.each(["linux", "windows"])("shows read-only prerequisites on %s", async (platform) => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "computer_permission_status") return { ...status("unsupported", "unsupported"), platform };
      if (command === "computer_open_permission") return { nextStep: "Desktop prerequisites\nSession requirements" };
      throw new Error(`unexpected ${command}`);
    });
    render(<ComputerUseRows />);
    await screen.findByText("Desktop prerequisites");
    expect(screen.getByText("Session requirements")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Grant|Reset permissions/ })).toBeNull();
  });

  it("resets permissions and shows the returned status", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "computer_permission_status") return status("granted", "granted");
      if (command === "computer_reset_permissions") return status("not-granted", "not-granted");
      throw new Error(`unexpected ${command}`);
    });
    render(<ComputerUseRows />);
    await screen.findByRole("button", { name: "Accessibility granted" });
    fireEvent.click(screen.getByRole("button", { name: "Reset permissions" }));
    await screen.findByRole("button", { name: "Grant Accessibility" });
    await screen.findByRole("button", { name: "Grant Screen Recording" });
  });

  it("explains the new helper to someone who granted before, without claiming they did", async () => {
    mocks.invoke.mockResolvedValue({ ...status("not-granted", "not-granted"), legacyHelper: { removed: true, bundleIds: ["old"] } });
    render(<ComputerUseRows />);
    const note = await screen.findByTestId("computer-use-upgrade-note");
    expect(note.textContent).toContain("If you allowed computer use in an earlier TerminalX:");
    expect(note.textContent).toContain("\"TerminalX Computer Use Helper\"");
    expect(note.textContent).toContain("The old helper's permission has been removed.");
    expect(note.textContent).not.toContain("Remove the old helper yourself.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/TerminalX itself should not be listed under Accessibility or Screen Recording/)).toBeTruthy();
  });

  it("asks for manual removal only when this launch's removal failed, and names both rows", async () => {
    mocks.invoke.mockResolvedValue({ ...status("granted", "granted"), legacyHelper: { removed: false, bundleIds: ["old"] } });
    render(<ComputerUseRows />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("remove \"TerminalX Computer Use\" with the − button");
    expect(alert.textContent).toContain("Keep \"TerminalX Computer Use Helper\"");
    expect(alert.textContent).toContain("any program on this Mac can use it");
    // Nothing the person clicks, and nothing stored, makes it go away.
    expect(screen.queryByRole("button", { name: /removed/i })).toBeNull();
    expect(screen.getByTestId("computer-use-upgrade-note").textContent).not.toContain("If you allowed");
  });

  it("shows no note when everything is granted and the removal succeeded, or has not reported", async () => {
    for (const legacyHelper of [{ removed: true, bundleIds: [] }, null, undefined]) {
      mocks.invoke.mockResolvedValue({ ...status("granted", "granted"), legacyHelper });
      render(<ComputerUseRows />);
      await screen.findByRole("button", { name: "Accessibility granted" });
      expect(screen.queryByTestId("computer-use-upgrade-note")).toBeNull();
      cleanup();
    }
    // A first-ever grant with no removal report is not told anything about earlier versions.
    mocks.invoke.mockResolvedValue(status("not-granted", "not-granted"));
    render(<ComputerUseRows />);
    await screen.findByRole("button", { name: "Grant Accessibility" });
    expect(screen.queryByTestId("computer-use-upgrade-note")).toBeNull();
  });
});
