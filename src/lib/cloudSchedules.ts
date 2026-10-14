import { useEffect, useSyncExternalStore } from "react";
import { api, type CloudSchedule, type CloudScheduleCreateInput, type CloudScheduleEstimate, type CloudScheduleRun, type CloudScheduleTiming } from "@/lib/api";

/**
 * Scheduled tasks of a cloud workspace (PRO-37, saas contract §24): what the
 * dialog says and checks, kept apart from how it is drawn.
 *
 * A scheduled task wakes its workspace at set times and sends one prompt to
 * an agent. The server keeps and runs it; only an organization's owners and
 * admins may make, pause, resume or delete one, and a private workspace's
 * schedules are its creator's alone.
 */

/**
 * The modes a scheduled agent may start in: the launch modes of
 * `PERMISSION_MODES` without bypass permissions, since nobody watches the
 * run. Listed here, not derived, so that nothing a schedule offers changes
 * when a mode is added there (a test holds the two together).
 */
export const SCHEDULE_MODES: { id: string; label: string; hint: string }[] = [
  { id: "plan", label: "Plan", hint: "Read and plan only; no edits or commands." },
  { id: "manual", label: "Ask every time", hint: "Every edit and command waits for an approval. With nobody watching, the run stops at the first one." },
  { id: "auto", label: "Auto", hint: "Routine actions are approved; risky ones ask." },
  { id: "acceptEdits", label: "Accept edits", hint: "File edits go through; commands still ask." },
];
export const SCHEDULE_DEFAULT_MODE = "acceptEdits";

/**
 * What the chosen mode means for a run nobody watches: an approval the
 * agent asks for has nobody to give it, so the run ends there.
 */
export function modeNote(mode: string): string {
  switch (mode) {
    case "manual":
      return "Ask every time stops at the agent's first edit or command: nobody is there to approve it, and the run ends as failed. Pick it only for a task that needs neither.";
    case "plan":
      return "Plan reads and plans only; the run ends with the plan and changes nothing.";
    case "acceptEdits":
      return "Accept edits lets file edits through. A command the agent has to ask for has nobody to approve it, and the run ends there as failed.";
    default:
      return "Auto approves routine actions. One it has to ask about has nobody to approve it, and the run ends there as failed.";
  }
}

export const SCHEDULE_LIMITS = { nameChars: 80, promptBytes: 32 * 1024, minRunMinutes: 5, maxRunMinutes: 240, defaultRunMinutes: 60 } as const;

export const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
] as const;

export const PRESETS: { value: CloudScheduleTiming["preset"]; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
];

const two = (value: number) => String(value).padStart(2, "0");

/** "Daily at 09:00 (Europe/Berlin)". */
export function describeTiming(timing: CloudScheduleTiming): string {
  const at = `${two(timing.hour)}:${two(timing.minute)} (${timing.timezone})`;
  switch (timing.preset) {
    case "hourly":
      return `Every hour at :${two(timing.minute)} (${timing.timezone})`;
    case "daily":
      return `Daily at ${at}`;
    case "weekdays":
      return `Monday to Friday at ${at}`;
    default: {
      const days = WEEKDAYS.filter((day) => timing.weekdays.includes(day.id)).map((day) => day.label);
      return `Weekly on ${days.join(", ") || "no day"} at ${at}`;
    }
  }
}

