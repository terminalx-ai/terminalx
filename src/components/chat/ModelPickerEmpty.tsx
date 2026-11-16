import { CircleAlert, Loader2 } from "@/icons";
import { DropdownMenuItem } from "@/components/ui/menu";

/**
 * What the model picker says, beside its Model row, while the agent's models
 * load, and the card it shows when the agent answered with none.
 */
export function ModelPickerEmpty({ agent, signIn, other, loading, retrying, onRetry, onOpenSettings }: {
  agent: string;
  /** Whose account the agent signs in with ("ChatGPT" for Codex), when it is not the agent's own. */
  signIn?: string;
  /** The other agent, whose models may still work. */
  other?: string;
  loading: boolean;
  retrying: boolean;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  if (loading || retrying) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground" role="status" data-testid="model-picker-loading">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Loading {agent} models…
      </div>
    );
  }
  return (
    <div data-testid="model-picker-empty" className="p-1">
      <div className="flex items-start gap-2.5 px-2.5 pb-2 pt-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-destructive/12 text-destructive" aria-hidden>
          <CircleAlert className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium leading-snug text-foreground">No models from {agent}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {agent} answered with an empty model list. Its {signIn ? `${signIn} ` : ""}sign-in may have expired: check it in Settings › Agents.
          </p>
        </div>
      </div>
      <div className="flex gap-1 px-1.5 pb-1.5 pl-[2.6rem]">
        <DropdownMenuItem onSelect={onOpenSettings} className="rounded-md bg-veil-raised px-2.5 py-1 text-xs">Open Settings › Agents</DropdownMenuItem>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onRetry(); }} className="rounded-md px-2.5 py-1 text-xs">Retry</DropdownMenuItem>
      </div>
      {other ? <p className="border-t border-hairline px-2.5 pb-1.5 pt-2 text-[11px] text-faint">{other} models still work. Pick {other} under Agent; it opens in a new tab.</p> : null}
    </div>
  );
}
