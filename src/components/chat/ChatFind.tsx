import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, CaseSensitive, Search, Terminal, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { SearchToggle } from "@/components/editor/SearchControls";
import { WithTooltip } from "@/components/ui/tooltip";
import { hasEscapeOverlay, keycaps, useHotkey, useShortcut } from "@/lib/hotkeys";
import { createChatSearchIndex, MAX_CHAT_MATCHES, searchTranscript } from "@/lib/chatSearch";
import { chatOwnsFocus, revealSearchRange, searchRangeRects, searchRanges } from "@/lib/chatSearchHighlights";
import { elementWithId, SEEK_ANCHOR_EVENT } from "@/lib/chatLinks";
import { READER_SCROLL_EVENT } from "@/lib/shellScroll";
import type { Transcript } from "@/lib/transcript";

export function useChatFind({ root, scroller, transcript, footerHeight }: {
  root: RefObject<HTMLDivElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  transcript: Transcript;
  footerHeight: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [includeToolOutput, setIncludeToolOutput] = useState(true);
  const [selected, setSelected] = useState(0);
  const [rects, setRects] = useState<(ReturnType<typeof searchRangeRects>[number] & { active: boolean })[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [index] = useState(createChatSearchIndex);
  const sections = useMemo(() => open ? index(transcript) : [], [index, transcript, open]);
  const matches = useMemo(() => searchTranscript(sections, query, { matchCase, includeToolOutput }), [sections, query, matchCase, includeToolOutput]);
  const current = Math.min(selected, Math.max(0, matches.length - 1));
  const active = open ? matches[current] : undefined;
  const activeId = active?.section.id;
  const activeTurn = active?.section.turnKey;
  const occurrence = active?.occurrence;
  const disclosures = useMemo(() => new Set(active?.section.disclosures), [active]);
  const ownsFocus = () => chatOwnsFocus(root.current, document.activeElement);
  const close = () => {
    setOpen(false);
    if (previousFocus.current?.isConnected && root.current?.contains(previousFocus.current)) previousFocus.current.focus({ preventScroll: true });
    else root.current?.focus({ preventScroll: true });
  };
  const move = (back: boolean) => {
    if (matches.length) setSelected((current + (back ? -1 : 1) + matches.length) % matches.length);
  };
  useShortcut("files.find", () => {
    if (!ownsFocus()) return false;
    if (!open) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  });
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);
  useHotkey("escape", () => {
    if (!ownsFocus() || hasEscapeOverlay()) return false;
    close();
  }, { enabled: open, global: true, priority: 10 });
  useHotkey("mod+g", () => {
    if (!ownsFocus()) return false;
    move(false);
  }, { enabled: open });
  useHotkey("mod+shift+g", () => {
    if (!ownsFocus()) return false;
    move(true);
  }, { enabled: open });

  // Give the existing seek path the owning turn: it can mount just that turn, even thousands away.
  useEffect(() => {
    const chat = scroller.current;
    if (chat && activeId && activeTurn && !elementWithId(chat, activeId)) chat.dispatchEvent(new CustomEvent(SEEK_ANCHOR_EVENT, { detail: { id: activeId, turnKey: activeTurn } }));
  }, [scroller, activeId, activeTurn, occurrence, query, matchCase]);

  // A highlight belongs to this chat, so a hidden tab cannot clear another tab's results.
  const name = `chat-find-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  useEffect(() => {
    const chat = scroller.current;
    if (!open || !chat) return;
    const native = typeof Highlight !== "undefined" && typeof CSS !== "undefined" && !!CSS.highlights;
    let pending = true;
    let chosenNode: Node | undefined;
    let chosenVisible = false;
    const paint = () => {
      const all: Range[] = [];
      let chosen: Range | undefined;
      for (const field of chat.querySelectorAll<HTMLElement>("[data-chat-search]")) {
        if (!includeToolOutput && field.hasAttribute("data-chat-search-tool")) continue;
        const ranges = searchRanges(field, query, matchCase, MAX_CHAT_MATCHES - all.length);
        all.push(...ranges);
        if (field.id === activeId) chosen = ranges[occurrence ?? 0];
      }
      if (native) {
        CSS.highlights.set(name, new Highlight(...all));
        const highlight = new Highlight(...(chosen ? [chosen] : []));
        highlight.priority = 1;
        CSS.highlights.set(`${name}-active`, highlight);
      }
      // A lazy code renderer can replace both the matched text and its scroller.
      // Follow that replacement only while the reader still has the match in view.
      if (chosen && (pending || (chosenVisible && chosenNode && !chosenNode.isConnected))) {
        pending = false;
        chat.dispatchEvent(new Event(READER_SCROLL_EVENT));
        revealSearchRange(chosen, chat, footerHeight);
      }
      chosenNode = chosen?.startContainer;
      chosenVisible = !!chosen && searchRangeRects(chosen, chat, footerHeight).length > 0;
      if (!native) setRects(all.flatMap((range) => searchRangeRects(range, chat, footerHeight).map((rect) => ({ ...rect, active: range === chosen }))));
    };
    paint();
    // Markdown syntax highlighting and virtual rows can finish after the find bar's commit.
    const observer = new MutationObserver(paint);
    observer.observe(chat, { childList: true, characterData: true, subtree: true });
    const resize = new ResizeObserver(paint);
    if (!native) {
      resize.observe(chat);
      window.addEventListener("resize", paint);
    }
    chat.addEventListener("scroll", paint, true);
    return () => {
      observer.disconnect();
      resize.disconnect();
      chat.removeEventListener("scroll", paint, true);
      window.removeEventListener("resize", paint);
      if (typeof CSS !== "undefined" && CSS.highlights) {
        CSS.highlights.delete(name);
        CSS.highlights.delete(`${name}-active`);
      }
    };
  }, [scroller, open, query, matchCase, includeToolOutput, activeId, occurrence, footerHeight, name]);

  const bar = open ? <div role="search" aria-label="Find in chat" className="z-20 border-b border-hairline bg-chat px-3 py-2 text-xs">
    <style>{`::highlight(${name}) { background-color: #e4b64866; color: inherit; } ::highlight(${name}-active) { background-color: #e4b648; color: #171717; }`}</style>
    {rects.length > 0 && createPortal(rects.map((rect, i) => <span key={i} aria-hidden data-chat-search-highlight className="pointer-events-none fixed z-20" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, background: rect.active ? "#e4b64888" : "#e4b64844", outline: rect.active ? "1px solid #b78719" : undefined }} />), document.body)}
    <div className="mx-auto flex max-w-3xl items-center gap-1">
      <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-well px-2 ring-ring/30 focus-within:ring-2">
        <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
        <input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); move(event.shiftKey); } }}
          aria-label="Find in chat" placeholder="Find in chat…" spellCheck={false} autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint" />
        <span role="status" className="shrink-0 tabular-nums text-faint">{query.trim() ? matches.length ? `${current + 1} of ${matches.length}${matches.length === MAX_CHAT_MATCHES ? "+" : ""}` : "No matches" : ""}</span>
        <SearchToggle label="Match case" pressed={matchCase} onClick={() => { setMatchCase(!matchCase); setSelected(0); }}><CaseSensitive className="size-3.5" /></SearchToggle>
        <SearchToggle label="Include tool output" pressed={includeToolOutput} onClick={() => { setIncludeToolOutput(!includeToolOutput); setSelected(0); }}><Terminal className="size-3.5" /></SearchToggle>
      </div>
      <WithTooltip label="Previous match" keys={keycaps("mod+shift+g")}><Button variant="ghost" size="icon-xs" aria-label="Previous match" disabled={!matches.length} onClick={() => move(true)}><ArrowUp /></Button></WithTooltip>
      <WithTooltip label="Next match" keys={keycaps("mod+g")}><Button variant="ghost" size="icon-xs" aria-label="Next match" disabled={!matches.length} onClick={() => move(false)}><ArrowDown /></Button></WithTooltip>
      <WithTooltip label="Close find" keys={keycaps("escape")}><Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={close}><X /></Button></WithTooltip>
    </div>
  </div> : null;
  return { bar, disclosures, hasMatch: !!active };
}
