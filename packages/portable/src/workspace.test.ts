import { describe, expect, it } from "vitest";
import type { RpcWireRequest } from "./rpc";
import { WorkspaceRpcClient, WorkspaceRpcError, type WorkspaceConnectionState, type WorkspaceTransport } from "./workspace";

const connected = (generation = 7, capabilities = ["pty/1", "fs/1", "git/1", "session/1"]): WorkspaceConnectionState => ({
  state: "connected",
  runtimeGeneration: generation,
  runtimeVersion: "0.2.2",
  capabilities,
  authority: "manage",
});

/** A runtime with the contract's idempotency and seq rules, behind a droppable link. */
class FakeRuntime implements WorkspaceTransport {
  up = false;
  generation = 7;
  sent: RpcWireRequest[] = [];
  /** Requests are received but the answer is lost with the connection. */
  loseAnswers = false;
  output = "";
  writes: string[] = [];
  created = 0;
  private cache = new Map<string, unknown>();
  private applied = 0;
  private subscription = 0;
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();

  send(frame: RpcWireRequest): boolean {
    if (!this.up) return false;
    this.sent.push(frame);
    const answer = this.answer(frame);
    if (!this.loseAnswers) queueMicrotask(() => this.deliver(answer));
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

  connect(capabilities?: string[]) {
    this.up = true;
    this.loseAnswers = false;
    for (const listener of this.states) listener(connected(this.generation, capabilities));
  }
  drop() {
    this.up = false;
    for (const listener of this.states) listener({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 250 });
  }
  deliver(message: unknown) {
    for (const listener of this.messages) listener(message);
  }
  typeOutput(text: string) {
    const offset = this.output.length;
    this.output += text;
    this.deliver({ event: "pty.output", params: { subscriptionId: `sub-${this.subscription}`, ptyId: "p1", offset, data: btoa(text) } });
  }

  private answer(frame: RpcWireRequest) {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const ok = (result: unknown) => ({ id: frame.id, ok: true, result });
    const key = typeof params.clientRequestId === "string" ? params.clientRequestId : null;
    if (key && this.cache.has(key)) return ok(this.cache.get(key));
    switch (frame.method) {
      case "pty.create": {
        this.created++;
        const result = { ptyId: "p1" };
        this.cache.set(key!, result);
        return ok(result);
      }
      case "pty.write": {
        const seq = Number(params.seq);
        if (seq <= this.applied) return ok({ applied: false, seq: this.applied });
        this.applied = seq;
        this.writes.push(String(params.data));
        return ok({ applied: true, seq });
      }
      case "pty.attach": {
        if (params.sinceOffset !== undefined && params.runtimeGeneration !== this.generation) {
          return { id: frame.id, ok: false, error: { code: "cursor_expired", message: "other generation" } };
        }
        const from = Number(params.sinceOffset ?? 0);
        this.subscription++;
        return ok({ subscriptionId: `sub-${this.subscription}`, offset: from, data: btoa(this.output.slice(from)), truncated: false, exited: false });
      }
      default:
        return { id: frame.id, ok: false, error: { code: "method_not_found", message: frame.method } };
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let counter = 0;
const ids = () => `req-${++counter}`;

describe("workspace RPC client", () => {
  it("resends a mutation with the same clientRequestId after a drop, so it runs once", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.loseAnswers = true;
    const created = client.mutate("pty.create", { cols: 80, rows: 24 });
    await settle();
    runtime.drop();
    runtime.connect();
    await expect(created).resolves.toEqual({ ptyId: "p1" });
    const creates = runtime.sent.filter((frame) => frame.method === "pty.create");
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((frame) => (frame.params as { clientRequestId: string }).clientRequestId)).size).toBe(1);
    expect(runtime.created).toBe(1);
    client.close();
  });

  it("numbers terminal writes so a resend is not typed twice", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.loseAnswers = true;
    const write = client.write("p1", "ls\n");
    await settle();
    runtime.drop();
    runtime.connect();
    await expect(write).resolves.toBe(false);
    expect(runtime.writes).toEqual(["ls\n"]);
    await expect(client.write("p1", "pwd\n")).resolves.toBe(true);
    expect(runtime.writes).toEqual(["ls\n", "pwd\n"]);
    client.close();
  });

  it("resumes a terminal from the last byte after a reconnect and resyncs after a new generation", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.output = "hello ";
    let seen = "";
    await client.attachPty("p1", (bytes) => {
      seen += new TextDecoder().decode(bytes);
    });
    runtime.typeOutput("world");
    runtime.drop();
    runtime.output += "!";
    runtime.connect();
    await settle();
    await settle();
    const attaches = runtime.sent.filter((frame) => frame.method === "pty.attach");
    expect(attaches[1]!.params).toEqual({ ptyId: "p1", sinceOffset: 11, runtimeGeneration: 7 });
    expect(seen).toBe("hello world!");

    runtime.drop();
    runtime.generation = 8;
    runtime.connect();
    await settle();
    await settle();
    const [stale, resync] = runtime.sent.filter((frame) => frame.method === "pty.attach").slice(-2);
    expect(stale!.params).toEqual({ ptyId: "p1", sinceOffset: 12, runtimeGeneration: 7 });
    expect(resync!.params).toEqual({ ptyId: "p1" });
    client.close();
  });

  it("refuses methods whose namespace the runtime did not grant, and surfaces refusals as codes", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect(["fs/1"]);
    await expect(client.call("pty.attach", { ptyId: "p1" })).rejects.toMatchObject({ code: "capability_not_granted" });
    await expect(client.call("fs.list", {})).rejects.toBeInstanceOf(WorkspaceRpcError);
    await expect(client.call("fs.list", {})).rejects.toMatchObject({ code: "method_not_found" });
    client.close();
  });
  it("keeps a subscription made while disconnected and starts it on connect", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    const stop = await client.attachPty("p1", () => undefined);
    expect(runtime.sent).toHaveLength(0);
    runtime.connect();
    await settle();
    expect(runtime.sent.map((frame) => frame.method)).toEqual(["pty.attach"]);
    stop();
    client.close();
  });
});
