import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import { CodeBlockContainer, CodeBlockCopyButton, CodeBlockHeader } from "streamdown";
import type { CodeHighlighterPlugin, HighlightResult } from "@streamdown/code";
import { textLinks } from "@terminalx/portable/textLinks";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { ChatLink } from "./ChatLink";

/** Keep syntax colours while making URLs clickable even when the highlighter
 * splits a URL across several tokens. Copy still uses the raw code. */
export const LinkedCode = memo(function LinkedCode({ code, language, mode, plugin, context }: { code: string; language: string; mode: string; plugin: CodeHighlighterPlugin; context?: ChatLinkContext }) {
  const [highlight, setHighlight] = useState<{ code: string; language: string; result: HighlightResult } | null>(null);
  const trimmedCode = useMemo(() => code.replace(/\n+$/, ""), [code]);
  useEffect(() => {
    let active = true;
    const lang = language as Parameters<CodeHighlighterPlugin["supportsLanguage"]>[0];
    if (plugin.supportsLanguage(lang)) {
      const accept = (result: HighlightResult) => { if (active) setHighlight({ code, language, result }); };
      const result = plugin.highlight({ code: trimmedCode, language: lang, themes: plugin.getThemes() }, accept);
      if (result) accept(result);
    }
    return () => { active = false; };
  }, [code, trimmedCode, language, plugin]);
  const lines = useMemo(
    () => highlight?.code === code && highlight.language === language
      ? highlight.result.tokens
      : trimmedCode.split("\n").map((content) => [{ content, color: "inherit" }]),
    [code, trimmedCode, language, highlight],
  );
  // Scan each line for links once per `code` change rather than on every highlight/theme render.
  const lineLinkParts = useMemo(
    () => trimmedCode.split("\n").map((line) => textLinks(line)),
    [trimmedCode],
  );
  const renderedLines = useMemo(
    () => lines.map((tokens, lineIndex) => {
      let offset = 0;
      const spans = tokens.map((token) => {
        const start = offset;
        offset += token.content.length;
        const dark = "htmlStyle" in token ? token.htmlStyle?.["--shiki-dark"] : undefined;
        const font = "fontStyle" in token ? token.fontStyle ?? 0 : 0;
        const style: CSSProperties = { color: mode === "dark" ? dark ?? token.color : token.color, fontStyle: font & 1 ? "italic" : undefined, fontWeight: font & 2 ? "bold" : undefined };
        return { token, start, end: offset, style };
      });
      const parts = lineLinkParts[lineIndex] ?? textLinks(tokens.map((token) => token.content).join(""));
      let from = 0;
      return <span key={lineIndex}>{parts.map((part, partIndex) => {
        const start = from;
        from += part.text.length;
        const content = spans.filter((span) => span.end > start && span.start < from).map((span, index) => <span key={index} style={span.style}>{span.token.content.slice(Math.max(0, start - span.start), Math.min(span.token.content.length, from - span.start))}</span>);
        return part.href ? <ChatLink key={partIndex} href={part.href} context={context}>{content}</ChatLink> : <span key={partIndex}>{content}</span>;
      })}{lineIndex < lines.length - 1 ? "\n" : null}</span>;
    }),
    [lines, lineLinkParts, mode, context],
  );
  return <CodeBlockContainer language={language}>
    <div className="flex items-center justify-between"><CodeBlockHeader language={language} /><div className="flex gap-1 pr-2"><CodeBlockCopyButton code={code} /></div></div>
    <pre className="max-h-96 overflow-auto px-4 py-3 font-mono text-[13px] leading-relaxed select-text"><code>{renderedLines}</code></pre>
  </CodeBlockContainer>;
});
