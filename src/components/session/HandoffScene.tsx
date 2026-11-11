import { cn } from "@/lib/cn";

/**
 * A picture of Continue in New Session: this conversation on the left, a new
 * one on the right, and its context carried across. The context leaves the
 * source as a small stack of lines, glides along the path between them, and
 * the new conversation's lines fill in as it lands; the source stays as it
 * was, since it stays open. One loop is five seconds (app.css, `.hs-*`);
 * under reduced motion it holds the finished handoff. It is sized from the
 * dialog's width (a share of it, at a fixed aspect), so it scales with it.
 */
export function HandoffScene({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("relative mx-auto aspect-[4/1] w-[68%]", className)} data-testid="handoff-scene">
      <Window className="left-0" label="This session">
        <Line width="78%" />
        <Line width="54%" />
        <Line width="66%" />
      </Window>
      {/* The path the context travels, quiet until it is on its way. The chip is centred on it by its animation
          (translateY(-50%)), not a class as well, which would lift it twice. */}
      {/* The path the context travels between the two windows; the chip rides it, centred on it by its animation
          (translate(-50%, -50%)) rather than a class as well, which would lift it twice. */}
      <span className="absolute inset-y-0 left-[38%] right-[38%]">
        <span className="absolute inset-x-1 top-1/2 border-t border-dashed border-foreground/15" />
        <span className="hs-packet absolute top-1/2 flex w-[30%] flex-col gap-0.5 rounded-md bg-accent/90 p-1 shadow-sm">
          <span className="h-0.5 w-full rounded-full bg-accent-foreground/70" />
          <span className="h-0.5 w-3/4 rounded-full bg-accent-foreground/70" />
          <span className="h-0.5 w-1/2 rounded-full bg-accent-foreground/70" />
        </span>
      </span>
      <Window className="hs-target right-0" label="New session">
        <Line className="hs-fill hs-fill-1" width="72%" />
        <Line className="hs-fill hs-fill-2" width="58%" />
        <span className="hs-fill hs-fill-3 flex items-center gap-1">
          <span className="h-1.5 w-1/3 rounded-full bg-foreground/25" />
          <span className="hs-caret h-2.5 w-px bg-foreground/70" />
        </span>
      </Window>
    </div>
  );
}

function Window({ className, label, children }: { className?: string; label: string; children: React.ReactNode }) {
  return (
    <div className={cn("absolute inset-y-0 flex w-[38%] flex-col gap-1.5 rounded-lg bg-veil-raised p-2.5", className)}>
      <span className="text-[10px] leading-none text-muted-foreground">{label}</span>
      <div className="flex flex-1 flex-col justify-end gap-1.5">{children}</div>
    </div>
  );
}

function Line({ width, className }: { width: string; className?: string }) {
  return <span className={cn("block h-1.5 rounded-full bg-foreground/25", className)} style={{ width }} />;
}
