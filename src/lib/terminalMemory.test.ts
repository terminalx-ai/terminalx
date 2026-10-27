import { afterEach, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { recordTerminalMemory, recordRendererMemory, startTerminalMemoryProbe, terminalMemorySnapshot, terminalCleanupComplete } from "./terminalMemory";

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
  expect(populated.pendingWriteUnits).toBe(0);
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

it("includes four baseline terminals and deduplicates their later observations", () => {
  startTerminalMemoryProbe();
  const terminals = Array.from({ length: 4 }, () => new Terminal());
  try {
    for (const term of terminals) recordTerminalMemory(term);
    for (const term of terminals) recordTerminalMemory(term);
    const sample = terminalMemorySnapshot()!;
    expect(sample.counts.terminal.tracked).toBe(4);
    expect(sample.counts.buffer.tracked).toBe(8);
    expect(sample.unavailable).toEqual([]);
    expect(sample.measurement).toBe("diagnostic-not-acceptance");
  } finally {
    for (const term of terminals) term.dispose();
  }
});

it("reports incompatible private fields rather than treating them as zero retained bytes", () => {
  startTerminalMemoryProbe();
  recordTerminalMemory({} as Terminal);
  const sample = terminalMemorySnapshot()!;
  expect(sample.unavailable).toEqual(["alternate buffer", "normal buffer", "parser", "write queue"]);
  expect(sample.byteTotals.scrollback).toBe(0); // Unavailable means this is not a zero-payload finding.
});

// Shape controls only: no claim these stand-ins exercise a native renderer.
function rendererShape() {
  return { _renderer: {
    _store: { isDisposed: false },
    dimensions: { device: { char: { width: 8, height: 16 } } },
    _glyphRenderer: { value: { _vertices: { attributes: new Float32Array(4), attributesBuffers: [new Float32Array(4)] } } },
    _rectangleRenderer: { value: { _vertices: { attributes: new Float32Array(4) } } },
    _model: { cells: new Uint32Array(4), lineLengths: new Uint32Array(1) },
    _canvas: document.createElement("canvas"), _renderLayers: [],
    _charAtlas: { _tmpCanvas: document.createElement("canvas"), _pages: [{ canvas: document.createElement("canvas") }] },
  } };
}

it.each(["glyph", "rectangle", "glyphBuffers", "rendererCanvas", "pageCanvas"] as const)("rejects a missing required live %s shape with a matched valid control", (missing) => {
  startTerminalMemoryProbe();
  const addon = rendererShape();
  recordRendererMemory(addon);
  expect(terminalMemorySnapshot()!.unavailable).toEqual([]);
  const r = addon._renderer;
  const expected = {
    glyph: "glyph geometry", rectangle: "rectangle geometry", glyphBuffers: "glyph attribute buffers",
    rendererCanvas: "renderer canvas", pageCanvas: "atlas page canvas",
  }[missing]!;
  if (missing === "glyph") Reflect.deleteProperty(r._glyphRenderer, "value");
  if (missing === "rectangle") Reflect.deleteProperty(r._rectangleRenderer, "value");
  if (missing === "glyphBuffers") Reflect.deleteProperty(r._glyphRenderer.value._vertices, "attributesBuffers");
  if (missing === "rendererCanvas") Reflect.deleteProperty(r, "_canvas");
  if (missing === "pageCanvas") Reflect.deleteProperty(r._charAtlas._pages[0], "canvas");
  recordRendererMemory(addon);
  expect(terminalMemorySnapshot()!.unavailable).toEqual([expected]);
});

it("distinguishes actual disposed children and deferred atlas acquisition from incompatible live shapes", () => {
  startTerminalMemoryProbe();
  const addon = rendererShape();
  Reflect.deleteProperty(addon._renderer, "_charAtlas");
  addon._renderer.dimensions.device.char = { width: 0, height: 0 };
  recordRendererMemory(addon);
  expect(terminalMemorySnapshot()!.lazyAtlasRenderers).toBe(1);
  expect(terminalMemorySnapshot()!.unavailable).toEqual([]);
  addon._renderer._store.isDisposed = true;
  Reflect.deleteProperty(addon._renderer._glyphRenderer, "value");
  Reflect.deleteProperty(addon._renderer._rectangleRenderer, "value");
  expect(terminalMemorySnapshot()!.disposedRenderers).toBe(1);
  expect(terminalMemorySnapshot()!.unavailable).toEqual([]);
});

it("labels pending units honestly and rejects missing or nonnumeric pending counters", () => {
  startTerminalMemoryProbe();
  const term = new Terminal();
  const queue = (term as unknown as { _core: { _writeBuffer: Record<string, unknown> } })._core._writeBuffer;
  const saved = { data: queue._pendingData, chunks: queue._writeBuffer };
  try {
    queue._pendingData = 6; // 1+2 UTF-16 units plus 3 typed bytes, not six bytes of text.
    queue._writeBuffer = ["é", "😀", new Uint8Array(3)];
    recordTerminalMemory(term);
    const sample = terminalMemorySnapshot()!;
    expect(sample.pendingWriteUnits).toBe(6);
    expect(sample.queuedStringCodeUnits).toBe(3);
    expect(sample.byteTotals.writeQueue).toBe(3);
    expect(sample.unavailable).toEqual([]);
    for (const invalid of [undefined, "6", NaN, -1]) {
      startTerminalMemoryProbe();
      queue._pendingData = invalid;
      recordTerminalMemory(term);
      expect(terminalMemorySnapshot()!.pendingWriteUnits).toBeNull();
      expect(terminalMemorySnapshot()!.unavailable).toEqual(["write queue pending units"]);
    }
  } finally {
    queue._pendingData = saved.data;
    queue._writeBuffer = saved.chunks;
    term.dispose();
  }
});

it("requires post-fallback owned cleanup, independently of disposed-object collection", () => {
  const clean = { sessions: 0, panes: 0, instances: 0, deleteFailures: 0, closeFailures: 0 };
  // Pre-fallback leftovers may have been resolved; only the supplied final state is used.
  expect(terminalCleanupComplete(clean)).toBe(true);
  for (const key of Object.keys(clean)) {
    expect(terminalCleanupComplete({ ...clean, [key]: 1 })).toBe(false);
  }
  expect(terminalCleanupComplete({ ...clean, instances: NaN })).toBe(false);
});
