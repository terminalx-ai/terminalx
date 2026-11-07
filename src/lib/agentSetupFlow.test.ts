import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen, refreshHarnesses, disposeInstance } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  refreshHarnesses: vi.fn(async () => {}),
  disposeInstance: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/lib/sessions", () => ({ refreshHarnesses }));
vi.mock("@/lib/terminal", () => ({ disposeInstance, peekInstance: () => undefined }));

import { forgetReadiness, useAgentReadiness, type AgentReadiness } from "./agentReadiness";
import {
  SETUP_EXIT, afterCheck, afterExit, cancelAgentSetup, getAgentSetupFlow, resetAgentSetupFlows, retryAgentSetup, startAgentSetup, useSetupTerminalHost, type AgentSetupFlow,
} from "./agentSetupFlow";

const answer = (state: AgentReadiness["state"]): AgentReadiness => ({ state, checkedAt: "2026-11-06T09:00:00Z", version: state === "missing" ? null : "2.1.318" });

/** Every `listen` callback by event, so a test can be the backend. */
const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}
/** What the readiness probe answers next, in order; the last one repeats. */
let probes: AgentReadiness["state"][] = [];
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

beforeEach(() => {
  resetAgentSetupFlows();
  forgetReadiness();
  handlers.clear();
  probes = ["missing"];
  listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => handlers.get(event)!.delete(handler);
  });
  invoke.mockImplementation(async (command: string) => {
    if (command === "check_agent_readiness") return answer(probes.length > 1 ? probes.shift()! : probes[0]);
    if (command === "agent_setup_start" || command === "pty_kill" || command === "pty_resize") return null;
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const running = (step: "install" | "login", chain = true): AgentSetupFlow => ({ phase: "running", step, pane: "setup:claude:r1", chain });
const checking = (step: "install" | "login", chain = true): AgentSetupFlow => ({ phase: "checking", step, pane: "setup:claude:r1", chain });

describe("setup transitions (PRO-152)", () => {
  it("reads each exit of a step, and claims nothing from a success until it is checked", () => {
    expect(afterExit(running("install"), 0)).toEqual(checking("install"));
    expect(afterExit(running("login"), 0)).toEqual(checking("login"));
    const failed = (step: "install" | "login", code: number | null) => {
      const flow = afterExit(running(step), code);
      return flow.phase === "failed" ? flow.problem : flow.phase;
    };
    expect(failed("install", SETUP_EXIT.permission)).toBe("permission");
    expect(failed("install", SETUP_EXIT.offline)).toBe("offline");
    expect(failed("install", SETUP_EXIT.download)).toBe("download");
    expect(failed("install", SETUP_EXIT.install)).toBe("install");
    expect(failed("install", 137)).toBe("install");
    expect(failed("install", null)).toBe("install");
    expect(failed("login", SETUP_EXIT.offline)).toBe("offline");
    expect(failed("login", SETUP_EXIT.login)).toBe("login");
    expect(failed("login", 1)).toBe("login");
    // Only a running step has an exit to read.
    const idle: AgentSetupFlow = { phase: "idle" };
    expect(afterExit(idle, 0)).toBe(idle);
  });

  it("goes from installed to signing in to ready on what the readiness probe says", () => {
    expect(afterCheck(checking("install"), answer("signed_out"))).toEqual(running("login"));
    expect(afterCheck(checking("install", false), answer("signed_out"))).toEqual({ phase: "idle" });
    expect(afterCheck(checking("install"), answer("ready"))).toEqual({ phase: "done" });
    expect(afterCheck(checking("login"), answer("ready"))).toEqual({ phase: "done" });
    // A sign-in that exited cleanly without signing in is not taken for one.
    expect(afterCheck(checking("login"), answer("signed_out"))).toMatchObject({ phase: "failed", problem: "login" });
    expect(afterCheck(checking("install"), answer("missing"))).toMatchObject({ phase: "failed", problem: "not_found" });
    // Installed, but the login cannot be told: no sign-in is forced on it.
    expect(afterCheck(checking("install"), answer("unknown"))).toEqual({ phase: "idle" });
    expect(afterCheck(running("install"), answer("ready"))).toEqual(running("install"));
  });
});

describe("the setup flow (PRO-152)", () => {
  it("installs, signs in in the same terminal, and tells every view it is ready", async () => {
    const { result } = renderHook(() => useAgentReadiness("claude"));
    await waitFor(() => expect(result.current.value?.state).toBe("missing"));

    await act(() => startAgentSetup("claude", "install", { chain: true }));
    const [install] = calls("agent_setup_start") as { id: string; harness: string; step: string }[];
    expect(install).toMatchObject({ harness: "claude", step: "install" });
    expect(install.id).toMatch(/^setup:claude:[a-z0-9]+$/);
    expect(getAgentSetupFlow("claude")).toMatchObject({ phase: "running", step: "install", pane: install.id });

    probes = ["signed_out"];
    await act(async () => emit("pty_exit", { id: install.id, code: 0 }));
    await waitFor(() => expect(getAgentSetupFlow("claude")).toMatchObject({ phase: "running", step: "login" }));
    expect(refreshHarnesses).toHaveBeenCalled();
    const login = calls("agent_setup_start")[1] as { id: string; step: string };
    expect(login).toMatchObject({ id: install.id, step: "login" });
    // No one pressed Check again.
    expect(result.current.value?.state).toBe("signed_out");

    probes = ["ready"];
    await act(async () => emit("pty_exit", { id: install.id, code: 0 }));
    await waitFor(() => expect(getAgentSetupFlow("claude")).toEqual({ phase: "done" }));
    expect(result.current.value?.state).toBe("ready");
    expect(calls("pty_kill")).toEqual([{ id: install.id }]);
    expect(disposeInstance).toHaveBeenCalledWith(install.id);
  });

  it("explains a failure and retries the same step in the same terminal", async () => {
    await act(() => startAgentSetup("codex", "install", { chain: true }));
    const pane = (calls("agent_setup_start")[0] as { id: string }).id;
    await act(async () => emit("pty_exit", { id: pane, code: SETUP_EXIT.offline }));
    expect(getAgentSetupFlow("codex")).toMatchObject({ phase: "failed", step: "install", problem: "offline", pane });

    await act(() => retryAgentSetup("codex"));
    expect(calls("agent_setup_start")[1]).toMatchObject({ id: pane, harness: "codex", step: "install" });
    expect(getAgentSetupFlow("codex")).toMatchObject({ phase: "running", step: "install", chain: true });
    // Another pane's exit, or another agent's, is not this run's.
    await act(async () => emit("pty_exit", { id: "setup:codex:other", code: 0 }));
    await act(async () => emit("pty_exit", { id: "01a0814c:1", code: 0 }));
    expect(getAgentSetupFlow("codex")).toMatchObject({ phase: "running" });
  });

  it("looks again for a CLI the installer put out of sight, without installing again", async () => {
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    const pane = (calls("agent_setup_start")[0] as { id: string }).id;
    probes = ["missing"];
    await act(async () => emit("pty_exit", { id: pane, code: 0 }));
    await waitFor(() => expect(getAgentSetupFlow("claude")).toMatchObject({ phase: "failed", problem: "not_found" }));
    probes = ["signed_out"];
    await act(() => retryAgentSetup("claude"));
    await waitFor(() => expect(getAgentSetupFlow("claude")).toMatchObject({ phase: "running", step: "login" }));
    expect(calls("agent_setup_start").map((args) => (args as { step: string }).step)).toEqual(["install", "login"]);
  });

  it("asks again about a CLI whose first run after its install cannot tell its login", async () => {
    vi.useFakeTimers();
    await act(() => startAgentSetup("codex", "install", { chain: true }));
    const pane = (calls("agent_setup_start")[0] as { id: string }).id;
    probes = ["unknown", "unknown", "signed_out"];
    await act(async () => emit("pty_exit", { id: pane, code: 0 }));
    expect(getAgentSetupFlow("codex")).toMatchObject({ phase: "checking" });
    // Twice, a moment apart.
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(calls("check_agent_readiness")).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(getAgentSetupFlow("codex")).toMatchObject({ phase: "running", step: "login" });
    expect(calls("check_agent_readiness")).toHaveLength(3);
    vi.useRealTimers();

    // After a sign-in, an unknown login is taken as it is.
    probes = ["unknown"];
    await act(async () => emit("pty_exit", { id: pane, code: 0 }));
    await waitFor(() => expect(getAgentSetupFlow("codex")).toEqual({ phase: "idle" }));
    expect(calls("check_agent_readiness")).toHaveLength(4);
  });

  it("cancels without a failure, and a late exit of the canceled run changes nothing", async () => {
    await act(() => startAgentSetup("claude", "login"));
    const pane = (calls("agent_setup_start")[0] as { id: string }).id;
    act(() => cancelAgentSetup("claude"));
    expect(getAgentSetupFlow("claude")).toEqual({ phase: "idle" });
    expect(calls("pty_kill")).toEqual([{ id: pane }]);
    await act(async () => emit("pty_exit", { id: pane, code: 143 }));
    expect(getAgentSetupFlow("claude")).toEqual({ phase: "idle" });

    // The next run is a new terminal.
    await act(() => startAgentSetup("claude", "login"));
    expect((calls("agent_setup_start")[1] as { id: string }).id).not.toBe(pane);
  });

  it("stops a step that was canceled while it was still starting", async () => {
    let started: () => void = () => {};
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_setup_start") return new Promise<void>((resolve) => { started = resolve; });
      return null;
    });
    const starting = startAgentSetup("claude", "install", { chain: true });
    await waitFor(() => expect(calls("agent_setup_start")).toHaveLength(1));
    const pane = (calls("agent_setup_start")[0] as { id: string }).id;
    act(() => cancelAgentSetup("claude"));
    expect(calls("pty_kill")).toEqual([{ id: pane }]);
    // The kill went ahead of the spawn; once the spawn lands it is killed too.
    await act(async () => { started(); await starting; });
    expect(calls("pty_kill")).toEqual([{ id: pane }, { id: pane }]);
    expect(getAgentSetupFlow("claude")).toEqual({ phase: "idle" });
  });

  it("shows the run another window started instead of starting a second one", async () => {
    let elsewhere: { pane: string; step: string } | null = { pane: "setup:claude:other", step: "install" };
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_setup_start") throw new Error("Claude Code is already being set up.");
      if (command === "agent_setup_running") return elsewhere;
      if (command === "check_agent_readiness") return answer(probes[0]);
      return null;
    });
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    expect(getAgentSetupFlow("claude")).toEqual({ phase: "running", step: "install", pane: "setup:claude:other", chain: true });
    // Its exit is this window's to follow, as if it had started it.
    probes = ["signed_out"];
    await act(async () => emit("pty_exit", { id: "setup:claude:other", code: 0 }));
    await waitFor(() => expect(calls("agent_setup_start").at(-1)).toMatchObject({ id: "setup:claude:other", step: "login" }));

    // One that ended before this window listened: nothing runs, and the views hear where it got to.
    resetAgentSetupFlows();
    let asked = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_setup_start") throw new Error("Claude Code is already being set up.");
      if (command === "agent_setup_running") return asked++ === 0 ? elsewhere : null;
      if (command === "check_agent_readiness") return answer("ready");
      return null;
    });
    const { result } = renderHook(() => useAgentReadiness("claude"));
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    expect(getAgentSetupFlow("claude")).toEqual({ phase: "idle" });
    await waitFor(() => expect(result.current.value?.state).toBe("ready"));

    // Refused with nothing to show: the reason is said.
    resetAgentSetupFlows();
    elsewhere = null;
    asked = 1;
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    expect(getAgentSetupFlow("claude")).toMatchObject({ phase: "failed", problem: "start", detail: "Claude Code is already being set up." });
  });

  it("keeps its terminal when the run it follows is in the pane it was about to use", async () => {
    // Two windows follow one install; when it ends, both start the sign-in in
    // its pane, and the runtime lets one of them.
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    const pane = (calls("agent_setup_start")[0] as { id: string }).id;
    invoke.mockImplementation(async (command: string) => {
      if (command === "check_agent_readiness") return answer("signed_out");
      if (command === "agent_setup_start") throw new Error("Claude Code is already being set up.");
      if (command === "agent_setup_running") return { pane, step: "login" };
      return null;
    });
    await act(async () => emit("pty_exit", { id: pane, code: 0 }));
    await waitFor(() => expect(calls("agent_setup_running").length).toBeGreaterThanOrEqual(2));
    expect(getAgentSetupFlow("claude")).toEqual({ phase: "running", step: "login", pane, chain: false });
    expect(disposeInstance).not.toHaveBeenCalledWith(pane);
  });

  it("puts a terminal in the view in front, and back in the one behind when it goes", () => {
    const behind = renderHook(() => useSetupTerminalHost("setup:claude:r1"));
    expect(behind.result.current).toBe(true);
    const front = renderHook(() => useSetupTerminalHost("setup:claude:r1"));
    expect([behind.result.current, front.result.current]).toEqual([false, true]);
    front.unmount();
    expect(behind.result.current).toBe(true);
    expect(renderHook(() => useSetupTerminalHost(null)).result.current).toBe(false);
  });

  it("says why a step could not start, and runs one step at a time", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_setup_start") throw new Error("The background service is not running.");
      return null;
    });
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    expect(getAgentSetupFlow("claude")).toMatchObject({ phase: "failed", problem: "start", detail: "The background service is not running." });

    invoke.mockImplementation(async () => null);
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    await act(() => startAgentSetup("claude", "install", { chain: true }));
    // The failed attempt, then one run: the second press found it running.
    expect(calls("agent_setup_start")).toHaveLength(2);
  });
});
