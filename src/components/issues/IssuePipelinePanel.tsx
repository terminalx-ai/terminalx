import { setCloudPipelineResolveConflicts } from "@/lib/cloudPipelines";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, CircleAlert, Cloud, ExternalLink, GitMerge, GitPullRequest, Loader2, MessageSquare, Pause } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { findCloudWorkspace, useCloudCatalog } from "@/lib/cloudCatalog";
import { openCloudSession } from "@/lib/cloudDashboard";
import { lookAtCloudPipeline } from "@/lib/cloudPipelines";
import { actOnAnyPipeline, actOnPipeline, countOf, pipelineActions, pipelineHeadline, pipelineSettings, pipelineSteps, setPipelineAutoMerge, setPipelineResolveConflicts, type PipelineStep, type PipelineTone } from "@/lib/issuePipeline";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import type { FindingSeverity, IssuePipeline, PipelineAction, PipelineFinding } from "@/types/issuePipeline";

const TONE_DOT: Record<PipelineTone, string> = {
  add: "bg-add",
  warning: "bg-warning",
  info: "bg-info animate-pulse-soft",
  merged: "bg-merged",
  faint: "bg-faint",
};

const TONE_TEXT: Record<PipelineTone, string> = {
  add: "text-add",
  warning: "text-warning",
  info: "text-foreground",
  merged: "text-merged",
  faint: "text-muted-foreground",
};

/** Where a pipeline stands: a dot in the state's colour and two or three words, small enough for a header or a list row. */
export function PipelineStatus({
  pipeline,
  className,
  dotClassName,
  labelClassName,
  lead,
}: {
  pipeline: IssuePipeline;
  className?: string;
  dotClassName?: string;
  /** The words as one label, so a tight header can cut them with an ellipsis while the dot stays. */
  labelClassName?: string;
  /** Words before the status inside that label, such as the session's part in the pipeline. */
  lead?: ReactNode;
}) {
  const headline = pipelineHeadline(pipeline);
  return (
    <span className={cn("flex items-center gap-1.5 text-[11px] font-medium", TONE_TEXT[headline.tone], className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[headline.tone], dotClassName)} />
      <span className={labelClassName}>
        {lead}
        {headline.label}
      </span>
    </span>
  );
}

/** When something was read, as a sentence says it: "a moment ago", "5m ago", "on Oct 12". */
function readWhen(at: number): string {
  const when = relativeTime(new Date(at).toISOString());
  if (when === "now") return "a moment ago";
  return /^\d+[mhd]$/.test(when) ? `${when} ago` : `on ${when}`;
}

function StepGlyph({ status }: { status: PipelineStep["status"] }) {
  if (status === "done") return <Check className="size-3 text-add" aria-label="done" />;
  if (status === "current") return <Loader2 className="size-3 animate-spin text-info" aria-label="in progress" />;
  if (status === "attention") return <CircleAlert className="size-3 text-warning" aria-label="needs you" />;
  if (status === "stopped") return <Pause className="size-3 text-faint" aria-label="stopped" />;
  return <span aria-hidden>·</span>;
}

const SEVERITY_TONE: Record<FindingSeverity, string> = {
  critical: "bg-destructive/15 text-destructive",
  high: "bg-destructive/15 text-destructive",
  medium: "bg-warning/15 text-warning",
  low: "bg-veil-raised text-muted-foreground",
  nit: "bg-veil-raised text-faint",
};

const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "nit"];

function Finding({ finding }: { finding: PipelineFinding }) {
  const place = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : null;
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={cn("mt-px shrink-0 rounded px-1 py-px text-[10px] font-medium uppercase tracking-wide", SEVERITY_TONE[finding.severity])}>
        {finding.severity}
        {finding.security ? " · security" : ""}
      </span>
      <span className="min-w-0">
        <span className="text-foreground">{finding.title}</span>
        {place && <span className="ml-1.5 break-all font-mono text-[11px] text-faint">{place}</span>}
        {finding.detail && <span className="mt-0.5 block whitespace-pre-wrap text-muted-foreground">{finding.detail}</span>}
      </span>
    </li>
  );
}

/**
 * One issue's pipeline on the issue page: the stage it is at and why, the
 * switch that lets it merge by itself, the reviewer's open findings, and the
 * record of everything that happened, with links to the sessions and the
 * pull request. A cloud workspace's pipeline has no switch: it stops at
 * Ready to merge, and Merge here uses the reader's own GitHub sign-in.
 */
