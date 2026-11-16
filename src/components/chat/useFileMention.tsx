import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { FileText } from "@/icons";
import { files as filesApi, type FileHit } from "@/lib/api";
import { cn } from "@/lib/cn";
import { tokenAtCaret } from "@/lib/pickers";
import { CaretPopover } from "./CaretPopover";

/**
 * `@` in a prompt that has no composer yet (the new-session box): the files of
 * `cwd` the typed words match, under the caret. Picking one writes its path
 * after the `@`. The textarea keeps the focus and passes its keys to `onKeyDown`.
 */
export function useFileMention(
  cwd: string | null,
  draft: string,
  caret: number,
  onChange: (text: string) => void,
  field: RefObject<HTMLTextAreaElement | null>,
  onCaret: (caret: number) => void,
) {
  const token = tokenAtCaret(draft, caret);
  const query = cwd && token?.kind === "mention" ? token.query : null;
  const key = cwd && token?.kind === "mention" ? JSON.stringify([cwd, token.start, token.query]) : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; hits: FileHit[] } | null>(null);
  const [selection, setSelection] = useState({ key: "", row: 0 });
  const list = useRef<HTMLDivElement>(null);
  const open = key !== null && key !== dismissed;
  useEffect(() => {
    if (!open || !cwd || query === null || !key) return;
    let live = true;
    const timer = window.setTimeout(() => {
      filesApi.search(cwd, query, 30).then(
        (hits) => live && setResult({ key, hits }),
        () => live && setResult({ key, hits: [] }),
      );
    }, 60);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, cwd, query, key]);
  // The last answer stays up while the next one is read, so the list does not blink on every letter.
  const hits = open ? (result?.hits ?? []) : [];
  const loading = open && result?.key !== key;
  const highlighted = selection.key === key ? Math.min(selection.row, Math.max(hits.length - 1, 0)) : 0;
  const highlight = (row: number) => setSelection({ key: key ?? "", row });
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  const pick = (hit: FileHit) => {
    if (!token) return;
    const replacement = `@${/\s/.test(hit.path) ? JSON.stringify(hit.path) : hit.path} `;
    const next = draft.slice(0, token.start) + replacement + draft.slice(caret);
    onChange(next);
    const pos = token.start + replacement.length;
    onCaret(pos);
    requestAnimationFrame(() => {
      field.current?.focus({ preventScroll: true });
      field.current?.setSelectionRange(pos, pos);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(key);
      return true;
    }
    if (!hits.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight((highlighted + (event.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      pick(hits[highlighted]);
      return true;
    }
    return false;
  };
  /** The `@` button: start a mention at the end of the prompt. */
  const start = () => {
    const next = draft + (draft && !/\s$/.test(draft) ? " " : "") + "@";
    onChange(next);
    setDismissed(null);
    onCaret(next.length);
    requestAnimationFrame(() => {
      field.current?.focus({ preventScroll: true });
      field.current?.setSelectionRange(next.length, next.length);
    });
  };
  return {
    open,
    start,
    onKeyDown,
    menu:
      open && token && key ? (
        <CaretPopover field={field} index={token.start} anchorKey={JSON.stringify([cwd, token.start])} label="Files" onDismiss={() => setDismissed(key)} testId="file-mention-popover">
          <div ref={list} role="listbox" aria-label="Files" className="max-h-72 overflow-y-auto scrollbar-thin p-1 text-[12.5px]">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Files</div>
            {hits.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">{loading ? "Searching files…" : "No matching file"}</div>}
            {hits.map((hit, row) => (
              <div
                key={hit.path}
                role="option"
                aria-label={hit.path}
                aria-selected={row === highlighted}
                data-index={row}
                onMouseEnter={() => highlight(row)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(hit);
                }}
                className={cn("flex h-8 cursor-default items-center gap-2 whitespace-nowrap rounded-md px-2.5", row === highlighted && "bg-veil-strong")}
              >
                <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0">{hit.name}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-faint">{hit.path}</span>
              </div>
            ))}
          </div>
        </CaretPopover>
      ) : null,
  };
}
