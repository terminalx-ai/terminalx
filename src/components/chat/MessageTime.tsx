import { messageTime } from "@terminalx/portable/transcript";

/** Native disclosure works with mouse, keyboard and touch, without hover. */
export function MessageTime({ ts }: { ts?: string }) {
  const time = messageTime(ts);
  if (!time) return null;
  return (
    <details className="mt-1 max-w-full whitespace-normal text-xs font-normal text-muted-foreground">
      <summary aria-label={`Message time: ${time.full}`} title={time.full} className="-mx-1 w-fit max-w-full cursor-pointer list-none rounded px-1 py-1 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <time dateTime={time.iso}>{time.short}</time>
      </summary>
      <div className="pb-1 break-words">{time.full}</div>
    </details>
  );
}
