const COPIED = [
  "boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "letterSpacing", "lineHeight", "textTransform", "textIndent", "tabSize", "wordSpacing", "direction",
] as const;

/**
 * Where the character at `index` of a textarea is drawn, from the textarea's
 * own top-left corner: its left edge, and the top and height of its line.
 * Measured on a hidden copy that wraps the same text the same way, so a
 * popover can sit under the caret without the text moving.
 */
export function caretPosition(field: HTMLTextAreaElement, index: number): { left: number; top: number; height: number } {
  const style = getComputedStyle(field);
  const copy = document.createElement("div");
  for (const name of COPIED) copy.style[name] = style[name];
  Object.assign(copy.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden", borderStyle: "solid" });
  copy.textContent = field.value.slice(0, index);
  const mark = document.createElement("span");
  // The rest of the word, so a word that wraps as a whole is measured on the line it lands on.
  mark.textContent = field.value.slice(index).match(/^\S+/)?.[0] ?? "​";
  copy.appendChild(mark);
  document.body.appendChild(copy);
  const height = parseFloat(style.lineHeight) || mark.offsetHeight || parseFloat(style.fontSize) * 1.5 || 0;
  const position = { left: mark.offsetLeft - field.scrollLeft, top: mark.offsetTop - field.scrollTop, height };
  copy.remove();
  return position;
}
