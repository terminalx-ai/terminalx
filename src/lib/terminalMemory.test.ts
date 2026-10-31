import { afterEach, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { recordTerminalMemory, startTerminalMemoryProbe, terminalMemorySnapshot } from "./terminalMemory";

afterEach(() => terminalMemorySnapshot(true));

it("does nothing until explicitly enabled and forgets its inventory when stopped", () => {
  const term = new Terminal();
  recordTerminalMemory(term);
  expect(terminalMemorySnapshot()).toBeNull();
  startTerminalMemoryProbe();
  recordTerminalMemory(term);
  expect(terminalMemorySnapshot(true)?.counts.terminal.tracked).toBe(1);
  expect(terminalMemorySnapshot()).toBeNull();
  startTerminalMemoryProbe();
  expect(terminalMemorySnapshot()?.counts).toEqual({});
  term.dispose();
});

it("measures real xterm backing arrays that survive disposal while their owner is still reachable", async () => {
  startTerminalMemoryProbe();
  const term = new Terminal({ cols: 177, rows: 46, scrollback: 10_000 });
  recordTerminalMemory(term);
  await new Promise<void>((done) => term.write("synthetic line\r\n".repeat(20_000), done));
  const populated = terminalMemorySnapshot()!;
  // Three Uint32 cell attributes per column, for every normal-buffer line.
  expect(populated.byteTotals.scrollback).toBe(10_046 * 177 * 12);
  expect(populated.pendingWriteBytes).toBe(0);
  expect(populated.retiredScrollbackBytes).toBe(0);
  recordTerminalMemory(term, true);
  term.dispose();
  const disposed = terminalMemorySnapshot()!;
  expect(disposed.counts.terminal).toEqual({ tracked: 1, alive: 1, retiredAlive: 1 });
  expect(disposed.retiredScrollbackBytes).toBe(populated.byteTotals.scrollback);
  expect(disposed.byteTotals.scrollback).toBe(populated.byteTotals.scrollback);
  // A snapshot is read-only: it must not clear terminal content to change a number.
  expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe("synthetic line");
});

it("counts both normal and alternate storage and deduplicates repeated observations", async () => {
  startTerminalMemoryProbe();
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 100 });
  await new Promise<void>((done) => term.write("line\r\n".repeat(200) + "\x1b[?1049halt screen", done));
  recordTerminalMemory(term);
  recordTerminalMemory(term);
  const result = terminalMemorySnapshot()!;
  expect(result.counts.buffer.tracked).toBe(2);
  expect(result.byteTotals.scrollback).toBe((124 + 24) * 80 * 12);
  expect(term.buffer.active).toBe(term.buffer.alternate);
  term.dispose();
});

it("does not materialize ArrayBuffer objects while inspecting real xterm arrays", async () => {
  startTerminalMemoryProbe();
  const term = new Terminal({ cols: 80, rows: 24 });
  await new Promise<void>((done) => term.write("line", done));
  const core = (term as unknown as { _core: { buffers: { normal: { lines: { get: (index: number) => { _data: Uint32Array } } } } } })._core;
  const data = core.buffers.normal.lines.get(0)._data;
  Object.defineProperty(data, "buffer", { configurable: true, get() { throw new Error("observing .buffer changes JSC allocation mode"); } });
  try {
    recordTerminalMemory(term);
    expect(terminalMemorySnapshot()?.byteTotals.scrollback).toBe(24 * 80 * 12);
  } finally {
    Reflect.deleteProperty(data, "buffer");
    term.dispose();
  }
});
