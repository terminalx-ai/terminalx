import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient, type RuntimeAgent, type WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { ModelInfo } from "@/lib/api";
import { modelOptionText } from "@/lib/models";
import { usePickerModels } from "./cloudModels";
import { FakeAgentRuntime } from "@/test/fakeAgentRuntime";

const opus: ModelInfo = { id: "opus", label: "Opus", harness: "claude", alias: true, resolved: "claude-opus-5-5", efforts: [], defaultEffort: null, acceptsImages: true, isDefault: true, upgrade: null, description: null };
const local = [opus, { ...opus, id: "claude-opus-5-5", alias: false }];
const agents = (version: string): RuntimeAgent[] => [{
  id: "claude", name: "Claude Code", caps: {}, modes: [], defaultMode: "bypassPermissions",
  models: [{ ...opus, resolved: version }, { ...opus, id: version, label: "VM pinned model", alias: false, resolved: null }],
}];
afterEach(cleanup);

describe("workspace model discovery", () => {
  it("shares the runtime list across pickers and refreshes it on demand", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.agents = agents("claude-opus-4-6");
    const client = new WorkspaceRpcClient(runtime);
    runtime.connect();
    const first = renderHook(() => usePickerModels(local, true, client, "claude"));
    const second = renderHook(() => usePickerModels(local, true, client, "claude"));
    await waitFor(() => expect(first.result.current.models.map((m) => m.id)).toEqual(["opus", "claude-opus-4-6"]));
    expect(second.result.current.models).toEqual(first.result.current.models);
    expect(modelOptionText(first.result.current.models[0], first.result.current.models)).toBe("Opus (latest · Opus 4.6)");
    expect(runtime.methods("runtime.agents")).toHaveLength(1);
    runtime.agents = agents("claude-opus-5");
    await act(() => first.result.current.refresh());
    expect(second.result.current.models[1].id).toBe("claude-opus-5");
  });

  it("drops pinned choices immediately offline and reads anew on reconnect", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.agents = agents("claude-opus-4-6");
    const client = new WorkspaceRpcClient(runtime);
    runtime.connect();
    const { result } = renderHook(() => usePickerModels(local, true, client, "claude"));
    await waitFor(() => expect(result.current.models).toHaveLength(2));
    for (const state of ["reconnecting", "suspended"] as const) {
      act(() => runtime.emit({ state } as WorkspaceConnectionState));
      expect(result.current.models.map((m) => m.id)).toEqual(["opus"]);
      expect(result.current.models[0].resolved).toBeNull();
      await act(() => result.current.refresh());
      expect(runtime.methods("runtime.agents")).toHaveLength(1);
    }
    runtime.agents = agents("claude-opus-5");
    act(() => runtime.connect());
    await waitFor(() => expect(result.current.models[1]?.id).toBe("claude-opus-5"));
    expect(runtime.methods("runtime.agents")).toHaveLength(2);
  });

  it("never carries a response across workspaces or reconnects, even if it arrives late", async () => {
    const runtime = new FakeAgentRuntime();
    const client = new WorkspaceRpcClient(runtime);
    runtime.connect();
    let resolve!: (agents: RuntimeAgent[]) => void;
    vi.spyOn(client, "listRuntimeAgents").mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { result, rerender } = renderHook(({ client }) => usePickerModels(local, true, client, "claude"), { initialProps: { client } });
    act(() => runtime.emit({ state: "reconnecting" } as WorkspaceConnectionState));
    await act(async () => resolve(agents("claude-opus-4-6")));
    expect(result.current.models.map((m) => m.id)).toEqual(["opus"]);
    const other = new FakeAgentRuntime();
    other.agents = agents("claude-opus-5");
    const otherClient = new WorkspaceRpcClient(other);
    other.connect();
    rerender({ client: otherClient });
    await waitFor(() => expect(result.current.models[1]?.id).toBe("claude-opus-5"));
  });

  it("uses aliases when the runtime is absent, old, or fails to answer", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.capabilities = ["session/1"];
    const client = new WorkspaceRpcClient(runtime);
    runtime.connect();
    const { result, rerender } = renderHook(({ client }: { client: WorkspaceRpcClient | null }) => usePickerModels(local, true, client, "claude"), { initialProps: { client: null } as { client: WorkspaceRpcClient | null } });
    expect(result.current.models.map((m) => m.id)).toEqual(["opus"]);
    rerender({ client });
    await act(() => result.current.refresh());
    expect(runtime.methods("runtime.agents")).toHaveLength(0);
    const read = vi.spyOn(client, "listRuntimeAgents").mockRejectedValue(new Error("unavailable"));
    runtime.capabilities.push("agents/1");
    act(() => runtime.connect());
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(result.current.models.map((m) => m.id)).toEqual(["opus"]);
    expect(modelOptionText(result.current.models[0], result.current.models)).toBe("Opus (latest)");
  });
});
