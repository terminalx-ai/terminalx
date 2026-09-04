import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { ArrowDown, ArrowUp, CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, Search, WholeWord, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { SearchToggle } from "@/components/editor/SearchControls";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";

/**
 * The editor's ⌘F bar. CodeMirror keeps the query and does the finding; it
 * only asks for a panel element, which React fills through a portal so the
 * bar shares the app's buttons, tooltips, and tokens. The handle is what
 * the portal needs: the element, the view, and a way to hear editor updates.
 */
export interface FindPanelHandle {
  dom: HTMLElement;
  view: EditorView;
  /** Bumped on every update the bar should redraw for. */
  version: number;
  subscribe(cb: () => void): () => void;
}

/** The search extension, handing its panel to `onPanel` when it opens and `null` when it closes. */
export function findPanel(onPanel: (handle: FindPanelHandle | null) => void): Extension {
  return search({
    top: false,
    createPanel(view) {
      const dom = document.createElement("div");
      dom.className = "cm-find";
      const listeners = new Set<() => void>();
      const handle: FindPanelHandle = {
        dom,
        view,
        version: 0,
        subscribe(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      };
      return {
        dom,
        top: false,
        mount: () => onPanel(handle),
        update(u: ViewUpdate) {
          const queryChanged = u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)));
          if (!u.docChanged && !u.selectionSet && !queryChanged) return;
          handle.version++;
          for (const l of listeners) l();
        },
        destroy: () => onPanel(null),
      };
    },
  });
}

const COUNT_CAP = 10_000;

/** Total matches, and which one the cursor sits on. */
function countMatches(view: EditorView, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.valid) return { total: 0, current: 0, capped: false };
  const sel = view.state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(view.state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= COUNT_CAP) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

export function FindBar({ handle }: { handle: FindPanelHandle }) {
  const { view } = handle;
  useSyncExternalStore(handle.subscribe, () => handle.version);
  const query = getSearchQuery(view.state);
  const readOnly = view.state.readOnly;
  const [replaceOpen, setReplaceOpen] = useState(() => query.replace.length > 0);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  // The version stands in for the editor state, which is what the count depends on.
  const counts = useMemo(() => countMatches(view, query), [view, query, handle.version]);

  useEffect(() => {
    findInput.current?.focus();
    findInput.current?.select();
  }, []);

  // Esc closes the bar from anywhere inside this editor, even while a turn is
  // running and the app would otherwise take Esc to stop it.
  useHotkey(
    "escape",
    () => {
      if (!view.dom.contains(document.activeElement)) return false;
      closeSearchPanel(view);
      return true;
    },
    { global: true },
  );

  const commit = (patch: Partial<{ search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }>) => {
    const next = new SearchQuery({
      search: query.search,
      replace: query.replace,
      caseSensitive: query.caseSensitive,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
      literal: query.literal,
      ...patch,
    });
    if (!next.eq(query)) view.dispatch({ effects: setSearchQuery.of(next) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (runScopeHandlers(view, e.nativeEvent, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.target === findInput.current) (e.shiftKey ? findPrevious : findNext)(view);
    else if (e.target === replaceInput.current) replaceNext(view);
  };

  const openReplace = () => {
    setReplaceOpen(true);
    requestAnimationFrame(() => replaceInput.current?.focus());
  };

  const counter = !query.search
    ? ""
    : !query.valid
      ? "Invalid"
      : counts.total === 0
        ? "No results"
        : counts.current
          ? `${counts.current} of ${counts.total}${counts.capped ? "+" : ""}`
          : `${counts.total}${counts.capped ? "+" : ""}`;

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 font-sans text-xs" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1">
        {!readOnly && (
          <WithTooltip label={replaceOpen ? "Hide replace" : "Replace"}>
            <button
              type="button"
              aria-label={replaceOpen ? "Hide replace" : "Show replace"}
              aria-expanded={replaceOpen}
              onClick={() => (replaceOpen ? setReplaceOpen(false) : openReplace())}
              className="rounded-md p-0.5 text-faint outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {replaceOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          </WithTooltip>
        )}
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-well px-2 ring-ring/30 focus-within:ring-2">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            ref={findInput}
            main-field="true"
            value={query.search}
            onChange={(e) => commit({ search: e.target.value })}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-faint"
          />
          <span
            className={cn("shrink-0 tabular-nums", query.search && query.valid && counts.total === 0 ? "text-destructive" : "text-faint")}
            aria-live="polite"
          >
            {counter}
          </span>
          <SearchToggle label="Match case" pressed={query.caseSensitive} onClick={() => commit({ caseSensitive: !query.caseSensitive })}>
            <CaseSensitive className="size-3.5" />
          </SearchToggle>
          <SearchToggle label="Whole word" pressed={query.wholeWord} onClick={() => commit({ wholeWord: !query.wholeWord })}>
            <WholeWord className="size-3.5" />
          </SearchToggle>
          <SearchToggle label="Regular expression" pressed={query.regexp} onClick={() => commit({ regexp: !query.regexp })}>
            <Regex className="size-3.5" />
          </SearchToggle>
        </div>
        <WithTooltip label="Previous match" keys={keycaps("mod+shift+g")}>
          <Button variant="ghost" size="icon-xs" aria-label="Previous match" disabled={!counts.total} onClick={() => findPrevious(view)}>
            <ArrowUp />
          </Button>
        </WithTooltip>
        <WithTooltip label="Next match" keys={keycaps("mod+g")}>
          <Button variant="ghost" size="icon-xs" aria-label="Next match" disabled={!counts.total} onClick={() => findNext(view)}>
            <ArrowDown />
          </Button>
        </WithTooltip>
        <WithTooltip label="Close" keys={keycaps("escape")}>
          <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={() => closeSearchPanel(view)}>
            <X />
          </Button>
        </WithTooltip>
      </div>
      {replaceOpen && !readOnly && (
        <div className="flex items-center gap-1 pl-[22px]">
          <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-well px-2 ring-ring/30 focus-within:ring-2">
            <Replace className="size-3.5 shrink-0 text-faint" />
            <input
              ref={replaceInput}
              value={query.replace}
              onChange={(e) => commit({ replace: e.target.value })}
              placeholder="Replace"
              aria-label="Replace"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-faint"
            />
          </div>
          <WithTooltip label="Replace" keys={keycaps("enter")}>
            <Button variant="ghost" size="icon-xs" aria-label="Replace" disabled={!counts.total} onClick={() => replaceNext(view)}>
              <Replace />
            </Button>
          </WithTooltip>
          <WithTooltip label="Replace all">
            <Button variant="ghost" size="icon-xs" aria-label="Replace all" disabled={!counts.total} onClick={() => replaceAll(view)}>
              <ReplaceAll />
            </Button>
          </WithTooltip>
          <span className="w-6" aria-hidden />
        </div>
      )}
    </div>
  );
}
