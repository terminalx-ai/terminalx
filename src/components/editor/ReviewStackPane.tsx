import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FileCode2, RefreshCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { ReviewCommentsProvider } from "@/components/changes/ReviewComments";
import { DiffPane } from "@/components/changes/DiffPane";
import { DiffViewToggles } from "@/components/changes/DiffOptions";
import { diffMediaKind, formatSize, TOO_LARGE, TooLargeState } from "@/components/changes/FileDiff";
import { useSessionThreads } from "@/components/changes/ReviewThreads";
import { cn } from "@/lib/cn";
import { diffFileKey, useDiffOptions } from "@/lib/diffOptions";
import { openFile as openWorkspaceFile, openDiff, updateDiffRange, type DiffEditorEntry } from "@/lib/editors";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { useSessionStore } from "@/lib/sessions";
import { useViewedChanges } from "@/lib/viewedChanges";
import { selectSessionTab } from "@/lib/terminal";
import type { ChangeRange } from "@/lib/changes";
import type { ChangedFile } from "@/types/session";

/**
 * The scope's one review tab (PRO-392, design 05.01): every changed file one
 * after another, each under a header with its path, its counts and Viewed,
 * below a single toolbar row.
 */
export function ReviewStackPane({ entry, visible }: { entry: DiffEditorEntry; visible: boolean }) {
  const source = useMemo(() => localGitSource(entry.root), [entry.root]);
  const session = useSessionStore().sessions.find((s) => s.id === entry.sessionId);
  const tabId = session?.activeTab ?? session?.tabs[0]?.id;
  return <ReviewCommentsProvider chrome={false} onAdd={() => { if (tabId) selectSessionTab(entry.sessionId, { kind: "agent", id: tabId }); }} key={source.key} source={source} active={visible} tabId={tabId}>
    <ReviewStack entry={entry} source={source} visible={visible} />
  </ReviewCommentsProvider>;
}

