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
