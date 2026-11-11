import type { Goal } from "@/types/events";
import { cn } from "@/lib/cn";

const STATES: Record<Goal["status"], { label: string; tone: string }> = {
  active: { label: "Active", tone: "text-accent" },
  paused: { label: "Paused", tone: "text-muted-foreground" },
  complete: { label: "Done", tone: "text-accent" },
  blocked: { label: "Blocked", tone: "text-destructive" },
  budgetLimited: { label: "Budget reached", tone: "text-warning" },
  usageLimited: { label: "Usage limited", tone: "text-warning" },
};

const tokens = (value: number) => value.toLocaleString();

/** The latest reported goal stays visible while the conversation scrolls. */
export function GoalBanner({ goal }: { goal: Goal }) {
  const state = STATES[goal.status];
  const budget = goal.tokenBudget;
  const metered = budget != null && budget > 0;
  const percent = metered ? Math.min(100, Math.max(0, (goal.tokensUsed / budget) * 100)) : 0;
  const usage = metered
    ? `${tokens(goal.tokensUsed)} / ${tokens(budget)} tokens`
    : `${tokens(goal.tokensUsed)} tokens used · No token budget`;

  return (
    <section aria-label="Codex goal" className="shrink-0 border-b border-border bg-chat">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-6 py-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="font-medium">Goal <span className={cn("ml-2", state.tone)}>{state.label}</span></span>
          <span className="text-muted-foreground tabular-nums">{usage}</span>
        </div>
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[13px] [overflow-wrap:anywhere]">{goal.objective}</p>
        {metered && (
          <div role="meter" aria-label="Goal token budget" aria-valuemin={0} aria-valuemax={budget}
            aria-valuenow={Math.min(goal.tokensUsed, budget)} aria-valuetext={usage}
            className="h-1 overflow-hidden rounded-full bg-border">
            <div className={cn("h-full rounded-full", percent >= 100 ? "bg-destructive" : percent >= 80 ? "bg-warning" : "bg-accent")}
              style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
    </section>
  );
}
