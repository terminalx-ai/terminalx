/**
 * Codex's file citation marker (#776). Codex's file skills (spreadsheets,
 * documents, PDF, presentations, Google Drive) write
 * `:codex-file-citation{path="/abs/report.xlsx" purpose="output"}` in a reply:
 * on its own line for a file the agent made or edited (`purpose="output"`), or
 * in a sentence in place of the name of a file the answer used
 * (`purpose="source"`). Both chat renderers turn a well-formed marker into a
 * link to its file; a malformed one stays text.
 *
 * Grammar: `:codex-file-citation{` then `key="value"` pairs separated by
 * spaces (or commas), then `}`, all on one line. Values may also be in single
 * quotes or, without spaces, unquoted. There are no escapes, so a Windows path
 * keeps its backslashes. `path` is required; unknown keys are ignored.
 */

export const CODEX_FILE_CITATION_OPEN = ":codex-file-citation{";

export interface CodexFileCitation {
  /** An absolute path on the task host, or a web URL (Google Drive). */
  path: string;
  /** `output`: a file the agent made or edited. `source`: one the answer relied on. */
  purpose?: string;
  artifactKind?: string;
  sheet?: string;
  range?: string;
  pageNumber?: string;
  objectId?: string;
  objectKind?: string;
  /** A workbook object's label, e.g. a chart's title. */
  label?: string;
}

const KEYS: Record<string, keyof CodexFileCitation> = {
  path: "path",
  purpose: "purpose",
  artifact_kind: "artifactKind",
  sheet: "sheet",
  range: "range",
  page_number: "pageNumber",
  object_id: "objectId",
  object_kind: "objectKind",
  label: "label",
};

const SEPARATOR = /[ \t,]*/y;
const KEY = /[A-Za-z_][\w.-]*/y;
const EQUALS = /[ \t]*=[ \t]*/y;
const VALUE = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'=<>`{},]+)/y;
/** A scheme other than a Windows drive letter. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):/;
/** A limit on one marker, so a long line of braces costs little to reject. */
export const CODEX_FILE_CITATION_MAX_LENGTH = 8192;

