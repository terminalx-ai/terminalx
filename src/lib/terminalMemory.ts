import type { Terminal } from "@xterm/xterm";

/**
 * Opt-in diagnostic inventory, not a heap size or an acceptance measurement.
 * WeakRefs never intentionally root their targets, but dereferencing keeps them
 * alive until the end of that job. Enable only in a separate diagnostic soak.
 * Private xterm 6 / addon-webgl 0.19 fields are read, never modified. Unknown
 * fields are omitted. Byte counts are view spans, not retained backing capacity:
 * distinct views may overlap. Reading .buffer can materialize backing objects
 * in JavaScriptCore and substantially change the allocation being measured.
 */
type Fields = Record<string, unknown>;
type Kind = "terminal" | "buffer" | "parser" | "writeQueue" | "renderer" | "geometry" | "atlas" | "canvas";
interface RecordEntry { kind: Kind; ref: WeakRef<object>; retired: boolean }
interface Probe { seen: WeakMap<object, RecordEntry>; records: RecordEntry[] }
let probe: Probe | undefined;

const fields = (value: unknown): Fields => value && typeof value === "object" ? value as Fields : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function track(kind: Kind, value: unknown, retired = false) {
  if (!probe || !value || typeof value !== "object") return;
  const existing = probe.seen.get(value);
  if (existing) {
    existing.retired ||= retired;
    return;
  }
  const entry = { kind, ref: new WeakRef(value), retired };
  probe.seen.set(value, entry);
  probe.records.push(entry);
}

export function startTerminalMemoryProbe() {
  probe = { seen: new WeakMap(), records: [] };
}

export function recordTerminalMemory(term: Terminal, retired = false) {
  if (!probe) return;
  track("terminal", term, retired);
  const core = fields(fields(term)._core);
  const buffers = fields(core.buffers);
  track("buffer", buffers.normal, retired);
  track("buffer", buffers.alt, retired);
  track("parser", core._inputHandler, retired);
  track("writeQueue", core._writeBuffer, retired);
  const renderer = fields(fields(core._renderService)._renderer).value;
  if (fields(renderer)._gl) recordRendererMemory({ _renderer: renderer }, retired);
}

/** Called both on acquisition and before release, while private fields exist. */
export function recordRendererMemory(addon: unknown, retired = false) {
  if (!probe) return;
  const renderer = fields(addon)._renderer;
  if (!renderer) return;
  track("renderer", renderer, retired);
  const r = fields(renderer);
  track("geometry", fields(r._glyphRenderer).value, retired);
  track("geometry", fields(r._rectangleRenderer).value, retired);
  track("canvas", r._canvas, retired);
  for (const layer of list(r._renderLayers)) track("canvas", fields(layer)._canvas, retired);
  // An atlas is shared between renderers. Its liveness/bytes are deduplicated;
  // retiring one renderer must not label a shared atlas as retired.
  track("atlas", r._charAtlas);
  const atlas = fields(r._charAtlas);
  track("canvas", atlas._tmpCanvas);
  for (const page of list(atlas._pages)) track("canvas", fields(page).canvas);
}

export function terminalMemorySnapshot(stop = false) {
  if (!probe) return null;
  // Discover replaced buffers and lazily acquired atlases before counting.
  for (const entry of [...probe.records]) {
    const value = entry.ref.deref();
    if (!value) continue;
    if (entry.kind === "terminal") recordTerminalMemory(value as Terminal, entry.retired);
    if (entry.kind === "renderer") recordRendererMemory({ _renderer: value }, entry.retired);
  }
  const counts: Record<string, { tracked: number; alive: number; retiredAlive: number }> = {};
  const views = new Set<ArrayBufferView>();
  const byteTotals = { scrollback: 0, parser: 0, writeQueue: 0, renderer: 0 };
  const countBytes = (kind: keyof typeof byteTotals, value: unknown) => {
    if (!ArrayBuffer.isView(value) || views.has(value)) return;
    views.add(value);
    byteTotals[kind] += value.byteLength;
  };
  let retiredScrollbackBytes = 0;
  let lineSlots = 0;
  let queuedStringCodeUnits = 0;
  let pendingWriteBytes = 0;
  let canvasPixels = 0;
  let detachedCanvasPixels = 0;
  let contextRestoreTimers = 0;
  let blinkTimers = 0;
  for (const entry of probe.records) {
    const count = counts[entry.kind] ??= { tracked: 0, alive: 0, retiredAlive: 0 };
    count.tracked++;
    const value = entry.ref.deref();
    if (!value) continue;
    count.alive++;
    if (entry.retired) count.retiredAlive++;
    const v = fields(value);
    if (entry.kind === "buffer") {
      const before = byteTotals.scrollback;
      // Include spare slots, not just the logical circular-list length.
      for (const line of list(fields(v.lines)._array)) {
        if (line) lineSlots++;
        countBytes("scrollback", fields(line)._data);
      }
      if (entry.retired) retiredScrollbackBytes += byteTotals.scrollback - before;
    } else if (entry.kind === "parser") {
      countBytes("parser", v._parseBuffer);
    } else if (entry.kind === "writeQueue") {
      pendingWriteBytes += Number(v._pendingData) || 0;
      for (const chunk of list(v._writeBuffer)) {
        countBytes("writeQueue", chunk);
        if (typeof chunk === "string") queuedStringCodeUnits += chunk.length;
      }
    } else if (entry.kind === "renderer") {
      const model = fields(v._model);
      countBytes("renderer", model.cells);
      countBytes("renderer", model.lineLengths);
      if (v._contextRestorationTimeout !== undefined) contextRestoreTimers++;
      const blink = fields(v._cursorBlinkStateManager);
      if (blink._blinkInterval !== undefined) blinkTimers++;
      if (blink._blinkStartTimeout !== undefined) blinkTimers++;
    } else if (entry.kind === "geometry") {
      for (const key of ["_vertices", "_verticesCursor"]) {
        const vertices = fields(v[key]);
        countBytes("renderer", vertices.attributes);
        for (const array of list(vertices.attributesBuffers)) countBytes("renderer", array);
      }
    } else if (entry.kind === "canvas" && value instanceof HTMLCanvasElement) {
      const pixels = value.width * value.height;
      canvasPixels += pixels;
      if (!value.isConnected) detachedCanvasPixels += pixels;
    }
  }
  const callbacks = fields(fields(window).__TAURI_INTERNALS__).callbacks;
  const result = {
    at: new Date().toISOString(), counts, byteTotals, retiredScrollbackBytes, lineSlots,
    byteAccounting: "unique typed-array view spans; shared backing may overlap",
    pendingWriteBytes, queuedStringCodeUnits, canvasPixels, detachedCanvasPixels,
    contextRestoreTimers, blinkTimers,
    // Read the documented-in-source debug map's size; never inspect callbacks.
    tauriCallbacks: callbacks instanceof Map ? callbacks.size : null,
    documentNodes: document.getElementsByTagName("*").length,
    documentCanvases: document.getElementsByTagName("canvas").length,
  };
  if (stop) probe = undefined;
  return result;
}
