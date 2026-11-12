import { Network, Sparkles } from "@/icons";
import { cn } from "@/lib/cn";

/** The two views of a session that can lead a run: the run, and the chat with the lead. */
export function RunStrip({ runShown, waiting, paused = false, onChange }: { runShown: boolean; /** The run's plan waits for approval. */ waiting: boolean; /** The run reached its budget and waits for the person (PRO-280). */ paused?: boolean; onChange: (runShown: boolean) => void }) {
  const tab = (selected: boolean) => cn(
    "relative flex h-full items-center gap-2 px-3 text-[13px] outline-none transition-colors focus-visible:bg-veil-raised",
    selected ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent" : "text-muted-foreground hover:text-foreground",
  );
  return (
    <div role="tablist" aria-label="Session views" data-testid="run-strip" className="flex h-9 shrink-0 items-stretch border-b border-hairline">
      <button type="button" role="tab" aria-selected={runShown} className={tab(runShown)} onClick={() => onChange(true)}>
        <Network aria-hidden className="size-3.5" />
        Run
        {waiting && <span className="size-1.5 rounded-full bg-accent" role="status" aria-label="A plan waits for your approval" />}
        {paused && <span className="size-1.5 rounded-full bg-warning" role="status" aria-label="The run reached its budget and waits for you" />}
      </button>
      <button type="button" role="tab" aria-selected={!runShown} className={tab(!runShown)} onClick={() => onChange(false)}>
        <Sparkles aria-hidden className="size-3.5" />
        Lead chat
      </button>
    </div>
  );
}
