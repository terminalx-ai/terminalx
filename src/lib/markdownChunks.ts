const CHUNK = 3000;

/**
 * A long stream is cut into settled chunks at paragraph breaks outside code
 * fences, so every delta re-parses only the tail instead of the whole text.
 * Chunks are keyed by content, which keeps their rendered output memoised.
 */
export function chunkStream(text: string): string[] {
  if (text.length < CHUNK * 2) return [text];
  const out: string[] = [];
  let start = 0;
  let fences = 0;
  let lastBreak = -1;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("```", i)) {
      fences++;
      i += 2;
      continue;
    }
    if (text[i] === "\n" && fences % 2 === 0) {
      const para = text[i + 1] === "\n";
      if (para || i - start > CHUNK * 2) lastBreak = i + (para ? 2 : 1);
      if (i - start >= CHUNK && lastBreak > start) {
        out.push(text.slice(start, lastBreak));
        start = lastBreak;
      }
    }
  }
  // The tail is whatever is still moving; keep it, even if empty for a moment.
  out.push(text.slice(start));
  return out;
}

