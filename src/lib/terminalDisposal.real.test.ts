import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TerminalBufferCleanup } from "./terminalBufferCleanup";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function populated(protectedLifetime = false) {
  const term = new Terminal({ cols: 240, rows: 24, scrollback: 10_000, allowProposedApi: true });
  if (protectedLifetime) term.loadAddon(new TerminalBufferCleanup());
  const written = new Promise<void>((resolve) => term.write("kept output\r\n".repeat(100), resolve));
  await vi.runAllTimersAsync();
  await written;
  expect(term.buffer.normal.length).toBe(101);
  expect(vi.getTimerCount()).toBe(0);
  return term;
}

describe("real xterm resize cleanup lifetime", () => {
  it("does not retain a scheduled callback when disposed without resizing", async () => {
    vi.useFakeTimers();
    const term = await populated();
    term.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("diagnoses a cleanup callback left pending after shrink and disposal", async () => {
    vi.useFakeTimers();
    const term = await populated();
    const line = rawNormalLine(term);
    const cleanup = vi.spyOn(line, "cleanupMemory");
    term.resize(80, 24);
    expect(vi.getTimerCount()).toBe(1);
    term.dispose();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    expect(cleanup).toHaveBeenCalled(); // The scheduled closure still reaches the disposed buffer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains live-terminal cleanup without changing output", async () => {
    vi.useFakeTimers();
    const term = await populated(true);
    term.resize(80, 24);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expect(term.buffer.normal.length).toBe(101);
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe("kept output");
    term.dispose();
  });
});

// Inspection only in this regression: prove a queued callback reaches actual
// buffer lines, rather than treating any unrelated timer as a retention bug.
function rawNormalLine(term: Terminal) {
  return (term as unknown as { _core: { buffers: { normal: { lines: { get(index: number): { cleanupMemory(): number } } } } } })._core.buffers.normal.lines.get(0);
}

describe("terminal buffer cleanup addon", () => {
  it("cancels compaction on disposal without running it or editing live output", async () => {
    vi.useFakeTimers();
    const term = await populated(true);
    const cleanup = vi.spyOn(rawNormalLine(term), "cleanupMemory");
    term.resize(80, 24);
    expect(vi.getTimerCount()).toBe(1);
    expect(term.buffer.normal.length).toBe(101);
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe("kept output");
    term.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(cleanup).not.toHaveBeenCalled();
    term.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels normal cleanup while the alternate screen is active", async () => {
    vi.useFakeTimers();
    const term = await populated(true);
    const written = new Promise<void>((resolve) => term.write("\x1b[?1049h" + "alternate\r\n".repeat(40), resolve));
    await vi.runAllTimersAsync();
    await written;
    term.resize(80, 24);
    // The alternate buffer has no scrollback/reflow cleanup; the inactive
    // normal buffer still schedules compaction when both buffers resize.
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("alternate");
    expect(vi.getTimerCount()).toBe(1);
    term.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also cancels a queued buffer generation replaced by reset", async () => {
    vi.useFakeTimers();
    const term = await populated(true);
    term.resize(80, 24);
    expect(vi.getTimerCount()).toBe(1);
    term.reset();
    expect(vi.getTimerCount()).toBe(1);
    term.resize(240, 24);
    term.resize(80, 24);
    expect(vi.getTimerCount()).toBe(2);
    term.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves queued writes and their acknowledgement callbacks alone", async () => {
    vi.useFakeTimers();
    const term = await populated(true);
    term.resize(80, 24);
    const acknowledged: number[] = [];
    term.write("queued first\r\n", () => acknowledged.push(1));
    term.write("queued second\r\n", () => acknowledged.push(2));
    expect(vi.getTimerCount()).toBe(2); // Compaction and the independent write queue.
    term.dispose();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    expect(acknowledged).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cancel another terminal's pending cleanup", async () => {
    vi.useFakeTimers();
    const closed = await populated(true);
    const live = await populated(true);
    closed.resize(80, 24);
    live.resize(80, 24);
    expect(vi.getTimerCount()).toBe(2);
    closed.dispose();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expect(live.buffer.normal.length).toBe(101);
    expect(live.buffer.normal.getLine(0)?.translateToString(true)).toBe("kept output");
    live.dispose();
  });
});

// Run the installed distribution without Node's process global so xterm selects
// its actual requestIdleCallback scheduler. Only the host scheduler is controlled;
// parser, buffers, TaskQueue and public addon disposal are the shipped code.
it("cancels the browser idle callback while the unprotected control retains it", async () => {
  vi.useFakeTimers();
  const pending = new Map<number, IdleRequestCallback>();
  let nextId = 1;
  const cancel = vi.fn((id: number) => pending.delete(id));
  const context = {
    navigator: { userAgent: "Safari", platform: "MacIntel", language: "en" },
    console, document, performance, setTimeout, clearTimeout, queueMicrotask,
    requestIdleCallback: (callback: IdleRequestCallback) => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    cancelIdleCallback: cancel,
    module: { exports: {} },
    exports: {},
  };
  const require = createRequire(import.meta.url);
  runInNewContext(readFileSync(require.resolve("@xterm/xterm"), "utf8"), { ...context, window: context });
  const BrowserTerminal = (context.module.exports as { Terminal: typeof Terminal }).Terminal;
  for (const protectedLifetime of [false, true]) {
    const term = new BrowserTerminal({ cols: 240, rows: 24, scrollback: 10_000 });
    if (protectedLifetime) term.loadAddon(new TerminalBufferCleanup());
    const written = new Promise<void>((resolve) => term.write("kept output\r\n".repeat(100), resolve));
    await vi.runAllTimersAsync();
    await written;
    const cleanup = vi.spyOn(rawNormalLine(term), "cleanupMemory");
    term.resize(80, 24);
    expect(pending.size).toBe(1);
    term.dispose();
    expect(pending.size).toBe(protectedLifetime ? 0 : 1);
    if (!protectedLifetime) {
      const [id, callback] = [...pending][0];
      pending.delete(id);
      callback({ didTimeout: false, timeRemaining: () => 100 });
      expect(cleanup).toHaveBeenCalled();
    } else {
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cleanup).not.toHaveBeenCalled();
    }
    expect(pending.size).toBe(0);
  }
});
