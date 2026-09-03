import { useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CalendarClock, ChevronDown, ChevronRight, CircleDot, Clock3, ExternalLink, FolderGit2, Loader2, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Markdown } from "@/components/chat/Markdown";
import { AutomationEditor } from "@/components/automations/AutomationEditor";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { describeSchedule, nextWallTime, relativeNext } from "@/lib/automationSchedule";
import {
  deleteAutomation,
  loadAutomationRuns,
  refreshAutomations,
  runAutomationNow,
  updateAutomation,
  useAutomationStore,
} from "@/lib/automations";
import { errorMessage } from "@/lib/api";
import { relativeTime, formatDuration } from "@/lib/time";
import { selectSession, useSessionStore } from "@/lib/sessions";
import type { Automation, AutomationInput, AutomationRun, AutomationRunStatus } from "@/types/automations";

const STATUS_LABEL: Record<AutomationRunStatus, string> = {
  pending: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timedOut: "Timed out",
  skippedPrecheck: "Precheck skipped",
  skippedMissed: "Missed",
  skippedUnavailable: "Unavailable",
};

function statusColor(status: AutomationRunStatus | null | undefined): string {
  if (status === "completed") return "bg-add";
  if (status === "pending" || status === "running") return "bg-info animate-pulse-soft";
  if (status === "failed" || status === "timedOut") return "bg-destructive";
  if (status?.startsWith("skipped") || status === "cancelled") return "bg-warning";
  return "bg-faint";
}

function toInput(automation: Automation): AutomationInput {
  return {
    name: automation.name,
    enabled: automation.enabled,
    projectPath: automation.projectPath,
    harness: automation.harness,
    model: automation.model,
    effort: automation.effort ?? null,
    mode: automation.mode,
    prompt: automation.prompt,
    workspace: automation.workspace,
    sessionId: automation.sessionId ?? null,
    reuseSession: automation.reuseSession,
    baseRef: automation.baseRef ?? null,
    schedule: automation.schedule,
    precheck: automation.precheck ?? null,
    missedRunGraceMinutes: automation.missedRunGraceMinutes,
    runTimeoutMinutes: automation.runTimeoutMinutes ?? null,
    issueTrigger: automation.issueTrigger ?? null,
  };
}

function issueTriggerSentence(automation: Automation): string | null {
  const trigger = automation.issueTrigger;
  if (!trigger) return null;
  return `GitHub: ${trigger.query} in ${trigger.repo}, checked every ${trigger.pollIntervalMinutes} min`;
}

