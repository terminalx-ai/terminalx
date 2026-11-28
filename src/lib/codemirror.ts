import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorState, type Extension } from "@codemirror/state";
import { extOf } from "@/lib/paths";

/** The diff's collapsed runs say what they hide in the app's words. */
export const diffPhrases: Extension = EditorState.phrases.of({ "$ unchanged lines": "$ unmodified lines" });

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
  // A line only the other side has: a faint diagonal hatch, so it never reads as a blank line of the file.
  ".cm-mergeSpacer": { backgroundColor: "transparent", backgroundImage: "repeating-linear-gradient(-45deg, color-mix(in oklab, var(--foreground) 9%, transparent) 0 1px, transparent 1px 6px)" },
  // The merge package draws these near-white (#f3f3f3 behind a zigzag) whatever the theme: a band in the toolbar's tone instead.
  ".cm-collapsedLines": {
    display: "flex", alignItems: "center", height: "32px", boxSizing: "border-box", padding: "0 12px 0 0", cursor: "pointer",
    color: "var(--muted-foreground) !important", background: "var(--veil-raised) !important",
    borderTop: "1px solid var(--hairline)", borderBottom: "1px solid var(--hairline)", fontFamily: "var(--font-sans)", fontSize: "12px",
  },
  ".cm-collapsedLines:hover": { color: "var(--foreground) !important" },
  ".cm-collapsedLines:before": {
    content: '""', flexShrink: "0", width: "13px", height: "13px", margin: "0 10px 0 14px", backgroundColor: "var(--ink-faint)",
    mask: `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>')}") center / contain no-repeat`,
  },
  ".cm-collapsedLines:after": { content: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 35%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--warning) 60%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--foreground)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--hairline-strong)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--hairline-strong)" },
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

type LangKey = "ts" | "tsx" | "js" | "jsx" | "rs" | "py" | "json" | "md" | "css" | "html";

const loadedLanguages = new Map<LangKey, Extension>();
const pendingLanguages = new Map<LangKey, Promise<Extension>>();

function langKeyFor(path: string): LangKey | null {
  switch (extOf(path)) {
    case "ts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "js";
    case "jsx":
      return "jsx";
    case "rs":
      return "rs";
    case "py":
      return "py";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "md";
    case "css":
    case "scss":
      return "css";
    case "html":
    case "svg":
    case "xml":
      return "html";
    default:
      return null;
  }
}

async function importLanguage(key: LangKey): Promise<Extension> {
  switch (key) {
    case "ts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "js":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "md":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
  }
}

/** Return the already-loaded CodeMirror language extension for `path`, or `[]` before it has loaded. */
export function languageFor(path: string): Extension {
  const key = langKeyFor(path);
  return key ? (loadedLanguages.get(key) ?? []) : [];
}

/** Dynamically load and cache the CodeMirror language pack for `path` on demand. */
export function loadLanguageFor(path: string): Promise<Extension> {
  const key = langKeyFor(path);
  if (!key) return Promise.resolve([]);
  const cached = loadedLanguages.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = pendingLanguages.get(key);
  if (inflight) return inflight;
  const promise = importLanguage(key)
    .then((ext) => {
      loadedLanguages.set(key, ext);
      pendingLanguages.delete(key);
      return ext;
    })
    .catch((err) => {
      pendingLanguages.delete(key);
      throw err;
    });
  pendingLanguages.set(key, promise);
  return promise;
}
