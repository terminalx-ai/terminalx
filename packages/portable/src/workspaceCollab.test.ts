import { describe, expect, it } from "vitest";
import type { RpcWireRequest } from "./rpc";
import { WorkspaceRpcClient, WorkspaceRpcError, type WorkspaceConnectionState, type WorkspaceTransport } from "./workspace";
import { WorkspaceCollab, collabGranted, leaseHeldBy, leaseLive, parseCollabEvent, type CollabEvent } from "./workspaceCollab";

const connected = (capabilities = ["session/1", "collab/1"]): WorkspaceConnectionState => ({
  state: "connected",
  runtimeGeneration: 1,
  runtimeEpoch: "e1",
  runtimeVersion: "0.3.0",
  capabilities,
  authority: "participate",
  you: { userId: "u-me", role: "driver", canApprove: false },
});

type Handler = (params: Record<string, unknown>) => unknown;

class RefusalError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) {
    super(message);
  }
}

/** A runtime answering from handlers; a thrown RefusalError is an RPC refusal. */
class FakeRuntime implements WorkspaceTransport {
  sent: RpcWireRequest[] = [];
  up = true;
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();

  constructor(private handlers: Record<string, Handler>) {}

  send(frame: RpcWireRequest): boolean {
    if (!this.up) return false;
    this.sent.push(frame);
    queueMicrotask(() => {
      try {
        const result = this.handlers[frame.method]?.((frame.params ?? {}) as Record<string, unknown>);
        this.deliver({ id: frame.id, ok: true, result: result ?? {} });
      } catch (error) {
        const refusal = error as RefusalError;
        this.deliver({ id: frame.id, ok: false, error: { code: refusal.code ?? "internal", message: refusal.message, data: refusal.data } });
      }
    });
    return true;
  }
  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  close() {}
  setState(state: WorkspaceConnectionState) {
    for (const listener of this.states) listener(state);
  }
  deliver(message: unknown) {
    for (const listener of this.messages) listener(message);
  }
  calls(method: string) {
    return this.sent.filter((frame) => frame.method === method).map((frame) => frame.params as Record<string, unknown>);
  }
}

function setup(handlers: Record<string, Handler>, capabilities?: string[]) {
  const runtime = new FakeRuntime(handlers);
  const client = new WorkspaceRpcClient(runtime, () => "req-fixed");
  runtime.setState(connected(capabilities));
  let next = 0;
  const collab = new WorkspaceCollab(client, () => `note-req-${++next}`);
  return { runtime, client, collab };
}

