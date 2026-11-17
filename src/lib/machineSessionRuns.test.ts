import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineSessionActions, MachineSetupRun, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CloudTerminal } from "@/lib/cloudTerminals";

const mocks = vi.hoisted(() => ({ syncCloudTerminals: vi.fn(async () => undefined) }));
vi.mock("@/lib/cloudTerminals", () => ({ syncCloudTerminals: mocks.syncCloudTerminals }));
vi.mock("@/components/terminal/TerminalView", () => ({ createTerminal: vi.fn() }));

const { latestRunsOf, scriptRunsOf, scriptsBlocked, setupSettling, setupTerminalOf, useMachineSessionScripts, SETUP_POLL_MS } = await import("./machineSessionRuns");

function terminal(patch: Partial<CloudTerminal>): CloudTerminal {
  return { id: `t-${patch.ptyId}`, ptyId: "p", number: 1, title: "", exited: false, exitCode: null, gone: null, sessionId: "s1", tabId: null, run: null, live: false, ...patch } as CloudTerminal;
}

const setup = (patch: Partial<MachineSetupRun> = {}): MachineSetupRun => ({ paneId: "s1:workspace-setup-1", command: "pnpm i", status: "running", exitCode: null, error: null, hasPane: true, ...patch });

describe("a machine session's runs, from its terminals on the machine (PRO-403)", () => {
  const listed = [
    terminal({ ptyId: "s1:action-serve-2", run: { kind: "action", actionId: "serve", name: "Serve" }, createdAt: 30 }),
    terminal({ ptyId: "s1:action-test-1", run: { kind: "action", actionId: "test", name: "Test" }, createdAt: 10, exited: true, exitCode: 1 }),
    terminal({ ptyId: "s1:action-serve-1", run: { kind: "action", actionId: "serve", name: "Serve" }, createdAt: 20, exited: true, exitCode: 0 }),
    terminal({ ptyId: "s1:action-gone", run: { kind: "action", actionId: "lint", name: "Lint" }, createdAt: 5, gone: "closed" }),
    terminal({ ptyId: "s1:workspace-setup-1", run: { kind: "setup" }, createdAt: 1 }),
    terminal({ ptyId: "shell-1", createdAt: 2 }),
  ];

  it("lists each action run oldest first, by the machine's pane and this window's terminal", () => {
    expect(scriptRunsOf(listed).map((run) => [run.actionId, run.ptyId, run.terminalId, run.state, run.exitCode])).toEqual([
      ["test", "s1:action-test-1", "t-s1:action-test-1", "exited", 1],
      ["serve", "s1:action-serve-1", "t-s1:action-serve-1", "exited", 0],
      ["serve", "s1:action-serve-2", "t-s1:action-serve-2", "running", null],
    ]);
  });

  it("keeps the newest run of each action for the Run menu", () => {
    expect(latestRunsOf(scriptRunsOf(listed)).map((run) => run.ptyId)).toEqual(["s1:action-test-1", "s1:action-serve-2"]);
  });

  it("finds the setup attempt's terminal by its pane, else the newest setup terminal", () => {
    expect(setupTerminalOf(listed, setup())).toBe("t-s1:workspace-setup-1");
    expect(setupTerminalOf(listed, setup({ paneId: "s1:workspace-setup-9" }))).toBeNull();
    expect(setupTerminalOf(listed, null)).toBe("t-s1:workspace-setup-1");
    expect(setupTerminalOf([], null)).toBeNull();
  });

  it("reads a setup again only while it is going", () => {
    expect(["pending", "running", "stopping"].map((status) => setupSettling(setup({ status: status as MachineSetupRun["status"] })))).toEqual([true, true, true]);
    expect(["succeeded", "failed", "stopped"].map((status) => setupSettling(setup({ status: status as MachineSetupRun["status"] })))).toEqual([false, false, false]);
    expect(setupSettling(null)).toBe(false);
  });

  it("says why nothing can be started, naming the machine", () => {
    const ok = { name: "Mac mini", connected: true, manage: true, served: true, available: true };
    expect(scriptsBlocked(ok)).toBeNull();
    expect(scriptsBlocked({ ...ok, connected: false })).toBe("Can't run until Mac mini is back");
    expect(scriptsBlocked({ ...ok, served: false })).toContain("older TerminalX");
    expect(scriptsBlocked({ ...ok, manage: false })).toBe("Only a computer paired with Mac mini runs its scripts");
    expect(scriptsBlocked({ ...ok, available: false })).toContain("worktree was removed");
  });
});