/** Saved prompts on the left; one automation and its chronological run story on the right. */
export function AutomationsView() {
  const automationStore = useAutomationStore();
  const sessionStore = useSessionStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = automationStore.automations.find((automation) => automation.id === selectedId) ?? automationStore.automations[0] ?? null;
  const runs = selected ? (automationStore.runs[selected.id] ?? []) : [];
  const groups = useMemo(() => {
    const map = new Map<string, Automation[]>();
    for (const automation of automationStore.automations) {
      const values = map.get(automation.projectPath) ?? [];
      values.push(automation);
      map.set(automation.projectPath, values);
    }
    return [...map.entries()].map(([path, automations]) => ({
      path,
      name: sessionStore.projects.find((project) => project.path === path)?.name ?? path.split("/").pop() ?? path,
      automations: automations.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [automationStore.automations, sessionStore.projects]);

  useEffect(() => {
    if (selected) void loadAutomationRuns(selected.id).catch((cause) => setError(errorMessage(cause)));
  }, [selected?.id]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshAutomations();
      if (selected) await loadAutomationRuns(selected.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const runNow = async () => {
    if (!selected) return;
    setRunning(true);
    setError(null);
    try {
      const run = await runAutomationNow(selected.id);
      setExpandedRun(run.runId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunning(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (!selected) return;
    try {
      await updateAutomation(selected.id, { ...toInput(selected), enabled });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const remove = async () => {
    if (!selected) return;
    const yes = await ask(
      `Delete “${selected.name}”? Its run history is removed, but its sessions and worktrees stay available for inspection.`,
      { title: "Delete automation", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
    ).catch(() => false);
    if (!yes) return;
    try {
      await deleteAutomation(selected.id);
      setSelectedId(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const newAutomation = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col border-r border-hairline">
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Automations</h1>
            <p className="text-xs text-muted-foreground">Scheduled, issue-driven and manual agent runs</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <WithTooltip label="Refresh">
              <Button variant="ghost" size="icon-sm" aria-label="Refresh automations" onClick={() => void refresh()}>
                <RefreshCw className={cn(refreshing && "animate-spin")} />
              </Button>
            </WithTooltip>
            <Button variant="accent" size="sm" onClick={newAutomation}><Plus /> New automation</Button>
          </div>
        </div>

        {error && <div className="mx-4 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-2 pb-4">
          {!automationStore.loaded ? (
            <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading automations…</div>
          ) : automationStore.automations.length === 0 ? (
            <div className="flex flex-col items-start gap-3 px-2 py-6 text-sm text-muted-foreground">
              <span>Save a prompt to run on a schedule or whenever you need it.</span>
              <Button variant="secondary" size="sm" onClick={newAutomation}><Plus /> Create your first automation</Button>
            </div>
          ) : groups.map((group) => (
            <section key={group.path} className="mb-4">
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                <FolderGit2 className="size-3" /> {group.name}
              </div>
              {group.automations.map((automation) => (
                <button
                  key={automation.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(automation.id);
                    setExpandedRun(null);
                  }}
                  className={cn(
                    "relative flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors",
                    selected?.id === automation.id ? "bg-selected" : "hover:bg-selected/50",
                    !automation.enabled && "opacity-60",
                  )}
                >
                  <span aria-hidden className={cn("absolute bottom-2.5 left-1 top-2.5 w-0.5 rounded-full", statusColor(automation.lastOutcome))} />
                  <AgentMark id={automation.harness} className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">{automation.name}</span>
                      {!automation.enabled && <span className="rounded bg-veil-raised px-1.5 py-0.5 text-[10px] text-faint">Paused</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{issueTriggerSentence(automation) ?? describeSchedule(automation.schedule)}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-1 text-[11px] text-faint">
                      {automation.issueTrigger ? (
                        <span>{automationStore.issueStates[automation.id]?.lastPolledAt ? `Last checked ${relativeTime(automationStore.issueStates[automation.id].lastPolledAt!)}` : "Waiting for first check"}</span>
                      ) : (
                        <><span>Next run {relativeNext(automation.nextRunAt)}</span><span>· {nextWallTime(automation.nextRunAt, automation.schedule.timezone)}</span></>
                      )}
                      {automation.lastOutcome && <span>· {STATUS_LABEL[automation.lastOutcome]}</span>}
                    </div>
                  </div>
                </button>
              ))}
            </section>
          ))}
        </div>
      </div>

      <div className="flex w-[46%] min-w-80 max-w-[42rem] flex-col">
        {selected ? (
          <>
            <div className="shrink-0 border-b border-hairline px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-veil-raised">{selected.issueTrigger ? <CircleDot className="size-4 text-muted-foreground" /> : <CalendarClock className="size-4 text-muted-foreground" />}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold">{selected.name}</h2>
                    <Switch size="sm" checked={selected.enabled} onCheckedChange={(value) => void toggleEnabled(value)} aria-label={selected.enabled ? "Disable automation" : "Enable automation"} />
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AgentMark id={selected.harness} className="size-3.5" />
                    {sessionStore.harnesses.find((harness) => harness.id === selected.harness)?.name ?? selected.harness}
                    <span>·</span>
                    <span>{selected.workspace === "newWorktree" ? "New worktree per run" : "Existing session"}</span>
                  </div>
                </div>
                <Button variant="accent" size="sm" disabled={running} onClick={() => void runNow()}>{running ? <Loader2 className="animate-spin" /> : <Play />} Run now</Button>
                <WithTooltip label="Edit automation"><Button variant="ghost" size="icon-sm" aria-label="Edit automation" onClick={() => { setEditing(selected); setEditorOpen(true); }}><Pencil /></Button></WithTooltip>
                <WithTooltip label="Delete automation"><Button variant="ghost" size="icon-sm" aria-label="Delete automation" onClick={() => void remove()}><Trash2 /></Button></WithTooltip>
              </div>
              <div className="mt-4 rounded-lg bg-well px-3 py-2.5">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-faint">Prompt</div>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{selected.prompt}</p>
              </div>
              {selected.issueTrigger ? (
                <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                  <CircleDot className="mt-0.5 size-3.5 shrink-0" />
                  <div>
                    <div>GitHub issues matching <code className="font-mono text-foreground">{selected.issueTrigger.query}</code> in <code className="font-mono text-foreground">{selected.issueTrigger.repo}</code></div>
                    <div className="mt-0.5 text-[11px] text-faint">Checked every {selected.issueTrigger.pollIntervalMinutes} min · up to {selected.issueTrigger.maxRunsPerTick} new run{selected.issueTrigger.maxRunsPerTick === 1 ? "" : "s"} per tick</div>
                    {automationStore.issueStates[selected.id]?.lastPollError && <div className="mt-1 text-[11px] text-destructive">{automationStore.issueStates[selected.id].lastPollError}</div>}
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                  <Clock3 className="mt-0.5 size-3.5 shrink-0" />
                  <div>
                    <div>{describeSchedule(selected.schedule)}, next {nextWallTime(selected.nextRunAt, selected.schedule.timezone)} ({relativeNext(selected.nextRunAt)})</div>
                    <div className="mt-0.5 text-[11px] text-faint">{selected.schedule.timezone}</div>
                    {selected.schedule.kind === "cron" && <details className="mt-1"><summary className="cursor-default text-[11px] hover:text-muted-foreground">Show cron expression</summary><code className="mt-1 block font-mono text-[11px] text-foreground">{selected.schedule.cron}</code></details>}
                  </div>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Run history</h3>
                <span className="text-[11px] text-faint">{runs.length} run{runs.length === 1 ? "" : "s"}</span>
              </div>
              {automationStore.loadingRuns[selected.id] && runs.length === 0 ? (
                <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Reading history…</div>
              ) : runs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-hairline px-3 py-5 text-center text-xs text-muted-foreground">No runs yet. Run it now to create an ordinary session.</div>
              ) : (
                <div>
                  {runs.map((run, index) => (
                    <RunRow
                      key={run.runId}
                      run={run}
                      last={index === runs.length - 1}
                      expanded={expandedRun === run.runId}
                      onToggle={() => setExpandedRun((current) => current === run.runId ? null : run.runId)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
            <CalendarClock className="size-7 text-faint" />
            <span>Select an automation to see its prompt and run history.</span>
          </div>
        )}
      </div>

      <AutomationEditor
        open={editorOpen}
        automation={editing}
        onOpenChange={setEditorOpen}
        onSaved={(automation) => {
          setSelectedId(automation.id);
          setEditing(null);
        }}
      />
    </div>
  );
}

function RunRow({ run, expanded, last, onToggle }: { run: AutomationRun; expanded: boolean; last: boolean; onToggle: () => void }) {
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const duration = Number.isFinite(start) ? formatDuration(Math.max(0, end - start)) : null;
  const repeated = run.repeatCount > 1 ? `${run.repeatCount} times, last ${relativeTime(run.lastRepeatAt ?? run.endedAt ?? "")}` : null;
  return (
    <div className="relative pl-6">
      {!last && <span aria-hidden className="absolute bottom-0 left-[5px] top-3 w-px bg-hairline" />}
      <span aria-hidden className={cn("absolute left-0 top-3 size-[11px] rounded-full ring-4 ring-background", statusColor(run.status))} />
      <div role="button" tabIndex={0} onClick={onToggle} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onToggle(); }} className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-selected/50">
        {expanded ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-faint" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-faint" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">Run {run.runNumber}</span>
            {run.issue && <button type="button" onClick={(event) => { event.stopPropagation(); void openUrl(run.issue!.url); }} className="flex items-center gap-1 font-mono text-[11px] text-info hover:underline">{run.issue.identifier}<ExternalLink className="size-3" /></button>}
            <span className="text-[11px] text-muted-foreground">{STATUS_LABEL[run.status]}</span>
            <span className="ml-auto text-[11px] text-faint">{relativeTime(run.startedAt ?? run.endedAt ?? "")}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-[11px] text-faint">
            <span className="capitalize">{run.trigger}</span>
            {duration && <span>· {duration}</span>}
            {run.changedFiles != null && <span>· {run.changedFiles} changed file{run.changedFiles === 1 ? "" : "s"}</span>}
            {repeated && <span>· {repeated}</span>}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="mb-3 ml-2 rounded-lg bg-well p-3">
          {run.sessionId && (
            <Button variant="secondary" size="xs" className="mb-3" onClick={() => selectSession(run.sessionId!)}>Open run session</Button>
          )}
          {run.finalMessage ? (
            <div>
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-faint">Output snapshot</div>
              <Markdown text={run.finalMessage} />
            </div>
          ) : run.error ? (
            <div className="text-xs leading-relaxed text-destructive">{run.error}</div>
          ) : (
            <div className="text-xs text-muted-foreground">{run.status === "running" || run.status === "pending" ? "The agent is still working." : "This run did not produce an assistant message."}</div>
          )}
          {run.precheck && (
            <div className="mt-3 border-t border-hairline pt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-faint">Precheck output</div>
              {run.precheck.stdoutTail && <pre className="overflow-x-auto whitespace-pre-wrap text-[11px] text-foreground">{run.precheck.stdoutTail}</pre>}
              {run.precheck.stderrTail && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-destructive">{run.precheck.stderrTail}</pre>}
            </div>
          )}
          {run.reported && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-hairline pt-3 text-[11px]">
              {run.reported.comment && <button type="button" onClick={() => void openUrl(run.reported!.comment!)} className="text-info hover:underline">View comment</button>}
              {run.reported.prUrl && <button type="button" onClick={() => void openUrl(run.reported!.prUrl!)} className="text-info hover:underline">Open pull request</button>}
              {(run.reported.labels?.length ?? 0) > 0 && <span className="text-faint">Labels: {run.reported.labels!.join(", ")}</span>}
            </div>
          )}
          {run.finalMessage && run.error && <div className="mt-2 text-[11px] text-destructive">{run.error}</div>}
        </div>
      )}
    </div>
  );
}
