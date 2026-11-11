import { describe, expect, it } from "vitest";
import { ScreenHistory, scrolledOff } from "./history";
import type { Row } from "./screen";

const rows = (texts: string[]): Row[] => texts.map((text, index) => ({ key: `normal:${index}`, spans: [{ text }] }));
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}`);
// A program's screen as Claude Code draws it: its transcript scrolling above a footer that stays put.
const screen = (from: number, spinner = "✻ Working") => [...lines(from, from + 14), "────────", `> ${spinner}`, "⏵⏵ bypass permissions on"];

describe("what moved off the top of a screen redrawn in place", () => {
  it("is how far its rows reappear higher, whatever the footer does", () => {
    expect(scrolledOff(screen(0), screen(2))).toBe(2);
    expect(scrolledOff(screen(0), screen(5))).toBe(5);
  });

  it("is nothing when only a spinner or the input changed, or the screen was drawn anew", () => {
    expect(scrolledOff(screen(0), screen(0, "✢ Working"))).toBe(0);
    expect(scrolledOff(screen(0), ["Welcome", ...Array<string>(16).fill("")])).toBe(0);
  });
});

describe("a phone-kept history", () => {
  it("keeps each row that moves off the top, once and in order", () => {
    const history = new ScreenHistory();
    history.observe(rows(screen(0)));
    history.observe(rows(screen(0, "✢ Working")));
    history.observe(rows(screen(2)));
    history.observe(rows(screen(5)));
    expect(history.rows.map((row) => row.spans[0].text)).toEqual(lines(0, 5));
    expect(new Set(history.rows.map((row) => row.key)).size).toBe(5);
  });

  it("keeps no more than its limit, the oldest going first", () => {
    const history = new ScreenHistory(3);
    for (let from = 0; from <= 10; from++) history.observe(rows(screen(from)));
    expect(history.rows.map((row) => row.spans[0].text)).toEqual(lines(7, 10));
  });
});
