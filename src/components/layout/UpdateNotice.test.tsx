import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn(), install: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: updater.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: updater.relaunch }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));

import { UpdateButton, UpdateNotice } from "./UpdateNotice";
import { checkForUpdate } from "@/lib/updates";

afterEach(cleanup);
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage in this environment */
  }
  updater.install.mockReset().mockImplementation(async (progress: (event: unknown) => void) => {
    progress({ event: "Started", data: { contentLength: 10 } });
    progress({ event: "Progress", data: { chunkLength: 10 } });
  });
  updater.relaunch.mockReset().mockResolvedValue(undefined);
});

describe("an update the app found by itself", () => {
  it("shows the Update button and the corner card, closes the card for that version only, and installs from either", async () => {
    updater.check.mockResolvedValue({ version: "9.9.9", downloadAndInstall: updater.install });
    render(
      <>
        <UpdateButton />
        <UpdateNotice />
      </>,
    );
    expect(screen.queryByTestId("sidebar-update")).toBeNull();
    await act(() => checkForUpdate({ quiet: true }));
    expect(screen.getByTestId("sidebar-update").textContent).toContain("Update");
    expect(screen.getByRole("dialog", { name: "Update available" }).textContent).toContain("TerminalX 9.9.9");

    // Later: the card goes, the button stays.
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByTestId("update-notice")).toBeNull();
    expect(screen.getByTestId("sidebar-update")).toBeTruthy();

    fireEvent.click(screen.getByTestId("sidebar-update"));
    await vi.waitFor(() => expect(updater.relaunch).toHaveBeenCalledOnce());
    expect(updater.install).toHaveBeenCalledOnce();
  });

  it("keeps quiet when a background check fails, and says nothing when there is no update", async () => {
    // A window that has found nothing yet.
    vi.resetModules();
    const { checkForUpdate } = await import("@/lib/updates");
    const { UpdateNotice } = await import("./UpdateNotice");
    updater.check.mockRejectedValueOnce(new Error("offline"));
    render(<UpdateNotice />);
    const state = await checkForUpdate({ quiet: true });
    expect(state.kind).not.toBe("error");
    updater.check.mockResolvedValueOnce(null);
    expect((await checkForUpdate({ quiet: true })).kind).toBe("none");
    expect(screen.queryByTestId("update-notice")).toBeNull();
  });
});
