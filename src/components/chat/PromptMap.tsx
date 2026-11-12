import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { messageTime, type Turn } from "@/lib/transcript";

/** Below this many prompts there is nothing to find again: no map. */
const MIN_PROMPTS = 2;
/** How far an edge fades out when the rail runs on past it. */
const FADE_PX = 56;

/**
 * The reader's prompts as marks down the transcript's right edge, one per
 * turn that has one. The mark of the prompt being read is bright; hovering a
 * mark shows its prompt beside it, and a click goes back to that turn.
 *
 * Marks keep their spacing however long the session runs: past the rail's
 * height it scrolls, following the prompt being read on its own, and an edge
 * with more prompts beyond it fades into the background. A wheel over the
 * rail scrolls the rail, not the transcript.
 */
export function PromptMap({
  turns,
  scroller,
  onJump,
  locate,
}: {
  turns: Turn[];
  scroller: RefObject<HTMLDivElement | null>;
  onJump: (key: string) => void;
  /**
   * The index in `turns` of the turn under the reading line. A transcript
   * that draws only the turns near the view says it from its own layout;
   * without it, the drawn turns are measured.
   */
  locate?: () => number;
}) {
  const prompts = turns.filter((t) => t.prompt?.text.trim());
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const [current, setCurrent] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ key: string; top: number } | null>(
    null,
  );
  const nav = useRef<HTMLElement>(null);
  const rail = useRef<HTMLOListElement>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const pointerOnRail = useRef(false);
  const followed = useRef(false);
  // One stable set of handlers serves every mark, reading the latest hover and
  // jump target through refs, so a mark redraws only when its own prompt,
  // number or highlight changes. A send in a long session then draws its one
  // new mark rather than every mark again (#727's send budget).
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const actions = useMemo<MarkActions>(() => {
    const show = (button: HTMLElement, key: string) => {
      const box = nav.current?.getBoundingClientRect();
      const mark = button.getBoundingClientRect();
      setHovered({ key, top: mark.top + mark.height / 2 - (box?.top ?? 0) });
    };
    return {
      jump: (key) => onJumpRef.current(key),
      show,
      move: (button, key) => {
        if (hoveredRef.current?.key !== key) show(button, key);
      },
      hide: () => setHovered(null),
    };
  }, []);

  const measureFade = () => {
    const el = rail.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
  };

  // Keep the lit mark in the middle of the rail, unless the pointer is on it:
  // the marks never move out from under the reader's cursor.
  useEffect(() => {
    const el = rail.current;
    if (!el || !current || pointerOnRail.current) return;
    const mark = el.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(current)}"]`,
    );
    if (!mark) return;
    const top = mark.offsetTop + mark.offsetHeight / 2 - el.clientHeight / 2;
    el.scrollTo?.({ top, behavior: followed.current ? "smooth" : "auto" });
    followed.current = true;
  }, [current]);

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    measureFade();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measureFade);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [prompts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // The prompt being read: the last one whose turn starts above the top third of the view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const at = locateRef.current?.();
      if (at != null) {
        // The last prompt at or above the turn being read.
        let found: string | null = null;
        const list = turnsRef.current;
        for (let i = 0; i <= Math.min(at, list.length - 1); i++) if (list[i].prompt?.text.trim()) found = list[i].key;
        setCurrent(found ?? prompts[0]?.key ?? null);
        return;
      }
      const line = el.getBoundingClientRect().top + el.clientHeight / 3;
      let found: string | null = prompts[0]?.key ?? null;
      for (const turn of prompts) {
        const node = el.querySelector<HTMLElement>(
          `[data-turn="${CSS.escape(turn.key)}"]`,
        );
        if (!node) continue;
        if (node.getBoundingClientRect().top <= line) found = turn.key;
        else break;
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, prompts.length, prompts[prompts.length - 1]?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (prompts.length < MIN_PROMPTS) return null;
  const hoveredPrompt = hovered && prompts.find((t) => t.key === hovered.key)?.prompt;
  const preview = hoveredPrompt?.text.trim();
  const sent = shortTime(hoveredPrompt?.messageTs);
  const mask =
    fade.top || fade.bottom
      ? `linear-gradient(to bottom, ${fade.top ? "transparent" : "black"}, black ${FADE_PX}px, black calc(100% - ${FADE_PX}px), ${fade.bottom ? "transparent" : "black"})`
      : undefined;
  const maskStyle: CSSProperties | undefined = mask
    ? { maskImage: mask, WebkitMaskImage: mask }
    : undefined;

  return (
    <nav
      ref={nav}
      aria-label="Prompts"
      data-testid="prompt-map"
      className="pointer-events-none absolute inset-y-0 right-1.5 z-10 flex items-center"
      onMouseLeave={() => setHovered(null)}
    >
      <ol
        ref={rail}
        className="scrollbar-none pointer-events-auto relative flex max-h-[70%] flex-col overflow-y-auto overscroll-contain py-1"
        style={maskStyle}
        onScroll={() => {
          measureFade();
          // The marks moved under a still pointer: its preview no longer points at it.
          if (pointerOnRail.current) setHovered(null);
        }}
        onMouseEnter={() => (pointerOnRail.current = true)}
        onMouseLeave={() => (pointerOnRail.current = false)}
      >
        {prompts.map((turn, index) => (
          <PromptMark
            key={turn.key}
            turnKey={turn.key}
            index={index}
            text={turn.prompt!.text.trim()}
            active={turn.key === current}
            actions={actions}
          />
        ))}
      </ol>
      {hovered && preview && (
        <div
          role="tooltip"
          className="pointer-events-none absolute right-7 z-(--z-tooltip) w-max max-w-[18rem] -translate-y-1/2 rounded-md bg-popover px-2.5 py-1.5 text-xs leading-snug text-popover-foreground shadow-surface hairline"
          style={{ top: hovered.top }}
        >
          {sent && (
            <time dateTime={sent.iso} className="mb-0.5 block text-[11px] text-faint">
              {sent.label}
            </time>
          )}
          <span className="line-clamp-3 whitespace-pre-wrap break-words">
            {preview}
          </span>
        </div>
      )}
    </nav>
  );
}

/** What a mark does when it is used: the same for every mark of a map. */
interface MarkActions {
  jump: (key: string) => void;
  show: (button: HTMLElement, key: string) => void;
  /** A pointer moving over a mark shows its prompt, unless that prompt is already shown. */
  move: (button: HTMLElement, key: string) => void;
  hide: () => void;
}

/**
 * One prompt's mark. It depends only on its own prompt, number and highlight
 * and the map's stable actions, so it is drawn again only when one of those
 * changes.
 */
const PromptMark = memo(function PromptMark({
  turnKey,
  index,
  text,
  active,
  actions,
}: {
  turnKey: string;
  index: number;
  text: string;
  active: boolean;
  actions: MarkActions;
}) {
  return (
    <li data-key={turnKey} className="flex h-[10px] shrink-0">
      <button
        type="button"
        aria-label={`Prompt ${index + 1}: ${text.slice(0, 80)}`}
        aria-current={active ? "true" : undefined}
        onClick={() => actions.jump(turnKey)}
        onMouseEnter={(e) => actions.show(e.currentTarget, turnKey)}
        onMouseMove={(e) => actions.move(e.currentTarget, turnKey)}
        onFocus={(e) => actions.show(e.currentTarget, turnKey)}
        onBlur={actions.hide}
        className="group flex w-6 items-center justify-end outline-none"
      >
        <span
          className={cn(
            "h-[2px] rounded-full transition-[width,background-color] duration-100",
            active
              ? "w-4 bg-foreground/70"
              : "w-3 bg-faint/50 group-hover:w-4 group-hover:bg-foreground/60 group-focus-visible:bg-foreground/60",
          )}
        />
      </button>
    </li>
  );
});

/**
 * When a prompt was sent, as short as it can be and still be plain: the
 * time today, the weekday and time within the week, else the date.
 */
export function shortTime(ts?: string, now = new Date(), locales?: string): { label: string; iso: string } | null {
  const time = messageTime(ts, locales);
  if (!time) return null;
  const at = new Date(time.iso);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (at >= startOfToday) return { label: time.short, iso: time.iso };
  if (at >= weekAgo) return { label: `${new Intl.DateTimeFormat(locales, { weekday: "short" }).format(at)} ${time.short}`, iso: time.iso };
  return { label: new Intl.DateTimeFormat(locales, { month: "short", day: "numeric" }).format(at), iso: time.iso };
}
