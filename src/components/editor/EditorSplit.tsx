import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRightClose, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { cn } from "@/lib/cn";
import { shortPath } from "@/lib/paths";
import { useShortcut } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import {
  closeAllEditors,
  closeEditor,
  setActiveEditor,
  setLastFocused,
  setPaneCollapsed,
  toggleViewMode,
  useEditors,
  isReviewEditor,
  isTabEditor,
  type TabEditorEntry,
  type AttachmentEditorEntry,
  attachmentFile,
} from "@/lib/editors";
import { DiffEditorPane } from "./DiffEditorPane";
import { CheckLogTab } from "@/components/changes/CheckLogTab";
import { PrPanel } from "@/components/changes/PrPanel";
import { ConflictView } from "@/components/changes/ConflictView";
import { MediaPane } from "./MediaPane";
import { EditorPane } from "./EditorPane";

import { useTerminals, type SelectedSessionTab } from "@/lib/terminal";
import { tabPanelId } from "@/lib/sessionTabIds";

const MIN_W = 320;

export { useFileTabShortcuts } from "./useFileTabShortcuts";

/**
 * The editor pane, where files are not tabs of a session: a cloud
 * workspace's files, and a checkout's with no session. Its open files are
 * tabs of its own; beside a transcript the pane takes width from the right,
 * drags on its left edge, and collapses to a thin strip so a long read never
 * has to be closed to see the conversation again. In narrow columns, the
 * editor fills the column until hidden or closed, keeping both surfaces usable.
 *
 * A local session's files are tabs in its tab strip, beside the chat
 * (PRO-402): the session's panes draw them, and this pane draws none of
 * them. Where a session has no panes (the floating window), its file and
 * review tabs are drawn here, one at a time, as the tab strip selects them.
 */
