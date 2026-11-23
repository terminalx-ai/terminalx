import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockResolvedValue(undefined),
  setDocked: vi.fn(),
  detachAll: vi.fn().mockResolvedValue(undefined),
}));
const setups = vi.hoisted(() => ({ runs: [] as import("@/lib/workspaceSetup").WorkspaceSetup[], shown: null, times: {} as Record<string, { started?: number; finished?: number }> }));
vi.mock("@/lib/workspaceSetup", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/workspaceSetup")>()), useWorkspaceSetups: () => setups, rerunSetup: vi.fn(), setupLog: vi.fn() }));
const store = vi.hoisted(() => ({ sessions: [] as unknown[], projects: [] as unknown[] }));
vi.mock("@/lib/sessions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/sessions")>()), useSessionStore: () => store }));
const run = vi.hoisted(() => ({ startAction: vi.fn(), runs: new Map<string, import("@/lib/actionRunner").ActionRun>() }));
vi.mock("@/components/session/RunMenu", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/components/session/RunMenu")>()), startAction: run.startAction, useActionRuns: () => run.runs }));
vi.mock("@/lib/api", () => ({ pty, errorMessage: (e: unknown) => String(e) }));
const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => { events.set(name, callback); return () => {}; }) }));
vi.mock("./TerminalView", () => ({
  TerminalView: ({ id, visible, moveToTab }: { id: string; visible: boolean; moveToTab?: boolean }) => <div data-testid="terminal-view" data-id={id} data-visible={visible} data-move-to-tab={moveToTab ? "true" : undefined} />,
}));

import { TerminalDock as Dock } from "./TerminalDock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setPrefs } from "@/lib/prefs";
import { dropSessionTerminals, openTerminal, moveTerminal } from "@/lib/terminal";

const TerminalDock = (props: { sessionId: string; cwd: string }) => (
  <TooltipProvider>
    <Dock {...props} />
  </TooltipProvider>
);
const shown = () => screen.getAllByTestId("terminal-view").filter((view) => view.dataset.visible === "true").map((view) => view.dataset.id);

beforeEach(() => {
  dropSessionTerminals(["s1"]);
  vi.clearAllMocks();
  setPrefs({ panelTerminalOpen: false });
  setups.runs = [];
  setups.times = {};
  store.sessions = [];
  store.projects = [];
  run.runs = new Map();
});
const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

afterEach(cleanup);