describe("collab/1 client", () => {
  it("is available only when the runtime granted collab/1", () => {
    const { collab } = setup({});
    expect(collab.available).toBe(true);
    expect(collabGranted(connected(["session/1"]))).toBe(false);
    expect(collabGranted({ state: "suspended" })).toBe(false);
  });

  it("refuses every collab method, including presence, notes and leases, on a runtime without collab/1", async () => {
    const { collab, runtime } = setup({}, ["session/1"]);
    expect(collab.available).toBe(false);
    for (const call of [
      () => collab.state(),
      () => collab.updatePresence({ tabId: "t-1" }),
      () => collab.listNotes("t-1"),
      () => collab.postNote("t-1", "hi"),
      () => collab.acquireLease("t-1"),
      () => collab.takeOverLease("t-1"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "capability_not_granted" });
    }
    expect(runtime.sent).toHaveLength(0);
  });

  it("reads the state and sends presence updates", async () => {
    const state = {
      you: { userId: "u-me", role: "driver", canApprove: false },
      participants: [{ userId: "u-a", role: "viewer", canApprove: false, surfaces: 2, tabId: "t-1", activity: "typing", since: 5 }],
      leases: [{ tabId: "t-1", holderId: "u-a", acquiredAt: 1, expiresAt: 2 }],
    };
    const { collab, runtime } = setup({ "collab.state": () => state });
    expect(await collab.state()).toEqual(state);
    await collab.updatePresence({ tabId: "t-2", activity: "typing" });
    expect(runtime.calls("presence.update")).toEqual([{ tabId: "t-2", activity: "typing" }]);
  });

  it("posts a note with a clientRequestId kept across a resend, and never sends an empty one", async () => {
    const note = { id: "note_1", tabId: "t-1", authorId: "u-me", text: "looks good", createdAt: 9 };
    const { collab, runtime } = setup({ "notes.post": () => ({ note }), "notes.list": () => ({ notes: [note], more: false }) });
    expect(await collab.postNote("t-1", "  looks good  ")).toEqual(note);
    expect(runtime.calls("notes.post")).toEqual([{ tabId: "t-1", text: "looks good", clientRequestId: "note-req-1" }]);
    await expect(collab.postNote("t-1", "   ")).rejects.toBeInstanceOf(WorkspaceRpcError);
    await expect(collab.postNote("t-1", "x".repeat(4001))).rejects.toBeInstanceOf(WorkspaceRpcError);
    expect(runtime.calls("notes.post")).toHaveLength(1);
    expect(await collab.listNotes("t-1", { limit: 50 })).toEqual({ notes: [note], more: false });
    expect(runtime.calls("notes.list")).toEqual([{ tabId: "t-1", limit: 50 }]);
  });

  it("resends a note whose answer was lost with the same id", async () => {
    const note = { id: "note_1", tabId: "t-1", authorId: "u-me", text: "hi", createdAt: 9 };
    const { collab, runtime } = setup({ "notes.post": () => ({ note }) });
    runtime.up = false;
    const posting = collab.postNote("t-1", "hi");
    runtime.setState({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 10 });
    runtime.up = true;
    runtime.setState(connected());
    expect(await posting).toEqual(note);
    expect(runtime.calls("notes.post").map((params) => params.clientRequestId)).toEqual(["note-req-1"]);
  });

  it("reports who holds a lease when acquiring is refused, and takes over or releases", async () => {
    const held = { tabId: "t-1", holderId: "u-a", acquiredAt: 1, expiresAt: 10 };
    const mine = { tabId: "t-1", holderId: "u-me", acquiredAt: 11, expiresAt: 20 };
    const { collab, runtime } = setup({
      "lease.acquire": () => {
        throw new RefusalError("lease_held", "held", { lease: held });
      },
      "lease.takeOver": () => ({ lease: mine }),
      "lease.release": () => ({}),
    });
    const error = await collab.acquireLease("t-1").catch((e: unknown) => e);
    expect(leaseHeldBy(error)).toEqual(held);
    expect(leaseHeldBy(new Error("other"))).toBeNull();
    expect(await collab.takeOverLease("t-1")).toEqual(mine);
    await collab.releaseLease("t-1");
    expect(runtime.calls("lease.release")).toEqual([{ tabId: "t-1" }]);
    expect(leaseLive(mine, 19)).toBe(true);
    expect(leaseLive(mine, 20)).toBe(false);
    expect(leaseLive(null, 0)).toBe(false);
  });

  it("parses presence, note, lease and role notifications and ignores the rest", () => {
    const { collab, runtime } = setup({});
    const events: CollabEvent[] = [];
    const stop = collab.onEvent((event) => events.push(event));
    const participants = [{ userId: "u-a", role: "viewer", canApprove: false, surfaces: 1, tabId: null, activity: "viewing", since: 1 }];
    runtime.deliver({ event: "collab.presence", params: { participants } });
    runtime.deliver({ event: "notes.posted", params: { note: { id: "note_2", tabId: "t-1", authorId: "u-a", text: "hi", createdAt: 3 } } });
    runtime.deliver({ event: "collab.lease", params: { tabId: "t-1", lease: null } });
    runtime.deliver({ event: "collab.you", params: { you: { userId: "u-me", role: "viewer", canApprove: false } } });
    runtime.deliver({ event: "session.tabs", params: { tabs: [] } });
    runtime.deliver({ event: "notes.posted", params: { note: { text: "malformed" } } });
    stop();
    runtime.deliver({ event: "collab.lease", params: { tabId: "t-2", lease: null } });
    expect(events.map((event) => event.type)).toEqual(["presence", "note", "lease", "you"]);
    expect(events[2]).toEqual({ type: "lease", tabId: "t-1", lease: null });
    expect(parseCollabEvent("collab.you", {})).toBeNull();
  });
});
