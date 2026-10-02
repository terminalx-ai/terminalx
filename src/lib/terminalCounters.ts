import type { Terminal } from "@xterm/xterm";

/**
 * What the terminal path counts as it runs (issue #232): output received and
 * which renderer each xterm ended up on. Counting is a few additions per
 * output event; nothing is computed until someone asks (`terminalPerf.ts`).
 */
export type TerminalRenderer = "webgl" | "dom";
export type TerminalTransport = "local" | "cloud";

export interface DataRate {
  /** Since the window loaded. */
  events: number;
  bytes: number;
  /** Over the last few whole seconds. */
  eventsPerSecond: number;
  bytesPerSecond: number;
}

const RATE_SECONDS = 5;
interface Meter {
  events: number;
  bytes: number;
  /** One bucket per second, newest last. */
  recent: { second: number; events: number; bytes: number }[];
}
const meters: Record<TerminalTransport, Meter> = {
  local: { events: 0, bytes: 0, recent: [] },
  cloud: { events: 0, bytes: 0, recent: [] },
};

/** One chunk of terminal output arrived in this window. */
export function countTerminalData(transport: TerminalTransport, bytes: number) {
  const meter = meters[transport];
  meter.events++;
  meter.bytes += bytes;
  const second = Math.floor(performance.now() / 1000);
  let bucket = meter.recent[meter.recent.length - 1];
  if (bucket?.second !== second) {
    meter.recent.push((bucket = { second, events: 0, bytes: 0 }));
    if (meter.recent.length > RATE_SECONDS + 1) meter.recent.shift();
  }
  bucket.events++;
  bucket.bytes += bytes;
}

export function dataRate(transport: TerminalTransport): DataRate {
  const meter = meters[transport];
  const now = Math.floor(performance.now() / 1000);
  // The current second is still filling, so the rate is over the whole seconds before it.
  const whole = meter.recent.filter((bucket) => bucket.second < now && bucket.second >= now - RATE_SECONDS);
  const sum = (field: "events" | "bytes") => whole.reduce((total, bucket) => total + bucket[field], 0);
  return {
    events: meter.events,
    bytes: meter.bytes,
    eventsPerSecond: sum("events") / RATE_SECONDS,
    bytesPerSecond: sum("bytes") / RATE_SECONDS,
  };
}

const renderers = new WeakMap<Terminal, TerminalRenderer>();
/** Since the window loaded: contexts asked for, taken away by the browser, and refused outright. */
export const webglContexts = { created: 0, lost: 0, failed: 0 };

export function setRenderer(term: Terminal, renderer: TerminalRenderer) {
  renderers.set(term, renderer);
}

/** A terminal nobody recorded has no WebGL addon: xterm's DOM renderer draws it. */
export function rendererOf(term: Terminal): TerminalRenderer {
  return renderers.get(term) ?? "dom";
}

const onScreen = new WeakSet<Terminal>();

/** Whether a view is showing the terminal now. Only those need WebGL. */
export function setOnScreen(term: Terminal, shown: boolean) {
  if (shown) onScreen.add(term);
  else onScreen.delete(term);
}

export function isOnScreen(term: Terminal): boolean {
  return onScreen.has(term);
}
