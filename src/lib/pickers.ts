/** The token around the caret that opens a picker: `/cmd` at position zero, or `@path` anywhere. */
export function tokenAtCaret(text: string, caret: number): { kind: "slash" | "mention"; start: number; query: string } | null {
  const before = text.slice(0, caret);
  if (before.startsWith("/") && !/\s/.test(before)) {
    return { kind: "slash", start: 0, query: before.slice(1) };
  }
  let i = before.length - 1;
  while (i >= 0 && !/\s/.test(before[i])) i--;
  const word = before.slice(i + 1);
  if (word.startsWith("@") && word.length >= 1) {
    return { kind: "mention", start: i + 1, query: word.slice(1) };
  }
  return null;
}
