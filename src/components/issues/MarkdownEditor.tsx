import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/cn";

type Pane = "write" | "preview";

/**
 * Markdown with a Write and a Preview tab, for comments and issue text. The
 * caller owns the text and the buttons: `children` sits at the right of the
 * bar under the text. ⌘/Ctrl+Enter submits and Escape cancels, when given;
 * neither while an input method is composing. `onKeyDown` sees each key
 * first, and one it prevents goes no further.
 */
export function MarkdownEditor({
  value,
  onChange,
  label,
  placeholder = "Write in Markdown",
  autoFocus = false,
  disabled = false,
  readOnly = false,
  rows = 4,
  onSubmit,
  onCancel,
  hint,
  children,
  className,
  textareaRef,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The text box's accessible name. */
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** While a save is out: the focus and its keys stay here, but the text doesn't change. */
  readOnly?: boolean;
  /** The height to start at; it grows with the text up to a limit, then scrolls. */
  rows?: number;
  onSubmit?: () => void;
  onCancel?: () => void;
  /** A short line at the left of the bar, beside the buttons. */
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** The text box, for a caller that follows the caret (dictation, mentions). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [pane, setPane] = useState<Pane>("write");
  const own = useRef<HTMLTextAreaElement>(null);
  const area = textareaRef ?? own;
  const id = useId();

  useEffect(() => {
    if (autoFocus && pane === "write") area.current?.focus();
  }, [autoFocus, pane]);

  // Grows with the text so a long comment can be read while it is written.
  useEffect(() => {
    const el = area.current;
    if (!el || pane !== "write") return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value, pane]);

  const tab = (which: Pane, text: string) => (
    <button
      type="button"
      role="tab"
      id={`${id}-${which}`}
      aria-selected={pane === which}
      aria-controls={`${id}-panel`}
      onClick={() => setPane(which)}
      className={cn(
        "h-6 rounded-md px-2 text-[11px] transition-colors",
        pane === which ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
      )}
    >
      {text}
    </button>
  );

  return (
    <div className={cn("flex min-w-0 flex-col rounded-lg bg-well hairline", (disabled || readOnly) && "opacity-70", className)}>
      <div role="tablist" aria-label={`${label} mode`} className="flex items-center gap-0.5 px-1.5 pt-1.5">
        {tab("write", "Write")}
        {tab("preview", "Preview")}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${pane}`} className="min-w-0 px-2.5 py-2">
        {pane === "write" ? (
          <textarea
            ref={area}
            aria-label={label}
            value={value}
            rows={rows}
            disabled={disabled}
            readOnly={readOnly}
            aria-busy={readOnly || undefined}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              onKeyDown?.(event);
              if (event.defaultPrevented || event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
                event.preventDefault();
                onSubmit();
              } else if (event.key === "Escape" && onCancel) {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }
            }}
            className="block w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-faint scrollbar-thin"
          />
        ) : value.trim() ? (
          <div className="max-h-80 min-h-16 overflow-y-auto scrollbar-thin">
            <Markdown text={value} />
          </div>
        ) : (
          <div className="min-h-16 text-[13px] text-faint">Nothing to preview.</div>
        )}
      </div>
      {(hint || children) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-hairline px-2.5 py-1.5">
          {hint && <span className="min-w-0 flex-1 basis-32 text-[11px] text-faint">{hint}</span>}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">{children}</div>
        </div>
      )}
    </div>
  );
}
