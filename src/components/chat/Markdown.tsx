import { PrivacyImage } from "@/components/ui/privacy-image";
import { cloneElement, isValidElement, memo, useMemo, useRef, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown, type ExtraProps } from "streamdown";
import { createCodePlugin, type CodeHighlighterPlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { isCommonShikiLang, normalizeShikiLang } from "@/lib/shikiLanguages";
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
import { openImageViewer } from "@/lib/imageViewer";

const baseCodePlugin = createCodePlugin({ themes: ["github-light", "github-dark"] });
const supportedCommonLanguages = baseCodePlugin.getSupportedLanguages().filter((lang) => isCommonShikiLang(lang));

export const codePlugin: CodeHighlighterPlugin = {
  ...baseCodePlugin,
  supportsLanguage(language) {
    return isCommonShikiLang(language) && baseCodePlugin.supportsLanguage(language);
  },
  getSupportedLanguages() {
    return supportedCommonLanguages;
  },
  highlight(options, callback) {
    if (!isCommonShikiLang(options.language)) {
      return baseCodePlugin.highlight({ ...options, language: "text" as never }, callback);
    }
    const normalized = normalizeShikiLang(options.language) as typeof options.language;
    return baseCodePlugin.highlight({ ...options, language: normalized }, callback);
  },
};
// Codex file citations (#776) become links with or without a workspace; with one, every other link is routed too.
const citedRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkCodexFileCitations];
const routedRemarkPlugins = [...citedRemarkPlugins, routeMarkdownLinks];

// S-22: Strip raw HTML media/embed tags that bypass `img` overrides and Data Privacy Mode
// (e.g. `<picture><source srcset="https://...">`, `<video>`, `<audio>`, `<iframe>`).
const BLOCKED_HTML_TAGS = new Set([
  "picture",
  "source",
  "video",
  "audio",
  "track",
  "iframe",
  "object",
  "embed",
  "applet",
  "base",
  "link",
  "meta",
  "style",
  "form",
  "svg",
  "math",
]);

const BLOCKED_HTML_ATTRS = new Set(["srcset", "srcSet", "poster", "ping", "background"]);

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function stripUnsafeMediaNodes() {
  const filter = (nodes: HastNode[]): HastNode[] => {
    const out: HastNode[] = [];
    for (const node of nodes) {
      if (node.type === "element" && typeof node.tagName === "string" && BLOCKED_HTML_TAGS.has(node.tagName.toLowerCase())) {
        continue;
      }
      if (node.properties) {
        for (const attr of Object.keys(node.properties)) {
          if (BLOCKED_HTML_ATTRS.has(attr) || BLOCKED_HTML_ATTRS.has(attr.toLowerCase())) {
            delete node.properties[attr];
          }
        }
      }
      if (Array.isArray(node.children)) {
        node.children = filter(node.children);
      }
      out.push(node);
    }
    return out;
  };
  return (tree: HastNode) => {
    if (Array.isArray(tree.children)) {
      tree.children = filter(tree.children);
    }
  };
}

function buildHardenedRehypePlugins() {
  const rawPlugin = defaultRehypePlugins.raw;
  const sanitizeEntry = defaultRehypePlugins.sanitize;
  const hardenEntry = defaultRehypePlugins.harden;
  let hardenedSanitize = sanitizeEntry;
  if (Array.isArray(sanitizeEntry) && sanitizeEntry.length >= 2 && sanitizeEntry[1] && typeof sanitizeEntry[1] === "object") {
    const schema = sanitizeEntry[1] as { tagNames?: string[]; strip?: string[]; attributes?: Record<string, unknown[]> };
    const filteredTagNames = (schema.tagNames ?? []).filter((tag) => !BLOCKED_HTML_TAGS.has(tag.toLowerCase()));
    const mergedStrip = Array.from(new Set([...(schema.strip ?? []), ...BLOCKED_HTML_TAGS]));
    const filteredAttributes: Record<string, unknown[]> = {};
    for (const [key, list] of Object.entries(schema.attributes ?? {})) {
      if (BLOCKED_HTML_TAGS.has(key.toLowerCase())) continue;
      filteredAttributes[key] = Array.isArray(list)
        ? list.filter((entry) => {
            const name = Array.isArray(entry) ? String(entry[0] ?? "") : String(entry ?? "");
            return !BLOCKED_HTML_ATTRS.has(name.toLowerCase());
          })
        : list;
    }
    hardenedSanitize = [
      sanitizeEntry[0],
      {
        ...schema,
        tagNames: filteredTagNames,
        strip: mergedStrip,
        attributes: filteredAttributes,
      },
    ];
  }
  return [rawPlugin, hardenedSanitize, stripUnsafeMediaNodes, hardenEntry].filter(Boolean);
}

