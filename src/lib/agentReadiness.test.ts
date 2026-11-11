import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
import { announceReadiness, checkAgentReadiness, forgetReadiness, readinessBlock, useAgentReadiness, useAgentReadinessList, useAllSignedOut, type AgentReadiness } from "./agentReadiness";

const answer = (state: AgentReadiness["state"]): AgentReadiness => ({ state, checkedAt: "2026-10-26T14:00:00Z", version: "0.164.0" });
const exits = new Set<() => void>();
beforeEach(() => {
  forgetReadiness();
  listen.mockImplementation(async (_event, callback) => {
    exits.add(callback);
    return () => exits.delete(callback);
  });
});
afterEach(() => { cleanup(); invoke.mockReset(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("agent readiness", () => {
  it("follows installation and login on return to the app without a manual check", async () => {
    invoke.mockResolvedValue(answer("missing"));
    const { result } = renderHook(() => useAgentReadiness("codex"));
    await waitFor(() => expect(result.current.value?.state).toBe("missing"));
    invoke.mockResolvedValue(answer("signed_out"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.value?.state).toBe("signed_out"));
    invoke.mockResolvedValue(answer("ready"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.value?.state).toBe("ready"));
  });

  it("rechecks when the embedded sign-in command finishes, without inferring success from its exit", async () => {
    invoke.mockResolvedValue(answer("signed_out"));
    const { result, unmount } = renderHook(() => useAgentReadiness("codex"));
    await waitFor(() => expect(result.current.value?.state).toBe("signed_out"));
    await act(async () => exits.forEach((notify) => notify()));
    expect(result.current.value?.state).toBe("signed_out");
    invoke.mockResolvedValue(answer("ready"));
    await act(async () => exits.forEach((notify) => notify()));
    expect(result.current.value?.state).toBe("ready");
    unmount();
    expect(exits.size).toBe(0);
  });

  it("polls every two minutes only while the Agents card is visible and disposes all triggers", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    invoke.mockResolvedValue(answer("missing"));
    const { result, unmount } = renderHook(() => useAgentReadiness("codex", true));
    await act(async () => {});
    invoke.mockResolvedValue(answer("signed_out"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(result.current.value?.state).toBe("signed_out");
    hidden.mockReturnValue(true);
    invoke.mockResolvedValue(answer("ready"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(result.current.value?.state).toBe("signed_out");
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.value?.state).toBe("ready");
    expect(invoke).toHaveBeenCalledTimes(3);
    unmount();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(exits.size).toBe(0);
  });

  it("does not poll unless requested or probe a cloud agent", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(answer("ready"));
    const { rerender } = renderHook(({ id }) => useAgentReadiness(id), { initialProps: { id: "codex" as string | null } });
    await act(async () => vi.advanceTimersByTimeAsync(360_000));
    expect(invoke).toHaveBeenCalledTimes(1);
    rerender({ id: null });
    window.dispatchEvent(new Event("focus"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(exits.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes a native listener that finishes registering after unmount", async () => {
    let register: (stop: () => void) => void = () => {};
    listen.mockReturnValueOnce(new Promise<() => void>((resolve) => { register = resolve; }));
    invoke.mockResolvedValue(answer("ready"));
    const { unmount } = renderHook(() => useAgentReadiness("codex"));
    unmount();
    const stop = vi.fn();
    await act(async () => register(stop));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not let a pre-login probe replace a newer result", async () => {
    let old: (value: AgentReadiness) => void = () => {};
    invoke.mockReturnValueOnce(new Promise<AgentReadiness>((resolve) => { old = resolve; }));
    const { result } = renderHook(() => useAgentReadiness("codex"));
    invoke.mockResolvedValue(answer("ready"));
    await act(async () => result.current.refresh());
    await act(async () => old(answer("signed_out")));
    expect(result.current.value?.state).toBe("ready");
  });

  it("keeps probe errors unknown without leaking diagnostics or blocking a working CLI", async () => {
    invoke.mockRejectedValue(new Error("provider diagnostic with secret value"));
    const result = await checkAgentReadiness("codex");
    expect(result).toEqual({ state: "unknown", checkedAt: null, version: null });
    expect(readinessBlock("Codex", result)).toBeNull();
  });

  it("blocks only known missing prerequisites", () => {
    expect(readinessBlock("Codex", answer("signed_out"))).toContain("no session has been created");
    expect(readinessBlock("Codex", answer("missing"))).toContain("not installed");
    expect(readinessBlock("Codex", answer("ready"))).toBeNull();
  });

  it("does not let an older agent check overwrite the selected agent", async () => {
    let old: (value: AgentReadiness) => void = () => {};
    invoke.mockImplementation((_cmd, { harness }) => harness === "claude"
      ? new Promise<AgentReadiness>((resolve) => { old = resolve; }) : Promise.resolve(answer("signed_out")));
    const { result, rerender } = renderHook(({ id }) => useAgentReadiness(id), { initialProps: { id: "claude" as string | null } });
    rerender({ id: "codex" });
    await waitFor(() => expect(result.current.value?.state).toBe("signed_out"));
    await act(async () => old(answer("ready")));
    expect(result.current.value?.state).toBe("signed_out");
    rerender({ id: null });
    expect(result.current.value).toBeNull();
  });
});


describe("new-chat readiness discovery", () => {
  const harnesses = ["claude", "codex"].map((id) => ({ id, name: id, available: true, path: `/bin/${id}`, installHint: "", installUrl: "", description: "" }));

  it("follows missing → installed → ready on return despite cached installation metadata", async () => {
    invoke.mockResolvedValue(answer("missing"));
    const { result } = renderHook(() => useAgentReadinessList([{ ...harnesses[1], available: false }]));
    await waitFor(() => expect(result.current.values?.codex.state).toBe("missing"));
    invoke.mockResolvedValue(answer("signed_out"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.values?.codex.state).toBe("signed_out"));
    invoke.mockResolvedValue(answer("ready"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.values?.codex.state).toBe("ready"));
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("rechecks embedded login completion and removes all triggers when disabled", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(answer("signed_out"));
    const { result, rerender, unmount } = renderHook(({ enabled }) => useAgentReadinessList([harnesses[1]], enabled), { initialProps: { enabled: true } });
    await act(async () => {});
    await act(async () => exits.forEach((notify) => notify()));
    expect(result.current.values?.codex.state).toBe("signed_out");
    invoke.mockResolvedValue(answer("ready"));
    await act(async () => exits.forEach((notify) => notify()));
    expect(result.current.values?.codex.state).toBe("ready");
    await act(async () => vi.advanceTimersByTimeAsync(360_000));
    expect(invoke).toHaveBeenCalledTimes(3);

    await act(async () => rerender({ enabled: false }));
    window.dispatchEvent(new Event("focus"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.current.values).toEqual({});
    expect(exits.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("waits for both probes before publishing defaults, then refreshes login changes", async () => {
    let claude: (value: AgentReadiness) => void = () => {};
    invoke.mockImplementation((_cmd, { harness }) => harness === "claude"
      ? new Promise<AgentReadiness>((resolve) => { claude = resolve; }) : Promise.resolve(answer("ready")));
    const { result } = renderHook(() => useAgentReadinessList(harnesses));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(result.current.values).toBeNull();
    await act(async () => claude(answer("signed_out")));
    expect(result.current.values?.claude.state).toBe("signed_out");
    expect(result.current.values?.codex.state).toBe("ready");
    invoke.mockResolvedValue(answer("ready"));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.values?.claude.state).toBe("ready");
  });

  it("takes a sign-in the setup flow announces, over a check still under way (PRO-152)", async () => {
    invoke.mockResolvedValue(answer("signed_out"));
    const { result } = renderHook(() => useAgentReadinessList(harnesses));
    await waitFor(() => expect(result.current.values?.claude.state).toBe("signed_out"));
    // No installation changed, so nothing else would check again.
    act(() => announceReadiness("claude", answer("ready")));
    expect(result.current.values?.claude.state).toBe("ready");
    expect(result.current.values?.codex.state).toBe("signed_out");

    let old: (value: AgentReadiness) => void = () => {};
    invoke.mockImplementation((_cmd, { harness }) => harness === "codex"
      ? new Promise<AgentReadiness>((resolve) => { old = resolve; }) : Promise.resolve(answer("ready")));
    let checked: Promise<unknown> = Promise.resolve();
    act(() => { checked = result.current.refresh(); });
    act(() => announceReadiness("codex", answer("ready")));
    await act(async () => { old(answer("signed_out")); await checked; });
    expect(result.current.values?.codex.state).toBe("ready");
    // Another agent's answer is not one of these.
    act(() => announceReadiness("gemini", answer("ready")));
    expect(result.current.values).not.toHaveProperty("gemini");
  });

  it("discards stale probes after installation changes and does not probe cloud agents", async () => {
    let old: (value: AgentReadiness) => void = () => {};
    invoke.mockImplementation(() => new Promise<AgentReadiness>((resolve) => { old = resolve; }));
    const { result, rerender } = renderHook(({ agents, enabled }) => useAgentReadinessList(agents, enabled), { initialProps: { agents: [harnesses[0]], enabled: true } });
    invoke.mockResolvedValue(answer("missing"));
    rerender({ agents: [{ ...harnesses[0], available: false }], enabled: true });
    await waitFor(() => expect(result.current.values?.claude.state).toBe("missing"));
    await act(async () => old(answer("ready")));
    expect(result.current.values?.claude.state).toBe("missing");
    invoke.mockClear();
    rerender({ agents: harnesses, enabled: false });
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("whether every installed agent is signed out (PRO-152)", () => {
  const states = (map: Record<string, AgentReadiness["state"]>) =>
    invoke.mockImplementation(async (_command: string, args: { harness: string }) => answer(map[args.harness]));
  const probed = () => invoke.mock.calls.map(([, args]) => (args as { harness: string }).harness);

  it("stops at the first agent that is not signed out, and asks nothing again soon after", async () => {
    states({ claude: "ready", codex: "signed_out" });
    const first = renderHook(() => useAllSignedOut(["claude", "codex"]));
    await waitFor(() => expect(probed()).toEqual(["claude"]));
    expect(first.result.current).toBe(false);
    first.unmount();

    // Home again a moment later, and the app back in front: no new checks.
    const again = renderHook(() => useAllSignedOut(["claude", "codex"]));
    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => {});
    expect(probed()).toEqual(["claude"]);
    expect(again.result.current).toBe(false);
  });

  it("is true only once every one is known signed out, and follows later answers", async () => {
    states({ claude: "signed_out", codex: "signed_out" });
    const { result } = renderHook(() => useAllSignedOut(["claude", "codex"]));
    await waitFor(() => expect(result.current).toBe(true));
    expect(probed()).toEqual(["claude", "codex"]);
    // Signed in from a setup run, or found so by any other check.
    act(() => announceReadiness("codex", answer("ready")));
    expect(result.current).toBe(false);
    act(() => announceReadiness("codex", answer("signed_out")));
    expect(result.current).toBe(true);
    states({ claude: "ready", codex: "signed_out" });
    await act(async () => { await checkAgentReadiness("claude"); });
    expect(result.current).toBe(false);
  });
});
