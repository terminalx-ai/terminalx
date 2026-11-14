import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/transcript";
import { dividerLabel, turnDivider } from "./turnDivider";

const at = (iso: string) => ({ key: iso, seq: 1, ts: iso, prompt: { text: "go", ts: iso, messageTs: iso, seq: 1 }, work: [], toolCount: 0, editedFiles: 0, live: false }) as unknown as Turn;
const now = new Date("2026-11-06T18:00:00");

describe("the time line between turns", () => {
  it("opens the first turn, and a turn after a long pause or on another day", () => {
    const first = at(new Date("2026-11-06T09:00:00").toISOString());
    expect(turnDivider(undefined, first, now, "en-US")).toBe("Today, 9:00 AM");
    expect(turnDivider(first, at(new Date("2026-11-06T09:10:00").toISOString()), now, "en-US")).toBeNull();
    expect(turnDivider(first, at(new Date("2026-11-06T10:00:00").toISOString()), now, "en-US")).toBe("Today, 10:00 AM");
    const lateNight = at(new Date("2026-11-05T23:55:00").toISOString());
    expect(turnDivider(lateNight, at(new Date("2026-11-06T00:05:00").toISOString()), now, "en-US")).toBe("Today, 12:05 AM");
  });

  it("says nothing for a turn without a known send time", () => {
    const legacy = { ...at("2026-11-06T09:00:00Z"), prompt: { text: "go", ts: "2026-11-06T09:00:00Z", seq: 1 } } as unknown as Turn;
    expect(turnDivider(undefined, legacy, now)).toBeNull();
  });

  it("names the day as near as it is", () => {
    expect(dividerLabel(new Date("2026-11-05T17:21:00"), now, "en-US")).toBe("Yesterday, 5:21 PM");
    expect(dividerLabel(new Date("2026-11-02T17:21:00"), now, "en-US")).toBe("Monday, 5:21 PM");
    expect(dividerLabel(new Date("2026-10-26T17:21:00"), now, "en-US")).toBe("Oct 26, 5:21 PM");
    expect(dividerLabel(new Date("2025-10-26T17:21:00"), now, "en-US")).toBe("Oct 26, 2025, 5:21 PM");
  });
});
