import { Marked, type Token, type Tokens } from "marked";

const parser = new Marked({ gfm: true, breaks: true });
const MAX_CHARS = 1600;
const MAX_LINES = 32;

// Keep individual native text layouts small, including a single very long
// prompt, reasoning message, paragraph, or fenced code block. Preserve every
// character and prefer whitespace boundaries so links and words stay together.
export function textChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_CHARS, text.length);
    let lines = 0;
    for (let i = start; i < end; i++) {
      if (text[i] === "\n" && ++lines === MAX_LINES) { end = i + 1; break; }
    }
    if (end < text.length && text[end - 1] !== "\n") {
      const boundary = text.slice(start, end).search(/\s+\S*$/);
      if (boundary > 0) end = start + boundary + 1;
      // Do not divide a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function markdownTokens(text: string): Token[] {
  return parser.lexer(text);
}

function inlineChunks(tokens: Token[]): Token[][] {
  const result: Token[][] = [];
  let current: Token[] = [];
  let size = 0;
  let lines = 0;
  for (const token of tokens) {
    const parts: Token[] = "tokens" in token && token.tokens?.length
      ? inlineChunks(token.tokens).map((tokens) => ({ ...token, tokens }))
      : "text" in token && typeof token.text === "string"
        ? textChunks(token.text).map((text) => ({ ...token, text }))
        : [token];
    for (const part of parts) {
      const text = inlineText(part);
      const length = text.length;
      const newlines = text.split("\n").length - 1;
      if (current.length && (size + length > MAX_CHARS || lines + newlines > MAX_LINES)) {
        result.push(current); current = []; size = 0; lines = 0;
      }
      current.push(part); size += length; lines += newlines;
    }
  }
  if (current.length) result.push(current);
  return result;
}

function inlineText(token: Token): string {
  if ("tokens" in token && token.tokens?.length) return token.tokens.map(inlineText).join("");
  if (token.type === "br") return "\n";
  return "text" in token ? token.text : token.raw;
}

// Parse the complete message before splitting: reference links and inline
// formatting must retain their context across virtualized rows. Lists keep
// their numbering, tables keep their header, and code keeps its language.
export function markdownBlocks(text: string): Token[] {
  return markdownTokens(text).flatMap(splitBlock);
}

function splitBlock(token: Token): Token[] {
  switch (token.type) {
    case "space": case "def": return [];
    case "paragraph": case "text":
      return token.tokens?.length ? inlineChunks(token.tokens).map((tokens) => ({ ...token, tokens })) : [token];
    case "code":
      return token.text ? textChunks(token.text).map((text) => ({ ...token, text })) : [token];
    case "list":
      return token.items.map((item: Tokens.ListItem, index: number) => ({ ...token, start: token.ordered ? Number(token.start) + index : "", items: [item] }));
    case "table": {
      const table = token as Tokens.Table;
      const blocks: Token[] = [];
      for (let i = 0; i < Math.max(1, table.rows.length); i += 8) blocks.push({ ...table, rows: table.rows.slice(i, i + 8) });
      return blocks;
    }
    case "blockquote":
      return (token.tokens ?? []).flatMap(splitBlock).map((block: Token) => ({ ...token, tokens: [block] }));
    default: return [token];
  }
}
