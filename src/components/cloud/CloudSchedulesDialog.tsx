import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CalendarClock, Loader2, Pause, Play, Plus, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type CloudAutomationDto, type CloudSelectedRepository, type CloudScheduleQuote } from "@/lib/api";
import {
  PRESETS,
  SCHEDULE_LIMITS,
  SCHEDULE_MODES,
  WEEKDAYS,
  blankAutomationForm,
  AUTOMATION_HOLD,
  automationFormErrors,
  automationInput,
  automationEstimateInput,
  automationCostLines,
  describeTiming,
  modeNote,
  pausedText,
  resumeBlocked,
  runText,
  scheduleErrorMessage,
  timezones,
  whenText,
  type AutomationForm,
} from "@/lib/cloudSchedules";
import { GithubTriggerEditor } from "./GithubTriggerEditor";
import { retireAutomationTargetScope, useAutomationFence, useAutomationScope } from "./CloudAutomationScope";
import { openCloudSession } from "@/lib/cloudDashboard";
import { cloudSessionKey, cloudWorkspaceKey } from "@/types/target";
import { errorCode } from "@/lib/cloudTerminals";
import { EFFORT_LABEL, modelOptionText, offeredOn, useModels } from "@/lib/models";
import { usePromptTextProps } from "@/lib/autocorrect";

/**
 * A cloud workspace's scheduled tasks (PRO-37): the list, with what each
 * costs and how its last run went; pause, resume and delete; a form for a
 * new one, which shows the cost before anything is saved; and the
 * organization's "pause all".
 *
 * Everything that starts billed compute by itself is said to do so and is
 * confirmed where it is asked for: creating a task, resuming one. Opening
 * the dialog and asking for an estimate wake nothing.
 *
 * There is no edit: the server has no route for it. A task is changed by
 * deleting it and making it again.
 *
 * "Pause all" is the emergency stop: it stays reachable while the list
 * cannot be read and while the form is open.
 */

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];
const inputClass = "min-w-0 rounded-md border border-hairline bg-transparent px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
/** How long the form rests before its cost is asked for again. Exported for its test, which lets exactly this pass. */
export const ESTIMATE_DELAY_MS = 400;

export interface SchedulesTarget {
  orgId: string;
  workspaceId: string;
  name: string;
}

type Confirming = { kind: "resume" | "delete"; id: string } | { kind: "pause-all" } | null;

export function CloudSchedulesDialog(props: SchedulesTarget & { onClose: () => void }) {
  const { stamp, allowed } = useAutomationScope();
  if (!allowed) return <Dialog open onOpenChange={(open) => !open && props.onClose()}><DialogContent><DialogTitle>Cloud automations unavailable</DialogTitle><DialogDescription>Sign in and turn off data privacy mode to view cloud automations.</DialogDescription></DialogContent></Dialog>;
  return <ScopedSchedulesDialog key={JSON.stringify([stamp, props.orgId, props.workspaceId])} {...props} />;
}