/** Money from the API's millionths of a currency unit: "$0.48", or "0.48 EUR" for a currency this machine cannot format. */
export function formatMicros(micros: number, currency: string): string {
  const amount = micros / 1_000_000;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: amount < 1 ? 4 : 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * What a scheduled task can cost and occupy, as the lines shown before it is
 * saved and next to it afterwards. They are upper bounds: a run that ends
 * early costs less, and a workspace someone already has running costs
 * nothing extra.
 *
 * "Up to" is the server's word: its figure covers every minute it lets a
 * run keep the workspace on (`perRunMaxMinutes`: the wait for the workspace
 * to start and take the run, the time limit, and the grace after it). A
 * server that does not state those minutes priced the time limit alone,
 * which is not a bound, and is not called one.
 */
export function costLines(estimate: CloudScheduleEstimate, maxRunMinutes: number): string[] {
  const { currency } = estimate;
  const rate = `${formatMicros(estimate.hourlyMicros, currency)} an hour`;
  const bounded = typeof estimate.perRunMaxMinutes === "number" && estimate.perRunMaxMinutes >= maxRunMinutes;
  const upTo = bounded ? "up to" : "about";
  const lines = [
    bounded
      ? `Each run wakes this workspace and can keep it on for up to ${estimate.perRunMaxMinutes} minutes (starting it, the ${maxRunMinutes}-minute limit, and ending the run): up to ${formatMicros(estimate.perRunMaxMicros, currency)} at ${rate}. The moment it takes to stop afterwards is not counted.`
      : `Each run wakes this workspace and costs about ${formatMicros(estimate.perRunMaxMicros, currency)} (${maxRunMinutes} minutes at ${rate}). Starting and stopping the workspace can add up to 25 minutes to a run, which is not in these figures.`,
  ];
  lines.push(
    estimate.keepsMachineRunning
      ? `The workspace is left running after a run, so this can cost up to ${formatMicros(estimate.monthlyMaxMicros, currency)} a month (the machine on all month) unless someone stops it or it goes idle.`
      : `About ${estimate.monthlyRuns} ${estimate.monthlyRuns === 1 ? "run" : "runs"} a month: ${upTo} ${formatMicros(estimate.monthlyMaxMicros, currency)} a month.`,
  );
  lines.push(`At most ${estimate.maxRunsPerDay} runs in any 24 hours. A run holds one of the organization's running-workspace slots while it runs.`);
  return lines;
}

const PAUSED: Record<string, string> = {
  "by-user": "Paused by a person.",
  "paused-all": "Paused with every other scheduled task of the organization.",
  "creator-not-manager": "Paused: the person it ran for is no longer an owner or admin.",
  "provider-disconnected": "Paused: the organization's compute provider is not connected.",
  "workspace-unavailable": "Paused: the workspace is archived or deleted.",
  "workspace-private": "Paused: the workspace became private and is not the task owner's.",
  "repeated-failures": "Paused after several runs in a row failed.",
  "needs-approval":
    "Paused: a run stopped at a permission request and nobody was there to answer it, so it was ended. It would stop there every time. Make the task again with a mode that asks less (Accept edits or Auto), or a prompt that needs no approval.",
  "cleanup-failed": "Paused: the workspace a run started could not be stopped again. Check that it is not still running.",
  "prompt-forbidden": "Paused: its prompt would run as a command in the agent's CLI.",
};

/**
 * Why a paused task cannot be resumed as it is, or null when it can. The
 * server would refuse these, or pause the task again at its next run:
 * nobody is offered a Resume that would only be refused.
 */
export function resumeBlocked(schedule: Pick<CloudSchedule, "state" | "pausedReason">, runtimeSupported: boolean | null = null): string | null {
  if (schedule.state !== "paused") return null;
  switch (schedule.pausedReason) {
    case "workspace-unavailable":
      return "Its workspace is archived or deleted, so it cannot run. Delete the task.";
    case "provider-disconnected":
      return "Connect the organization's compute provider first.";
    case "prompt-forbidden":
      return "Its prompt would be refused again. Delete the task and make it with a different prompt.";
    case "needs-approval":
      return ERRORS.cloud_schedule_needs_approval;
    default:
      return runtimeSupported === false ? ERRORS.cloud_schedule_runtime_unsupported : null;
  }
}

/** Why a task is not running, or null for an active one. */
export function pausedText(schedule: Pick<CloudSchedule, "state" | "pausedReason">): string | null {
  if (schedule.state !== "paused") return null;
  return (schedule.pausedReason && PAUSED[schedule.pausedReason]) ?? "Paused.";
}

const RUN_STATE: Record<string, string> = {
  queued: "Waiting to start",
  provisioning: "Starting the workspace",
  working: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  canceled: "Canceled",
  expired: "Not started",
};

const RUN_CATEGORY: Record<string, string> = {
  "timed-out": "it ran past its time limit and was stopped",
  "previous-run-active": "the previous run was still going",
  missed: "its time had passed",
  "daily-cap": "24 runs had already started in 24 hours",
  "not-dispatched": "nothing picked it up in time",
  "schedule-paused": "the task was paused",
  "needs-approval": "the agent asked for an approval and nobody was there to give it; a mode that asks less (Accept edits or Auto) may let it finish",
  "agent-credential-required": "the agent has no login in this workspace",
  "agent-unavailable": "the agent is not installed in this workspace",
  "agent-start-failed": "the agent did not start",
  "agent-failed": "the agent reported an error",
  "agent-exited": "the agent exited",
  "project-unavailable": "the project folder is missing",
  "runtime-error": "the workspace's runtime restarted or failed",
  "runtime-unsupported": "the workspace's runtime cannot run scheduled tasks",
  canceled: "its turn was stopped",
  "shell-command-forbidden": "its prompt is a shell command",
  "slash-command-forbidden": "its prompt is a slash command",
  "file-mention-forbidden": "its prompt mentions a file outside the project",
};

/** "Failed: it ran past its time limit and was stopped". */
export function runText(run: Pick<CloudScheduleRun, "state" | "category">): string {
  const state = RUN_STATE[run.state] ?? run.state;
  if (!run.category || run.state === "completed") return state;
  return `${state}: ${RUN_CATEGORY[run.category] ?? run.category}`;
}

/** A time in the reader's own zone: "Oct 12, 09:00". */
export function whenText(at: number | undefined | null): string | null {
  if (!at) return null;
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ERRORS: Record<string, string> = {
  organization_admin_required: "Only an owner or admin of the organization can manage scheduled tasks.",
  cloud_workspace_not_found: "That workspace or scheduled task no longer exists, or is private to someone else.",
  cloud_provider_connection_required: "The organization's compute provider is not connected, so nothing could be started.",
  cloud_schedule_runtime_unsupported: "This workspace's runtime cannot run scheduled tasks yet. Resume the workspace once so it updates, then try again.",
  cloud_schedule_cleanup_pending: "A run of this task is still starting or stopping its workspace. Pause the task, then delete it when the workspace has stopped.",
  cloud_schedule_prompt_shell_command: "The prompt starts with “!”, which the agent's CLI would run as a shell command with nobody watching. Write it as a request instead.",
  cloud_schedule_prompt_slash_command: "The prompt starts with a slash command, which changes what the agent may do. Write it as a request instead.",
  cloud_schedule_prompt_file_mention: "The prompt mentions a file outside the project with “@”. Mention only files inside the project.",
  cloud_schedule_needs_approval:
    "Its runs would stop at the same permission request again, and its mode and prompt cannot be changed. Delete the task and make it again with a mode that asks less (Accept edits or Auto), or a prompt that needs no approval.",
  cloud_workspace_quota_exceeded: "There are already as many scheduled tasks as allowed (10 per workspace, 50 per organization).",
  cloud_workspace_request_invalid: "The server did not accept those settings.",
  cloud_workspace_prompt_too_long: "The prompt is empty or longer than 32 KB.",
  cloud_workspace_unavailable: "The server could not be reached. Nothing was changed.",
  cloud_schedule_estimate_not_supported: "This server cannot say yet what a scheduled task costs, so a new one cannot be saved here. Tasks that exist can still be paused, resumed and deleted.",
};

export function scheduleErrorMessage(code: string): string {
  return ERRORS[code] ?? `That did not work (${code}).`;
}

export interface ScheduleForm {
  name: string;
  prompt: string;
  agent: string;
  model: string;
  effort: string;
  mode: string;
  preset: CloudScheduleTiming["preset"];
  /** "HH:MM", as a time input gives it. */
  time: string;
  weekdays: string[];
  timezone: string;
  maxRunMinutes: number;
  missedRunPolicy: "skip" | "run-once";
  completionPolicy: "suspend" | "keep";
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The zones offered in the form, the reader's own first; empty where the platform lists none. */
export function timezones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    return typeof supported === "function" ? supported.call(Intl, "timeZone") : [];
  } catch {
    return [];
  }
}

export function blankScheduleForm(): ScheduleForm {
  return {
    name: "",
    prompt: "",
    agent: "claude",
    model: "",
    effort: "",
    mode: SCHEDULE_DEFAULT_MODE,
    preset: "daily",
    time: "09:00",
    weekdays: ["mon"],
    timezone: localTimezone(),
    maxRunMinutes: SCHEDULE_LIMITS.defaultRunMinutes,
    missedRunPolicy: "skip",
    completionPolicy: "suspend",
  };
}

/** The form's times as the API takes them, or null while they are not a time. */
export function timingOf(form: Pick<ScheduleForm, "preset" | "time" | "weekdays" | "timezone">): CloudScheduleTiming | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(form.time);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) || !form.timezone) return null;
  if (form.preset === "weekly" && form.weekdays.length === 0) return null;
  return { preset: form.preset, hour: form.preset === "hourly" ? 0 : hour, minute, weekdays: form.preset === "weekly" ? WEEKDAYS.map((day) => day.id).filter((day) => form.weekdays.includes(day)) : [], timezone: form.timezone };
}

