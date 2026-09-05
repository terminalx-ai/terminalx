import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerPermissionStatus } from "@/lib/api";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { ComputerUseRows } from "./ComputerUseSettings";

const helper = "/Applications/TerminalX.app/Contents/Resources/TerminalX Computer Use.app";
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
    mocks.invoke.mockResolvedValue(status("not-granted", "not-granted", "TerminalX Computer Use.app was not found"));
    render(<ComputerUseRows />);
    await screen.findByText(/helper app is missing/);
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
});
