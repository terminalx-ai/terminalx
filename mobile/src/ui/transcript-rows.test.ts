import { describe, expect, it } from "vitest";
import type { Token } from "marked";
import type { Turn } from "@terminalx/portable/transcript";
import { markdownBlocks, textChunks } from "./markdown-blocks";
import { turnRows } from "./transcript-rows";

const turn: Turn = { key: "t1", seq: 1, ts: "", prompt: { text: "Prompt", seq: 1, ts: "" }, work: [], toolCount: 0, editedFiles: 0, live: false };
const visibleText = (token: Token): string => "tokens" in token && token.tokens?.length ? token.tokens.map(visibleText).join("") : token.type === "br" ? "\n" : "text" in token ? token.text : token.raw;

describe("transcript virtualization units", () => {
  it("breaks a long turn into independently keyed blocks without losing content", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const rows = turnRows({ ...turn, work: [
      { kind: "text", key: "a2", seq: 2, text },
      { kind: "reasoning", key: "r3", seq: 3, text: "Thinking.\n".repeat(300) },
    ], finalText: "**Final answer**" });
    expect(rows[0]).toMatchObject({ kind: "prompt", text: "Prompt", startsTurn: true });
    expect(rows.filter((row) => row.kind === "markdown").map((row) => visibleText(row.token))).toEqual(["Paragraph one.", "Paragraph two.", "Paragraph three.", "Final answer"]);
    expect(rows.flatMap((row) => row.kind === "work" && row.item.kind === "reasoning" ? [row.item.text] : []).join("")).toBe("Thinking.\n".repeat(300));
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows.filter((row) => row.startsTurn)).toHaveLength(1);
  });

  it("keeps existing keys when output streams and earlier context arrives", () => {
    const work = { kind: "text" as const, key: "a2", seq: 2, text: "First paragraph.\n\nSecond" };
    const before = turnRows({ ...turn, work: [work] });
    const after = turnRows({ ...turn, work: [{ ...work, text: `${work.text} paragraph.\n\nThird.` }] });
    expect(after.slice(0, before.length).map((row) => row.key)).toEqual(before.map((row) => row.key));
    const orphan = turnRows({ ...turn, key: "t2", seq: 2, prompt: undefined, work: [work] });
    expect(orphan[0].key).toBe(before[1].key);
  });
});

describe("large individual messages", () => {
  it("bounds prompt/reasoning text by characters and lines, preserving Unicode and whitespace", () => {
    for (const text of ["word ".repeat(3000), "line\n".repeat(300), "🚀".repeat(3000), "x".repeat(5000)]) {
      const chunks = textChunks(text);
      expect(chunks.join("")).toBe(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1600);
        expect(chunk.split("\n").length).toBeLessThanOrEqual(33);
        expect(chunk.isWellFormed()).toBe(true);
      }
    }
  });

  it("splits fenced code without dropping lines or its language", () => {
    const code = "const value = 42;\n".repeat(300);
    const blocks = markdownBlocks(`\`\`\`ts\n${code}\`\`\``);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((token) => token.type === "code" && token.lang === "ts")).toBe(true);
    expect(blocks.map(visibleText).join("")).toBe(code.trimEnd());
  });

  it("retains inline formatting and reference links across a split paragraph", () => {
    const text = "formatted words ".repeat(400).trimEnd();
    const blocks = markdownBlocks(`**${text}** [Reference][ref]\n\n[ref]: https://example.com/path`);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map(visibleText).join("")).toBe(`${text} Reference`);
    const tokens = blocks.flatMap((token) => "tokens" in token ? token.tokens ?? [] : []);
    expect(tokens.filter((token) => token.type === "strong").length).toBeGreaterThan(1);
    expect(tokens.find((token) => token.type === "link")).toMatchObject({ href: "https://example.com/path" });
  });

  it("keeps ordered list numbering and table headers when splitting large structures", () => {
    const list = markdownBlocks(Array.from({ length: 100 }, (_, i) => `${i + 5}. Item ${i}`).join("\n"));
    expect(list).toHaveLength(100);
    expect(list.map((token) => token.type === "list" ? token.start : null)).toEqual(Array.from({ length: 100 }, (_, i) => i + 5));
    const table = markdownBlocks(`| Name | Value |\n| --- | --- |\n${Array.from({ length: 100 }, (_, i) => `| Row ${i} | ${i} |`).join("\n")}`);
    expect(table.length).toBeGreaterThan(1);
    expect(table.every((token) => token.type === "table" && token.header[0].text === "Name" && token.rows.length <= 8)).toBe(true);
    expect(table.flatMap((token) => token.type === "table" ? token.rows : [])).toHaveLength(100);
  });
});
