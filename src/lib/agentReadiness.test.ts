import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { checkAgentReadiness, readinessBlock, useAgentReadiness, type AgentReadiness } from "./agentReadiness";

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
