import { useEffect, useRef, useState } from "react";
import { Code, Copy, Download, EllipsisVertical, Eye, FolderOpen, Save } from "@/icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MenuShortcut,
} from "@/components/ui/menu";
import type { ViewMode } from "@/lib/editors";
import { setPrefs, usePrefs } from "@/lib/prefs";

/**
 * The file tab's View options (PRO-297): how the source view is drawn, and
 * the file's contents taken elsewhere. Wrap and whitespace are app-wide
 * choices, so the next file opens the same way.
 */
export function ViewOptionsMenu({ copyKeys, onCopy, onDownload, onReveal, disabled }: {
  copyKeys: string[];
  onCopy: () => void;
  onDownload: () => void;
  /** Set while the toolbar is too narrow for its own Reveal in Finder button. */
  onReveal?: () => void;
  disabled: boolean;
}) {
  const { editorWrap, editorShowWhitespace } = usePrefs();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="View options" title="View options" className="data-[state=open]:bg-veil-strong data-[state=open]:text-foreground">
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[262px]" data-testid="view-options-menu">
        <DropdownMenuLabel className="px-2.5 pt-2 pb-1">View options</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={editorWrap} onCheckedChange={(on) => setPrefs({ editorWrap: on })} onSelect={(e) => e.preventDefault()} indicator="box" className="h-8 gap-2.5 px-2.5 text-[12.5px]">
          Wrap lines
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={editorShowWhitespace} onCheckedChange={(on) => setPrefs({ editorShowWhitespace: on })} onSelect={(e) => e.preventDefault()} indicator="box" className="h-8 gap-2.5 px-2.5 text-[12.5px]">
          Show whitespace
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabled} onSelect={onCopy} className="h-8 gap-2.5 px-2.5 text-[12.5px] [&_svg]:size-3.5">
          <Copy />
          Copy file contents
          {copyKeys.length > 0 && <MenuShortcut keys={copyKeys} />}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={onDownload} className="h-8 gap-2.5 px-2.5 text-[12.5px] [&_svg]:size-3.5">
          <Download />
          Download
        </DropdownMenuItem>
        {onReveal && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onReveal} className="h-8 gap-2.5 px-2.5 text-[12.5px] [&_svg]:size-3.5">
            <FolderOpen />
            Reveal in Finder
          </DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const REVEAL_MIN_WIDTH = 220;

export function EditorToolbar({ path, relativePath, markdown, viewMode, onViewModeChange, cloud, readOnly, dirty, truncated, saveDisabled, saveKeys, onSave, copyKeys, contentsDisabled, onCopy, onDownload }: {
  path: string;
  relativePath: string;
  markdown: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  cloud?: boolean;
  readOnly: boolean;
  dirty: boolean;
  truncated: boolean;
  saveDisabled: boolean;
  saveKeys: string[];
  onSave: () => void;
  copyKeys: string[];
  /** Nothing to copy or download yet (loading, binary, offline). */
  contentsDisabled: boolean;
  onCopy: () => void;
  onDownload: () => void;
}) {
  const slash = relativePath.lastIndexOf("/") + 1;
  // Below this width Reveal in Finder moves into View options, so the toolbar still fits.
  // The menu is portalled, outside the container query, so it reads the width itself.
  const bar = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? el.clientWidth) < REVEAL_MIN_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const reveal = () => void revealItemInDir(path).catch(() => {});
  const notes = [truncated && "first 4 MB shown", cloud && "cloud workspace", readOnly && "read-only", dirty && "unsaved"].filter((note): note is string => typeof note === "string");
  return (
    <div ref={bar} className="@container/editor-toolbar h-8 shrink-0 border-b border-hairline" data-testid="editor-toolbar">
      {/* Below the minimum icon width, scroll instead of crushing or overlapping controls. */}
      <div className="flex h-full items-center gap-2 overflow-x-auto px-3 text-xs">
        <span className="flex min-w-0 flex-1 text-muted-foreground" title={path}>
          <span className="truncate">{relativePath.slice(0, slash)}</span>
          <span className="min-w-0 shrink-0 truncate max-w-full">{relativePath.slice(slash)}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {notes.length > 0 && (
            <span title={notes.join(" · ")} aria-label={notes.join(" · ")} className="text-faint" data-testid="editor-notes">
              <span className="hidden max-w-20 truncate @min-[290px]/editor-toolbar:block">{notes.map((note, index) => <span key={note}>{index > 0 && " · "}<span className={note === "first 4 MB shown" ? "text-warning" : undefined}>{note}</span></span>)}</span>
              <span aria-hidden className="block size-1.5 rounded-full bg-current @min-[290px]/editor-toolbar:hidden" />
              {cloud && <span className="sr-only" data-testid="editor-cloud-file">cloud workspace</span>}
            </span>
          )}
          {markdown && (
            <Segmented<ViewMode>
              aria-label="View"
              value={viewMode}
              onChange={onViewModeChange}
              options={[
                { value: "preview", "aria-label": "Preview", title: "Preview", label: <><Eye aria-hidden className="size-3.5 @min-[360px]/editor-toolbar:hidden" /><span className="hidden @min-[360px]/editor-toolbar:inline">Preview</span></> },
                { value: "source", "aria-label": "Source", title: "Source", label: <><Code aria-hidden className="size-3.5 @min-[360px]/editor-toolbar:hidden" /><span className="hidden @min-[360px]/editor-toolbar:inline">Source</span></> },
              ]}
            />
          )}
          {/* The menu has both; the toolbar's own buttons give way first when it narrows. */}
          <Button variant="ghost" size="icon-xs" aria-label="Copy file contents" title={`Copy file contents ${copyKeys.join("")}`.trim()} className="hidden @min-[400px]/editor-toolbar:inline-flex" disabled={contentsDisabled} onClick={onCopy}>
            <Copy />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Download" title="Download" className="hidden @min-[400px]/editor-toolbar:inline-flex" disabled={contentsDisabled} onClick={onDownload}>
            <Download />
          </Button>
          <ViewOptionsMenu copyKeys={copyKeys} onCopy={onCopy} onDownload={onDownload} onReveal={!cloud && narrow ? reveal : undefined} disabled={contentsDisabled} />
          {!cloud && (
            <Button variant="ghost" size="icon-xs" aria-label="Reveal in Finder" title="Reveal in Finder" className="hidden @min-[220px]/editor-toolbar:inline-flex" onClick={reveal}>
              <FolderOpen />
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={onSave} disabled={saveDisabled} aria-label="Save" title={`Save ${saveKeys.join("")}`}>
            <Save className="size-3.5" />
            <span className="hidden @min-[440px]/editor-toolbar:inline">Save</span>
            <kbd className="ml-1 hidden text-[10px] text-faint @min-[520px]/editor-toolbar:inline">{saveKeys.join("")}</kbd>
          </Button>
        </span>
      </div>
    </div>
  );
}
