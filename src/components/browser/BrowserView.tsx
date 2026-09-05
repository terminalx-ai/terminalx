import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Pause, Play, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { BrowserPage } from "@/lib/api";
import { activateBrowserPage, navigateBrowserPage, setScreencast, subscribeFrames, useBrowser } from "@/lib/browser";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/api";
import type { SessionEntry } from "@/types/session";

/**
 * One browser page: a toolbar the reader can drive, and a live preview of
 * the Chromium tab streamed over DevTools. The real page lives in the
 * Chromium window; "Open window" raises it for hands-on control.
 */
export function BrowserView({ session, page, active }: { session: SessionEntry; page: BrowserPage; active: boolean }) {
  const browser = useBrowser();
  const cast = browser.screencast[page.id];
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState(page.url);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const live = active && !paused;

  // The address bar follows the page unless the reader is typing in it.
  useEffect(() => {
    if (!editing) setDraft(page.url);
  }, [page.url, editing]);

  useEffect(() => {
    if (!live) {
      void setScreencast(page.id, false);
      return;
    }
    void setScreencast(page.id, true);
    return () => {
      void setScreencast(page.id, false);
    };
  }, [live, page.id]);

  useEffect(() => {
    return subscribeFrames(page.id, (frame) => {
      const img = imgRef.current;
      if (!img) return;
      img.src = `data:image/jpeg;base64,${frame.data}`;
      setHasFrame(true);
    });
  }, [page.id]);

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
            onFocus={() => setEditing(true)}
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
          <Button type="button" variant="outline" size="sm" aria-label="Open window" onClick={() => void activateBrowserPage(session.id, page.id, true)}>
            <ExternalLink /> Open window
          </Button>
        </WithTooltip>
      </form>
      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-well/60 p-2">
        <img
          ref={imgRef}
          alt={page.title ? `Preview of ${page.title}` : "Page preview"}
          className={cn("max-h-full max-w-full rounded-md object-contain shadow-button", !hasFrame && "hidden")}
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
        <span className="shrink-0 font-mono text-faint" title="Pass this id with --page to target the page from the CLI">{page.browserPageId}</span>
        <span className="shrink-0 rounded-sm bg-veil-raised px-1 text-[10px] text-faint">{page.profileId}</span>
      </div>
    </div>
  );
}
