import remend from "remend";
import {
  CODEX_FILE_CITATION_MAX_LENGTH,
  CODEX_FILE_CITATION_OPEN,
  codexFileCitationLabel,
  codexFileCitationName,
  codexFileCitationParts,
  googleFileLabel,
  isCodexFileOutput,
  matchCodexFileCitation,
} from "@terminalx/portable/codexCitations";
import { CITATION_DATA, citedFileHref, routedChatHref } from "./chatLinks";

/*
 * Codex's `:codex-file-citation{…}` markers in rendered Markdown (#776). The
 * marker is recognised while Markdown is tokenised, like an autolink, so what
 * is inside it (a path's `*` or `_`, a Drive URL) is never read as emphasis or
 * as an autolink of its own, and code spans and fences, which are tokenised
 * first, keep it literal. A well-formed marker becomes a link to its file,
 * with the same routing as a Markdown link to that path; anything else stays
 * the text it was.
 */

// The few micromark and mdast shapes this needs, without depending on their packages.
type Code = number | null;
type State = (code: Code) => State | undefined;
interface Effects {
  enter(type: string): unknown;
  exit(type: string): unknown;
  consume(code: Code): void;
}
interface Token {
  type: string;
}
interface MdastNode {
  type: string;
  [key: string]: unknown;
}
interface CompileContext {
  stack: MdastNode[];
  enter(node: MdastNode, token: Token): void;
  exit(token: Token): void;
  sliceSerialize(token: Token): string;
}

const TOKEN = "codexFileCitation";
const COLON = 58;
const TAB = -2;
const VIRTUAL_SPACE = -1;

function tokenizeCitation(effects: Effects, ok: State, nok: State): State {
  let raw = "";
  const inside: State = (code) => {
    // A marker is on one line: a line ending or the end of the text means it never closed.
    if (code === null || code < TAB) return nok(code);
    const char = code === TAB ? "\t" : code === VIRTUAL_SPACE ? "" : String.fromCharCode(code);
    if (raw.length < CODEX_FILE_CITATION_OPEN.length ? char !== CODEX_FILE_CITATION_OPEN[raw.length] : raw.length >= CODEX_FILE_CITATION_MAX_LENGTH) return nok(code);
    if (!raw) effects.enter(TOKEN);
    effects.consume(code);
    raw += char;
    // The first `}` that completes a well-formed marker ends it; an earlier one is inside a quoted value.
    if (char === "}" && raw.length > CODEX_FILE_CITATION_OPEN.length && matchCodexFileCitation(raw)?.end === raw.length) {
      effects.exit(TOKEN);
      return ok;
    }
    return inside;
  };
  return inside;
}

const syntax = { text: { [COLON]: { name: TOKEN, tokenize: tokenizeCitation } } };

const fromMarkdown = {
  enter: {
    [TOKEN](this: CompileContext, token: Token) {
      const raw = this.sliceSerialize(token);
      const match = matchCodexFileCitation(raw);
      // A link cannot hold another link, and an image's text is only its alt text.
      const nested = this.stack.some((node) => node.type === "link" || node.type === "linkReference" || node.type === "image" || node.type === "imageReference");
      if (!match || nested) {
        this.enter({ type: "text", value: raw }, token);
        return;
      }
      const { citation } = match;
      this.enter({
        type: "link",
        // Routed like every chat link, so the sanitiser keeps any path; an output also says it is one.
        url: isCodexFileOutput(citation) ? citedFileHref(citation.path) : routedChatHref(citation.path),
        title: citation.path,
        data: { [CITATION_DATA]: true },
        children: [{ type: "text", value: codexFileCitationLabel(citation) }],
      }, token);
    },
  },
  exit: {
    [TOKEN](this: CompileContext, token: Token) {
      this.exit(token);
    },
  },
};

/** A remark plugin: recognise Codex file citations while the Markdown is parsed. */
export function remarkCodexFileCitations(this: { data(): unknown }) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}

const HELD = /\uE000(\d+)\uE001/g;

/**
 * Streamdown's completion of unfinished Markdown in a streaming reply
 * (remend), without reading into a whole citation: a path's lone `*`, `_`,
 * `[` or backtick would otherwise look unclosed and gain a closing `*` or a
 * `](…)` after it until the reply settles. Each marker stands aside as an
 * inert placeholder while remend runs, and comes back unchanged. Both happen
 * here, around the one call, because remend can return before a handler of
 * its own would have put them back. Streamdown is then told not to run it.
 */
export function completeStreamingMarkdown(text: string): string {
  // A reply that already holds the placeholder characters is completed as it is.
  if (!text.includes(CODEX_FILE_CITATION_OPEN) || /[\uE000\uE001]/.test(text)) return remend(text);
  const markers: string[] = [];
  const held = codexFileCitationParts(text).map((part) => part.citation ? `\uE000${markers.push(part.text) - 1}\uE001` : part.text).join("");
  return remend(held).replace(HELD, (whole, index: string) => markers[Number(index)] ?? whole);
}

export type CitedFileKind = "spreadsheet" | "presentation" | "pdf" | "image" | "document" | "file";

const GOOGLE_KINDS: Record<string, CitedFileKind> = {
  "Google Sheets file": "spreadsheet",
  "Google Docs file": "document",
  "Google Slides file": "presentation",
};
const EXTENSION_KINDS: Record<string, CitedFileKind> = Object.fromEntries([
  ...["xlsx", "xlsm", "xls", "csv", "tsv", "ods", "numbers"].map((ext) => [ext, "spreadsheet"]),
  ...["pptx", "ppt", "key", "odp"].map((ext) => [ext, "presentation"]),
  ["pdf", "pdf"],
  ...["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].map((ext) => [ext, "image"]),
  ...["docx", "doc", "odt", "rtf", "pages", "md", "txt"].map((ext) => [ext, "document"]),
]);

/** What kind of file a cited file's chip shows an icon for, Drive files included. */
export function citedFileKind(href: string): CitedFileKind {
  const google = googleFileLabel(href);
  if (google) return GOOGLE_KINDS[google] ?? "file";
  const name = codexFileCitationName(href);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXTENSION_KINDS[ext] ?? "file";
}
