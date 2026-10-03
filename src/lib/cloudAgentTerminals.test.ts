// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { FakeAgentRuntime, fakeXterm, type FakeXterm } from "@/test/fakeAgentRuntime";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const {
  agentTerminalId,
  agentTerminalOf,
  attachAgentTerminal,
  cloudTerminalFactory,
  cloudTerminalsOf,
  isMouseReport,
  isTerminalReport,
  quietCloudTerminals,
  detachAgentTerminal,
  dropCloudTerminals,
  ensureAgentTerminal,
  resetCloudTerminals,
  setCloudTerminalInputGate,
  syncCloudTerminals,
  takeControl,
  typeIntoCloudTerminal,
} = await import("./cloudTerminals");
const { cloudReadOnlyReason, cloudSessionBackend, localSessionBackend, resetCloudWakes, terminalViewOf, TERMINAL_VIEW_NO_TERMINAL, TERMINAL_VIEW_OLD_RUNTIME } = await import("./sessionBackend");
const { enterTerminalView, resetTabViews, tabViewOf, toggleTabView } = await import("./tabViews");
const { getInstance } = await import("./terminal");

const WS = "cloud:org-1:ws-1";
const ID = agentTerminalId(WS, "t-1");

let runtime: FakeAgentRuntime;
let client: WorkspaceRpcClient;
let xterm: FakeXterm;
const base = () => xterm;
/** Let the fake runtime's answers (delivered in microtasks) land. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

beforeEach(() => {
  resetCloudTerminals();
  resetCloudWakes();
  resetTabViews();
  runtime = new FakeAgentRuntime();
  client = new WorkspaceRpcClient(runtime);
  xterm = fakeXterm();
  runtime.connect();
});

afterEach(() => client.close());

describe("an agent tab's own terminal in the cloud terminal store", () => {
  it("exists before the runtime is asked anything, and is never a shell tab", () => {
    const terminal = ensureAgentTerminal(WS, "t-1");
    expect(terminal).toMatchObject({ id: ID, ptyId: "tab:t-1", tabId: "t-1", control: "none", live: false });
    expect(ensureAgentTerminal(WS, "t-1")).toBe(terminal);
    expect(cloudTerminalsOf(WS).terminals).toEqual([]);
    expect(runtime.sent).toEqual([]);
  });

  it("attaches with a replay of the agent's screen, starting and taking nothing", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    expect(runtime.params("pty.attach")).toEqual([{ ptyId: "tab:t-1" }]);
    expect(xterm.screen()).toBe("agent screen\r\n");
    expect(agentTerminalOf(WS, "t-1")).toMatchObject({ live: true, control: "none", cols: 120, rows: 30 });
    // Looking is only an attach: no control, no input, no size, no new terminal.
    expect(runtime.sent.map((frame) => frame.method)).toEqual(["pty.attach"]);
    runtime.output("more\r\n");
    expect(xterm.screen()).toBe("agent screen\r\nmore\r\n");
  });

  it("keeps the view across leaving and coming back, and resumes after the last byte instead of replaying", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    detachAgentTerminal(WS, "t-1");
    await settle();
    expect(runtime.methods("pty.detach")).toHaveLength(1);
    expect(agentTerminalOf(WS, "t-1")?.live).toBe(false);
    // The agent kept working while nobody watched.
    runtime.agent.screen += "while away\r\n";
    await attachAgentTerminal(WS, client, "t-1", base);
    expect(runtime.params("pty.attach")[1]).toMatchObject({ ptyId: "tab:t-1", sinceOffset: "agent screen\r\n".length, epoch: "e1" });
    expect(xterm.screen()).toBe("agent screen\r\nwhile away\r\n");
    expect(xterm.term.reset).not.toHaveBeenCalled();
  });

  it("is untouched by the shell terminal list: never marked closed, never listed", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    await syncCloudTerminals(WS, client, base);
    expect(cloudTerminalsOf(WS).terminals).toEqual([]);
    expect(agentTerminalOf(WS, "t-1")).toMatchObject({ gone: null, live: true });
  });

  it("types through pty.write on the workspace connection, in order, and only after its gate allows", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    await takeControl(WS, client, ID, { cols: 100, rows: 40 });
    expect(runtime.params("pty.control")).toEqual([{ ptyId: "tab:t-1", cols: 100, rows: 40, epoch: "e1" }]);
    expect(agentTerminalOf(WS, "t-1")).toMatchObject({ control: "you", cols: 100, rows: 40 });

    // No gate: a keystroke is one ordered write to the agent's terminal.
    xterm.type("l");
    xterm.type("s");
    await settle();
    expect(runtime.typed.join("")).toBe("ls");
    expect(runtime.params("pty.write")[0]).toMatchObject({ ptyId: "tab:t-1", seq: 1, epoch: "e1" });

    // A gate that refuses drops the input; one that allows after a wait keeps the order.
    let open = false;
    const release: (() => void)[] = [];
    setCloudTerminalInputGate(ID, () => (open ? new Promise<boolean>((resolve) => release.push(() => resolve(true))) : false));
    await typeIntoCloudTerminal(WS, ID, "x");
    await settle();
    expect(runtime.typed.join("")).toBe("ls");
    open = true;
    const first = typeIntoCloudTerminal(WS, ID, "a");
    const second = typeIntoCloudTerminal(WS, ID, "b");
    await settle();
    release.shift()?.();
    await first;
    await settle();
    release.shift()?.();
    await second;
    await settle();
    expect(runtime.typed.join("")).toBe("lsab");
  });

  it("shows a refusal on the terminal instead of dropping it quietly", async () => {
    runtime.collab = { you: { userId: "u-me", role: "driver", canApprove: true }, participants: [], leases: [{ tabId: "t-1", holderId: "u-alice", acquiredAt: 1, expiresAt: Date.now() + 60_000 }] };
    await attachAgentTerminal(WS, client, "t-1", base);
    xterm.type("x");
    await settle();
    expect(runtime.typed).toEqual([]);
    expect(agentTerminalOf(WS, "t-1")?.inputError).toBe("lease_held");
    await expect(takeControl(WS, client, ID, null)).rejects.toMatchObject({ code: "lease_held" });
  });

  it("a view that does not control it follows the controller's size and never sends its own", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    runtime.controlledBy("other", "u-alice");
    runtime.resizedTo(132, 43);
    expect(xterm.term.resize).toHaveBeenLastCalledWith(132, 43);
    expect(agentTerminalOf(WS, "t-1")).toMatchObject({ control: "other", controllerId: "u-alice", cols: 132, rows: 43 });
    // This window is resized: its size is not the program's business.
    xterm.fitTo(60, 20);
    await settle();
    expect(runtime.methods("pty.resize")).toEqual([]);

    await takeControl(WS, client, ID, { cols: 60, rows: 20 });
    xterm.fitTo(70, 25);
    await settle();
    expect(runtime.params("pty.resize")).toEqual([{ ptyId: "tab:t-1", cols: 70, rows: 25, epoch: "e1" }]);
  });

  it("starts over on a restarted runtime instead of ending with it", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    await takeControl(WS, client, ID, null);
    // The runtime process is replaced (a resume): same tab, a new CLI and screen.
    runtime.emit({ state: "reconnecting", attempt: 1, reason: "dropped", retryInMs: 1 });
    runtime.epoch = "e2";
    runtime.agent = { control: "none", controllerId: null, cols: 120, rows: 30, screen: "fresh screen\r\n", running: true };
    runtime.connect();
    await settle();
    expect(agentTerminalOf(WS, "t-1")).toMatchObject({ gone: null, live: true, control: "none" });
    expect(xterm.term.reset).toHaveBeenCalledTimes(1);
    expect(xterm.screen()).toBe("fresh screen\r\n");
    // The fresh attach names no offset of the old process.
    expect(runtime.params("pty.attach").at(-1)).toEqual({ ptyId: "tab:t-1" });
  });

  it("goes with its workspace's other views when access ends", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    dropCloudTerminals(WS);
    expect(agentTerminalOf(WS, "t-1")).toBeUndefined();
    runtime.output("after\r\n");
    expect(xterm.screen()).toBe("agent screen\r\n");
  });
});

describe("what a terminal says by itself is not typing (review M1)", () => {
  const FOCUS_IN = "\x1b[I";
  const FOCUS_OUT = "\x1b[O";

  it("tells reports from keys", () => {
    for (const report of [FOCUS_IN, FOCUS_OUT, "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[12;40R", "\x1b[?2004;1$y", "\x1b]11;rgb:1c1c/1c1c/1f1f\x1b\\", "\x1b]10;rgb:ff/ff/ff\x07", "\x1b[4;600;800t", `${FOCUS_IN}\x1b[?1;2c`]) {
      expect(isTerminalReport(report), JSON.stringify(report)).toBe(true);
    }
    for (const typed of ["a", "\r", "\x1b", "\x1b[A", "\x1bOP", "\x1b[15~", "\x1b[200~pasted\x1b[201~", "ls -la\r", `${FOCUS_IN}x`]) {
      expect(isTerminalReport(typed), JSON.stringify(typed)).toBe(false);
    }
    expect(isMouseReport("\x1b[<0;10;5M")).toBe(true);
    expect(isMouseReport("\x1b[<35;11;5m\x1b[<35;12;5m")).toBe(true);
    expect(isMouseReport("\x1b[A")).toBe(false);
  });

  it("a report never asks the gate, takes control or types: with nobody controlling it goes nowhere", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    const gate = vi.fn(() => true);
    setCloudTerminalInputGate(ID, gate);
    xterm.report(FOCUS_IN);
    xterm.report(FOCUS_OUT);
    xterm.report("\x1b[<0;10;5M");
    await settle();
    expect(gate).not.toHaveBeenCalled();
    expect(runtime.sent.map((frame) => frame.method)).toEqual(["pty.attach"]);
    expect(agentTerminalOf(WS, "t-1")?.inputError).toBeNull();
    // A key does ask.
    xterm.type("x");
    await settle();
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("the controller's reports reach the program marked as reports, apart from what was typed", async () => {
    await attachAgentTerminal(WS, client, "t-1", base);
    await takeControl(WS, client, ID, null);
    xterm.type("a");
    xterm.report(FOCUS_IN);
    xterm.type("b");
    await settle();
    expect(runtime.typed.join("")).toBe("ab");
    expect(runtime.reports).toEqual([FOCUS_IN]);
    const writes = runtime.params("pty.write");
    expect(writes.filter((write) => write.report === true).map((write) => write.data)).toEqual([FOCUS_IN]);
    expect(writes.filter((write) => write.data === "a" || write.data === "b").every((write) => !("report" in write))).toBe(true);
    // Control moves to someone else: this view's reports stop, without an error.
    runtime.controlledBy("other", "u-alice");
    xterm.report(FOCUS_OUT);
    await settle();
    expect(runtime.reports).toEqual([FOCUS_IN]);
    expect(agentTerminalOf(WS, "t-1")?.inputError).toBeNull();
  });

  it("answers no query found in the replay, and answers a live one", async () => {
    runtime.agent.control = "you";
    runtime.agent.screen = "old \x1b[c and \x1b[6n\r\n";
    await attachAgentTerminal(WS, client, "t-1", base);
    await settle();
    expect(xterm.screen()).toContain("old ");
    expect(runtime.methods("pty.write")).toEqual([]);
    // The program asks now, and is waiting for the answer.
    runtime.output("\x1b[c");
    await settle();
    expect(runtime.reports).toEqual(["\x1b[?1;2c"]);
    expect(runtime.typed).toEqual([]);

    // Coming back later: what was written while away is replay too.
    detachAgentTerminal(WS, "t-1");
    runtime.agent.screen += "\x1b[6n";
    await attachAgentTerminal(WS, client, "t-1", base);
    await settle();
    expect(runtime.reports).toEqual(["\x1b[?1;2c"]);
  });

  it("goes by xterm's own mark where there is one: Shift+F3 is typed, the same bytes as a cursor report are not", async () => {
    const marks: (() => void)[] = [];
    (xterm.term as unknown as { _core: unknown })._core = { coreService: { onUserInput: (listener: () => void) => void marks.push(listener) } };
    await attachAgentTerminal(WS, client, "t-1", base);
    await takeControl(WS, client, ID, null);
    const press = (data: string) => {
      marks.forEach((mark) => mark());
      xterm.type(data);
    };
    press("\x1b[1;2R");
    xterm.report("\x1b[1;2R");
    // A mouse report is marked as the user's by xterm, and is still not typing.
    press("\x1b[<0;10;5M");
    await settle();
    expect(runtime.typed).toEqual(["\x1b[1;2R"]);
    expect(runtime.reports.join("")).toBe("\x1b[1;2R\x1b[<0;10;5M");
  });

  it("holds for cloud shell terminals too: a watcher's reports are dropped quietly, the controller's are marked", async () => {
    const shell = { ptyId: "p1", number: 1, epoch: "e1", pid: 1, cwd: "/w", cols: 80, rows: 24, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "other" as const, controllerId: "u-alice" };
    const writes: { data: string; report: boolean }[] = [];
    const shellClient = {
      connection: { state: "connected" },
      listPtys: async () => ({ epoch: "e1", terminals: [shell] }),
      attachPty: async () => ({ cursor: () => undefined, detach: () => undefined }),
      write: async (_ptyId: string, data: string, options: { report?: boolean } = {}) => void writes.push({ data, report: options.report === true }),
      controlPty: async () => ({ ...shell, control: "you" as const, controllerId: "u-me" }),
    } as never;
    const [terminal] = await syncCloudTerminals(WS, shellClient, base);
    xterm.report(FOCUS_IN);
    await settle();
    expect(writes).toEqual([]);
    expect(cloudTerminalsOf(WS).terminals[0]?.inputError).toBeNull();
    await takeControl(WS, shellClient, terminal!.id, null);
    xterm.report(FOCUS_IN);
    xterm.type("ls\r");
    await settle();
    expect(writes).toEqual([{ data: FOCUS_IN, report: true }, { data: "ls\r", report: false }]);
  });

  it("a stopped workspace's terminals forget the modes their programs set", () => {
    const made = cloudTerminalFactory(WS, ensureAgentTerminal(WS, "t-1"), base);
    getInstance(ID, made);
    quietCloudTerminals(WS);
    for (const off of ["\x1b[?1004l", "\x1b[?1000l", "\x1b[?1003l", "\x1b[?1006l"]) expect(xterm.screen()).toContain(off);
  });
});

describe("the terminal view capability of a session backend", () => {
  const context = (fields: Partial<Parameters<typeof cloudSessionBackend>[0]> = {}): Parameters<typeof cloudSessionBackend>[0] => ({
    key: "cloud:org-1:ws-1:s-1",
    workspaceKey: WS,
    scope: { organizationId: "org-1", workspaceId: "ws-1" },
    sessionId: "s-1",
    state: client.connection,
    client,
    workspaceState: "ready",
    authority: "manage",
    outbox: [],
    followUps: () => [],
    wake: vi.fn(async () => undefined),
    terminalBase: base,
    agentProcess: () => "running",
    ...fields,
  });
  const claude = { harness: "claude" };

  it("every local tab has the switch", () => {
    expect(terminalViewOf(localSessionBackend("local-1"), claude)).toEqual({ available: true, reason: null });
    expect(terminalViewOf(localSessionBackend("local-1"), { harness: "opencode" })).toEqual({ available: true, reason: null });
    expect(localSessionBackend("local-1").agentTerminal).toBeUndefined();
  });

  it("a cloud tab has it while its runtime serves agent-pty/1, and says why when it does not", () => {
    const backend = cloudSessionBackend(context());
    expect(terminalViewOf(backend, claude)).toEqual({ available: true, reason: null });
    expect(backend.agentTerminal).toMatchObject({ workspaceKey: WS, client, asleep: false });
    expect(terminalViewOf(backend, { harness: "opencode" })).toEqual({ available: false, reason: TERMINAL_VIEW_NO_TERMINAL });

    runtime.capabilities = runtime.capabilities.filter((capability) => capability !== "agent-pty/1");
    runtime.connect();
    const older = cloudSessionBackend(context());
    expect(terminalViewOf(older, claude)).toEqual({ available: false, reason: TERMINAL_VIEW_OLD_RUNTIME });
    expect(older.agentTerminal?.client).toBeNull();
  });

  it("a stopped workspace offers it unless its runtime was last seen without it, and holds no client", () => {
    const stopped = { state: { state: "suspended" } as const, workspaceState: "suspended" };
    const unknown = cloudSessionBackend(context(stopped));
    expect(terminalViewOf(unknown, claude).available).toBe(true);
    expect(unknown.agentTerminal).toMatchObject({ client: null, asleep: true });
    expect(terminalViewOf(cloudSessionBackend(context({ ...stopped, agentPty: true })), claude).available).toBe(true);
    expect(terminalViewOf(cloudSessionBackend(context({ ...stopped, agentPty: false })), claude)).toEqual({ available: false, reason: TERMINAL_VIEW_OLD_RUNTIME });
  });

  it("typing wakes a stopped workspace once however many keys are pressed, and never for someone who cannot type", async () => {
    const wake = vi.fn(async () => undefined);
    const stopped = { state: { state: "suspended" } as const, workspaceState: "suspended", wake };
    const backend = cloudSessionBackend(context(stopped));
    expect(wake).not.toHaveBeenCalled();
    backend.agentTerminal!.wake();
    backend.agentTerminal!.wake();
    // A send while it wakes shares the same wake.
    cloudSessionBackend(context(stopped)).agentTerminal!.wake();
    await settle();
    expect(wake).toHaveBeenCalledTimes(1);

    const viewerWake = vi.fn(async () => undefined);
    const viewer = cloudSessionBackend(context({ ...stopped, workspaceKey: "cloud:org-1:ws-2", wake: viewerWake, authority: "participate", you: { userId: "u-v", role: "viewer", canApprove: false } }));
    expect(viewer.readOnlyReason).toBe(cloudReadOnlyReason("participate", "suspended", { userId: "u-v", role: "viewer", canApprove: false }));
    viewer.agentTerminal!.wake();
    await settle();
    expect(viewerWake).not.toHaveBeenCalled();
  });
});

describe("which view a tab shows", () => {
  const session = { id: "cloud:org-1:ws-1:s-1", cwd: "cloud://org-1/ws-1" } as never;
  const tab = { id: "t-1", harness: "claude" } as never;

  it("a cloud tab's switch is only a flag, remembered per tab: nothing local is started or adopted", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await toggleTabView(session, tab, { remote: true });
    expect(tabViewOf("t-1")).toBe("terminal");
    expect(tabViewOf("t-2")).toBe("chat");
    await enterTerminalView(session, tab, { remote: true });
    expect(tabViewOf("t-1")).toBe("terminal");
    await toggleTabView(session, tab, { remote: true });
    expect(tabViewOf("t-1")).toBe("chat");
    expect(invoke).not.toHaveBeenCalled();
  });
});
