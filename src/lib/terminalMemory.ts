import type { Terminal } from "@xterm/xterm";

/**
 * Opt-in diagnostic inventory, not a heap size or an acceptance measurement.
 * WeakRefs never intentionally root their targets, but dereferencing keeps them
 * alive until the end of that job. Enable only in a separate diagnostic soak.
 * Private xterm 6 / addon-webgl 0.19 fields are read, never modified. Missing
 * required fields invalidate attribution rather than silently becoming zero.
 * Byte counts are view spans, not retained backing capacity:
 * distinct views may overlap. Reading .buffer can materialize backing objects
 * in JavaScriptCore and substantially change the allocation being measured.
 */
type Fields = Record<string, unknown>;
type Kind = "terminal" | "buffer" | "parser" | "writeQueue" | "renderer" | "glyphGeometry" | "rectangleGeometry" | "atlas" | "canvas";
interface RecordEntry { kind: Kind; ref: WeakRef<object>; retired: boolean }
interface Probe { seen: WeakMap<object, RecordEntry>; records: RecordEntry[]; unavailable: Set<string> }
let probe: Probe | undefined;

const fields = (value: unknown): Fields => value && typeof value === "object" ? value as Fields : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function requireObject(name: string, value: unknown) {
  if (!value || typeof value !== "object") probe?.unavailable.add(name);
}

function trackCanvas(name: string, value: unknown, retired = false) {
  if (!(value instanceof HTMLCanvasElement)) probe?.unavailable.add(name);
  else track("canvas", value, retired);
}

/** Owned resource state only; collection of disposed objects is not required. */
export function terminalCleanupComplete(state: { sessions: number; panes: number; instances: number; deleteFailures: number; closeFailures: number }) {
  return Object.values(state).every((count) => Number.isSafeInteger(count) && count === 0);
}

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
  probe = { seen: new WeakMap(), records: [], unavailable: new Set() };
}