export const EditorSplit = memo(function EditorSplit({ sessionId, active, fill = false, selectedTab }: {
  sessionId: string;
  active: boolean;
  fill?: boolean;
  selectedTab?: SelectedSessionTab | null;
}) {
  const prefs = usePrefs();
  const ed = useEditors();
  const requested = useTerminals().selected[sessionId];
  const selected = selectedTab === undefined ? requested : selectedTab;
  const all = ed.editors.filter((e) => e.sessionId === sessionId);
  // A checkout without a session has no workspace tab strip.
  const standalone = sessionId.startsWith("checkout:");
  const reviews = standalone ? [] : all.filter(isTabEditor);
  const editors = standalone ? all : all.filter((e) => !isTabEditor(e));
  const activeId = editors.find((e) => e.id === ed.active[sessionId])?.id ?? editors[editors.length - 1]?.id ?? null;
  const reviewActive = editors.some((e) => e.id === activeId && isReviewEditor(e));
  const fullWidth = fill || reviewActive;
  const shownTab = reviews.find((e) => selected?.kind === "review" && selected.id === e.id);
  const reviewShown = !!shownTab;
  const collapsed = !!ed.collapsed[sessionId];
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; w: number; max: number } | null>(null);

  // A review covers the composer, so give it focus (also after restoration).
  // Otherwise typing or ⌘W could still act on the hidden conversation.
  useEffect(() => {
    if (active && reviewActive && !collapsed) root.current?.focus({ preventScroll: true });
  }, [active, activeId, reviewActive, collapsed]);

  // Leave enough space for the composer in side-by-side mode.
  const maxWidth = useCallback(() => {
    const parent = root.current?.parentElement;
    return parent && parent.clientWidth > 0 ? Math.max(MIN_W, parent.clientWidth - 360) : 1200;
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

  // The file on screen: a tab of the session when one is shown, else this pane's.
  const previewTarget = shownTab ? shownTab.id : activeId;
  useShortcut(
    "files.togglePreview",
    () => {
      if (previewTarget) toggleViewMode(previewTarget);
    },
    { enabled: active && !!previewTarget },
  );
  useShortcut("files.closeAll", () => void closeAllEditors(sessionId, !standalone), { enabled: active });

  const reviewPanes = reviews.map((entry) => <ReviewTab key={entry.id} entry={entry} visible={active && selected?.kind === "review" && selected.id === entry.id} />);

  return <>
    {reviewPanes}
    {editors.length > 0 && collapsed && !reviewShown && (
      <div className="flex h-full w-8 shrink-0 flex-col items-center border-l border-hairline bg-well/30 pt-1.5">
        <WithTooltip label={`Show ${editors.length} open file${editors.length === 1 ? "" : "s"}`}>
          <Button variant="ghost" size="icon-xs" aria-label="Show editor pane" onClick={() => setPaneCollapsed(sessionId, false)}>
            <PanelRightClose className="rotate-180" />
          </Button>
        </WithTooltip>
        <span className="mt-2 rounded-full bg-veil-raised px-1.5 text-[10px] tabular-nums text-faint">{editors.length}</span>
      </div>
    )}
    {/* A session whose files are all tabs of its own has no pane here, and no strip of open files. */}
    {editors.length > 0 && <div
      ref={root}
      tabIndex={-1}
      role="region"
      aria-hidden={collapsed || reviewShown}
      aria-label={editors.find((e) => e.id === activeId)?.name ?? "Open files"}
      className={cn(
        "absolute inset-0 z-10 flex h-full w-full min-w-0 shrink-0 flex-col border-l border-hairline bg-background outline-none",
        (collapsed || reviewShown) && "hidden",
        // Beside a transcript it takes a resizable share; alone (a cloud workspace's files) it fills.
        !fullWidth && "@min-[768px]/editor-host:relative @min-[768px]/editor-host:w-(--editor-w) @min-[768px]/editor-host:max-w-[calc(100%-360px)]",
      )}
      onPointerDownCapture={() => setLastFocused("editor")}
      onFocusCapture={() => setLastFocused("editor")}
    >
      {!fullWidth && <div
        role="separator"
        aria-label="Resize editor pane"
        aria-orientation="vertical"
        aria-valuemin={MIN_W}
        aria-valuemax={maxWidth()}
        aria-valuenow={Math.round(prefs.editorPaneWidth)}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={(e) => {
          const max = maxWidth();
          const step = e.shiftKey ? 80 : 32;
          const next =
            e.key === "ArrowLeft" ? clamp(prefs.editorPaneWidth + step, max)
            : e.key === "ArrowRight" ? clamp(prefs.editorPaneWidth - step, max)
            : e.key === "Home" ? MIN_W
            : e.key === "End" ? max
            : null;
          if (next !== null) {
            e.preventDefault();
            setPrefs({ editorPaneWidth: next });
          }
        }}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize outline-none hover:bg-ring/30 focus-visible:bg-ring/50 focus-visible:ring-2 focus-visible:ring-ring/40"
      />}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-hairline bg-well/40 pl-1 pr-1" role="tablist" aria-label="Open files">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-thin">
          {editors.map((e) => {
            const isActive = e.id === activeId;
            return (
              <div
                key={e.id}
                data-attachment={"attachment" in e && e.attachment ? "" : undefined}
                onAuxClick={(k) => k.button === 1 && void closeEditor(e.id)}
                className={cn(
                  "group/tab flex h-6 shrink-0 items-center gap-0.5 rounded-[5px] pl-1.5 pr-1 text-xs transition-colors",
                  isActive ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  title={"attachment" in e && e.attachment ? shortPath(e.attachment.path) : e.rel}
                  onClick={() => setActiveEditor(sessionId, e.id)}
                  className="flex h-full min-w-0 items-center gap-1.5 rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <FileTypeIcon name={e.name} isDir={false} size={14} />
                  <span className="max-w-[10rem] truncate">{e.name}</span>
                  {e.dirty && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Unsaved" />}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${e.name}`}
                  onClick={() => void closeEditor(e.id)}
                  className="ml-0.5 rounded-sm p-0.5 text-faint opacity-0 outline-none hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40"
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
        <WithTooltip label="Close all files" shortcut="files.closeAll">
          <Button variant="ghost" size="icon-xs" aria-label="Close all files" onClick={() => void closeAllEditors(sessionId, !standalone)}>
            <X />
          </Button>
        </WithTooltip>
      </div>
      <div className="relative min-h-0 flex-1">
        {editors.map((e) => (
          <LazyEditorSlot key={e.id} entry={e} isActive={e.id === activeId} visible={e.id === activeId && active && !collapsed && !reviewShown} />
        ))}
      </div>
    </div>}
  </>;
});

/** Defer mounting heavy inactive editor/diff/media/PR tabs until first shown, and unmount read-only live panels when hidden. */
function LazyEditorSlot({ entry: e, isActive, visible }: { entry: ReturnType<typeof useEditors>["editors"][number]; isActive: boolean; visible: boolean }) {
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);
  const mounted = e.kind === "pr" || e.kind === "checkLog" ? visible : everVisible || visible;
  return (
    <div className={cn("absolute inset-0 flex flex-col", !isActive && "hidden")}>
      {mounted && (
        e.kind === "diff" ? <DiffEditorPane entry={e} visible={visible} />
          : e.kind === "conflict" ? <ConflictView entry={e} visible={visible} />
          : e.kind === "pr" ? <PrPanel cwd={e.root} sessionId={e.sessionId.startsWith("checkout:") ? undefined : e.sessionId} branch={e.pr.head} selectedPr={e.pr} active={visible} busy={false} />
          : e.kind === "attachment" ? <AttachmentPane entry={e} visible={visible} embedded={false} />
          : e.kind === "checkLog" ? <CheckLogTab entry={e} visible={visible} />
          : e.kind === "text" ? <EditorPane entry={e} visible={visible} />
          : <MediaPane entry={e} visible={visible} />
      )}
    </div>
  );
}

/**
 * A session tab an editor fills: a review, or a file the session opened.
 * They share the workspace selection and retain their buffers while hidden.
 * In a workspace pane (`embedded`) the pane's cell is the tab panel, and two panes can
 * both show a tab: only the focused pane's takes the keyboard focus.
 */
export function ReviewTab({ entry, visible, focused = visible, embedded = false }: { entry: TabEditorEntry; visible: boolean; focused?: boolean; embedded?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);
  useEffect(() => {
    if (visible && focused) root.current?.focus({ preventScroll: true });
  }, [visible, focused]);
  const mounted = entry.kind === "pr" || entry.kind === "checkLog" ? visible : everVisible || visible;
  return <div ref={root} role={embedded ? undefined : "tabpanel"} id={embedded ? undefined : tabPanelId({ kind: "review", id: entry.id })}
    aria-label={embedded ? undefined : entry.name} aria-hidden={embedded ? undefined : !visible} tabIndex={-1}
    className={cn("absolute inset-0 z-10 flex min-h-0 flex-col bg-background outline-none", !visible && "hidden")}
    onPointerDownCapture={() => setLastFocused("editor")} onFocusCapture={() => setLastFocused("editor")}>
    {mounted && (
      entry.kind === "diff" ? <DiffEditorPane entry={entry} visible={visible} />
        : entry.kind === "conflict" ? <ConflictView entry={entry} visible={visible} />
        : entry.kind === "attachment" ? <AttachmentPane entry={entry} visible={visible} embedded={embedded} />
        : entry.kind === "pr" ? <PrPanel cwd={entry.root} sessionId={entry.sessionId} branch={entry.pr.head} selectedPr={entry.pr} active={visible} busy={false} />
        : entry.kind === "checkLog" ? <CheckLogTab entry={entry} visible={visible} />
        : entry.kind === "text" ? <EditorPane entry={entry} visible={visible} />
        : <MediaPane entry={entry} visible={visible} />
    )}
  </div>;
}

/** A file attached to a sent message, drawn by the file surfaces as a read-only file with the attachment toolbar (PRO-290). */
function AttachmentPane({ entry, visible, embedded }: { entry: AttachmentEditorEntry; visible: boolean; embedded: boolean }) {
  const file = useMemo(() => attachmentFile(entry), [entry]);
  return file.kind === "text" ? <EditorPane entry={file} visible={visible} embedded={embedded} /> : <MediaPane entry={file} visible={visible} />;
}
