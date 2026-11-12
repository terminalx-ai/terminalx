import { CircleAlert, LoaderCircle, ShieldAlert } from "@/icons";
import { cn } from "@/lib/cn";
import { usePrefs } from "@/lib/prefs";
import type { Run } from "@/types/orchestration";

/** What a lead's title bar says of its run (18.01, 18.03): that it needs the person, else how many workers run. `null` for neither. */
export function runPillOf(run: Run | null | undefined): { kind: "needs" | "approval" | "running"; text: string; why: string } | null {
  if (!run || ["done", "stopped"].includes(run.state)) return null;
  if (run.state === "awaitingApproval") return { kind: "approval", text: "Needs you", why: "The plan waits for your approval" };
  if (run.state === "needsYou") return { kind: "needs", text: "Needs you", why: run.pause?.message ?? run.reason ?? "The run reached its budget" };
  const blocked = run.pieces.filter((piece) => piece.state === "blocked" || piece.state === "failed");
  if (blocked.length) return { kind: "needs", text: "Needs you", why: blocked.map((piece) => `${piece.title} is blocked`).join("\n") };
  const stopped = run.pieces.find((piece) => piece.merge && ["conflict", "integrationFailed", "failed"].includes(piece.merge.state) && piece.state === "done");
  if (stopped && run.merge?.stoppedAt === stopped.id) return { kind: "needs", text: "Needs you", why: `${stopped.title} could not be merged` };
  const running = run.inTurn ?? run.pieces.filter((piece) => piece.state === "running" || piece.state === "stalled").length;
  if (running > 0) return { kind: "running", text: `${running} ${running === 1 ? "worker" : "workers"} running`, why: "Open the run" };
  return null;
}

/** The pill itself: opens the Run view. */
export function RunPill({ run, onOpen }: { run: Run | null | undefined; onOpen: () => void }) {
  const { animations } = usePrefs();
  const pill = runPillOf(run);
  if (!pill) return null;
  const Icon = pill.kind === "running" ? LoaderCircle : pill.kind === "approval" ? ShieldAlert : CircleAlert;
  return (
    <div
      role="button" tabIndex={0} data-testid="run-pill" data-pill={pill.kind} title={pill.why}
      onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}
      className={cn(
        "mr-1.5 inline-flex h-7 shrink-0 cursor-default items-center gap-1.5 self-center rounded-md px-2.5 text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        pill.kind === "running" ? "bg-veil-raised text-muted-foreground hover:text-foreground" : "bg-accent text-accent-foreground hover:bg-accent/90",
      )}
    >
      <Icon aria-hidden className={cn("size-3.5", pill.kind === "running" && animations && "animate-spin")} />
      {pill.text}
    </div>
  );
}
