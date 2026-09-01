import { describe, expect, it } from "vitest";
import { chunkStream } from "@/lib/markdownChunks";

describe("chunkStream", () => {
  it("leaves short text whole", () => {
    expect(chunkStream("hello\n\nworld")).toEqual(["hello\n\nworld"]);
  });
  it("splits long text at paragraph breaks and keeps every character", () => {
    const para = "lorem ipsum dolor sit amet ".repeat(20) + "\n\n";
    const text = para.repeat(40);
    const chunks = chunkStream(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("\n\n")).toBe(true);
  });
  it("never splits inside a code fence", () => {
    const code = "```ts\n" + "const x = 1;\n".repeat(600) + "```\n\n";
    const text = "intro\n\n" + code + "after\n\n".repeat(400);
    const chunks = chunkStream(text);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect((c.match(/```/g) ?? []).length % 2).toBe(0);
  });
});
