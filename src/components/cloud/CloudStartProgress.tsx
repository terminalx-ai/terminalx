import { Check, Circle, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import type { cloudStartPhase, cloudStartSteps } from "@/lib/cloudStartProgress";

export function CloudStartProgress({ name, phase, steps, hasPrompt, cancel, cancelBusy, error }: {
  name: string;
  phase: NonNullable<ReturnType<typeof cloudStartPhase>>;
  steps: ReturnType<typeof cloudStartSteps>;
  hasPrompt: boolean;
  cancel?: () => void;
  cancelBusy: boolean;
  error: string | null;
}) {
  const canceling = cancelBusy || phase === "canceling";
  return (
    <section data-testid="cloud-start-progress" className="w-full max-w-xl rounded-lg border border-hairline bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 font-medium wrap-anywhere">
          {phase === "canceled" ? "Workspace start canceled" : canceling ? "Canceling workspace start…" : `Starting ${name}`}
        </h2>
        {cancel && !canceling && <Button size="sm" variant="outline" onClick={cancel}>Cancel</Button>}
      </div>
      {phase === "canceled" ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          The compute was released.{hasPrompt && " The first message was not sent."}
        </p>
      ) : canceling ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">Waiting for the workspace to finish canceling.</p>
      ) : (
        <>
          {hasPrompt && <p className="mt-2 text-xs text-muted-foreground">Your first message sends once the agent is ready.</p>}
          <ol aria-label="Start steps" className="mt-3 space-y-2">
            {steps.map(({ label, detail, state, duration }) => {
              const Icon = state === "done" ? Check : state === "current" ? Loader2 : Circle;
              return (
                <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined} className="flex items-start gap-2">
                  <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${state === "done" ? "text-success" : state === "current" ? "motion-safe:animate-spin" : "text-faint"}`} />
                  <div className="min-w-0 flex-1 wrap-anywhere">
                    <span className={state === "waiting" ? "text-muted-foreground" : undefined}>{label}</span>
                    {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
                  </div>
                  {state === "done" && <span className="sr-only">Completed</span>}
                  {duration && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{duration}</span>}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">Commands run in this cloud workspace.</p>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
