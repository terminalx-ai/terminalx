import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { useTheme } from "@/lib/theme";
import { chunkStream } from "@/lib/markdownChunks";

const codePlugin = createCodePlugin({ themes: ["github-light", "github-dark"] });

const Block = memo(function Block({ text, streaming, mode }: { text: string; streaming: boolean; mode: string }) {
  return (
    <div className="prose-chat select-text" data-mode={mode}>
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        parseIncompleteMarkdown={streaming}
        plugins={{ code: codePlugin }}
        shikiTheme={["github-light", "github-dark"]}
        controls={{ code: true, table: true, mermaid: false }}
        linkSafety={{ enabled: false }}
        codeBlockMaxHeight="24rem"
      >
        {text}
      </Streamdown>
    </div>
  );
});

/**
 * Assistant prose. Streaming text keeps incomplete markdown parseable; the
 * committed block re-renders in static mode. Links open outside the app.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  const { resolvedMode } = useTheme();
  const chunks = useMemo(() => (streaming ? chunkStream(text) : [text]), [text, streaming]);
  if (chunks.length === 1) {
    return (
      <div className={className}>
        <Block text={text} streaming={!!streaming} mode={resolvedMode} />
      </div>
    );
  }
  // Settled chunks never change, so their index is a stable identity and
  // the memoised Block skips them; only the tail re-parses per delta.
  const last = chunks.length - 1;
  return (
    <div className={className}>
      {chunks.map((c, i) => (
        <Block key={i} text={c} streaming={i === last} mode={resolvedMode} />
      ))}
    </div>
  );
});
