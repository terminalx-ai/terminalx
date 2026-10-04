import { vi } from "vitest";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import type { AgentTabInfo, PtyControl, RuntimeAgent, RuntimeSession, WorkspaceConnectionState, WorkspaceTransport } from "@terminalx/portable/workspace";
import type { TerminalInstance } from "@/lib/terminal";

/**
 * A fake workspace runtime behind the real `WorkspaceRpcClient`, for the
 * terminal view of a cloud agent tab (PRO-86). It holds one agent tab's own
 * terminal (`tab:t-1`) and answers the `pty.*` calls with the runtime's rules:
 * a viewer is refused, someone else's lease refuses input, only the
 * controller types and sizes, and nothing is ever started without `start`.
 */
export const AGENT_PTY_CAPABILITIES = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "collab/1", "agent-pty/1"];

export const agentTab = (fields: Partial<AgentTabInfo> = {}): AgentTabInfo => ({
  sessionId: "s-1",
  tabId: "t-1",
  title: "Fix login",
  harness: "claude",
  model: "",
  effort: null,
  permissionMode: "bypassPermissions",
  status: "idle",
  process: "running",
  pendingPermissions: [],
  followUps: [],
  lastSeq: 0,
  created: "2026-09-29T00:00:00Z",
  modified: "2026-09-29T00:00:00Z",
  ...fields,
});

/** Terminal bytes on the wire: base64 of UTF-8. Offsets below are in characters, so tests keep to ASCII. */
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const refusal = (id: string, code: string, data?: unknown) => ({ id, ok: false, error: { code, message: code, ...(data ? { data } : {}) } });

export class FakeAgentRuntime implements WorkspaceTransport {
  up = false;
  sent: RpcWireRequest[] = [];
  capabilities = [...AGENT_PTY_CAPABILITIES];
  agents: RuntimeAgent[] = [{ id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "bypassPermissions" }];
  generation = 3;
  epoch = "e1";
  tabs: AgentTabInfo[] = [agentTab()];
  events: unknown[] = [];
  sessions: RuntimeSession[] = [
    {
      id: "s-1",
      projectPath: "/workspace/api",
      cwd: "/workspace/api",
      branch: "tx/login-fix",
      title: "Fix login redirect",
      created: "2026-09-29T00:00:00Z",
      modified: "2026-09-29T00:00:00Z",
      archived: false,
      pinned: false,
      tabs: [{ id: "t-1", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "" }],
    },
  ];
  /** `collab.state`, on a shared workspace. */
  collab: { you: { userId: string; role: string; canApprove: boolean }; participants: unknown[]; leases: { tabId: string; holderId: string; acquiredAt: number; expiresAt: number }[] } | null = null;
  /** The agent's terminal as the runtime holds it. */
  agent = { control: "none" as PtyControl, controllerId: null as string | null, cols: 120, rows: 30, screen: "agent screen\r\n", running: true };
  /** Input the agent's CLI received, in order. */
  typed: string[] = [];
  /** What a client's terminal emulator said by itself (`report: true`): delivered, never driving. */
  reports: string[] = [];
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();
  private subscription = 0;
  private ptySubscription: string | null = null;
  /** The last numbered write applied per writer: a resend is answered, a gap is refused (`conflict`). */
  private applied = new Map<string, number>();
  /** A numbered write was refused for its number (`conflict`). */
  conflicts = 0;

  /**
   * The workspace stopped and woke: every attachment was revoked, so this
   * desktop is a new device to the runtime, while the app (and its client)
   * stayed open. Call between the `suspended` state and the next `connect`.
   *
   * - `"frozen"`: the runtime process survived the stop (a frozen
   *   container). It counts writes and control per device, so the controller
   *   is "another device" and it knows none of this client's writers.
   * - `"restarted"`: the machine booted cold: a new runtime process, a new
   *   CLI and screen, nobody controlling it.
   */
  wokeAsNewDevice(runtime: "frozen" | "restarted") {
    this.applied.clear();
    if (runtime === "frozen") {
      if (this.agent.control === "you") this.agent.control = "other";
      return;
    }
    this.epoch = `${this.epoch}+`;
    this.agent = { control: "none", controllerId: null, cols: 120, rows: 30, screen: "fresh screen\r\n", running: true };
  }

