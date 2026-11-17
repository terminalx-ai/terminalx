import { describe, expect, it } from "vitest";
import { nearQueries, nearText } from "./projectSearch";

const off = { caseSensitive: false, wholeWord: false, regex: false };

describe("what a search that found nothing was near (design 07.09)", () => {
  it("looks for the same text with the toggles off first, when any is on", () => {
    expect(nearQueries("archive", { ...off, wholeWord: true })).toEqual([{ query: "archive", regex: false, byToggles: true }]);
    expect(nearQueries("  ", { ...off, wholeWord: true })).toEqual([]);
  });

  it("then for a name's words in any case, with or without a separator", () => {
    const loose = { query: "archive[_\\-. ]?script", regex: true, byToggles: false };
    expect(nearQueries("archive_script", off)).toEqual([loose]);
    expect(nearQueries("archiveScript", off)).toEqual([{ ...loose, query: "archive[_\\-. ]?Script" }]);
    expect(nearQueries("archive-script", { ...off, caseSensitive: true })).toEqual([{ query: "archive-script", regex: false, byToggles: true }, loose]);
    expect(new RegExp(loose.query, "i").test("const archiveScript = 1")).toBe(true);
    expect(new RegExp(loose.query, "i").test("ARCHIVE_SCRIPT")).toBe(true);
  });

  it("leaves one word, and anything that is not plainly a name, alone", () => {
    expect(nearQueries("nothing", off)).toEqual([]);
    expect(nearQueries("foo(bar)", off)).toEqual([]);
    expect(nearQueries("a+b c", off)).toEqual([]);
  });

  it("says the match as the code writes it: widened to the whole name", () => {
    expect(nearText({ text: "export const archiveScript = defineScript();", matches: [[13, 20]] })).toBe("archiveScript");
    expect(nearText({ text: "run($archive_script);", matches: [[5, 12]] })).toBe("$archive_script");
    expect(nearText({ text: "x", matches: [] })).toBeNull();
    expect(nearText({ text: "a".repeat(200), matches: [[0, 3]] })).toBeNull();
  });
});
