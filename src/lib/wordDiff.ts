/** One run of a word-level comparison. */
export interface WordDiffPart {
  kind: "same" | "add" | "remove";
  text: string;
}

/** Past this many changed words on a side, the middle is shown as one replacement. */
const MAX_COMPARED_TOKENS = 2000;

/** Words (with their apostrophes and hyphens), whitespace runs, and single other characters. */
export function wordTokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{M}\p{N}_]+(?:['’-][\p{L}\p{M}\p{N}_]+)*|[\s\S]/gu) ?? [];
}

function push(parts: WordDiffPart[], kind: WordDiffPart["kind"], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/** What changed from `before` to `after`, word by word. Removals come before additions. */
export function wordDiff(before: string, after: string): WordDiffPart[] {
  const a = wordTokens(before);
  const b = wordTokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const parts: WordDiffPart[] = [];
  push(parts, "same", a.slice(0, start).join(""));
  const rows = endA - start;
  const columns = endB - start;
  if (rows > MAX_COMPARED_TOKENS || columns > MAX_COMPARED_TOKENS || rows === 0 || columns === 0) {
    push(parts, "remove", a.slice(start, endA).join(""));
    push(parts, "add", b.slice(start, endB).join(""));
  } else {
    // The longest common subsequence, one row of lengths kept per token of `a`.
    const width = columns + 1;
    const lengths = new Uint16Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        lengths[i * width + j] = a[start + i] === b[start + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows || j < columns) {
      if (i < rows && j < columns && a[start + i] === b[start + j]) {
        push(parts, "same", a[start + i]);
        i++;
        j++;
      } else if (i < rows && (j === columns || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        push(parts, "remove", a[start + i++]);
      } else {
        push(parts, "add", b[start + j++]);
      }
    }
  }
  push(parts, "same", a.slice(endA).join(""));
  return parts;
}

/** How many separate places a comparison changed: a replacement counts once. */
export function changeCount(parts: WordDiffPart[]): number {
  let count = 0;
  let inChange = false;
  for (const part of parts) {
    const change = part.kind !== "same";
    if (change && !inChange) count++;
    inChange = change;
  }
  return count;
}
