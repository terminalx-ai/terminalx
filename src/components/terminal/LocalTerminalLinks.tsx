import { useEffect, useRef, useState } from "react";
import { errorMessage, pty } from "@/lib/api";
import { openBrowserTab } from "@/lib/browser";

/** Only the visible local pane polls; output stays in the owning runtime. */
export function LocalTerminalLinks({ id, active }: { id: string; active: boolean }) {
  const [links, setLinks] = useState<Awaited<ReturnType<typeof pty.localLinks>>>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setLinks(null);
    setError(null);
    setOpening(false);
    if (!active) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await pty.localLinks(id);
        if (live) setLinks(next);
      } catch {
        // Older or disconnected runtimes have no links to offer.
        if (live) setLinks(null);
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { live = false; generation.current++; clearInterval(timer); };
  }, [id, active]);

  if (!active || !links?.urls.length) return null;
  const open = async (url: string) => {
    if (opening) return;
    setOpening(true);
    setError(null);
    const request = generation.current;
    try { await openBrowserTab(links.sessionId, links.cwd, url); }
    catch (error) { if (generation.current === request) setError(errorMessage(error)); }
    finally { if (generation.current === request) setOpening(false); }
  };
  return <div className="shrink-0 border-b border-hairline px-3 py-1 text-xs">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Local server URLs">
      {links.urls.map((url) => <button key={url} type="button" disabled={opening} onClick={() => void open(url)}
        className="max-w-full truncate rounded px-1 py-1 text-muted-foreground hover:text-foreground focus-visible:outline-ring disabled:opacity-50"
        title={url} aria-label={`Open ${url}`}>Open <span className="font-mono">{url}</span></button>)}
    </div>
    {error && <p role="alert" className="py-1 text-destructive">{error}</p>}
  </div>;
}
