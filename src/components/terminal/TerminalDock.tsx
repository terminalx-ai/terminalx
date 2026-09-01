import { useEffect, useRef } from "react";
import { ChevronDown, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { closeTerminal, openTerminal, setActiveTerminal, setDockOpen, toggleDock, useTerminals } from "@/lib/terminal";
import { TerminalView } from "./TerminalView";

/**
 * Terminals docked under the transcript, running in the session's own
 * checkout. ⌘J shows or hides the dock (opening a shell the first time);
 * panes stay alive while hidden, so a dev server keeps running.
 */
export function TerminalDock({ sessionId, cwd, active }: { sessionId: string; cwd: string; active: boolean }) {
  const terms = useTerminals();
  const prefs = usePrefs();
  const panes = terms.panes.filter((p) => p.sessionId === sessionId);
  const open = !!terms.open[sessionId];
  const activeId = terms.active[sessionId] ?? panes[0]?.id;
  const drag = useRef<{ y: number; h: number } | null>(null);

  useHotkey("mod+j", () => void toggleDock(sessionId, cwd), { enabled: active });

  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: prefs.terminalHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const h = Math.max(120, Math.min(window.innerHeight * 0.8, drag.current.h - (e.clientY - drag.current.y)));
    document.documentElement.style.setProperty("--dock-h", `${h}px`);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const h = Math.max(120, Math.min(window.innerHeight * 0.8, drag.current.h - (e.clientY - drag.current.y)));
    drag.current = null;
    setPrefs({ terminalHeight: h });
  };
  useEffect(() => {
    document.documentElement.style.setProperty("--dock-h", `${prefs.terminalHeight}px`);
  }, [prefs.terminalHeight]);

  if (!open) return null;

  return (
    <div className="relative flex h-(--dock-h) shrink-0 flex-col border-t border-hairline bg-well/40">
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize hover:bg-ring/30"
      />
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-1.5">
        <TerminalIcon className="mx-1 size-3.5 text-faint" />
        {panes.map((p) => (
          <div
            key={p.id}
            role="tab"
            aria-selected={p.id === activeId}
            onClick={() => setActiveTerminal(sessionId, p.id)}
            className={cn(
              "group/term flex h-6 items-center gap-1 rounded-md px-2 text-xs",
              p.id === activeId ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className={cn(p.exited && "line-through opacity-60")}>{p.title}</span>
            <button
              type="button"
              aria-label="Close terminal"
              onClick={(e) => {
                e.stopPropagation();
                void closeTerminal(p.id);
              }}
              className="rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/term:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <WithTooltip label="New terminal">
          <Button variant="ghost" size="icon-xs" aria-label="New terminal" onClick={() => void openTerminal(sessionId, cwd)}>
            <Plus />
          </Button>
        </WithTooltip>
        <WithTooltip label="Hide terminal" keys={keycaps("mod+j")}>
          <Button variant="ghost" size="icon-xs" aria-label="Hide terminal" className="ml-auto" onClick={() => setDockOpen(sessionId, false)}>
            <ChevronDown />
          </Button>
        </WithTooltip>
      </div>
      <div className="relative min-h-0 flex-1">
        {panes.map((p) => (
          <div key={p.id} className={cn("absolute inset-0", p.id !== activeId && "invisible")}>
            <TerminalView id={p.id} visible={p.id === activeId && active} />
            {p.exited && (
              <div className="absolute bottom-2 left-3 rounded-md bg-popover px-2 py-1 text-[11px] text-muted-foreground hairline">
                Process exited{p.exitCode != null ? ` (${p.exitCode})` : ""}.
              </div>
            )}
          </div>
        ))}
        {!panes.length && <div className="p-3 text-xs text-muted-foreground">No terminal yet.</div>}
      </div>
    </div>
  );
}
