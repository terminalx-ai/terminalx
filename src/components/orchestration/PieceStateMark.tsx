import { CircleAlert, CircleCheck, CircleDashed, CircleX, Hourglass, LoaderCircle, ScanSearch, SkipForward, Sparkles, Square } from "@/icons";
import { cn } from "@/lib/cn";
import { PIECE_STATE_LABEL, type ShownPieceState } from "@/lib/orchestration";
import { useReducedMotion } from "@/lib/reducedMotion";
import type { PieceState } from "@/types/orchestration";

/** One glyph and colour per piece state: the Run view's labels and the sidebar's worker rows (PRO-281) draw the same. */
export const PIECE_STATE_STYLE: Record<ShownPieceState, { icon: typeof CircleCheck; className: string }> = {
  queued: { icon: CircleDashed, className: "text-faint" },
  // Queued behind a piece that cannot go on by itself (18.03): the dashed circle, named for what holds it.
  waiting: { icon: CircleDashed, className: "text-muted-foreground" },
  running: { icon: LoaderCircle, className: "text-accent" },
  stalled: { icon: Hourglass, className: "text-warning" },
  verifying: { icon: ScanSearch, className: "text-info" },
  done: { icon: CircleCheck, className: "text-add" },
  // Red, as 18.03 draws it: a blocked piece is what holds the run up.
  blocked: { icon: CircleAlert, className: "text-destructive" },
  failed: { icon: CircleX, className: "text-destructive" },
  stopped: { icon: Square, className: "text-faint" },
  skipped: { icon: SkipForward, className: "text-faint" },
  lead: { icon: Sparkles, className: "text-accent" },
};

/** A piece's state as the Run view labels it: its mark and its name. */
export function PieceStateMark({ state }: { state: ShownPieceState }) {
  const { icon: Icon, className } = PIECE_STATE_STYLE[state];
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]", className)}><Icon aria-hidden className="size-3.5 shrink-0" />{PIECE_STATE_LABEL[state]}</span>;
}

/** The mark alone, as a worker row leads with it; the state is its name. */
export function PieceStateIcon({ state, className }: { state: PieceState; className?: string }) {
  const reduced = useReducedMotion();
  const { icon: Icon, className: colour } = PIECE_STATE_STYLE[state];
  return (
    <span role="img" aria-label={PIECE_STATE_LABEL[state]} title={PIECE_STATE_LABEL[state]} data-piece-mark={state} className={cn("inline-flex shrink-0", colour, className)}>
      <Icon aria-hidden className={cn("size-3.5", state === "running" && !reduced && "animate-spin")} />
    </span>
  );
}
