import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { onInstanceDisposed } from "@/lib/terminal";
import { isOnScreen, setOnScreen, setRenderer, setWebglRefused, webglContexts } from "@/lib/terminalCounters";

/**
 * Who gets a WebGL context (issue #232).
 *
 * WebKit allows about 16 live contexts in a page and takes the oldest away
 * when one more is asked for. Terminals live for hours, so the oldest context
 * is usually the terminal someone is looking at, and a terminal that lost its
 * context stayed on xterm's slow DOM renderer for good. Two rules keep the
 * page well under the limit:
 *
 * - A terminal has a context while it is on screen. A few that were on
 *   screen most recently keep theirs, so going back to one is instant; beyond
 *   that budget the least recently shown gives its context up and draws with
 *   the DOM renderer, which does no work while it is hidden.
 * - A context is released the moment its terminal lets go of it. xterm's
 *   addon only removes its canvas and leaves the context to the garbage
 *   collector, and until that runs WebKit still counts it against the limit.
 *
 * A terminal on screen whose context the browser takes anyway gets a new one
 * at once; a hidden one gets it when it is next shown.
 */
export const WEBGL_BUDGET = 6;

interface Held {
  addon: WebglAddon;
  /** The canvas that owns the WebGL context (the addon also adds a 2D one for links). */
  canvas: HTMLCanvasElement | null;
}
/** Terminals with a context, least recently shown first. */
const held = new Map<Terminal, Held>();

/** When each terminal lost a context lately: a page that cannot keep one must not spin. */
const losses = new WeakMap<Terminal, number[]>();
const RETRIES = 5;
const RETRY_WINDOW_MS = 10_000;
/** After WebGL was refused, nobody asks again for this long: a window without WebGL2 stays without it. */
const REFUSED_BACKOFF_MS = 30_000;
let refusedAt: number | null = null;

interface AddonInternals {
  _renderer?: { _canvas?: HTMLCanvasElement; _cursorBlinkStateManager?: { dispose?: () => void } };
}

/**
 * The addon (0.19.0) never disposes its cursor-blink timer: the field holding
 * it is not registered with the renderer's disposables. A terminal that is
 * focused when it is closed therefore leaves an interval running for good,
 * and that interval keeps the renderer, the context and the terminal with its
 * whole scrollback alive: about 17 MB per closed terminal, and one of
 * WebKit's context slots each. The field is private, so this is a no-op the
 * day it is renamed or fixed.
 */
function stopCursorBlink(addon: WebglAddon) {
  (addon as unknown as AddonInternals)._renderer?._cursorBlinkStateManager?.dispose?.();
}

/** The addon's WebGL canvas: its renderer's own, or else the one it added that is not the link layer. */
function glCanvas(term: Terminal, addon: WebglAddon, before: Set<Element>): HTMLCanvasElement | null {
  const own = (addon as unknown as AddonInternals)._renderer?._canvas;
  if (own instanceof HTMLCanvasElement) return own;
  const added = [...(term.element?.querySelectorAll("canvas") ?? [])].filter((canvas) => !before.has(canvas));
  return added.find((canvas) => !canvas.classList.contains("xterm-link-layer")) ?? null;
}

function release(term: Terminal) {
  const entry = held.get(term);
  if (!entry) return;
  held.delete(term);
  stopCursorBlink(entry.addon);
  try {
    // Puts the terminal back on the DOM renderer, unless the terminal itself is being disposed.
    entry.addon.dispose();
  } catch {
    /* already disposed with its terminal */
  }
  entry.canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
  setRenderer(term, "dom");
}

function trim() {
  for (const term of held.keys()) {
    if (held.size <= WEBGL_BUDGET) return;
    if (!isOnScreen(term)) release(term);
  }
}

function acquire(term: Terminal) {
  const entry = held.get(term);
  if (entry) {
    // Shown again: now the most recent.
    held.delete(term);
    held.set(term, entry);
    return;
  }
  if (!term.element) return;
  if (refusedAt !== null && Date.now() - refusedAt < REFUSED_BACKOFF_MS) return;
  try {
    const before = new Set<Element>(term.element.querySelectorAll("canvas"));
    const addon = new WebglAddon();
    addon.onContextLoss(() => lost(term, addon));
    term.loadAddon(addon);
    const canvas = glCanvas(term, addon, before);
    // The addon reports a loss only after waiting three seconds for the
    // context to come back, and one WebKit took for the limit never does.
    canvas?.addEventListener("webglcontextlost", () => lost(term, addon), { once: true });
    held.set(term, { addon, canvas });
    webglContexts.created++;
    refusedAt = null;
    setWebglRefused(false);
    setRenderer(term, "webgl");
  } catch {
    /* the DOM renderer stays */
    webglContexts.failed++;
    refusedAt = Date.now();
    // With no context alive this is not the limit: the window has no WebGL2.
    if (held.size === 0) setWebglRefused(true);
  }
  trim();
}

function lost(term: Terminal, addon: WebglAddon) {
  if (held.get(term)?.addon !== addon) return;
  webglContexts.lost++;
  release(term);
  const now = Date.now();
  const recent = (losses.get(term) ?? []).filter((at) => now - at < RETRY_WINDOW_MS);
  recent.push(now);
  losses.set(term, recent);
  // Not from inside the event that reported the loss. A terminal that keeps
  // losing its context waits the window out, then asks once more.
  setTimeout(() => {
    if (isOnScreen(term)) acquire(term);
  }, recent.length > RETRIES ? RETRY_WINDOW_MS : 0);
}

/** The terminal is on screen: it draws with WebGL from here on. */
export function showWebgl(term: Terminal) {
  setOnScreen(term, true);
  acquire(term);
}

/** The terminal left the screen. It keeps its context while the budget allows. */
export function hideWebgl(term: Terminal) {
  setOnScreen(term, false);
  trim();
}

/** Replace a stale GPU surface without touching xterm's buffers or its PTY. */
export function recoverWebgl(term: Terminal) {
  release(term);
  if (isOnScreen(term)) acquire(term);
  term.refresh(0, term.rows - 1);
}

/** The terminal is going away: its context is released now, not when it is collected. */
export function dropWebgl(term: Terminal) {
  setOnScreen(term, false);
  release(term);
}

onInstanceDisposed((inst) => dropWebgl(inst.term));
