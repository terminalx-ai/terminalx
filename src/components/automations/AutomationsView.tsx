import { useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { AutomationEditor } from "@/components/automations/AutomationEditor";
import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { describeSchedule, nextWallTime, relativeNext } from "@/lib/automationSchedule";
import {
  deleteAutomation,
  loadAutomationRuns,
  refreshAutomations,
  runAutomationNow,
  updateAutomation,
  useAutomationStore,
} from "@/lib/automations";
import { cn } from "@/lib/cn";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { formatDuration, relativeTime } from "@/lib/time";
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

/** One full workspace surface at a time: list, selected automation, or editor. */
export function AutomationsView({ initialAutomationId = null }: { initialAutomationId?: string | null }) {
  const automationStore = useAutomationStore();
  const sessionStore = useSessionStore();
  const [selectedId, setSelectedId] = useState(initialAutomationId);
  const [editing, setEditing] = useState<Automation | null | undefined>(undefined);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = automationStore.automations.find((automation) => automation.id === selectedId) ?? null;
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

  if (editing !== undefined) {
    return (
      <AutomationEditor
        open
        automation={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        onSaved={(automation) => {
          setSelectedId(automation.id);
          setEditing(undefined);
        }}
      />
    );
  }

  if (selected) {
    return (
      <div className="automation-workspace flex h-full min-h-0 min-w-0 flex-col">
        <header className="shrink-0 border-b border-hairline px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Back to automations"
              onClick={() => {
                setSelectedId(null);
                setExpandedRun(null);
              }}
            >
              <ArrowLeft /> Automations
            </Button>
            <div className="mx-1 h-5 w-px bg-hairline" />
            <div className="flex min-w-48 flex-1 items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-veil-raised">
                {selected.issueTrigger ? <CircleDot className="size-4 text-muted-foreground" /> : <CalendarClock className="size-4 text-muted-foreground" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-base font-semibold">{selected.name}</h1>
                  <Switch size="sm" checked={selected.enabled} onCheckedChange={(value) => void toggleEnabled(value)} aria-label={selected.enabled ? "Disable automation" : "Enable automation"} />
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {sessionStore.projects.find((project) => project.path === selected.projectPath)?.name ?? selected.projectPath}
                </div>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(selected)}><Pencil /> Edit</Button>
            <WithTooltip label="Delete automation"><Button variant="ghost" size="icon-sm" aria-label="Delete automation" onClick={() => void remove()}><Trash2 /></Button></WithTooltip>
            <Button variant="accent" size="sm" disabled={running} onClick={() => void runNow()}>{running ? <Loader2 className="animate-spin" /> : <Play />} Run now</Button>
          </div>

          {error && <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
          <div className="mt-3 grid min-w-0 gap-3 automation-summary-grid">
            <details open className="min-w-0 rounded-lg bg-well px-3 py-2">
              <summary className="cursor-default text-[10px] font-medium uppercase tracking-wide text-faint">Prompt</summary>
              <p className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap pr-2 text-[13px] leading-relaxed text-foreground scrollbar-thin">{selected.prompt}</p>
            </details>
            <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-hairline px-3 py-2 text-xs">
              <SummaryItem label="Agent" value={sessionStore.harnesses.find((harness) => harness.id === selected.harness)?.name ?? selected.harness} />
              <SummaryItem label="Workspace" value={selected.workspace === "newWorktree" ? "New worktree per run" : "Existing session"} />
              <div className="col-span-2 flex min-w-0 items-start gap-2 text-muted-foreground">
                {selected.issueTrigger ? <CircleDot className="mt-0.5 size-3.5 shrink-0" /> : <Clock3 className="mt-0.5 size-3.5 shrink-0" />}
                <div className="min-w-0">
                  <div className="truncate text-foreground">
                    {selected.issueTrigger
                      ? issueTriggerSentence(selected)
                      : `${describeSchedule(selected.schedule)}, next ${nextWallTime(selected.nextRunAt, selected.schedule.timezone)} (${relativeNext(selected.nextRunAt)})`}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-faint">{selected.issueTrigger ? `Up to ${selected.issueTrigger.maxRunsPerTick} new runs per tick` : selected.schedule.timezone}</div>
                  {selected.issueTrigger && automationStore.issueStates[selected.id]?.lastPollError && (
                    <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{automationStore.issueStates[selected.id].lastPollError}</div>
                  )}
                  {!selected.issueTrigger && selected.schedule.kind === "cron" && (
                    <code className="mt-1 block truncate font-mono text-[11px] text-faint">{selected.schedule.cron}</code>
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>

        <section className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3">
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Run history</h2>
            <span className="text-[11px] tabular-nums text-faint">{runs.length} run{runs.length === 1 ? "" : "s"}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-hairline scrollbar-thin">
            <RunTable runs={runs} loading={!!automationStore.loadingRuns[selected.id]} expandedRun={expandedRun} onExpandedRunChange={setExpandedRun} />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-3">
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
          <Button variant="accent" size="sm" onClick={() => setEditing(null)}><Plus /> New automation</Button>
        </div>
      </header>

      {error && <div className="mx-4 mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 scrollbar-thin">
        {!automationStore.loaded ? (
          <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading automations…</div>
        ) : automationStore.automations.length === 0 ? (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-hairline px-4 text-center text-sm text-muted-foreground">
            <CalendarClock className="size-7 text-faint" />
            <span>Save a prompt to run on a schedule or whenever you need it.</span>
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)}><Plus /> Create your first automation</Button>
          </div>
        ) : groups.map((group) => (
          <section key={group.path} className="mb-5">
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
              <FolderGit2 className="size-3" /> {group.name}
              <span className="font-normal normal-case tabular-nums">· {group.automations.length}</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-hairline">
              {group.automations.map((automation, index) => (
                <button
                  key={automation.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(automation.id);
                    setExpandedRun(null);
                  }}
                  className={cn(
                    "relative flex w-full min-w-0 items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-selected/50",
                    index > 0 && "border-t border-hairline",
                    !automation.enabled && "opacity-60",
                  )}
                >
                  <span aria-hidden className={cn("absolute bottom-3 left-0 top-3 w-0.5 rounded-full", statusColor(automation.lastOutcome))} />
                  <AgentMark id={automation.harness} className="size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">{automation.name}</span>
                      {!automation.enabled && <span className="rounded bg-veil-raised px-1.5 py-0.5 text-[10px] text-faint">Paused</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{issueTriggerSentence(automation) ?? describeSchedule(automation.schedule)}</div>
                  </div>
                  <div className="hidden shrink-0 text-right text-[11px] text-faint sm:block">
                    <div>{automation.issueTrigger ? (automationStore.issueStates[automation.id]?.lastPolledAt ? `Checked ${relativeTime(automationStore.issueStates[automation.id].lastPolledAt!)}` : "Waiting for check") : `Next ${relativeNext(automation.nextRunAt)}`}</div>
                    {automation.lastOutcome && <div>{STATUS_LABEL[automation.lastOutcome]}</div>}
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-faint" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-faint">{label}</div>
      <div className="truncate text-[12px] text-foreground">{value}</div>
    </div>
  );
}

function RunTable({ runs, loading, expandedRun, onExpandedRunChange }: { runs: AutomationRun[]; loading: boolean; expandedRun: string | null; onExpandedRunChange: (id: string | null) => void }) {
  const sessionStore = useSessionStore();
  return (
    <table aria-label="Automation runs" className="automation-table w-full min-w-[42rem] table-fixed border-collapse text-left text-xs">
      <colgroup>
        <col className="w-[11%]" />
        <col className="w-[24%]" />
        <col className="w-[13%]" />
        <col className="automation-column-timing w-[17%]" />
        <col className="automation-column-workspace w-[20%]" />
        <col className="automation-column-result w-[15%]" />
      </colgroup>
      <thead className="sticky top-0 z-10 bg-background">
        <tr className="border-b border-hairline text-[10px] font-medium uppercase tracking-wide text-faint">
          <th scope="col" className="px-3 py-2">Run</th>
          <th scope="col" className="px-3 py-2">Trigger or issue</th>
          <th scope="col" className="px-3 py-2">Status</th>
          <th scope="col" className="automation-column-timing px-3 py-2">Timing</th>
          <th scope="col" className="automation-column-workspace px-3 py-2">Worktree or session</th>
          <th scope="col" className="automation-column-result px-3 py-2">Result or PR</th>
        </tr>
      </thead>
      <tbody>
        {runs.length === 0 && (
          <tr>
            <td colSpan={6} className="h-36 px-4 text-center text-xs text-muted-foreground">
              {loading ? <span className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Reading history…</span> : "No runs yet. Run it now to create an ordinary session."}
            </td>
          </tr>
        )}
        {runs.map((run) => {
          const expanded = expandedRun === run.runId;
          const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
          const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
          const duration = Number.isFinite(start) ? formatDuration(Math.max(0, end - start)) : null;
          const session = sessionStore.sessions.find((value) => value.id === run.sessionId);
          return <RunTableRows key={run.runId} run={run} expanded={expanded} duration={duration} sessionTitle={session?.title ?? null} onToggle={() => onExpandedRunChange(expanded ? null : run.runId)} />;
        })}
      </tbody>
    </table>
  );
}

function RunTableRows({ run, expanded, duration, sessionTitle, onToggle }: { run: AutomationRun; expanded: boolean; duration: string | null; sessionTitle: string | null; onToggle: () => void }) {
  const repeated = run.repeatCount > 1 ? `${run.repeatCount}× · ${relativeTime(run.lastRepeatAt ?? run.endedAt ?? "")}` : null;
  return (
    <>
      <tr className={cn("border-b border-hairline align-top transition-colors hover:bg-selected/30", expanded && "bg-selected/20")}>
        <td className="px-3 py-2.5">
          <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} run ${run.runNumber}`} onClick={onToggle} className="flex items-center gap-1.5 font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            {expanded ? <ChevronDown className="size-3.5 text-faint" /> : <ChevronRight className="size-3.5 text-faint" />}
            <span className="tabular-nums">#{run.runNumber}</span>
          </button>
          {repeated && <div className="mt-0.5 pl-5 text-[10px] text-faint">{repeated}</div>}
        </td>
        <td className="px-3 py-2.5">
          {run.issue ? (
            <button type="button" onClick={() => void openUrl(run.issue!.url)} className="flex max-w-full items-start gap-1 text-left text-info hover:underline">
              <span className="shrink-0 font-mono">{run.issue.identifier}</span>
              <span className="truncate text-muted-foreground">{run.issue.title}</span>
              <ExternalLink className="mt-0.5 size-3 shrink-0" />
            </button>
          ) : <span className="capitalize text-muted-foreground">{run.trigger}</span>}
        </td>
        <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span aria-hidden className={cn("size-1.5 rounded-full", statusColor(run.status))} />{STATUS_LABEL[run.status]}</span></td>
        <td className="automation-column-timing px-3 py-2.5 text-muted-foreground"><div>{relativeTime(run.startedAt ?? run.endedAt ?? "")}</div><div className="text-[10px] text-faint">{duration ?? "—"}</div></td>
        <td className="automation-column-workspace px-3 py-2.5">
          {run.worktreeName ? <span className="flex min-w-0 items-center gap-1.5"><GitBranch className="size-3 shrink-0 text-faint" /><span className="truncate font-mono text-[11px]">{run.worktreeName}</span></span> : run.sessionId ? <span className="block truncate text-muted-foreground">{sessionTitle ?? "Session"}</span> : <span className="text-faint">—</span>}
        </td>
        <td className="automation-column-result px-3 py-2.5">
          {run.reported?.prUrl ? <button type="button" onClick={() => void openUrl(run.reported!.prUrl!)} className="inline-flex items-center gap-1 text-info hover:underline">Open PR <ExternalLink className="size-3" /></button> : run.error ? <span className="text-destructive">Error</span> : run.finalMessage ? <span className="text-muted-foreground">Output</span> : <span className="text-faint">—</span>}
          {run.changedFiles != null && <div className="text-[10px] text-faint">{run.changedFiles} file{run.changedFiles === 1 ? "" : "s"} changed</div>}
        </td>
      </tr>
      {expanded && <tr className="border-b border-hairline bg-well/60"><td colSpan={6} className="px-4 py-3"><RunDetails run={run} /></td></tr>}
    </>
  );
}

function RunDetails({ run }: { run: AutomationRun }) {
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {run.sessionId && <Button variant="secondary" size="xs" onClick={() => selectSession(run.sessionId!)}>Open run session</Button>}
        {run.reported?.comment && <button type="button" onClick={() => void openUrl(run.reported!.comment!)} className="text-[11px] text-info hover:underline">View comment</button>}
        {run.reported?.prUrl && <button type="button" onClick={() => void openUrl(run.reported!.prUrl!)} className="text-[11px] text-info hover:underline">Open pull request</button>}
        {(run.reported?.labels?.length ?? 0) > 0 && <span className="text-[11px] text-faint">Labels: {run.reported!.labels!.join(", ")}</span>}
      </div>
      {run.finalMessage ? <div><div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-faint">Output snapshot</div><Markdown text={run.finalMessage} /></div> : run.error ? <div className="text-xs leading-relaxed text-destructive">{run.error}</div> : <div className="text-xs text-muted-foreground">{run.status === "running" || run.status === "pending" ? "The agent is still working." : "This run did not produce an assistant message."}</div>}
      {run.precheck && <div className="mt-3 border-t border-hairline pt-3"><div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-faint">Precheck output</div>{run.precheck.stdoutTail && <pre className="overflow-x-auto whitespace-pre-wrap text-[11px] text-foreground">{run.precheck.stdoutTail}</pre>}{run.precheck.stderrTail && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-destructive">{run.precheck.stderrTail}</pre>}</div>}
      {run.finalMessage && run.error && <div className="mt-2 text-[11px] text-destructive">{run.error}</div>}
    </div>
  );
}
