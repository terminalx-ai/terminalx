import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { openExternalWebUrl } from "@/lib/externalUrl";
import { CircleCheck, CircleX, Copy, ExternalLink, Loader2, RotateCcw, Search, Wrench } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { CheckLog } from "@/lib/api";
import { checkBucket, checkDurationMs, checkStateLabel, durationLabel, isFailingCheck } from "@/lib/checks";
import { showRerunFailed } from "@/lib/checkToasts";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { CheckLogEditorEntry } from "@/lib/editors";
import { requestFixErrors } from "@/lib/fixCheckErrors";
import { localGitSource } from "@/lib/gitSource";
import { useShortcutKeycaps } from "@/lib/hotkeys";
import { bindingText, joinKeycaps } from "@/lib/shortcuts";
import { ansiSpans, plainLog } from "./AnsiLog";
import { webUrl } from "./PrChecks";

/** One line of `gh run view --log`: the step it belongs to and its text, without the job and timestamp columns. */
export interface LogLine { step: string | null; text: string }

/**
 * `gh run view --log` prefixes every line with its job and step, tab
 * separated, then GitHub's timestamp. The viewer shows the text; the step is
 * kept to say which step failed. Lines without the columns are kept whole.
 */
export function parseRunLog(text: string): LogLine[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((line) => {
    const columns = line.split("\t");
    if (columns.length < 3) return { step: null, text: line };
    const rest = columns.slice(2).join("\t");
    return { step: columns[1] || null, text: rest.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, "") };
  });
}

/** The steps a log covers, in the order they ran. */
export function logSteps(lines: LogLine[]): string[] {
  const steps: string[] = [];
  for (const line of lines) if (line.step && !steps.includes(line.step)) steps.push(line.step);
  return steps;
}

/** The hand-off bar's sentence: what Fix errors sends and how much. */
export function handOffText(failures: number): string {
  const what = failures === 1 ? "the failure" : failures === 2 ? "both failures" : `all ${failures} failures`;
  return `Send ${what} to the agent. The logs go in as one attachment, trimmed to 256 KB.`;
}

/**
 * A check's log in a centre tab (PRO-394, design 05.09): the check, its run
 * and job, Copy log, Re-run job and the run on GitHub; Failed steps or the
 * Full log with Find in log; the log; and a bar that hands the failures to
 * the agent with Fix errors. The Checks tab marks the check while it is shown.
 */
