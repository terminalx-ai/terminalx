import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalRuntimeState } from "@/lib/api";

const native = vi.hoisted(() => ({ status: vi.fn(), reconnect: vi.fn(), restart: vi.fn(), replace: vi.fn(), listeners: new Map<string, () => void>() }));
const terminals = vi.hoisted(() => ({ reattachLocalTerminals: vi.fn() }));
vi.mock("@/lib/api", async (actual) => ({ localRuntime: native, errorMessage: (await actual<typeof import("@/lib/api")>()).errorMessage }));
vi.mock("@/lib/terminal", () => terminals);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    native.listeners.set(event, callback);
    return () => native.listeners.delete(event);
  }),
}));

const connected: LocalRuntimeState = { state: "connected", epoch: "owner", generation: 1, view: 0 };
const connecting = (downMs: number, attempt = 2, terminal = false): LocalRuntimeState => ({
  state: "connecting", terminal, attempt, retryInMs: 500, downMs,
  message: "Could not reconnect to the background runtime: connection refused",
});
const unresponsive: LocalRuntimeState = { state: "unresponsive", message: "The TerminalX runtime did not answer runtime.liveness within 15 seconds.", epoch: "owner", keeps: false };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  native.status.mockReset().mockResolvedValue(connected);
  native.reconnect.mockReset().mockResolvedValue(connected);
  // The desktop stops the runtime, then attaches a fresh one by itself.
  native.restart.mockReset().mockImplementation(async () => {
    native.status.mockResolvedValue({ ...connected, epoch: "fresh", generation: 2 });
    return connecting(0, 1);
  });
  // The desktop stops the older runtime, then attaches the app's own.
  native.replace.mockReset().mockImplementation(async () => {
    native.status.mockResolvedValue({ ...connected, epoch: "bundled", generation: 2 });
    return { state: "updating", from: "0.2.21", to: "0.2.23", keeping: false };
  });
  native.listeners.clear();
  terminals.reattachLocalTerminals.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mounted() {
  // A fresh store per test: it is module state, as in a window.
  const { LocalRuntimeNotice } = await import("./LocalRuntimeNotice");
  await act(async () => { render(<LocalRuntimeNotice />); });
}
/** The desktop's state changed: windows read their status again. */
async function changed(state: LocalRuntimeState) {
  native.status.mockResolvedValue(state);
  await act(async () => native.listeners.get("local_runtime_state")?.());
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

it("says nothing about a short gap that recovers by itself", async () => {
  await mounted();
  await changed(connecting(0, 1));
  await advance(2_000);
  expect(screen.queryByRole("status")).toBeNull();
  await changed({ ...connected, generation: 2 });
  await advance(60_000);
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
});

it("after a few seconds says it is reconnecting, asks for nothing, and clears by itself", async () => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  await mounted();
  await changed(connecting(0, 3));
  await advance(3_000);
  expect(screen.getByRole("status").textContent).toContain("Reconnecting… (attempt 3)");
  expect(screen.getByRole("status").textContent).toContain("Agents and terminal commands keep running.");
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.activeElement).toBe(input);
  await changed(connecting(4_000, 4));
  expect(screen.getByRole("status").textContent).toContain("(attempt 4)");
  await changed({ ...connected, generation: 2 });
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
  input.remove();
});

it("names a gap in this window's terminal output alone", async () => {
  await mounted();
  await changed(connecting(5_000, 2, true));
  expect(screen.getByRole("status").textContent).toContain("Reconnecting terminal output… (attempt 2)");
});

it("offers Try again once a failure has lasted minutes, and trying asks the desktop, never the page", async () => {
  await mounted();
  await changed(connecting(119_000, 12));
  expect(screen.queryByRole("button")).toBeNull();
  await advance(1_000);
  expect(screen.getByRole("status").textContent).toContain("Live connection unavailable");
  expect(screen.getByRole("status").textContent).toContain("connection refused");
  native.status.mockResolvedValue({ ...connected, generation: 2 });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).toBeNull();
});

it("says at once when retrying cannot help, and clears when it later succeeds", async () => {
  await mounted();
  await changed({ state: "unavailable", message: "Another TerminalX window is connected to this background runtime. Close it, then try again." });
  expect(screen.getByRole("status").textContent).toContain("Another TerminalX window is connected");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  await changed({ ...connected, generation: 2 });
  expect(screen.queryByRole("status")).toBeNull();
});

it("a late disconnect hint after recovery cannot bring the notice back while status is healthy", async () => {
  await mounted();
  await changed(connecting(10_000));
  expect(screen.getByRole("status")).toBeTruthy();
  await changed({ ...connected, generation: 2 });
  for (let i = 0; i < 3; i++) await changed({ ...connected, generation: 2 });
  await advance(180_000);
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
});

