import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CaseSensitive, Regex, Replace, ReplaceAll, Search, TextSearch as NoHitsIcon, ToggleLeft, WholeWord, X } from "@/icons";
import { confirmInApp } from "@/lib/confirm";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Kbd, WithTooltip } from "@/components/ui/tooltip";
import { SearchCheck, SearchToggle } from "@/components/editor/SearchControls";
import type { ReplaceTarget, TextHit, TextSearch } from "@/lib/api";
import { liveEditorPathsUnder, liveEditorsFor } from "@/lib/editorViews";
import { openFile } from "@/lib/editors";
import { useShortcut } from "@/lib/hotkeys";
import { hitKey, planReplace, replaceInOpenBuffers, splitTargets, type ReplacePlan, type ReplaceSpec } from "@/lib/replace";
import { cn } from "@/lib/cn";
import { joinNames, loadSearchToggles, nearQueries, nearText, registerProjectSearch, saveSearchToggles, togglesOn } from "@/lib/projectSearch";
import { keycaps } from "@/lib/shortcuts";
import { fileErrorText, localFileSource, StaleRequestError, type FileSource } from "@/lib/workspaceFiles";

const LIMIT = 500;

/**
 * ⇧⌘F: grep the checkout, grouped by file; a hit opens the editor at its
 * line. ⇧⌘H adds a replacement: every row previews what its matches become,
 * any line or file can be left out, and a replace goes through open buffers
 * where there are any and to disk everywhere else.
 *
 * It searches through a FileSource: the local checkout at `root` unless
 * `source` names another. Replace is offered only where the source can
 * rewrite files.
 *
 * It opens under the title bar, where Open file does, and stays there as
 * the results change. Replace has no control of its own beside the search
 * field: ⇧⌘H shows its row, and the row closes itself.
 *
 * Match case, Whole word and Regex stay as they were left, across reopening
 * and restarts. A search that finds nothing names the toggles that are on
 * and offers to turn them off, and says what the code has that is near it
 * (`nearQueries`): the same text once the toggles are off, or the same name
 * written another way. `openProjectSearch` (lib/projectSearch) opens
 * it from elsewhere with a query filled in.
 */
