import { useEffect, useRef, useState } from "react";
import { Segmented } from "@/components/ui/controls";
import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/cn";

/**
 * Markdown with a Write and a Preview side, for an issue's description.
 * PRO-94 (IM-3) builds the comment composer's editor; once it is on main this
 * one gives way to it, so it keeps to the plain value-and-change shape that
 * editor takes.
 */
export function IssueMarkdownEditor({
  value,
  onChange,
  readOnly = false,
  autoFocus = false,
  placeholder = "Add a description…",
  "aria-label": ariaLabel = "Description",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** While a save is out: still focused, so its keys stay here, but not changing. */
  readOnly?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  "aria-label"?: string;
  className?: string;
}) {
  const [side, setSide] = useState<"write" | "preview">("write");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const el = area.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Segmented<"write" | "preview">
        aria-label="Write or preview"
        className="self-start"
        value={side}
        onChange={setSide}
        options={[
          { value: "write", label: "Write" },
          { value: "preview", label: "Preview" },
        ]}
      />
      {side === "write" ? (
        <textarea
          ref={area}
          aria-label={ariaLabel}
          value={value}
          readOnly={readOnly}
          aria-busy={readOnly}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-40 w-full resize-y rounded-md bg-well px-3 py-2 font-mono text-xs leading-relaxed outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30 read-only:opacity-60"
        />
      ) : (
        <div className="min-h-40 rounded-md px-3 py-2 hairline" data-testid="markdown-preview">
          {value.trim() ? <Markdown text={value} /> : <div className="text-sm text-faint">Nothing to preview.</div>}
        </div>
      )}
    </div>
  );
}
