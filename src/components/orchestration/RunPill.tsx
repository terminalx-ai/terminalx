import { CircleAlert, Clock, LoaderCircle, ShieldAlert } from "@/icons";
import { cn } from "@/lib/cn";
import { joinKeycaps, useShortcutKeys } from "@/lib/hotkeys";
import { useReducedMotion } from "@/lib/reducedMotion";
import { resetClock } from "@/lib/orchestration";
import type { Run } from "@/types/orchestration";

/** What a lead's title bar says of its run (18.01, 18.03): that it needs the person, else how many workers run. `null` for
 * a session that leads no run (#1404: it looks like any other session), while the run is still being read, and for a run
 * with nothing to say. */
export function runPillOf(run: Run | null | undefined): { kind: "needs" | "approval" | "running" | "waiting"; text: string; why: string } | null {
  if (!run || ["done", "stopped"].includes(run.state)) return null;
  if (run.state === "awaitingApproval") return { kind: "approval", text: "Needs you", why: "The plan waits for your approval" };
  // Paused on its own points, it goes on by itself at the reset (#1004): said, not asked.
  if (run.state === "needsYou" && run.pause?.byItself && run.pause.resumeAt) return { kind: "waiting", text: `Goes on at ${resetClock(run.pause.resumeAt)}`, why: `${run.pause.message}\nIt goes on by itself when the window resets.` };
  if (run.state === "needsYou") return { kind: "needs", text: "Needs you", why: run.pause?.message ?? run.reason ?? "The run reached its budget" };
  // One the run hands to the lead by itself is not the person's (#1004).
  const blocked = run.pieces.filter((piece) => (piece.state === "blocked" || piece.state === "failed") && !piece.toLead);
  if (blocked.length) return { kind: "needs", text: "Needs you", why: blocked.map((piece) => `${piece.title} is blocked`).join("\n") };
  const stopped = run.pieces.find((piece) => piece.merge && ["conflict", "integrationFailed", "failed"].includes(piece.merge.state) && piece.state === "done");
  if (stopped && run.merge?.stoppedAt === stopped.id) return { kind: "needs", text: "Needs you", why: `${stopped.title} could not be merged` };
  const running = run.inTurn ?? run.pieces.filter((piece) => piece.state === "running" || piece.state === "stalled").length;
  if (running > 0) return { kind: "running", text: `${running} ${running === 1 ? "worker" : "workers"} running`, why: "Open the run" };
  return null;
}

/** The pill itself: opens the Run view. */
export function RunPill({ run, onOpen }: { run: Run | null | undefined; onOpen: () => void }) {
  const reduced = useReducedMotion();
  const pill = runPillOf(run);
  if (!pill) return null;
  const Icon = pill.kind === "running" ? LoaderCircle : pill.kind === "waiting" ? Clock : pill.kind === "approval" ? ShieldAlert : CircleAlert;
  return (
    <div
      role="button" tabIndex={0} data-testid="run-pill" data-pill={pill.kind} title={pill.why}
      onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}
      className={cn(
        "mr-1.5 inline-flex h-7 shrink-0 cursor-default items-center gap-1.5 self-center rounded-md px-2.5 text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        pill.kind === "running" || pill.kind === "waiting" ? "bg-veil-raised text-muted-foreground hover:text-foreground" : "bg-accent text-accent-foreground hover:bg-accent/90",
      )}
    >
      <Icon aria-hidden className={cn("size-3.5", pill.kind === "running" && !reduced && "animate-spin")} />
      {pill.text}
    </div>
  );
}

/**
 * The keys that open the Run view, beside the pill in a lead's title bar (18.01): "⇧⌘O run view". The reader's
 * own keys when they changed them (Settings → Keyboard shortcuts); nothing when the action has none.
 */
export function RunViewHint({ className }: { className?: string }) {
  const keys = useShortcutKeys("app.runView");
  if (!keys.length) return null;
  const text = joinKeycaps(keys);
  return (
    <span data-testid="run-view-hint" title="Open the Run view (Go → Run View)" className={cn("mr-1.5 inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap text-[11.5px] text-faint", className)}>
      <kbd className="font-sans text-muted-foreground">{text}</kbd>
      <span>run view</span>
    </span>
  );
}
