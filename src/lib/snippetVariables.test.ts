import { describe, expect, it } from "vitest";
import { fillSnippet, snippetVariables } from "./snippetVariables";

describe("snippet variables", () => {
  it("lists each placeholder once, in order", () => {
    expect(snippetVariables("Fix {{file}} in {{ branch }}, then {{file}} again")).toEqual(["file", "branch"]);
    expect(snippetVariables("no {{}} or {{1bad}} here")).toEqual([]);
  });

  it("fills in one pass, so a value is never expanded", () => {
    expect(fillSnippet("{{a}} and {{b}}", { a: "{{b}}", b: "two" })).toBe("{{b}} and two");
  });

  it("keeps a placeholder left empty, and takes a value literally", () => {
    expect(fillSnippet("{{a}} {{b}}", { a: "$& one" })).toBe("$& one {{b}}");
    expect(fillSnippet("{{constructor}}", {})).toBe("{{constructor}}");
  });
});