  send(frame: RpcWireRequest): boolean {
    if (!this.up) return false;
    this.sent.push(frame);
    const answer = this.answer(frame);
    queueMicrotask(() => {
      for (const listener of this.messages) listener(answer);
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
  emit(state: WorkspaceConnectionState) {
    this.up = state.state === "connected";
    for (const listener of this.states) listener(state);
  }
  connect(authority: "manage" | "participate" = "manage") {
    this.emit({
      state: "connected",
      runtimeGeneration: this.generation,
      runtimeEpoch: this.epoch,
      runtimeVersion: "0.3.0",
      capabilities: this.capabilities.filter((capability) => capability !== "collab/1" || !!this.collab),
      authority,
      ...(this.collab ? { you: { ...this.collab.you, listed: true } } : {}),
    } as WorkspaceConnectionState);
  }
  methods(name: string) {
    return this.sent.filter((frame) => frame.method === name);
  }
  params(name: string) {
    return this.methods(name).map((frame) => frame.params as Record<string, unknown>);
  }
  notify(event: string, params: Record<string, unknown>) {
    for (const listener of this.messages) listener({ event, params });
  }
  /** The agent draws: live output on the newest attachment. */
  output(text: string) {
    const offset = this.agent.screen.length;
    this.agent.screen += text;
    if (this.ptySubscription) this.notify("pty.output", { subscriptionId: this.ptySubscription, ptyId: "tab:t-1", offset, data: b64(text) });
  }
  /** Someone else takes or loses the terminal. */
  controlledBy(control: PtyControl, controllerId: string | null) {
    this.agent.control = control;
    this.agent.controllerId = controllerId;
    if (this.ptySubscription) this.notify("pty.control", { subscriptionId: this.ptySubscription, ptyId: "tab:t-1", control, controllerId });
  }
  resizedTo(cols: number, rows: number) {
    this.agent.cols = cols;
    this.agent.rows = rows;
    if (this.ptySubscription) this.notify("pty.resized", { subscriptionId: this.ptySubscription, ptyId: "tab:t-1", cols, rows });
  }

  private describe() {
    return {
      ptyId: "tab:t-1",
      number: 0,
      epoch: this.epoch,
      pid: 7,
      cwd: "",
      cols: this.agent.cols,
      rows: this.agent.rows,
      createdAt: 1,
      offset: this.agent.screen.length,
      exited: false,
      exitCode: null,
      control: this.agent.control,
      controllerId: this.agent.controllerId,
      tabId: "t-1",
      running: this.agent.running,
    };
  }

  /** Why this person's input is refused, as the runtime decides it. */
  private inputRefusal(id: string) {
    const you = this.collab?.you;
    if (you && you.role !== "driver" && you.role !== "manager") return refusal(id, "forbidden");
    if (you && you.role !== "manager" && !you.canApprove) return refusal(id, "forbidden", { needs: "canApprove" });
    const held = this.collab?.leases.find((lease) => lease.tabId === "t-1" && lease.holderId !== you?.userId);
    if (held && you?.role !== "manager") return refusal(id, "lease_held", { lease: held });
    return null;
  }

  private answer(frame: RpcWireRequest) {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const ok = (result: unknown) => ({ id: frame.id, ok: true, result });
    if (frame.method.startsWith("pty.") && String(params.ptyId ?? "").startsWith("tab:")) {
      if (!this.capabilities.includes("agent-pty/1")) return refusal(frame.id, "capability_not_granted");
      if (params.ptyId !== "tab:t-1") return refusal(frame.id, "not_found");
    }
    switch (frame.method) {
      case "session.tabs":
        return ok({ tabs: this.tabs });
      case "session.list":
        return ok({ sessions: this.sessions });
      case "session.subscribe":
        return ok({ subscriptionId: `sub-${++this.subscription}`, events: this.events.map((event, index) => ({ cursor: `${this.generation}:${index + 1}`, event })), cursor: `${this.generation}:${this.events.length}` });
      case "session.nudge":
      case "session.markRead":
      case "session.unsubscribe":
      case "presence.update":
      case "pty.detach":
        return ok({});
      case "collab.state":
        return this.collab ? ok(this.collab) : refusal(frame.id, "method_not_found");
      case "notes.list":
        return ok({ notes: [], more: false });
      case "runtime.agents":
        return ok({ agents: this.agents });
      case "pty.list":
        // An agent's own terminal is never listed as a shell.
        return ok({ epoch: this.epoch, terminals: [] });
      case "git.repositories":
        return ok({ repositories: [] });
      case "pty.attach": {
        this.ptySubscription = `sub-${++this.subscription}`;
        const from = Math.min(Number(params.sinceOffset ?? 0), this.agent.screen.length);
        return ok({ ...this.describe(), subscriptionId: this.ptySubscription, offset: from, end: this.agent.screen.length, data: b64(this.agent.screen.slice(from)), replayEnd: this.agent.screen.length, truncated: false, runtimeGeneration: this.generation });
      }
      case "pty.control": {
        const refused = this.inputRefusal(frame.id);
        if (refused) return refused;
        this.agent.control = "you";
        this.agent.controllerId = this.collab?.you.userId ?? null;
        if (params.cols && params.rows) {
          this.agent.cols = Number(params.cols);
          this.agent.rows = Number(params.rows);
        }
        if (params.start === true && !this.agent.running) {
          this.agent.running = true;
          this.tabs = this.tabs.map((tab) => (tab.tabId === "t-1" ? { ...tab, process: "running" } : tab));
          queueMicrotask(() => this.notify("session.tabs", { tabs: this.tabs }));
        }
        return ok(this.describe());
      }
      case "pty.write": {
        const refused = this.inputRefusal(frame.id);
        if (refused) return refused;
        if (!this.agent.running) return refusal(frame.id, "unavailable");
        if (params.epoch !== undefined && params.epoch !== this.epoch) return refusal(frame.id, "not_found");
        const writer = String(params.writerId ?? "");
        const applied = this.applied.get(writer) ?? 0;
        const seq = Number(params.seq);
        if (seq <= applied) return ok({ applied: false, seq: applied });
        if (seq !== applied + 1) {
          this.conflicts++;
          return refusal(frame.id, "conflict");
        }
        if (this.agent.control !== "you") return refusal(frame.id, "not_controller");
        this.applied.set(writer, seq);
        if (params.report === true) this.reports.push(String(params.data));
        else this.typed.push(String(params.data));
        return ok({ applied: true, seq: params.seq });
      }
      case "pty.resize": {
        const refused = this.inputRefusal(frame.id);
        if (refused) return refused;
        if (this.agent.control !== "you") return refusal(frame.id, "not_controller");
        this.agent.cols = Number(params.cols);
        this.agent.rows = Number(params.rows);
        return ok({ cols: this.agent.cols, rows: this.agent.rows });
      }
      default:
        return refusal(frame.id, "method_not_found");
    }
  }
}

/** An xterm that records what it is told, with the hooks the terminal stores wire. */
export interface FakeXterm extends TerminalInstance {
  /** Everything written to the screen, decoded. */
  screen(): string;
  /** The reader presses keys. */
  type(data: string): void;
  /** The emulator says something by itself: a focus report, the answer to a query. */
  report(data: string): void;
  /** Queries (`ESC[c`, `ESC[6n`) found in output are answered once the output is parsed, as xterm does. */
  answers: boolean;
  /** The view's box changed and this view fits itself to it. */
  fitTo(cols: number, rows: number): void;
}

export function fakeXterm(size: { cols: number; rows: number } = { cols: 100, rows: 40 }): FakeXterm {
  const written: string[] = [];
  const data: ((value: string) => void)[] = [];
  const resized: ((size: { cols: number; rows: number }) => void)[] = [];
  const decoder = new TextDecoder();
  let parsing = Promise.resolve();
  const term = {
    cols: 80,
    rows: 24,
    options: {} as Record<string, unknown>,
    write: (chunk: Uint8Array | string, done?: () => void) => {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
      written.push(text);
      // Like xterm: output is parsed a little later, in order, and the answer
      // to a query in it is emitted then, before the write's callback.
      parsing = parsing.then(() => {
        if (fake.answers && text.includes("\x1b[c")) emit("\x1b[?1;2c");
        if (fake.answers && text.includes("\x1b[6n")) emit("\x1b[1;1R");
        done?.();
      });
    },
    reset: vi.fn(() => void (written.length = 0)),
    onData: (listener: (value: string) => void) => void data.push(listener),
    onBinary: () => undefined,
    onResize: (listener: (size: { cols: number; rows: number }) => void) => void resized.push(listener),
    resize: vi.fn((cols: number, rows: number) => {
      term.cols = cols;
      term.rows = rows;
    }),
    focus: () => undefined,
    dispose: () => undefined,
  };
  const emit = (value: string) => data.forEach((listener) => listener(value));
  const fake = {
    el: document.createElement("div"),
    term,
    fit: { fit: () => undefined, proposeDimensions: () => size },
    answers: true,
    screen: () => written.join(""),
    type: emit,
    report: emit,
    fitTo: (cols: number, rows: number) => {
      term.cols = cols;
      term.rows = rows;
      resized.forEach((listener) => listener({ cols, rows }));
    },
  } as unknown as FakeXterm;
  return fake;
}
