import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CalendarClock, Loader2, Pause, Play, Plus, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type CloudSchedule, type CloudScheduleQuote } from "@/lib/api";
import {
  PRESETS,
  SCHEDULE_LIMITS,
  SCHEDULE_MODES,
  WEEKDAYS,
  blankScheduleForm,
  costLines,
  describeTiming,
  modeNote,
  pausedText,
  resumeBlocked,
  runText,
  scheduleErrorMessage,
  scheduleFormErrors,
  scheduleInput,
  timezones,
  timingOf,
  validRunMinutes,
  whenText,
  type ScheduleForm,
} from "@/lib/cloudSchedules";
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
/** How long the form rests before its cost is asked for again. */
const ESTIMATE_DELAY_MS = 400;

export interface SchedulesTarget {
  orgId: string;
  workspaceId: string;
  name: string;
}

type Confirming = { kind: "resume" | "delete"; id: string } | { kind: "pause-all" } | null;

export function CloudSchedulesDialog({ orgId, workspaceId, name, onClose }: SchedulesTarget & { onClose: () => void }) {
  const [schedules, setSchedules] = useState<CloudSchedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [creating, setCreating] = useState(false);
  // Whether this workspace's runtime can take a scheduled run: the server
  // refuses to resume a task on one that cannot. null until it has said.
  const [runtimeSupported, setRuntimeSupported] = useState<boolean | null>(null);

  const reload = useCallback(async () => {
    try {
      setSchedules((await api.cloudSchedules(workspaceId, orgId)).schedules);
      setLoadError(null);
    } catch (e) {
      setLoadError(scheduleErrorMessage(errorCode(e)));
    }
  }, [orgId, workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Asked only when there is a paused task to offer Resume on. It reads the
  // workspace's record and wakes nothing.
  const hasPaused = schedules?.some((schedule) => schedule.state === "paused") ?? false;
  useEffect(() => {
    if (!hasPaused) return;
    let stale = false;
    api.cloudScheduleEstimate({ workspaceId, schedule: { preset: "daily", hour: 9, minute: 0, weekdays: [], timezone: "UTC" }, completionPolicy: "suspend", maxRunMinutes: SCHEDULE_LIMITS.defaultRunMinutes }, orgId).then(
      (answer) => {
        if (!stale) setRuntimeSupported(answer.supported);
      },
      // A server that cannot say: Resume stays offered, and its own refusal is shown.
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [hasPaused, orgId, workspaceId]);

  /** One change at a time; the list is read again after it, whatever became of it. */
  const act = async (key: string, work: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      setConfirming(null);
    } catch (e) {
      setError(scheduleErrorMessage(errorCode(e)));
    } finally {
      setBusy(null);
      await reload();
    }
  };

  const pause = (schedule: CloudSchedule) => act(schedule.id, async () => (await api.cloudScheduleSetActive(schedule.id, false, orgId), null));
  const resume = (schedule: CloudSchedule) => act(schedule.id, async () => (await api.cloudScheduleSetActive(schedule.id, true, orgId), null));
  const remove = (schedule: CloudSchedule) => act(schedule.id, async () => (await api.cloudScheduleDelete(schedule.id, orgId), null));
  const pauseAll = () =>
    act("pause-all", async () => {
      const { paused } = await api.cloudSchedulesPauseAll(orgId);
      return paused === 0 ? "No scheduled task of the organization was active." : `Paused ${paused} scheduled ${paused === 1 ? "task" : "tasks"} in the organization. Resume each one by hand.`;
    });

  const active = schedules?.filter((schedule) => schedule.state === "active").length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[40rem]" data-testid="cloud-schedules-dialog">
        <DialogHeader>
          <DialogTitle>Scheduled tasks for {name}</DialogTitle>
          <DialogDescription>
            A scheduled task wakes this workspace at set times and sends one prompt to an agent, with nobody watching. Each run starts billed compute by itself. Only
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
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="text-muted-foreground">{notice}</p>}
          {/* The form opens where its button was, not under the list. */}
          {creating && (
            <NewScheduleForm
              orgId={orgId}
              workspaceId={workspaceId}
              onCancel={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                void reload();
              }}
            />
          )}
          {!schedules && !loadError && <Loader2 className="size-4 animate-spin" />}
          {loadError && (
            <p className="text-destructive" data-testid="cloud-schedules-load-error">
              Could not load the scheduled tasks. {loadError}
            </p>
          )}
          {schedules && schedules.length === 0 && !creating && <p className="text-muted-foreground">This workspace has no scheduled tasks.</p>}
          {schedules && schedules.length > 0 && (
            <ul className="flex flex-col gap-2" data-testid="cloud-schedules-list">
              {schedules.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  busy={busy !== null}
                  resumeBlocked={resumeBlocked(schedule, runtimeSupported)}
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
  schedule: CloudSchedule;
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
  const paused = pausedText(schedule);
  const next = whenText(schedule.nextRunAt);
  const last = schedule.lastRun;
  return (
    <li className="flex flex-col gap-1 rounded-md border border-hairline px-3 py-2" data-testid={`cloud-schedule-${schedule.id}`}>
      <div className="flex min-w-0 items-center gap-2">
        <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium" title={schedule.name}>
          {schedule.name}
        </span>
        <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] ${paused ? "bg-well text-muted-foreground" : "bg-emerald-500/15 text-emerald-600"}`}>{paused ? "Paused" : "Active"}</span>
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
        {describeTiming(schedule.schedule)} · {schedule.agent}
        {schedule.mode ? ` · ${SCHEDULE_MODES.find((mode) => mode.id === schedule.mode)?.label ?? schedule.mode}` : ""} · stops after {schedule.maxRunMinutes} minutes
      </p>
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
        {costLines(schedule.estimate, schedule.maxRunMinutes)
          .slice(0, 2)
          .map((line) => (
            <li key={line}>{line}</li>
          ))}
      </ul>
      {confirming === "resume" && !blocked && (
        <p className="flex flex-wrap items-center gap-2 rounded-md bg-well/40 px-2 py-1.5" data-testid="cloud-schedule-resume-confirm">
          <span>Resuming starts billed compute by itself again, from the next time on, and the task then runs under your account.</span>
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
          <span>Delete this task, its prompt and its run history? The workspace itself is not touched.</span>
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

function NewScheduleForm({ orgId, workspaceId, onCancel, onCreated }: { orgId: string; workspaceId: string; onCancel: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<ScheduleForm>(blankScheduleForm);
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
  const [error, setError] = useState<string | null>(null);
  const models = offeredOn(useModels(form.agent), false);
  const model = models.find((item) => item.id === form.model);
  const zones = useMemo(() => {
    const listed = timezones();
    return listed.includes(form.timezone) || listed.length === 0 ? listed : [form.timezone, ...listed];
    // The zone list is the platform's; only the form's own zone can be missing from it.
  }, [form.timezone]);
  const update = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const errors = scheduleFormErrors(form);
  const shown = touched ? errors : {};

  // The cost depends on the times and two settings, not on the prompt: ask
  // again when one of those changes, after the form has rested a moment.
  const timing = timingOf(form);
  const timingKey = timing ? JSON.stringify(timing) : null;
  const { completionPolicy, maxRunMinutes } = form;
  const quoteKey = timingKey && validRunMinutes(maxRunMinutes) ? JSON.stringify([timingKey, completionPolicy, maxRunMinutes]) : null;
  useEffect(() => {
    if (!timingKey || !quoteKey) return;
    let stale = false;
    const timer = setTimeout(() => {
      api
        .cloudScheduleEstimate({ workspaceId, schedule: JSON.parse(timingKey), completionPolicy, maxRunMinutes }, orgId)
        .then(
          (answer) => {
            if (stale) return;
            setAnswered({ key: quoteKey, quote: answer });
            setQuoteError(null);
          },
          (e: unknown) => {
            if (stale) return;
            setAnswered(null);
            setQuoteError({ key: quoteKey, message: scheduleErrorMessage(errorCode(e)) });
          },
        );
    }, ESTIMATE_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [orgId, workspaceId, timingKey, quoteKey, completionPolicy, maxRunMinutes]);
  const quote = answered && answered.key === quoteKey ? answered.quote : null;
  const failed = quoteError && quoteError.key === quoteKey ? quoteError.message : null;

  const unsupported = quote?.supported === false;
  // What a create would be refused for whatever the form says: said with
  // the cost, before anyone agrees to it.
  const refusal = quote?.refusal ?? null;
  const agreeable = quote !== null && !unsupported && !refusal;
  // A changed cost has not been agreed to.
  const confirmed = agreeable && agreedKey !== null && agreedKey === quoteKey;
  const save = async () => {
    setTouched(true);
    const input = scheduleInput(form, workspaceId);
    if (!input || !confirmed || !agreeable) return;
    setSaving(true);
    setError(null);
    try {
      await api.cloudScheduleCreate(input, orgId);
      onCreated();
    } catch (e) {
      setError(scheduleErrorMessage(errorCode(e)));
    } finally {
      setSaving(false);
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
      <div className="flex flex-wrap items-center gap-2">
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
      {(shown.time || shown.weekdays) && <span className="text-destructive">{shown.time ?? shown.weekdays}</span>}
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
          <select aria-label="After a run" className={inputClass} value={form.completionPolicy} onChange={(event) => update("completionPolicy", event.target.value as ScheduleForm["completionPolicy"])}>
            <option value="suspend">Stop the workspace again</option>
            <option value="keep">Leave it running</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">A missed run</span>
          <select aria-label="A missed run" className={inputClass} value={form.missedRunPolicy} onChange={(event) => update("missedRunPolicy", event.target.value as ScheduleForm["missedRunPolicy"])}>
            <option value="skip">Is skipped</option>
            <option value="run-once">Runs once, late</option>
          </select>
        </label>
      </div>
      <div className="rounded-md bg-well/40 px-3 py-2" data-testid="cloud-schedule-cost">
        <p className="font-medium">What it costs</p>
        {quote ? (
          <ul className="text-muted-foreground">
            {costLines(quote.estimate, form.maxRunMinutes).map((line) => (
              <li key={line}>{line}</li>
            ))}
            {quote.nextRunAt && <li>First run {whenText(quote.nextRunAt)} (your time).</li>}
          </ul>
        ) : failed ? (
          <p className="text-destructive">The cost could not be read, so the task cannot be saved yet. {failed}</p>
        ) : timing && validRunMinutes(form.maxRunMinutes) ? (
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

export function openSchedulesDialog(target: SchedulesTarget | null) {
  schedulesTarget = target;
  for (const listener of [...schedulesListeners]) listener();
}

/** Mounted once (AppShell): the scheduled tasks dialog for `openSchedulesDialog`. */
export function CloudSchedulesDialogHost() {
  const target = useSyncExternalStore(
    (listener) => {
      schedulesListeners.add(listener);
      return () => schedulesListeners.delete(listener);
    },
    () => schedulesTarget,
    () => null,
  );
  if (!target) return null;
  return <CloudSchedulesDialog key={`${target.orgId}:${target.workspaceId}`} {...target} onClose={() => openSchedulesDialog(null)} />;
}
