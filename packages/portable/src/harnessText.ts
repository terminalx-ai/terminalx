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

const SHELL_RECORD = new RegExp(
  "^\\s*" +
  "(?:<bash-input>([\\s\\S]*?)</bash-input>\\s*)?" +
  "(?:<bash-stdout>([\\s\\S]*?)</bash-stdout>\\s*)?" +
  "(?:<bash-stderr>([\\s\\S]*?)</bash-stderr>\\s*)?" +
  "(?:<bash-exit-code>\\s*(-?\\d+)\\s*</bash-exit-code>\\s*)?$",
);

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
 */
export function shellRecord(text: string): ShellRecord | null {
  if (!text.includes("<bash-")) return null;
  const match = SHELL_RECORD.exec(text);
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [, command, stdout, stderr, exitCode] = match;
  const record: ShellRecord = {};
  if (command !== undefined) record.command = command.trim();
  if (stdout !== undefined) record.stdout = output(stdout);
  if (stderr !== undefined) record.stderr = output(stderr);
  if (exitCode !== undefined) record.exitCode = Number(exitCode);
  return record;
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
