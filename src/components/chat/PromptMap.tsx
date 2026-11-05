import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { cn } from "@/lib/cn";
import type { Turn } from "@/lib/transcript";

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
}: {
  turns: Turn[];
  scroller: RefObject<HTMLDivElement | null>;
  onJump: (key: string) => void;
}) {
  const prompts = turns.filter((t) => t.prompt?.text.trim());
  const [current, setCurrent] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ key: string; top: number } | null>(
    null,
  );
  const nav = useRef<HTMLElement>(null);
  const rail = useRef<HTMLOListElement>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const pointerOnRail = useRef(false);
  const followed = useRef(false);

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
  const preview =
    hovered && prompts.find((t) => t.key === hovered.key)?.prompt?.text.trim();
  const show = (button: HTMLElement, key: string) => {
    const box = nav.current?.getBoundingClientRect();
    const mark = button.getBoundingClientRect();
    setHovered({ key, top: mark.top + mark.height / 2 - (box?.top ?? 0) });
  };
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
        {prompts.map((turn, index) => {
          const text = turn.prompt!.text.trim();
          const active = turn.key === current;
          return (
            <li key={turn.key} data-key={turn.key} className="flex h-[10px] shrink-0">
              <button
                type="button"
                aria-label={`Prompt ${index + 1}: ${text.slice(0, 80)}`}
                aria-current={active ? "true" : undefined}
                onClick={() => onJump(turn.key)}
                onMouseEnter={(e) => show(e.currentTarget, turn.key)}
                onMouseMove={(e) => {
                  if (hovered?.key !== turn.key) show(e.currentTarget, turn.key);
                }}
                onFocus={(e) => show(e.currentTarget, turn.key)}
                onBlur={() => setHovered(null)}
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
        })}
      </ol>
      {hovered && preview && (
        <div
          role="tooltip"
          className="pointer-events-none absolute right-7 z-(--z-tooltip) w-max max-w-[18rem] -translate-y-1/2 rounded-md bg-popover glass px-2.5 py-1.5 text-xs leading-snug text-popover-foreground shadow-surface hairline"
          style={{ top: hovered.top }}
        >
          <span className="line-clamp-3 whitespace-pre-wrap break-words">
            {preview}
          </span>
        </div>
      )}
    </nav>
  );
}
