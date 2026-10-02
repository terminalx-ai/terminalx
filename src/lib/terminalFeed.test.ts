import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({ ack: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/api", () => ({ pty }));

import { ACK_BYTES, HIDDEN_ACK_MS, feedLocalPane } from "./terminalFeed";
import { dataRate, setOnScreen } from "./terminalCounters";

/** An xterm that parses each write when told to. */
function terminal() {
  const parsed: (() => void)[] = [];
  const term = { write: vi.fn((_bytes: Uint8Array, done: () => void) => void parsed.push(done)) };
  return { term: term as never, parse: () => parsed.splice(0).forEach((done) => done()) };
}

const acked = () => pty.ack.mock.calls.reduce((total, [, bytes]) => total + (bytes as number), 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("a local pane's output", () => {
  it("is acknowledged once drawn, in steps, for the terminal on screen", () => {
    const { term, parse } = terminal();
    setOnScreen(term, true);
    const feed = feedLocalPane("p1", term);
    const before = dataRate("local").bytes;

    feed(new Uint8Array(ACK_BYTES - 1));
    // Received, not drawn: nothing to acknowledge yet.
    expect(pty.ack).not.toHaveBeenCalled();
    parse();
    // Drawn, but less than a step.
    expect(pty.ack).not.toHaveBeenCalled();

    feed(new Uint8Array(10));
    parse();
    expect(pty.ack).toHaveBeenCalledTimes(1);
    expect(pty.ack).toHaveBeenCalledWith("p1", ACK_BYTES + 9);
    expect(dataRate("local").bytes - before).toBe(ACK_BYTES + 9);
  });

  it("is acknowledged a step per tick for a hidden terminal, and all at once when it is shown", () => {
    const { term, parse } = terminal();
    const feed = feedLocalPane("p1", term);
    feed(new Uint8Array(ACK_BYTES * 4));
    parse();
    expect(pty.ack).not.toHaveBeenCalled();

    vi.advanceTimersByTime(HIDDEN_ACK_MS);
    expect(acked()).toBe(ACK_BYTES);
    vi.advanceTimersByTime(HIDDEN_ACK_MS);
    expect(acked()).toBe(ACK_BYTES * 2);

    setOnScreen(term, true);
    vi.advanceTimersByTime(HIDDEN_ACK_MS);
    expect(acked()).toBe(ACK_BYTES * 4);
    // Nothing owed: no more ticks.
    vi.advanceTimersByTime(HIDDEN_ACK_MS * 10);
    expect(pty.ack).toHaveBeenCalledTimes(3);
  });

  it("costs a quiet hidden terminal no acknowledgements at all", () => {
    const { term, parse } = terminal();
    const feed = feedLocalPane("p1", term);
    for (let frame = 0; frame < 20; frame++) {
      feed(new Uint8Array(3000));
      parse();
      vi.advanceTimersByTime(100);
    }
    expect(pty.ack).not.toHaveBeenCalled();
  });
});
