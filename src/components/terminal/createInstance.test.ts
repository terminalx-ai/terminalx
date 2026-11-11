import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SessionEntry, TabEntry } from "@/types/session";

const pty = vi.hoisted(() => ({
  attachSized: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn().mockResolvedValue(undefined),
  detachAll: vi.fn(),
  ack: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
}));
const agent = vi.hoisted(() => ({ ensureStarted: vi.fn(), tabPane: vi.fn(), reportTerminalView: vi.fn() }));
vi.mock("@/lib/api", () => ({ pty, agent, errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/terminalWebgl", () => ({ showWebgl: vi.fn(), hideWebgl: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // jsdom has no canvas: xterm measures and draws through this.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() =>
    new Proxy({}, { get: () => () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }), set: () => true })) as never);
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => vi.restoreAllMocks());

/** Let every pending promise callback run. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("a local terminal's attachment", () => {
  it("keeps Chat until real PTY attachment succeeds, reports a refusal, and retries without another owner", async () => {
    pty.detachAll.mockResolvedValue(undefined);
    let attached!: () => void;
    let refused!: (error: Error) => void;
    pty.attachSized.mockImplementation(() => new Promise<void>((resolve, reject) => { attached = resolve; refused = reject; }));
    agent.ensureStarted.mockResolvedValue(undefined);
    agent.tabPane.mockResolvedValue({ paneId: "tab:t1", command: "codex resume", harness: "codex" });
    agent.reportTerminalView.mockResolvedValue(undefined);
    const { createInstance } = await import("./TerminalView");
    const { getInstance, disposeInstance } = await import("@/lib/terminal");
    const views = await import("@/lib/tabViews");
    const tab: TabEntry = { id: "t1", harness: "codex", model: "", permissionMode: "auto", status: "idle", created: "", modified: "" };
    const session: SessionEntry = { id: "s1", projectPath: "/work", cwd: "/work", worktreeRemoved: false, title: "Fixture", created: "", modified: "", archived: false, pinned: false, tabs: [tab], activeTab: tab.id };
    const inst = getInstance("tab:t1", () => createInstance("tab:t1", "dark"));
    const hook = renderHook(views.useTabViews);
    try {
      await settled();
      let switching!: Promise<void>;
      await act(async () => { switching = views.enterTerminalView(session, tab); await settled(); });
      expect(hook.result.current.views.t1).toBeUndefined();
      expect(hook.result.current.switching.t1).toBe(true);
      expect(agent.reportTerminalView.mock.calls.some(([, , report]) => report.stage === "opened")).toBe(false);
      await act(async () => { refused(new Error("PTY output stream unavailable")); await switching; });
      expect(views.tabViewOf(tab)).toBe("chat");
      expect(hook.result.current.errors.t1).toBe("PTY output stream unavailable");
      expect(agent.reportTerminalView).toHaveBeenCalledWith("s1", "t1", expect.objectContaining({ stage: "failed", errorCategory: "attach" }));

      await act(async () => { switching = views.enterTerminalView(session, tab); await settled(); });
      await vi.waitFor(() => expect(pty.attachSized).toHaveBeenCalledTimes(2));
      expect(views.tabViewOf(tab)).toBe("chat");
      await act(async () => { attached(); await switching; });
      expect(views.tabViewOf(tab)).toBe("terminal");
      expect(hook.result.current.errors.t1).toBeNull();
      expect(agent.reportTerminalView.mock.calls.filter(([, , report]) => report.stage === "opened")).toHaveLength(1);
      await act(async () => { await views.leaveTerminalView(session, tab); await views.enterTerminalView(session, tab); });
      expect(pty.attachSized).toHaveBeenCalledTimes(2); // Reuse the established stream.
      expect(inst.attachedAs?.(pty.attachSized.mock.calls[1][1])).toBe(true);
    } finally {
      hook.unmount();
      disposeInstance("tab:t1");
      pty.attachSized.mockResolvedValue(undefined);
    }
  });

  it("parses late sized output through the real feed without resizing the PTY backwards", async () => {
    pty.detachAll.mockResolvedValue(undefined);
    const { createInstance } = await import("./TerminalView");
    const { requestTerminalResize } = await import("@/lib/terminalOutput");
    const inst = createInstance("s1:shell", "dark");
    await settled();
    const feed = pty.attachSized.mock.calls[0][2] as (bytes: Uint8Array, size: { cols: number; rows: number }) => void;
    const prompt = "PROMPTMARK@clean-macos-vm terminalx-project ";
    const command = "echo pending";
    const write = (data: string, cols: number) => feed(new TextEncoder().encode(data), { cols, rows: 12 });
    write(`\r\x1b[J${prompt}${command}`, 80);
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    requestTerminalResize(inst.term, { cols: 30, rows: 12 });
    requestTerminalResize(inst.term, { cols: 18, rows: 12 });
    await settled(); // Both RPCs finish before the previous redraw is delivered.
    write(`\r\r\x1b[J${prompt}${command}`, 30);
    write(`\r\r\x1b[A\x1b[J${prompt}${command}\x1b[K`, 18);
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    const drawn = Array.from({ length: inst.term.buffer.active.length }, (_, i) => inst.term.buffer.active.getLine(i)?.translateToString(true)).join("");
    expect(drawn.match(/PROMPTMARK/g)).toHaveLength(1);
    expect(drawn).toContain(command);
    expect(pty.resize.mock.calls).toEqual([["s1:shell", 30, 12], ["s1:shell", 18, 12]]);
    inst.release?.();
    inst.term.dispose();
  });

  it("waits for the page to have dropped the attachments of the page before it", async () => {
    // What a launch does: an agent tab's view makes its terminal before
    // anything has subscribed, and the subscription then drops every
    // attachment the backend holds. Attached first, the view would go with them.
    let dropped!: () => void;
    pty.detachAll.mockReturnValue(new Promise<void>((resolve) => (dropped = resolve)));
    const { createInstance } = await import("./TerminalView");
    const inst = createInstance("tab:t1", "dark");
    await settled();
    expect(pty.detachAll).toHaveBeenCalledTimes(1);
    expect(pty.attachSized).not.toHaveBeenCalled();

    dropped();
    await settled();
    expect(pty.attachSized).toHaveBeenCalledTimes(1);
    expect(pty.attachSized.mock.calls[0][0]).toBe("tab:t1");
    expect(pty.detachAll.mock.invocationCallOrder[0]).toBeLessThan(pty.attachSized.mock.invocationCallOrder[0]);

    // A second terminal of the same page: attached, and nothing is dropped again.
    createInstance("s1:shell", "dark");
    await settled();
    expect(pty.attachSized).toHaveBeenCalledTimes(2);
    expect(pty.detachAll).toHaveBeenCalledTimes(1);
    inst.term.dispose();
  });

  it("is not made for a terminal that was disposed while it was on its way", async () => {
    let dropped!: () => void;
    pty.detachAll.mockReturnValue(new Promise<void>((resolve) => (dropped = resolve)));
    const { createInstance } = await import("./TerminalView");
    const inst = createInstance("s1:shell", "dark");
    inst.release?.();
    dropped();
    await settled();
    expect(pty.attachSized).not.toHaveBeenCalled();
    inst.term.dispose();
  });

  it("cannot detach the terminal that replaced it for the same pane", async () => {
    // A is made and released while the page is still subscribing; B is made
    // for the same pane; then the subscription resolves. Whatever A sends
    // after that must name A, so the backend leaves B's attachment alone.
    let dropped!: () => void;
    pty.detachAll.mockReturnValue(new Promise<void>((resolve) => (dropped = resolve)));
    const { createInstance } = await import("./TerminalView");
    const a = createInstance("tab:t1", "dark");
    a.release?.();
    const b = createInstance("tab:t1", "dark");
    dropped();
    await settled();

    // Only B attached, and under its own name.
    expect(pty.attachSized).toHaveBeenCalledTimes(1);
    const tokenB = pty.attachSized.mock.calls[0][1] as string;
    // Every detach A sent names A's attachment, never B's.
    expect(pty.detach.mock.calls.length).toBeGreaterThan(0);
    for (const [id, token] of pty.detach.mock.calls) {
      expect(id).toBe("tab:t1");
      expect(token).not.toBe(tokenB);
    }
    // And B's acknowledgements name B.
    const feed = pty.attachSized.mock.calls[0][2] as (bytes: Uint8Array) => void;
    feed(new Uint8Array(300 * 1024));
    await new Promise<void>((resolve) => b.term.write("", resolve));
    expect(pty.ack.mock.calls.every(([, token]) => token === tokenB)).toBe(true);
    a.term.dispose();
    b.term.dispose();
  });

  it("feeds what the pane prints into the terminal, and stops when the terminal is released", async () => {
    pty.detachAll.mockResolvedValue(undefined);
    const { createInstance } = await import("./TerminalView");
    const inst = createInstance("s1:shell", "dark");
    await settled();
    const [, token, feed] = pty.attachSized.mock.calls[0] as [string, string, (bytes: Uint8Array) => void];
    feed(new TextEncoder().encode("hello"));
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    expect(inst.term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
    inst.release?.();
    expect(pty.detach).toHaveBeenCalledWith("s1:shell", token);
    inst.term.dispose();
  });

  it("attaches again in place over a new connection: redrawn from the replay, answered under its new name", async () => {
    pty.detachAll.mockResolvedValue(undefined);
    const { createInstance } = await import("./TerminalView");
    // An agent's pane: acknowledged as soon as it is parsed, shown or not.
    const inst = createInstance("tab:t1", "dark");
    await settled();
    const [, oldToken, oldFeed] = pty.attachSized.mock.calls[0] as [string, string, (bytes: Uint8Array) => void];
    oldFeed(new TextEncoder().encode("before the gap"));
    inst.reattach!();
    expect(pty.detach).toHaveBeenCalledWith("tab:t1", oldToken);
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    await settled();
    expect(pty.attachSized).toHaveBeenCalledTimes(2);
    const [, newToken, newFeed] = pty.attachSized.mock.calls[1] as [string, string, (bytes: Uint8Array) => void];
    expect(newToken).not.toBe(oldToken);
    // A late byte from the old connection is not drawn; the replay is, on a clean screen.
    oldFeed(new TextEncoder().encode("stale"));
    newFeed(new TextEncoder().encode("replayed tail"));
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    expect(inst.term.buffer.active.getLine(0)?.translateToString(true)).toBe("replayed tail");
    newFeed(new Uint8Array(300 * 1024));
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    expect(pty.ack).toHaveBeenCalled();
    expect(pty.ack.mock.calls.every(([, token]) => token === newToken)).toBe(true);
    inst.release?.();
    expect(pty.detach).toHaveBeenLastCalledWith("tab:t1", newToken);
    inst.term.dispose();
  });

  it("answers to the name of its current attachment only, and to none once released (#716)", async () => {
    pty.detachAll.mockResolvedValue(undefined);
    const { createInstance } = await import("./TerminalView");
    const inst = createInstance("tab:t1", "dark");
    await settled();
    const first = pty.attachSized.mock.calls[0][1] as string;
    expect(inst.attachedAs!(first)).toBe(true);
    expect(inst.attachedAs!("another")).toBe(false);
    inst.reattach!();
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    await settled();
    const second = pty.attachSized.mock.calls[1][1] as string;
    expect(inst.attachedAs!(first)).toBe(false);
    expect(inst.attachedAs!(second)).toBe(true);
    inst.release?.();
    expect(inst.attachedAs!(second)).toBe(false);
    inst.term.dispose();
  });

  it("attaches again once for reattaches in quick succession, and never once released", async () => {
    pty.detachAll.mockResolvedValue(undefined);
    const { createInstance } = await import("./TerminalView");
    const inst = createInstance("s1:shell", "dark");
    await settled();
    inst.reattach!();
    inst.reattach!();
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    await settled();
    expect(pty.attachSized).toHaveBeenCalledTimes(2);
    inst.reattach!();
    inst.release!();
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    await settled();
    expect(pty.attachSized).toHaveBeenCalledTimes(2);
    inst.term.dispose();
  });
});