describe("the right panel's terminal dock", () => {
  it("always has Setup, Run, Terminal and Device, with where to add each script when there is none", () => {
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    expect(tabNames()).toEqual(["Setup", "Run", "Terminal", "Device"]);
    expect(screen.getByRole("img", { name: "Setup not run" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Not running" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Setup/ }));
    expect(screen.getByTestId("setup-empty").textContent).toContain("Settings → Projects → Scripts");
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    expect(screen.getByTestId("run-empty").textContent).toContain("Settings → Projects → Actions");
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it("shows the configured setup script before it has run", () => {
    store.sessions = [{ id: "s1", projectPath: "/repo", cwd: "/repo/.raccoon/worktrees/a", tabs: [] }];
    store.projects = [{ path: "/repo", name: "repo", scripts: { setup: "bun install", archive: "" } }];
    render(<TerminalDock sessionId="s1" cwd="/repo/.raccoon/worktrees/a" />);
    fireEvent.click(screen.getByRole("tab", { name: /^Setup/ }));
    expect(screen.getByText("After setup")).toBeTruthy();
    expect(screen.getByTestId("setup-script").textContent).toBe("bun install");
    expect(screen.getByRole("status").textContent).toBe("Not run in this workspace yet.");
    expect(screen.getByRole("button", { name: "Run setup" })).toBeTruthy();
  });

  it("shows a setup run's script, outcome with duration and exit code, and keeps its output", () => {
    const view = render(<TerminalDock sessionId="s1" cwd="/repo" />);
    setups.runs = [{ sessionId: "s1", paneId: "s1:workspace-setup-test", command: "bun install", status: "succeeded", exitCode: 0, error: null, hasPane: true }];
    setups.times = { "s1:s1:workspace-setup-test": { started: 1_000, finished: 15_000 } };
    view.rerender(<TerminalDock sessionId="s1" cwd="/repo" />);
    expect(tabNames()).toEqual(["Setup", "Run", "Terminal", "Device"]);
    fireEvent.click(screen.getByRole("tab", { name: /^Setup/ }));
    expect(screen.getByRole("img", { name: "Setup succeeded" })).toBeTruthy();
    expect(screen.getByTestId("setup-script").textContent).toBe("bun install");
    expect(screen.getByRole("status").textContent).toBe("✓ Last setup finished in 14s · exit 0");
    expect(screen.getByRole("button", { name: "Rerun" })).toBeTruthy();
    expect(shown()).toEqual(["s1:workspace-setup-test"]);
    expect(pty.spawn).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("lists the project's run actions with their state, and runs one through the Run menu's action", () => {
    store.sessions = [{ id: "s1", projectPath: "/repo", cwd: "/repo", tabs: [] }];
    store.projects = [{ path: "/repo", name: "repo", actions: [{ id: "dev", name: "Dev server", icon: "play", command: "bun run dev", runAfterSetup: false, concurrent: false, hidden: false }] }];
    run.runs = new Map([["dev", { sessionId: "s1", actionId: "dev", name: "Dev server", paneId: "s1:action-dev", state: "running", exitCode: null, started: "2026-11-16T10:00:00Z", ended: null }]]);
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    const pane = screen.getByTestId("run-pane");
    expect(pane.textContent).toContain("Dev server");
    expect(pane.textContent).toContain("bun run dev");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(run.startAction).toHaveBeenCalledWith({ id: "s1", cwd: "/repo" }, expect.objectContaining({ id: "dev" }), { restart: true });
  });

  it("starts folded and opens a shell in the session's folder when shown", async () => {
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(pty.spawn).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show terminal" })));
    expect(pty.spawn).toHaveBeenCalledWith(expect.stringMatching(/^s1:dock-/), "/repo", 80, 12, undefined, "Terminal 1");
    // One terminal is just "Terminal"; numbers come with a second.
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
    expect(shown()).toHaveLength(1);
  });

  it("adds more terminals, switches between them and closes them", async () => {
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
    const [first, second] = pty.spawn.mock.calls.map(([id]) => id as string);
    expect(tabNames()).toEqual(["Setup", "Run", "Terminal 1", "Terminal 2", "Device"]);
    // The shell's own header row carries Move to tab; the dock's row has no Move button.
    expect(screen.getAllByTestId("terminal-view").every((view) => view.dataset.moveToTab === "true")).toBe(true);
    expect(screen.queryByRole("button", { name: /Move to/ })).toBeNull();
    expect(shown()).toEqual([second]);

    fireEvent.click(screen.getByRole("tab", { name: "Terminal 1" }));
    expect(shown()).toEqual([first]);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" })));
    expect(pty.kill).toHaveBeenCalledWith(first);
    expect(tabNames()).toEqual(["Setup", "Run", "Terminal", "Device"]);
    expect(shown()).toEqual([second]);
  });

  it("folds to its tab row and keeps its shells", async () => {
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
    fireEvent.click(screen.getByRole("button", { name: "Hide terminal" }));
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(pty.kill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show terminal" }));
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(shown()).toHaveLength(1);
  });
});

it("shows the terminal moved into a populated dock and keeps its exited history", async () => {
  render(<TerminalDock sessionId="s1" cwd="/repo" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
  let tab!: Awaited<ReturnType<typeof openTerminal>>;
  await act(async () => { tab = await openTerminal("s1", "/repo"); });
  pty.setDocked.mockResolvedValue({ id: tab.id, sessionId: "s1", title: tab.title, cwd: "/repo", exited: true, docked: true });
  await act(async () => { await moveTerminal(tab.id, true); });
  expect(shown()).toEqual([tab.id]);
  act(() => events.get("pty_exit")!({ payload: { id: tab.id, code: 1 } }));
  expect(screen.getByText("Process exited (1).")).toBeTruthy();
  expect(shown()).toEqual([tab.id]);
  expect(pty.kill).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
  expect(shown()).toEqual([pty.spawn.mock.calls.at(-1)![0]]);
});
