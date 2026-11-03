import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn(), install: vi.fn() }));
const runtime = vi.hoisted(() => ({ work: vi.fn(), planUpdate: vi.fn() }));
/** What happened, in order: the plan must be left after installing and before relaunching. */
const steps = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-updater", () => ({ check: updater.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: updater.relaunch }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), localRuntime: runtime }));

import { UpdateButton, UpdateNotice } from "./UpdateNotice";
import { checkForUpdate } from "@/lib/updates";

afterEach(cleanup);
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage in this environment */
  }
  steps.length = 0;
  updater.install.mockReset().mockImplementation(async (progress: (event: unknown) => void) => {
    progress({ event: "Started", data: { contentLength: 10 } });
    progress({ event: "Progress", data: { chunkLength: 10 } });
    steps.push("install");
  });
  updater.relaunch.mockReset().mockImplementation(async () => { steps.push("relaunch"); });
  // Nothing under way in the runtime attached.
  runtime.work.mockReset().mockImplementation(async () => { steps.push("read"); return { epoch: "owner", work: [], readAt: 1_000 }; });
  runtime.planUpdate.mockReset().mockImplementation(async (epoch: string, forced: boolean, quietSince: number | null) => {
    steps.push("plan");
    return { epoch, forced, quietSince, madeAt: 2_000, madeBy: 1 };
  });
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

/** A window that has found the update, with a store of its own. */
async function found() {
  vi.resetModules();
  const updates = await import("@/lib/updates");
  const { UpdateButton, UpdateNotice } = await import("./UpdateNotice");
  updater.check.mockResolvedValue({ version: "9.9.9", downloadAndInstall: updater.install });
  render(
    <>
      <UpdateButton />
      <UpdateNotice />
    </>,
  );
  await act(() => updates.checkForUpdate({ quiet: true }));
  return updates;
}

const turn = "Claude Code in “Fix login” (Review), in the middle of a turn";
const terminal = "The terminal “npm run dev” in “Web”";

describe("the runtime the update comes with (#766)", () => {
  it("with nothing under way, installs, leaves the runtime to be moved as the app relaunches, and asks nothing", async () => {
    await found();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update and relaunch" })); });
    await vi.waitFor(() => expect(updater.relaunch).toHaveBeenCalledOnce());
    expect(steps).toEqual(["read", "install", "plan", "relaunch"]);
    // Quiet since that reading, if still quiet just before the relaunch.
    expect(runtime.planUpdate).toHaveBeenCalledExactlyOnceWith("owner", false, 1_000);
    expect(screen.queryByTestId("update-choice")).toBeNull();
  });

  it("lists what moving to it would stop before installing anything, and Update now restarts it", async () => {
    runtime.work.mockResolvedValue({ epoch: "owner", work: [turn, terminal], readAt: 1_000 });
    await found();
    // From the sidebar's button, with the corner card closed for this version.
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await act(async () => { fireEvent.click(screen.getByTestId("sidebar-update")); });
    const card = screen.getByRole("dialog", { name: "Update and restart work in progress?" });
    expect(card.textContent).toContain("Update to TerminalX 9.9.9");
    expect(card.textContent).toContain("Moving to it now stops:");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([turn, terminal]);
    expect(card.textContent).toContain("Update now restarts them: each agent picks up its conversation again when its tab starts.");
    expect(card.textContent).toContain("Update when they're done installs the app now, and moves to the new runtime by itself once nothing would be cut short.");
    expect(updater.install).not.toHaveBeenCalled();
    expect(screen.getByTestId("sidebar-update")).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update now" })); });
    await vi.waitFor(() => expect(updater.relaunch).toHaveBeenCalledOnce());
    expect(steps).toEqual(["install", "plan", "relaunch"]);
    expect(runtime.planUpdate).toHaveBeenCalledExactlyOnceWith("owner", true, null);
  });

  it("Update when they're done installs now and leaves the runtime to move by itself, without asking again", async () => {
    runtime.work.mockResolvedValue({ epoch: "owner", work: [turn], readAt: 1_000 });
    await found();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update and relaunch" })); });
    expect(screen.getByTestId("update-choice").textContent).toContain("Update now restarts it:");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update when they're done" })); });
    await vi.waitFor(() => expect(updater.relaunch).toHaveBeenCalledOnce());
    expect(runtime.planUpdate).toHaveBeenCalledExactlyOnceWith("owner", false, null);
  });

  it("closing the choice updates nothing, and a background check does not take it away", async () => {
    runtime.work.mockResolvedValue({ epoch: "owner", work: [terminal], readAt: 1_000 });
    const updates = await found();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update and relaunch" })); });
    expect((await updates.checkForUpdate({ quiet: true })).kind).toBe("choosing");
    expect(screen.getByTestId("update-choice")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Not now" })); });
    expect(screen.queryByTestId("update-choice")).toBeNull();
    expect(screen.getByTestId("update-notice")).toBeTruthy();
    expect(updater.install).not.toHaveBeenCalled();
    expect(runtime.planUpdate).not.toHaveBeenCalled();
  });

  it("updates when the runtime cannot be read, or the plan cannot be left: the relaunched app then waits by itself, and says so", async () => {
    runtime.work.mockRejectedValue("The TerminalX runtime is not attached.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await found();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update and relaunch" })); });
    await vi.waitFor(() => expect(updater.relaunch).toHaveBeenCalledOnce());
    expect(runtime.planUpdate).not.toHaveBeenCalled();

    runtime.work.mockResolvedValue({ epoch: "owner", work: [turn], readAt: 1_000 });
    runtime.planUpdate.mockRejectedValue("disk full");
    await found();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update and relaunch" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update now" })); });
    await vi.waitFor(() => expect(updater.relaunch).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    warn.mockRestore();
  });

  it("a failed install says why and leaves no plan behind", async () => {
    updater.install.mockRejectedValue(new Error("signature mismatch"));
    const updates = await found();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update and relaunch" })); });
    await vi.waitFor(() => expect(updates.getUpdateState().kind).toBe("error"));
    expect(updates.getUpdateState()).toEqual({ kind: "error", message: expect.stringContaining("signature mismatch") });
    expect(runtime.planUpdate).not.toHaveBeenCalled();
    expect(updater.relaunch).not.toHaveBeenCalled();
  });
});
