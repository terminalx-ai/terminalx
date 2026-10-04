import { describe, expect, it } from "vitest";
import type { RpcWireRequest } from "./rpc";
import {
  METHOD_CAPABILITIES,
  MUTATING_METHODS,
  WORKSPACE_CAPABILITIES,
  WorkspaceRpcClient,
  WorkspaceRpcError,
  agentPtyId,
  type RuntimeSession,
  type WorkspaceConnectionState,
  type WorkspaceTransport,
} from "./workspace";
// The runtime's side of the contract, read as text so the two cannot drift.
import protocolSource from "../../../src-tauri/src/remote/protocol.rs?raw";

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
  agentEvents: { seq: number; id: string }[] = [];
  sessions: RuntimeSession[] = [session("s1", "Fix login")];
  updates = 0;
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
  /**
   * The workspace stopped and woke: this client is a new device now. A
   * runtime that counts writes per device (before it kept a writer's count
   * across devices of one installation) knows none of its writers any more.
   */
  newDevice() {
    this.applied.clear();
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
      case "session.subscribe": {
        this.subscription++;
        const since = typeof params.sinceCursor === "string" ? Number(params.sinceCursor.split(":")[1]) : 0;
        if (typeof params.sinceCursor === "string" && !params.sinceCursor.startsWith(`${this.generation}:`)) {
          return { id: frame.id, ok: false, error: { code: "cursor_expired", message: "other generation" } };
        }
        const events = this.agentEvents.filter((event) => event.seq > since).map((event) => ({ cursor: `${this.generation}:${event.seq}`, event }));
        return ok({ subscriptionId: `sub-${this.subscription}`, events, cursor: `${this.generation}:${this.agentEvents.at(-1)?.seq ?? since}` });
      }
      case "session.tabs":
        return ok({ tabs: [{ sessionId: "s1", tabId: "t1", status: "idle", process: "running" }] });
      case "session.configure": {
        const result = { tab: { sessionId: params.sessionId, tabId: params.tabId, model: params.model } };
        this.cache.set(key!, result);
        return ok(result);
      }
      case "session.nudge":
        return ok({});
      case "session.list":
        return ok({ sessions: this.sessions });
      case "session.update": {
        const session = this.sessions.find((entry) => entry.id === params.sessionId);
        if (!session) return { id: frame.id, ok: false, error: { code: "not_found", message: "no such session" } };
        this.updates++;
        Object.assign(session, Object.fromEntries(["title", "pinned", "archived"].filter((field) => field in params).map((field) => [field, params[field]])));
        const result = { session: { ...session } };
        this.cache.set(key!, result);
        return ok(result);
      }
      case "session.addTab": {
        const result = { sessionId: params.sessionId, tabId: "t2", session: this.sessions[0], tab: null };
        this.cache.set(key!, result);
        return ok(result);
      }
      case "session.delete": {
        this.sessions = this.sessions.filter((entry) => entry.id !== params.sessionId);
        const result = { sessionId: params.sessionId, deleted: [params.sessionId] };
        this.cache.set(key!, result);
        return ok(result);
      }
      case "runtime.agents":
        return ok({ agents: [{ id: "claude", name: "Claude Code", caps: { effort: true }, models: [{ id: "opus", label: "Opus 5.5", efforts: ["high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null }], modes: ["plan", "bypassPermissions"], defaultMode: "bypassPermissions" }] });
      case "pty.list":
        return ok({ epoch: this.epoch, terminals: [{ ptyId: "p1", epoch: this.epoch, sessionId: "s1" }, { ptyId: "p2", epoch: this.epoch }] });
      default:
        return { id: frame.id, ok: false, error: { code: "method_not_found", message: frame.method } };
    }
  }
}

function session(id: string, title: string): RuntimeSession {
  return { id, projectPath: "/workspace", cwd: "/workspace", title, created: "", modified: "", archived: false, pinned: false, tabs: [] };
}

const SESSION_1 = ["pty/1", "fs/1", "git/1", "session/1", "keys/1", "lifecycle/1"];

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

  it("types again after it became a new device to a runtime that counts writes per device", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    await client.write("p1", "one\n");
    await client.write("p1", "two\n");
    // Stop and wake: the same client object, a new device on the runtime.
    runtime.drop();
    runtime.newDevice();
    runtime.connect();
    // The first key after the wake was refused, not applied: it is typed once, under a new writer.
    await expect(client.write("p1", "three\n")).resolves.toBeUndefined();
    await client.write("p1", "four\n");
    expect(runtime.writes).toEqual(["one\n", "two\n", "three\n", "four\n"]);
    const writes = runtime.sent.filter((frame) => frame.method === "pty.write").map((frame) => frame.params as { seq: number; writerId: string });
    expect(writes.map((write) => write.seq)).toEqual([1, 2, 3, 1, 2]);
    expect(writes[3]!.writerId).not.toBe(writes[0]!.writerId);
    expect(writes[4]!.writerId).toBe(writes[3]!.writerId);
    client.close();
  });

  it("never types twice what may have landed before it became a new device", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    await client.write("p1", "one\n");
    // Sent, applied, and its answer lost with the connection; then the wake.
    runtime.loseAnswers = true;
    const doubtful = client.write("p1", "rm -rf build\n");
    await settle();
    runtime.drop();
    runtime.newDevice();
    runtime.connect();
    await expect(doubtful).rejects.toMatchObject({ code: "conflict" });
    expect(runtime.writes).toEqual(["one\n", "rm -rf build\n"]);
    // It was reported, and what is typed next goes through.
    await client.write("p1", "ls\n");
    expect(runtime.writes).toEqual(["one\n", "rm -rf build\n", "ls\n"]);
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

  it("resumes an agent tab from a kept cursor, reports cursors and status, and starts over for a new generation", async () => {
    const runtime = new FakeRuntime();
    runtime.agentEvents = [1, 2, 3].map((seq) => ({ seq, id: `e${seq}` }));
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    const seen: number[] = [];
    const cursors: (string | undefined)[] = [];
    const statuses: string[] = [];
    await client.subscribeSession("s1", "t1", (event) => seen.push((event as { seq: number }).seq), {
      sinceCursor: "7:2",
      onCursor: (cursor) => cursors.push(cursor),
      // The process is not part of a status change; it comes with `session.tabs`.
      onStatus: (change) => statuses.push(`${change.status}/${change.process ?? "-"}`),
    });
    expect(seen).toEqual([3]);
    expect(runtime.sent[0]!.params).toMatchObject({ sessionId: "s1", tabId: "t1", sinceCursor: "7:2" });
    runtime.deliver({ event: "session.event", params: { subscriptionId: "sub-1", cursor: "7:4", event: { seq: 4 } } });
    runtime.deliver({ event: "session.status", params: { subscriptionId: "sub-1", sessionId: "s1", tabId: "t1", status: "in_progress" } });
    expect(seen).toEqual([3, 4]);
    expect(cursors.at(-1)).toBe("7:4");
    expect(statuses).toEqual(["in_progress/-"]);
    // A runtime of another generation cannot resume the cursor: a full replay follows.
    runtime.drop();
    runtime.generation = 8;
    runtime.connect();
    await settle();
    await settle();
    expect(seen).toEqual([3, 4, 1, 2, 3]);
    expect(cursors).toContain(undefined);
    client.close();
  });

  it("lists and configures agent tabs, gives configure a stable request id, and hands broadcasts to listeners", async () => {
    const runtime = new FakeRuntime();
    const client = new WorkspaceRpcClient(runtime, ids);
    runtime.connect();
    const broadcasts: string[] = [];
    client.onNotification((notification) => broadcasts.push(notification.event));
    expect(await client.listAgentTabs()).toEqual([{ sessionId: "s1", tabId: "t1", status: "idle", process: "running" }]);
    const tab = await client.configureAgentTab({ sessionId: "s1", tabId: "t1", model: "opus" });
    expect(tab).toMatchObject({ model: "opus" });
    const configure = runtime.sent.find((frame) => frame.method === "session.configure")!;
    expect(typeof (configure.params as Record<string, unknown>).clientRequestId).toBe("string");
    await client.nudgeMailbox();
    runtime.deliver({ event: "session.tabs", params: { tabs: [] } });
    expect(broadcasts).toEqual(["session.tabs"]);
    client.close();
  });

  describe("CS-12: agents/1, session/2 and pty/2", () => {
    it("asks for the same namespace versions the runtime serves, and gates each addition by its own version", () => {
      const served = /pub const CAPABILITIES: \[&str; \d+\] =\s*\[([^\]]*)\]/.exec(protocolSource)?.[1];
      expect(served?.match(/"[^"]+"/g)?.map((entry) => JSON.parse(entry))).toEqual([...WORKSPACE_CAPABILITIES]);
      const methods = [...protocolSource.matchAll(/method\("([^"]+)", "([^"]+)", (Manage|Participate), (true|false)\)/g)].map(([, name, capability, authority, idempotent]) => ({
        name: name!,
        capability: capability!,
        authority,
        idempotent: idempotent === "true",
      }));
      for (const method of methods) {
        const [namespace, version] = method.capability.split("/");
        // Anything beyond "<own namespace>/1" must be named here, or an older runtime would be sent it.
        if (namespace !== method.name.split(".")[0] || version !== "1") expect(METHOD_CAPABILITIES[method.name], method.name).toBe(method.capability);
      }
      for (const [name, capability] of Object.entries(METHOD_CAPABILITIES)) {
        expect(methods.find((method) => method.name === name)?.capability, name).toBe(capability);
      }
      for (const name of ["session.update", "session.addTab", "session.delete"]) {
        const method = methods.find((entry) => entry.name === name)!;
        expect(method).toMatchObject({ authority: "Manage", idempotent: true });
        expect(MUTATING_METHODS.has(name), name).toBe(true);
      }
    });

    it("a session/1 runtime is never sent a session/2, pty/2 or agents/1 call", async () => {
      const runtime = new FakeRuntime();
      const client = new WorkspaceRpcClient(runtime, ids);
      runtime.connect(SESSION_1);
      expect(client.hasCapability("session/2")).toBe(false);
      expect(client.hasCapability("session/1")).toBe(true);
      await expect(client.updateSession("s1", { title: "x" })).rejects.toMatchObject({ code: "capability_not_granted" });
      await expect(client.addSessionTab("s1", { agent: "claude" })).rejects.toMatchObject({ code: "capability_not_granted" });
      await expect(client.deleteSession("s1")).rejects.toMatchObject({ code: "capability_not_granted" });
      await expect(client.listRuntimeAgents()).rejects.toMatchObject({ code: "capability_not_granted" });
      await expect(client.createPty({ cols: 80, rows: 24, sessionId: "s1" })).rejects.toMatchObject({ code: "capability_not_granted" });
      expect(runtime.sent.map((frame) => frame.method)).toEqual([]);
      // What session/1 had still works.
      expect((await client.listSessions()).map((entry) => entry.id)).toEqual(["s1"]);
      await client.createPty({ cols: 80, rows: 24 });
      expect((runtime.sent.at(-1)!.params as Record<string, unknown>).sessionId).toBeUndefined();
      client.close();
    });

    it("updates, adds tabs to and deletes sessions once each, and hands on the session list", async () => {
      const runtime = new FakeRuntime();
      const client = new WorkspaceRpcClient(runtime, ids);
      runtime.connect([...WORKSPACE_CAPABILITIES]);
      const lists: string[][] = [];
      client.onSessions((sessions) => lists.push(sessions.map((entry) => entry.title)));

      runtime.loseAnswers = true;
      const updating = client.updateSession("s1", { title: "Fix the login", pinned: true, archived: undefined });
      await settle();
      runtime.drop();
      runtime.connect([...WORKSPACE_CAPABILITIES]);
      const updated = await updating;
      expect(updated).toMatchObject({ title: "Fix the login", pinned: true, archived: false });
      const sends = runtime.sent.filter((frame) => frame.method === "session.update");
      expect(sends).toHaveLength(2);
      expect((sends[0]!.params as Record<string, unknown>).clientRequestId).toBe((sends[1]!.params as Record<string, unknown>).clientRequestId);
      expect("archived" in (sends[0]!.params as Record<string, unknown>)).toBe(false);
      expect(runtime.updates).toBe(1);

      expect(await client.addSessionTab("s1", { agent: "codex", model: "", effort: null, mode: "plan" })).toMatchObject({ tabId: "t2" });
      const add = runtime.sent.find((frame) => frame.method === "session.addTab")!.params as Record<string, unknown>;
      expect(add).toMatchObject({ sessionId: "s1", agent: "codex", mode: "plan" });
      expect("model" in add || "effort" in add).toBe(false);

      expect(await client.deleteSession("s1", { removeWorktree: true })).toEqual({ sessionId: "s1", deleted: ["s1"] });
      expect(runtime.sent.find((frame) => frame.method === "session.delete")!.params).toMatchObject({ sessionId: "s1", removeWorktree: true });

      runtime.deliver({ event: "session.sessions", params: { sessions: [session("s2", "Other")] } });
      expect(lists).toEqual([["Other"]]);
      client.close();
    });

    it("lists runtime agents and the session a terminal was opened for", async () => {
      const runtime = new FakeRuntime();
      const client = new WorkspaceRpcClient(runtime, ids);
      runtime.connect([...WORKSPACE_CAPABILITIES]);
      const [agent] = await client.listRuntimeAgents();
      expect(agent).toMatchObject({ id: "claude", defaultMode: "bypassPermissions" });
      expect(agent!.models[0]).toMatchObject({ id: "opus", efforts: ["high"] });
      await client.createPty({ cols: 80, rows: 24, sessionId: "s1" });
      expect(runtime.sent.find((frame) => frame.method === "pty.create")!.params).toMatchObject({ sessionId: "s1" });
      const listed = await client.listPtys();
      expect(listed.terminals.map((terminal) => terminal.sessionId)).toEqual(["s1", undefined]);
      client.close();
    });
  });

  describe("PRO-86: agent-pty/1", () => {
    it("addresses an agent tab's terminal by its tab, and asks for a start only when told to", async () => {
      expect(agentPtyId("t1")).toBe("tab:t1");
      const runtime = new FakeRuntime();
      const client = new WorkspaceRpcClient(runtime, ids);
      runtime.connect(["pty/1", "session/1"]);
      // An older runtime: the capability says so before anything is sent.
      expect(client.hasCapability("agent-pty/1")).toBe(false);
      runtime.drop();
      runtime.connect([...WORKSPACE_CAPABILITIES]);
      expect(client.hasCapability("agent-pty/1")).toBe(true);
      await client.controlPty(agentPtyId("t1"), 100, 40).catch(() => undefined);
      await client.controlPty(agentPtyId("t1"), 100, 40, { start: true }).catch(() => undefined);
      const controls = runtime.sent.filter((frame) => frame.method === "pty.control").map((frame) => frame.params);
      expect(controls).toEqual([
        { ptyId: "tab:t1", cols: 100, rows: 40 },
        { ptyId: "tab:t1", cols: 100, rows: 40, start: true },
      ]);
      // It adds no method: the terminal calls are the shells'.
      expect(protocolSource).not.toMatch(/method\("[^"]+", "agent-pty\/1"/);
      client.close();
    });
  });
});
