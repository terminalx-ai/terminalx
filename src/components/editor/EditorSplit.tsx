import { useCallback, useEffect, useRef } from "react";
import { PanelRightClose, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { cn } from "@/lib/cn";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import {
  closeAllEditors,
  closeEditor,
  setActiveEditor,
  setLastFocused,
  setPaneCollapsed,
  toggleViewMode,
  useEditors,
} from "@/lib/editors";
import { EditorPane } from "./EditorPane";

const MIN_W = 320;

/**
 * The editor pane: open files as tabs beside the transcript. The chat keeps
 * its height and its composer; the pane takes width from the right, drags on
 * its left edge, and collapses to a thin strip so a long read never has to
 * be closed to see the conversation again.
 */
export function EditorSplit({ sessionId, active }: { sessionId: string; active: boolean }) {
  const prefs = usePrefs();
  const ed = useEditors();
  const editors = ed.editors.filter((e) => e.sessionId === sessionId);
  const activeId = ed.active[sessionId] ?? editors[editors.length - 1]?.id ?? null;
  const collapsed = !!ed.collapsed[sessionId];
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; w: number; max: number } | null>(null);

  // The pane may take up to 70% of the column it sits in.
  const maxWidth = useCallback(() => {
    const parent = root.current?.parentElement;
    return parent ? Math.max(MIN_W, Math.floor(parent.clientWidth * 0.7)) : 1200;
  }, []);
  const clamp = (w: number, max: number) => Math.max(MIN_W, Math.min(max, w));
  const onDown = useCallback(
    (e: React.PointerEvent) => {
      drag.current = { x: e.clientX, w: prefs.editorPaneWidth, max: maxWidth() };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [prefs.editorPaneWidth, maxWidth],
  );
  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    document.documentElement.style.setProperty("--editor-w", `${clamp(d.w - (e.clientX - d.x), d.max)}px`);
  }, []);
  const onUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setPrefs({ editorPaneWidth: clamp(d.w - (e.clientX - d.x), d.max) });
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--editor-w", `${prefs.editorPaneWidth}px`);
  }, [prefs.editorPaneWidth]);

  useHotkey(
    "mod+shift+p",
    () => {
      if (activeId) toggleViewMode(activeId);
    },
    { enabled: active && !!activeId },
  );
  useHotkey("mod+alt+w", () => void closeAllEditors(sessionId), { enabled: active });

  if (!editors.length) return null;

  if (collapsed) {
    return (
      <div className="flex h-full w-8 shrink-0 flex-col items-center border-l border-hairline bg-well/30 pt-1.5">
        <WithTooltip label={`Show ${editors.length} open file${editors.length === 1 ? "" : "s"}`}>
          <Button variant="ghost" size="icon-xs" aria-label="Show editor pane" onClick={() => setPaneCollapsed(sessionId, false)}>
            <PanelRightClose className="rotate-180" />
          </Button>
        </WithTooltip>
        <span className="mt-2 rounded-full bg-veil-raised px-1.5 text-[10px] tabular-nums text-faint">{editors.length}</span>
      </div>
    );
  }

  return (
    <div
      ref={root}
      className="relative flex h-full w-(--editor-w) shrink-0 flex-col border-l border-hairline"
      onPointerDownCapture={() => setLastFocused("editor")}
      onFocusCapture={() => setLastFocused("editor")}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-ring/30"
      />
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-hairline bg-well/40 pl-1 pr-1" role="tablist" aria-label="Open files">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-thin">
          {editors.map((e) => {
            const isActive = e.id === activeId;
            return (
              <div
                key={e.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                title={e.rel}
                onClick={() => setActiveEditor(sessionId, e.id)}
                onKeyDown={(k) => k.key === "Enter" && setActiveEditor(sessionId, e.id)}
                onAuxClick={(k) => k.button === 1 && void closeEditor(e.id)}
                className={cn(
                  "group/tab flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] pl-1.5 pr-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  isActive ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <FileTypeIcon name={e.name} isDir={false} size={14} />
                <span className="max-w-[10rem] truncate">{e.name}</span>
                {e.dirty && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Unsaved" />}
                <button
                  type="button"
                  aria-label="Close file"
                  onClick={(k) => {
                    k.stopPropagation();
                    void closeEditor(e.id);
                  }}
                  className="ml-0.5 rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <WithTooltip label="Hide editor pane">
          <Button variant="ghost" size="icon-xs" aria-label="Hide editor pane" onClick={() => setPaneCollapsed(sessionId, true)}>
            <PanelRightClose />
          </Button>
        </WithTooltip>
        <WithTooltip label="Close all files" keys={keycaps("mod+alt+w")}>
          <Button variant="ghost" size="icon-xs" aria-label="Close all files" onClick={() => void closeAllEditors(sessionId)}>
            <X />
          </Button>
        </WithTooltip>
      </div>
      <div className="relative min-h-0 flex-1">
        {editors.map((e) => (
          <div key={e.id} className={cn("absolute inset-0 flex flex-col", e.id !== activeId && "hidden")}>
            <EditorPane entry={e} visible={e.id === activeId && active} />
          </div>
        ))}
      </div>
    </div>
  );
}
