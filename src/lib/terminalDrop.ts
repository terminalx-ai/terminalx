/**
 * What a drop on a terminal types. Paths are escaped the way Terminal.app and
 * iTerm escape them, which is also what the agent CLIs recognise as a dragged
 * file, and never contain a raw control character: a newline in a file's name
 * would otherwise be an Enter in a program that has no bracketed paste.
 */

import { isWindows } from "@/lib/platform";

/** Characters a shell reads as themselves. Everything above ASCII is left alone too. */
const SAFE = /[A-Za-z0-9_\-.,/:@+=%]/;
const NAMED: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** `path` as one shell word. */
export function shellQuotePath(path: string): string {
  if (!path) return "''";
  let out = "";
  for (const ch of path) {
    const code = ch.codePointAt(0)!;
    // Backslash-newline is a line continuation, so control characters go in $'…' instead
    // (C1 ones as their UTF-8 bytes: bash 3 has no \u).
    if (code >= 0x80 && code <= 0x9f) out += `$'\\xc2\\x${code.toString(16)}'`;
    else if (code < 0x20 || code === 0x7f) out += `$'${NAMED[ch] ?? `\\x${code.toString(16).padStart(2, "0")}`}'`;
    else if (code > 0x7f || SAFE.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/**
 * `path` as one PowerShell word: a single-quoted string, in which nothing is
 * expanded or run (`$`, `$(…)`, backticks and `;` are only characters).
 * PowerShell reads the typographic single quotes as quotes too, so each of
 * them is doubled as `'` is. A path with a control character (NTFS allows
 * DEL and the C1 range) cannot be typed as itself without one reaching the
 * terminal as a key: `null`.
 */
export function powershellQuotePath(path: string): string | null {
  if (!path || /[\x00-\x1f\x7f-\x9f]/.test(path)) return null;
  let out = "'";
  for (const ch of path) {
    if (ch === "'" || ch === "‘" || ch === "’" || ch === "‚" || ch === "‛") out += ch + ch;
    else out += ch;
  }
  return `${out}'`;
}

/**
 * `path` as one cmd.exe word: double-quoted, inside which `& | < > ^` are only
 * characters. cmd expands `%VAR%` even there and nothing escapes it, so a
 * path with `%` (or a control character) cannot be typed safely: `null`.
 * A Windows file name never holds `"`.
 */
export function cmdQuotePath(path: string): string | null {
  if (!path || /[%"\x00-\x1f\x7f-\x9f]/.test(path)) return null;
  return `"${path}"`;
}

/** Which shell's quoting dropped paths get: the shell the terminals run. */
export type QuoteStyle = "posix" | "powershell" | "cmd";

export const defaultQuoteStyle: QuoteStyle = isWindows ? "powershell" : "posix";

/**
 * The text typed for dropped files: each path quoted, a space after each, no
 * Enter. `null` when a path cannot be quoted safely for `style`'s shell.
 */
export function droppedPathsText(paths: readonly string[], style: QuoteStyle = defaultQuoteStyle): string | null {
  const quote = style === "cmd" ? cmdQuotePath : style === "powershell" ? powershellQuotePath : shellQuotePath;
  const quoted = paths.map(quote);
  if (quoted.some((path) => path === null)) return null;
  return quoted.map((path) => `${path} `).join("");
}

/** Why dropped paths that `droppedPathsText` refused for `style` were not typed. */
export function unquotableMessage(style: QuoteStyle): string {
  return style === "cmd"
    ? "That file's name can't be typed into this terminal's shell safely (cmd expands % in it). Rename it, or use PowerShell."
    : "That file's name holds a control character, so it can't be typed into this terminal safely. Rename it.";
}

/** More dragged text than this is refused, not typed. */
export const MAX_DROPPED_TEXT = 1024 * 1024;

const UNSAFE_TERMINAL_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Dragged text as it may be typed. It is somebody else's text, so it carries
 * no control characters: an escape could end a bracketed paste early and have
 * the rest read as keys. It carries no invisible or direction-changing
 * characters either, which would make what is typed differ from what is
 * seen. Lines stay lines only inside a bracketed paste; without one a
 * newline is an Enter, so the text goes in as a single line.
 */
export function droppedText(text: string, bracketed: boolean): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_TERMINAL_CONTROLS, "");
  // Not a regex: /\n+$/ retries from every newline of a long run that is not at the end.
  let end = clean.length;
  while (end > 0 && clean.charCodeAt(end - 1) === 0x0a) end--;
  const trimmed = clean.slice(0, end);
  return bracketed ? trimmed : trimmed.replace(/[\n\t]+/g, " ");
}

export interface SanitizedTerminalPaste {
  /** Sanitized text safe to pass to `term.paste()`. */
  text: string;
  /** Number of non-trailing lines in the sanitized text. */
  lines: number;
  /** True when the paste spans multiple lines and should be confirmed. */
  multiLine: boolean;
  /** True when control or invisible/bidi characters (e.g. ESC, CSI) were stripped. */
  strippedControls: boolean;
}

/**
 * Sanitize clipboard text before it reaches xterm: strips ESC (`\x1b`), C0/C1
 * controls (preventing `ESC [201~` / `CSI 201~` bracketed-paste breakout),
 * invisible/bidi characters, and trailing newlines.
 */
export function sanitizeTerminalPaste(raw: string, bracketed: boolean): SanitizedTerminalPaste {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const clean = normalized.replace(UNSAFE_TERMINAL_CONTROLS, "");
  const strippedControls = clean.length !== normalized.length;
  let end = clean.length;
  while (end > 0 && clean.charCodeAt(end - 1) === 0x0a) end--;
  const trimmed = clean.slice(0, end);
  const lines = trimmed ? trimmed.split("\n").length : 0;
  const text = bracketed ? trimmed : trimmed.replace(/[\n\t]+/g, " ");
  return { text, lines, multiLine: lines > 1, strippedControls };
}

/** Compact preview of sanitized paste text for the multi-line confirmation dialog. */
export function formatTerminalPastePreview(text: string, maxChars = 400): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
