import { describe, expect, it } from "vitest";
import { isExternalChatUrl, textLinks } from "./textLinks";

describe("chat text links", () => {
  it("preserves text and URL punctuation, ports, queries, fragments, and parentheses", () => {
    const text = "See (https://example.com/a_(b)), http://localhost:4173/path?q=a%20b#L2.\nThen www.example.com.";
    const parts = textLinks(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts.filter((part) => part.href).map((part) => part.href)).toEqual(["https://example.com/a_(b)", "http://localhost:4173/path?q=a%20b#L2", "http://www.example.com"]);
  });
  it("recognises email, telephone, and file URLs but leaves executable schemes inert", () => {
    const parts = textLinks("Contact me@example.com or tel:+15551234567. Read file:///tmp/report.md#L12. javascript:alert(1) data:text/html,hello");
    expect(parts.filter((part) => part.href).map((part) => part.href)).toEqual(["mailto:me@example.com", "tel:+15551234567", "file:///tmp/report.md#L12"]);
    expect(isExternalChatUrl("https://example.com")).toBe(true);
    expect(isExternalChatUrl("file:///tmp/report.md")).toBe(false);
    expect(isExternalChatUrl("javascript:alert(1)")).toBe(false);
  });
});
