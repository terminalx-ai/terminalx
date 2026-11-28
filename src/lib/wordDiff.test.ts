// @vitest-environment node
import { describe, expect, it } from "vitest";
import { changeCount, wordDiff, wordTokens } from "./wordDiff";

const side = (parts: ReturnType<typeof wordDiff>, kind: "add" | "remove") =>
  parts.filter((part) => part.kind === "same" || part.kind === kind).map((part) => part.text).join("");

describe("wordDiff", () => {
  it("rebuilds both texts exactly", () => {
    for (const [before, after] of [
      ["i propose one check", "I propose one check: please"],
      ["line one\r\nline two\n", "line one\nline 2\n"],
      ["", "added"],
      ["removed", ""],
      ["नमस्ते दुनिया", "नमस्ते मित्र"],
      ["same", "same"],
    ]) {
      const parts = wordDiff(before, after);
      expect(side(parts, "remove")).toBe(before);
      expect(side(parts, "add")).toBe(after);
    }
  });

  it("marks whole words, not letters inside them", () => {
    expect(wordDiff("fix the prmpt now", "fix the prompt now")).toEqual([
      { kind: "same", text: "fix the " },
      { kind: "remove", text: "prmpt" },
      { kind: "add", text: "prompt" },
      { kind: "same", text: " now" },
    ]);
  });

  it("keeps a contraction and a hyphenated word whole", () => {
    expect(wordTokens("don't re-run")).toEqual(["don't", " ", "re-run"]);
  });

  it("replaces the middle of a very long text in one piece", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `a${index}`).join(" ");
    const after = Array.from({ length: 3000 }, (_, index) => `b${index}`).join(" ");
    const parts = wordDiff(before, after);
    expect(parts).toHaveLength(2);
    expect(side(parts, "add")).toBe(after);
  });

  it("counts each changed place once", () => {
    expect(changeCount(wordDiff("same words", "same words"))).toBe(0);
    expect(changeCount(wordDiff("teh cat sat on teh mat", "the cat sat on the mat"))).toBe(2);
  });
});
