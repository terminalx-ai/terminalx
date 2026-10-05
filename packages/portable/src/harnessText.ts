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
