import { cloneElement, isValidElement, memo, useMemo, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { defaultRemarkPlugins, Streamdown, type ExtraProps } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { useTheme } from "@/lib/theme";
import { chunkStream } from "@/lib/markdownChunks";
import { ChatLink, chatLinkComponent } from "./ChatLink";
import { originalChatHref, parseChatLink, routeMarkdownLinks, type ChatLinkContext } from "@/lib/chatLinks";
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

const Block = memo(function Block({ text, streaming, mode, linkContext, remoteImages = true, webLinksOnly = false }: { remoteImages?: boolean; webLinksOnly?: boolean; text: string; streaming: boolean; mode: string; linkContext?: ChatLinkContext }) {
  // Streamdown would complete unfinished Markdown itself; done here, it leaves Codex file citations whole (#776).
  const source = useMemo(() => (streaming ? completeStreamingMarkdown(text) : text), [text, streaming]);
  const components = useMemo(() => ({
    a: webLinksOnly ? (props: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) => {
      if (parseChatLink(originalChatHref(props.href ?? "")).kind !== "web") return <span>{props.children}</span>;
      return <ChatLink {...props} context={linkContext} />;
    } : chatLinkComponent(linkContext),
    table: MarkdownTable,
    // A picture on this computer is drawn under the message (ChatMedia); the web view cannot load its path.
    img: ({ src, alt }: { src?: string | Blob; alt?: string }) => typeof src === "string" && /^(https?:|data:image\/)/i.test(src) ? !remoteImages && /^https?:/i.test(src) ? <span>{alt || "Remote image"} (image blocked)</span> : <img src={src} alt={alt ?? ""} className="max-h-96 max-w-full rounded-lg" /> : null,
    // Untrusted code stays literal instead of turning file: URLs into actions.
    inlineCode: ({ children }: { children?: ReactNode }) => <code className="rounded bg-well px-1 py-0.5 font-mono text-[0.9em]">{webLinksOnly ? children : <LinkedText text={String(children ?? "")} context={linkContext} />}</code>,
    pre: ({ children }: { children?: ReactNode }) => {
      if (!isValidElement(children)) return children;
      const child = children as ReactElement<{ children?: ReactNode; className?: string; "data-block"?: string }>;
      const code = typeof child.props.children === "string" ? child.props.children : "";
      if (webLinksOnly || !textLinks(code).some((part) => part.href)) return cloneElement(child, { "data-block": "true" });
      const language = child.props.className?.match(/language-([^\s]+)/)?.[1] ?? "text";
      return <LinkedCode code={code} language={language} mode={mode} plugin={codePlugin} context={linkContext} />;
    },
  }), [linkContext, mode, remoteImages, webLinksOnly]);
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
  remoteImages,
  webLinksOnly,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
  linkContext?: ChatLinkContext;
  /** Disable network image loads for prose authored by other people, e.g. PR bodies. */
  remoteImages?: boolean;
  /** Untrusted repository prose may link to websites, never local files or applications. */
  webLinksOnly?: boolean;
}) {
  const { resolvedMode } = useTheme();
  const shown = useMemo(() => (streaming ? withoutPartialCodexFileCitation(text) : text), [text, streaming]);
  const chunks = useMemo(() => (streaming ? chunkStream(shown) : [shown]), [shown, streaming]);
  if (chunks.length === 1) {
    return (
      <div className={className}>
        <Block text={shown} streaming={!!streaming} mode={resolvedMode} linkContext={linkContext} remoteImages={remoteImages} webLinksOnly={webLinksOnly} />
      </div>
    );
  }
  // Settled chunks never change, so their index is a stable identity and
  // the memoised Block skips them; only the tail re-parses per delta.
  const last = chunks.length - 1;
  return (
    <div className={className}>
      {chunks.map((c, i) => (
        <Block key={i} text={c} streaming={i === last} mode={resolvedMode} linkContext={linkContext} remoteImages={remoteImages} webLinksOnly={webLinksOnly} />
      ))}
    </div>
  );
});
