import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { onInstanceDisposed } from "@/lib/terminal";
import { isOnScreen, setOnScreen, setRenderer, webglContexts } from "@/lib/terminalCounters";

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
 * A context that is no longer used still holds its slot until it is
 * collected, so after many terminals were closed WebKit may take a live one.
 * A terminal on screen whose context is taken gets a new one at once; a hidden
 * one gets it when it is next shown.
 */
export const WEBGL_BUDGET = 6;

interface Held {
  addon: WebglAddon;
  canvas: HTMLCanvasElement | null;
}
/** Terminals with a context, least recently shown first. */
const held = new Map<Terminal, Held>();

/** When each terminal lost a context lately: a page that cannot keep one must not retry forever. */
const losses = new WeakMap<Terminal, number[]>();
const RETRIES = 5;
const RETRY_WINDOW_MS = 10_000;

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
  const renderer = (addon as unknown as { _renderer?: { _cursorBlinkStateManager?: { dispose?: () => void } } })._renderer;
  renderer?._cursorBlinkStateManager?.dispose?.();
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
  try {
    const before = new Set(term.element.querySelectorAll("canvas"));
    const addon = new WebglAddon();
    addon.onContextLoss(() => lost(term, addon));
    term.loadAddon(addon);
    const canvas = [...term.element.querySelectorAll("canvas")].find((item) => !before.has(item)) ?? null;
    // The addon reports a loss only after waiting three seconds for the
    // context to come back, and one WebKit took for the limit never does.
    canvas?.addEventListener("webglcontextlost", () => lost(term, addon), { once: true });
    held.set(term, { addon, canvas });
    webglContexts.created++;
    setRenderer(term, "webgl");
  } catch {
    /* the DOM renderer stays */
    webglContexts.failed++;
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
  if (recent.length > RETRIES) return;
  // Not from inside the event that reported the loss.
  setTimeout(() => {
    if (isOnScreen(term)) acquire(term);
  }, 0);
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

/** The terminal is going away: its context is released now, not when it is collected. */
export function dropWebgl(term: Terminal) {
  setOnScreen(term, false);
  release(term);
}

onInstanceDisposed((inst) => dropWebgl(inst.term));