function ReviewStack({ entry, source, visible }: { entry: DiffEditorEntry; source: GitSource; visible: boolean }) {
  const { range, scope, target, uncommitted, focus, turnLabel } = entry.diff;
  // The PR's review threads, found and kept current while this tab is shown (PRO-234).
  useSessionThreads(source, entry.sessionId.startsWith("checkout:") ? undefined : entry.sessionId, visible);
  const { mode, hideWhitespace } = useDiffOptions();
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // The same Viewed marks as the Changes list: one checked here is checked there.
  const viewed = useViewedChanges(source.key);
  const live = scope === "all";
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    source.changesBetween(range.base, range.head, hideWhitespace).then(
      (next) => { if (!cancelled) { setFiles(next); setError(null); } },
      (e: unknown) => { if (!cancelled) setError(source.errorMessage(e)); },
    );
    return () => { cancelled = true; };
  }, [source, range?.base, range?.head, hideWhitespace, tick]);
  // A live comparison follows the workspace; a turn or commit snapshot stays as it was.
  const refresh = useCallback(async () => {
    if (!live) { setTick((t) => t + 1); return; }
    setRefreshing(true);
    try {
      const next = await source.reviewRange(target ?? null, uncommitted ?? false);
      if (next.base !== range?.base || next.head !== range?.head) updateDiffRange(entry.id, { base: next.base, head: next.head });
      else setTick((t) => t + 1);
    } catch (e) { setError(source.errorMessage(e)); }
    finally { setRefreshing(false); }
  }, [live, source, target, uncommitted, range?.base, range?.head, entry.id]);
  useEffect(() => {
    if (!visible || !live) return;
    const onChange = () => void refresh();
    window.addEventListener("focus", onChange);
    window.addEventListener("workspace-files-changed", onChange);
    return () => { window.removeEventListener("focus", onChange); window.removeEventListener("workspace-files-changed", onChange); };
  }, [visible, live, refresh]);
  // WebKit has no scroll anchoring: files load lazily and grow, which would push what is being read down the page.
  // The file at the top of the view is remembered on every scroll, and kept where it was when the stack resizes.
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ section: HTMLElement; offset: number } | null>(null);
  const written = useRef<number | null>(null);
  // Opening a file holds the stack at the tallest it has been until the reader scrolls (or a few seconds pass):
  // an editor being rebuilt shrinks it for a moment, and the browser would clamp the scroll off the opened file.
  const settling = useRef<number | null>(null);
  const loaded = files !== null;
  const write = useCallback((el: HTMLElement, top: number) => { el.scrollTop = top; written.current = el.scrollTop; }, []);
  const settle = useCallback((on: boolean) => {
    const inner = content.current;
    if (settling.current !== null) window.clearTimeout(settling.current);
    settling.current = on ? window.setTimeout(() => settle(false), 5000) : null;
    if (inner) inner.style.minHeight = on ? `${inner.offsetHeight}px` : "";
  }, []);
  useEffect(() => {
    const el = scroller.current, inner = content.current;
    if (!loaded || !el || !inner) return;
    const remember = () => {
      // The scroll this tab made itself keeps the anchor it was made for.
      if (written.current !== null && Math.abs(el.scrollTop - written.current) <= 1) return;
      written.current = null;
      const top = el.getBoundingClientRect().top;
      const section = [...el.querySelectorAll<HTMLElement>("[data-review-file]")].find((s) => s.getBoundingClientRect().bottom > top + 1);
      anchor.current = section ? { section, offset: section.getBoundingClientRect().top - top } : null;
    };
    const keep = () => {
      // Raised a frame later: resizing what this observes from its own callback is a ResizeObserver loop.
      if (settling.current !== null) requestAnimationFrame(() => { if (settling.current !== null) inner.style.minHeight = `${inner.offsetHeight}px`; });
      const held = anchor.current;
      if (!held?.section.isConnected) return;
      const moved = held.section.getBoundingClientRect().top - el.getBoundingClientRect().top - held.offset;
      if (Math.abs(moved) > 1) write(el, el.scrollTop + moved);
    };
    const reader = () => { if (settling.current !== null) settle(false); };
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keep);
    resized?.observe(inner);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const name of events) el.addEventListener(name, reader, { passive: true });
    el.addEventListener("scroll", remember, { passive: true });
    return () => {
      resized?.disconnect();
      for (const name of events) el.removeEventListener(name, reader);
      el.removeEventListener("scroll", remember);
      settle(false);
    };
  }, [loaded, write, settle]);
  // Opening a file from Changes scrolls this tab to it.
  useEffect(() => {
    const el = scroller.current;
    if (!loaded || !el) return;
    const section = [...el.querySelectorAll<HTMLElement>("[data-review-file]")].find((s) => s.dataset.reviewFile === entry.rel);
    if (!section) return;
    anchor.current = { section, offset: 0 };
    settle(true);
    // Straight to the offset, not scrollIntoView: that also scrolls the window and the panes around it.
    write(el, section.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop);
  }, [loaded, focus, entry.rel, write, settle]);
  const openFile = (file: ChangedFile) => {
    if (!range) return;
    openDiff(entry.sessionId, entry.root, file.path, live ? { scope: "all", range, oldPath: file.oldPath, target, uncommitted } : { scope: "turn", range, oldPath: file.oldPath, turnLabel });
  };

  return <div className="flex h-full min-h-0 flex-col" data-testid="review-stack">
    <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-hairline px-3">
      <DiffViewToggles />
      {live && <Button className="ml-auto" variant="ghost" size="icon-xs" aria-label="Refresh review" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={cn(refreshing && "animate-spin")} /></Button>}
    </div>
    {error && <div role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">{error} <Button size="xs" variant="outline" onClick={() => void refresh()}>Retry</Button></div>}
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      {!range ? <p className="p-4 text-sm text-muted-foreground">No snapshots are available for this turn. Choose All changes in the Changes panel to review the workspace.</p>
        : files === null ? !error && <p role="status" className="p-4 text-sm text-muted-foreground">Loading changes…</p>
        : !files.length ? <p className="p-4 text-sm text-muted-foreground">No changes in this scope.</p>
        : <div ref={content}>{files.map((file) => <StackedFile key={JSON.stringify([file.path, file.oldPath, range.base, range.head])} source={source} file={file} range={range} mode={mode} hideWhitespace={hideWhitespace}
          viewed={viewed.status(file).viewed} onViewed={file.blobHash ? (on) => viewed.set(file, on) : undefined} onOpenFile={file.status !== "deleted" ? () => openWorkspaceFile(entry.sessionId, entry.root, file.path, undefined, entry.workspaceRoot) : undefined} onOpen={() => openFile(file)} />)}</div>}
    </div>
  </div>;
}

