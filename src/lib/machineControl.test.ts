import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineConnectionState } from "@/types/machines";

const store = {
  ready: true,
  machines: [{ machineId: "m1", name: "Mac mini", version: "0.2.30" }],
  states: {} as Record<string, MachineConnectionState>,
  connections: {} as Record<string, unknown>,
  attachErrors: {} as Record<string, string>,
  error: null,
};
const live: { client: unknown } = { client: null };
const reconnect = vi.fn(async (_machineId: string): Promise<void> => undefined);

vi.mock("@/lib/machineConnections", () => ({
  getMachineConnections: () => store,
  isMachineDisconnected: () => false,
  reconnectMachine: (machineId: string) => reconnect(machineId),
  subscribeMachineConnections: () => () => undefined,
}));
vi.mock("@/lib/machineCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/machineCatalog")>()),
  liveMachineClient: () => live.client,
}));

const { answerMachineControl, connectedClient, CONNECT_WITHIN_MS, stateRefusal } = await import("@/lib/machineControl");

const machine = { machineId: "m1", name: "Mac mini" };

/** A clock the test moves: `sleep` advances it instead of waiting. */
function clock() {
  let at = 1_000;
  const slept: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
    slept,
  };
}

beforeEach(() => {
  store.states = {};
  store.connections = {};
  store.attachErrors = {};
  live.client = null;
  reconnect.mockClear();
});

describe("machine control", () => {
  it("gives each state that cannot answer its own code, as native code does", () => {
    const codes = (state: MachineConnectionState) => stateRefusal("Mac mini", state)?.code ?? null;
    expect(codes({ state: "idle" })).toBeNull();
    expect(codes({ state: "connecting", trying: ["lan"] })).toBeNull();
    expect(codes({ state: "direct", route: { kind: "lan", endpoint: "ws://10.0.0.2:6768/machine/1" }, since: 1, rttMs: 4 })).toBeNull();
    expect(codes({ state: "offline", lastSeenAt: null, retryInMs: 10_000 })).toBe("machine_offline");
    expect(codes({ state: "reconnecting", lostAt: 1, attempt: 1, retryInMs: 250, trying: [] })).toBe("machine_offline");
    expect(codes({ state: "needsUpdate", version: "0.2.1", side: "machine" })).toBe("machine_needs_update");
    expect(codes({ state: "updating", version: "0.2.41", since: 1 })).toBe("machine_updating");
    expect(codes({ state: "accessRemoved" })).toBe("machine_access_removed");
    expect(codes({ state: "disconnected" })).toBe("machine_disconnected");
  });

  it("refuses an offline machine at once, without waiting for it", async () => {
    store.states.m1 = { state: "offline", lastSeenAt: null, retryInMs: 10_000 };
    const time = clock();
    await expect(connectedClient(machine, time.sleep, time.now)).rejects.toMatchObject({ code: "machine_offline" });
    expect(time.slept).toEqual([]);
  });

  it("attaches a machine this window does not hold and waits a bounded time for it", async () => {
    const time = clock();
    const client = { connection: { state: "connected" }, hasCapability: () => true };
    store.states.m1 = { state: "connecting", trying: ["lan"] };
    reconnect.mockImplementationOnce(async (_machineId: string) => {
      store.connections.m1 = {};
    });
    const waiting = connectedClient(machine, async (ms) => {
      await time.sleep(ms);
      if (time.slept.length === 3) live.client = client;
    }, time.now);
    await expect(waiting).resolves.toBe(client);
    expect(reconnect).toHaveBeenCalledTimes(1);

    // One that never connects is refused as offline once the bound has passed: never a socket timeout.
    live.client = null;
    const slow = clock();
    await expect(connectedClient(machine, slow.sleep, slow.now)).rejects.toMatchObject({ code: "machine_offline" });
    expect(slow.slept.reduce((sum, ms) => sum + ms, 0)).toBe(CONNECT_WITHIN_MS);
  });

  it("says when the machine's version does not serve a command", async () => {
    live.client = { connection: { state: "connected" }, hasCapability: (capability: string) => capability !== "session/2" };
    const answer = await answerMachineControl("sessions.rename", { machine, session: "s1", title: "New" });
    expect(answer).toMatchObject({ ok: false, error: { code: "machine_unsupported" } });
    if (!answer.ok) expect(answer.error.message).toContain("Mac mini runs TerminalX 0.2.30");
  });

  it("previews a worktree delete whatever its verdict, and refuses the delete itself without --force", async () => {
    const candidate = { projectPath: "/srv/api", path: "/srv/api-wt/fix", name: "fix", branch: "fix", managed: true, verdict: "dirty", reason: "2 files changed", lastActivity: null, sessions: [], token: "t1" };
    const removeCleanup = vi.fn();
    live.client = {
      connection: { state: "connected" },
      hasCapability: () => true,
      machineProjects: async () => [{ projectId: "p1", name: "api", path: "/srv/api", kind: "git", defaultBranch: "main", archived: false }],
      scanCleanup: async () => [{ path: "/srv/api", name: "api", note: null, candidates: [candidate] }],
      removeCleanup,
    };
    const preview = await answerMachineControl("worktrees.delete", { machine, worktree: "fix", dryRun: true });
    expect(preview).toMatchObject({ ok: true, result: { dryRun: true, wouldRemove: false, worktree: { name: "fix", verdict: "dirty" } } });
    expect(await answerMachineControl("worktrees.delete", { machine, worktree: "fix", dryRun: true, force: true })).toMatchObject({ ok: true, result: { wouldRemove: true } });
    expect(await answerMachineControl("worktrees.delete", { machine, worktree: "fix", confirmed: true })).toMatchObject({ ok: false, error: { code: "worktree_not_safe" } });
    expect(removeCleanup).not.toHaveBeenCalled();
  });

  it("answers an unknown command or a missing machine in the CLI's error shape", async () => {
    expect(await answerMachineControl("exec", { machine })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await answerMachineControl("read", { target: "s1" })).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });
});