it("offers a restart, never Try again, for a runtime that stopped answering, and the fresh one attaches in place", async () => {
  await mounted();
  await changed(unresponsive);
  expect(screen.getByRole("status").textContent).toContain("TerminalX runtime is not responding");
  expect(screen.getByRole("status").textContent).toContain("within 15 seconds");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await advance(180_000);
  expect(native.reconnect).not.toHaveBeenCalled();
  expect(native.restart).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart runtime" })); });
  // Only the runtime this window found not responding, which cannot be
  // handed over: it is stopped, as the notice said.
  expect(native.restart).toHaveBeenCalledExactlyOnceWith("owner", "stoppingAll");
  expect(screen.queryByRole("status")).toBeNull();
  // Its terminals move to the fresh runtime without a reload.
  expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
});

it("shows the watchdog's finding as soon as it reports one, and clears once the runtime answers again", async () => {
  await mounted();
  expect(screen.queryByRole("status")).toBeNull();
  await changed(unresponsive);
  expect(screen.getByRole("status").textContent).toContain("TerminalX runtime is not responding");
  await changed(connected);
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.restart).not.toHaveBeenCalled();
  expect(terminals.reattachLocalTerminals).not.toHaveBeenCalled();
});

it("says why a restart failed and leaves it to be tried again", async () => {
  native.restart.mockRejectedValue("Could not stop the TerminalX runtime: it was left running.");
  await mounted();
  await changed(unresponsive);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart runtime" })); });
  expect(screen.getByRole("alert").textContent).toContain("Could not stop the TerminalX runtime");
  expect((screen.getByRole("button", { name: "Restart runtime" }) as HTMLButtonElement).disabled).toBe(false);
  // Once it answers again, the failure is old news.
  await changed(connected);
  await changed(unresponsive);
  expect(screen.queryByRole("alert")).toBeNull();
});

const outdated = (work: string[] | null, problem: string | null = null, failed = false, keeps = false): LocalRuntimeState =>
  ({ ...connected, outdated: { running: "0.2.21", app: "0.2.23", work, problem, failed, keeps } });

it("says the runtime is older than the app, names what it waits for, and Restart now replaces only that runtime", async () => {
  await mounted();
  await changed(outdated(null));
  const notice = () => screen.getByRole("status").textContent ?? "";
  expect(notice()).toContain("TerminalX runtime is older than the app");
  expect(notice()).toContain("version 0.2.21; this app is 0.2.23");
  expect(notice()).toContain("It restarts with 0.2.23 once it has checked that nothing it runs would be cut short.");
  // #730 review: not only turns: a terminal running a server is waited for too.
  await changed(outdated(["Claude Code in “Fix login” (Review), in the middle of a turn", "The terminal “npm run dev” in “Web”"]));
  expect(notice()).toContain("It restarts with 0.2.23 once nothing it runs would be cut short. It is waiting for:");
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Claude Code in “Fix login” (Review), in the middle of a turn", "The terminal “npm run dev” in “Web”"]);
  expect(notice()).toContain("Restarting now stops all of that, and its terminals and whatever they run");
  await changed(outdated(["The terminal “npm run dev” in “Web”"]));
  expect(notice()).toContain("Restarting now stops that,");
  await changed(outdated([]));
  expect(notice()).toContain("Nothing it runs would be cut short: it restarts with 0.2.23 in a moment.");
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  expect(native.replace).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart now" })); });
  // Only the runtime this window was told about.
  expect(native.replace).toHaveBeenCalledExactlyOnceWith("owner");
  expect(screen.queryByRole("status")).toBeNull();
  // Its terminals move to the app's own runtime without a reload.
  expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
});

it("after a switch failed, says it will not try again by itself rather than that it restarts now", async () => {
  await mounted();
  await changed(outdated([], "Could not restart the TerminalX runtime: it did not exit.", true));
  const notice = screen.getByRole("status").textContent ?? "";
  expect(notice).toContain("Restarting it with 0.2.23 failed, and it will not try again by itself.");
  expect(notice).not.toContain("in a moment");
  expect(screen.getByRole("alert").textContent).toContain("it did not exit");
  expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
});

it("says while the runtime is being replaced, and clears once the app's own attaches", async () => {
  await mounted();
  await changed({ state: "updating", from: "0.2.21", to: "0.2.23", keeping: false });
  expect(screen.getByRole("status").textContent).toContain("Updating the TerminalX runtime");
  expect(screen.getByRole("status").textContent).toContain("Stopping the 0.2.21 runtime and starting 0.2.23");
  expect(screen.queryByRole("button")).toBeNull();
  await changed({ ...connected, epoch: "bundled", generation: 2 });
  expect(screen.queryByRole("status")).toBeNull();
  expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
});

