import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { errorMessage, gh, type FileInput, type PullRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { ComposerPrs } from "@/lib/cloudComposer";
import { tokenAtCaret } from "@/lib/pickers";
import { PR_ROW_LABEL, prRowState } from "@/lib/prRow";
import { usePrSearchIn } from "@/lib/usePrSearch";
import { CARET_POPOVER_SURFACE, CaretPopover } from "./CaretPopover";
import { PrStateIcon } from "./PrStateIcon";

/**
 * The `#` list: the pull requests the typed number or words match, each with
 * where it stands, and what picking one does. It never takes focus: the
 * textarea keeps it and answers every key.
 */
function PrMentionList({ query, items, highlighted, onHover, onPick, empty, note }: {
  query: string;
  items: PullRequest[];
  highlighted: number;
  onHover: (row: number) => void;
  onPick: (pr: PullRequest) => void;
  empty: string;
  note: string | null;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <div ref={list} role="listbox" aria-label="Pull requests" className="max-h-72 overflow-y-auto scrollbar-thin p-1 text-[12.5px]">
      <div className="flex items-center px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[.08em] text-faint">
        <span>Pull requests</span>
        <span className="ml-auto normal-case tracking-normal" data-testid="pr-mention-query">#{query}</span>
      </div>
      {items.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">{empty}</div>}
      {items.map((pr, row) => {
        const state = prRowState(pr);
        return (
          <div
            key={pr.number}
            role="option"
            aria-label={`#${pr.number} ${pr.title} ${PR_ROW_LABEL[state]}`}
            aria-selected={row === highlighted}
            data-index={row}
            onMouseEnter={() => onHover(row)}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(pr);
            }}
            className={cn("flex h-9 cursor-default items-center gap-2 whitespace-nowrap rounded-md px-2.5", row === highlighted && "bg-veil-strong")}
          >
            <PrStateIcon state={state} />
            <span className="shrink-0 font-mono text-faint">#{pr.number}</span>
            <span className="min-w-0 truncate">{pr.title}</span>
            <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">{PR_ROW_LABEL[state]}</span>
          </div>
        );
      })}
      {note && <div className="px-2.5 py-1.5 text-[11px] text-destructive" data-testid="picker-note">{note}</div>}
      <div className="my-1 border-t border-hairline" />
      <div className="px-2.5 py-1 text-[11.5px] text-faint">Adds the PR’s title, description and diff as a context file.</div>
    </div>
  );
}

/** This computer's `#` list for a checkout here: its `gh`, and a context file mentioned by its path. */
function localPrs(cwd: string): ComposerPrs {
  return {
    key: cwd,
    search: (query) => gh.search(cwd, query),
    pick: async (number) => ({ mention: await gh.attach(cwd, number) }),
  };
}

/**
 * PR context is fetched before replacing the token; late answers never
 * overwrite a newer draft. `where`: a directory on this computer, or a
 * runtime's list (`cloudComposerPrs`, #1329), whose pick is a file the
 * composer attaches (`onAttachFile`) while the token is removed.
 */
export function usePrMention(
  where: string | ComposerPrs | null,
  draft: string,
  caret: number,
  onChange: (text: string) => void,
  field: RefObject<HTMLTextAreaElement | null>,
  onCaret: (caret: number) => void,
  /** `floating`: under the caret, over whatever is below, as the new-session box shows it; else above the field. */
  { floating = false, onAttachFile }: { floating?: boolean; onAttachFile?: (file: FileInput) => void } = {},
) {
  const source = typeof where === "string" ? localPrs(where) : where;
  // Names the repository asked, for every check below that a pick still belongs to it.
  const cwd = source?.key ?? null;
  const token = tokenAtCaret(draft, caret);
  const key = cwd && token?.kind === "pr" ? JSON.stringify([cwd, token.start, token.query]) : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selection, setSelection] = useState({ key: "", row: 0 });
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attaching, setAttaching] = useState(false);
  const pending = useRef(false);
  const operation = useRef(0);
  useEffect(() => {
    setDismissed(null);
  }, [key]);
  useEffect(() => {
    // An attachment belongs to the draft and project that selected it.
    operation.current++;
    pending.current = false;
    setAttaching(false);
  }, [draft, cwd]);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  const current = useRef({ draft, cwd });
  current.current = { draft, cwd };
  const open = key !== null && key !== dismissed;
  const result = usePrSearchIn(open ? cwd : null, source?.search ?? null, token?.kind === "pr" ? token.query : null);
  const items = result.items;
  const highlighted = selection.key === key ? Math.min(selection.row, Math.max(items.length - 1, 0)) : 0;
  const highlight = (row: number) => setSelection({ key: key ?? "", row });
  const pick = async (item: PullRequest) => {
    if (!source || !cwd || !token || !key || pending.current) return;
    const request = ++operation.current;
    pending.current = true;
    setAttaching(true);
    setFailure(null);
    try {
      const picked = await source.pick(item.number);
      if (operation.current !== request || current.current.draft !== draft || current.current.cwd !== cwd) return;
      if ("file" in picked && !onAttachFile) throw new Error("This composer cannot attach a pull request's context file.");
      // A file read on the agent's runtime is attached as a chip; the `#` token goes.
      if ("file" in picked) onAttachFile!(picked.file);
      const path = "mention" in picked ? picked.mention : null;
      const replacement = path === null ? "" : `@${/\s/.test(path) ? JSON.stringify(path) : path} `;
      const next = draft.slice(0, token.start) + replacement + draft.slice(caret);
      onChange(next);
      const pos = token.start + replacement.length;
      onCaret(pos);
      requestAnimationFrame(() => {
        field.current?.focus({ preventScroll: true });
        field.current?.setSelectionRange(pos, pos);
      });
    } catch (error) {
      if (operation.current === request) setFailure({ key, message: errorMessage(error) });
    } finally {
      if (operation.current === request) {
        pending.current = false;
        setAttaching(false);
      }
    }
  };
  const dismiss = () => {
    operation.current++;
    pending.current = false;
    setAttaching(false);
    setDismissed(key);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) highlight((highlighted + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    const item = attaching ? undefined : items[highlighted];
    if (item && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      void pick(item);
      return true;
    }
    return false;
  };
  const list: ReactNode = open ? (
    <PrMentionList
      query={token?.kind === "pr" ? token.query : ""}
      items={attaching ? [] : items}
      highlighted={highlighted}
      onHover={highlight}
      onPick={(pr) => void pick(pr)}
      empty={attaching ? "Attaching pull request…" : result.loading ? "Searching pull requests…" : "No matching pull requests"}
      note={failure?.key === key ? failure.message : result.error}
    />
  ) : null;
  return {
    open,
    attaching: attaching && open,
    onKeyDown,
    menu: !open || !token || !key ? null : floating ? (
      <CaretPopover field={field} index={token.start} anchorKey={key} label="Pull requests" onDismiss={dismiss} testId="pr-mention-popover">
        {list}
      </CaretPopover>
    ) : (
      <div className={cn(CARET_POPOVER_SURFACE, "absolute bottom-full left-0 right-0 z-30 mb-2")}>{list}</div>
    ),
  };
}