export function CheckLogTab({ entry, visible }: { entry: CheckLogEditorEntry; visible: boolean }) {
  const { check } = entry;
  const source = useMemo(() => localGitSource(entry.root), [entry.root]);
  const failed = isFailingCheck(check);
  const [mode, setMode] = useState<"failed" | "full">(failed ? "failed" : "full");
  const [logs, setLogs] = useState<Partial<Record<"failed" | "full", CheckLog>>>({});
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const find = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const keycaps = useShortcutKeycaps();
  const running = checkBucket(check.state) === "running";
  const log = logs[mode];

  useEffect(() => {
    if (!visible || running || logs[mode]) return;
    let cancelled = false;
    setError(null);
    source.checkLog!(check.prUrl, check.url, mode === "failed").then((read) => {
      if (!cancelled) setLogs((old) => ({ ...old, [mode]: read }));
    }, (reason) => { if (!cancelled) setError(source.errorMessage(reason)); });
    return () => { cancelled = true; };
    // `logs` is what was read; asking again is `tick`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, check.prUrl, check.url, mode, visible, running, tick]);

  const lines = useMemo(() => log ? parseRunLog(log.text) : [], [log]);
  const steps = useMemo(() => logSteps(lines), [lines]);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => needle ? lines.flatMap((line, index) => plainLog(line.text).toLowerCase().includes(needle) ? [index] : []) : [], [lines, needle]);
  useEffect(() => { setMatch(0); }, [needle, mode]);
  useEffect(() => {
    if (!matches.length) return;
    body.current?.querySelector(`[data-line="${matches[Math.min(match, matches.length - 1)]}"]`)?.scrollIntoView({ block: "center" });
  }, [match, matches]);

  const ms = checkDurationMs(check, Date.now());
  const said = [
    `${checkStateLabel(check.state)}${ms == null ? "" : checkBucket(check.state) === "failed" ? ` after ${durationLabel(ms)}` : checkBucket(check.state) === "passed" ? ` in ${durationLabel(ms)}` : ""}`,
    `run ${check.runId}`,
    check.jobId != null && `job ${check.jobId}`,
  ].filter(Boolean).join(" · ");
  const runUrl = webUrl(check.url);

  const copy = async () => {
    if (!log) return;
    try { await copyText(plainLog(log.text)); setNotice("Log copied"); }
    catch (reason) { setNotice(`Couldn't copy the log: ${source.errorMessage(reason)}`); }
  };
  const rerun = async () => {
    if (!source.rerunCheck || !source.checkAuthority || rerunning) return;
    setRerunning(true);
    setNotice(null);
    try {
      await source.rerunCheck(check.prUrl, check.url, failed, await source.checkAuthority());
      setNotice(failed ? "Re-run requested for this run's failed jobs." : "Re-run requested.");
    } catch (reason) {
      showRerunFailed({ prNumber: check.prNumber, error: source.errorMessage(reason), runUrl });
    } finally { setRerunning(false); }
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      find.current?.focus();
      find.current?.select();
    }
  };
  const stepLabel = mode === "failed" && steps.length
    ? steps.length === 1 ? `Step · ${steps[0]}` : `${steps.length} steps · ${steps.join(", ")}`
    : steps.length ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}` : "";

  return <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} data-testid="check-log-tab" aria-label={`Log for ${check.name}`}>
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
      {failed ? <CircleX className="size-3.5 shrink-0 text-destructive" aria-hidden /> : <CircleCheck className="size-3.5 shrink-0 text-add" aria-hidden />}
      <span className="min-w-0 truncate text-[13px] font-medium">{check.name}</span>
      <span className="min-w-0 truncate text-xs text-faint" data-testid="check-log-details">{said}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={!log?.text} onClick={() => void copy()}><Copy />Copy log</Button>
        {source.rerunCheck && <Button size="sm" variant="outline" disabled={rerunning || running} onClick={() => void rerun()} title={failed ? "Re-run this run's failed jobs" : "Re-run this run"}>
          {rerunning ? <Loader2 className="animate-spin" /> : <RotateCcw />}Re-run job
        </Button>}
        {runUrl && <WithTooltip label="Open on GitHub"><Button size="icon-sm" variant="ghost" aria-label="Open on GitHub" onClick={() => void openExternalWebUrl(runUrl)}><ExternalLink /></Button></WithTooltip>}
      </span>
    </div>
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3 text-xs text-muted-foreground">
      <div role="radiogroup" aria-label="Log shown" className="flex items-center rounded-md border border-border p-0.5">
        {failed && <Segment selected={mode === "failed"} onSelect={() => setMode("failed")}>Failed steps</Segment>}
        <Segment selected={mode === "full"} onSelect={() => setMode("full")}>Full log</Segment>
      </div>
      {stepLabel && <span className="min-w-0 truncate text-faint" title={stepLabel} data-testid="check-log-step">{stepLabel}</span>}
      <label className="ml-auto flex h-7 w-[200px] shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-faint focus-within:border-ring">
        <Search className="size-3 shrink-0" aria-hidden />
        <input ref={find} value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} placeholder="Find in log" aria-label="Find in log"
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches.length) { event.preventDefault(); setMatch((n) => (n + (event.shiftKey ? matches.length - 1 : 1)) % matches.length); }
            if (event.key === "Escape") setQuery("");
          }}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-faint" />
        {needle ? <span className="shrink-0 tabular-nums" aria-live="polite">{matches.length ? `${Math.min(match, matches.length - 1) + 1}/${matches.length}` : "0"}</span>
          : <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10.5px] leading-4">{bindingText("mod+f")}</kbd>}
      </label>
    </div>
    {notice && <p role="status" className="shrink-0 border-b border-hairline px-3 py-1.5 text-xs text-muted-foreground">{notice}</p>}
    <div ref={body} className="min-h-0 flex-1 overflow-auto bg-[#0e0f11] scrollbar-thin" data-testid="check-log-body">
      {running ? <p className="p-3 text-xs text-[#9a9ca3]">This check is still running. Its log shows here once it finishes.</p>
        : error ? <div role="alert" className="flex items-center gap-2 p-3 text-xs text-destructive">{error}<Button size="sm" variant="ghost" onClick={() => setTick((n) => n + 1)}>Retry</Button></div>
        : !log ? <p role="status" className="p-3 text-xs text-[#9a9ca3]">Loading the log…</p>
        : !log.text ? <p className="p-3 text-xs text-[#9a9ca3]">GitHub has no log output for this check. Open it on GitHub for details.</p>
        : <>
          {log.truncated && <p className="px-3 pt-2 text-xs text-[#9a9ca3]">Showing the last 256 KB. Open on GitHub for the whole log.</p>}
          <pre tabIndex={0} aria-label="Check log" className="p-3 font-mono text-xs leading-[19px] whitespace-pre text-[#cfccc8] select-text">
            {lines.map((line, index) => <div key={index} data-line={index} className={cn(matches[Math.min(match, matches.length - 1)] === index && "bg-warning/15")}>
              <LogText text={line.text} needle={needle} />{"\n"}
            </div>)}
          </pre>
        </>}
    </div>
    {failed && <div className="flex min-h-14 shrink-0 items-center gap-3 border-t border-hairline bg-well px-4 py-2" data-testid="check-log-handoff">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{handOffText(Math.max(1, entry.failures))}</p>
      <Button size="sm" onClick={() => requestFixErrors(entry.sessionId, check.prUrl)}>
        <Wrench />Fix errors<kbd className="ml-1 font-mono text-[10.5px] opacity-70">{joinKeycaps(keycaps("session.fixErrors"))}</kbd>
      </Button>
    </div>}
  </div>;
}

function Segment({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: ReactNode }) {
  return <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
    className={cn("flex h-6 items-center rounded-[5px] px-2 text-xs whitespace-nowrap", selected ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:text-foreground")}>{children}</button>;
}

/** A log line in its terminal colours, with what Find in log looks for marked. */
function LogText({ text, needle }: { text: string; needle: string }) {
  const spans = useMemo(() => ansiSpans(text), [text]);
  // GitHub's own markers: a group's title faint, an error red.
  const marker: CSSProperties | undefined = /^##\[error\]/.test(text) ? { color: "var(--color-destructive, #fa686a)" } : /^##\[(group|endgroup)\]/.test(text) ? { opacity: 0.6 } : undefined;
  return <span style={marker}>{spans.map((span, i) => <span key={i} style={span.style}>{needle ? highlight(span.text, needle) : span.text}</span>)}</span>;
}

function highlight(text: string, needle: string): ReactNode {
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    parts.push(text.slice(from, at), <mark key={at} className="rounded-[2px] bg-warning/40 text-inherit">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}