/** Whether the run limit is one the server takes. */
export function validRunMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= SCHEDULE_LIMITS.minRunMinutes && minutes <= SCHEDULE_LIMITS.maxRunMinutes;
}

/** What is wrong with the form, by field; empty when it can be sent. Checked here so the person is told before anything is sent. */
export function scheduleFormErrors(form: ScheduleForm): Partial<Record<"name" | "prompt" | "time" | "weekdays" | "maxRunMinutes" | "mode", string>> {
  const errors: ReturnType<typeof scheduleFormErrors> = {};
  const name = form.name.trim();
  if (!name) errors.name = "Give the task a name.";
  else if ([...name].length > SCHEDULE_LIMITS.nameChars) errors.name = `At most ${SCHEDULE_LIMITS.nameChars} characters.`;
  const prompt = form.prompt;
  const first = prompt.trimStart();
  if (!prompt.trim()) errors.prompt = "Write what the agent should do.";
  else if (new TextEncoder().encode(prompt).length > SCHEDULE_LIMITS.promptBytes) errors.prompt = "The prompt is longer than 32 KB.";
  else if (first.startsWith("!")) errors.prompt = scheduleErrorMessage("cloud_schedule_prompt_shell_command");
  if (form.preset === "weekly" && form.weekdays.length === 0) errors.weekdays = "Pick at least one day.";
  else if (!timingOf(form)) errors.time = "Enter a time such as 09:00.";
  if (!validRunMinutes(form.maxRunMinutes)) errors.maxRunMinutes = `Between ${SCHEDULE_LIMITS.minRunMinutes} and ${SCHEDULE_LIMITS.maxRunMinutes} minutes.`;
  if (!SCHEDULE_MODES.some((mode) => mode.id === form.mode)) errors.mode = "Pick a permission mode. A scheduled task cannot bypass permissions.";
  return errors;
}