type Pair = { before: string; after: string; size?: number | null };

function StackedFile({ source, file, range, mode, hideWhitespace, viewed, onViewed, onOpen, onOpenFile }: {
  source: GitSource; file: ChangedFile; range: ChangeRange; mode: "unified" | "split"; hideWhitespace: boolean;
  onOpenFile?: () => void;
  viewed: boolean; onViewed?: (on: boolean) => void; onOpen(): void;
}) {
  const { wrap } = useDiffOptions(diffFileKey(source.key, file.path));
  const media = diffMediaKind(file.path);
  const section = useRef<HTMLElement>(null);
  // Files far below the fold are read once they come near, so a large review opens at once.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !section.current) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); observer.disconnect(); } }, { rootMargin: "800px 0px" });
    observer.observe(section.current);
    return () => observer.disconnect();
  }, [near]);
  const [pair, setPair] = useState<Pair | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!near || (media && media !== "svg")) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      const next = await source.fileContentsAt(file.path, range.base, range.head);
      const previous = file.oldPath ? await source.fileContentsAt(file.oldPath, range.base, range.head) : next;
      if (!cancelled) setPair({ before: previous.before ?? "", after: next.after ?? "", size: next.after === TOO_LARGE ? next.afterSize : previous.beforeSize });
    })().catch((e: unknown) => { if (!cancelled) setError(source.errorMessage(e)); });
    return () => { cancelled = true; };
  }, [near, source, file.path, file.oldPath, range.base, range.head, media, retry]);
  const tooLarge = pair?.before === TOO_LARGE || pair?.after === TOO_LARGE;
  const binary = !!pair && (pair.before.includes("\0") || pair.after.includes("\0"));

  return <section ref={section} data-review-file={file.path} aria-label={file.path} className="border-b border-hairline">
    <header className="sticky top-0 z-10 flex h-10 min-w-0 items-center gap-2 border-b border-hairline bg-raised px-4">
      <FileCode2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-mono text-[12.5px]" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
      <span className="shrink-0 font-mono text-xs tabular-nums">
        {file.additions > 0 && <span className="text-add">+{file.additions}</span>}{" "}
        {file.deletions > 0 && <span className="text-destructive">−{file.deletions}</span>}
      </span>
      {tooLarge && pair?.size != null && <span className="shrink-0 font-mono text-xs text-faint">{formatSize(pair.size)}</span>}
      <Button className="ml-auto" variant="ghost" size="icon-xs" aria-label={`Open ${file.path} in its own tab`} title="Open in its own tab" onClick={onOpen}><ExternalLink /></Button>
      <Checkbox label={`Viewed ${file.path}`} checked={viewed} disabled={!onViewed}
        title={!onViewed ? "Viewed marks require file identities from the workspace." : undefined} onChange={(on) => onViewed?.(on)}>Viewed</Checkbox>
    </header>
    {/* Its own stacking context: the editor's gutters must not draw over the next file's sticky header. */}
    <div className={cn("isolate", viewed && "opacity-60")}>
      {media && media !== "svg" ? <p className="px-4 py-3 text-xs text-muted-foreground">{media === "pdf" ? "PDF" : "Image"} changed. <Button size="xs" variant="outline" onClick={onOpen}>Open to compare</Button></p>
        : error ? <div role="alert" className="px-4 py-3 text-xs text-destructive">{error} <Button size="xs" variant="outline" onClick={() => setRetry((n) => n + 1)}>Retry</Button></div>
        : !pair ? <p role="status" className="min-h-16 px-4 py-3 text-xs text-muted-foreground">Loading file diff…</p>
        : tooLarge ? <TooLargeState path={file.path} size={pair.size} onOpenFile={onOpenFile} />
        : binary ? <p className="px-4 py-3 text-xs text-muted-foreground">Binary file changed.</p>
        : <DiffPane stacked workspace={source.key} path={file.path} before={pair.before} after={pair.after} base={range.base} originalPath={file.oldPath} mode={mode} wrap={wrap} hideWhitespace={hideWhitespace} />}
    </div>
  </section>;
}
