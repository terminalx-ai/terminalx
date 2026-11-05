import { messageTime } from "@terminalx/portable/transcript";
import { cn } from "@/lib/cn";

/**
 * Native disclosure works with mouse, keyboard and touch, without hover.
 * `inline` sits in a row (a turn's footer) rather than on a line of its own.
 */
export function MessageTime({ ts, inline }: { ts?: string; inline?: boolean }) {
  const time = messageTime(ts);
  if (!time) return null;
  return (
    <details className={cn("max-w-full whitespace-normal text-xs font-normal", inline ? "shrink-0 text-faint [&>summary]:whitespace-nowrap" : "mt-1 text-muted-foreground")}>
      <summary aria-label={`Message time: ${time.full}`} title={time.full} className="-mx-1 w-fit max-w-full cursor-pointer list-none rounded px-1 py-1 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <time dateTime={time.iso}>{time.short}</time>
      </summary>
      <div className="pb-1 break-words">{time.full}</div>
    </details>
  );
}

/**
 * A message's time that takes no room: under the bubble's right edge, shown
 * while the message is hovered or the time has keyboard focus. Its parent is
 * `relative` and carries `group/msg`.
 */
export function HoverTime({ ts }: { ts?: string }) {
  const time = messageTime(ts);
  if (!time) return null;
  return (
    <time
      dateTime={time.iso}
      title={time.full}
      aria-label={`Message time: ${time.full}`}
      tabIndex={0}
      className="absolute right-1 top-full mt-0.5 rounded px-1 text-[11px] leading-4 text-faint opacity-0 transition-opacity outline-none group-hover/msg:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {time.short}
    </time>
  );
}