/** The create request for a form that has no errors; null otherwise. */
export function scheduleInput(form: ScheduleForm, workspaceId: string): CloudScheduleCreateInput | null {
  const schedule = timingOf(form);
  if (!schedule || Object.keys(scheduleFormErrors(form)).length > 0) return null;
  return {
    workspaceId,
    name: form.name.trim(),
    agent: form.agent,
    ...(form.model ? { model: form.model } : {}),
    ...(form.effort ? { effort: form.effort } : {}),
    mode: form.mode,
    prompt: form.prompt,
    schedule,
    missedRunPolicy: form.missedRunPolicy,
    completionPolicy: form.completionPolicy,
    maxRunMinutes: form.maxRunMinutes,
  };
}

/**
 * Whether scheduled tasks are offered to this person in an organization:
 * the server has them turned on and the person may manage them. Asked once
 * per organization, by reading the list, which wakes nothing; until the
 * answer is in, and after a refusal, nothing is offered.
 */
export type SchedulesOffer = "unknown" | "offered" | "not-offered";

const offers = new Map<string, { offer: SchedulesOffer; askedAt: number }>();
const listeners = new Set<() => void>();
/** A refusal is asked about again after this long: the feature may have been turned on, or the person made an admin. */
const RECHECK_MS = 10 * 60_000;

