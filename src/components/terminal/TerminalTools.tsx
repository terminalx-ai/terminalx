import { isMac } from "@/lib/platform";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, MessageSquarePlus, Search, X } from "@/icons";
import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/theme";
import { hasEscapeOverlay, useHotkey, useShortcut } from "@/lib/hotkeys";
import { ariaKeyShortcut, bindingText } from "@/lib/shortcuts";
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

/**
 * The terminal's own keys while the focus is in it. They are the surface's,
 * like Escape in a dialog: bound by chord, ahead of the app's action on the
 * same keys (the command palette, Pull, Copy contents), which still has them
 * everywhere else.
 */
function terminalKey(chord: string) {
  return { chord, label: bindingText(chord), aria: ariaKeyShortcut(chord) ?? "" };
}

export const TERMINAL_KEYS = {
  clear: terminalKey("mod+k"),
  addToChat: terminalKey("mod+shift+l"),
  matchCase: terminalKey("mod+alt+c"),
} as const;

/** Run `action` for a terminal key only while the focus is inside `frame`; otherwise the key falls through. */
export function useTerminalKey(chord: string, frame: RefObject<HTMLElement | null>, action: () => void, enabled: boolean) {
  const handler = useCallback(() => {
    if (!frame.current?.contains(document.activeElement)) return false;
    action();
  }, [frame, action]);
  useHotkey(chord, handler, { enabled, global: true, priority: 10 });
}

const kbd = "rounded-sm bg-veil-strong px-1 font-sans text-[10.5px] font-medium text-foreground/80";

type Toggle = "caseSensitive" | "wholeWord" | "regex";
const TOGGLES: { key: Toggle; label: string; text: string }[] = [
  { key: "caseSensitive", label: "Match case", text: "Aa" },
  { key: "wholeWord", label: "Match whole word", text: "ab" },
  { key: "regex", label: "Use regular expression", text: ".*" },
];

/** Where the Add to chat pill goes: under the selection's last line, inside the frame. */
function pillPlace(term: Terminal, frame: HTMLElement, pill: { width: number; height: number }): { left: number; top: number } | null {
  const position = term.getSelectionPosition?.();
  const screen = term.element?.querySelector(".xterm-screen");
  if (!position || !screen) return null;
  const box = screen.getBoundingClientRect();
  const outer = frame.getBoundingClientRect();
  if (!box.width || !box.height || !term.cols || !term.rows) return null;
  const cellWidth = box.width / term.cols;
  const cellHeight = box.height / term.rows;
  const end = position.end ?? position.start;
  const row = end.y - term.buffer.active.viewportY;
  const gap = 6;
  const margin = 8;
  const below = box.top - outer.top + (row + 1) * cellHeight + gap;
  const above = box.top - outer.top + (position.start.y - term.buffer.active.viewportY) * cellHeight - gap - pill.height;
  const bottom = outer.height - margin - pill.height;
  // Under the last line when there is room, over the first line when there is not, and always in the frame.
  const top = below <= bottom ? below : Math.max(margin, Math.min(bottom, above));
  const anchor = box.left - outer.left + end.x * cellWidth - pill.width;
  const left = Math.max(margin, Math.min(outer.width - margin - pill.width, anchor));
  return { left: Math.round(left), top: Math.round(Math.max(margin, top)) };
}

