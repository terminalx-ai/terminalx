import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalRuntimeState } from "@/lib/api";

const native = vi.hoisted(() => ({ status: vi.fn(), replace: vi.fn(), listeners: new Map<string, () => void>() }));
const terminals = vi.hoisted(() => ({ reattachLocalTerminals: vi.fn() }));
vi.mock("@/lib/api", () => ({ localRuntime: native, errorMessage: (error: unknown) => String(error) }));
vi.mock("@/lib/terminal", () => terminals);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    native.listeners.set(event, callback);
    return () => native.listeners.delete(event);
  }),
}));

const connected: LocalRuntimeState = { state: "connected", epoch: "owner", generation: 1, view: 0 };
const outdated = (work: string[] | null, problem: string | null = null, failed = false): LocalRuntimeState =>
  ({ ...connected, outdated: { running: "0.2.23", app: "0.2.24", work, problem, failed } });
const turn = "Claude Code in “Fix login” (Review), in the middle of a turn";
const terminal = "The terminal “npm run dev” in “Web”";

beforeEach(() => {
  vi.resetModules();
  native.status.mockReset().mockResolvedValue(connected);
  // The desktop stops the older runtime, then attaches the app's own.
  native.replace.mockReset().mockImplementation(async () => {
    native.status.mockResolvedValue({ ...connected, epoch: "bundled", generation: 2 });
    return { state: "updating", from: "0.2.23", to: "0.2.24" };
  });
  native.listeners.clear();
  terminals.reattachLocalTerminals.mockReset();
});
afterEach(cleanup);

async function mounted(tier: "full" | "compact" | "icon" = "full") {
  // A fresh store per test: it is module state, as in a window.
  const { RuntimeStatus } = await import("./RuntimeStatus");
  const view = await act(async () => render(<RuntimeStatus tier={tier} />));
  return view;
}
/** The desktop's state changed: windows read their status again. */
async function changed(state: LocalRuntimeState) {
  native.status.mockResolvedValue(state);
  await act(async () => native.listeners.get("local_runtime_state")?.());
}
const item = () => screen.getByTestId("runtime-status");
async function details() {
  await act(async () => { fireEvent.click(item()); });
  return screen.getByRole("dialog");
}

it("shows nothing while the runtime is the app's own", async () => {
  const { container } = await mounted();
  expect(container.textContent).toBe("");
  expect(screen.queryByTestId("runtime-status")).toBeNull();
});

it("shows the runtime's version and what moving to the app's waits for, and lists it on a click (#766)", async () => {
  await mounted();
  await changed(outdated(null));
  expect(item().textContent).toBe("Runtime 0.2.23 · checking");
  await changed(outdated([turn, terminal]));
  expect(item().textContent).toBe("Runtime 0.2.23 · waiting for 2");
  expect(item().getAttribute("aria-label")).toBe("Runtime 0.2.23, waiting for 2");
  const popover = await details();
  expect(popover.textContent).toContain("Runtime 0.2.23 → 0.2.24");
  expect(popover.textContent).toContain("is version 0.2.23; this app is 0.2.24. It moves to 0.2.24 by itself once nothing it runs would be cut short. It is waiting for:");
  expect(screen.getAllByRole("listitem").map((entry) => entry.textContent)).toEqual([turn, terminal]);
  expect(popover.textContent).toContain("Restarting now stops all of that, and its terminals and whatever they run; each agent picks up its conversation again when its tab starts.");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(native.replace).not.toHaveBeenCalled();
});

it("says when nothing would be cut short any more, and why it could not tell", async () => {
  await mounted();
  await changed(outdated([]));
  expect(item().textContent).toBe("Runtime 0.2.23 · updating shortly");
  expect((await details()).textContent).toContain("Nothing it runs would be cut short: it moves to 0.2.24 in a moment.");
  await changed(outdated([turn], "Could not tell what it is running: timed out"));
  expect(item().className).toContain("text-warning");
  expect(screen.getByRole("alert").textContent).toContain("Could not tell what it is running");
});

it("Restart now replaces only the runtime this window was told about, and says why it could not", async () => {
  native.replace.mockRejectedValueOnce("Could not restart the TerminalX runtime: it did not exit.");
  await mounted();
  await changed(outdated([terminal]));
  await details();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart now" })); });
  expect(native.replace).toHaveBeenCalledExactlyOnceWith("owner");
  expect(screen.getByRole("alert").textContent).toContain("it did not exit");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart now" })); });
  expect(native.replace).toHaveBeenCalledTimes(2);
  // The app's own runtime attached: nothing left to show.
  expect(screen.queryByTestId("runtime-status")).toBeNull();
  expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
});

it("keeps saying a switch failed after its notice is hidden, with Try again (#766)", async () => {
  await mounted();
  await changed(outdated([turn], "Could not restart the TerminalX runtime: it did not exit.", true));
  expect(item().textContent).toBe("Runtime 0.2.23 · not updated");
  const popover = await details();
  expect(popover.textContent).toContain("Moving to 0.2.24 failed, and it does not try again by itself.");
  expect(popover.textContent).toContain("Trying again stops its agents");
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  expect(screen.getByRole("alert").textContent).toContain("it did not exit");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  expect(native.replace).toHaveBeenCalledExactlyOnceWith("owner");
});

it("says while the runtime is being replaced", async () => {
  await mounted();
  await changed({ state: "updating", from: "0.2.23", to: "0.2.24" });
  expect(screen.getByRole("status", { name: "Updating the runtime to 0.2.24" }).textContent).toBe("Updating the runtime to 0.2.24…");
  expect(screen.queryByRole("button")).toBeNull();
});

it("narrows with the status bar, keeping the version, then only the icon", async () => {
  const compact = await mounted("compact");
  await changed(outdated([turn]));
  expect(item().textContent).toBe("Runtime 0.2.23");
  compact.unmount();
  await mounted("icon");
  expect(item().textContent).toBe("");
  expect(item().getAttribute("aria-label")).toBe("Runtime 0.2.23, waiting for 1");
});
