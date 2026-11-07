import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { SearchAddon, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { ChevronDown, ChevronUp, Search, X } from "@/icons";
import { useTheme } from "@/lib/theme";
import { useShortcut } from "@/lib/hotkeys";
import { peekInstance } from "@/lib/terminal";
import { TerminalChatContext } from "./TerminalChat";

const darkDecorations = {
  matchBackground: "#755c25", matchBorder: "#d6a83b", matchOverviewRuler: "#d6a83b",
  activeMatchBackground: "#366fa8", activeMatchBorder: "#9bcaff", activeMatchColorOverviewRuler: "#9bcaff",
};

const lightDecorations = {
  matchBackground: "#ffe8a3", matchBorder: "#9e7000", matchOverviewRuler: "#9e7000",
  activeMatchBackground: "#b3d8ff", activeMatchBorder: "#2467a6", activeMatchColorOverviewRuler: "#2467a6",
};

/** Search and selection act on the instance currently mounted in this view. */
export function TerminalTools({ id, shown, frame }: { id: string; shown: boolean; frame: RefObject<HTMLDivElement | null> }) {
  const addToChat = useContext(TerminalChatContext);
  const { resolvedMode } = useTheme();
  const decorations = resolvedMode === "dark" ? darkDecorations : lightDecorations;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [results, setResults] = useState<ISearchResultChangeEvent>({ resultCount: 0, resultIndex: -1 });
  const [selection, setSelection] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const search = useRef<SearchAddon | null>(null);
  const adding = useRef(false);

  const show = () => {
    setOpen(true);
    input.current?.focus();
    input.current?.select();
  };
  useShortcut("files.find", () => {
    if (!frame.current?.contains(document.activeElement)) return false;
    show();
  }, { enabled: shown });

  useEffect(() => {
    if (!shown || !open) return;
    const inst = peekInstance(id);
    if (!inst) return;
    const addon = new SearchAddon();
    inst.term.loadAddon(addon);
    search.current = addon;
    const change = addon.onDidChangeResults((results) => {
      setResults(results);
      // A resize or incoming output makes the addon recompute with noScroll.
      // Keep its selected match visible after the terminal's grid changes.
      const start = inst.term.getSelectionPosition()?.start;
      if (start && (start.y < inst.term.buffer.active.viewportY || start.y >= inst.term.buffer.active.viewportY + inst.term.rows)) {
        inst.term.scrollToLine(Math.max(0, start.y - Math.floor(inst.term.rows / 2)));
      }
    });
    input.current?.focus();
    input.current?.select();
    return () => {
      change.dispose();
      addon.clearDecorations();
      inst.term.clearSelection();
      addon.dispose();
      search.current = null;
    };
  }, [id, shown, open]);

  useEffect(() => {
    if (!shown || !open) return;
    // addon-search 0.16 caches the count for the same query even when case
    // sensitivity changes. Invalidate its decorations before recomputing.
    search.current?.clearDecorations();
    if (query) search.current?.findNext(query, { caseSensitive: matchCase, incremental: true, decorations });
    else {
      peekInstance(id)?.term.clearSelection();
      setResults({ resultCount: 0, resultIndex: -1 });
    }
  }, [query, matchCase, id, shown, open, decorations]);

  useEffect(() => {
    if (!shown || !addToChat || open) { setSelection(""); return; }
    const term = peekInstance(id)?.term;
    if (!term) return;
    const changed = () => { setSelection(term.getSelection()); setNotice(null); setError(null); };
    changed();
    const subscription = term.onSelectionChange(changed);
    return () => subscription.dispose();
  // The context callback changes with session state; selection belongs to the terminal.
  }, [id, shown, !!addToChat, open]);

  const close = () => { setOpen(false); peekInstance(id)?.term.focus(); };
  const find = (previous: boolean) => {
    const options = { caseSensitive: matchCase, decorations };
    if (previous) search.current?.findPrevious(query, options);
    else search.current?.findNext(query, options);
  };
  const add = async () => {
    if (!addToChat || adding.current) return;
    adding.current = true;
    setPending(true);
    setError(null);
    try {
      await addToChat(selection);
      peekInstance(id)?.term.clearSelection();
      setNotice("Added to chat draft");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      adding.current = false;
      setPending(false);
    }
  };

  if (!shown) return null;
  return <>
    {open && <div role="search" aria-label="Find in terminal" className="absolute top-1 right-2 left-2 z-30 flex items-center gap-1 rounded border border-hairline bg-popover px-2 py-1 text-xs shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); find(event.shiftKey); }
      }}>
      <Search className="size-3 shrink-0" aria-hidden />
      <input ref={input} aria-label="Find in terminal" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find in terminal…" className="min-w-0 flex-1 bg-transparent px-1 py-1 outline-none" />
      <span role="status" className="shrink-0 text-muted-foreground">{query ? results.resultCount === 0 ? "No matches" : results.resultIndex < 0 ? `${results.resultCount}+ matches` : `${results.resultIndex + 1} of ${results.resultCount}` : ""}</span>
      <button type="button" aria-label="Match case" aria-pressed={matchCase} onClick={() => setMatchCase(!matchCase)} className="rounded px-1.5 py-1 hover:bg-veil-raised aria-pressed:bg-veil-raised">Aa</button>
      <button type="button" aria-label="Previous match" disabled={!query} onClick={() => find(true)} className="rounded p-1 hover:bg-veil-raised disabled:opacity-40"><ChevronUp className="size-3.5" /></button>
      <button type="button" aria-label="Next match" disabled={!query} onClick={() => find(false)} className="rounded p-1 hover:bg-veil-raised disabled:opacity-40"><ChevronDown className="size-3.5" /></button>
      <button type="button" aria-label="Close terminal search" onClick={close} className="rounded p-1 hover:bg-veil-raised"><X className="size-3.5" /></button>
    </div>}
    {!open && <button type="button" aria-label="Search terminal" onClick={show} className="absolute top-1 left-3 z-10 rounded bg-background px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Search className="size-3" /></button>}
    {!open && (selection.trim() || notice || error) && <div className="absolute right-4 bottom-3 z-20 max-w-[90%] rounded-md border border-hairline bg-popover px-2 py-1 text-xs shadow-md">
      {selection.trim() && <button type="button" disabled={pending} onMouseDown={(event) => event.preventDefault()} onClick={() => void add()} className="rounded px-1 py-1 hover:bg-veil-raised disabled:opacity-50">{pending ? "Adding…" : "Add to chat"}</button>}
      {notice && <span role="status">{notice}</span>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>}
  </>;
}
