import { useEffect, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";
import type { Turn } from "@/lib/transcript";

/** Below this many prompts there is nothing to find again: no map. */
const MIN_PROMPTS = 2;

/**
 * The reader's prompts as marks down the transcript's right edge, one per
 * turn that has one. The mark of the prompt being read is bright; hovering a
 * mark shows its prompt beside it, and a click goes back to that turn.
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

  return (
    <nav
      aria-label="Prompts"
      data-testid="prompt-map"
      className="pointer-events-none absolute inset-y-0 right-1.5 z-10 flex items-center"
      onMouseLeave={() => setHovered(null)}
    >
      <ol className="pointer-events-auto flex max-h-[70%] flex-col py-1">
        {prompts.map((turn, index) => {
          const text = turn.prompt!.text.trim();
          const active = turn.key === current;
          return (
            <li
              key={turn.key}
              className="flex min-h-[3px] max-h-[10px] flex-1 basis-[10px]"
            >
              <button
                type="button"
                aria-label={`Prompt ${index + 1}: ${text.slice(0, 80)}`}
                aria-current={active ? "true" : undefined}
                onClick={() => onJump(turn.key)}
                onMouseEnter={(e) =>
                  setHovered({
                    key: turn.key,
                    top:
                      e.currentTarget.offsetTop +
                      e.currentTarget.offsetHeight / 2,
                  })
                }
                onFocus={(e) =>
                  setHovered({
                    key: turn.key,
                    top:
                      e.currentTarget.offsetTop +
                      e.currentTarget.offsetHeight / 2,
                  })
                }
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