function sticky(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** A path is a local path (absolute or relative), a `file:` URL, or a web URL; no other scheme. */
function citablePath(path: string): boolean {
  const scheme = path.match(SCHEME)?.[1]?.toLowerCase();
  return !scheme || scheme === "http" || scheme === "https" || scheme === "file";
}

/** The well-formed marker that starts exactly at `from`, and the index just past its `}`. */
export function matchCodexFileCitation(text: string, from = 0): { citation: CodexFileCitation; end: number } | null {
  if (!text.startsWith(CODEX_FILE_CITATION_OPEN, from)) return null;
  const limit = Math.min(text.length, from + CODEX_FILE_CITATION_MAX_LENGTH);
  const fields: Partial<Record<keyof CodexFileCitation, string>> = {};
  let at = from + CODEX_FILE_CITATION_OPEN.length;
  for (;;) {
    at += sticky(SEPARATOR, text, at)![0].length;
    if (at >= limit) return null;
    if (text[at] === "}") {
      at++;
      break;
    }
    const key = sticky(KEY, text, at);
    if (!key) return null;
    at += key[0].length;
    const equals = sticky(EQUALS, text, at);
    if (!equals) return null;
    at += equals[0].length;
    const value = sticky(VALUE, text, at);
    if (!value) return null;
    at += value[0].length;
    if (at > limit) return null;
    // The first value given for a key wins, as in an HTML tag.
    const field = KEYS[key[0]];
    if (field && fields[field] === undefined) fields[field] = value[1] ?? value[2] ?? value[3];
  }
  const path = fields.path?.trim();
  if (!path || !citablePath(path)) return null;
  const citation: CodexFileCitation = { path };
  for (const [field, value] of Object.entries(fields) as [keyof CodexFileCitation, string][]) {
    const trimmed = value.trim();
    if (field !== "path" && trimmed) citation[field] = trimmed;
  }
  return { citation, end: at };
}

export interface CodexFileCitationPart {
  text: string;
  citation?: CodexFileCitation;
}

/** Split plain text into prose and well-formed markers, keeping every character. */
export function codexFileCitationParts(text: string): CodexFileCitationPart[] {
  const parts: CodexFileCitationPart[] = [];
  let from = 0;
  let search = 0;
  for (;;) {
    const at = text.indexOf(CODEX_FILE_CITATION_OPEN, search);
    if (at < 0) break;
    const match = matchCodexFileCitation(text, at);
    if (!match) {
      search = at + 1;
      continue;
    }
    if (at > from) parts.push({ text: text.slice(from, at) });
    parts.push({ text: text.slice(at, match.end), citation: match.citation });
    from = search = match.end;
  }
  if (from < text.length || !parts.length) parts.push({ text: text.slice(from) });
  return parts;
}

const GOOGLE_FILES: [RegExp, string][] = [
  [/^\/spreadsheets\//, "Google Sheets file"],
  [/^\/document\//, "Google Docs file"],
  [/^\/presentation\//, "Google Slides file"],
  [/^\/forms\//, "Google Forms file"],
  [/^\/drawings\//, "Google Drawings file"],
];

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A Google Drive file's kind, for a URL that names no file: "Google Sheets file". */
export function googleFileLabel(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.hostname === "docs.google.com") {
    // Account-scoped links put /u/0 first.
    const path = url.pathname.replace(/^\/u\/\d+(?=\/)/, "");
    return GOOGLE_FILES.find(([pattern]) => pattern.test(path))?.[1] ?? "Google Docs file";
  }
  if (url.hostname === "drive.google.com") return "Google Drive file";
  return undefined;
}

/** The name to show for a cited file: its last path segment, or a short label for a URL that has none. */
export function codexFileCitationName(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    const google = googleFileLabel(path);
    if (google) return google;
    try {
      const url = new URL(path);
      const segment = url.pathname.split("/").filter(Boolean).pop();
      return segment ? decoded(segment) : url.hostname;
    } catch {
      return path;
    }
  }
  if (/^file:/i.test(path)) {
    const segment = path.replace(/[?#].*$/, "").split("/").filter(Boolean).pop();
    return segment ? decoded(segment) : path;
  }
  const segment = path.split(/[\\/]/).filter(Boolean).pop();
  return segment ?? path;
}

/** Where a cited place is within its file: `Revenue Model!C27`, a chart's label, `p. 3`. */
export function codexFileCitationLocator(citation: CodexFileCitation): string[] {
  const out: string[] = [];
  if (citation.sheet && citation.range) out.push(`${citation.sheet}!${citation.range}`);
  else if (citation.sheet ?? citation.range) out.push((citation.sheet ?? citation.range)!);
  if (citation.label) out.push(citation.label);
  if (citation.pageNumber) out.push(`p. ${citation.pageNumber}`);
  return out;
}

/** The link's text: `report.xlsx · Revenue Model!C27`. */
export function codexFileCitationLabel(citation: CodexFileCitation): string {
  return [codexFileCitationName(citation.path), ...codexFileCitationLocator(citation)].join(" · ");
}

/** A cited file the agent made or edited, which reads as a deliverable rather than a reference. */
export function isCodexFileOutput(citation: CodexFileCitation): boolean {
  return citation.purpose?.toLowerCase() === "output";
}

/**
 * A streaming reply without a marker that is still being written: the open
 * marker on the last line with no closing `}` yet, or the start of
 * `:codex-file-citation{` at the very end. The marker then appears once,
 * whole, instead of as raw text that turns into a link.
 */
export function withoutPartialCodexFileCitation(text: string): string {
  const at = text.lastIndexOf(CODEX_FILE_CITATION_OPEN);
  if (at >= 0 && text.length - at <= CODEX_FILE_CITATION_MAX_LENGTH && !closesOnItsLine(text, at + CODEX_FILE_CITATION_OPEN.length)) return text.slice(0, at);
  for (let length = Math.min(CODEX_FILE_CITATION_OPEN.length - 1, text.length); length >= 2; length--) {
    if (text.endsWith(CODEX_FILE_CITATION_OPEN.slice(0, length))) return text.slice(0, -length);
  }
  return text;
}

/** Whether a `}` outside quotes, or the end of the line, follows `from`. */
function closesOnItsLine(text: string, from: number): boolean {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || c === "\r") return true;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "}") return true;
  }
  return false;
}
