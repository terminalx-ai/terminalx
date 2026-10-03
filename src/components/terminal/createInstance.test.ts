import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  attach: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn().mockResolvedValue(undefined),
  detachAll: vi.fn(),
  ack: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/api", () => ({ pty }));
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
    expect(pty.attach).not.toHaveBeenCalled();

    dropped();
    await settled();
    expect(pty.attach).toHaveBeenCalledTimes(1);
    expect(pty.attach.mock.calls[0][0]).toBe("tab:t1");
    expect(pty.detachAll.mock.invocationCallOrder[0]).toBeLessThan(pty.attach.mock.invocationCallOrder[0]);

    // A second terminal of the same page: attached, and nothing is dropped again.
    createInstance("s1:shell", "dark");
    await settled();
    expect(pty.attach).toHaveBeenCalledTimes(2);
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
    expect(pty.attach).not.toHaveBeenCalled();
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
    expect(pty.attach).toHaveBeenCalledTimes(1);
    const tokenB = pty.attach.mock.calls[0][1] as string;
    // Every detach A sent names A's attachment, never B's.
    expect(pty.detach.mock.calls.length).toBeGreaterThan(0);
    for (const [id, token] of pty.detach.mock.calls) {
      expect(id).toBe("tab:t1");
      expect(token).not.toBe(tokenB);
    }
    // And B's acknowledgements name B.
    const feed = pty.attach.mock.calls[0][2] as (bytes: Uint8Array) => void;
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
    const [, token, feed] = pty.attach.mock.calls[0] as [string, string, (bytes: Uint8Array) => void];
    feed(new TextEncoder().encode("hello"));
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    expect(inst.term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
    inst.release?.();
    expect(pty.detach).toHaveBeenCalledWith("s1:shell", token);
    inst.term.dispose();
  });
});
