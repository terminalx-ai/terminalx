import { useEffect, useId, useMemo, useState } from "react";
import { Columns2, Rows2 } from "@/icons";
import { changeRange, type ChangeRange } from "@/lib/changes";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { AgentEvent } from "@/types/events";
import type { ChangedFile, UnfinishedMerge } from "@/types/session";
import { DiffPane } from "./DiffPane";
import { FileList, sumChanges } from "./FileList";
import { MergeInProgress, mergeGroups, type MergeGroup } from "./MergeInProgress";

type Scope = "all" | "uncommitted" | "turn";
type Choice = { scope: Scope; target: string | null };
const preferenceKey = (source: GitSource) => `changes-scope:${source.key}`;
function readChoice(source: GitSource): Choice {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(source)) ?? "null");
    if (saved && ["all", "uncommitted", "turn"].includes(saved.scope)) {
      return { scope: saved.scope, target: typeof saved.target === "string" ? saved.target : null };
    }
  } catch { /* Storage may be unavailable. */ }
  return { scope: "all", target: null };
}

/** Review the accumulated workspace by default; turn snapshots are opt-in. */
export function ChangesPanel(props: {
  cwd?: string;
  source?: GitSource;
  events: AgentEvent[];
  version: number;
  baseRef?: string | null;
  active: boolean;
  live: boolean;
  workingTree?: boolean;
  onViewUncommitted: () => void;
}) {
  const source = useMemo(() => props.source ?? localGitSource(props.cwd ?? ""), [props.source, props.cwd]);
  return <ScopedChanges key={source.key} {...props} source={source} />;
}

function ScopedChanges({ source, events, version, active, live, workingTree, onViewUncommitted }: {
  source: GitSource;
  events: AgentEvent[];
  version: number;
  active: boolean;
  live: boolean;
  workingTree?: boolean;
  onViewUncommitted: () => void;
}) {
  const targetId = useId();
  const [choice, setChoice] = useState(() => readChoice(source));
  const turnRange = useMemo(() => {
    let start = 0;
    events.forEach((event, index) => {
      if (event.payload.type === "user_message" && !event.payload.queued) start = index;
    });
    return changeRange(events.slice(start));
  }, [events, version]);
  const [draft, setDraft] = useState(choice.target ?? "");
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ range: ChangeRange; target: string; files: ChangedFile[]; merge: UnfinishedMerge | null; mergeError: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const choose = (next: Choice) => {
    setChoice(next);
    setTick((t) => t + 1);
    setResult(null);
    setError(null);
    setLoading(true);
    try { localStorage.setItem(preferenceKey(source), JSON.stringify(next)); } catch { /* Optional persistence. */ }
  };
  useEffect(() => {
    if (!active || loading) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 4000);
    const refresh = () => setTick((t) => t + 1);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(id); window.removeEventListener("focus", refresh); };
  }, [active, loading]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    const read = async () => {
      let range: ChangeRange;
      let target: string;
      if (choice.scope === "turn") {
        const turn = turnRange;
        if (!turn || (!live && !turn.head) || workingTree) {
          setResult(null);
          setError("No turn snapshots are available. Choose All changes to review the workspace.");
          return;
        }
        range = turn.head ? turn : { base: turn.base, head: (await source.reviewRange(null, true)).head };
        target = `Turn snapshot ${range.base.slice(0, 7)}`;
      } else {
        const review = await source.reviewRange(choice.target, choice.scope === "uncommitted");
        range = review;
        target = review.target;
      }
      // A merge left in progress makes the base's files look like this branch's own (#736).
      const [files, merge] = await Promise.all([
        source.changesBetween(range.base, range.head),
        (source.unfinishedMerge?.() ?? Promise.resolve(null)).then(
          (merge) => ({ merge, mergeError: null }),
          (e: unknown) => ({ merge: null, mergeError: source.errorMessage(e) }),
        ),
      ]);
      if (!cancelled) { setResult({ range, target, files, ...merge }); setError(null); }
    };
    void read().catch((e) => {
      if (!cancelled) { setResult(null); setError(source.errorMessage(e)); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source, choice.scope, choice.target, choice.scope === "turn" ? turnRange?.base : null, choice.scope === "turn" ? turnRange?.head : null, active, tick, workingTree, live]);
  const label = choice.scope === "all" ? "All changes" : choice.scope === "uncommitted" ? "Uncommitted changes" : live ? "This turn" : "Last turn";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-hairline px-3 py-2 text-xs">
        <label className="flex items-center gap-2">Scope
          <select aria-label="Changes scope" className="min-w-0 flex-1 rounded bg-well p-1" value={choice.scope} onChange={(e) => choose({ ...choice, scope: e.target.value as Scope })}>
            <option value="all">All changes</option>
            <option value="uncommitted">Uncommitted changes</option>
            <option value="turn">{live ? "This turn" : "Last turn"}</option>
          </select>
        </label>
        {choice.scope === "all" && <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); choose({ ...choice, target: draft.trim() || null }); }}>
          <label htmlFor={targetId}>Target</label>
          <input id={targetId} aria-label="Comparison target" className="min-w-0 flex-1 rounded bg-well p-1 font-mono" value={draft} placeholder={result?.target ?? "Automatic base branch"} onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" variant="secondary" size="sm">Apply</Button>
        </form>}
        <p className="break-words text-muted-foreground">{result
          ? choice.scope === "all" ? `Against ${result.target} · merge-base tree ${result.range.base.slice(0, 7)}`
            : choice.scope === "uncommitted" ? `Against HEAD · tree ${result.range.base.slice(0, 7)}` : result.target
          : choice.scope === "all" ? `Target: ${choice.target ?? "automatic base branch"}` : choice.scope === "uncommitted" ? "Against HEAD" : "Turn snapshots"}</p>
      </div>
      {result?.merge && <MergeInProgress source={source} merge={result.merge} allChanges={choice.scope === "all"} onChanged={() => setTick((t) => t + 1)} />}
      {result?.mergeError && <div role="alert" className="mx-3 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">Whether a merge is in progress could not be read: {result.mergeError}</div>}
      <div className="min-h-0 flex-1">
        <ChangesBody key={`${choice.scope}:${choice.target}`} source={source} files={result?.files ?? []} loading={loading} error={error} range={result?.range ?? null}
          groups={choice.scope === "uncommitted" && result?.merge ? mergeGroups(result.merge, result.files) : null}
          label={label} empty={loading ? "Loading changes…" : error ? "Changes unavailable." : "No changes in this scope."}
          noRange={loading ? "Loading changes…" : "Changes unavailable."} />
      </div>
      <div className="shrink-0 border-t border-hairline px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onViewUncommitted}>Commit and history in Repo</Button>
      </div>
    </div>
  );
}

