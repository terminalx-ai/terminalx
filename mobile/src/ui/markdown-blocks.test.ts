import { expect, it } from "vitest";
import type { Token } from "marked";
import { markdownBlocks, markdownTokens } from "./markdown-blocks";

const inline = (text: string): Token[] => (markdownTokens(text)[0] as { tokens?: Token[] }).tokens ?? [];

it("reads a Codex file citation as one token, before emphasis and autolinks touch its path (#776)", () => {
  const drive = ':codex-file-citation{path="https://docs.google.com/spreadsheets/d/1Ab_c*d*/edit" purpose="output"}';
  expect(inline(drive)).toEqual([expect.objectContaining({ type: "codexFileCitation", raw: drive, citation: { path: "https://docs.google.com/spreadsheets/d/1Ab_c*d*/edit", purpose: "output" } })]);
  const sentence = inline('The review of :codex-file-citation{path="/abs/my *draft*.xlsx" sheet="Revenue Model" range="C27"} is due *Friday*.');
  expect(sentence.map((token) => token.type)).toEqual(["text", "codexFileCitation", "text", "em", "text"]);
});

it("leaves the marker literal in code and when it is malformed", () => {
  const marker = ':codex-file-citation{path="/abs/a.xlsx"}';
  expect(inline("`" + marker + "`").map((token) => token.type)).toEqual(["codespan"]);
  expect(markdownTokens("```\n" + marker + "\n```")[0]).toEqual(expect.objectContaining({ type: "code", text: marker }));
  expect(inline(':codex-file-citation{purpose="output"} and :codex-file-citation{path="/abs/a.xlsx"').some((token) => token.type === "codexFileCitation")).toBe(false);
});

it("keeps a citation whole when a long paragraph is split into rows", () => {
  const marker = ':codex-file-citation{path="/abs/report.xlsx" purpose="source"}';
  const blocks = markdownBlocks(`${"word ".repeat(400)}${marker} ${"word ".repeat(400)}`);
  const citations = blocks.flatMap((block) => (block as { tokens?: Token[] }).tokens ?? []).filter((token) => token.type === "codexFileCitation");
  expect(citations).toEqual([expect.objectContaining({ raw: marker })]);
});
