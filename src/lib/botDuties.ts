import { invoke } from "@/lib/api";
import { describeSchedule } from "@/lib/automationSchedule";
import type { Automation, AutomationPrecheck, AutomationRun, PrecheckTrial } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { DutyInput, DutyReportsTo, DutyState, QuietHours } from "@/types/botDuties";

/**
 * A bot's duties (PRO-471). A duty is an ordinary automation that names its bot (`automation.bot`), so the duties and
 * their runs arrive with the automations (`automations_changed`, `automation_run`). These calls change them, each
 * through the window's own route: what gives the bot more (adding, editing, running or switching a duty on, quiet
 * hours) carries a person's proof. Every one is refused while Settings → Experimental → Bots is off.
 */
export const dutiesApi = {
  /** The bot's quiet hours, each duty's note, and the home its first checks run in. */
  state: (id: string) => invoke<DutyState>("bot_duties", { id }),
  save: (id: string, dutyId: string | null, input: DutyInput) => invoke<Automation>("bot_duty_save", { id, dutyId, input }),
  switch: (id: string, dutyId: string, on: boolean) => invoke<Automation>("bot_duty_switch", { id, dutyId, on }),
  remove: (id: string, dutyId: string) => invoke<void>("bot_duty_delete", { id, dutyId }),
  /** A copy, switched off. */
  duplicate: (id: string, dutyId: string) => invoke<Automation>("bot_duty_duplicate", { id, dutyId }),
  /** The first check, then the bot only when the check found something. */
  run: (id: string, dutyId: string) => invoke<AutomationRun>("bot_duty_run", { id, dutyId }),
  /** The first check once, where the duty's runs run it: its own empty folder, as you. Nothing is recorded. */
  tryCheck: (id: string, dutyId: string | null, precheck: AutomationPrecheck) => invoke<PrecheckTrial>("bot_duty_try_check", { id, dutyId, precheck }),
  quietHours: (id: string, quietHours: QuietHours | null) => invoke<{ quietHours: QuietHours | null }>("bot_quiet_hours", { id, quietHours }),
};

/** Whether an automation is a bot's duty, listed under its bot rather than on the Automations page. */
export function isDuty(automation: Pick<Automation, "bot">): boolean {
  return !!automation.bot;
}

/**
 * Whether the Automations page lists `automation`: every automation that is not a duty, and a duty whose bot is gone
 * for certain (the bots were read, none is unreadable, and its bot is not among them), so it can still be removed.
 * While Bots is off the bots cannot be read, and a duty stays off the page.
 */
export function shownOnAutomations(
  automation: Pick<Automation, "bot">,
  bots: { loaded: boolean; error: string | null; unreadable: number; bots: readonly Pick<Bot, "id">[] },
): boolean {
  const id = automation.bot?.id;
  if (!automation.bot) return true;
  return bots.loaded && !bots.error && bots.unreadable === 0 && !bots.bots.some((bot) => bot.id === id);
}

/** The variable a duty's first check finds its bot's home in (`bots::duties::HOME_ENV`). */
export const HOME_ENV = "TERMINALX_BOT_HOME";

/**
 * Whether a first check names something in the bot's home, which the bot can change: the home's path, the variable
 * that holds it, or a bot's home under `~/.raccoon/bots`. The check runs in a folder of its own, as the owner, so only
 * a command that reaches into the home on purpose runs what the bot last wrote there. A guess, for a warning only.
 */
export function checkRunsHomeFile(command: string, home: string | null): boolean {
  if (command.includes("$" + HOME_ENV) || command.includes("${" + HOME_ENV + "}")) return true;
  if (home && command.includes(home)) return true;
  return /(~|\$HOME|\$\{HOME\})\/\.raccoon\/bots\//.test(command);
}

/** The duties of bot `botId`, oldest first: the order they were added in. */
export function dutiesOf(automations: readonly Automation[], botId: string): Automation[] {
  return automations.filter((automation) => automation.bot?.id === botId).sort((a, b) => a.created.localeCompare(b.created));
}

/** The Reports to targets a duty may choose now, and the ones that come with the channel tickets. */
export const REPORT_TARGETS: { id: DutyReportsTo; label: string; ready: boolean }[] = [
  { id: "terminalx", label: "TerminalX", ready: true },
  { id: "lead", label: "Its lead", ready: true },
  { id: "slack", label: "Slack", ready: false },
  { id: "telegram", label: "Telegram", ready: false },
  { id: "pullRequest", label: "The pull request", ready: false },
];

/** Where a duty reports, in words: TerminalX, the lead's name, or a target a newer app wrote as it is. */
export function reportsToLabel(reportsTo: DutyReportsTo | undefined, bot: Pick<Bot, "reportsTo">, bots: readonly Pick<Bot, "id" | "name">[]): string {
  if (!reportsTo || reportsTo === "terminalx") return "TerminalX";
  if (reportsTo === "lead") {
    if (bot.reportsTo === "owner") return "TerminalX (it reports to you)";
    return bots.find((other) => other.id === bot.reportsTo)?.name ?? "Its lead";
  }
  const known = REPORT_TARGETS.find((target) => target.id === reportsTo);
  return `${known?.label ?? reportsTo} (TerminalX here)`;
}

/** What wakes a duty, in words. */
export function wakesOn(duty: Pick<Automation, "schedule" | "issueTrigger" | "eventTrigger">): string {
  if (duty.eventTrigger || duty.issueTrigger) return "An event";
  return describeSchedule(duty.schedule);
}