function ScopedSchedulesDialog({ orgId, workspaceId, name, onClose }: SchedulesTarget & { onClose: () => void }) {
  const capture = useAutomationFence();
  const listRequest = useRef(0);
  const [contractsAvailable, setContractsAvailable] = useState(false);
  useEffect(() => {
    const current = capture();
    api.phase2DesktopContractsAvailable().then((available) => { if (current()) setContractsAvailable(available === true); }, () => {});
  }, [capture]);
  const [schedules, setSchedules] = useState<CloudAutomationDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [creating, setCreating] = useState(false);
  const reload = useCallback(async () => {
    const current = capture();
    const request = ++listRequest.current;
    try {
      const result = await api.cloudAutomations(workspaceId, orgId);
      if (!current() || request !== listRequest.current) return;
      setSchedules(result.schedules);
      setLoadError(null);
    } catch (e) {
      if (!current() || request !== listRequest.current) return;
      setLoadError(scheduleErrorMessage(errorCode(e)));
    }
  }, [orgId, workspaceId, capture]);
  useEffect(() => { void reload(); }, [reload]);

  /** One change at a time; the list is read again after it, whatever became of it. */
  const act = async (key: string, work: () => Promise<string | null>) => {
    const current = capture();
    if (!current()) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      if (!current()) return;
      setNotice(message);
      setConfirming(null);
    } catch (e) {
      if (current()) setError(scheduleErrorMessage(errorCode(e)));
    } finally {
      if (current()) { setBusy(null); await reload(); }
    }
  };

  const pause = (schedule: CloudAutomationDto) => act(schedule.id, async () => (await api.cloudAutomationSetActive(schedule.id, false, orgId), null));
  const resume = (schedule: CloudAutomationDto) => {
    if ((schedule.workspaceMode === "fresh" || schedule.githubTrigger) && !contractsAvailable) return;
    return act(schedule.id, async () => (await api.cloudAutomationSetActive(schedule.id, true, orgId), null));
  };
  const remove = (schedule: CloudAutomationDto) => act(schedule.id, async () => (await api.cloudScheduleDelete(schedule.id, orgId), null));
  const pauseAll = () =>
    act("pause-all", async () => {
      const { paused } = await api.cloudSchedulesPauseAll(orgId);
      return paused === 0 ? "No scheduled task of the organization was active." : `Paused ${paused} scheduled ${paused === 1 ? "task" : "tasks"} in the organization. Resume each one by hand.`;
    });

  const [confirmClose, setConfirmClose] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const active = schedules?.filter((schedule) => schedule.state === "active").length ?? 0;

  const requestClose = () => {
    if (creating && formDirty) setConfirmClose(true);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
      <DialogContent width="max-w-[40rem]" className="max-h-[85vh] overflow-y-auto" data-testid="cloud-schedules-dialog">
        <DialogHeader>
          <DialogTitle>Scheduled tasks for {name}</DialogTitle>
          <DialogDescription>
            An automation sends one prompt to an agent on a timer or GitHub event, using this workspace or a fresh workspace, with nobody watching. Each run starts billed compute by itself. Only
            owners and admins of the organization can make, pause, resume or delete one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-xs">
          {/* First, above a list of any length: "Pause all" is the emergency stop. */}
          <div className="flex flex-wrap items-center gap-2">
            {schedules && !creating && (
              <Button size="sm" onClick={() => setCreating(true)} disabled={busy !== null}>
                <Plus /> New scheduled task
              </Button>
            )}
            {confirming?.kind === "pause-all" ? (
              <span className="flex flex-wrap items-center gap-2" data-testid="cloud-schedules-pause-all-confirm">
                <span>Pause every scheduled task in the organization, including ones on other workspaces? Nothing new starts; each is resumed by hand.</span>
                <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void pauseAll()}>
                  Pause all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming({ kind: "pause-all" })}>
                <Pause /> Pause all in the organization…
              </Button>
            )}
            {active > 0 && (
              <span className="ml-auto text-faint">
                {active} active here
              </span>
            )}
          </div>
          {!contractsAvailable && <p role="note">{AUTOMATION_HOLD}</p>}
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="text-muted-foreground">{notice}</p>}
          {confirmClose && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-well/60 px-3 py-2 text-xs" role="alert" data-testid="cloud-schedules-discard-confirm">
              <span className="min-w-0 flex-1">You have an unsaved scheduled task. Discard it and close?</span>
              <Button size="xs" variant="destructive" onClick={() => { setConfirmClose(false); onClose(); }}>
                Discard &amp; close
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirmClose(false)}>
                Keep editing
              </Button>
            </div>
          )}
          {/* The form opens where its button was, not under the list. */}
          {creating && (
            <NewScheduleForm
              orgId={orgId}
              workspaceId={workspaceId}
              contractsAvailable={contractsAvailable}
              onDirtyChange={setFormDirty}
              onCancel={() => {
                setCreating(false);
                setFormDirty(false);
              }}
              onCreated={() => {
                setCreating(false);
                setFormDirty(false);
                void reload();
              }}
            />
          )}
          {!schedules && !loadError && <Loader2 className="size-4 animate-spin" />}
          {loadError && (
            <p role="alert" className="text-destructive" data-testid="cloud-schedules-load-error">
              Could not load the scheduled tasks. {loadError}{" "}
              <Button size="xs" variant="outline" onClick={() => void reload()}>Try again</Button>
            </p>
          )}
          {schedules && schedules.length === 0 && !creating && <p className="text-muted-foreground">This workspace has no scheduled tasks.</p>}
          {schedules && schedules.length > 0 && (
            <ul className="flex flex-col gap-2" data-testid="cloud-schedules-list">
              {schedules.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  orgId={orgId}
                  busy={busy !== null}
                  resumeBlocked={(schedule.workspaceMode === "fresh" || schedule.githubTrigger) && !contractsAvailable ? AUTOMATION_HOLD : resumeBlocked(schedule)}
                  confirming={confirming && "id" in confirming && confirming.id === schedule.id ? confirming.kind : null}
                  onPause={() => void pause(schedule)}
                  onAskResume={() => setConfirming({ kind: "resume", id: schedule.id })}
                  onResume={() => void resume(schedule)}
                  onAskDelete={() => setConfirming({ kind: "delete", id: schedule.id })}
                  onDelete={() => void remove(schedule)}
                  onCancel={() => setConfirming(null)}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleRow({
  orgId,
  schedule,
  busy,
  resumeBlocked: blocked,
  confirming,
  onPause,
  onAskResume,
  onResume,
  onAskDelete,
  onDelete,
  onCancel,
}: {
  orgId: string;
  schedule: CloudAutomationDto;
  busy: boolean;
  /** Why Resume would only be refused, or null. */
  resumeBlocked: string | null;
  confirming: "resume" | "delete" | null;
  onPause: () => void;
  onAskResume: () => void;
  onResume: () => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const paused = pausedText(schedule);
  const next = schedule.githubTrigger ? null : whenText(schedule.nextRunAt);
  const last = schedule.lastRun;
  return (
    <li className="flex flex-col gap-1 rounded-md border border-hairline px-3 py-2" data-testid={`cloud-schedule-${schedule.id}`}>
      <div className="flex min-w-0 items-center gap-2">
        <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium" title={schedule.name}>
          {schedule.name}
        </span>
        <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] ${paused ? "bg-well text-muted-foreground" : "bg-add/15 text-add"}`}>{paused ? "Paused" : "Active"}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {paused ? (
            <Button size="xs" variant="ghost" disabled={busy || blocked !== null} title={blocked ?? undefined} onClick={onAskResume}>
              <Play /> Resume…
            </Button>
          ) : (
            <Button size="xs" variant="ghost" disabled={busy} onClick={onPause}>
              <Pause /> Pause
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={busy} onClick={onAskDelete} aria-label={`Delete ${schedule.name}`}>
            <Trash2 />
          </Button>
        </span>
      </div>
      <p className="text-muted-foreground">
        {schedule.githubTrigger ? `GitHub · ${schedule.githubTrigger.event} · ${schedule.githubTrigger.repositoryId}` : schedule.schedule ? describeTiming(schedule.schedule) : "Trigger unavailable"} · {schedule.workspaceMode === "fresh" ? "New workspace per run" : "Existing workspace"} · {schedule.agent}
        {schedule.mode ? ` · ${SCHEDULE_MODES.find((mode) => mode.id === schedule.mode)?.label ?? schedule.mode}` : ""} · stops after {schedule.maxRunMinutes} minutes
      </p>
      {schedule.githubTrigger && <p>{schedule.githubTrigger.filters.map((filter) => `${filter.field} ${filter.operator} ${filter.value}`).join(" AND ") || "No filters"}. Allow pull requests from forks: {schedule.githubTrigger.allowForkPullRequests ? "Yes" : "No"}.</p>}
      {schedule.workspaceMode === "fresh" && <p>{schedule.archiveAfterDays ? `Archive after ${schedule.archiveAfterDays} days. ` : ""}{schedule.archiveOnPrMerge ? "Archive when the PR merges." : ""}</p>}
      {paused && <p>{paused}</p>}
      {blocked && (
        <p className="text-muted-foreground" data-testid="cloud-schedule-resume-blocked">
          It cannot be resumed: {blocked}
        </p>
      )}
      <p className="text-muted-foreground">
        {next && !paused ? `Next run ${next}. ` : ""}
        {last ? `Last run ${whenText(last.scheduledFor)}: ${runText(last)}.` : "It has not run yet."}
      </p>
      <ul className="text-faint">
        {automationCostLines(schedule.estimate, schedule.maxRunMinutes, schedule.workspaceMode === "fresh", !!schedule.githubTrigger)
          .map((line) => (
            <li key={line}>{line}</li>
          ))}
      </ul>
      <Button size="xs" variant="ghost" onClick={() => setShowRuns((value) => !value)}>{showRuns ? "Hide runs" : "Show runs"}</Button>
      {showRuns && <CloudAutomationRuns schedule={schedule} orgId={orgId} />}
      {confirming === "resume" && !blocked && (
        <p className="flex flex-wrap items-center gap-2 rounded-md bg-well/40 px-2 py-1.5" data-testid="cloud-schedule-resume-confirm">
          <span>Resuming starts billed compute by itself again on matching triggers, and the task then runs under your account.</span>
          <Button size="xs" disabled={busy} onClick={onResume}>
            Resume
          </Button>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </p>
      )}
      {confirming === "delete" && (
        <p className="flex flex-wrap items-center gap-2 rounded-md bg-well/40 px-2 py-1.5" data-testid="cloud-schedule-delete-confirm">
          <span>Delete this task, its prompt and its run history? Pending workspace cleanup may prevent deletion.</span>
          <Button size="xs" variant="destructive" disabled={busy} onClick={onDelete}>
            Delete
          </Button>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </p>
      )}
    </li>
  );
}

function CloudAutomationRuns({ schedule, orgId }: { schedule: CloudAutomationDto; orgId: string }) {
  const capture = useAutomationFence();
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.cloudAutomation>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const current = capture();
    let stale = false;
    api.cloudAutomation(schedule.id, orgId).then((answer) => {
      if (current() && !stale) setDetail(answer);
    }, (e: unknown) => { if (current() && !stale) setError(scheduleErrorMessage(errorCode(e))); });
    return () => { stale = true; };
  }, [schedule.id, orgId, capture]);
  if (error) return <p role="alert">Could not read runs. {error}</p>;
  if (!detail) return <p>Reading runs…</p>;
  return <ul aria-label="Runs">{detail.runs.length === 0 && <li>No runs yet.</li>}{detail.runs.map((run) => {
    const workspaceId = run.workspaceId && !(detail.schedule.workspaceMode === "fresh" && run.workspaceId === detail.schedule.workspaceId) ? run.workspaceId : null;
    return <li key={run.id} data-testid={`automation-run-${run.id}`}>
      <p>{whenText(run.scheduledFor)} · {runText(run)} · {run.trigger}</p>
      {run.workBranch && <p>Branch: {run.workBranch}</p>}
      {run.archivedAt ? <p>Archived {whenText(run.archivedAt)}</p> : run.archiveAt ? <p>Archive due {whenText(run.archiveAt)}; archival not observed.</p> : null}
      {workspaceId ? <Button size="xs" variant="ghost" onClick={() => openCloudSession(run.sessionId ? cloudSessionKey(orgId, workspaceId, run.sessionId) : cloudWorkspaceKey(orgId, workspaceId), run.tabId)}>Open run workspace</Button> : <p>Run workspace not allocated.</p>}
    </li>;
  })}</ul>;
}

function NewScheduleForm({ orgId, workspaceId, contractsAvailable, onDirtyChange, onCancel, onCreated }: { orgId: string; workspaceId: string; contractsAvailable: boolean; onDirtyChange?: (dirty: boolean) => void; onCancel: () => void; onCreated: () => void }) {
  const capture = useAutomationFence();
  const [form, setForm] = useState<AutomationForm>(blankAutomationForm);
  const [repositories, setRepositories] = useState<CloudSelectedRepository[]>([]);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [estimateAttempt, setEstimateAttempt] = useState(0);
  useEffect(() => {
    const dirty = Boolean(form.name.trim() || form.prompt.trim());
    onDirtyChange?.(dirty);
  }, [form.name, form.prompt, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (form.triggerKind !== "github") return;
    const current = capture();
    let stale = false;
    setRepositories([]);
    setRepositoryError(null);
    api.cloudWorkspaceRepositories(orgId).then((answer) => {
      if (current() && !stale) setRepositories(answer.repositories);
    }, (error: unknown) => { if (current() && !stale) setRepositoryError(scheduleErrorMessage(errorCode(error))); });
    return () => { stale = true; };
  }, [orgId, form.triggerKind, capture]);
  const textProps = usePromptTextProps();
  const [touched, setTouched] = useState(false);
  // The settings whose cost was agreed to, not a bare tick: an agreement
  // holds only for the cost it was given for.
  const [agreedKey, setAgreedKey] = useState<string | null>(null);
  // The answer, with the settings it was asked for. Only an answer for the
  // settings on screen is shown or agreed to: while another is on its way
  // (or never comes) there is no cost, no tick and no save.
  const [answered, setAnswered] = useState<{ key: string; quote: CloudScheduleQuote } | null>(null);
  const [quoteError, setQuoteError] = useState<{ key: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const models = offeredOn(useModels(form.agent), false);
  const model = models.find((item) => item.id === form.model);
  const zones = useMemo(() => {
    const listed = timezones();
    return listed.includes(form.timezone) || listed.length === 0 ? listed : [form.timezone, ...listed];
    // The zone list is the platform's; only the form's own zone can be missing from it.
  }, [form.timezone]);
  const update = <K extends keyof AutomationForm>(key: K, value: AutomationForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (!["name", "prompt", "agent", "model", "effort", "mode", "missedRunPolicy"].includes(key)) {
      setRevision((value) => value + 1);
      setAgreedKey(null);
    }
  };
  const errors = automationFormErrors(form, repositories);
  const shown = touched ? errors : {};

  const advanced = form.workspaceMode === "fresh" || form.triggerKind === "github";
  const held = advanced && !contractsAvailable;
  const estimateInput = automationEstimateInput(form, workspaceId, repositories);
  const estimateKey = estimateInput ? JSON.stringify(estimateInput) : null;
  // Revision prevents A → B → A from reviving a previous quote/agreement.
  const quoteKey = estimateKey && !held ? JSON.stringify([estimateKey, revision]) : null;
  useEffect(() => {
    if (!estimateKey || !quoteKey) return;
    const current = capture();
    let stale = false;
    const timer = setTimeout(() => {
      if (!current()) return;
      api.cloudAutomationEstimate(JSON.parse(estimateKey), orgId).then(
        (answer) => {
          if (!current() || stale) return;
          setAnswered({ key: quoteKey, quote: answer });
          setQuoteError(null);
        },
        (e: unknown) => {
          if (!current() || stale) return;
          setAnswered(null);
          setQuoteError({ key: quoteKey, message: scheduleErrorMessage(errorCode(e)) });
        },
      );
    }, ESTIMATE_DELAY_MS);
    return () => { stale = true; clearTimeout(timer); };
  }, [orgId, workspaceId, estimateKey, quoteKey, estimateAttempt, capture]);
  const quote = answered && answered.key === quoteKey ? answered.quote : null;
  const failed = quoteError && quoteError.key === quoteKey ? quoteError.message : null;

  const unsupported = quote?.supported === false;
  // What a create would be refused for whatever the form says: said with
  // the cost, before anyone agrees to it.
  const refusal = quote?.refusal ?? null;
  const agreeable = !held && !errors.cleanup && quote !== null && !unsupported && !refusal;
  // A changed cost has not been agreed to.
  const confirmed = agreeable && agreedKey !== null && agreedKey === quoteKey;
  const save = async () => {
    setTouched(true);
    const current = capture();
    const input = automationInput(form, workspaceId, repositories);
    if (!current() || savingNow.current || !input || !confirmed || !agreeable) return;
    savingNow.current = true;
    setSaving(true);
    setError(null);
    try {
      await api.cloudAutomationCreate(input, orgId);
      if (current()) onCreated();
    } catch (e) {
      if (current()) setError(scheduleErrorMessage(errorCode(e)));
    } finally {
      savingNow.current = false;
      if (current()) setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-hairline p-3"
      data-testid="cloud-schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="font-medium">New scheduled task</p>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Name</span>
        <input aria-label="Name" className={inputClass} maxLength={SCHEDULE_LIMITS.nameChars} placeholder="Nightly triage" value={form.name} onChange={(event) => update("name", event.target.value)} />
        {shown.name && <span className="text-destructive">{shown.name}</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Prompt</span>
        <textarea
          aria-label="Prompt"
          {...textProps}
          className={`${inputClass} min-h-20 resize-y`}
          placeholder="What should the agent do each time? It cannot be a slash command or a “!” shell command."
          value={form.prompt}
          onChange={(event) => update("prompt", event.target.value)}
        />
        {shown.prompt && <span className="text-destructive">{shown.prompt}</span>}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Agent</span>
          <select aria-label="Agent" className={inputClass} value={form.agent} onChange={(event) => setForm((current) => ({ ...current, agent: event.target.value, model: "", effort: "" }))}>
            {AGENTS.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Model</span>
          <select aria-label="Model" className={inputClass} value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value, effort: "" }))}>
            <option value="">Default</option>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {modelOptionText(item, models, false)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Effort</span>
          <select aria-label="Effort" className={inputClass} value={form.effort} onChange={(event) => update("effort", event.target.value)}>
            <option value="">Default</option>
            {(model?.efforts ?? []).map((effort) => (
              <option key={effort} value={effort}>
                {EFFORT_LABEL[effort] ?? effort}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Permissions</span>
          <select aria-label="Permission mode" className={inputClass} value={form.mode} onChange={(event) => update("mode", event.target.value)}>
            {SCHEDULE_MODES.map((mode) => (
              <option key={mode.id} value={mode.id} title={mode.hint}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        <p className="col-span-2 text-faint" data-testid="cloud-schedule-mode-note">
          Nobody watches a scheduled run, so it cannot bypass permissions. {modeNote(form.mode)}
        </p>
      </div>
      <label>Workspace <select aria-label="Workspace mode" className={inputClass} value={form.workspaceMode} onChange={(e) => update("workspaceMode", e.target.value as AutomationForm["workspaceMode"])}>
        <option value="existing">Existing workspace</option><option value="fresh">New workspace per run</option>
      </select></label>
      {form.workspaceMode === "fresh" && <fieldset className="flex flex-col gap-2"><legend>Cleanup</legend>
        <label>Archive after days (optional) <input aria-label="Archive after days" type="number" min={1} max={365} step={1} value={form.archiveAfterDays} onChange={(e) => update("archiveAfterDays", e.target.value)} /></label>
        <label><input type="checkbox" checked={form.archiveOnPrMerge} onChange={(e) => update("archiveOnPrMerge", e.target.checked)} /> Archive when the PR merges</label>
        {errors.cleanup && <p role="status">{errors.cleanup}</p>}
      </fieldset>}
      <label>Trigger <select aria-label="Trigger" className={inputClass} value={form.triggerKind} onChange={(e) => update("triggerKind", e.target.value as AutomationForm["triggerKind"])}>
        <option value="timer">Schedule</option><option value="github">GitHub event</option>
      </select></label>
      {form.triggerKind === "github" && <>
        {repositoryError && <p role="alert">Could not read repositories. {repositoryError}</p>}
        <GithubTriggerEditor value={form.githubTrigger} repositories={repositories} onChange={(value) => update("githubTrigger", value)} />
      </>}
      {form.triggerKind === "timer" && <><div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Runs</span>
        <Segmented aria-label="How often" value={form.preset} onChange={(value) => update("preset", value)} options={PRESETS} />
        <label className="flex items-center gap-1">
          <span>{form.preset === "hourly" ? "at minute" : "at"}</span>
          {form.preset === "hourly" ? (
            <input
              aria-label="Minute"
              type="number"
              min={0}
              max={59}
              className={`${inputClass} w-14`}
              value={Number(form.time.split(":")[1] ?? 0)}
              onChange={(event) => update("time", `00:${String(Math.min(59, Math.max(0, Number(event.target.value) || 0))).padStart(2, "0")}`)}
            />
          ) : (
            <input aria-label="Time" type="time" className={inputClass} value={form.time} onChange={(event) => update("time", event.target.value)} />
          )}
        </label>
        {/* Hourly too: "at minute 30" is another moment in a zone half an hour off. */}
        {zones.length > 0 ? (
            <select aria-label="Time zone" className={`${inputClass} max-w-48`} value={form.timezone} onChange={(event) => update("timezone", event.target.value)}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          ) : (
            <input aria-label="Time zone" className={`${inputClass} w-40`} value={form.timezone} onChange={(event) => update("timezone", event.target.value)} />
          )}
      </div>
      {form.preset === "weekly" && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Days">
          {WEEKDAYS.map((day) => (
            <label key={day.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={form.weekdays.includes(day.id)}
                onChange={(event) => update("weekdays", event.target.checked ? [...form.weekdays, day.id] : form.weekdays.filter((id) => id !== day.id))}
              />
              {day.label}
            </label>
          ))}
        </div>
      )}
      {(shown.time || shown.weekdays) && <span className="text-destructive">{shown.time ?? shown.weekdays}</span>}</>}
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Stop a run after</span>
          <span className="flex items-center gap-1">
            <input
              aria-label="Time limit in minutes"
              type="number"
              min={SCHEDULE_LIMITS.minRunMinutes}
              max={SCHEDULE_LIMITS.maxRunMinutes}
              className={`${inputClass} w-16`}
              value={form.maxRunMinutes}
              onChange={(event) => update("maxRunMinutes", Number(event.target.value))}
            />
            minutes
          </span>
          {errors.maxRunMinutes && <span className="text-destructive">{errors.maxRunMinutes}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">After a run</span>
          <select aria-label="After a run" className={inputClass} value={form.completionPolicy} onChange={(event) => update("completionPolicy", event.target.value as AutomationForm["completionPolicy"])}>
            <option value="suspend">Stop the workspace again</option>
            <option value="keep">Leave it running</option>
          </select>
        </label>
        {form.triggerKind === "timer" && <label className="flex flex-col gap-1">
          <span className="font-medium">A missed run</span>
          <select aria-label="A missed run" className={inputClass} value={form.missedRunPolicy} onChange={(event) => update("missedRunPolicy", event.target.value as AutomationForm["missedRunPolicy"])}>
            <option value="skip">Is skipped</option>
            <option value="run-once">Runs once, late</option>
          </select>
        </label>}
      </div>
      <div className="rounded-md bg-well/40 px-3 py-2" data-testid="cloud-schedule-cost">
        <p className="font-medium">What it costs</p>
        {held ? <p>{AUTOMATION_HOLD}</p> : quote ? (
          <ul className="text-muted-foreground">
            {automationCostLines(quote.estimate, form.maxRunMinutes, form.workspaceMode === "fresh", form.triggerKind === "github").map((line) => (
              <li key={line}>{line}</li>
            ))}
            {form.triggerKind === "timer" && quote.nextRunAt && <li>First run {whenText(quote.nextRunAt)} (your time).</li>}
          </ul>
        ) : failed ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-destructive" role="alert">The cost could not be read, so the task cannot be saved yet. {failed}</p>
            <Button type="button" size="xs" variant="outline" onClick={() => { setQuoteError(null); setEstimateAttempt((n) => n + 1); }}>
              Try again
            </Button>
          </div>
        ) : estimateInput ? (
          <p className="text-muted-foreground">Reading the cost…</p>
        ) : (
          <p className="text-muted-foreground">Set when it runs and its time limit to see the cost.</p>
        )}
        {refusal && (
          <p className="mt-1 text-destructive" data-testid="cloud-schedule-refusal">
            It cannot be saved now: {scheduleErrorMessage(refusal)}
          </p>
        )}
        {unsupported && (
          <p className="mt-1 text-destructive" data-testid="cloud-schedule-unsupported">
            {scheduleErrorMessage("cloud_schedule_runtime_unsupported")}
          </p>
        )}
      </div>
      {touched && Object.entries(errors).filter(([field]) => field === "githubTrigger" || field === "cleanup").map(([field, message]) => <p key={field} role="alert">{message}</p>)}
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={confirmed} disabled={!agreeable} onChange={(event) => setAgreedKey(event.target.checked && agreeable ? quoteKey : null)} />
        <span>I understand this task starts the workspace and billed compute by itself, with nobody watching, at the cost shown above.</span>
      </label>
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving || !confirmed || !agreeable}>
          {saving ? <Loader2 className="animate-spin" /> : <CalendarClock />} Create scheduled task
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

let schedulesTarget: SchedulesTarget | null = null;
const schedulesListeners = new Set<() => void>();
const __subscribe_schedulesListeners = (listener: () => void) => { schedulesListeners.add(listener); return () => { schedulesListeners.delete(listener); }; };

export function openSchedulesDialog(target: SchedulesTarget | null) {
  if (schedulesTarget?.orgId !== target?.orgId || schedulesTarget?.workspaceId !== target?.workspaceId) {
    retireAutomationTargetScope();
  }
  // A reused A object after batched A -> B -> A still needs a new store snapshot.
  schedulesTarget = target ? { ...target } : null;
  for (const listener of [...schedulesListeners]) listener();
}

/** Mounted once (AppShell): the scheduled tasks dialog for `openSchedulesDialog`. */
export function CloudSchedulesDialogHost() {
  const target = useSyncExternalStore(
    __subscribe_schedulesListeners,
    () => schedulesTarget,
    () => null,
  );
  if (!target) return null;
  return <CloudSchedulesDialog key={`${target.orgId}:${target.workspaceId}`} {...target} onClose={() => openSchedulesDialog(null)} />;
}
