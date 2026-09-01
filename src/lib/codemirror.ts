import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { extOf } from "@/lib/paths";

/** Editor chrome drawn from the app's tokens so it follows the theme. */
export const raccoonTheme: Extension = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "12.5px" },
  ".cm-content": { fontFamily: "var(--font-mono)", padding: "6px 0", caretColor: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--ink-faint)", border: "none", fontFamily: "var(--font-mono)" },
  ".cm-activeLine": { backgroundColor: "var(--veil-raised)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--selection) !important" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "36px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-changedLine": { backgroundColor: "color-mix(in oklab, var(--accent-add) 12%, transparent)" },
  ".cm-deletedChunk": { backgroundColor: "color-mix(in oklab, var(--destructive) 12%, transparent)" },
  ".cm-insertedLine, .cm-changedLine": { backgroundColor: "color-mix(in oklab, var(--accent-add) 12%, transparent)" },
  ".cm-changedText": { background: "color-mix(in oklab, var(--accent-add) 28%, transparent)" },
  ".cm-deletedText": { background: "color-mix(in oklab, var(--destructive) 28%, transparent)" },
  ".cm-mergeSpacer": { backgroundColor: "var(--veil-raised)" },
  ".cm-collapsedLines": { color: "var(--ink-faint)", backgroundColor: "var(--veil-raised)", padding: "2px 12px" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 35%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--foreground)" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", border: "1px solid var(--hairline-strong)", borderRadius: "6px" },
});

export const raccoonHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: "var(--accent-thinking)" },
    { tag: [t.string, t.special(t.string)], color: "var(--accent-add)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--accent-command)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--ink-faint)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--accent-mention)" },
    { tag: [t.typeName, t.className, t.namespace], color: "var(--warning)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--foreground)" },
    { tag: [t.definition(t.variableName)], color: "var(--foreground)" },
    { tag: t.heading, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.link, color: "var(--accent-mention)", textDecoration: "underline" },
    { tag: [t.tagName], color: "var(--accent-thinking)" },
    { tag: t.invalid, color: "var(--destructive)" },
  ]),
);

export function languageFor(path: string): Extension {
  switch (extOf(path)) {
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "rs":
      return rust();
    case "py":
      return python();
    case "json":
      return json();
    case "md":
    case "mdx":
      return markdown();
    case "css":
    case "scss":
      return css();
    case "html":
    case "svg":
    case "xml":
      return html();
    default:
      return [];
  }
}