export function IssuePipelinePanel({ pipeline }: { pipeline: IssuePipeline }) {
  const store = useSessionStore();
  const catalog = useCloudCatalog();
  const [busy, setBusy] = useState<PipelineAction | "autoMerge" | "resolveConflicts" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);

  const place = pipeline.place ?? null;
  const project = store.projects.find((value) => value.path === pipeline.projectPath) ?? null;
  const settings = pipelineSettings(project);
  const steps = pipelineSteps(pipeline);
  const { primary, secondary } = pipelineActions(pipeline);
  // A cloud workspace's sessions are its runtime's: they open from their keys, listed here or not.
  const hasSession = (id: string | null | undefined) => id != null && (place != null || store.sessions.some((session) => session.id === id));
  const openSession = (id: string, tabId?: string) => (place ? openCloudSession(id, tabId) : selectSession(id));
  const authorHere = hasSession(pipeline.author.sessionId);
  const reviewerHere = pipeline.reviewer != null && hasSession(pipeline.reviewer.sessionId);
  const workspace = place ? findCloudWorkspace(catalog, place.orgId, place.workspaceId)?.workspace ?? null : null;
  const asleep = workspace != null && workspace.state !== "ready";
  const findings = [...(pipeline.verdict?.findings ?? [])].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const done = pipeline.state === "merged";

  const run = useCallback(
    async (what: PipelineAction | "autoMerge" | "resolveConflicts", work: () => Promise<unknown>) => {
      setBusy(what);
      setError(null);
      try {
        await work();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // Opening the issue is a reason to look at its pull request now, rather
  // than at the next pass. A look that fails changes nothing and says nothing.
  const { id, stage, state } = pipeline;
  const watchesPullRequest = stage === "merge" && state !== "merged" && state !== "stopped";
  useEffect(() => {
    // Once per issue opened, not once per change to it. A cloud workspace is asked only while it runs.
    if (watchesPullRequest) void (place ? lookAtCloudPipeline(pipeline) : actOnPipeline(id, "refresh")).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section aria-label="Pipeline" className="flex shrink-0 flex-col gap-2.5 border-b border-hairline px-5 py-3" data-testid="issue-pipeline">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <PipelineStatus pipeline={pipeline} className="text-xs" />
        {pipeline.pr && (
          <button type="button" onClick={() => void openUrl(pipeline.pr!.url)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            {done ? <GitMerge className="size-3 text-merged" /> : <GitPullRequest className="size-3" />}
            Pull request #{pipeline.pr.number}
            <ExternalLink className="size-3" />
          </button>
        )}
        {authorHere && (
          <button type="button" onClick={() => openSession(pipeline.author.sessionId, pipeline.author.tabId)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <MessageSquare className="size-3" /> Author session
          </button>
        )}
        {reviewerHere && (
          <button type="button" onClick={() => openSession(pipeline.reviewer!.sessionId, pipeline.reviewer!.tabId)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <MessageSquare className="size-3" /> Reviewer session
          </button>
        )}
      </div>

      {place && asleep && !done && (
        <p className="flex items-start gap-1.5 text-[11px] text-faint" data-testid="pipeline-asleep">
          <Cloud className="mt-px size-3 shrink-0" />
          <span>
            Its cloud workspace is asleep. This is where it stood when it was last read, {readWhen(place.readAt)}; it goes on when the workspace wakes, and Stop, Resume or a review wakes it now.
          </span>
        </p>
      )}

      {pipeline.note && (
        <p role="status" className={cn("text-xs leading-relaxed", pipeline.state === "needsYou" ? "text-foreground" : "text-muted-foreground")}>
          {pipeline.note}
        </p>
      )}

      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Stages">
        {steps.map((step) => (
          <li
            key={step.stage}
            aria-current={step.status === "current" || step.status === "attention" ? "step" : undefined}
            className={cn("flex items-center gap-1", step.status === "pending" || step.status === "skipped" ? "text-faint" : step.status === "done" ? "text-muted-foreground" : "text-foreground")}
          >
            <span className="inline-flex w-3.5 justify-center">
              <StepGlyph status={step.status} />
            </span>
            {step.label}
            {step.detail && <span className="text-faint">{step.detail}</span>}
          </li>
        ))}
      </ol>

      {!done && place && (
        <p className="rounded-lg bg-well px-3 py-2 text-xs text-muted-foreground" data-testid="pipeline-cloud-merge">
          <span className="block font-medium text-foreground">A person merges this one</span>
          A cloud workspace stops at Ready to merge. Merge here uses your own GitHub sign-in, only at the reviewed commit, with its checks passed and no finding of medium severity or higher open.
        </p>
      )}

      {!done && <label className="flex items-center justify-between gap-3 rounded-lg bg-well px-3 py-2 text-xs">
        <span>Resolve conflicts automatically</span>
        <Switch aria-label="Resolve conflicts automatically" size="sm" checked={pipeline.resolveConflicts ?? false} disabled={busy != null}
          onCheckedChange={(value) => void run("resolveConflicts", () => place ? setCloudPipelineResolveConflicts(pipeline, value) : setPipelineResolveConflicts(pipeline.id, value))} />
      </label>}

      {!done && !place && (
        <label className="flex items-center justify-between gap-3 rounded-lg bg-well px-3 py-2 text-xs">
          <span className="min-w-0">
            <span className="block font-medium">Merge when green</span>
            <span className="text-faint">
              {settings.requirePerson
                ? "This project has a person do the merge, whatever this is set to."
                : "Only at the reviewed commit, with its checks passed and no finding of medium severity or higher open."}
            </span>
          </span>
          <Switch
            aria-label="Merge when green"
            size="sm"
            checked={pipeline.autoMerge}
            disabled={busy != null || settings.requirePerson}
            onCheckedChange={(value) => void run("autoMerge", () => setPipelineAutoMerge(pipeline.id, value))}
          />
        </label>
      )}

      {(primary || secondary.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {primary && (
            <Button
              size="sm"
              variant={primary.action === "merge" ? "default" : "secondary"}
              className={cn(primary.action === "merge" && "bg-merge text-merge-foreground hover:opacity-90")}
              disabled={busy != null}
              onClick={() => void run(primary.action, () => actOnAnyPipeline(pipeline, primary.action))}
            >
              {busy === primary.action ? <Loader2 className="animate-spin" /> : primary.action === "merge" ? <GitMerge /> : null}
              {primary.label}
            </Button>
          )}
          {secondary.map((button) => (
            <Button key={button.action} size="sm" variant="ghost" className="text-xs" disabled={busy != null} onClick={() => void run(button.action, () => actOnAnyPipeline(pipeline, button.action))}>
              {busy === button.action ? <Loader2 className="animate-spin" /> : null}
              {button.label}
            </Button>
          ))}
        </div>
      )}

      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}

      {pipeline.verdict && findings.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-faint">
            {countOf(findings.length, "open finding")} · review {pipeline.verdict.round} of <span className="font-mono normal-case">{pipeline.verdict.commit.slice(0, 7)}</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {findings.map((finding, index) => (
              <Finding key={`${finding.title}:${index}`} finding={finding} />
            ))}
          </ul>
        </div>
      )}

      <div>
        <button type="button" aria-expanded={recordOpen} onClick={() => setRecordOpen((open) => !open)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <ChevronRight className={cn("size-3 transition-transform", recordOpen && "rotate-90")} />
          Record · {pipeline.events.length} {pipeline.events.length === 1 ? "entry" : "entries"}
        </button>
        {recordOpen && (
          <ol className="mt-1.5 flex flex-col gap-1 text-xs" aria-label="Record">
            {pipeline.events.map((event, index) => (
              <li key={`${event.at}:${index}`} className="flex items-baseline gap-2">
                <span className="w-9 shrink-0 text-right font-mono text-[10px] text-faint" title={event.at}>
                  {relativeTime(event.at)}
                </span>
                <span className="min-w-0 text-muted-foreground">
                  {event.message}
                  {event.url && (
                    <button type="button" aria-label="Open on the web" onClick={() => void openUrl(event.url!)} className="ml-1.5 inline-flex translate-y-0.5 text-faint hover:text-foreground">
                      <ExternalLink className="size-3" />
                    </button>
                  )}
                  {hasSession(event.sessionId) && (
                    <button type="button" aria-label="Open the session" onClick={() => openSession(event.sessionId!)} className="ml-1.5 inline-flex translate-y-0.5 text-faint hover:text-foreground">
                      <MessageSquare className="size-3" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
