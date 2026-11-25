import { noteChangesCount } from "@/lib/panelMarks";
import { ReviewCommentsProvider, useReviewComments } from "./ReviewComments";
import { DiscardDialog, DiscardButton } from "./DiscardDialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { openConflict, openDiff, openFile, openReviewStack, useEditors } from "@/lib/editors";
import { useTerminals } from "@/lib/terminal";
import { changeRange, type ChangeRange } from "@/lib/changes";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CircleDot, GitCommitHorizontal, Layers, MessageSquare } from "@/icons";
import type { AgentEvent } from "@/types/events";
import type { BranchInfo, ChangedFile, UnfinishedMerge } from "@/types/session";
import { FileDiff } from "./FileDiff";
import { useDiffOptions } from "@/lib/diffOptions";
import { ReviewFileList } from "./ReviewFileList";
import { ScopePicker, TargetPicker } from "./ScopePicker";
import { EmptyState } from "./EmptyState";
import { checkpointChoices, commitRange, readChangesChoice, saveChangesChoice, type ChangesChoice } from "@/lib/changesScope";
import { MergeInProgress } from "./MergeInProgress";
import { RepoPanel } from "./RepoPanel";
import { showCompareSwitchFailed } from "@/lib/branchToasts";
import { dismissErrorKey } from "@/lib/errorToasts";
import { onThreadJump, onThreadJumpFallback, pendingThreadJump, setPendingThreadJump, threadCounts, threadFile, type ThreadView } from "@/lib/reviewThreads";
import { useSessionThreads } from "./ReviewThreads";

/**
 * Review the accumulated workspace by default; turn snapshots are opt-in.
 * Uncommitted is where a commit is made, and History opens past commits.
 */
export function ChangesPanel(props: {
  reviewTabId?: string | null;
  /** Supplied by the workspace host only when file access is available. */
  openFileAction?: (path: string) => (() => void) | undefined;
  cwd?: string;
  sessionId?: string;
  source?: GitSource;
  events: AgentEvent[];
  version: number;
  baseRef?: string | null;
  active: boolean;
  live: boolean;
  workingTree?: boolean;
}) {
  const source = useMemo(() => props.source ?? localGitSource(props.cwd ?? ""), [props.source, props.cwd]);
  const root = !source.cloud ? props.cwd ?? (source.key.startsWith("local:") ? source.key.slice(6) : undefined) : undefined;
  const panel = <ScopedChanges key={source.key} {...props} source={source} sessionId={props.sessionId} editor={root ? { root, sessionId: props.sessionId ?? `checkout:${root}` } : undefined} />;
  return props.reviewTabId ? <ReviewCommentsProvider key={source.key} source={source} active={props.active} tabId={props.reviewTabId}>{panel}</ReviewCommentsProvider> : panel;
}

