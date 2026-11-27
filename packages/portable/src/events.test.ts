import { describe, expect, it } from "vitest";
import { isStrictEventAppend, mergeAgentEvents, type AgentEvent } from "./events";

const makeEvent = (seq: number, text = `m${seq}`): AgentEvent => ({
  id: `e-${seq}`,
  sessionId: "s1",
  tabId: "t1",
  harness: "claude",
  seq,
  ts: "2026-11-01T00:00:00Z",
  payload: { type: "status", text },
});

describe("mergeAgentEvents fast paths (P-13)", () => {
  it("appends strictly increasing events in O(1)/linear copy and marks strict append lineage", () => {
    const e0: AgentEvent[] = [];
    const e1 = mergeAgentEvents(e0, [makeEvent(1), makeEvent(2)]);
    const e2 = mergeAgentEvents(e1, [makeEvent(3)]);
    const e3 = mergeAgentEvents(e2, [makeEvent(4), makeEvent(5)]);

    expect(e3.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(isStrictEventAppend(e0, e1)).toBe(true);
    expect(isStrictEventAppend(e1, e2)).toBe(true);
    expect(isStrictEventAppend(e1, e3)).toBe(true);
    expect(isStrictEventAppend(e2, e3)).toBe(true);
  });

  it("returns the exact same array reference for empty incoming or identical duplicate tail", () => {
    const ev1 = makeEvent(1);
    const ev2 = makeEvent(2);
    const base = mergeAgentEvents([], [ev1, ev2]);

    expect(mergeAgentEvents(base, [])).toBe(base);
    expect(mergeAgentEvents(base, [ev2])).toBe(base);

    const updatedTail = makeEvent(2, "updated");
    const replaced = mergeAgentEvents(base, [updatedTail]);
    expect(replaced).not.toBe(base);
    expect(replaced.map((e) => e.seq)).toEqual([1, 2]);
    expect(replaced[1]).toBe(updatedTail);
    expect(isStrictEventAppend(base, replaced)).toBe(false);
  });

  it("falls back cleanly to deduplicated sort on out-of-order or prepended events", () => {
    const base = mergeAgentEvents([], [makeEvent(3), makeEvent(4)]);
    const prepended = mergeAgentEvents(base, [makeEvent(1), makeEvent(2)]);
    expect(prepended.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(isStrictEventAppend(base, prepended)).toBe(false);

    const unsortedExisting = [makeEvent(5), makeEvent(2)];
    const merged = mergeAgentEvents(unsortedExisting, [makeEvent(4), makeEvent(2, "override")]);
    expect(merged.map((e) => e.seq)).toEqual([2, 4, 5]);
    expect((merged[0].payload as { text: string }).text).toBe("override");
  });
});