const hardenedRehypePlugins = buildHardenedRehypePlugins();

/** Loopback hosts must never be fetched via Markdown `<img>` (prevents blind GET SSRF). */
function isLoopbackImageUrl(src: string): boolean {
  try {
    const url = new URL(src);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    return true;
  }
}

const dropElement = () => null;

const Block = memo(function Block({ text, streaming, mode, linkContext, remoteImages = false, webLinksOnly = false }: { remoteImages?: boolean; webLinksOnly?: boolean; text: string; streaming: boolean; mode: string; linkContext?: ChatLinkContext }) {
  // Streamdown would complete unfinished Markdown itself; done here, it leaves Codex file citations whole (#776).
  const source = useMemo(() => (streaming ? completeStreamingMarkdown(text) : text), [text, streaming]);
  const components = useMemo(() => ({
    a: webLinksOnly ? (props: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) => {
      if (parseChatLink(originalChatHref(props.href ?? "")).kind !== "web") return <span>{props.children}</span>;
      return <ChatLink {...props} context={linkContext} />;
    } : chatLinkComponent(linkContext),
    table: MarkdownTable,
    // Defense-in-depth: block raw HTML media/embed tags at the React component boundary too.
    picture: dropElement,
    source: dropElement,
    video: dropElement,
    audio: dropElement,
    iframe: dropElement,
    object: dropElement,
    embed: dropElement,
    // A picture on this computer is drawn under the message (ChatMedia); the web view cannot load its path.
    img: ({ src, alt }: { src?: string | Blob; alt?: string }) => {
      if (typeof src !== "string") return null;
      if (/^data:image\//i.test(src)) return <ViewableImage src={src} alt={alt} />;
      if (/^https?:/i.test(src)) {
        if (!remoteImages || isLoopbackImageUrl(src)) return <span>{alt || "Remote image"} (image blocked)</span>;
        return <ViewableImage src={src} alt={alt} />;
      }
      return null;
    },
    // Untrusted code stays literal instead of turning file: URLs into actions.
    inlineCode: ({ children }: { children?: ReactNode }) => <code>{webLinksOnly ? children : <LinkedText text={String(children ?? "")} context={linkContext} />}</code>,
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
        // Code reads as the answer gives it: no line numbers, and one labelled Copy rather than download and copy icons.
        controls={{ code: { copy: true, download: false }, table: true, mermaid: false }}
        lineNumbers={false}
        components={components}
        rehypePlugins={hardenedRehypePlugins}
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
/**
 * An image in a reply, inline as Markdown draws it, that opens the image viewer. Not a button: it may sit inside a
 * link (a badge), where a button is invalid; there the click is the link's, and the viewer stays out of it.
 */
function ViewableImage({ src, alt }: { src: string; alt?: string }) {
  const view = (event: { currentTarget: HTMLElement; preventDefault: () => void }) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    openImageViewer([{ src, name: alt || "Image" }]);
  };
  return (
    <PrivacyImage
      src={src}
      alt={alt ?? ""}
      role="button"
      tabIndex={0}
      aria-label={`View ${alt || "image"}`}
      onClick={view}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") view(event); }}
      className="inline-block max-h-96 max-w-full cursor-zoom-in rounded-lg [a_&]:cursor-pointer"
    />
  );
}

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
  // Preserve settled chunk boundaries when streaming completes so React never
  // unmounts and re-parses/re-highlights settled <Block>s on `streaming: true -> false`.
  const streamedFirstChunk = useRef<string | null>(null);
  const keepChunked = !!streaming || (streamedFirstChunk.current !== null && shown.startsWith(streamedFirstChunk.current));
  const chunks = useMemo(() => (keepChunked ? chunkStream(shown) : [shown]), [shown, keepChunked]);
  if (streaming && chunks.length > 1) {
    streamedFirstChunk.current = chunks[0];
  } else if (!keepChunked) {
    streamedFirstChunk.current = null;
  }
  // Settled chunks never change, so their index is a stable identity and
  // the memoised Block skips them; only the tail re-parses per delta and
  // flips `streaming` to false on completion.
  const last = chunks.length - 1;
  return (
    <div className={className}>
      {chunks.map((c, i) => (
        <Block key={i} text={c} streaming={!!streaming && i === last} mode={resolvedMode} linkContext={linkContext} remoteImages={remoteImages} webLinksOnly={webLinksOnly} />
      ))}
    </div>
  );
});
