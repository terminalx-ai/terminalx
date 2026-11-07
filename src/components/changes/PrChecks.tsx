import { useEffect, useState } from "react";
import { Check, CircleAlert, CircleDot, ExternalLink, Loader2, X } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CheckLog, PrCheck, PullRequest } from "@/lib/api";
import type { GitSource } from "@/lib/gitSource";
import { actionsRuns, checkBucket, checkSummary, isFailingCheck, RUNNING_CHECKS } from "@/lib/checks";
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
      {source.rerunCheck && <>
        <Button size="xs" variant="outline" disabled={disabled || running || !failedRuns.length} onClick={() => onRerun(true)}>Re-run failed</Button>
        <Button size="xs" variant="ghost" disabled={disabled || running} onClick={() => onRerun(false)}>Re-run all</Button>
      </>}
    </div>}
    {pr.checks.map((c, index) => {
      const requirement = pr.requiredChecks == null ? "Requirement unknown" : pr.requiredChecks.includes(c.name) ? "Required" : "Optional";
      const url = webUrl(c.url);
      return <div key={checkKey(c, index)} aria-label={`${c.name}: ${c.state}`} className="flex min-w-0 items-center gap-2 text-xs">
        <CheckIcon state={c.state} />
        {url ? <button type="button" onClick={() => void openUrl(url)} className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:underline" title={`${c.name}: ${c.state}`}>{c.name}</button> : <span className="min-w-0 flex-1 truncate text-muted-foreground" title={`${c.name}: ${c.state}`}>{c.name}</span>}
        <span className="shrink-0 text-[10px] text-faint">{requirement}</span>
        {c.actions && c.url && source.checkLog ? <Button size="xs" variant="ghost" disabled={RUNNING_CHECKS.includes(c.state)} aria-label={`View logs for ${c.name}`} aria-expanded={selected === checkKey(c, index)} onClick={() => setSelected(selected === checkKey(c, index) ? null : checkKey(c, index))}>Logs</Button> : <Button size="xs" variant="ghost" onClick={() => void openUrl(pr.url + "/checks")} aria-label={`Open on GitHub: ${c.name}`} title="Open on GitHub"><ExternalLink className="size-3" /></Button>}
      </div>;
    })}
    {check?.actions && check.url && source.checkLog && <CheckLogView key={`${pr.url}:${selected}:${check.state}`} pr={pr} check={check} source={source} onClose={() => setSelected(null)} />}
  </div>;
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
  return <CircleAlert className={cn("size-3.5 shrink-0", bucket === "failed" ? "text-destructive" : "text-faint")} />;
}

/** Provider URLs are untrusted data; only web links may leave the app. */
function webUrl(value?: string | null): string | null {
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
