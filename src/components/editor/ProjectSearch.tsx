import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, Search } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { SearchCheck, SearchToggle } from "@/components/editor/SearchControls";
import { fs, type ReplaceTarget, type TextHit, type TextSearch } from "@/lib/api";
import { liveEditorPathsUnder, liveEditorsFor } from "@/lib/editorViews";
import { openFile } from "@/lib/editors";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { hitKey, planReplace, replaceInOpenBuffers, splitTargets, type ReplacePlan, type ReplaceSpec } from "@/lib/replace";
import { cn } from "@/lib/cn";

const LIMIT = 500;

/**
 * ⌘⇧F: grep the checkout, grouped by file; a hit opens the editor at its
 * line. ⌘⇧H adds a replacement: every row previews what its matches become,
 * any line or file can be left out, and a replace goes through open buffers
 * where there are any and to disk everywhere else.
 */
export function ProjectSearch({ sessionId, root }: { sessionId: string; root: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<TextSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [replacing, setReplacing] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  // Bumped after a replace so the same query runs again over the new text.
  const [generation, setGeneration] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const focusNext = useRef<"find" | "replace">("find");

  useHotkey("mod+shift+f", () => {
    focusNext.current = "find";
    setOpen(true);
  });
  useHotkey("mod+shift+h", () => {
    focusNext.current = "replace";
    setReplaceOpen(true);
    setOpen(true);
    // Already open: move to the replace field without waiting for a re-open.
    requestAnimationFrame(() => replaceInput.current?.select());
  });

  const preview = replaceOpen ? replacement : undefined;
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
        const r = await fs.searchText(root, q, regex, caseSensitive, LIMIT, preview);
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
  }, [open, q, regex, caseSensitive, root, preview, generation]);

  // A new question starts with everything selected again.
  useEffect(() => {
    setExcluded(new Set());
    setReport(null);
  }, [q, regex, caseSensitive, root, open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => (focusNext.current === "replace" && replaceInput.current ? replaceInput.current : input.current)?.select());
  }, [open, replaceOpen]);

  const groups = useMemo(() => {
    const m = new Map<string, TextHit[]>();
    for (const h of result?.hits ?? []) {
      const a = m.get(h.path) ?? [];
      a.push(h);
      m.set(h.path, a);
    }
    return [...m.entries()];
  }, [result]);

  const occurrences = useMemo(() => (result?.hits ?? []).reduce((n, h) => n + h.matches.length, 0), [result]);
  const plan = useMemo(() => planReplace(result?.hits ?? [], excluded), [result, excluded]);
  const nothingExcluded = excluded.size === 0;
  const plus = result?.capped && nothingExcluded ? "+" : "";

  const choose = (h: TextHit) => {
    openFile(sessionId, root, h.path, { line: h.line, col: h.col });
    setOpen(false);
  };

  const toggleHit = (h: TextHit, on: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (on) next.delete(hitKey(h));
      else next.add(hitKey(h));
      return next;
    });
  };
  const toggleFile = (hits: TextHit[], on: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const h of hits) if (on) next.delete(hitKey(h));
      else next.add(hitKey(h));
      return next;
    });
  };
  const fileChecked = (hits: TextHit[]): boolean | "mixed" => {
    const out = hits.filter((h) => excluded.has(hitKey(h))).length;
    return out === 0 ? true : out === hits.length ? false : "mixed";
  };

  /**
   * Apply a plan. `everything` means the reader asked for every match in the
   * checkout while the listing was capped, so the backend walks the tree
   * itself and only the open buffers are handled here.
   */
  const runReplace = useCallback(
    async (target: ReplacePlan, opts: { everything: boolean; confirm: boolean }) => {
      const spec: ReplaceSpec = { query: q, replacement, regex, caseSensitive };
      const abs = (rel: string) => `${root}/${rel}`;
      const openRel = liveEditorPathsUnder(root).map((p) => p.slice(root.length + 1));
      const { live, disk } = opts.everything
        ? { live: openRel.map((path): ReplaceTarget => ({ path })), disk: [] }
        : splitTargets(target.targets, (p) => liveEditorsFor(abs(p)).length > 0);
      const unsaved = live.filter((t) => liveEditorsFor(abs(t.path)).some((e) => e.isDirty())).length;
      if (opts.confirm) {
        const suffix = opts.everything ? "+" : "";
        const lines = [
          `Replace ${target.occurrences}${suffix} ${target.occurrences === 1 && !suffix ? "match" : "matches"} in ${target.files}${suffix} ${target.files === 1 && !suffix ? "file" : "files"} with “${replacement}”?`,
        ];
        if (opts.everything) lines.push(`Only the first ${LIMIT} matches are listed; every match in the checkout will be replaced.`);
        if (unsaved) lines.push(`${unsaved} open ${unsaved === 1 ? "file has" : "files have"} unsaved changes. The replacement goes into ${unsaved === 1 ? "its buffer" : "their buffers"} and stays unsaved.`);
        const ok = await ask(lines.join("\n\n"), { title: "Replace in project", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" }).catch(() => false);
        if (!ok) return;
      }
      setReplacing(true);
      setError(null);
      try {
        let files = 0;
        let count = 0;
        let leftUnsaved = 0;
        for (const t of live) {
          const r = await replaceInOpenBuffers(abs(t.path), spec, t.lines ? new Set(t.lines) : undefined);
          if (!r.count) continue;
          files++;
          count += r.count;
          if (r.unsaved) leftUnsaved++;
        }
        if (opts.everything || disk.length) {
          const r = await fs.replaceText(root, q, replacement, regex, caseSensitive, opts.everything ? null : disk, opts.everything ? openRel : []);
          files += r.files;
          count += r.replacements;
        }
        const note = leftUnsaved ? ` ${leftUnsaved} open ${leftUnsaved === 1 ? "file is" : "files are"} unsaved.` : "";
        setReport(`Replaced ${count} ${count === 1 ? "match" : "matches"} in ${files} ${files === 1 ? "file" : "files"}.${note}`);
        setExcluded(new Set());
        setGeneration((g) => g + 1);
      } catch (e) {
        setError(String(e));
      } finally {
        setReplacing(false);
      }
    },
    [q, replacement, regex, caseSensitive, root],
  );

  const replaceSelected = () => {
    if (!plan.occurrences || replacing) return;
    void runReplace(plan, { everything: !!result?.capped && nothingExcluded, confirm: true });
  };
  const replaceFile = (hits: TextHit[]) => void runReplace(planReplace(hits, new Set()), { everything: false, confirm: true });
  const replaceHit = (h: TextHit) => void runReplace(planReplace([h], new Set()), { everything: false, confirm: false });

  const canReplace = replaceOpen && !!result && !busy;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showClose={false} width="max-w-[46rem]" className="p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Search in project</DialogTitle>
        <div className="border-b border-hairline">
          <div className="flex items-center gap-2 px-3">
            <WithTooltip label={replaceOpen ? "Hide replace" : "Replace"} keys={keycaps("mod+shift+h")}>
              <button
                type="button"
                aria-label={replaceOpen ? "Hide replace" : "Show replace"}
                aria-expanded={replaceOpen}
                onClick={() => {
                  focusNext.current = replaceOpen ? "find" : "replace";
                  setReplaceOpen((v) => !v);
                }}
                className="-ml-1 rounded-md p-0.5 text-faint outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {replaceOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
            </WithTooltip>
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
              autoComplete="off"
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-faint"
            />
            <SearchToggle label="Match case" pressed={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
              <CaseSensitive className="size-4" />
            </SearchToggle>
            <SearchToggle label="Regular expression" pressed={regex} onClick={() => setRegex((v) => !v)}>
              <Regex className="size-4" />
            </SearchToggle>
          </div>
          {replaceOpen && (
            <div className="flex items-center gap-2 px-3 pb-2">
              <span className="size-4 shrink-0" aria-hidden />
              <Replace className="size-4 text-faint" />
              <input
                ref={replaceInput}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") replaceSelected();
                }}
                placeholder={regex ? "Replace ($1 for a group)" : "Replace"}
                aria-label="Replace with"
                spellCheck={false}
                autoComplete="off"
                className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-faint"
              />
              <Button variant="accent" size="xs" disabled={!canReplace || !plan.occurrences || replacing} onClick={replaceSelected}>
                <ReplaceAll />
                {replacing ? "Replacing…" : `Replace ${plan.occurrences}${plus}`}
              </Button>
            </div>
          )}
        </div>
        <div className="max-h-[26rem] overflow-auto p-1 scrollbar-thin">
          {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
          {report && <div className="px-3 py-2 text-xs text-add">{report}</div>}
          {result && (
            <div className="px-2 py-1 text-[11px] text-faint">
              {occurrences}
              {result.capped ? "+" : ""} {occurrences === 1 && !result.capped ? "match" : "matches"} in {result.files} file{result.files === 1 ? "" : "s"}
              {replaceOpen && !nothingExcluded ? ` · ${plan.occurrences} selected` : ""}
              {busy ? " · searching…" : ""}
            </div>
          )}
          {groups.map(([path, hits]) => (
            <div key={path} className="mb-1">
              <div className="group/file sticky top-0 z-10 flex items-center gap-2 bg-popover px-2 py-1 text-xs font-medium text-foreground">
                {replaceOpen && <SearchCheck label={`Include ${path}`} checked={fileChecked(hits)} onChange={(on) => toggleFile(hits, on)} />}
                <span className="min-w-0 flex-1 truncate">{path}</span>
                {replaceOpen && (
                  <WithTooltip label="Replace all in file">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Replace all in ${path}`}
                      disabled={!canReplace || replacing}
                      onClick={() => replaceFile(hits)}
                      className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
                    >
                      <ReplaceAll />
                    </Button>
                  </WithTooltip>
                )}
              </div>
              {hits.map((h) => {
                const on = !excluded.has(hitKey(h));
                return (
                  <div
                    key={`${h.line}:${h.col}`}
                    className={cn(
                      "group/hit flex w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[12px] text-muted-foreground hover:bg-veil-strong hover:text-foreground",
                      replaceOpen && !on && "opacity-50",
                    )}
                  >
                    {replaceOpen && <SearchCheck label={`Include line ${h.line}`} checked={on} onChange={(v) => toggleHit(h, v)} />}
                    <button type="button" onClick={() => choose(h)} className="flex min-w-0 flex-1 items-baseline gap-2 py-0.5 text-left outline-none">
                      <span className="w-10 shrink-0 text-right text-faint">{h.line}</span>
                      <span className="truncate">
                        <HitLine hit={h} preview={replaceOpen && on} />
                      </span>
                    </button>
                    {replaceOpen && (
                      <WithTooltip label="Replace this line">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Replace on line ${h.line}`}
                          disabled={!canReplace || replacing}
                          onClick={() => replaceHit(h)}
                          className="opacity-0 group-hover/hit:opacity-100 focus-visible:opacity-100"
                        >
                          <Replace />
                        </Button>
                      </WithTooltip>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {q.trim() && result && !result.hits.length && !busy && <div className="px-3 py-6 text-center text-xs text-faint">No matches.</div>}
          {!q.trim() && (
            <div className="px-3 py-6 text-center text-xs text-faint">
              {replaceOpen ? "Type to search, then a replacement to preview it in every file." : "Type to search every file in the checkout."}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A hit's line with each match lit, or struck through beside its replacement. */
function HitLine({ hit, preview }: { hit: TextHit; preview: boolean }) {
  const parts: ReactNode[] = [];
  let last = 0;
  hit.matches.forEach(([start, end], i) => {
    if (start > hit.text.length || start < last) return;
    parts.push(hit.text.slice(last, start));
    const m = hit.text.slice(start, end);
    if (preview && hit.replacements) {
      parts.push(
        <del key={`d${i}`} className="rounded-sm bg-destructive/15 text-destructive/80">
          {m}
        </del>,
        <ins key={`i${i}`} className="rounded-sm bg-add/20 text-foreground no-underline">
          {hit.replacements[i]}
        </ins>,
      );
    } else {
      parts.push(
        <mark key={`m${i}`} className="rounded-sm bg-warning/30 text-foreground">
          {m}
        </mark>,
      );
    }
    last = Math.min(end, hit.text.length);
  });
  parts.push(hit.text.slice(last));
  return <>{parts}</>;
}
