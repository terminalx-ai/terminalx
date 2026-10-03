/**
 * What a drop on a terminal types. Paths are escaped the way Terminal.app and
 * iTerm escape them, which is also what the agent CLIs recognise as a dragged
 * file, and never contain a raw control character: a newline in a file's name
 * would otherwise be an Enter in a program that has no bracketed paste.
 */

/** Characters a shell reads as themselves. Everything above ASCII is left alone too. */
const SAFE = /[A-Za-z0-9_\-.,/:@+=%]/;
const NAMED: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** `path` as one shell word. */
export function shellQuotePath(path: string): string {
  if (!path) return "''";
  let out = "";
  for (const ch of path) {
    const code = ch.codePointAt(0)!;
    // Backslash-newline is a line continuation, so control characters go in $'…' instead.
    if (code < 0x20 || code === 0x7f) out += `$'${NAMED[ch] ?? `\\x${code.toString(16).padStart(2, "0")}`}'`;
    else if (code > 0x7f || SAFE.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/** The text typed for dropped files: each path quoted, a space after each, no Enter. */
export function droppedPathsText(paths: readonly string[]): string {
  return paths.map((path) => `${shellQuotePath(path)} `).join("");
}
