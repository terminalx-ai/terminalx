import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Pause, Play, RotateCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { BrowserPage } from "@/lib/api";
import { activateBrowserPage, navigateBrowserPage, sendPageInput, setScreencast, subscribeFrames, useBrowser, watchScreencast } from "@/lib/browser";
import { insertText, keyEvents, keyForPage, mouseEvent, toPagePoint, wheelEvent, wheelPixels, modifiersOf, type PageInputEvent } from "@/lib/browserInput";
import { isMac } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/api";
import type { SessionEntry } from "@/types/session";

/**
 * One browser page: a toolbar, and the page itself, streamed live from
 * Chromium over DevTools and driven from here. Clicks, drags, the wheel,
 * keys and pasted text reach the page, so the reader works in the same page
 * the agent does without leaving the app. "Open window" still raises the
 * Chromium window for what a preview cannot do (file pickers, extensions).
 *
 * `compact` is the side panel's: the toolbar keeps to icons and the footer
 * keeps to the title.
 */
export function BrowserView({ session, page, active, compact }: { session: Pick<SessionEntry, "id">; page: BrowserPage; active: boolean; compact?: boolean }) {
  const browser = useBrowser();
  const cast = browser.screencast[page.id];
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState(page.url);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [focused, setFocused] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  /** The page's size in CSS pixels, from the last frame: what preview points scale to. */
  const pageSize = useRef({ width: 0, height: 0 });
  const live = active && !paused;

  // The address bar follows the page unless the reader is typing in it.
  useEffect(() => {
    if (!editing) setDraft(page.url);
  }, [page.url, editing]);

  useEffect(() => (live ? watchScreencast(page.id) : undefined), [live, page.id]);

  useEffect(() => {
    return subscribeFrames(page.id, (frame) => {
      const img = imgRef.current;
      if (!img) return;
      img.src = `data:image/jpeg;base64,${frame.data}`;
      if (frame.width && frame.height) pageSize.current = { width: frame.width, height: frame.height };
      setHasFrame(true);
    });
  }, [page.id]);

  // Input goes out once a frame: moves and wheel turns between two frames merge into one.
  const queue = useRef<PageInputEvent[]>([]);
  const pendingMove = useRef<PageInputEvent | null>(null);
  const pendingWheel = useRef<{ x: number; y: number; dx: number; dy: number; modifiers: number } | null>(null);
  const frame = useRef(0);
  const flush = () => {
    frame.current = 0;
    const events = queue.current;
    queue.current = [];
    if (pendingMove.current) events.push(pendingMove.current);
    pendingMove.current = null;
    const wheel = pendingWheel.current;
    pendingWheel.current = null;
    if (wheel) events.push(wheelEvent({ x: wheel.x, y: wheel.y }, wheel.dx, wheel.dy, wheel.modifiers));
    if (events.length) void sendPageInput(page.id, events).catch((e) => setError(errorMessage(e)));
  };
  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  };
  const send = (event: PageInputEvent) => {
    // What came before it (a move, a wheel turn) goes first: order is the page's sense of the gesture.
    if (pendingMove.current) queue.current.push(pendingMove.current);
    pendingMove.current = null;
    queue.current.push(event);
    schedule();
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const pointAt = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    const size = pageSize.current;
    if (!img || !size.width) return null;
    return toPagePoint(clientX, clientY, img.getBoundingClientRect(), size);
  };
  const interactive = live && hasFrame && cast?.state === "live";

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    surfaceRef.current?.focus({ preventScroll: true });
    const point = pointAt(e.clientX, e.clientY);
    if (!interactive || !point) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    send(mouseEvent("mousePressed", point, e));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const point = pointAt(e.clientX, e.clientY);
    if (!interactive || !point) return;
    send(mouseEvent("mouseReleased", point, e));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const point = pointAt(e.clientX, e.clientY);
    if (!interactive || !point) return;
    pendingMove.current = mouseEvent("mouseMoved", point, e);
    schedule();
  };

  // The wheel scrolls the page, not the panel: a listener that may prevent the default.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const point = pointAt(e.clientX, e.clientY);
      if (!interactive || !point) return;
      e.preventDefault();
      const height = pageSize.current.height;
      const wheel = (pendingWheel.current ??= { ...point, dx: 0, dy: 0, modifiers: modifiersOf(e) });
      wheel.x = point.x;
      wheel.y = point.y;
      wheel.dx += wheelPixels(e.deltaX, e.deltaMode, height);
      wheel.dy += wheelPixels(e.deltaY, e.deltaMode, height);
      schedule();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || e.nativeEvent.isComposing || !keyForPage(e, isMac)) return;
    e.preventDefault();
    e.stopPropagation();
    send(keyEvents("down", e, isMac));
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !keyForPage(e, isMac)) return;
    e.preventDefault();
    send(keyEvents("up", e, isMac));
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!interactive || !text) return;
    e.preventDefault();
    send(insertText(text));
  };

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = draft.trim();
    setEditing(false);
    if (!url) return;
    void run("goto", () => navigateBrowserPage(page.id, "goto", url));
    surfaceRef.current?.focus({ preventScroll: true });
  };

  const status = cast?.state === "error" ? cast.message ?? "Preview failed." : paused ? "Preview paused." : cast?.state === "live" ? null : cast?.state === "ended" ? "Preview ended." : "Starting preview…";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`browser-view-${page.id}`}>
      <form onSubmit={submit} className="flex items-center gap-1 border-b border-hairline px-2 py-1">
        <WithTooltip label="Back">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Back" disabled={busy != null} onClick={() => void run("back", () => navigateBrowserPage(page.id, "back"))}>
            <ArrowLeft />
          </Button>
        </WithTooltip>
        <WithTooltip label="Forward">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Forward" disabled={busy != null} onClick={() => void run("forward", () => navigateBrowserPage(page.id, "forward"))}>
            <ArrowRight />
          </Button>
        </WithTooltip>
        <WithTooltip label="Reload">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Reload" disabled={busy != null} onClick={() => void run("reload", () => navigateBrowserPage(page.id, "reload"))}>
            <RotateCw className={cn(busy === "reload" && "animate-spin")} />
          </Button>
        </WithTooltip>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-well px-2">
          <Globe className="size-3.5 shrink-0 text-faint" aria-hidden />
          <input
            aria-label="Address"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => {
              setEditing(true);
              event.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            spellCheck={false}
            className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint"
            placeholder="Enter a URL"
          />
        </div>
        <WithTooltip label={paused ? "Resume preview" : "Pause preview"}>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={paused ? "Resume preview" : "Pause preview"} aria-pressed={paused} onClick={() => setPaused((v) => !v)}>
            {paused ? <Play /> : <Pause />}
          </Button>
        </WithTooltip>
        <WithTooltip label="Open the browser window">
          {compact ? (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Open window" onClick={() => void activateBrowserPage(session.id, page.id, true)}>
              <ExternalLink />
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" aria-label="Open window" onClick={() => void activateBrowserPage(session.id, page.id, true)}>
              <ExternalLink /> Open window
            </Button>
          )}
        </WithTooltip>
      </form>
      <div
        ref={surfaceRef}
        tabIndex={0}
        role="application"
        aria-label={page.title ? `Page: ${page.title}` : "Page"}
        aria-roledescription="browser page"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => interactive && e.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={cn("relative flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-well/60 outline-none", compact ? "p-0" : "p-2")}
        data-testid="browser-surface"
      >
        <img
          ref={imgRef}
          alt={page.title ? `Preview of ${page.title}` : "Page preview"}
          className={cn(
            "max-h-full max-w-full select-none object-contain",
            compact ? "" : "rounded-md shadow-button",
            interactive ? "cursor-default" : "",
            // Where the keys go: a ring on the page while it has them.
            focused && interactive && "ring-1 ring-accent/60",
            !hasFrame && "hidden",
          )}
          draggable={false}
        />
        {status && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Globe className="size-6 text-faint" aria-hidden />
            <span>{status}</span>
            {cast?.state === "error" && (
              <Button size="xs" variant="outline" onClick={() => void setScreencast(page.id, true)}>
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-hairline px-3 py-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={page.title || page.url}>
          {page.title || page.url}
        </span>
        {error && <span role="alert" className="max-w-[40%] truncate text-destructive" title={error}>{error}</span>}
        {!compact && <span className="shrink-0 font-mono text-faint" title="Pass this id with --page to target the page from the CLI">{page.browserPageId}</span>}
        {!compact && <span className="shrink-0 rounded-sm bg-veil-raised px-1 text-[11px] text-faint">{page.profileId}</span>}
      </div>
    </div>
  );
}
