import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, Code, Copy, Download, Ellipsis, Eye, FolderOpen, Paperclip } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { attachments } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { shortPath } from "@/lib/paths";
import type { ViewMode } from "@/lib/editors";

/** "on your message · 14:31": the sending message's time, local and 24-hour. Absent without a readable time. */
export function attachmentSentLabel(sentAt?: string): string | null {
  if (!sentAt) return null;
  const at = new Date(sentAt);
  if (Number.isNaN(at.getTime())) return null;
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `on your message · ${hh}:${mm}`;
}

type Done = "copied" | "saved" | null;

/**
 * The toolbar of a file attached to a sent message (PRO-290, screen 03.22):
 * a paperclip, the stored path with the home folder as "~" (the folder part
 * truncates first, so the file's name stays readable), when the message was
 * sent, Preview/Source for markdown, Copy, Download and an overflow menu.
 * There is no Save: an attachment is the copy that was sent, read-only.
 *
 * Copy puts a text file's contents on the clipboard (`copyContents`); a media
 * file, which has no text, copies its path. Download asks where to save and
 * writes a copy there. Each says it worked on its button for a moment, or
 * says why it did not under the toolbar.
 */
export function AttachmentToolbar({ path, name, sentAt, markdown = false, viewMode = "source", onViewModeChange, copyContents }: {
  path: string;
  name: string;
  sentAt?: string;
  markdown?: boolean;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /** The text to copy; absent for a media file (its path is copied). Throws to refuse, with the reason. */
  copyContents?: () => string;
}) {
  const [done, setDone] = useState<Done>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = (what: Done) => {
    setDone(what);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(null), 1500);
  };

  const shown = shortPath(path);
  const slash = shown.lastIndexOf("/") + 1;
  const sent = attachmentSentLabel(sentAt);

  const copy = async () => {
    setError(null);
    try {
      await copyText(copyContents ? copyContents() : path);
      flash("copied");
    } catch (e) {
      setError(`Could not copy ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const download = async () => {
    setError(null);
    try {
      const to = await save({ defaultPath: name });
      if (!to) return;
      await attachments.saveCopy(path, to);
      flash("saved");
    } catch (e) {
      setError(`Could not download ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="shrink-0" data-testid="attachment-toolbar">
      <div className="@container/editor-toolbar h-8 border-b border-hairline" data-testid="editor-toolbar">
        <div className="flex h-full items-center gap-2 overflow-x-auto px-3 text-xs">
          <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 font-mono text-[11px] text-faint" title={path} data-testid="attachment-path">
            <span className="truncate">{shown.slice(0, slash)}</span>
            <span className="min-w-0 max-w-full shrink-0 truncate">{shown.slice(slash)}</span>
          </span>
          {sent && (
            <span className="hidden shrink-0 rounded-[5px] bg-veil-raised px-1.5 py-px text-[11px] whitespace-nowrap text-muted-foreground @min-[480px]/editor-toolbar:inline" data-testid="attachment-sent">
              {sent}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {markdown && onViewModeChange && (
              <Segmented<ViewMode>
                aria-label="View"
                value={viewMode}
                onChange={onViewModeChange}
                options={[
                  { value: "preview", "aria-label": "Preview", title: "Preview", label: <><Eye aria-hidden className="size-3.5 @min-[520px]/editor-toolbar:hidden" /><span className="hidden @min-[520px]/editor-toolbar:inline">Preview</span></> },
                  { value: "source", "aria-label": "Source", title: "Source", label: <><Code aria-hidden className="size-3.5 @min-[520px]/editor-toolbar:hidden" /><span className="hidden @min-[520px]/editor-toolbar:inline">Source</span></> },
                ]}
              />
            )}
            <Button variant="ghost" size="xs" aria-label="Copy" title={copyContents ? `Copy the contents of ${name}` : `Copy the path of ${name}`} onClick={() => void copy()}>
              {done === "copied" ? <Check className="size-3.5 text-foreground" /> : <Copy className="size-3.5" />}
              <span className="hidden @min-[360px]/editor-toolbar:inline">{done === "copied" ? "Copied" : "Copy"}</span>
            </Button>
            <Button variant="ghost" size="xs" aria-label="Download" title={`Save a copy of ${name}`} onClick={() => void download()}>
              {done === "saved" ? <Check className="size-3.5 text-foreground" /> : <Download className="size-3.5" />}
              <span className="hidden @min-[360px]/editor-toolbar:inline">{done === "saved" ? "Saved" : "Download"}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="More" title="More"><Ellipsis /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void revealItemInDir(path).catch((e) => setError(`Could not reveal ${name}: ${String(e)}`))}>
                  <FolderOpen /> Reveal in Finder
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copyText(path).then(() => flash("copied"), (e) => setError(`Could not copy the path: ${String(e)}`))}>
                  <Copy /> Copy path
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </div>
      {error && <p role="alert" className="border-b border-hairline px-3 py-1.5 text-xs text-destructive" data-testid="attachment-error">{error}</p>}
      <span className="sr-only" role="status">{done === "copied" ? "Copied" : done === "saved" ? `Saved a copy of ${name}` : ""}</span>
    </div>
  );
}
