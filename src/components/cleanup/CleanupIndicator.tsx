import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { freedText } from "@/components/cleanup/CleanupRunView";
import { clearCleanupRun, summarize, useCleanupRun, type CleanupRun } from "@/lib/cleanupRun";
import { openWorktreeCleanup, useDialogs } from "@/lib/dialogs";
import { clearLeftoverRun, leftoverTotals, useLeftoverRun, useLeftoverRunWatched, type LeftoverRun } from "@/lib/leftoverRun";
import { formatSize } from "@/lib/workspaceSizes";

/** How long a result with nothing to look at stays before it goes by itself. */
export const CLEAN_RESULT_MS = 8_000;

/** Kept between the indicator and what it must not sit on. */
const CLEARANCE = 8;

type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/**
 * How far up `own` has to move so that it does not sit on any of `controls`.
 * `own` is where it rests with no lift at all.
 */
export function liftClearOf(own: Box, controls: Box[]): number {
  let lift = 0;
  // Moving up off one control can land on another, so this settles first. Each pass clears one for good.
  for (let pass = 0; pass <= controls.length; pass++) {
    const under = controls.find((control) => control.right > own.left && control.left < own.right && control.bottom > own.top - lift && control.top < own.bottom - lift);
    if (!under) break;
    lift = own.bottom - under.top + CLEARANCE;
  }
  return lift;
}

/**
 * The lift that keeps `element` off a composer (`data-composer-box`): its
 * send controls, and the text being typed. An indicator stays for as long as
 * a clean-up runs, and a message must be writable and sendable all that
 * time. The composer comes and goes with the session and moves with the
 * panels, so while the indicator is up this is read again twice a second
 * instead of being hooked into each of those.
 */
