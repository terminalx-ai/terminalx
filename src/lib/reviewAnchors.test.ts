import { expect, it } from "vitest";
import { anchorReview, locateReview, reviewInDiff } from "./reviewAnchors";

const base = "a".repeat(40);
it("captures the original text and surrounding context on both sides", () => {
  for (const side of ["before", "after"] as const) {
    const c = anchorReview("new.ts", base, side, "one\r\ntwo\r\nthree\r\nfour", 3, 2, "old.ts");
    expect(c).toMatchObject({ side, base, originalPath: "old.ts", startLine: 2, endLine: 3, lineText: "two\nthree", contextBefore: ["one"], contextAfter: ["four"] });
    expect(locateReview(c, "inserted\none\ntwo\nthree\nfour")).toEqual({ outdated: false, startLine: 3, endLine: 4 });
    expect(locateReview(c, "two\nthree")).toEqual({ outdated: false, startLine: 1, endLine: 2 });
    expect(locateReview(c, "one\nchanged\nthree\nfour")).toEqual({ outdated: true, startLine: undefined, endLine: undefined });
  }
});
it("uses context to disambiguate repeated text, and never guesses between duplicates", () => {
  const c = anchorReview("a", base, "after", "one\ntwo\nthree", 2, 2);
  expect(locateReview(c, "two\none\ntwo\nthree")).toMatchObject({ startLine: 3, outdated: false });
  expect(locateReview(c, "two\nfour\ntwo")).toEqual({ outdated: false, startLine: undefined, endLine: undefined });
  expect(locateReview(c, null)).toEqual({ outdated: true });
});
it("requires the same base and rename identity, including after-side and legacy notes", () => {
  const c = anchorReview("a", base, "after", "one", 1, 1, "old");
  expect(reviewInDiff(c, "a", base, "old")).toBe(true);
  expect(reviewInDiff(c, "a", "b".repeat(40), "old")).toBe(false);
  expect(reviewInDiff(c, "a", base)).toBe(false);
  expect(reviewInDiff({ ...c, base: undefined }, "a", base, "old")).toBe(false);
});

it("handles long repeated quotations without guessing among overlapping matches", () => {
  const text = Array.from({ length: 20000 }, () => "same").join("\n");
  const c = anchorReview("a", base, "after", text, 10, 5000);
  expect(locateReview(c, text)).toEqual({ outdated: false, startLine: undefined, endLine: undefined });
  expect(locateReview({ ...c, lineText: "same\nsame\nend", endLine: 12 }, "same\nsame\nsame\nend")).toMatchObject({ startLine: 2, endLine: 4 });
});
