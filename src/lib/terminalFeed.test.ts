import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const pty = vi.hoisted(() => ({ ack: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/api", () => ({ pty }));

import { ACK_BYTES, HIDDEN_ACK_MS, HIDDEN_QUEUE_LIMIT, feedLocalPane, queuedLocalOutputBytes } from "./terminalFeed";
import { dataRate, setOnScreen } from "./terminalCounters";

/** An xterm that parses each write when told to. */
function terminal() {
  const parsed: (() => void)[] = [];
  const term = { write: vi.fn((_bytes: Uint8Array, done: () => void) => void parsed.push(done)) };
  return { term: term as unknown as Terminal, parse: () => parsed.splice(0).forEach((done) => done()) };
}

/** The totals reported so far, in order. */
const reported = () => pty.ack.mock.calls.map(([, , total]) => total as number);

let hidden = false;
function hideWindow(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => vi.useRealTimers());

describe("a local pane's output", () => {
  it("retires a suspended view before its unparsed queue can grow without bound", () => {
    const { term, parse } = terminal();
    const before = queuedLocalOutputBytes();
    const retire = vi.fn(() => feed.stop());
    const feed = feedLocalPane("p1", "a1", term, { retire });
    hideWindow(true);
    feed.data(new Uint8Array(HIDDEN_QUEUE_LIMIT));
    expect(queuedLocalOutputBytes() - before).toBe(HIDDEN_QUEUE_LIMIT);
    feed.data(new Uint8Array(32 * 1024));
    expect(retire).toHaveBeenCalledOnce();
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(queuedLocalOutputBytes()).toBe(before);
    parse();
    expect(queuedLocalOutputBytes()).toBe(before);
  });

  it("is acknowledged once drawn, as a running total, for the terminal on screen", () => {
    const { term, parse } = terminal();
    setOnScreen(term, true);
    const feed = feedLocalPane("p1", "a1", term);
    const before = dataRate("local").bytes;

    feed.data(new Uint8Array(ACK_BYTES - 1));
    // Received, not drawn: nothing to acknowledge yet.
    expect(pty.ack).not.toHaveBeenCalled();
    parse();
    // Drawn, but less than a step.
    expect(pty.ack).not.toHaveBeenCalled();

    feed.data(new Uint8Array(10));
    parse();
    feed.data(new Uint8Array(ACK_BYTES));
    parse();
    // Totals, not steps: one that goes missing is made good by the next.
    expect(reported()).toEqual([ACK_BYTES + 9, 2 * ACK_BYTES + 9]);
    expect(pty.ack).toHaveBeenLastCalledWith("p1", "a1", 2 * ACK_BYTES + 9);
    expect(dataRate("local").bytes - before).toBe(2 * ACK_BYTES + 9);
  });

  it("is acknowledged a step per tick for a hidden shell, and all at once when it is shown", () => {
    const { term, parse } = terminal();
    const feed = feedLocalPane("p1", "a1", term);
    feed.data(new Uint8Array(ACK_BYTES * 4));
    parse();
    expect(pty.ack).not.toHaveBeenCalled();

    vi.advanceTimersByTime(HIDDEN_ACK_MS);
    vi.advanceTimersByTime(HIDDEN_ACK_MS);
    expect(reported()).toEqual([ACK_BYTES, ACK_BYTES * 2]);

    setOnScreen(term, true);
    vi.advanceTimersByTime(HIDDEN_ACK_MS);
    expect(reported()).toEqual([ACK_BYTES, ACK_BYTES * 2, ACK_BYTES * 4]);
    // Nothing owed: no more ticks.
    vi.advanceTimersByTime(HIDDEN_ACK_MS * 10);
    expect(pty.ack).toHaveBeenCalledTimes(3);
  });

  it("costs a quiet hidden terminal no acknowledgements at all", () => {
    const { term, parse } = terminal();
    const feed = feedLocalPane("p1", "a1", term);
    for (let frame = 0; frame < 20; frame++) {
      feed.data(new Uint8Array(3000));
      parse();
      vi.advanceTimersByTime(100);
    }
    expect(pty.ack).not.toHaveBeenCalled();
  });

  it("never slows an agent's pane for not being looked at", () => {
    const { term, parse } = terminal();
    // Not on screen: the agent's terminal under its chat.
    const feed = feedLocalPane("tab:t1", "a1", term, { paced: false });
    feed.data(new Uint8Array(ACK_BYTES * 4));
    parse();
    // All of it at once, with no timer involved.
    expect(reported()).toEqual([ACK_BYTES * 4]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds nothing back while the window is hidden, where the page's timers barely run", () => {
    const { term, parse } = terminal();
    setOnScreen(term, true);
    const feed = feedLocalPane("p1", "a1", term);
    feed.data(new Uint8Array(ACK_BYTES * 2));
    // Arrived and not yet parsed: with the window visible that is not acknowledged.
    expect(pty.ack).not.toHaveBeenCalled();

    // The window is hidden: what has arrived is acknowledged there and then.
    hideWindow(true);
    expect(reported()).toEqual([ACK_BYTES * 2]);
    feed.data(new Uint8Array(ACK_BYTES));
    expect(reported()).toEqual([ACK_BYTES * 2, ACK_BYTES * 3]);

    // Shown again, and xterm catches up: nothing is acknowledged twice.
    hideWindow(false);
    parse();
    expect(pty.ack).toHaveBeenCalledTimes(2);
    feed.data(new Uint8Array(ACK_BYTES));
    parse();
    expect(reported()).toEqual([ACK_BYTES * 2, ACK_BYTES * 3, ACK_BYTES * 4]);
  });

  it("says nothing more once its terminal is gone", () => {
    const { term, parse } = terminal();
    const feed = feedLocalPane("p1", "a1", term);
    feed.data(new Uint8Array(ACK_BYTES * 4));
    parse();
    feed.stop();
    vi.advanceTimersByTime(HIDDEN_ACK_MS * 10);
    hideWindow(true);
    expect(pty.ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a parse callback and channel data already in flight when disposed", () => {
    const before = queuedLocalOutputBytes();
    const { term, parse } = terminal();
    const feed = feedLocalPane("p1", "a1", term);
    feed.data(new Uint8Array(ACK_BYTES * 4));
    expect(queuedLocalOutputBytes() - before).toBe(ACK_BYTES * 4);
    feed.stop();
    feed.stop();
    parse();
    feed.data(new Uint8Array(ACK_BYTES));
    vi.advanceTimersByTime(HIDDEN_ACK_MS * 10);
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(pty.ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(queuedLocalOutputBytes()).toBe(before);
  });
});
