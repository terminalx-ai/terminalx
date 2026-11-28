import { type ReactNode, useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight, CircleAlert, CircleCheck, CircleMinus, CircleX, ExternalLink, Loader2, LoaderCircle, RefreshCw, RotateCcw, Wrench, X } from "@/icons";
import { openExternalWebUrl } from "@/lib/externalUrl";
import type { CheckLog, PrCheck, PullRequest } from "@/lib/api";
import type { GitSource } from "@/lib/gitSource";
import { actionsRuns, checkBucket, checkCounts, checkLine, checkMinutes, checkStateLabel, checkSummary, checkTime, isFailingCheck, isRequiredCheck, minutesLabel, RUNNING_CHECKS, webUrl } from "@/lib/checks";
import type { PipelineChecksView } from "@/lib/issuePipeline";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { AnsiLog, plainLog } from "./AnsiLog";
import { addThreadsToChat, githubAuthorName, githubReviewLocation, refreshThreads, requestThreadJump, threadCounts, threadInitials, type ReviewThread, type ThreadView } from "@/lib/reviewThreads";

export const checkKey = (check: PrCheck, index: number) => `${check.name}\0${check.url ?? ""}\0${index}`;

/** Ticks once a minute while a check runs, so "Running · 4m" keeps time. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

/**
 * A pull request's checks, as the Checks tab lists them (PRO-394, designs
 * 05.02/05.08/05.09): with a failure, a red band saying how many failed with
 * one Fix action, then a two-line row per check (its time, GitHub's line,
 * Logs and Re-run); with none, a CHECKS heading and a short row per check
 * with its time. Never folded away.
 *
 * `onOpenLog` opens a check's log in a centre tab and `viewing` names the
 * check whose log is open there; without it (a cloud workspace) the log opens
 * under the list.
 */
