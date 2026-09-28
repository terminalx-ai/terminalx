import { describe, expect, it } from "vitest";
import type { RpcWireRequest } from "./rpc";
import { WorkspaceRpcClient, WorkspaceRpcError, type WorkspaceConnectionState, type WorkspaceTransport } from "./workspace";

const connected = (generation = 7, capabilities = ["pty/1", "fs/1", "git/1", "session/1"], epoch = "e1"): WorkspaceConnectionState => ({
  state: "connected",
  runtimeGeneration: generation,
  runtimeEpoch: epoch,
  runtimeVersion: "0.2.2",
  capabilities,
  authority: "manage",
});

/** A runtime with the contract's idempotency and seq rules, behind a droppable link. */
class FakeRuntime implements WorkspaceTransport {
  up = false;
  generation = 7;
  epoch = "e1";
  /** Answer the next pty.write with this error code instead. */
  refuseWrite: string | null = null;
  sent: RpcWireRequest[] = [];
  /** Requests are received but the answer is lost with the connection. */
  loseAnswers = false;
  output = "";
  writes: string[] = [];
  created = 0;
  private cache = new Map<string, unknown>();
  private applied = new Map<string, number>();
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
    for (const listener of this.states) listener(connected(this.generation, capabilities, this.epoch));
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
        const result = { ptyId: "p1", epoch: this.epoch };
        this.cache.set(key!, result);
        return ok(result);
      }
      case "pty.write": {
        const seq = Number(params.seq);
        const writer = String(params.writerId);
        const applied = this.applied.get(writer) ?? 0;
        if (params.epoch !== undefined && params.epoch !== this.epoch) return { id: frame.id, ok: false, error: { code: "not_found", message: "old epoch" } };
        if (seq <= applied) return ok({ applied: false, seq: applied });
        if (seq !== applied + 1) return { id: frame.id, ok: false, error: { code: "conflict", message: `expected ${applied + 1}` } };
        if (this.refuseWrite) {
          const code = this.refuseWrite;
          this.refuseWrite = null;
          return { id: frame.id, ok: false, error: { code, message: code } };
        }
        this.applied.set(writer, seq);
        this.writes.push(String(params.data));
        return ok({ applied: true, seq });
      }
      case "pty.attach": {
        if (params.sinceOffset !== undefined && (params.runtimeGeneration !== this.generation || params.epoch !== this.epoch)) {
          return { id: frame.id, ok: false, error: { code: "cursor_expired", message: "other generation" } };
        }
        const from = Number(params.sinceOffset ?? 0);
        this.subscription++;
        return ok({
          subscriptionId: `sub-${this.subscription}`,
          epoch: this.epoch,
          offset: from,
          data: btoa(this.output.slice(from)),
          truncated: false,
          exited: false,
          control: "you",
          cols: 80,
          rows: 24,
        });
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
    await expect(created).resolves.toEqual({ ptyId: "p1", epoch: "e1" });
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
    await expect(write).resolves.toBeUndefined();
    expect(runtime.writes).toEqual(["ls\n"]);
    await client.write("p1", "pwd\n");
    expect(runtime.writes).toEqual(["ls\n", "pwd\n"]);
    client.close();
  });

  it("sends input one write at a time, in order, batching what was typed meanwhile", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    await Promise.all(["e", "c", "h", "o"].map((key) => client.write("p1", key)));
    expect(runtime.writes).toEqual(["e", "cho"]);
    const seqs = runtime.sent.filter((frame) => frame.method === "pty.write").map((frame) => (frame.params as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
    client.close();
  });

  it("reports refused input instead of dropping it, and retries backpressure with the same seq", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.refuseWrite = "not_controller";
    await expect(client.write("p1", "rm -rf build\n")).rejects.toMatchObject({ code: "not_controller" });
    expect(runtime.writes).toEqual([]);
    runtime.refuseWrite = "backpressure";
    await client.write("p1", "q");
    expect(runtime.writes).toEqual(["q"]);
    const seqs = runtime.sent.filter((frame) => frame.method === "pty.write").map((frame) => (frame.params as { seq: number }).seq);
    expect(seqs).toEqual([1, 1, 1], "a refusal does not spend the seq");
    client.close();
  });

  it("resumes a terminal from the last byte after a reconnect, also across a new generation of the same runtime", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.output = "hello ";
    let seen = "";
    await client.attachPty("p1", {
      onData: (bytes) => {
        seen += new TextDecoder().decode(bytes);
      },
    });
    runtime.typeOutput("world");
    runtime.drop();
    runtime.output += "!";
    runtime.connect();
    await settle();
    await settle();
    const attaches = runtime.sent.filter((frame) => frame.method === "pty.attach");
    expect(attaches[1]!.params).toEqual({ ptyId: "p1", sinceOffset: 11, runtimeGeneration: 7, epoch: "e1" });
    expect(seen).toBe("hello world!");

    // The relay re-registered at a newer generation; the process (and its
    // terminals) are the same, so output resumes without a replay.
    runtime.drop();
    runtime.generation = 8;
    runtime.connect();
    await settle();
    await settle();
    expect(runtime.sent.filter((frame) => frame.method === "pty.attach").at(-1)!.params).toEqual({
      ptyId: "p1",
      sinceOffset: 12,
      runtimeGeneration: 8,
      epoch: "e1",
    });
    expect(seen).toBe("hello world!");
    client.close();
  });

  it("resumes from a kept cursor, and again from the last byte when the runtime says the link lagged", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.output = "old output|";
    let seen = "";
    const attachment = await client.attachPty("p1", {
      since: { offset: 11, epoch: "e1" },
      onData: (bytes) => {
        seen += new TextDecoder().decode(bytes);
      },
    });
    expect(runtime.sent.at(-1)!.params).toEqual({ ptyId: "p1", sinceOffset: 11, runtimeGeneration: 7, epoch: "e1" });
    runtime.output += "missed";
    runtime.deliver({ event: "pty.lagged", params: { subscriptionId: "sub-1", ptyId: "p1", offset: 11 } });
    await settle();
    await settle();
    expect(runtime.sent.at(-1)!.params).toEqual({ ptyId: "p1", sinceOffset: 11, runtimeGeneration: 7, epoch: "e1" });
    expect(seen).toBe("missed");
    expect(attachment.cursor()).toEqual({ offset: 17, epoch: "e1" });
    client.close();
  });

  it("keeps output that arrives before its subscription's answer has been handled", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.output = "first|";
    let seen = "";
    const originalSend = runtime.send.bind(runtime);
    runtime.send = (frame) => {
      const sent = originalSend(frame);
      // The rest of a long replay, queued right behind the answer.
      if (frame.method === "pty.attach") runtime.deliver({ event: "pty.output", params: { subscriptionId: "sub-1", ptyId: "p1", offset: 6, data: btoa("rest") } });
      return sent;
    };
    await client.attachPty("p1", { onData: (bytes) => (seen += new TextDecoder().decode(bytes)) });
    await settle();
    expect(seen).toBe("first|rest");
    client.close();
  });

  it("reports a terminal closed elsewhere and does not resume it", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    const gone: string[] = [];
    await client.attachPty("p1", { onData: () => undefined, onGone: (reason) => gone.push(reason) });
    runtime.deliver({ event: "pty.closed", params: { subscriptionId: "sub-1", ptyId: "p1" } });
    expect(gone).toEqual(["closed"]);
    runtime.drop();
    runtime.connect();
    await settle();
    expect(runtime.sent.filter((frame) => frame.method === "pty.attach")).toHaveLength(1);
    client.close();
  });

  it("keeps trying to resume a lagged stream while the link is up", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids, 20);
    runtime.connect();
    let seen = "";
    await client.attachPty("p1", { onData: (bytes) => (seen += new TextDecoder().decode(bytes)) });
    runtime.loseAnswers = true;
    runtime.deliver({ event: "pty.lagged", params: { subscriptionId: "sub-1", ptyId: "p1", offset: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    runtime.loseAnswers = false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(runtime.sent.filter((frame) => frame.method === "pty.attach").length).toBeGreaterThanOrEqual(3);
    runtime.typeOutput("back");
    expect(seen).toBe("back");
    client.close();
  });

  it("never re-attaches or types into a terminal whose runtime restarted", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    const gone: string[] = [];
    await client.attachPty("p1", { onData: () => undefined, onGone: (reason) => gone.push(reason) });
    runtime.drop();
    const typed = client.write("p1", "make deploy\n");
    runtime.epoch = "e2";
    runtime.connect();
    await settle();
    await expect(typed).rejects.toMatchObject({ code: "not_found" });
    expect(gone).toEqual(["runtime-restarted"]);
    expect(runtime.sent.filter((frame) => frame.method === "pty.attach")).toHaveLength(1);
    expect(runtime.writes).toEqual([]);
    client.close();
  });

  it("fails input at once while the workspace is suspended rather than holding it", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    runtime.up = false;
    for (const listener of (runtime as unknown as { states: Set<(state: WorkspaceConnectionState) => void> }).states) listener({ state: "suspended" });
    await expect(client.write("p1", "x")).rejects.toThrow(/suspended/);
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
    const attachment = await client.attachPty("p1", { onData: () => undefined });
    expect(runtime.sent).toHaveLength(0);
    runtime.connect();
    await settle();
    expect(runtime.sent.map((frame) => frame.method)).toEqual(["pty.attach"]);
    attachment.detach();
    client.close();
  });
});
