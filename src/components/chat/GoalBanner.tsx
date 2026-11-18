import type { Goal } from "@/types/events";
import { Pause, Pencil, Play, Target } from "@/icons";
import { cn } from "@/lib/cn";

/** What Codex reports the goal is doing, as the card's label says it (03.12: "GOAL · PURSUING"). */
const STATES: Record<Goal["status"], { label: string; tone: string }> = {
  active: { label: "Pursuing", tone: "text-info" },
  paused: { label: "Paused", tone: "text-muted-foreground" },
  complete: { label: "Done", tone: "text-add" },
  blocked: { label: "Blocked", tone: "text-destructive" },
  budgetLimited: { label: "Budget reached", tone: "text-warning" },
  usageLimited: { label: "Usage limited", tone: "text-warning" },
};

/** 182000 → "182K", as the card's mono counter reads. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${+(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${+(value / 1_000_000).toFixed(1)}M`;
}

/**
 * The latest reported goal, as a card at the top of the transcript column
 * (PRO-380, design 03.12). It stays in view while the conversation scrolls.
 * Pause and Resume are Codex's own `/goal pause` and `/goal resume`; Edit
 * puts `/goal <objective>` in the composer to change and send.
 */
export function GoalBanner({ goal, onCommand, onEdit }: {
  goal: Goal;
  /** Sends a `/goal …` command to the agent; without it the card has no Pause or Resume. */
  onCommand?: (command: string) => void;
  /** Puts the goal in the composer to change; without it the card has no Edit. */
  onEdit?: (objective: string) => void;
}) {
  const state = STATES[goal.status];
  const budget = goal.tokenBudget;
  const metered = budget != null && budget > 0;
  const percent = metered ? Math.min(100, Math.max(0, (goal.tokensUsed / budget) * 100)) : 0;
  const usage = metered
    ? `${compactTokens(goal.tokensUsed)} / ${compactTokens(budget)} tokens`
    : `${compactTokens(goal.tokensUsed)} tokens used · No token budget`;
  const exact = metered
    ? `${goal.tokensUsed.toLocaleString()} / ${budget.toLocaleString()} tokens`
    : `${goal.tokensUsed.toLocaleString()} tokens used`;
  const toggle = goal.status === "active" ? "pause" : goal.status === "paused" ? "resume" : null;

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pt-3 pb-1">
      <section aria-label="Codex goal" className="flex items-center gap-3 rounded-lg border border-info/30 bg-info/5 px-3.5 py-2.5">
        <Target aria-hidden className="size-[15px] shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[.08em] text-info">
              Goal · <span className={state.tone}>{state.label}</span>
            </span>
            <span className="min-w-0 truncate" title={goal.objective} data-testid="goal-objective">{goal.objective}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            {metered && (
              <div role="meter" aria-label="Goal token budget" aria-valuemin={0} aria-valuemax={budget}
                aria-valuenow={Math.min(goal.tokensUsed, budget)} aria-valuetext={exact}
                className="h-1.5 w-[220px] max-w-[40%] shrink-0 overflow-hidden rounded-full bg-veil-strong">
                <div className={cn("h-full rounded-full", percent >= 100 ? "bg-destructive" : percent >= 80 ? "bg-warning" : "bg-info")}
                  style={{ width: `${percent}%` }} />
              </div>
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={exact}>{usage}</span>
          </div>
        </div>
        {(toggle && onCommand) || onEdit ? (
          <div className="flex shrink-0 items-center gap-1">
            {toggle && onCommand && (
              <button type="button" onClick={() => onCommand(`/goal ${toggle}`)}
                className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-veil-strong hover:text-foreground">
                {toggle === "pause" ? <Pause className="size-[13px]" /> : <Play className="size-[13px]" />}
                {toggle === "pause" ? "Pause" : "Resume"}
              </button>
            )}
            {onEdit && (
              <button type="button" onClick={() => onEdit(goal.objective)}
                className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-veil-strong hover:text-foreground">
                <Pencil className="size-[13px]" />
                Edit
              </button>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
