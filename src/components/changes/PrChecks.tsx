import { type ReactNode, useEffect, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, CircleAlert, CircleDot, CircleX, ExternalLink, Loader2, X } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CheckLog, PrCheck, PullRequest } from "@/lib/api";
import type { GitSource } from "@/lib/gitSource";
import { actionsRuns, checkBucket, checkMinutes, checkStateLabel, checkSummary, isFailingCheck, minutesLabel, RUNNING_CHECKS } from "@/lib/checks";
import type { PipelineChecksView } from "@/lib/issuePipeline";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { AnsiLog, plainLog } from "./AnsiLog";

const checkKey = (check: PrCheck, index: number) => `${check.name}\0${check.url ?? ""}\0${index}`;

export function PrChecks({ pr, source, disabled, fixBusy, onRerun, onFix, showSummary = true }: {
  pr: PullRequest;
  source: GitSource;
  disabled: boolean;
  fixBusy?: boolean;
  showSummary?: boolean;
  onRerun: (failedOnly: boolean) => void;
  onFix?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const check = pr.checks.find((c, index) => checkKey(c, index) === selected);
  const runs = actionsRuns(pr);
  const failedRuns = actionsRuns(pr, true);
  const running = pr.checks.some((c) => c.actions && RUNNING_CHECKS.includes(c.state));
  if (!pr.checks.length) return null;
  return <div className="flex min-w-0 flex-col gap-1">
    {showSummary && <p className="mb-1 text-[11px] text-muted-foreground">{checkSummary(pr.checks)}</p>}
    {runs.length > 0 && source.canWrite && <div className="flex flex-wrap gap-1 py-1">
      {onFix && failedRuns.length > 0 && <Button size="xs" disabled={disabled || fixBusy} onClick={onFix} title="Send failed check logs to the active agent tab">{fixBusy && <Loader2 className="animate-spin" />}Fix errors</Button>}
      {source.rerunCheck && source.checkAuthority && <>
        <Button size="xs" variant="outline" disabled={disabled || running || !failedRuns.length} onClick={() => onRerun(true)}>Re-run failed</Button>
        <Button size="xs" variant="ghost" disabled={disabled || running} onClick={() => onRerun(false)}>Re-run all</Button>
      </>}
    </div>}
    {pr.checks.map((c, index) => {
      const requirement = pr.requiredChecks == null ? "Requirement unknown" : pr.requiredChecks.includes(c.name) ? "Required" : "Optional";
      return <CheckRow key={checkKey(c, index)} check={c}>
        <span className="shrink-0 text-[10px] text-faint">{requirement}</span>
        {c.actions && c.url && source.checkLog ? <Button size="xs" variant="ghost" disabled={RUNNING_CHECKS.includes(c.state)} aria-label={`View logs for ${c.name}`} aria-expanded={selected === checkKey(c, index)} onClick={() => setSelected(selected === checkKey(c, index) ? null : checkKey(c, index))}>Logs</Button> : <Button size="xs" variant="ghost" onClick={() => void openUrl(pr.url + "/checks")} aria-label={`Open on GitHub: ${c.name}`} title="Open on GitHub"><ExternalLink className="size-3" /></Button>}
      </CheckRow>;
    })}
    {check?.actions && check.url && source.checkLog && <CheckLogView key={`${pr.url}:${selected}:${check.state}`} pr={pr} check={check} source={source} onClose={() => setSelected(null)} />}
  </div>;
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
      {url ? <button type="button" onClick={() => void openUrl(url)} className={cn(name, "hover:underline")} title={`${check.name}: ${check.state}`}>{check.name}</button> : <span className={name} title={`${check.name}: ${check.state}`}>{check.name}</span>}
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
      ? <button type="button" onClick={() => void openUrl(url)} aria-label={`Open the run: ${check.name}`} title="Open the run" className="shrink-0 text-faint hover:text-foreground"><ArrowUpRight className="size-3.5" /></button>
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
      <Button size="xs" variant="ghost" aria-label="Close check log" onClick={onClose}><X className="size-3" /></Button>
    </div>
    <div className="flex flex-wrap gap-1 p-1">
      <Button size="xs" variant="ghost" disabled={!log?.text} onClick={() => void copy(plainLog(log!.text), "Log")}>Copy log</Button>
      <Button size="xs" variant="ghost" onClick={() => void copy(`${check.name}: ${check.state}\nPR: ${pr.url}\nRun: ${check.actions!.runId}${check.actions!.jobId ? ` · Job: ${check.actions!.jobId}` : ""}\n${check.url}`, "Details")}>Copy details</Button>
      <Button size="xs" variant="ghost" onClick={() => void openUrl(check.url!)}>Open on GitHub</Button>
    </div>
    {notice && <p role="status" className="px-2 text-[11px] text-faint">{notice}</p>}
    {copyError && <p role="alert" className="px-2 py-1 text-xs text-destructive">{copyError}</p>}
    {error && <div role="alert" className="px-2 py-1 text-xs text-destructive">{error}<Button size="xs" variant="ghost" onClick={() => setTick((n) => n + 1)}>Retry</Button></div>}
    {running ? <p className="p-2 text-xs text-faint">Check is running. Logs will be available when it finishes.</p> : !log && !error ? <p role="status" className="p-2 text-xs text-faint">Loading check log…</p> : log && <>
      {log.truncated && <p className="px-2 py-1 text-[11px] text-faint">Showing the last 256 KiB. Open on GitHub for the full log.</p>}
      {log.text ? <AnsiLog text={log.text} /> : <p className="p-2 text-xs text-faint">No log output is available for this check. Open on GitHub for details.</p>}
    </>}
  </section>;
}

function CheckIcon({ state }: { state: string }) {
  const bucket = checkBucket(state);
  if (bucket === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  if (bucket === "passed") return <Check className="size-3.5 shrink-0 text-add" />;
  if (bucket === "skipped") return <CircleDot className="size-3.5 shrink-0 text-faint" />;
  if (bucket === "failed") return <CircleX className="size-3.5 shrink-0 text-destructive" />;
  return <CircleAlert className="size-3.5 shrink-0 text-faint" />;
}

/** Provider URLs are untrusted data; only web links may leave the app. */
export function webUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function Deployments({ pr }: { pr: PullRequest }) {
  if (!pr.deployments?.length) return null;
  return <section aria-label="Deployments" className="mt-2 flex flex-col gap-1">
    <h4 className="text-[11px] font-medium text-muted-foreground">Deployments</h4>
    {pr.deployments.map((deployment, index) => {
      const url = webUrl(deployment.url);
      return <div key={`${deployment.name}:${index}`} className="flex min-w-0 items-center gap-2 text-xs">
        <CheckIcon state={deployment.state} />
        <span className="truncate text-muted-foreground">{deployment.name}</span>
        {url && <button type="button" onClick={() => void openUrl(url)} title={url} className="min-w-0 truncate text-faint hover:underline">{url}</button>}
      </div>;
    })}
  </section>;
}
