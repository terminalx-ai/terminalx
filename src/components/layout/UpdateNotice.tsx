import { ArrowDownToLine, Loader2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { dismissUpdateNotice, installUpdate, useUpdate } from "@/lib/updates";

/** The sidebar footer's Update button, before Settings, while an update is ready or installing. */
export function UpdateButton() {
  const { state } = useUpdate();
  if (state.kind === "installing") {
    return (
      <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" /> {state.pct}%
      </span>
    );
  }
  if (state.kind !== "available") return null;
  return (
    <WithTooltip label={`Install TerminalX ${state.update.version} and relaunch`} side="top">
      <Button size="sm" variant="accent" className="h-7 shrink-0 gap-1.5 px-2.5" onClick={() => void installUpdate()} data-testid="sidebar-update">
        <ArrowDownToLine /> Update
      </Button>
    </WithTooltip>
  );
}

/**
 * A card in the window's bottom-right corner when an update is found: what it
 * is and a button to install it. "Later" closes it for this version; the
 * sidebar's Update button stays until it is installed.
 */
export function UpdateNotice() {
  const { state, noticeDismissed } = useUpdate();
  if (state.kind !== "available" || noticeDismissed) return null;
  const version = state.update.version;
  return (
    <div
      role="dialog"
      aria-label="Update available"
      data-testid="update-notice"
      className="fixed bottom-10 right-4 z-(--z-menu) w-[20rem] max-w-[calc(100vw-2rem)] rounded-xl bg-popover glass p-3.5 text-popover-foreground shadow-surface hairline animate-fade-in"
    >
      <button type="button" aria-label="Close" onClick={() => dismissUpdateNotice(version)} className="absolute right-2 top-2 rounded-md p-1 text-faint hover:bg-veil-raised hover:text-foreground">
        <X className="size-3.5" />
      </button>
      <div className="flex items-start gap-2.5 pr-5">
        <ArrowDownToLine className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">Update available</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">TerminalX {version} is ready to install. The app relaunches when it is done.</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => dismissUpdateNotice(version)}>
          Later
        </Button>
        <Button size="sm" variant="accent" onClick={() => void installUpdate()}>
          Update and relaunch
        </Button>
      </div>
    </div>
  );
}
