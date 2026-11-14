import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalRuntimeStartFailed, LocalRuntimeState } from "@/lib/api";

const native = vi.hoisted(() => ({ status: vi.fn(), reconnect: vi.fn(), restart: vi.fn(), replace: vi.fn(), log: vi.fn(), listeners: new Map<string, () => void>() }));
const app = vi.hoisted(() => ({ relaunch: vi.fn(), exit: vi.fn(), openUrl: vi.fn(), copyText: vi.fn() }));
vi.mock("@/lib/api", async (actual) => ({ localRuntime: native, errorMessage: (await actual<typeof import("@/lib/api")>()).errorMessage }));
vi.mock("@/lib/terminal", () => ({ reattachLocalTerminals: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: app.copyText }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: app.relaunch, exit: app.exit }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: app.openUrl }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    native.listeners.set(event, callback);
    return () => native.listeners.delete(event);
  }),
}));

const connected: LocalRuntimeState = { state: "connected", epoch: "owner", generation: 1, view: 0 };
/** As the desktop reports a runtime that exited while starting (`launch.rs`). */
const failed: LocalRuntimeStartFailed = {
  process: "terminalx-serve", code: 78, signal: null, ranMs: 412,
  error: "terminalx-serve: open the state directory: Permission denied (os error 13)",
  log: "/Users/someone/Library/Logs/com.terminalx.next/runtime.log",
  at: new Date(2026, 10, 11, 9, 41, 12).getTime(), app: "0.2.30", os: "macOS 26.1 (25B78)",
};
const startFailed = (overrides: Partial<LocalRuntimeStartFailed> = {}): LocalRuntimeState => ({
  state: "unavailable", message: "Could not connect to the background runtime: local runtime failed before attachment", startFailed: { ...failed, ...overrides },
});