/** The first line of what the check printed, or `null` when it printed nothing or did not run. */
export function checkFound(run: Pick<AutomationRun, "precheck">): string | null {
  const line = run.precheck?.stdoutTail.split("\n").map((value) => value.trim()).find(Boolean);
  return line ?? null;
}

/** When a run happened, for the log: its newest repeat, else when it ended or started. */
export function runAt(run: Pick<AutomationRun, "lastRepeatAt" | "endedAt" | "startedAt" | "scheduledFor">): string | null {
  return run.lastRepeatAt ?? run.endedAt ?? run.startedAt ?? run.scheduledFor ?? null;
}

/** What happened after the check, in a few words. `lead` names the bot a report went to. */
export function runOutcome(run: AutomationRun, lead: (id: string) => string | null): string {
  switch (run.status) {
    case "pending":
      return run.precheck ? "Starting…" : "Checking…";
    case "running":
      return "Looking…";
    case "skippedPrecheck":
      return "Nothing new";
    case "failed":
      return run.error ? `Failed: ${run.error}` : "Failed";
    case "timedOut":
      return "Timed out";
    case "cancelled":
      return run.error ?? "Cancelled";
    case "skippedMissed":
      return "Missed: the app was closed";
    case "skippedUnavailable":
      return run.error ?? "The agent was not available";
    case "completed": {
      const report = run.duty;
      if (!report?.reportedTo) return "Done";
      if (report.reportedTo === "nobody") return "Nothing new";
      if (report.reportedTo === "owner") return report.urgent ? "Reported, urgent" : report.quiet && !report.notified ? "Reported, in quiet hours" : "Reported";
      return `Told ${lead(report.reportedTo) ?? "its lead"}`;
    }
  }
}

/** Whether a run reported something to someone. */
export function reported(run: AutomationRun): boolean {
  return run.status === "completed" && !!run.duty?.reportedTo && run.duty.reportedTo !== "nobody";
}

/** How long a run took, in milliseconds, when it ended. */
export function runTook(run: Pick<AutomationRun, "startedAt" | "endedAt" | "precheck">): number | null {
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const ended = run.endedAt ? Date.parse(run.endedAt) : NaN;
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) return ended - started;
  return run.precheck?.durationMs ?? null;
}

export function tookText(ms: number | null): string {
  if (ms == null) return "–";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function sameDay(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  const at = new Date(iso);
  return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
}

function sameMonth(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  const at = new Date(iso);
  return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth();
}

/** Whether a run counts as a wake: something was looked at, not a time that passed while paused or closed. */
function woke(run: AutomationRun): boolean {
  return run.status !== "skippedMissed" && !(run.status === "cancelled" && !run.precheck && !run.sessionId);
}

/**
 * Today's counts on this computer's clock. A row that folds repeats ("Nothing new" again) counts each repeat when it
 * was first written today, and once when only its last repeat was.
 */
export function todayCounts(runs: readonly AutomationRun[], now = new Date()): { checks: number; nothingNew: number; reports: number } {
  let checks = 0;
  let nothingNew = 0;
  let reports = 0;
  for (const run of runs) {
    if (!woke(run)) continue;
    const first = run.endedAt ?? run.startedAt ?? null;
    const times = sameDay(first, now) ? run.repeatCount || 1 : sameDay(run.lastRepeatAt ?? null, now) ? 1 : 0;
    if (!times) continue;
    checks += times;
    if (run.status === "skippedPrecheck" || run.duty?.reportedTo === "nobody") nothingNew += times;
    if (reported(run)) reports += times;
  }
  return { checks, nothingNew, reports };
}

/** What the runs' sessions spent today and this month, `spent` reading one session's cost. */
export function dutySpend(runs: readonly AutomationRun[], spent: (sessionId: string) => number | null, now = new Date()): { today: number; month: number } {
  let today = 0;
  let month = 0;
  for (const run of runs) {
    if (!run.sessionId) continue;
    const cost = spent(run.sessionId) ?? 0;
    const at = run.startedAt ?? run.endedAt ?? null;
    if (sameDay(at, now)) today += cost;
    if (sameMonth(at, now)) month += cost;
  }
  return { today, month };
}

/** Whether `minutes` past local midnight is inside quiet hours, across midnight when `to` is earlier. */
export function inQuietHours(quiet: QuietHours | null, minutes: number): boolean {
  if (!quiet) return false;
  const read = (text: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(text);
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const from = read(quiet.from);
  const to = read(quiet.to);
  if (from == null || to == null || from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** A local clock time, `13:20`, from an ISO time. */
export function clockOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A new duty's starting state: weekdays at nine, no first check, reported in TerminalX, on. */
export function newDutyInput(): DutyInput {
  return {
    name: "",
    prompt: "",
    schedule: {
      kind: "preset",
      preset: "weekdays",
      hour: 9,
      minute: 0,
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      dtstart: new Date().toISOString(),
    },
    precheck: null,
    reportsTo: "terminalx",
    enabled: true,
  };
}

/** A saved duty as the editor starts from it. */
export function dutyInputOf(duty: Automation): DutyInput {
  return {
    name: duty.name,
    prompt: duty.prompt,
    schedule: duty.schedule,
    precheck: duty.precheck ?? null,
    reportsTo: duty.bot?.reportsTo ?? "terminalx",
    enabled: duty.enabled,
    ...(duty.bot?.builtin ? { focus: duty.bot.focus ?? null } : {}),
  };
}
