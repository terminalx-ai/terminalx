import { describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "@terminalx/portable/workspace";

vi.mock("@/lib/api", () => ({ fs: {}, api: {} }));

const { cloudFileSource } = await import("./workspaceFiles");

const connected: WorkspaceConnectionState = {
  state: "connected",
  runtimeGeneration: 1,
  runtimeEpoch: "e1",
  runtimeVersion: "0.3.0",
  capabilities: ["fs/1", "git/1"],
  authority: "manage",
};

/** A runtime answering `git.*` from `answer`; a thrown `{ code }` is a refusal. */
function client(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const messages = new Set<(message: unknown) => void>();
  const states = new Set<(state: WorkspaceConnectionState) => void>();
  const transport: WorkspaceTransport = {
    send(frame) {
      queueMicrotask(() => {
        try {
          const result = answer(frame.method, (frame.params ?? {}) as Record<string, unknown>);
          for (const listener of messages) listener({ id: frame.id, ok: true, result });
        } catch (error) {
          for (const listener of messages) listener({ id: frame.id, ok: false, error: { code: (error as { code: string }).code, message: "refused" } });
        }
      });
      return true;
    },
    onMessage: (listener) => (messages.add(listener), () => messages.delete(listener)),
    onState: (listener) => (states.add(listener), () => states.delete(listener)),
    close() {},
  };
  const rpc = new WorkspaceRpcClient(transport);
  for (const listener of states) listener(connected);
  return rpc;
}

const file = (path: string) => ({ path, index: " ", worktree: "M" });

describe("Git badges of a cloud workspace's file tree", () => {
  it("puts a lone clone's paths under its directory", async () => {
    const source = cloudFileSource("cloud:o:w", client(() => ({ repository: true, repo: "app", files: [file("src/main.ts")] })), false);
    expect(await source.changes!()).toEqual([{ path: "app/src/main.ts", status: "modified" }]);
  });

  it("reads each of several repositories under its own directory", async () => {
    const source = cloudFileSource(
      "cloud:o:w",
      client((method, params) => {
        if (method === "git.repositories") return { repositories: [{ repo: "app" }, { repo: "libs/core" }] };
        if (!params.repo) throw { code: "ambiguous_repository" };
        return { repository: true, repo: params.repo, files: [file("a.ts")] };
      }),
      false,
    );
    expect(await source.changes!()).toEqual([
      { path: "app/a.ts", status: "modified" },
      { path: "libs/core/a.ts", status: "modified" },
    ]);
  });
});
