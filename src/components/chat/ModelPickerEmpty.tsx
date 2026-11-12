import { Loader2 } from "@/icons";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/menu";

/** What the model picker says while the agent's models load, and when it answered with none. */
export function ModelPickerEmpty({ agent, other, loading, retrying, onRetry, onOpenSettings }: {
  agent: string;
  /** The other agent, whose models may still work. */
  other?: string;
  loading: boolean;
  retrying: boolean;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  if (loading || retrying) {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground" role="status" data-testid="model-picker-loading">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Loading {agent} models…
      </div>
    );
  }
  return (
    <div data-testid="model-picker-empty">
      <DropdownMenuLabel className="text-foreground">No models from {agent}</DropdownMenuLabel>
      <p className="max-w-72 px-2 pb-1.5 text-xs text-muted-foreground">
        {agent} answered with an empty model list. Its sign-in may have expired: check it in Settings › Agents.
      </p>
      <DropdownMenuItem onSelect={onOpenSettings}>Open Settings › Agents</DropdownMenuItem>
      <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onRetry(); }}>Retry</DropdownMenuItem>
      {other ? <p className="max-w-72 px-2 pt-1.5 text-xs text-faint">{other} models still work. Pick {other} under Agent; it opens in a new tab.</p> : null}
    </div>
  );
}