function setOffer(orgId: string, offer: SchedulesOffer, askedAt: number) {
  offers.set(orgId, { offer, askedAt });
  for (const listener of [...listeners]) listener();
}

export function schedulesOffer(orgId: string): SchedulesOffer {
  return offers.get(orgId)?.offer ?? "unknown";
}

export function probeSchedules(orgId: string, now = Date.now()): Promise<void> {
  const known = offers.get(orgId);
  if (known && (known.offer === "offered" || now - known.askedAt < RECHECK_MS)) return Promise.resolve();
  offers.set(orgId, { offer: known?.offer ?? "unknown", askedAt: now });
  return Promise.resolve()
    .then(() => api.cloudSchedules(null, orgId))
    .then(
      () => setOffer(orgId, "offered", now),
      () => setOffer(orgId, "not-offered", now),
    );
}

/**
 * A private workspace's tasks are its creator's alone, and the organization's
 * list does not say whose a workspace is. So for a private workspace the
 * server is asked about that workspace: an estimate, which reads and wakes
 * nothing and answers "not found" to an admin it is merely shared with.
 */
const PROBE_TIMING: CloudScheduleTiming = { preset: "daily", hour: 9, minute: 0, weekdays: [], timezone: "UTC" };
const workspaceKey = (orgId: string, workspaceId: string) => `${orgId}\n${workspaceId}`;

export function probeWorkspaceSchedules(orgId: string, workspaceId: string, now = Date.now()): Promise<void> {
  const key = workspaceKey(orgId, workspaceId);
  const known = offers.get(key);
  if (known && (known.offer === "offered" || now - known.askedAt < RECHECK_MS)) return Promise.resolve();
  offers.set(key, { offer: known?.offer ?? "unknown", askedAt: now });
  return Promise.resolve()
    .then(() => api.cloudScheduleEstimate({ workspaceId, schedule: PROBE_TIMING, completionPolicy: "suspend", maxRunMinutes: SCHEDULE_LIMITS.defaultRunMinutes }, orgId))
    .then(
      () => setOffer(key, "offered", now),
      () => setOffer(key, "not-offered", now),
    );
}

export function resetSchedulesOffers() {
  offers.clear();
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * `schedulesOffer`, asked for when first needed. With a private workspace's
 * id, the offer also needs the server's word on that workspace.
 */
export function useSchedulesOffer(orgId: string, enabled = true, privateWorkspaceId: string | null = null): SchedulesOffer {
  const organization = useSyncExternalStore(
    subscribe,
    () => schedulesOffer(orgId),
    () => "unknown" as const,
  );
  const workspace = useSyncExternalStore(
    subscribe,
    () => (privateWorkspaceId ? schedulesOffer(workspaceKey(orgId, privateWorkspaceId)) : ("offered" as const)),
    () => "unknown" as const,
  );
  useEffect(() => {
    if (!enabled) return;
    void probeSchedules(orgId);
    if (privateWorkspaceId && organization === "offered") void probeWorkspaceSchedules(orgId, privateWorkspaceId);
  }, [orgId, enabled, privateWorkspaceId, organization]);
  return organization === "offered" ? workspace : organization;
}
