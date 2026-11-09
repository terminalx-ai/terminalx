import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteGit } from "@terminalx/portable/workspaceGit";
import { closeWorkspaceConnections, workspaceConnection } from "./api";
import { cloudGitSource } from "./gitSource";
import { commitRange } from "./changesScope";
import { refreshDataPrivacy, setDataPrivacy } from "./dataPrivacy";

const native = vi.hoisted(() => ({ invoke: vi.fn(), events: new Set<(event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name: string, listener: (event: { payload: unknown }) => void) => {
  native.events.add(listener);
  return () => native.events.delete(listener);
}) }));
const emit = (payload: unknown) => { for (const listener of [...native.events]) listener({ payload }); };
const sha = "a".repeat(40), parent = "b".repeat(40);
const target = { kind: "cloud" as const, organizationId: "org", workspaceId: "review" };
let enabled = false, managed = false, next = 0;
let connections: string[] = [];
let sent: { connectionId: string; method: string }[] = [];

beforeEach(async () => {
  enabled = false; managed = false; next = 0; connections = []; sent = [];
  native.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "data_privacy_status") return { enabled, managed };
    if (command === "data_privacy_set") {
      enabled = args.enabled === true;
      if (enabled) emit({ kind: "identityChanged", connectionIds: connections });
      return { enabled, managed: enabled && managed };
    }
    if (command === "cloud_remote_attach") {
      const connectionId = `connection-${++next}`;
      connections.push(connectionId);
      emit({ kind: "state", connectionId, state: { state: "connected", runtimeGeneration: next, runtimeVersion: "1", capabilities: ["git/1"], authority: "participate" } });
      return connectionId;
    }
    if (command === "cloud_remote_send") {
      const { connectionId, frame } = args as { connectionId: string; frame: { id: string; method: string; params: { from?: string } } };
      sent.push({ connectionId, method: frame.method });
      const result = frame.method === "git.log" ? { commits: frame.params.from === parent
        ? [{ sha: parent, tree: "parent-tree" }]
        : [{ sha, parent, shortSha: sha.slice(0, 7), subject: "Review", tree: "commit-tree" }] } : { files: [] };
      emit({ kind: "message", connectionId, message: { id: frame.id, ok: true, result } });
    }
  });
  await refreshDataPrivacy();
});
afterEach(() => { closeWorkspaceConnections(); native.events.clear(); });

async function source() {
  const connection = await workspaceConnection(target);
  if (!connection) throw new Error("Expected a cloud connection");
  return cloudGitSource({ workspaceKey: "cloud:org:review", remote: new RemoteGit(connection.client, "."), canWrite: false, author: async () => null });
}

it.each([false, true].flatMap((policy) => [false, true].flatMap((restore) => [1, 2].map((pauseAfter) => ({ policy, restore, pauseAfter }))))) (
  "does not renew a commit-scope continuation after policy=$policy restore=$restore reply=$pauseAfter",
  async ({ policy, restore, pauseAfter }) => {
    managed = policy;
    const original = await source();
    let arrived!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { arrived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    // Pause a completed real portable/native-transport reply, not its request.
    const delayed = { ...original, logCommits: async (from: string | null, limit: number) => {
      const result = await original.logCommits(from, limit);
      if (++reads === pauseAfter) { arrived(); await gate; }
      return result;
    } };
    const review = commitRange(delayed, sha).then((range) => original.changesBetween(range.base, range.head));
    const refused = expect(review).rejects.toThrow(/closed|unavailable/);
    await entered;
    expect(sent).toHaveLength(pauseAfter);
    await setDataPrivacy(true);
    if (restore) await setDataPrivacy(false);
    release();
    await refused;
    expect(sent).toHaveLength(pauseAfter);
    expect(connections).toHaveLength(1);
    if (!restore) await setDataPrivacy(false);
    const fresh = await source();
    const range = await commitRange(fresh, sha);
    await expect(fresh.changesBetween(range.base, range.head)).resolves.toEqual([]);
    expect(sent.slice(pauseAfter)).toEqual(["git.log", "git.log", "git.changesBetween"].map((method) => ({ connectionId: "connection-2", method })));
  },
);