function ChangesBody({
  source,
  files,
  groups,
  loading,
  error,
  range,
  label,
  empty,
  noRange,
}: {
  source: GitSource;
  files: ChangedFile[];
  /** The files of a merge in progress, by what they are; null to list them as one. */
  groups: MergeGroup[] | null;
  loading: boolean;
  error: string | null;
  range: ChangeRange | null;
  label: string;
  empty: string;
  noRange: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [pair, setPair] = useState<{ path: string; before: string; after: string } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const current = files.find((f) => f.path === selected) ?? null;

  useEffect(() => {
    if (!current || !range) {
      setPair(null);
      setPairError(null);
      return;
    }
    let cancelled = false;
    setPair(null);
    setPairError(null);
    const read = async () => {
      const next = await source.fileContentsAt(current.path, range.base, range.head);
      const before = current.oldPath ? (await source.fileContentsAt(current.oldPath, range.base, range.head)).before : next.before;
      if (!cancelled) setPair({ path: current.path, before: before ?? "", after: next.after ?? "" });
    };
    void read().catch((e) => { if (!cancelled) setPairError(source.errorMessage(e)); });
    return () => { cancelled = true; };
  }, [source, current?.path, current?.oldPath, range?.base, range?.head]);

  const totals = sumChanges(files);

  if (!range) return <div role={error ? "alert" : "status"} className="px-3 py-4 text-xs text-muted-foreground">{error ?? noRange}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>{label} · {files.length} {files.length === 1 ? "file" : "files"}</span>
        <span className="font-mono tabular-nums">
          {totals.additions > 0 && <span className="text-add">+{totals.additions}</span>}{" "}
          {totals.deletions > 0 && <span className="text-destructive">−{totals.deletions}</span>}
        </span>
        {loading && <span className="text-faint">…</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <WithTooltip label="Unified">
            <Button variant={mode === "unified" ? "secondary" : "ghost"} size="icon-xs" aria-label="Unified" onClick={() => setMode("unified")}>
              <Rows2 />
            </Button>
          </WithTooltip>
          <WithTooltip label="Split">
            <Button variant={mode === "split" ? "secondary" : "ghost"} size="icon-xs" aria-label="Split" onClick={() => setMode("split")}>
              <Columns2 />
            </Button>
          </WithTooltip>
        </div>
      </div>
      {error && <div className="mx-3 mb-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
      <div className={cn("shrink-0 overflow-y-auto scrollbar-thin", pair ? "max-h-[40%] border-b border-hairline" : "flex-1")}>
        {groups?.length ? groups.map((group) => (
          <section key={group.key} aria-label={group.title}>
            <h3 className="px-3 pt-2 text-[11px] font-medium text-faint">{group.title} · {group.files.length}</h3>
            <FileList files={group.files} selected={selected} onSelect={(p) => setSelected((s) => (s === p ? null : p))} empty={empty} />
          </section>
        )) : <FileList files={files} selected={selected} onSelect={(p) => setSelected((s) => (s === p ? null : p))} empty={empty} />}
      </div>
      {pairError && <div role="alert" className="px-3 py-2 text-xs text-destructive">{pairError}</div>}
      {current && !pair && !pairError && <div role="status" className="px-3 py-2 text-xs">Loading file diff…</div>}
      {pair && (
        <div className="min-h-0 flex-1">
          <DiffPane path={pair.path} before={pair.before} after={pair.after} mode={mode} />
        </div>
      )}
    </div>
  );
}