export function ProjectSearch({ sessionId, root, source, initialOpen }: { sessionId: string; root: string; source?: FileSource; initialOpen?: { mode: "find" | "replace"; query?: string } }) {
  const reader = useMemo(() => source ?? localFileSource(root), [source, root]);
  const cloudKey = reader.kind === "cloud" ? reader.key : undefined;
  const canRewrite = !!reader.replaceText && !reader.readOnly;
  const [open, setOpen] = useState(!!initialOpen);
  const [q, setQ] = useState(initialOpen?.query ?? "");
  const [replacement, setReplacement] = useState("");
  const [replaceShown, setReplaceOpen] = useState(initialOpen?.mode === "replace");
  const replaceOpen = replaceShown && canRewrite;
  const [initialToggles] = useState(loadSearchToggles);
  const [regex, setRegex] = useState(initialToggles.regex);
  const [caseSensitive, setCaseSensitive] = useState(initialToggles.caseSensitive);
  const [wholeWord, setWholeWord] = useState(initialToggles.wholeWord);
  const [result, setResult] = useState<TextSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [replacing, setReplacing] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  // Bumped after a replace so the same query runs again over the new text.
  const [generation, setGeneration] = useState(0);
  /** What the code has near a query that found nothing, and whether turning the toggles off is what finds it. */
  const [near, setNear] = useState<{ text: string; byToggles: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const hitOptionId = (index: number) => `${listId}-hit-${index}`;
  const [sel, setSel] = useState(0);
  const focusNext = useRef<"find" | "replace">(initialOpen?.mode ?? "find");

  useShortcut("files.search", () => {
    focusNext.current = "find";
    setOpen(true);
  });
  useEffect(
    () =>
      registerProjectSearch((query) => {
        if (query) setQ(query);
        focusNext.current = "find";
        setOpen(true);
      }),
    [],
  );
  useEffect(() => saveSearchToggles({ caseSensitive, wholeWord, regex }), [caseSensitive, wholeWord, regex]);
  useShortcut("files.replace", () => {
    if (!canRewrite) return;
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
    const controller = new AbortController();
    const t = window.setTimeout(async () => {
      setBusy(true);
      try {
        if (!reader.search) throw new Error("Searching is not available in this workspace.");
        const r = await reader.search({ query: q, regex, caseSensitive, wholeWord, limit: LIMIT, replacement: preview }, controller.signal);
        if (live) {
          setResult(r);
          setError(null);
        }
      } catch (e) {
        if (live && !(e instanceof StaleRequestError)) setError(cloudKey ? fileErrorText(e) : String(e));
      } finally {
        if (live) setBusy(false);
      }
    }, 180);
    return () => {
      live = false;
      controller.abort();
      window.clearTimeout(t);
    };
  }, [open, q, regex, caseSensitive, wholeWord, reader, preview, generation]);

  // A new question starts with everything selected again.
  useEffect(() => {
    setExcluded(new Set());
    setReport(null);
  }, [q, regex, caseSensitive, wholeWord, root, open]);

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
  const flatHits = useMemo(() => groups.flatMap(([, hits]) => hits), [groups]);
  const hitIndex = useMemo(() => new Map(flatHits.map((h, i) => [hitKey(h), i])), [flatHits]);
  const clampedSel = flatHits.length ? Math.min(sel, flatHits.length - 1) : -1;

  useEffect(() => {
    setSel(0);
  }, [result]);

  useEffect(() => {
    if (!open || clampedSel < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(hitOptionId(clampedSel))}`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, clampedSel, flatHits]);

  const occurrences = useMemo(() => (result?.hits ?? []).reduce((n, h) => n + h.matches.length, 0), [result]);
  const plan = useMemo(() => planReplace(result?.hits ?? [], excluded), [result, excluded]);
  const nothingExcluded = excluded.size === 0;
  const plus = result?.capped && nothingExcluded ? "+" : "";

  const choose = (h: TextHit) => {
    openFile(sessionId, root, h.path, { line: h.line, col: h.col }, root, cloudKey);
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
      const spec: ReplaceSpec = { query: q, replacement, regex, caseSensitive, wholeWord };
      const abs = (rel: string) => `${root}/${rel}`;
      const openRel = liveEditorPathsUnder(root).map((p) => p.slice(root.length + 1));
      const { live, disk } = opts.everything
        ? { live: openRel.map((path): ReplaceTarget => ({ path })), disk: [] }
        : splitTargets(target.targets, (p) => liveEditorsFor(abs(p)).length > 0);
      const unsaved = live.filter((t) => liveEditorsFor(abs(t.path)).some((e) => e.isDirty())).length;
      if (opts.confirm) {
        const suffix = opts.everything ? "+" : "";
        const title = `Replace ${target.occurrences}${suffix} ${target.occurrences === 1 && !suffix ? "match" : "matches"} in ${target.files}${suffix} ${target.files === 1 && !suffix ? "file" : "files"} with “${replacement}”?`;
        const lines: string[] = [];
        if (opts.everything) lines.push(`Only the first ${LIMIT} matches are listed; every match in the checkout will be replaced.`);
        if (unsaved) lines.push(`${unsaved} open ${unsaved === 1 ? "file has" : "files have"} unsaved changes. The replacement goes into ${unsaved === 1 ? "its buffer" : "their buffers"} and stays unsaved.`);
        const ok = await confirmInApp({ title, body: lines.join("\n\n") || undefined, action: "Replace" });
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
          if (!reader.replaceText) throw new Error("Replacing is not available in this workspace.");
          const r = await reader.replaceText({ query: q, replacement, regex, caseSensitive, wholeWord, targets: opts.everything ? null : disk, skip: opts.everything ? openRel : [] });
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
    [q, replacement, regex, caseSensitive, wholeWord, root, reader],
  );

  const replaceSelected = () => {
    if (!plan.occurrences || replacing) return;
    void runReplace(plan, { everything: !!result?.capped && nothingExcluded, confirm: true });
  };
  const replaceFile = (hits: TextHit[]) => void runReplace(planReplace(hits, new Set()), { everything: false, confirm: true });
  const replaceHit = (h: TextHit) => void runReplace(planReplace([h], new Set()), { everything: false, confirm: false });

  const canReplace = replaceOpen && !!result && !busy;
  const noHits = !!q.trim() && !!result && !result.hits.length && !busy;
  const onNames = togglesOn({ caseSensitive, wholeWord, regex });

  // A search that found nothing is followed by quieter ones for what it was near; the first that finds something is said.
  useEffect(() => {
    setNear(null);
    if (!noHits || !reader.search) return;
    let live = true;
    const controller = new AbortController();
    const search = reader.search.bind(reader);
    void (async () => {
      for (const attempt of nearQueries(q, { caseSensitive, wholeWord, regex })) {
        try {
          const found = await search({ query: attempt.query, regex: attempt.regex, caseSensitive: false, wholeWord: false, limit: 1 }, controller.signal);
          const text = found.hits[0] ? nearText(found.hits[0]) : null;
          if (!live) return;
          if (text && text !== q.trim()) return setNear({ text, byToggles: attempt.byToggles });
        } catch {
          // A hint only: a failed look is no hint.
          if (!live) return;
        }
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [noHits, q, caseSensitive, wholeWord, regex, reader]);
  // Exactly the toggles that are on go off, and the query runs again.
  const turnOff = () => {
    setCaseSensitive(false);
    setWholeWord(false);
    setRegex(false);
    focusNext.current = "find";
    input.current?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showClose={false} width="max-w-[38.5rem]" className="bottom-auto top-11 gap-0 overflow-hidden p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Search in project</DialogTitle>
        <div className="border-b border-hairline">
          <div className="flex h-12 items-center gap-2.5 px-4 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/40">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              value={q}
              role="combobox"
              aria-label="Search in project"
              aria-expanded={flatHits.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={clampedSel >= 0 ? hitOptionId(clampedSel) : undefined}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  if (flatHits.length) {
                    e.preventDefault();
                    setSel((s) => Math.min(flatHits.length - 1, s + 1));
                  }
                } else if (e.key === "ArrowUp") {
                  if (flatHits.length) {
                    e.preventDefault();
                    setSel((s) => Math.max(0, s - 1));
                  }
                } else if (e.key === "Enter" && !e.nativeEvent.isComposing && clampedSel >= 0) {
                  e.preventDefault();
                  choose(flatHits[clampedSel]);
                }
              }}
              placeholder="Search in project"
              spellCheck={false}
              autoComplete="off"
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
            <Kbd className="shrink-0 text-xs text-muted-foreground">{keycaps("escape")[0]}</Kbd>
          </div>
          {replaceOpen && (
            <div className="flex items-center gap-2.5 px-4 pb-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/40">
              <Replace className="size-4 shrink-0 text-muted-foreground" />
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
                className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
              />
              <Button variant="accent" size="xs" disabled={!canReplace || !plan.occurrences || replacing} onClick={replaceSelected}>
                <ReplaceAll />
                {replacing ? "Replacing…" : `Replace ${plan.occurrences}${plus}`}
              </Button>
              <WithTooltip label="Hide replace">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Hide replace"
                  className="text-muted-foreground"
                  onClick={() => {
                    focusNext.current = "find";
                    setReplaceOpen(false);
                  }}
                >
                  <X />
                </Button>
              </WithTooltip>
            </div>
          )}
          <div className="flex h-9 items-center gap-1 border-t border-hairline px-3">
            <SearchToggle label="Match case" text="Match case" pressed={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
              <CaseSensitive className="size-3.5" />
            </SearchToggle>
            <SearchToggle label="Whole word" text="Whole word" pressed={wholeWord} onClick={() => setWholeWord((v) => !v)}>
              <WholeWord className="size-3.5" />
            </SearchToggle>
            <SearchToggle label="Regular expression" text="Regex" pressed={regex} onClick={() => setRegex((v) => !v)}>
              <Regex className="size-3.5" />
            </SearchToggle>
            {result && (
              <div className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">
                {occurrences}
                {result.capped ? "+" : ""} {occurrences === 1 && !result.capped ? "match" : "matches"}
                {occurrences || result.capped ? ` in ${result.files} file${result.files === 1 ? "" : "s"}` : ""}
                {replaceOpen && !nothingExcluded ? ` · ${plan.occurrences} selected` : ""}
                {busy ? " · searching…" : ""}
              </div>
            )}
          </div>
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Search matches" className="max-h-[min(26rem,calc(100dvh-14rem))] overflow-auto p-1.5 scrollbar-thin">
          {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
          {report && <div className="px-3 py-2 text-xs text-add">{report}</div>}
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
                const idx = hitIndex.get(hitKey(h)) ?? -1;
                const isSelected = idx === clampedSel;
                return (
                  <div
                    key={`${h.line}:${h.col}`}
                    id={idx >= 0 ? hitOptionId(idx) : undefined}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => idx >= 0 && setSel(idx)}
                    className={cn(
                      "group/hit flex w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[12px] text-muted-foreground hover:bg-veil-strong hover:text-foreground",
                      isSelected && "bg-veil-strong text-foreground",
                      replaceOpen && !on && "opacity-50",
                    )}
                  >
                    {replaceOpen && <SearchCheck label={`Include line ${h.line}`} checked={on} onChange={(v) => toggleHit(h, v)} />}
                    <button type="button" onClick={() => choose(h)} className="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
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
          {noHits && (
            <div className="px-3 py-8 text-center">
              <div className="mx-auto grid size-10 place-items-center rounded-lg bg-veil-strong">
                <NoHitsIcon className="size-[18px] text-muted-foreground" />
              </div>
              <div className="mt-3 text-sm font-medium text-foreground">No matches for “{q}”</div>
              {(onNames.length > 0 || near) && (
                <>
                  <div className="mx-auto mt-1 max-w-[26rem] text-[12.5px] text-muted-foreground" aria-live="polite">
                    {onNames.length > 0 && `${joinNames(onNames)} ${onNames.length === 1 ? "is" : "are"} on. `}
                    {near && (
                      <>
                        The code uses <span className="font-mono text-xs text-foreground">{near.text}</span>
                        {near.byToggles ? `; try turning ${onNames.length === 1 ? "it" : "them"} off.` : "."}
                      </>
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {onNames.length > 0 && (
                      <Button variant="outline" size="sm" className="text-muted-foreground" onClick={turnOff}>
                        <ToggleLeft />
                        Turn off {joinNames(onNames)}
                      </Button>
                    )}
                    {near && !near.byToggles && (
                      <Button variant="outline" size="sm" className="max-w-full text-muted-foreground" onClick={() => { setQ(near.text); input.current?.focus(); }}>
                        <Search />
                        <span className="truncate">Search for {near.text}</span>
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          {!q.trim() && (
            <div className="px-3 py-6 text-center text-xs text-faint">
              {replaceOpen ? "Type to search, then a replacement to preview it in every file." : "Type to search every file in the checkout."}
            </div>
          )}
        </div>
        <div className="flex h-9 items-center gap-4 border-t border-hairline px-4 text-xs text-faint">
          <span className="truncate">Searches files in this worktree that git does not ignore</span>
          <span className="ml-auto shrink-0">Toggles stay on for the next search</span>
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