it("hides for the runtime it was hidden for, and says why a restart failed", async () => {
  native.replace.mockRejectedValue("Could not restart the TerminalX runtime: it did not exit.");
  await mounted();
  await changed(outdated(["Codex in “Release notes”, in the middle of a turn"], "Could not tell what it is running: timed out"));
  expect(screen.getByRole("alert").textContent).toContain("Could not tell what it is running");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart now" })); });
  expect(screen.getByRole("alert").textContent).toContain("it did not exit");
  expect((screen.getByRole("button", { name: "Restart now" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hide" })); });
  expect(screen.queryByRole("status")).toBeNull();
  await changed(outdated([]));
  expect(screen.queryByRole("status")).toBeNull();
  // Another older runtime is news again.
  await changed({ ...outdated([]), epoch: "another", generation: 3 } as LocalRuntimeState);
  expect(screen.getByRole("status").textContent).toContain("it restarts with 0.2.23 in a moment.");
});

// #765: a runtime that can be handed over keeps what it runs.

it("says a runtime being handed over keeps its agents and terminals running", async () => {
  await mounted();
  await changed({ state: "updating", from: "0.2.24", to: "0.2.25", keeping: true });
  const notice = screen.getByRole("status").textContent ?? "";
  expect(notice).toContain("Handing what the 0.2.24 runtime runs over to 0.2.25");
  expect(notice).toContain("Its agents and terminals keep running.");
  expect(notice).not.toContain("Stopping");
  expect(notice).not.toContain("picks up its conversation");
});

it("names what an older runtime's handover cannot carry, and Restart now stops only that", async () => {
  await mounted();
  await changed(outdated(null, null, false, true));
  const notice = () => screen.getByRole("status").textContent ?? "";
  expect(notice()).toContain("It hands its agents and terminals over to 0.2.23 in a moment; they keep running.");
  expect(notice()).toContain("Restarting now keeps its agents and terminals running.");
  await changed(outdated(["Gemini in “Docs”, in the middle of a turn"], null, false, true));
  expect(notice()).toContain("It hands everything over to 0.2.23, keeping it running, except what it cannot carry over:");
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Gemini in “Docs”, in the middle of a turn"]);
  expect(notice()).toContain("Restarting now stops only that, and everything else keeps running");
  expect(notice()).not.toContain("its terminals and whatever they run");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart now" })); });
  expect(native.replace).toHaveBeenCalledExactlyOnceWith("owner");
});

it("says a handover that failed will not be tried again by itself", async () => {
  await mounted();
  await changed(outdated([], "Could not restart the TerminalX runtime: the updated runtime did not answer.", true, true));
  expect(screen.getByRole("status").textContent).toContain("Handing it over to 0.2.23 failed, and it will not try again by itself.");
  expect(screen.getByRole("alert").textContent).toContain("did not answer");
});

it("restarts an unresponsive runtime that can be handed over keeping what it runs", async () => {
  await mounted();
  await changed({ ...unresponsive, keeps: true } as LocalRuntimeState);
  expect(screen.getByRole("status").textContent).toContain("Restarting it hands its agents and terminals to a fresh runtime, and they keep running.");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart runtime" })); });
  expect(native.restart).toHaveBeenCalledExactlyOnceWith("owner", "keeping");
  expect(screen.queryByRole("status")).toBeNull();
  expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
});

it("asks before stopping what an unresponsive runtime's handover cannot carry, or all of it", async () => {
  native.restart.mockRejectedValueOnce({ message: "Restarting it keeps everything it runs but what is named here, which would have to stop.", unkept: ["Gemini in “Docs”"] });
  await mounted();
  await changed({ ...unresponsive, keeps: true } as LocalRuntimeState);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart runtime" })); });
  expect(native.restart).toHaveBeenCalledExactlyOnceWith("owner", "keeping");
  expect(screen.getByRole("alert").textContent).toContain("would have to stop");
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Gemini in “Docs”"]);
  expect(screen.getByRole("status").textContent).toContain("Restarting it stopping that keeps everything else running.");
  expect(screen.queryByRole("button", { name: "Restart runtime" })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart, stopping that" })); });
  expect(native.restart).toHaveBeenLastCalledWith("owner", "stoppingUnkept");
  expect(screen.queryByRole("status")).toBeNull();
});

it("offers to stop everything only once keeping it running could not be done", async () => {
  native.restart.mockRejectedValueOnce({ message: "Could not restart it keeping what it runs: it did not answer. Nothing was stopped.", unkept: [] });
  await mounted();
  await changed({ ...unresponsive, keeps: true } as LocalRuntimeState);
  expect(screen.queryByRole("button", { name: "Stop and restart" })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart runtime" })); });
  expect(screen.getByRole("alert").textContent).toContain("Nothing was stopped.");
  expect(screen.getByRole("status").textContent).toContain("Stopping it instead stops everything it runs");
  expect(screen.queryByRole("button", { name: /Restart, stopping/ })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop and restart" })); });
  expect(native.restart).toHaveBeenLastCalledWith("owner", "stoppingAll");
});
