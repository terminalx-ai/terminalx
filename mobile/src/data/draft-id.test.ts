import { describe, expect, it, vi } from "vitest";
import { draftContent, draftIdFor, readDraftId } from "./draft-id";

const uuids = vi.hoisted(() => ({ made: 0 }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `uuid-${++uuids.made}` }));

describe("a draft's id (#675)", () => {
  it("stays with what would be sent and changes with it", () => {
    const first = draftIdFor(null, draftContent("agent", "Ship it", []));
    expect(draftIdFor(first, draftContent("agent", "Ship it", []))).toBe(first);
    for (const other of [
      draftContent("agent", "Ship it now", []),
      draftContent("note", "Ship it", []),
      draftContent("agent", "Ship it", ["file:///brief.pdf:1:0"]),
    ]) {
      expect(draftIdFor(first, other).id).not.toBe(first.id);
    }
  });

  it("reads back only an id this phone saved", () => {
    const saved = draftIdFor(null, draftContent("agent", "Ship it", []));
    expect(readDraftId(JSON.stringify(saved))).toEqual(saved);
    for (const value of [null, "", "not json", "null", "[]", JSON.stringify({ id: "" , draft: "x" }), JSON.stringify({ id: 1, draft: "x" }), JSON.stringify({ id: "a" })]) {
      expect(readDraftId(value)).toBeNull();
    }
  });
});
