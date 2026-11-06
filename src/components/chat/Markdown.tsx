import { cloneElement, isValidElement, memo, useMemo, type ReactElement, type ReactNode } from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { useTheme } from "@/lib/theme";
import { chunkStream } from "@/lib/markdownChunks";
import { chatLinkComponent } from "./ChatLink";
import { routeMarkdownLinks, type ChatLinkContext } from "@/lib/chatLinks";
import { textLinks } from "@terminalx/portable/textLinks";
import { withoutPartialCodexFileCitation } from "@terminalx/portable/codexCitations";
import { completeStreamingMarkdown, remarkCodexFileCitations } from "@/lib/codexCitations";
import { LinkedText } from "./LinkedText";
import { MarkdownTable } from "./MarkdownTable";
import { LinkedCode } from "./LinkedCode";

const codePlugin = createCodePlugin({ themes: ["github-light", "github-dark"] });
// Codex file citations (#776) become links with or without a workspace; with one, every other link is routed too.
const citedRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkCodexFileCitations];
const routedRemarkPlugins = [...citedRemarkPlugins, routeMarkdownLinks];

const Block = memo(function Block({ text, streaming, mode, linkContext }: { text: string; streaming: boolean; mode: string; linkContext?: ChatLinkContext }) {
  // Streamdown would complete unfinished Markdown itself; done here, it leaves Codex file citations whole (#776).
  const source = useMemo(() => (streaming ? completeStreamingMarkdown(text) : text), [text, streaming]);
  const components = useMemo(() => ({
    a: chatLinkComponent(linkContext),
    table: MarkdownTable,
    inlineCode: ({ children }: { children?: ReactNode }) => <code className="rounded bg-well px-1 py-0.5 font-mono text-[0.9em]"><LinkedText text={String(children ?? "")} context={linkContext} /></code>,
    pre: ({ children }: { children?: ReactNode }) => {
      if (!isValidElement(children)) return children;
      const child = children as ReactElement<{ children?: ReactNode; className?: string; "data-block"?: string }>;
      const code = typeof child.props.children === "string" ? child.props.children : "";
      if (!textLinks(code).some((part) => part.href)) return cloneElement(child, { "data-block": "true" });
      const language = child.props.className?.match(/language-([^\s]+)/)?.[1] ?? "text";
      return <LinkedCode code={code} language={language} mode={mode} plugin={codePlugin} context={linkContext} />;
    },
  }), [linkContext, mode]);
  return (
    <div className="prose-chat select-text" data-mode={mode}>
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        parseIncompleteMarkdown={false}
        plugins={{ code: codePlugin }}
        shikiTheme={["github-light", "github-dark"]}
        controls={{ code: true, table: true, mermaid: false }}
        components={components}
        remarkPlugins={linkContext ? routedRemarkPlugins : citedRemarkPlugins}
        linkSafety={{ enabled: false }}
        codeBlockMaxHeight="24rem"
      >
        {source}
      </Streamdown>
    </div>
  );
});

/**
 * Assistant prose. Streaming text keeps incomplete markdown parseable, and
 * holds back a Codex file citation until its marker is whole; the committed
 * block re-renders in static mode. Routed links retain their originating
 * session and workspace context.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  className,
  linkContext,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
  linkContext?: ChatLinkContext;
}) {
  const { resolvedMode } = useTheme();
  const shown = useMemo(() => (streaming ? withoutPartialCodexFileCitation(text) : text), [text, streaming]);
  const chunks = useMemo(() => (streaming ? chunkStream(shown) : [shown]), [shown, streaming]);
  if (chunks.length === 1) {
    return (
      <div className={className}>
        <Block text={shown} streaming={!!streaming} mode={resolvedMode} linkContext={linkContext} />
      </div>
    );
  }
  // Settled chunks never change, so their index is a stable identity and
  // the memoised Block skips them; only the tail re-parses per delta.
  const last = chunks.length - 1;
  return (
    <div className={className}>
      {chunks.map((c, i) => (
        <Block key={i} text={c} streaming={i === last} mode={resolvedMode} linkContext={linkContext} />
      ))}
    </div>
  );
});