export function recordTerminalMemory(term: Terminal, retired = false) {
  if (!probe) return;
  track("terminal", term, retired);
  const core = fields(fields(term)._core);
  const buffers = fields(core.buffers);
  requireObject("normal buffer", buffers.normal);
  requireObject("alternate buffer", buffers.alt);
  requireObject("parser", core._inputHandler);
  requireObject("write queue", core._writeBuffer);
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
  requireObject("WebGL renderer", renderer);
  if (!renderer) return;
  track("renderer", renderer, retired);
  const r = fields(renderer);
  const disposed = fields(r._store).isDisposed === true;
  const glyph = fields(r._glyphRenderer).value;
  const rectangle = fields(r._rectangleRenderer).value;
  // MutableDisposable releases these children on actual renderer disposal.
  // `retired` alone only records a teardown attempt, not successful disposal.
  if (!disposed) {
    requireObject("glyph geometry", glyph);
    requireObject("rectangle geometry", rectangle);
  }
  track("glyphGeometry", glyph, retired);
  track("rectangleGeometry", rectangle, retired);
  if (!disposed || r._canvas !== undefined) trackCanvas("renderer canvas", r._canvas, retired);
  if ((!disposed || r._renderLayers !== undefined) && !Array.isArray(r._renderLayers)) probe.unavailable.add("renderer layers");
  for (const layer of list(r._renderLayers)) trackCanvas("layer canvas", fields(layer)._canvas, retired);
  // An atlas is shared between renderers. Its liveness/bytes are deduplicated;
  // retiring one renderer must not label a shared atlas as retired.
  track("atlas", r._charAtlas);
  const atlas = fields(r._charAtlas);
  // A live zero-character-size renderer has not acquired an atlas yet. Record that
  // state in snapshots; a missing atlas at positive dimensions is incompatible.
  const char = fields(fields(fields(r.dimensions).device).char);
  const lazyAtlas = typeof char.width === "number" && typeof char.height === "number" && char.width <= 0 && char.height <= 0;
  if (!r._charAtlas && (disposed || lazyAtlas)) return;
  requireObject("atlas", r._charAtlas);
  if (!Array.isArray(atlas._pages)) probe.unavailable.add("atlas pages");
  trackCanvas("atlas temporary canvas", atlas._tmpCanvas);
  for (const page of list(atlas._pages)) trackCanvas("atlas page canvas", fields(page).canvas);
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
    if (!ArrayBuffer.isView(value)) {
      probe?.unavailable.add(`${kind} typed view`);
      return;
    }
    if (views.has(value)) return;
    views.add(value);
    byteTotals[kind] += value.byteLength;
  };
  let retiredScrollbackBytes = 0;
  let lineSlots = 0;
  let queuedStringCodeUnits = 0;
  let pendingWriteUnits = 0;
  let pendingWriteUnitsAvailable = true;
  let disposedRenderers = 0;
  let lazyAtlasRenderers = 0;
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
      if (!Array.isArray(fields(v.lines)._array)) probe.unavailable.add("buffer line slots");
      // Include spare slots, not just the logical circular-list length.
      for (const line of list(fields(v.lines)._array)) {
        if (!line) continue;
        lineSlots++;
        countBytes("scrollback", fields(line)._data);
      }
      if (entry.retired) retiredScrollbackBytes += byteTotals.scrollback - before;
    } else if (entry.kind === "parser") {
      countBytes("parser", v._parseBuffer);
    } else if (entry.kind === "writeQueue") {
      if (!Array.isArray(v._writeBuffer)) probe.unavailable.add("write queue chunks");
      if (typeof v._pendingData !== "number" || !Number.isSafeInteger(v._pendingData) || v._pendingData < 0) {
        probe.unavailable.add("write queue pending units");
        pendingWriteUnitsAvailable = false;
      } else pendingWriteUnits += v._pendingData;
      for (const chunk of list(v._writeBuffer)) {
        if (typeof chunk === "string") queuedStringCodeUnits += chunk.length;
        else countBytes("writeQueue", chunk);
      }
    } else if (entry.kind === "renderer") {
      if (fields(v._store).isDisposed === true) disposedRenderers++;
      else if (!v._charAtlas) {
        const char = fields(fields(fields(v.dimensions).device).char);
        if (typeof char.width === "number" && typeof char.height === "number" && char.width <= 0 && char.height <= 0) lazyAtlasRenderers++;
      }
      const model = fields(v._model);
      countBytes("renderer", model.cells);
      countBytes("renderer", model.lineLengths);
      if (v._contextRestorationTimeout !== undefined) contextRestoreTimers++;
      const blink = fields(v._cursorBlinkStateManager);
      if (blink._blinkInterval !== undefined) blinkTimers++;
      if (blink._blinkStartTimeout !== undefined) blinkTimers++;
    } else if (entry.kind === "glyphGeometry" || entry.kind === "rectangleGeometry") {
      requireObject("geometry vertices", v._vertices);
      for (const key of ["_vertices", "_verticesCursor"]) {
        if (key === "_verticesCursor" && !(key in v)) continue;
        const vertices = fields(v[key]);
        countBytes("renderer", vertices.attributes);
        if (entry.kind === "glyphGeometry" && !Array.isArray(vertices.attributesBuffers)) probe.unavailable.add("glyph attribute buffers");
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
    at: new Date().toISOString(), monotonicMs: performance.now(),
    measurement: "diagnostic-not-acceptance", unavailable: [...probe.unavailable].sort(),
    counts, byteTotals, retiredScrollbackBytes, lineSlots,
    byteAccounting: "unique typed-array view spans; shared backing may overlap",
    pendingWriteUnits: pendingWriteUnitsAvailable ? pendingWriteUnits : null,
    pendingWriteUnitsMeaning: "raw xterm pendingData: UTF-16 code units for strings plus bytes for Uint8Array; not bytes",
    queuedStringCodeUnitsMeaning: "all stored string chunks, including processed entries not yet trimmed; not exact pending units",
    queuedStringCodeUnits, canvasPixels, detachedCanvasPixels, disposedRenderers, lazyAtlasRenderers,
    contextRestoreTimers, blinkTimers,
    // Read the documented-in-source debug map's size; never inspect callbacks.
    tauriCallbacks: callbacks instanceof Map ? callbacks.size : null,
    documentNodes: document.getElementsByTagName("*").length,
    documentCanvases: document.getElementsByTagName("canvas").length,
  };
  if (stop) probe = undefined;
  return result;
}
