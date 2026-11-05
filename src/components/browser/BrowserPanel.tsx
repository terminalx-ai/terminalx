import { useEffect, useState, type FormEvent } from "react";
import { Globe, Plus, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { bootBrowser, closeBrowserPage, openBrowserPage, pagesFor, useBrowser } from "@/lib/browser";
import { cn } from "@/lib/cn";
import { BrowserView } from "./BrowserView";

/**
 * The side panel's browser: the workspace's pages beside the chat. It is the
 * same Chromium the agent drives, so a page the agent opened is here to
 * watch and use, and a page opened here is one the agent can read and act
 * in. Pages show as small tabs over the page; with none, an address to open.
 */
export function BrowserPanel({ sessionId, cwd, active }: { sessionId: string; cwd: string; active: boolean }) {
  const state = useBrowser();
  const pages = pagesFor(state.pages, cwd);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void bootBrowser();
  }, []);

  // The page picked here, else the one the browser has in front, else the newest.
  const page = pages.find((p) => p.id === picked || p.browserPageId === picked) ?? pages.find((p) => p.active) ?? pages.at(-1);
  const showStart = adding || !page;

  const opened = (id: string) => {
    setPicked(id);
    setAdding(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="panel-browser">
      {pages.length > 0 && (
        <div role="tablist" aria-label="Pages" className="flex shrink-0 items-center gap-0.5 overflow-x-auto scrollbar-none border-b border-hairline px-2 py-1">
          {pages.map((p) => {
            const selected = !showStart && p.id === page?.id;
            return (
              <div
                key={p.id}
                className={cn(
                  "group flex h-6 max-w-[11rem] shrink-0 items-center gap-1 rounded-md pl-2 pr-0.5 text-xs transition-colors",
                  selected ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
                )}
              >
                <button type="button" role="tab" aria-selected={selected} className="min-w-0 truncate" title={p.url} onClick={() => opened(p.id)}>
                  {p.title || hostOf(p.url) || "New page"}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${p.title || p.url}`}
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm text-faint opacity-0 hover:bg-veil-strong hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => void closeBrowserPage(sessionId, p.id).catch((e) => console.error("browser close failed", e))}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <WithTooltip label="New page">
            <Button variant="ghost" size="icon-xs" aria-label="New page" className="shrink-0" onClick={() => setAdding(true)}>
              <Plus />
            </Button>
          </WithTooltip>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {showStart ? (
          <StartPage cwd={cwd} onOpened={opened} onCancel={pages.length ? () => setAdding(false) : undefined} />
        ) : (
          page && <BrowserView key={page.id} session={{ id: sessionId }} page={page} active={active} compact />
        )}
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "about:" ? "" : u.host || url;
  } catch {
    return url;
  }
}

/** No page yet (or a new one): an address, and what this browser is. */
function StartPage({ cwd, onOpened, onCancel }: { cwd: string; onOpened: (id: string) => void; onCancel?: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(await openBrowserPage(cwd, target));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <Globe className="size-6 text-faint" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm text-foreground">Open a page beside the chat</p>
        <p className="text-xs leading-relaxed text-muted-foreground">The agent uses this browser too: you can watch it work, and it can see and act in what you open.</p>
      </div>
      <form onSubmit={submit} className="flex w-full max-w-sm items-center gap-1.5 rounded-lg bg-well px-2 hairline focus-within:ring-1 focus-within:ring-ring/40">
        <input
          autoFocus
          aria-label="Address"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel?.()}
          spellCheck={false}
          placeholder="localhost:5173 or a URL"
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint"
        />
        <Button type="submit" size="xs" disabled={!url.trim() || busy}>
          {busy ? "Opening…" : "Open"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="max-w-sm text-xs text-destructive">
          {error}
        </p>
      )}
      {onCancel && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onCancel}>
          Back to the open page
        </button>
      )}
    </div>
  );
}