/** Search and selection act on the instance currently mounted in this view. */
export function TerminalTools({ id, shown, frame }: { id: string; shown: boolean; frame: RefObject<HTMLDivElement | null> }) {
  const addToChat = useContext(TerminalChatContext);
  const { resolvedMode } = useTheme();
  const decorations = resolvedMode === "dark" ? darkDecorations : lightDecorations;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Record<Toggle, boolean>>({ caseSensitive: false, wholeWord: false, regex: false });
  const [results, setResults] = useState<ISearchResultChangeEvent>({ resultCount: 0, resultIndex: -1 });
  const [invalid, setInvalid] = useState(false);
  const [selection, setSelection] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const search = useRef<SearchAddon | null>(null);
  const adding = useRef(false);

  const show = useCallback(() => {
    setOpen(true);
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  const findFocused = useCallback(() => {
    if (!frame.current?.contains(document.activeElement)) return false;
    show();
  }, [frame, show]);
  useShortcut("files.find", findFocused, { enabled: shown });

  const close = useCallback(() => { setOpen(false); peekInstance(id)?.term.focus(); }, [id]);
  const closeFocused = useCallback(() => {
    if (!frame.current?.contains(document.activeElement) || hasEscapeOverlay()) return false;
    close();
  }, [frame, close]);
  // The window dispatches shortcuts in capture, before React's key handler.
  // Search owns Escape ahead of a running agent's interrupt, just as chat find does.
  useHotkey("escape", closeFocused, { enabled: shown && open, global: true, priority: 10 });
  const toggleCase = useCallback(() => setOptions((current) => ({ ...current, caseSensitive: !current.caseSensitive })), []);
  useTerminalKey(TERMINAL_KEYS.matchCase.chord, frame, toggleCase, shown && open);

  useEffect(() => {
    if (!shown || !open) return;
    const inst = peekInstance(id);
    if (!inst) return;
    const addon = new SearchAddon();
    inst.term.loadAddon(addon);
    search.current = addon;
    // Writes and resizes recompute with noScroll. Only explicit searches and
    // navigation should move the viewport; background results just update the bar.
    const change = addon.onDidChangeResults(setResults);
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    return () => {
      change.dispose();
      addon.clearDecorations();
      inst.term.clearSelection();
      addon.dispose();
      search.current = null;
    };
  }, [id, shown, open]);

  const run = (how: "next" | "previous", extra: Partial<ISearchOptions> = {}) => {
    const addon = search.current;
    if (!addon) return;
    try {
      const searchOptions = { ...options, decorations, ...extra };
      if (how === "previous") addon.findPrevious(query, searchOptions);
      else addon.findNext(query, searchOptions);
      setInvalid(false);
    } catch {
      // A regular expression still being typed ("[a-").
      addon.clearDecorations();
      setInvalid(true);
      setResults({ resultCount: 0, resultIndex: -1 });
    }
  };

  useEffect(() => {
    if (!shown || !open) return;
    // addon-search 0.16 caches the count for the same query even when an
    // option changes. Invalidate its decorations before recomputing.
    search.current?.clearDecorations();
    if (query) run("next", { incremental: true });
    else {
      setInvalid(false);
      peekInstance(id)?.term.clearSelection();
      setResults({ resultCount: 0, resultIndex: -1 });
    }
  // `run` reads the current query and options.
  }, [query, options, id, shown, open, decorations]);

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

  const hasPill = !open && !!(selection.trim() || notice || error);
  // The pill follows the selection: placed after it renders (its size is known),
  // and again when the terminal scrolls or changes size under it.
  useLayoutEffect(() => {
    if (!hasPill || !selection.trim()) return;
    const term = peekInstance(id)?.term;
    const outer = frame.current;
    if (!term || !outer) return;
    const update = () => {
      const box = pill.current?.getBoundingClientRect();
      const next = pillPlace(term, outer, { width: box?.width ?? 0, height: box?.height ?? 0 });
      setPlace((current) => (current?.left === next?.left && current?.top === next?.top ? current : next));
    };
    update();
    const scroll = term.onScroll?.(update);
    const resize = term.onResize?.(update);
    return () => { scroll?.dispose(); resize?.dispose(); };
  }, [id, hasPill, selection, frame]);

  const add = useCallback(async () => {
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
  }, [addToChat, selection, id]);
  const addSelected = useCallback(() => void add(), [add]);
  useTerminalKey(TERMINAL_KEYS.addToChat.chord, frame, addSelected, shown && !open && !!addToChat && !!selection.trim());

  if (!shown) return null;
  const status = !query ? "" : invalid ? "Invalid pattern" : results.resultCount === 0 ? "No matches" : results.resultIndex < 0 ? `${results.resultCount}+ matches` : `${results.resultIndex + 1} of ${results.resultCount}`;
  return <>
    {/* A row of its own above the output: the card never covers a line of it. */}
    {open && <div className="flex shrink-0 justify-end px-2 pt-2 pb-1" data-testid="terminal-find-row">
      <div role="search" aria-label="Find in terminal" data-testid="terminal-find" className="flex w-[475px] max-w-full flex-col gap-1 rounded-lg border border-hairline bg-popover px-2 pt-1.5 pb-1.5 text-xs shadow-md focus-within:ring-2 focus-within:ring-ring/40"
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); run(event.shiftKey ? "previous" : "next"); }
        }}>
        <div className="flex items-center gap-1">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input ref={input} aria-label="Find in terminal" aria-invalid={invalid || undefined} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find in terminal" spellCheck={false} className="min-w-0 flex-1 bg-transparent px-1 py-1 outline-none" />
          <span role="status" className={cn("shrink-0 tabular-nums", invalid ? "text-destructive" : "text-muted-foreground")}>{status}</span>
          <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Search options">
            {TOGGLES.map((toggle) => <button key={toggle.key} type="button" aria-label={toggle.label} title={toggle.key === "caseSensitive" ? `${toggle.label} (${TERMINAL_KEYS.matchCase.label})` : toggle.label} aria-pressed={options[toggle.key]}
              onClick={() => setOptions((current) => ({ ...current, [toggle.key]: !current[toggle.key] }))}
              className="h-6 min-w-6 rounded px-1 font-mono text-[11px] text-muted-foreground outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:bg-veil-strong aria-pressed:text-foreground">{toggle.text}</button>)}
          </div>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-hairline" aria-hidden />
          <button type="button" aria-label="Previous match" disabled={!query} onClick={() => run("previous")} className="rounded p-1 outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"><ChevronUp className="size-3.5" /></button>
          <button type="button" aria-label="Next match" disabled={!query} onClick={() => run("next")} className="rounded p-1 outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"><ChevronDown className="size-3.5" /></button>
          <button type="button" aria-label="Close terminal search" onClick={close} className="rounded p-1 outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40"><X className="size-3.5" /></button>
        </div>
        <ul aria-label="Find keys" data-testid="terminal-find-keys" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-hairline px-1 pt-1 text-[11px] text-muted-foreground">
          <li><kbd className={kbd}>↵</kbd> next</li>
          <li><kbd className={kbd}>{isMac ? "⇧↵" : "Shift+Enter"}</kbd> previous</li>
          <li><kbd className={kbd}>{TERMINAL_KEYS.matchCase.label}</kbd> match case</li>
          <li><kbd className={kbd}>esc</kbd> closes</li>
        </ul>
      </div>
    </div>}
    {hasPill && <div ref={pill} data-testid="terminal-add-to-chat"
      className={cn("absolute z-20 flex max-w-[90%] items-center gap-1 rounded-full border border-hairline bg-popover px-1 py-0.5 text-xs shadow-md", !place && "right-4 bottom-3")}
      style={place ? { left: place.left, top: place.top } : undefined}>
      {selection.trim() && <button type="button" disabled={pending} onMouseDown={(event) => event.preventDefault()} onClick={() => void add()}
        aria-label="Add to chat" aria-keyshortcuts={TERMINAL_KEYS.addToChat.aria}
        className="flex items-center gap-1.5 rounded-full py-1 pr-1 pl-2 hover:bg-veil-raised disabled:opacity-50">
        <MessageSquarePlus className="size-3.5 shrink-0" aria-hidden />
        <span>{pending ? "Adding…" : "Add to chat"}</span>
        <kbd className={kbd} aria-hidden>{TERMINAL_KEYS.addToChat.label}</kbd>
      </button>}
      {notice && <span role="status" className="px-2 py-1">{notice}</span>}
      {error && <p role="alert" className="px-2 py-1 text-destructive">{error}</p>}
    </div>}
  </>;
}
