import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { docEqualsString } from "./EditorPane";

describe("docEqualsString", () => {
  it("detects length differences in O(1) without flattening", () => {
    const doc = Text.of(["hello", "world"]);
    expect(docEqualsString(doc, "hello\nworld!")).toBe(false);
    expect(docEqualsString(doc, "hello")).toBe(false);
  });

  it("matches identical multi-line ropes accurately", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}: some content here`);
    const text = lines.join("\n");
    const doc = Text.of(lines);
    expect(docEqualsString(doc, text)).toBe(true);
  });

  it("detects same-length mutations without flattening the whole doc", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}: some content here`);
    const doc = Text.of(lines);
    const mutated = [...lines];
    mutated[250] = mutated[250].replace("some", "XXXX");
    expect(docEqualsString(doc, mutated.join("\n"))).toBe(false);
  });

  it("handles empty documents", () => {
    expect(docEqualsString(Text.empty, "")).toBe(true);
    expect(docEqualsString(Text.empty, "a")).toBe(false);
  });
});
