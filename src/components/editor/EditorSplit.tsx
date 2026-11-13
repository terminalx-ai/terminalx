import { useCallback, useEffect, useMemo, useRef } from "react";
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
  type ReviewEditorEntry,
  type AttachmentEditorEntry,
  attachmentFile,
} from "@/lib/editors";
import { DiffEditorPane } from "./DiffEditorPane";
import { PrPanel } from "@/components/changes/PrPanel";
import { ConflictView } from "@/components/changes/ConflictView";
import { MediaPane } from "./MediaPane";
import { EditorPane } from "./EditorPane";

import { useTerminals, type SelectedSessionTab } from "@/lib/terminal";
import { tabPanelId } from "@/lib/sessionTabIds";

const MIN_W = 320;

/**
 * The editor pane: open files as tabs beside the transcript. The chat keeps
 * its height and its composer; the pane takes width from the right, drags on
 * its left edge, and collapses to a thin strip so a long read never has to
 * be closed to see the conversation again. In narrow columns, the editor
 * fills the column until hidden or closed, keeping both surfaces usable.
 */
export function EditorSplit({ sessionId, active, fill = false, selectedTab, reviewsInPanes = false }: {
  sessionId: string;
  active: boolean;
  fill?: boolean;
  selectedTab?: SelectedSessionTab | null;
  /** The workspace panes draw review tabs in their own pane (PRO-263); this split still steps aside for one. */
  reviewsInPanes?: boolean;
}) {
  const prefs = usePrefs();
  const ed = useEditors();
  const requested = useTerminals().selected[sessionId];
  const selected = selectedTab === undefined ? requested : selectedTab;
  const all = ed.editors.filter((e) => e.sessionId === sessionId);
  // A checkout without a session has no workspace tab strip.
  const standalone = sessionId.startsWith("checkout:");
  const reviews = standalone ? [] : all.filter(isReviewEditor);
  const editors = standalone ? all : all.filter((e) => !isReviewEditor(e));
  const activeId = editors.find((e) => e.id === ed.active[sessionId])?.id ?? editors[editors.length - 1]?.id ?? null;
  const reviewActive = editors.some((e) => e.id === activeId && isReviewEditor(e));
  const fullWidth = fill || reviewActive;
  const reviewShown = reviews.some((e) => selected?.kind === "review" && selected.id === e.id);
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
    return parent ? Math.max(MIN_W, parent.clientWidth - 360) : 1200;
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

  useShortcut(
    "files.togglePreview",
    () => {
      if (activeId) toggleViewMode(activeId);
    },
    { enabled: active && !!activeId },
  );
  useShortcut("files.closeAll", () => void closeAllEditors(sessionId, !standalone), { enabled: active });

  const reviewPanes = reviewsInPanes ? null : reviews.map((entry) => <ReviewTab key={entry.id} entry={entry} visible={active && selected?.kind === "review" && selected.id === entry.id} />);

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
    <div
      ref={root}
      tabIndex={-1}
      role="region"
      aria-hidden={!editors.length || collapsed || reviewShown}
      aria-label={editors.find((e) => e.id === activeId)?.name ?? "Open files"}
      className={cn(
        "absolute inset-0 z-10 flex h-full w-full min-w-0 shrink-0 flex-col border-l border-hairline bg-background outline-none",
        (!editors.length || collapsed || reviewShown) && "hidden",
        // Beside a transcript it takes a resizable share; alone (a cloud workspace's files) it fills.
        !fullWidth && "@min-[768px]/editor-host:relative @min-[768px]/editor-host:w-(--editor-w) @min-[768px]/editor-host:max-w-[calc(100%-360px)]",
      )}
      onPointerDownCapture={() => setLastFocused("editor")}
      onFocusCapture={() => setLastFocused("editor")}
    >
      {!fullWidth && <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-ring/30"
      />}
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
                title={"attachment" in e && e.attachment ? shortPath(e.attachment.path) : e.rel}
                data-attachment={"attachment" in e && e.attachment ? "" : undefined}
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
        <WithTooltip label="Close all files" shortcut="files.closeAll">
          <Button variant="ghost" size="icon-xs" aria-label="Close all files" onClick={() => void closeAllEditors(sessionId, !standalone)}>
            <X />
          </Button>
        </WithTooltip>
      </div>
      <div className="relative min-h-0 flex-1">
        {editors.map((e) => (
          <div key={e.id} className={cn("absolute inset-0 flex flex-col", e.id !== activeId && "hidden")}>
            {e.kind === "diff" ? <DiffEditorPane entry={e} visible={e.id === activeId && active && !collapsed && !reviewShown} /> : e.kind === "conflict" ? <ConflictView entry={e} visible={e.id === activeId && active && !collapsed && !reviewShown} /> : e.kind === "pr" ? <PrPanel cwd={e.root} sessionId={e.sessionId.startsWith("checkout:") ? undefined : e.sessionId} branch={e.pr.head} selectedPr={e.pr} active={e.id === activeId && active && !collapsed && !reviewShown} busy={false} /> : e.kind === "attachment" ? <AttachmentPane entry={e} visible={e.id === activeId && active && !collapsed && !reviewShown} embedded={false} /> : e.kind === "text" ? <EditorPane entry={e} visible={e.id === activeId && active && !collapsed && !reviewShown} /> : <MediaPane entry={e} visible={e.id === activeId && active && !collapsed && !reviewShown} />}
          </div>
        ))}
      </div>
    </div>
  </>;
}

/**
 * Review surfaces share the workspace selection and retain their buffers while hidden.
 * In a workspace pane (`embedded`) the pane's cell is the tab panel, and two panes can
 * both show a tab: only the focused pane's takes the keyboard focus.
 */
export function ReviewTab({ entry, visible, focused = visible, embedded = false }: { entry: ReviewEditorEntry; visible: boolean; focused?: boolean; embedded?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible && focused) root.current?.focus({ preventScroll: true });
  }, [visible, focused]);
  return <div ref={root} role={embedded ? undefined : "tabpanel"} id={embedded ? undefined : tabPanelId({ kind: "review", id: entry.id })}
    aria-label={embedded ? undefined : entry.name} aria-hidden={embedded ? undefined : !visible} tabIndex={-1}
    className={cn("absolute inset-0 z-10 flex min-h-0 flex-col bg-background outline-none", !visible && "hidden")}
    onPointerDownCapture={() => setLastFocused("editor")} onFocusCapture={() => setLastFocused("editor")}>
    {entry.kind === "diff" ? <DiffEditorPane entry={entry} visible={visible} />
      : entry.kind === "conflict" ? <ConflictView entry={entry} visible={visible} />
      : entry.kind === "attachment" ? <AttachmentPane entry={entry} visible={visible} embedded={embedded} />
      : <PrPanel cwd={entry.root} sessionId={entry.sessionId} branch={entry.pr.head} selectedPr={entry.pr} active={visible} busy={false} />}
  </div>;
}

/** A file attached to a sent message, drawn by the file surfaces as a read-only file with the attachment toolbar (PRO-290). */
function AttachmentPane({ entry, visible, embedded }: { entry: AttachmentEditorEntry; visible: boolean; embedded: boolean }) {
  const file = useMemo(() => attachmentFile(entry), [entry]);
  return file.kind === "text" ? <EditorPane entry={file} visible={visible} embedded={embedded} /> : <MediaPane entry={file} visible={visible} />;
}