beforeEach(() => {
  vi.resetModules();
  native.status.mockReset().mockResolvedValue(connected);
  native.log.mockReset().mockResolvedValue("[2026-11-11T09:41:12Z ERROR raccoon_lib::serve] terminalx-serve: open the state directory\n");
  native.listeners.clear();
  for (const call of Object.values(app)) call.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mounted() {
  // A fresh store per test: it is module state, as in a window.
  const { LocalRuntimeNotice } = await import("./LocalRuntimeNotice");
  await act(async () => { render(<LocalRuntimeNotice />); });
}
async function changed(state: LocalRuntimeState) {
  native.status.mockResolvedValue(state);
  await act(async () => native.listeners.get("local_runtime_state")?.());
}
const dialog = () => screen.getByRole("dialog", { name: "TerminalX couldn't start its agent runtime" });
const click = async (name: string) => { await act(async () => { fireEvent.click(within(dialog()).getByRole("button", { name })); }); };

it("shows a runtime that exited while starting in a dialog, with its exit code and error", async () => {
  await mounted();
  await changed(startFailed());
  const shown = dialog();
  expect(shown.textContent).toContain("The process that runs Claude Code and Codex in their terminals stopped while starting, so no session can run.");
  expect(shown.textContent).toContain("Your sessions, worktrees and drafts are safe on disk.");
  const details = within(shown).getByRole("group", { name: "What failed" });
  expect(details.textContent).toContain("terminalx-serve exited with code 78 after 0.4 s");
  expect(details.textContent).toContain("terminalx-serve: open the state directory: Permission denied (os error 13)");
  expect(details.textContent).toContain("09:41:12 · TerminalX 0.2.30 · macOS 26.1 (25B78)");
  expect(shown.textContent).toContain("Restarting fixes this most of the time. If it comes back, send a report with the logs so we can look.");
  expect(within(shown).getAllByRole("button").map((button) => button.textContent)).toEqual(["Quit", "Copy logs", "Report…", "Restart TerminalX"]);
  expect(shown.textContent).toContain("~/Library/Logs/com.terminalx.next/runtime.log");
  expect(shown.textContent).toContain("logs can include file paths and branch names");
  // The bottom notice is not shown as well.
  expect(screen.queryByRole("status")).toBeNull();
});

it("holds the window: Escape does not close it", async () => {
  await mounted();
  await changed(startFailed());
  await act(async () => { fireEvent.keyDown(dialog(), { key: "Escape" }); });
  expect(dialog()).toBeTruthy();
});

it("says how a runtime ended by a signal, or never started, ended", async () => {
  await mounted();
  await changed(startFailed({ code: null, signal: 9, ranMs: 2_300, error: null }));
  expect(within(dialog()).getByRole("group", { name: "What failed" }).textContent).toContain("terminalx-serve was ended by signal 9 after 2.3 s");
  await changed(startFailed({ code: null, signal: null, ranMs: 0, error: "start local runtime: Permission denied (os error 13)" }));
  const details = within(dialog()).getByRole("group", { name: "What failed" }).textContent;
  expect(details).toContain("terminalx-serve could not be started");
  expect(details).toContain("start local runtime: Permission denied (os error 13)");
});

it("Copy logs puts the runtime's log on the clipboard", async () => {
  await mounted();
  await changed(startFailed());
  await click("Copy logs");
  expect(native.log).toHaveBeenCalledOnce();
  expect(app.copyText).toHaveBeenCalledWith("[2026-11-11T09:41:12Z ERROR raccoon_lib::serve] terminalx-serve: open the state directory\n");
  expect(within(dialog()).getByRole("button", { name: "Copied" })).toBeTruthy();
});

it("says why the log could not be copied", async () => {
  native.log.mockRejectedValue("Could not read runtime.log: No such file or directory (os error 2)");
  await mounted();
  await changed(startFailed());
  await click("Copy logs");
  expect(app.copyText).not.toHaveBeenCalled();
  expect(within(dialog()).getByRole("alert").textContent).toContain("No such file or directory");
});

it("Report… opens a new issue with the app version and what failed filled in", async () => {
  await mounted();
  await changed(startFailed());
  await click("Report…");
  expect(app.openUrl).toHaveBeenCalledOnce();
  const url = new URL(app.openUrl.mock.calls[0][0] as string);
  expect(`${url.origin}${url.pathname}`).toBe("https://github.com/terminalx-ai/raccoon/issues/new");
  expect(url.searchParams.get("title")).toBe("Agent runtime failed to start (TerminalX 0.2.30)");
  const body = url.searchParams.get("body") ?? "";
  expect(body).toContain("terminalx-serve exited with code 78 after 0.4 s");
  expect(body).toContain("terminalx-serve: open the state directory: Permission denied (os error 13)");
  expect(body).toContain("TerminalX 0.2.30 · macOS 26.1 (25B78)");
  // The log is pasted by the reader, not sent.
  expect(body).not.toContain("raccoon_lib::serve");
});

it("Restart TerminalX relaunches the app", async () => {
  await mounted();
  await changed(startFailed());
  await click("Restart TerminalX");
  expect(app.relaunch).toHaveBeenCalledOnce();
  expect(app.exit).not.toHaveBeenCalled();
});

it("Quit quits the app", async () => {
  await mounted();
  await changed(startFailed());
  await click("Quit");
  expect(app.exit).toHaveBeenCalledWith(0);
  expect(app.relaunch).not.toHaveBeenCalled();
});

it("a short connection gap shows only the reconnecting notice, never the dialog", async () => {
  vi.useFakeTimers();
  await mounted();
  await changed({ state: "connecting", terminal: false, attempt: 2, retryInMs: 500, downMs: 0, message: "Could not reconnect to the background runtime: connection refused" });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(screen.getByRole("status").textContent).toContain("Reconnecting… (attempt 2)");
  expect(screen.queryByRole("dialog")).toBeNull();
  // Unavailable for another reason is the bottom notice too.
  await changed({ state: "unavailable", message: "Another TerminalX window is connected." });
  expect(screen.getByRole("status").textContent).toContain("Live connection unavailable");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("goes away once a runtime attaches", async () => {
  await mounted();
  await changed(startFailed());
  expect(dialog()).toBeTruthy();
  await changed({ ...connected, generation: 2 });
  expect(screen.queryByRole("dialog")).toBeNull();
});
