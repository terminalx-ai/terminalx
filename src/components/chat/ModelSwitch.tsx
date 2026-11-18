import { TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";

/**
 * Asked before a model change mid-chat: the new model rebuilds the prompt
 * cache, so the next reply is slower and costs more. Nothing is switched
 * until the reader says so.
 */
export function ModelSwitchConfirm({ model, onCancel, onConfirm }: { model: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      role="group"
      aria-labelledby="model-switch-title"
      data-testid="model-switch-confirm"
      className="mb-2 flex items-start gap-2.5 rounded-xl border border-warning/35 bg-warning/10 px-3 py-2.5 text-warning"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p id="model-switch-title" className="text-[13px] font-medium">Mid-chat model change</p>
        <p className="mt-0.5 text-xs text-foreground/80">
          Switching to {model} mid-chat rebuilds the prompt cache. The next reply is slower and uses more tokens.
        </p>
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="secondary" size="sm" className="bg-warning/20 text-warning hover:bg-warning/30" onClick={onConfirm} autoFocus>
            Switch model
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Said under the composer once a mid-chat switch is agreed, with the way back. */
export function ModelSwitchNotice({ model, onUndo }: { model: string; onUndo: () => void }) {
  return (
    <div className="mt-1.5 flex items-center gap-1 px-2 text-[11px] text-muted-foreground" role="status" data-testid="model-switch-notice">
      <span className="min-w-0 truncate">Switch requested for {model}</span>
      <span aria-hidden className="text-faint">·</span>
      <button type="button" className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
