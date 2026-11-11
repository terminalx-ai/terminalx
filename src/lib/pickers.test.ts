import { describe, expect, it } from "vitest";
import { tokenAtCaret } from "@/lib/pickers";

describe("tokenAtCaret", () => {
  it("finds a slash command only at the start", () => {
    expect(tokenAtCaret("/rev", 4)).toEqual({ kind: "slash", start: 0, query: "rev" });
    expect(tokenAtCaret("fix /rev", 8)).toBeNull();
    expect(tokenAtCaret("/review now", 11)).toBeNull();
  });
  it("finds an @ mention around the caret and ignores emails", () => {
    expect(tokenAtCaret("see @src/ap", 11)).toEqual({ kind: "mention", start: 4, query: "src/ap" });
    expect(tokenAtCaret("mail me@x.com", 13)).toBeNull();
    expect(tokenAtCaret("@", 1)).toEqual({ kind: "mention", start: 0, query: "" });
  });
});

it("recognizes PR numbers, titles and authors at the caret, without opening for embedded hashes", () => {
  for (const query of ["", "12", "parser", "alice"]) expect(tokenAtCaret(`Review #${query}`, 8 + query.length)).toEqual({ kind: "pr", start: 7, query });
  expect(tokenAtCaret("sha#12", 6)).toBeNull();
  expect(tokenAtCaret("#12 rest", 3)).toEqual({ kind: "pr", start: 0, query: "12" });
});