export function PrChecks({ pr, source, disabled, fixBusy, onRerun, onRerunCheck, onFix, onOpenLog, viewing, showSummary = true }: {
  pr: PullRequest;
  source: GitSource;
  disabled: boolean;
  fixBusy?: boolean;
  showSummary?: boolean;
  onRerun: (failedOnly: boolean) => void;
  /** Re-run one check's Actions run (its failed jobs, when it failed). */
  onRerunCheck?: (check: PrCheck) => void;
  onFix?: () => void;
  onOpenLog?: (check: PrCheck) => void;
  /** The URL of the check whose log is open in a centre tab. */
  viewing?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const check = pr.checks.find((c, index) => checkKey(c, index) === selected);
  const runs = actionsRuns(pr);
  const failedRuns = actionsRuns(pr, true);
  const running = pr.checks.some((c) => RUNNING_CHECKS.includes(c.state));
  const actionsRunning = pr.checks.some((c) => c.actions && RUNNING_CHECKS.includes(c.state));
  // GitHub re-runs only a finished run: a row waits for its own run, not every run on the PR.
  const runRunning = (runId: number) => pr.checks.some((c) => c.actions?.runId === runId && RUNNING_CHECKS.includes(c.state));
  const now = useNow(running);
  if (!pr.checks.length) return null;
  const counts = checkCounts(pr.checks);
  const canRerun = runs.length > 0 && source.canWrite && !!source.rerunCheck && !!source.checkAuthority;
  const canFix = !!onFix && failedRuns.length > 0 && source.canWrite;
  const extra = [counts.running && `${counts.running} running`, counts.skipped && `${counts.skipped} skipped`].filter(Boolean).join(" · ");
  const failing = counts.failed > 0;
  return <div className="flex min-w-0 flex-col" data-testid="pr-checks">
    {failing ? (
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-destructive/5 px-3 py-1.5" data-testid="checks-failed-band">
        <span className="text-[13px] font-medium text-destructive">{counts.failed} of {counts.total} checks failed</span>
        {extra && <span className="text-xs text-faint">· {extra}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {canRerun && <Button size="sm" variant="outline" disabled={disabled || !failedRuns.some((c) => !runRunning(c.actions!.runId))} onClick={() => onRerun(true)}><RotateCcw />Re-run failed</Button>}
          {canFix && <Button size="sm" disabled={disabled || fixBusy} onClick={onFix} title="Send failed check logs to the active agent tab">{fixBusy ? <Loader2 className="animate-spin" /> : <Wrench />}Fix errors</Button>}
        </span>
      </div>
    ) : showSummary && (
      <div className="flex min-h-9 items-center gap-2 px-3 pt-2" data-testid="checks-heading">
        <h4 className="text-xs font-medium uppercase tracking-[.08em] text-faint">Checks</h4>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{checkSummary(pr.checks)}</span>
        {canRerun && <Button size="sm" variant="ghost" className="ml-auto" disabled={disabled || actionsRunning} onClick={() => onRerun(false)}>Re-run</Button>}
      </div>
    )}
    <ul className={cn("flex min-w-0 flex-col", failing ? "" : "pb-1")} aria-label="Checks">
      {pr.checks.map((c, index) => {
        const key = checkKey(c, index);
        const required = isRequiredCheck(pr, c.name);
        const failed = isFailingCheck(c);
        const finished = !RUNNING_CHECKS.includes(c.state);
        const hasLog = !!(c.actions && c.url && source.checkLog);
        const inCentre = !!(viewing && c.url && viewing === c.url);
        const inline = selected === key;
        const openLog = () => onOpenLog ? onOpenLog(c) : setSelected(inline ? null : key);
        const logButton = hasLog && finished && <Button size="sm" variant="ghost" className={cn("h-6 px-1.5", !failed && "opacity-0 group-hover/check:opacity-100 focus-visible:opacity-100")} aria-label={`View logs for ${c.name}`} aria-expanded={onOpenLog ? undefined : inline} onClick={openLog}>Logs</Button>;
        const external = !hasLog && webUrl(c.url) && <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover/check:opacity-100 focus-visible:opacity-100" onClick={() => void openExternalWebUrl(webUrl(c.url)!)} aria-label={`Open on GitHub: ${c.name}`} title="Open on GitHub"><ExternalLink /></Button>;
        if (!failing) return <li key={key} className={cn("group/check flex min-h-8 min-w-0 items-center gap-2 px-3 text-[13px]", inCentre && "bg-veil-strong")} aria-label={`${c.name}: ${c.state}`}>
          <CheckIcon state={c.state} />
          <CheckName check={c} />
          {required && <RequiredChip />}
          <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-faint">{inCentre ? <span className="text-accent">Viewing log</span> : checkTime(c, now)}</span>
          {!inCentre && logButton}
          {external}
        </li>;
        return <li key={key} className={cn("group/check flex min-h-12 min-w-0 items-center gap-2.5 border-b border-hairline px-3 py-1.5", inCentre && "bg-veil-strong")} aria-label={`${c.name}: ${c.state}`}>
          <CheckIcon state={c.state} large />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-center gap-1.5 text-[13px]"><CheckName check={c} />{required && <RequiredChip />}</div>
            <div className="truncate text-xs text-faint" title={c.summary ?? undefined}>{checkLine(c, now)}</div>
          </div>
          <span className="flex shrink-0 items-center gap-0.5">
            {inCentre ? <span className="text-xs text-accent">Viewing log</span> : logButton}
            {failed && canRerun && c.actions && c.url && onRerunCheck && <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={disabled || runRunning(c.actions.runId)} aria-label={`Re-run ${c.name}`} title="Re-run this check's failed jobs" onClick={() => onRerunCheck(c)}>Re-run</Button>}
            {external}
          </span>
        </li>;
      })}
    </ul>
    {check?.actions && check.url && source.checkLog && <div className="px-3"><CheckLogView key={`${pr.url}:${selected}:${check.state}`} pr={pr} check={check} source={source} onClose={() => setSelected(null)} /></div>}
  </div>;
}

/** Only a check the merge needs is marked; an optional one carries nothing. */
function RequiredChip() {
  return <span className="shrink-0 rounded border border-hairline px-1 text-xs leading-4 text-muted-foreground">required</span>;
}

/** A check's name: a link to its run when GitHub gave one. */
function CheckName({ check }: { check: PrCheck }) {
  const url = webUrl(check.url);
  const className = "min-w-0 truncate text-left text-foreground";
  return url
    ? <button type="button" onClick={() => void openExternalWebUrl(url)} className={cn(className, "hover:underline")} title={`${check.name}: ${check.state}`}>{check.name}</button>
    : <span className={className} title={`${check.name}: ${check.state}`}>{check.name}</span>;
}

/**
 * One check: its state's glyph, its name, a link to its run when GitHub gave
 * one, and the line GitHub carries with it. What follows is the list's own.
 * The pull request panel and the pipeline panel both list checks with it.
 */
function CheckRow({ check, emphasis, className, children }: { check: PrCheck; emphasis?: boolean; className?: string; children?: ReactNode }) {
  const url = webUrl(check.url);
  // The name keeps its room; GitHub's line gives way first, then the name is cut.
  const name = cn("max-w-full shrink-0 truncate text-left", emphasis ? "text-foreground" : "text-muted-foreground");
  return <div aria-label={`${check.name}: ${check.state}`} className={cn("flex min-w-0 items-center gap-2 text-xs", className)}>
    <CheckIcon state={check.state} />
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      {url ? <button type="button" onClick={() => void openExternalWebUrl(url)} className={cn(name, "hover:underline")} title={`${check.name}: ${check.state}`}>{check.name}</button> : <span className={name} title={`${check.name}: ${check.state}`}>{check.name}</span>}
      {check.summary && <span className="min-w-0 truncate text-[11px] text-faint" title={check.summary}>{check.summary}</span>}
    </span>
    {children}
  </div>;
}

/** A check's state and how long it has been in it, then the way to its run. */
function TimedCheckRow({ check, now }: { check: PrCheck; now: number }) {
  const url = webUrl(check.url);
  const minutes = checkMinutes(check, now);
  return <CheckRow check={check} emphasis className="px-3 py-2">
    <span className={cn("w-16 shrink-0", checkBucket(check.state) === "failed" ? "text-destructive" : "text-muted-foreground")}>{checkStateLabel(check.state)}</span>
    <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{minutes == null ? "" : minutesLabel(minutes)}</span>
    {url
      ? <button type="button" onClick={() => void openExternalWebUrl(url)} aria-label={`Open the run: ${check.name}`} title="Open the run" className="shrink-0 text-faint hover:text-foreground"><ArrowUpRight className="size-3.5" /></button>
      : <span className="w-3.5 shrink-0" aria-hidden />}
  </CheckRow>;
}

/**
 * The checks an issue pipeline's merge waits on or stopped on (#881): one row
 * per required check with its state, time and run, the optional ones folded
 * away, and how long the wait has gone on against when it asks for a person.
 */
export function PipelineCheckList({ view, now }: { view: PipelineChecksView; now: number }) {
  const [optionalOpen, setOptionalOpen] = useState(false);
  const failed = view.outcome === "failed";
  const progress = failed || view.outcome === "stalled" ? 1 : view.waitedMinutes == null ? 0 : Math.min(1, view.waitedMinutes / view.limitMinutes);
  const clock = view.waitedMinutes == null ? null : view.outcome === "waiting" ? `Waiting ${minutesLabel(view.waitedMinutes)} · asks you at ${view.limitMinutes} min` : `Waited ${minutesLabel(view.waitedMinutes)}`;
  return <section aria-label="Required checks" data-testid="pipeline-checks" className="min-w-0 overflow-hidden rounded-lg bg-well">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pt-2.5">
      <span className="text-xs font-medium">Required checks</span>
      <span className="font-mono text-[11px] text-faint">{view.commit.slice(0, 7)}</span>
      {clock && <span data-testid="pipeline-checks-clock" className="ml-auto text-[11px] text-muted-foreground">{clock}</span>}
    </div>
    <div role="progressbar" aria-label="Time waited" aria-valuemin={0} aria-valuemax={view.limitMinutes} aria-valuenow={Math.min(view.waitedMinutes ?? 0, view.limitMinutes)} className="mx-3 mb-2.5 mt-2 h-1 overflow-hidden rounded-full bg-veil-raised">
      <div className={cn("h-full rounded-full", failed ? "bg-destructive" : view.outcome === "stalled" ? "bg-warning" : "bg-info")} style={{ width: `${progress * 100}%` }} />
    </div>
    <ul className="divide-y divide-hairline border-t border-hairline" aria-label="Required">
      {view.required.length === 0 && <li className="px-3 py-2 text-xs text-faint">GitHub has not reported a check on this commit yet.</li>}
      {view.required.map((check, index) => <li key={checkKey(check, index)}><TimedCheckRow check={check} now={now} /></li>)}
    </ul>
    {view.optional.length > 0 && <div className="border-t border-hairline">
      <button type="button" aria-expanded={optionalOpen} onClick={() => setOptionalOpen((open) => !open)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", optionalOpen && "rotate-90")} />
        Optional
        <span className="truncate text-faint">{checkSummary(view.optional)}</span>
      </button>
      {optionalOpen && <ul className="divide-y divide-hairline border-t border-hairline" aria-label="Optional">
        {view.optional.map((check, index) => <li key={checkKey(check, index)}><TimedCheckRow check={check} now={now} /></li>)}
      </ul>}
    </div>}
  </section>;
}

function CheckLogView({ pr, check, source, onClose }: { pr: PullRequest; check: PrCheck; source: GitSource; onClose: () => void }) {
  const [log, setLog] = useState<CheckLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const running = RUNNING_CHECKS.includes(check.state);
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    setLog(null);
    setError(null);
    source.checkLog!(pr.url, check.url!, isFailingCheck(check)).then((log) => {
      if (!cancelled) setLog(log);
    }).catch((error) => { if (!cancelled) setError(source.errorMessage(error)); });
    return () => { cancelled = true; };
  }, [source, pr.url, check.url, check.state, running, tick]);
  const copy = async (text: string, label: string) => {
    setNotice(null);
    setCopyError(null);
    try { await copyText(text); setNotice(`${label} copied`); }
    catch (error) { setCopyError(source.errorMessage(error)); }
  };
  return <section aria-label={`Logs for ${check.name}`} className="my-1 min-w-0 overflow-hidden rounded-md border border-hairline">
    <div className="flex items-center gap-1 bg-well px-2 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate font-medium">{check.name}</span>
      <Button size="sm" variant="ghost" aria-label="Close check log" onClick={onClose}><X className="size-3" /></Button>
    </div>
    <div className="flex flex-wrap gap-1 p-1">
      <Button size="sm" variant="ghost" disabled={!log?.text} onClick={() => void copy(plainLog(log!.text), "Log")}>Copy log</Button>
      <Button size="sm" variant="ghost" onClick={() => void copy(`${check.name}: ${check.state}\nPR: ${pr.url}\nRun: ${check.actions!.runId}${check.actions!.jobId ? ` · Job: ${check.actions!.jobId}` : ""}\n${check.url}`, "Details")}>Copy details</Button>
      <Button size="sm" variant="ghost" onClick={() => void openExternalWebUrl(check.url!)}>Open on GitHub</Button>
    </div>
    {notice && <p role="status" className="px-2 text-xs text-faint">{notice}</p>}
    {copyError && <p role="alert" className="px-2 py-1 text-xs text-destructive">{copyError}</p>}
    {error && <div role="alert" className="px-2 py-1 text-xs text-destructive">{error}<Button size="sm" variant="ghost" onClick={() => setTick((n) => n + 1)}>Retry</Button></div>}
    {running ? <p className="p-2 text-xs text-faint">Check is running. Logs will be available when it finishes.</p> : !log && !error ? <p role="status" className="p-2 text-xs text-faint">Loading check log…</p> : log && <>
      {log.truncated && <p className="px-2 py-1 text-xs text-faint">Showing the last 256 KiB. Open on GitHub for the full log.</p>}
      {log.text ? <AnsiLog text={log.text} /> : <p className="p-2 text-xs text-faint">No log output is available for this check. Open on GitHub for details.</p>}
    </>}
  </section>;
}

/** Running is an amber spinner, skipped a struck-through circle (PRO-394). */
function CheckIcon({ state, large = false }: { state: string; large?: boolean }) {
  const bucket = checkBucket(state);
  const size = large ? "size-[15px] shrink-0" : "size-3.5 shrink-0";
  if (bucket === "running") return <LoaderCircle className={cn(size, "animate-spin text-warning")} aria-label="Running" />;
  if (bucket === "passed") return <CircleCheck className={cn(size, "text-add")} aria-label="Passed" />;
  if (bucket === "skipped") return <CircleMinus className={cn(size, "text-faint")} aria-label="Skipped" />;
  if (bucket === "failed") return <CircleX className={cn(size, "text-destructive")} aria-label="Failed" />;
  return <CircleAlert className={cn(size, "text-faint")} aria-label="Unknown" />;
}

export { webUrl };

export function Deployments({ pr }: { pr: PullRequest }) {
  if (!pr.deployments?.length) return null;
  return <section aria-label="Deployments" className="mt-2 flex flex-col gap-1">
    <h4 className="text-xs font-medium uppercase tracking-[.08em] text-faint">Deployments</h4>
    {pr.deployments.map((deployment, index) => {
      const url = webUrl(deployment.url);
      return <div key={`${deployment.name}:${index}`} className="flex min-w-0 items-center gap-2 text-xs">
        <CheckIcon state={deployment.state} />
        <span className="truncate text-muted-foreground">{deployment.name}</span>
        {url && <button type="button" onClick={() => void openExternalWebUrl(url)} title={url} className="min-w-0 truncate text-faint hover:underline">{url}</button>}
      </div>;
    })}
  </section>;
}

const threadLine = (thread: ReviewThread) => {
  const line = thread.isOutdated || thread.line == null ? thread.originalLine : thread.line;
  return `${thread.path.split("/").pop()}${line == null ? "" : `:${line}`}`;
};
const threadSnippet = (thread: ReviewThread) => thread.comments[0]?.body.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

/**
 * The PR's review threads in the Checks section (PRO-234, design 05.14): open
 * and resolved counts, every open one into the chat at once, and a row per
 * thread that opens its place in the Changes diff.
 */
export function ReviewThreadList({ workspace, view }: { workspace: string; view: ThreadView }) {
  const [notice, setNotice] = useState<string | null>(null);
  const threads = view.snapshot?.threads ?? [];
  const counts = threadCounts(threads);
  const open = threads.filter((thread) => !thread.isResolved);
  const tabId = view.pr.tabId;
  // None to show: the REVIEW summary already says "0 unresolved" (design 05.08), so no empty row here.
  if (!view.error && !notice && threads.length === 0 && (view.snapshot || !view.loading)) return null;
  return <section aria-label="Review threads" data-testid="review-threads" className="mt-1 flex min-w-0 flex-col gap-1 text-xs">
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <h4 className="shrink-0 text-xs font-medium text-muted-foreground">Review threads</h4>
      {view.snapshot && <span data-testid="review-thread-counts" className="min-w-0 text-xs text-faint">{counts.open} open · {counts.resolved} resolved</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {view.pr.state === "OPEN" && counts.open > 0 && <Button size="sm" variant="secondary" disabled={!tabId} title={tabId ? undefined : "Open an agent tab to add threads to its chat"} onClick={() => {
          const { added, omitted } = addThreadsToChat(tabId!, open, view.pr.url);
          setNotice(omitted
            ? `Added the first ${added} of ${open.length} open threads to the chat draft. Add the rest once these are done.`
            : `Added ${added} open ${added === 1 ? "thread" : "threads"} to the chat draft.`);
        }}>Add all {counts.open} to chat</Button>}
        <Button size="icon-xs" variant="ghost" aria-label="Refresh threads" title="Refresh threads" disabled={view.loading || !!view.working} onClick={() => void refreshThreads(workspace, view.pr.url, true)}>
          <RefreshCw className={cn(view.loading && "animate-spin")} />
        </Button>
      </span>
    </div>
    {/* Said quietly, like an unreachable GitHub: the checks' own alerts and notices stay the ones read out. */}
    {view.loading && !view.snapshot && <p className="text-xs text-faint">Loading review threads…</p>}
    {view.error && <p data-testid="review-threads-error" className="break-words text-xs text-destructive">Could not refresh review threads: {view.error}</p>}
    {threads.length > 0 && <ul className="flex min-w-0 flex-col" aria-label="Threads">
      {threads.map((thread) => <li key={thread.id} className="min-w-0">
        <button type="button" aria-label={`Go to review thread ${githubReviewLocation(thread)}`} title={thread.path}
          onClick={() => { setNotice(null); void requestThreadJump(workspace, thread).then((shown) => { if (!shown) setNotice(`${thread.path} is not in the Changes diff.`); }); }}
          className="flex w-full min-w-0 items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-veil">
          <span aria-hidden className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-veil-strong text-[9px] font-semibold text-muted-foreground">{threadInitials(githubAuthorName(thread.comments[0]))}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("min-w-0 truncate font-mono text-xs", thread.isResolved ? "text-faint" : "text-foreground")}>{threadLine(thread)}</span>
              {thread.isResolved && <span className="shrink-0 text-xs text-add">Resolved</span>}
              {thread.isOutdated && <span className="shrink-0 text-xs text-warning">Outdated</span>}
            </span>
            <span className="min-w-0 truncate text-xs text-faint">{threadSnippet(thread)}</span>
          </span>
        </button>
      </li>)}
    </ul>}
    {notice && <p aria-live="polite" className="text-xs text-muted-foreground">{notice}</p>}
  </section>;
}
