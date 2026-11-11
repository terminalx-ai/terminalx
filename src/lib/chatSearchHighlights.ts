import { MAX_CHAT_MATCHES, searchExpression } from "./chatSearch";

const BLOCKS = new Set(["P", "DIV", "PRE", "LI", "TR", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);

/** Ranges may cross emphasis, links and syntax tokens. No mutation of React's Markdown DOM. */
export function searchRanges(root: HTMLElement, query: string, matchCase: boolean, limit = MAX_CHAT_MATCHES): Range[] {
  const expression = searchExpression(query, matchCase);
  if (!expression || limit <= 0) return [];
  let text = "";
  const runs: { start: number; end: number; node: Text; offset: number }[] = [];
  const space = () => { if (text && !text.endsWith(" ")) text += " "; };
  const visit = (node: Node) => {
    if (node instanceof Text) {
      // Keep the mapping to the original UTF-16 offsets while folding whitespace as the index does.
      for (const part of node.data.matchAll(/\s+|\S+/g)) {
        if (/^\s/.test(part[0])) {
          if (text.endsWith(" ")) continue;
          runs.push({ start: text.length, end: text.length + 1, node, offset: part.index });
          text += " ";
        } else {
          runs.push({ start: text.length, end: text.length + part[0].length, node, offset: part.index });
          text += part[0];
        }
      }
    } else if (node instanceof HTMLElement) {
      if (node.matches('button, svg, [aria-hidden="true"], [data-streamdown="code-block-header"], [data-streamdown="code-block-actions"]')) return;
      const block = BLOCKS.has(node.tagName) || node.tagName === "BR";
      if (block) space();
      node.childNodes.forEach(visit);
      if (block) space();
    }
  };
  visit(root);
  const ranges: Range[] = [];
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    const end = match.index + match[0].length;
    while (cursor < runs.length && runs[cursor].end <= match.index) cursor++;
    const first = runs[cursor];
    let lastIndex = cursor;
    while (lastIndex + 1 < runs.length && runs[lastIndex + 1].start < end) lastIndex++;
    const last = runs[lastIndex];
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first.node, first.offset + Math.max(0, match.index - first.start));
    range.setEnd(last.node, last.offset + Math.min(last.end - last.start, end - last.start));
    ranges.push(range);
    if (ranges.length === limit) break;
  }
  return ranges;
}

/** Only this chat owns the shortcut, including its composer, never a nested editor/terminal or a portal. */
export function chatOwnsFocus(root: HTMLElement | null, target: Element | null): boolean {
  return !!root && !!target && root.contains(target) && target.closest('[data-find-scope], .cm-editor, .terminal-host, .xterm') === root;
}

/** Reveal through nested output/code scrollers, stopping at the chat so the app shell cannot move. */
export function revealSearchRange(range: Range, chat: HTMLElement, footerHeight: number): void {
  // Offscreen Markdown code blocks defer layout with content-visibility: auto.
  // WebKit can then return a Range rectangle but ignore the nested scrollTop
  // write. Measure the selected path with layout enabled, then restore its
  // original rendering policy once both the inner scrollers and chat are set.
  const deferred: { element: HTMLElement; value: string; priority: string }[] = [];
  for (let element = range.startContainer.parentElement; element && chat.contains(element); element = element.parentElement) {
    if (getComputedStyle(element).contentVisibility === "auto") {
      deferred.push({ element, value: element.style.getPropertyValue("content-visibility"), priority: element.style.getPropertyPriority("content-visibility") });
    }
    if (element === chat) break;
  }
  try {
    for (const { element } of deferred) element.style.setProperty("content-visibility", "visible");
    let element = range.startContainer.parentElement;
    while (element && chat.contains(element)) {
      const { overflowY, overflowX } = getComputedStyle(element);
      // Hidden overflow still scrolls programmatically (unlike clip). Skipping
      // it can place a result inside the chat while an inner wrapper hides it.
      if (element === chat || /auto|scroll|hidden/.test(overflowY + overflowX)) {
        const rect = range.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const bottom = box.bottom - (element === chat ? footerHeight : 0);
        if (rect.top < box.top + 8) element.scrollTop += rect.top - box.top - 8;
        else if (rect.bottom > bottom - 8) element.scrollTop += Math.min(rect.bottom - bottom + 8, rect.top - box.top - 8);
        if (rect.left < box.left) element.scrollLeft += rect.left - box.left;
        else if (rect.right > box.right) element.scrollLeft += rect.right - box.right;
      }
      if (element === chat) break;
      element = element.parentElement;
    }
  } finally {
    for (const { element, value, priority } of deferred) {
      if (value) element.style.setProperty("content-visibility", value, priority);
      else element.style.removeProperty("content-visibility");
    }
  }
}

/** Older WebKit (the app supports macOS 12) paints ranges as clipped overlays instead. */
export function searchRangeRects(range: Range, chat: HTMLElement, footerHeight: number): { top: number; left: number; width: number; height: number }[] {
  const box = chat.getBoundingClientRect();
  let top = box.top;
  let bottom = box.bottom - footerHeight;
  let left = box.left;
  let right = box.right;
  for (let node = range.startContainer.parentElement; node && node !== chat && chat.contains(node); node = node.parentElement) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
  }
  return Array.from(range.getClientRects()).flatMap((rect) => {
    const y = Math.max(top, rect.top);
    const x = Math.max(left, rect.left);
    const width = Math.min(right, rect.right) - x;
    const height = Math.min(bottom, rect.bottom) - y;
    return width > 0 && height > 0 ? [{ top: y, left: x, width, height }] : [];
  });
}
