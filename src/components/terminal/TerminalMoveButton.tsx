import { useRef, useState } from "react";
import { LayoutPanelBottomDock, LayoutPanelBottomUndock } from "@/icons";
import { moveTerminal } from "@/lib/terminal";
import { setPrefs } from "@/lib/prefs";

export function TerminalMoveButton({ id, docked }: { id: string; docked: boolean }) {
  const moving = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = async () => {
    if (moving.current) return;
    moving.current = true;
    setPending(true);
    setError(null);
    try {
      // Make the destination host available before changing placement.
      if (!docked) setPrefs({ panelOpen: true, panelTerminalOpen: true });
      await moveTerminal(id, !docked);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      moving.current = false;
      setPending(false);
    }
  };
  return <>
    {/* Beside the button in its own row, never over the terminal's output. */}
    {error && <span role="alert" title={error} className="min-w-0 max-w-80 truncate text-xs text-destructive">{error}</span>}
    <button type="button" disabled={pending} onClick={() => void move()} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-xs whitespace-nowrap text-muted-foreground hover:bg-veil-raised hover:text-foreground disabled:opacity-50">{docked ? <LayoutPanelBottomUndock className="size-3.5" aria-hidden /> : <LayoutPanelBottomDock className="size-3.5" aria-hidden />}{docked ? "Move to tab" : "Move to dock"}</button>
  </>;
}
