/** Hide harness context from prompts, including old event logs lacking meta
 * flags. Leave quoted code and unrelated XML as the reader typed them. */
export function withoutHarnessBlocks(text: string): string {
  if (!text.includes("<task-notification") && !text.includes("<system-reminder")) return text;
  const markers = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)|(`+)|<(\/?)(task-notification|system-reminder)(?=[\s/>])[^>]*>/gm;
  const hidden: string[] = [];
  const output: string[] = [];
  let fence = "";
  let inline = "";
  let from = 0;
  let changed = false;
  for (const match of text.matchAll(markers)) {
    const end = match.index + match[0].length;
    if (match[1] && !hidden.length && !inline) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = "";
      continue;
    }
    if (fence) continue;
    if (match[3] && !hidden.length) {
      if (inline === match[3]) inline = "";
      else if (!inline) {
        // An unmatched backtick is prose, not an inline code span.
        const remaining = /`+/g;
        remaining.lastIndex = end;
        let closing: RegExpExecArray | null;
        while ((closing = remaining.exec(text))) {
          if (closing[0] === match[3]) { inline = match[3]; break; }
        }
      }
      continue;
    }
    if (inline || !match[5]) continue;
    if (!hidden.length) {
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      if (/^(?: {4}|\t)/.test(text.slice(lineStart, match.index))) continue;
    }
    const closing = !!match[4];
    const tag = match[5];
    if (!closing) {
      if (!hidden.length) {
        output.push(text.slice(from, match.index));
        changed = true;
      }
      if (!/\/\s*>$/.test(match[0])) hidden.push(tag);
      else if (!hidden.length) from = end;
    } else if (hidden[hidden.length - 1] === tag) {
      hidden.pop();
      if (!hidden.length) from = end;
    }
  }
  if (!changed) return text;
  // An unfinished block is still harness context; never leak its trailing ids.
  if (!hidden.length) output.push(text.slice(from));
  return output.join("").trim();
}

/**
 * A command run through Claude Code's `!` shell passthrough (#1294), as its
 * transcript records it: `<bash-input>` in one record, then
 * `<bash-stdout>`, `<bash-stderr>` and, from some versions, `<bash-exit-code>`
 * in the next; or all of them in one. Parts a record does not hold are absent.
 */
export interface ShellRecord {
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/** What the CLI writes for a command that printed nothing: nothing to draw. */
const NO_OUTPUT = "(Bash completed with no output)";

/** Terminal escape sequences (colours, cursor moves, titles): the chat draws the text they decorate. */
export function withoutAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-Z\\-_]/g, "");
}

function output(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const clean = withoutAnsi(text).replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  return clean === NO_OUTPUT ? "" : clean;
}

/**
 * The shell command a user record is, when the record is nothing else: a
 * message that only mentions the tags (in prose or a code fence) is not one.
 *
 * A linear scan, not a backtracking pattern: output can be megabytes. Parts
 * come in the CLI's order; output that itself holds its closing tag is kept
 * whole, as each part ends at the last closing tag of its kind.
 */
export function shellRecord(text: string): ShellRecord | null {
  if (!text.includes("<bash-")) return null;
  const parts: Partial<Record<"input" | "stdout" | "stderr" | "exit-code", string>> = {};
  let at = skipSpace(text, 0);
  for (const [tag, last] of [["input", false], ["stdout", true], ["stderr", true], ["exit-code", false]] as const) {
    const open = `<bash-${tag}>`;
    if (!text.startsWith(open, at)) continue;
    const close = `</bash-${tag}>`;
    const from = at + open.length;
    const end = last ? text.lastIndexOf(close) : text.indexOf(close, from);
    if (end < from) return null;
    parts[tag] = text.slice(from, end);
    at = skipSpace(text, end + close.length);
  }
  if (at !== text.length || !Object.keys(parts).length) return null;
  const exitCode = parts["exit-code"]?.trim();
  if (exitCode !== undefined && !/^-?\d+$/.test(exitCode)) return null;
  const record: ShellRecord = {};
  if (parts.input !== undefined) record.command = parts.input.trim();
  if (parts.stdout !== undefined) record.stdout = output(parts.stdout);
  if (parts.stderr !== undefined) record.stderr = output(parts.stderr);
  if (exitCode !== undefined) record.exitCode = Number(exitCode);
  return record;
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}

/** Lines of a `!` command's output, and characters, shown before "Show more": the desktop and the phone fold at the same place. */
export const SHELL_FOLD_LINES = 12;
const SHELL_FOLD_CHARS = 2000;

/** The start of a long output, and whether anything was left out of it. */
export function foldShellOutput(text: string): { shown: string; folded: boolean } {
  // The newline that ends the last line shown, if the text goes past it.
  let end = -1;
  for (let line = 0; line < SHELL_FOLD_LINES; line++) {
    end = text.indexOf("\n", end + 1);
    if (end === -1) break;
  }
  const cut = Math.min(end === -1 ? text.length : end, SHELL_FOLD_CHARS);
  return cut >= text.length ? { shown: text, folded: false } : { shown: text.slice(0, cut), folded: true };
}
