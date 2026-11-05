import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { checkAgentReadiness, readinessBlock, useAgentReadiness, useAgentReadinessList, type AgentReadiness } from "./agentReadiness";

const answer = (state: AgentReadiness["state"]): AgentReadiness => ({ state, checkedAt: "2026-10-26T14:00:00Z", version: "0.164.0" });
afterEach(() => { cleanup(); invoke.mockReset(); });

describe("agent readiness", () => {
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

  it("discards stale probes after installation changes and does not probe cloud agents", async () => {
    let old: (value: AgentReadiness) => void = () => {};
    invoke.mockImplementation(() => new Promise<AgentReadiness>((resolve) => { old = resolve; }));
    const { result, rerender } = renderHook(({ agents, enabled }) => useAgentReadinessList(agents, enabled), { initialProps: { agents: [harnesses[0]], enabled: true } });
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
