import { CircleAlert, CircleCheck, CircleDashed, CircleX, Hourglass, LoaderCircle, ScanSearch, Square } from "@/icons";
import { cn } from "@/lib/cn";
import { PIECE_STATE_LABEL } from "@/lib/orchestration";
import { usePrefs } from "@/lib/prefs";
import type { PieceState } from "@/types/orchestration";

/** One glyph and colour per piece state: the Run view's labels and the sidebar's worker rows (PRO-281) draw the same. */
export const PIECE_STATE_STYLE: Record<PieceState, { icon: typeof CircleCheck; className: string }> = {
  queued: { icon: CircleDashed, className: "text-faint" },
  running: { icon: LoaderCircle, className: "text-accent" },
  stalled: { icon: Hourglass, className: "text-warning" },
  verifying: { icon: ScanSearch, className: "text-info" },
  done: { icon: CircleCheck, className: "text-add" },
  blocked: { icon: CircleAlert, className: "text-warning" },
  failed: { icon: CircleX, className: "text-destructive" },
  stopped: { icon: Square, className: "text-faint" },
};

/** A piece's state as the Run view labels it: its mark and its name. */
export function PieceStateMark({ state }: { state: PieceState }) {
  const { icon: Icon, className } = PIECE_STATE_STYLE[state];
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]", className)}><Icon aria-hidden className="size-3.5 shrink-0" />{PIECE_STATE_LABEL[state]}</span>;
}

/** The mark alone, as a worker row leads with it; the state is its name. */
export function PieceStateIcon({ state, className }: { state: PieceState; className?: string }) {
  const { animations } = usePrefs();
  const { icon: Icon, className: colour } = PIECE_STATE_STYLE[state];
  return (
    <span role="img" aria-label={PIECE_STATE_LABEL[state]} title={PIECE_STATE_LABEL[state]} data-piece-mark={state} className={cn("inline-flex shrink-0", colour, className)}>
      <Icon aria-hidden className={cn("size-3.5", state === "running" && animations && "animate-spin")} />
    </span>
  );
}
