import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { keycaps } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { FileTreeView } from "./FileTreeView";

const MIN_W = 180;
const MAX_W = 480;

/**
 * The explorer column: the session's checkout as a tree, sitting between the
 * sidebar and the transcript so a file is one click from the conversation
 * about it. Width drags on the right edge and persists; ⌘⇧E or the header
 * button shows and hides it.
 */
export function ExplorerPane({
  sessionId,
  root,
  rootName,
  mentionTabId,
  statusKey,
}: {
  sessionId: string;
  root: string;
  rootName: string;
  mentionTabId?: string | null;
  statusKey?: string;
}) {
  const prefs = usePrefs();
  const [tick, setTick] = useState(0);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const clamp = (w: number) => Math.max(MIN_W, Math.min(MAX_W, w));
  const onDown = useCallback(
    (e: React.PointerEvent) => {
      drag.current = { x: e.clientX, w: prefs.explorerWidth };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [prefs.explorerWidth],
  );
  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    document.documentElement.style.setProperty("--explorer-w", `${clamp(d.w + (e.clientX - d.x))}px`);
  }, []);
  const onUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setPrefs({ explorerWidth: clamp(d.w + (e.clientX - d.x)) });
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--explorer-w", `${prefs.explorerWidth}px`);
  }, [prefs.explorerWidth]);

  return (
    <aside className="relative flex h-full w-(--explorer-w) shrink-0 flex-col overflow-hidden border-r border-hairline bg-well/30">
      <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-0.5 pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-faint">Explorer</span>
        <WithTooltip label="Refresh">
          <Button variant="ghost" size="icon-xs" aria-label="Refresh explorer" onClick={() => setTick((t) => t + 1)}>
            <RefreshCw />
          </Button>
        </WithTooltip>
        <WithTooltip label="Hide explorer" keys={keycaps("mod+shift+e")}>
          <Button variant="ghost" size="icon-xs" aria-label="Hide explorer" onClick={() => setPrefs({ explorerOpen: false })}>
            <X />
          </Button>
        </WithTooltip>
      </div>
      <div className="min-h-0 flex-1">
        <FileTreeView sessionId={sessionId} root={root} rootName={rootName} active mentionTabId={mentionTabId} statusKey={statusKey} refreshTick={tick} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-ring/30"
      />
    </aside>
  );
}
