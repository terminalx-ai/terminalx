import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, Regex, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fs, type TextHit, type TextSearch } from "@/lib/api";
import { openFile } from "@/lib/editors";
import { useHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";

/** ⌘⇧F: grep the checkout, grouped by file; a hit opens the editor at its line. */
export function ProjectSearch({ sessionId, root }: { sessionId: string; root: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<TextSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useHotkey("mod+shift+f", () => setOpen(true));

  useEffect(() => {
    if (!open) return;
    if (!q.trim()) {
      setResult(null);
      setError(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fs.searchText(root, q, regex, caseSensitive, 500);
        if (live) {
          setResult(r);
          setError(null);
        }
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        if (live) setBusy(false);
      }
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [open, q, regex, caseSensitive, root]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.select());
  }, [open]);

  const groups = useMemo(() => {
    const m = new Map<string, TextHit[]>();
    for (const h of result?.hits ?? []) {
      const a = m.get(h.path) ?? [];
      a.push(h);
      m.set(h.path, a);
    }
    return [...m.entries()];
  }, [result]);

  const choose = (h: TextHit) => {
    openFile(sessionId, root, h.path, { line: h.line, col: h.col });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showClose={false} width="max-w-[46rem]" className="p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Search in project</DialogTitle>
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search className="size-4 text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && groups[0]?.[1][0]) choose(groups[0][1][0]);
            }}
            placeholder="Search in project"
            spellCheck={false}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-faint"
          />
          <button
            type="button"
            aria-label="Match case"
            aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
            className={cn("rounded-md p-1", caseSensitive ? "bg-veil-strong text-foreground" : "text-faint hover:text-foreground")}
          >
            <CaseSensitive className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Regular expression"
            aria-pressed={regex}
            onClick={() => setRegex((v) => !v)}
            className={cn("rounded-md p-1", regex ? "bg-veil-strong text-foreground" : "text-faint hover:text-foreground")}
          >
            <Regex className="size-4" />
          </button>
        </div>
        <div className="max-h-[26rem] overflow-auto p-1 scrollbar-thin">
          {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
          {result && (
            <div className="px-2 py-1 text-[11px] text-faint">
              {result.hits.length}
              {result.capped ? "+" : ""} matches in {result.files} file{result.files === 1 ? "" : "s"}
              {busy ? " · searching…" : ""}
            </div>
          )}
          {groups.map(([path, hits]) => (
            <div key={path} className="mb-1">
              <div className="sticky top-0 truncate bg-popover px-2 py-1 text-xs font-medium text-foreground">{path}</div>
              {hits.map((h) => (
                <button
                  key={`${h.line}:${h.col}`}
                  type="button"
                  onClick={() => choose(h)}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-0.5 text-left font-mono text-[12px] text-muted-foreground hover:bg-veil-strong hover:text-foreground"
                >
                  <span className="w-10 shrink-0 text-right text-faint">{h.line}</span>
                  <span className="truncate">
                    {h.text.slice(0, h.col)}
                    <mark className="rounded-sm bg-warning/30 text-foreground">{h.text.slice(h.col, h.col + Math.max(1, matchLen(h.text.slice(h.col), q, regex, caseSensitive)))}</mark>
                    {h.text.slice(h.col + Math.max(1, matchLen(h.text.slice(h.col), q, regex, caseSensitive)))}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {q.trim() && result && !result.hits.length && !busy && <div className="px-3 py-6 text-center text-xs text-faint">No matches.</div>}
          {!q.trim() && <div className="px-3 py-6 text-center text-xs text-faint">Type to search every file in the checkout.</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function matchLen(s: string, q: string, regex: boolean, caseSensitive: boolean): number {
  try {
    const re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
    const m = re.exec(s);
    return m && m.index === 0 ? m[0].length : q.length;
  } catch {
    return q.length;
  }
}