function ScopedChanges({ openFileAction: hostOpenFileAction, source, events, version, active, live, workingTree, editor, sessionId }: {
  openFileAction?: (path: string) => (() => void) | undefined;
  editor?: { root: string; sessionId: string };
  /** The session whose agent tab the merge card asks; none for a checkout without one. */
  sessionId?: string;
  source: GitSource;
  events: AgentEvent[];
  version: number;
  active: boolean;
  live: boolean;
  workingTree?: boolean;
}) {
  const openFileAction = hostOpenFileAction ?? (editor ? (path: string) => () => openFile(editor.sessionId, editor.root, path) : undefined);
  const review = useReviewComments();
  // The session's PR and its threads are read here too: the PR panel need never have been opened (PRO-234).
  const threads = useSessionThreads(source, sessionId, active);
  const { hideWhitespace } = useDiffOptions();
  const [choice, setChoice] = useState(() => readChangesChoice(source.key));
  const turnRange = useMemo(() => {
    let start = 0;
    events.forEach((event, index) => {
      if (event.payload.type === "user_message" && !event.payload.queued) start = index;
    });
    return changeRange(events.slice(start));
  }, [events, version]);
  const checkpoints = useMemo(() => workingTree ? [] : checkpointChoices(events), [events, version, workingTree]);
  const checkpoint = checkpoints.find((entry) => entry.id === choice.checkpoint);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [targetOpen, setTargetOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const targetInput = useRef<HTMLInputElement>(null);
  const [switching, setSwitching] = useState(false);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ range: ChangeRange; target: string; files: ChangedFile[]; merge: UnfinishedMerge | null; mergeError: string | null;
    /** A merge's own files: what is uncommitted against HEAD, whichever scope is shown. */
    mergeWork: { range: ChangeRange; files: ChangedFile[] } | null; } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // History is the repository's view, which reads for itself. Uncommitted is too, except while a
  // merge is in progress (#736): then the merge's own view (what is the base's, what was changed
  // here, what is conflicted) leads, so it is read here like the other scopes.
  const reads = choice.scope !== "history";
  const repo = choice.scope === "history" ? "history" : choice.scope === "uncommitted" && !result?.merge ? "uncommitted" : null;
  // What is chosen now, for a step that finishes after an await: Apply's check must not put back a scope changed meanwhile.
  const latestChoice = useRef(choice);
  latestChoice.current = choice;
  const choose = (next: ChangesChoice) => {
    latestChoice.current = next;
    setChoice(next);
    setTick((t) => t + 1);
    setResult(null);
    setError(null);
    setLoading(true);
    saveChangesChoice(source.key, next);
  };
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = async () => {
      try {
        const next = await source.branches();
        if (!cancelled) { setBranches(next); setBranchError(null); }
      } catch (error) { if (!cancelled) setBranchError(source.errorMessage(error)); }
    };
    void read();
    window.addEventListener("focus", read);
    return () => { cancelled = true; window.removeEventListener("focus", read); };
  }, [source, active]);
  useEffect(() => {
    if (!active || loading || !reads || choice.scope === "commit" || choice.scope === "checkpoint") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 4000);
    const refresh = () => setTick((t) => t + 1);
    window.addEventListener("focus", refresh);
    window.addEventListener("workspace-files-changed", refresh);
    return () => { window.clearInterval(id); window.removeEventListener("focus", refresh); window.removeEventListener("workspace-files-changed", refresh); };
  }, [active, loading, reads, choice.scope]);
  useEffect(() => {
    if (!active || !reads) return;
    let cancelled = false;
    setLoading(true);
    const read = async () => {
      let range: ChangeRange;
      let target: string;
      if (choice.scope === "commit") {
        if (!choice.commit) {
          setResult(null);
          setError(null);
          return;
        }
        const review = await commitRange(source, choice.commit);
        range = review;
        target = review.target;
      } else if (choice.scope === "checkpoint") {
        if (!checkpoint) throw new Error("This turn checkpoint is unavailable in this conversation. Choose another scope.");
        range = { base: checkpoint.base, head: checkpoint.head };
        target = checkpoint.label;
      } else if (choice.scope === "turn") {
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
      if (cancelled) return;
      // A merge left in progress makes the base's files look like this branch's own (#736).
      const [files, merge] = await Promise.all([
        source.changesBetween(range.base, range.head, hideWhitespace),
        ((choice.scope === "all" || choice.scope === "uncommitted" ? source.unfinishedMerge?.() : null) ?? Promise.resolve(null)).then(
          (merge) => ({ merge, mergeError: null }),
          (e: unknown) => ({ merge: null, mergeError: source.errorMessage(e) }),
        ),
      ]);
      // The merge card lists what is uncommitted; All changes reads that as well.
      const mergeWork = !merge.merge ? null : choice.scope === "uncommitted" ? { range, files } : await (async () => {
        const work = await source.reviewRange(null, true);
        return { range: { base: work.base, head: work.head }, files: await source.changesBetween(work.base, work.head, hideWhitespace) };
      })();
      if (!cancelled) {
        setResult({ range, target, files, ...merge, mergeWork });
        setError(null);
        // The panel's tab row counts the branch's files (PRO-394): All changes against the default comparison is that.
        if (choice.scope === "all" && !choice.target) noteChangesCount(source.key, files.length);
      }
    };
    void read().catch((e) => {
      if (!cancelled) { setResult(null); setError(source.errorMessage(e)); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source, choice.scope, choice.target, choice.commit, choice.checkpoint, checkpoint?.base, checkpoint?.head, choice.scope === "turn" ? turnRange?.base : null, choice.scope === "turn" ? turnRange?.head : null, active, tick, workingTree, live, reads, hideWhitespace]);
  // A comparison branch is tried before it is switched to (PRO-295): one that cannot be used leaves the comparison
  // where it was, and a toast says why, what it still compares against, and git's own words.
  const applyTarget = async (target: string | null) => {
    if (switching) return;
    if (!target || target === choice.target) {
      dismissErrorKey("compare-switch");
      choose({ ...choice, target });
      return;
    }
    setSwitching(true);
    try {
      await source.reviewRange(target, false);
    } catch (e) {
      showCompareSwitchFailed({
        target,
        current: result?.target ?? choice.target ?? "the automatic base branch",
        error: source.errorMessage(e),
        branches,
        onChooseAnother: () => setTargetOpen(true),
      });
      return;
    } finally {
      setSwitching(false);
    }
    dismissErrorKey("compare-switch");
    // The check took a while: the target joins the choice as it is now, keeping a scope picked during it.
    choose({ ...latestChoice.current, target });
  };
  // Turn, checkpoint and commit scopes are fixed snapshots; All and Uncommitted are live comparisons a tab can refresh.
  const fixed = choice.scope === "turn" || choice.scope === "checkpoint" || choice.scope === "commit";
  // A file opens the scope's one review tab, which stacks every changed file (PRO-392); the panel stays as it is.
  const onOpenDiff = editor ? (file: ChangedFile, range: ChangeRange) => openReviewStack(editor.sessionId, editor.root, file.path, fixed
    ? { scope: "turn", range, turnLabel: choice.scope === "commit" && choice.commit ? `Commit ${choice.commit.slice(0, 7)}` : choice.scope === "checkpoint" ? "Turn" : undefined }
    : { scope: "all", range, target: choice.target, uncommitted: choice.scope === "uncommitted" }) : undefined;
  // A Checks row whose file this list does not have yet: read All changes, then open the file (PRO-234).
  useEffect(() => onThreadJumpFallback(source.key, async (thread) => {
    const all = await source.reviewRange(choice.target, false);
    const file = threadFile(await source.changesBetween(all.base, all.head, hideWhitespace), thread);
    if (!file) return false;
    if (editor) {
      openReviewStack(editor.sessionId, editor.root, file.path, { scope: "all", range: { base: all.base, head: all.head }, target: choice.target, uncommitted: false });
      return true;
    }
    // Here the list itself shows the diff: it opens the file once All changes has loaded it.
    setPendingThreadJump(source.key, thread);
    if (choice.scope !== "all") choose({ ...choice, scope: "all" }); else setTick((t) => t + 1);
    return true;
  }), [source, choice, hideWhitespace, editor?.sessionId, editor?.root]);
  useEffect(() => { if (result) review?.refresh(); }, [result, review?.refresh]);
  const merge = result?.merge ?? null;
  // While a merge is in progress, its card is the live views: conflicts, what was changed here, what it brought in.
  // Nothing is listed under it: All changes would count what the merge brings in as the branch's own work.
  const mergeOnly = !!merge && (choice.scope === "uncommitted" || choice.scope === "all");
  const openPath = useOpenConflictPath(editor);
  const onOpenConflict = editor && merge && source.conflictFile ? (path: string) => openConflict(editor.sessionId, editor.root, path, merge, merge.conflictCounts[path] ?? 0) : undefined;
  const onOpenMergeFile = editor && result?.mergeWork ? (file: ChangedFile) => openDiff(editor.sessionId, editor.root, file.path,
    { scope: "all", range: result.mergeWork!.range, oldPath: file.oldPath, target: null, uncommitted: true }) : undefined;
  const currentBranch = branches.find((branch) => branch.current)?.name ?? null;
  const comparedWith = (choice.scope === "all" && result?.target) || choice.target;
  const showTurn = !workingTree && (live || !checkpoints.length);
  const back = () => choose({ ...choice, scope: "all" });
  const backButton = <Button size="sm" variant="outline" className="border" onClick={back}><ArrowLeft /> Back to all changes</Button>;
  const commitSubject = choice.scope === "commit" && result?.target ? result.target.split(" · ").slice(1).join(" · ") : "";
  const emptyState = choice.scope === "all"
    ? <EmptyState icon={<Layers />} title="No file changes yet">This branch has no changes against <span className="font-mono">{result?.target ?? "its base branch"}</span>.</EmptyState>
    : choice.scope === "uncommitted"
      ? <EmptyState icon={<CircleDot />} title="No uncommitted changes" actions={backButton}>Everything in this workspace is committed.</EmptyState>
      : choice.scope === "commit"
        ? <EmptyState icon={<GitCommitHorizontal />} title={`No file changes in ${choice.commit?.slice(0, 7) ?? "this commit"}`}
          actions={<>{backButton}<Button size="sm" variant="outline" className="border" onClick={() => setScopeOpen(true)}><GitCommitHorizontal /> Pick another commit</Button></>}>
          {commitSubject && <p className="font-mono text-muted-foreground">{commitSubject}</p>}
          <p>{/^Merge /.test(commitSubject) ? "A merge with no conflicts adds no changes of its own." : "This commit doesn't change any files."}</p>
        </EmptyState>
        : <EmptyState icon={<MessageSquare />} title="No changes in the selected turn" actions={backButton}>The agent didn't change any files in this turn.</EmptyState>;
  const unavailable = loading ? null : choice.scope === "commit" && !choice.commit
    ? <EmptyState icon={<GitCommitHorizontal />} title="Choose a commit" actions={<Button size="sm" variant="outline" className="border" onClick={() => setScopeOpen(true)}><GitCommitHorizontal /> Pick a commit</Button>}>Choose a commit to review its changes.</EmptyState>
    : <EmptyState role="note" icon={choice.scope === "turn" || choice.scope === "checkpoint" ? <MessageSquare /> : <Layers />} title="Changes unavailable" actions={<><Button size="sm" variant="outline" className="border" onClick={() => setTick((t) => t + 1)}>Retry</Button>{choice.scope !== "all" ? backButton : null}</>}><p role="alert">{error ?? "Changes unavailable."}</p></EmptyState>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-2">
        <ScopePicker source={source} choice={choice} onChoose={choose} checkpoints={checkpoints} showTurn={showTurn} live={live} open={scopeOpen} onOpenChange={setScopeOpen}
          currentBranch={currentBranch} target={comparedWith} onPickTarget={() => setTargetOpen(true)} hideWhitespace={hideWhitespace} />
        {choice.scope === "all" && <TargetPicker open={targetOpen} onOpenChange={setTargetOpen} label={(comparedWith ?? "base").replace(/^origin\//, "")} value={choice.target}
          branches={branches} busy={switching} onApply={(target) => void applyTarget(target)} inputRef={targetInput} />}
      </div>
      {choice.scope === "all" && branchError && targetOpen && <p className="px-3 pt-1 text-xs text-muted-foreground">Branch suggestions unavailable: {branchError}</p>}
      {merge && <div className={cn("overflow-y-auto pb-2 scrollbar-thin", mergeOnly ? "min-h-0 flex-1" : "max-h-[55%] shrink-0 border-b border-hairline")}>
        <MergeInProgress source={source} merge={merge} files={result?.mergeWork?.files ?? []} sessionId={sessionId}
          onChanged={() => setTick((t) => t + 1)} onOpenConflict={onOpenConflict} onOpenFile={onOpenMergeFile} openPath={openPath} />
      </div>}
      {result?.mergeError && <div role="alert" className="mx-3 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">Whether a merge is in progress could not be read: {result.mergeError}</div>}
      {!mergeOnly && <div className="min-h-0 flex-1">
        {repo ? <RepoPanel openFileAction={openFileAction} onOpenDiff={onOpenDiff} source={source} active={active} revision={tick} view={repo} onViewChange={(view) => choose({ ...choice, scope: view })} onReviewCommit={(commit) => choose({ ...choice, scope: "commit", commit })} embedded /> : <ChangesBody openFileAction={openFileAction} onOpenDiff={onOpenDiff} key={`${choice.scope}:${choice.target}:${choice.commit}:${choice.checkpoint}`} source={source} files={result?.files ?? []} loading={loading} error={error} range={result?.range ?? null}
          allowDiscard={choice.scope !== "commit" && choice.scope !== "checkpoint"}
          empty={emptyState} unavailable={unavailable} onChanged={() => setTick((t) => t + 1)} />}
      </div>}
      {threads?.snapshot && <ReviewThreadsFooter view={threads} />}
    </div>
  );
}

/** The PR's GitHub review threads at a glance (PRO-234, design 05.13): "PR #14 review threads 0 open · 1 resolved". */
function ReviewThreadsFooter({ view }: { view: ThreadView }) {
  const counts = threadCounts(view.snapshot?.threads ?? []);
  return <div data-testid="changes-review-threads" className="flex min-w-0 shrink-0 items-center gap-2 border-t border-hairline px-3 py-1.5 text-[11px]">
    <span className="min-w-0 truncate text-muted-foreground">PR #{view.pr.number} review threads</span>
    <span className="ml-auto shrink-0 tabular-nums text-faint">{counts.open} open · {counts.resolved} resolved</span>
  </div>;
}

/**
 * The conflicted file whose tab is being looked at in this checkout: the
 * selected workspace tab, or the file pane's active entry where a checkout
 * has no workspace tab strip.
 */
function useOpenConflictPath(editor: { root: string; sessionId: string } | undefined): string | null {
  const editors = useEditors();
  const selected = useTerminals().selected;
  if (!editor) return null;
  const pick = selected[editor.sessionId];
  const id = pick ? (pick.kind === "review" ? pick.id : null) : editors.active[editor.sessionId];
  const open = editors.editors.find((e) => e.id === id);
  return open?.kind === "conflict" && open.root === editor.root ? open.rel : null;
}

function ChangesBody({
  openFileAction,
  source,
  files,
  loading,
  error,
  range,
  empty,
  unavailable,
  onOpenDiff,
  onChanged,
  allowDiscard,
}: {
  openFileAction?: (path: string) => (() => void) | undefined;
  onOpenDiff?: (file: ChangedFile, range: ChangeRange) => void;
  source: GitSource;
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
  range: ChangeRange | null;
  /** Drawn in place of the list when the scope has no files. */
  empty: React.ReactNode;
  /** Drawn when there is no range to list (loading, failed, nothing chosen); null while loading. */
  unavailable: React.ReactNode;
  onChanged: () => void;
  allowDiscard: boolean;
}) {
  const [discarding, setDiscarding] = useState<ChangedFile | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const current = files.find((f) => f.path === selected) ?? null;

  const select = (path: string) => {
    const file = files.find((f) => f.path === path);
    if (onOpenDiff && file && range) onOpenDiff(file, range);
    else setSelected((s) => s === path ? null : path);
  };
  // A thread's row in the Checks list opens its file here, or in its centre diff tab.
  useEffect(() => onThreadJump(source.key, (thread) => {
    const file = threadFile(files, thread);
    if (!file || !range) return false;
    if (onOpenDiff) onOpenDiff(file, range); else setSelected(file.path);
    return true;
  }), [source.key, files, range, onOpenDiff]);
  // A jump that had to load this list first.
  useEffect(() => {
    const thread = pendingThreadJump(source.key);
    const file = thread && range ? threadFile(files, thread) : undefined;
    if (!thread || !file || !range) return;
    setPendingThreadJump(source.key, null);
    if (onOpenDiff) onOpenDiff(file, range); else setSelected(file.path);
  }, [source.key, files, range]);
  const discardAction = allowDiscard && source.discard && source.canWrite ? (file: ChangedFile) => <DiscardButton path={file.path} onClick={() => setDiscarding(file)} /> : undefined;

  if (!range) return unavailable ?? <div role="status" className="animate-panel-content px-3 py-4 text-xs text-muted-foreground">Loading changes…</div>;
  if (!files.length && !error) return loading ? <div role="status" className="animate-panel-content px-3 py-4 text-xs text-muted-foreground">Loading changes…</div> : empty;

  return (
    <div className="animate-panel-content flex h-full min-h-0 flex-col">
      <DiscardDialog source={source} file={discarding} base={range.base} onClose={() => setDiscarding(null)} onDiscarded={() => { setSelected(null); onChanged(); }} />
      {error && <div role="alert" className="mx-3 mb-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error} <Button size="xs" variant="outline" onClick={onChanged}>Retry</Button></div>}
      <div className={cn("shrink-0 overflow-y-auto scrollbar-thin", current ? "max-h-[40%] border-b border-hairline" : "flex-1")}>
        <ReviewFileList workspace={source.key} base={range.base} files={files} selected={selected} onSelect={select} empty="No changes in this scope." trailing={discardAction} loading={loading} />
      </div>
      {current && <div className="min-h-0 flex-1">
        <FileDiff onOpenFile={current.status !== "deleted" ? openFileAction?.(current.path) : undefined} source={source} path={current.path} oldPath={current.oldPath} base={range.base} head={range.head} stats={current} onDiscard={discardAction ? () => setDiscarding(current) : undefined} />
      </div>}
    </div>
  );
}
