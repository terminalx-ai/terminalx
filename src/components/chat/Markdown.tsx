import { memo } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";

const codePlugin = createCodePlugin({ themes: ["github-light", "github-dark"] });

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
  return (
    <div className={cn("prose-chat select-text", className)} data-mode={resolvedMode}>
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        isAnimating={!!streaming}
        parseIncompleteMarkdown={!!streaming}
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
