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

  it("feeds what the pane prints into the terminal, and stops when the terminal is released", async () => {
    pty.detachAll.mockResolvedValue(undefined);
    const { createInstance } = await import("./TerminalView");
    const inst = createInstance("s1:shell", "dark");
    await settled();
    const feed = pty.attach.mock.calls[0][1] as (bytes: Uint8Array) => void;
    feed(new TextEncoder().encode("hello"));
    await new Promise<void>((resolve) => inst.term.write("", resolve));
    expect(inst.term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
    inst.release?.();
    expect(pty.detach).toHaveBeenCalledWith("s1:shell");
    inst.term.dispose();
  });
});