function useLiftOffComposer(element: React.RefObject<HTMLElement | null>, active: boolean): number {
  const [lift, setLift] = useState(0);
  const applied = useRef(0);
  applied.current = lift;
  useLayoutEffect(() => {
    if (!active) {
      setLift(0);
      return;
    }
    const measure = () => {
      const node = element.current;
      if (!node) return;
      const now = node.getBoundingClientRect();
      // Where it rests: what is measured already includes the lift in force.
      const rest = { left: now.left, right: now.right, top: now.top + applied.current, bottom: now.bottom + applied.current };
      const composers = [...document.querySelectorAll<HTMLElement>("[data-composer-box]")].map((composer) => composer.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
      setLift(Math.round(liftClearOf(rest, composers)));
    };
    measure();
    const timer = window.setInterval(measure, 500);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [element, active]);
  return lift;
}

function Ring({ done, total, text }: { done: number; total: number; text: string }) {
  const length = 2 * Math.PI * 8;
  return (
    <svg role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={text} viewBox="0 0 20 20" className="size-5 shrink-0 -rotate-90">
      <circle cx="10" cy="10" r="8" fill="none" stroke="var(--hairline-strong)" strokeWidth="2.5" />
      <circle cx="10" cy="10" r="8" fill="none" stroke="var(--ink-strong)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${total ? (done / total) * length : 0} ${length}`} className="transition-[stroke-dasharray] duration-300" />
    </svg>
  );
}

interface CardProps {
  /** What this is, for a screen reader: "Worktree clean-up". */
  label: string;
  /** Still going: there is progress to show, and nothing to dismiss. */
  progress: { done: number; total: number; text: string } | null;
  title: string;
  detail: string | null;
  /** The result holds something to look at: it stays until it is dismissed. */
  problems: boolean;
  open: string;
  onOpen: () => void;
  onDismiss: () => void;
}

function Card({ label, progress, title, detail, problems, open, onOpen, onDismiss }: CardProps) {
  const finishedClean = !progress && !problems;
  useEffect(() => {
    if (!finishedClean) return;
    const timer = window.setTimeout(onDismiss, CLEAN_RESULT_MS);
    return () => window.clearTimeout(timer);
  }, [finishedClean, onDismiss]);

  let icon: ReactNode;
  if (progress) icon = <Ring {...progress} />;
  else if (problems) icon = <AlertCircle aria-hidden className="size-5 shrink-0 text-warning" />;
  else icon = <CheckCircle2 aria-hidden className="size-5 shrink-0 text-add" />;

  return (
    <section
      aria-label={label}
      data-cleanup-indicator
      // The whole card opens it for the mouse; the button is the same action for the keyboard.
      onClick={onOpen}
      className="pointer-events-auto flex max-w-full cursor-pointer items-center gap-2.5 rounded-xl bg-popover glass px-3 py-2.5 text-sm shadow-surface hairline animate-fade-in"
    >
      {icon}
      <div role="status" className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        {detail && <div className="truncate text-xs tabular-nums text-muted-foreground">{detail}</div>}
      </div>
      <Button
        variant="secondary"
        size="xs"
        className="shrink-0"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        {open}
      </Button>
      {!progress && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          className="shrink-0 rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </section>
  );
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function worktreeCard(run: CleanupRun): Omit<CardProps, "onOpen" | "onDismiss"> {
  const sum = summarize(run);
  if (run.status === "running") {
    return {
      label: "Worktree clean-up",
      progress: { done: sum.done, total: sum.total, text: `${sum.done} of ${plural(sum.total, "worktree", "worktrees")} done` },
      // The one it is on, not how many are done: "4 of 12" while the fourth is being removed.
      title: run.stopping ? "Stopping the clean-up" : `Cleaning up ${Math.min(sum.done + 1, sum.total)} of ${sum.total}`,
      detail: `${formatSize(sum.freedBytes)} freed`,
      problems: false,
      open: "Show",
    };
  }
  const left = [sum.skipped > 0 && `${sum.skipped} skipped`, sum.failed > 0 && `${sum.failed} failed`].filter(Boolean).join(", ");
  return { label: "Worktree clean-up", progress: null, title: `Removed ${sum.removed}, freed ${freedText(sum)}`, detail: left || null, problems: sum.problems > 0, open: "Details" };
}

function leftoverCard(run: LeftoverRun): Omit<CardProps, "onOpen" | "onDismiss"> {
  const sum = leftoverTotals(run);
  const total = run.items.length;
  if (run.status === "running") {
    return {
      label: "Leftover clean-up",
      progress: { done: run.finished.length, total, text: `${run.finished.length} of ${plural(total, "leftover", "leftovers")} done` },
      title: run.checking ? "Checking leftovers again" : `Deleting leftovers, ${Math.min(run.finished.length + 1, total)} of ${total}`,
      detail: `${formatSize(sum.freedBytes)} freed`,
      problems: false,
      open: "Show",
    };
  }
  if (run.error) return { label: "Leftover clean-up", progress: null, title: "Leftovers could not be deleted", detail: run.error, problems: true, open: "Details" };
  return { label: "Leftover clean-up", progress: null, title: `Deleted ${sum.deleted}, freed ${formatSize(sum.freedBytes)}`, detail: sum.kept > 0 ? `${sum.kept} kept` : null, problems: sum.kept > 0, open: "Details" };
}

/**
 * The corner's view of a clean-up that is not on screen: how far it is while
 * it runs, then what it came to. Opening it shows the whole thing where it
 * was started. A result with anything skipped, failed or kept stays until it
 * is dismissed; one where everything went goes by itself.
 *
 * It belongs in the stack the toasts are in, below them, so the two never
 * overlap. It is only as wide as what it says, and lifts that stack off a
 * composer, so a message can be written and sent while it is there.
 */
export function CleanupIndicator({ onOpenStorage }: { onOpenStorage: () => void }) {
  const run = useCleanupRun();
  const { worktreeCleanup: dialogOpen } = useDialogs();
  const leftovers = useLeftoverRun();
  const watched = useLeftoverRunWatched();
  const stack = useRef<HTMLDivElement>(null);

  // The dialog is the other view of the same run; the Storage tab of the same leftovers.
  const worktrees = run && !dialogOpen ? run : null;
  const storage = leftovers && !watched && !(leftovers.status === "done" && leftovers.seen) ? leftovers : null;
  const lift = useLiftOffComposer(stack, !!worktrees || !!storage);
  if (!worktrees && !storage) return null;
  return (
    <div ref={stack} className="flex shrink-0 flex-col items-end gap-2" style={lift ? { marginBottom: lift } : undefined}>
      {storage && <Card {...leftoverCard(storage)} onOpen={onOpenStorage} onDismiss={clearLeftoverRun} />}
      {worktrees && <Card {...worktreeCard(worktrees)} onOpen={openWorktreeCleanup} onDismiss={clearCleanupRun} />}
    </div>
  );
}
