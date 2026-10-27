import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { closeTerminal, dockPanes, openDockTerminal, useTerminals } from "@/lib/terminal";
import { TerminalView } from "./TerminalView";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 800;
const clampHeight = (h: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));

/**
 * The right panel's terminals: shells in the session's folder, below the
 * panel's tabs. Any number of them, one shown at a time; folded, only the
 * tab row stays. They are the session's, so each window lists the same ones
 * and they close with the session.
 */
export function TerminalDock({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const prefs = usePrefs();
  const open = prefs.panelTerminalOpen;
  const panes = dockPanes(sessionId, useTerminals().panes);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const current = panes.find((pane) => pane.id === picked) ?? panes.at(-1);
  const [height, setHeight] = useState(() => clampHeight(prefs.panelTerminalHeight));
  const dragging = useRef<{ y: number; h: number } | null>(null);

  const add = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    setPrefs({ panelTerminalOpen: true });
    try {
      const pane = await openDockTerminal(sessionId, cwd);
      setPicked(pane.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [sessionId, cwd, starting]);

  const toggle = () => {
    if (open) return setPrefs({ panelTerminalOpen: false });
    if (!panes.length) return void add();
    setPrefs({ panelTerminalOpen: true });
  };

  // A shell that exited (`exit`, ^D) leaves its tab, as a closed terminal does.
  const exited = panes.filter((pane) => pane.exited).map((pane) => pane.id).join(",");
  useEffect(() => {
    for (const id of exited ? exited.split(",") : []) void closeTerminal(id);
  }, [exited]);

  const onDown = (e: React.PointerEvent) => {
    dragging.current = { y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (d) setHeight(clampHeight(d.h - (e.clientY - d.y)));
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = null;
    setPrefs({ panelTerminalHeight: height });
  };

  return (
    <section
      aria-label="Terminal"
      data-testid="panel-terminal"
      className="relative flex shrink-0 flex-col border-t border-hairline bg-background"
      style={open ? { height, maxHeight: "75%" } : undefined}
    >
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          className="absolute -top-1 left-0 z-10 h-2 w-full cursor-row-resize hover:bg-ring/30"
        />
      )}
      <div className="flex h-8 shrink-0 items-center gap-1 px-1.5">
        <Button variant="ghost" size="icon-xs" aria-label={open ? "Hide terminal" : "Show terminal"} aria-expanded={open} onClick={toggle} className="text-muted-foreground">
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
        <div role="tablist" aria-label="Terminals" className="flex h-full min-w-0 flex-1 items-stretch gap-3 overflow-x-auto pr-2">
          {!panes.length && (
            <button type="button" onClick={toggle} className="text-xs text-muted-foreground hover:text-foreground">
              Terminal
            </button>
          )}
          {panes.map((pane) => {
            const selected = open && pane.id === current?.id;
            const label = panes.length === 1 ? "Terminal" : pane.title;
            return (
              <div key={pane.id} className="group relative flex shrink-0 items-stretch">
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => {
                    setPicked(pane.id);
                    setPrefs({ panelTerminalOpen: true });
                  }}
                  className={cn("border-b text-xs", selected ? "border-foreground/60 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                >
                  {label}
                </button>
                {/* Over the label's end on hover, so it takes no room and the underline is the label's alone. */}
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={() => void closeTerminal(pane.id)}
                  className="absolute top-1/2 right-0 flex size-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-sm bg-background text-muted-foreground opacity-0 ring-1 ring-hairline hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <WithTooltip label="New terminal">
          <Button variant="ghost" size="icon-xs" aria-label="New terminal" disabled={starting} onClick={() => void add()} className="text-muted-foreground">
            <Plus />
          </Button>
        </WithTooltip>
      </div>
      {open && (
        <div className="relative min-h-0 flex-1">
          {error && (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {panes.map((pane) => (
            <div key={pane.id} className={cn("absolute inset-0 pl-1", pane.id !== current?.id && "invisible")}>
              <TerminalView id={pane.id} visible={pane.id === current?.id} redraw={false} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