describe("useMachineSessionScripts (the model's `scripts`)", () => {
  const info = (patch: Partial<MachineSessionActions> = {}): MachineSessionActions => ({
    actions: [
      { id: "serve", name: "Serve", icon: "play", command: "pnpm dev", runAfterSetup: false, concurrent: false, hidden: false },
      { id: "secret", name: "Secret", icon: "terminal", command: "x", runAfterSetup: false, concurrent: false, hidden: true },
    ],
    previewUrls: [{ id: "web", name: "Web", url: "http://localhost:$PORT" }],
    setupScript: "pnpm i",
    setupApplies: true,
    available: true,
    ports: [41000],
    setup: null,
    ...patch,
  });
  let client: Record<string, ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    client = {
      hasCapability: vi.fn((capability: string) => capability === "machine/7"),
      sessionActions: vi.fn(async () => info()),
      runAction: vi.fn(async (_session: string, actionId: string) => ({ started: true, run: { actionId, name: "Serve", ptyId: "s1:action-serve-1", state: "running", exitCode: null }, terminal: null })),
      rerunSetup: vi.fn(async () => setup()),
      stopSetup: vi.fn(async () => setup({ status: "stopping" })),
    };
  });
  const mount = (patch: { manage?: boolean; connected?: boolean } = {}) =>
    renderHook(() =>
      useMachineSessionScripts({
        client: client as unknown as WorkspaceRpcClient,
        connected: patch.connected ?? true,
        manage: patch.manage ?? true,
        name: "Mac mini",
        sessionId: "s1",
        generation: "1:e:0:1",
        workspaceKey: "machine:m1",
        terminals: [],
        terminalBase: (() => null) as never,
      }),
    );

  it("reads the session's scripts on the machine and offers its visible actions", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.info).not.toBeNull());
    expect(client.sessionActions).toHaveBeenCalledWith("s1");
    expect(result.current.actions.map((action) => action.id)).toEqual(["serve"]);
    expect(result.current.info?.ports).toEqual([41000]);
    expect(result.current.blocked).toBeNull();
  });

  it("runs and restarts an action on the machine, then lists its terminal here", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.info).not.toBeNull());
    await act(() => result.current.run("serve"));
    await act(() => result.current.run("serve", { restart: true }));
    expect(client.runAction.mock.calls).toEqual([["s1", "serve", false], ["s1", "serve", true]]);
    expect(mocks.syncCloudTerminals).toHaveBeenCalledTimes(2);
  });

  it("reruns and stops setup on the machine, by the attempt's pane", async () => {
    client.sessionActions.mockResolvedValue(info({ setup: setup() }));
    const { result } = mount();
    await waitFor(() => expect(result.current.info?.setup?.paneId).toBe("s1:workspace-setup-1"));
    await act(() => result.current.stopSetup());
    expect(client.stopSetup).toHaveBeenCalledWith("s1", "s1:workspace-setup-1");
    await act(() => result.current.rerunSetup());
    expect(client.rerunSetup).toHaveBeenCalledWith("s1");
  });

  it("reads a going setup again every poll", async () => {
    vi.useFakeTimers();
    client.sessionActions.mockResolvedValue(info({ setup: setup() }));
    const { result } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.info?.setup?.status).toBe("running");
    const reads = client.sessionActions.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 2);
    });
    expect(client.sessionActions.mock.calls.length).toBeGreaterThanOrEqual(reads + 2);
    vi.useRealTimers();
  });

  it("starts nothing for a participant, while away, or on a machine without machine/7", async () => {
    const viewer = mount({ manage: false });
    await waitFor(() => expect(viewer.result.current.info).not.toBeNull());
    await expect(viewer.result.current.run("serve")).rejects.toThrow("Only a computer paired with Mac mini");
    const away = mount({ connected: false });
    expect(away.result.current.served).toBe(false);
    await expect(away.result.current.rerunSetup()).rejects.toThrow("Can't run until Mac mini is back");
    client.hasCapability.mockReturnValue(false);
    const older = mount();
    expect(older.result.current.served).toBe(false);
    expect(older.result.current.actions).toEqual([]);
    expect(client.runAction).not.toHaveBeenCalled();
  });
});
