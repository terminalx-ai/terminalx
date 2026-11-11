import { useRef, useState } from "react";
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
    <button type="button" disabled={pending} onClick={() => void move()} className="shrink-0 rounded px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">{docked ? "Move to tab" : "Move to dock"}</button>
    {error && <p role="alert" className="absolute top-8 right-2 z-30 max-w-80 rounded border border-hairline bg-popover p-2 text-xs text-destructive">{error}</p>}
  </>;
}
