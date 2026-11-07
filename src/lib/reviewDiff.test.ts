import { describe, expect, it } from "vitest";
import { reviewSelection, unifiedReviewLines } from "./reviewDiff";

describe("selectable unified diff", () => {
  it.each([
    ["a\nb\nc", "a\nB\nc"], ["", "added\n"], ["deleted\n", ""], ["a", "a\nb"], ["a\nb", "a"],
    ["a\n", "a"], ["a", "a\n"], ["a\nb\nc\nd", "new\na\nb\nC\nd\nlast"], ["same", "same"], ["", ""],
  ])("preserves both documents and their source lines (%j → %j)", (before, after) => {
    const lines = unifiedReviewLines(before, after);
    for (const [side, source] of [["before", before], ["after", after]] as const) {
      const rows = lines.filter((l) => l[side] != null);
      expect(rows.map((l) => l.text).join("\n")).toBe(source);
      expect(rows.map((l) => l[side])).toEqual(source.split("\n").map((_, i) => i + 1));
    }
  });
  it("maps Windows and classic Mac line endings to the displayed line text", () => {
    const lines = unifiedReviewLines("one\r\ntwo\r\n", "one\rTHREE\r");
    expect(lines.filter((l) => l.before != null).map((l) => l.text)).toEqual(["one", "two", ""]);
    expect(lines.filter((l) => l.after != null).map((l) => l.text)).toEqual(["one", "THREE", ""]);
    expect(reviewSelection("f", lines, 2, 2)?.lineText).toBe("two");
  });
  it("selects removed and added ranges but refuses a range crossing sides", () => {
    const lines = unifiedReviewLines("a\nb\nc", "a\nB\nC");
    expect(reviewSelection("f", lines, 2, 3)).toEqual({ path: "f", side: "before", startLine: 2, endLine: 3, lineText: "b\nc" });
    expect(reviewSelection("f", lines, 5, 4)).toMatchObject({ side: "after", startLine: 2, endLine: 3, lineText: "B\nC" });
    expect(reviewSelection("f", lines, 3, 4)).toBeNull();
    expect(reviewSelection("f", lines, 1, 1)).toMatchObject({ side: "after", startLine: 1, lineText: "a" });
  });
});
