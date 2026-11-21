import { useState, type ReactNode } from "react";
import { AppWindow, CalendarClock, ChevronLeft, Copy, Loader2, Pause, Pencil, Play, Sparkles, Trash2, Zap } from "@/icons";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { errorMessage } from "@/lib/api";
import { describeSchedule, nextWallTime, relativeNext } from "@/lib/automationSchedule";
import {
  checkFound,
  checkRunsHomeFile,
  clockOf,
  dutiesApi,
  dutySpend,
  lastRun,
  reported,
  reportsToLabel,
  runAt,
  runOutcome,
  runTook,
  todayCounts,
  tookText,
  wakeOf,
  wakesOn,
} from "@/lib/botDuties";
import { useAutomationStore } from "@/lib/automations";
import { builtinOf } from "@/lib/botSuggestions";
import { cn } from "@/lib/cn";
import { confirmInApp } from "@/lib/confirm";
import { formatCost } from "@/lib/stats";
import { accessLabel } from "./botLabels";
import type { Automation, AutomationRun } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { DutyState } from "@/types/botDuties";
import { quietText } from "./BotDuties";

/**
 * One duty (PRO-471, design 23.10): what happens each time in four steps (wakes on, first checks, then the bot looks,
 * reports to), its runs, and beside them how it runs, what it remembers and the bot's quiet hours.
 */
export function BotDuty({ bot, bots, duty, runs, state, spent, leadName, onBack, onEdit, onOpenSession, onOpenDuty, onChanged }: {
  bot: Bot;
  bots: readonly Bot[];
  duty: Automation;
  runs: readonly AutomationRun[];
  state: DutyState | null;
  spent: (sessionId: string) => number | null;
  leadName: (id: string) => string | null;
  onBack: () => void;
  onEdit: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Open another duty's page: with the duty itself when it was just made, before the store lists it. */
  onOpenDuty: (id: string, duty?: Automation) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What failed, to send again once a restarted runtime can confirm it.
  const [failed, setFailed] = useState<{ name: string; action: () => Promise<unknown> } | null>(null);
  const act = (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    action().then(
      () => { setError(null); setFailed(null); onChanged(); },
      (cause) => { setError(errorMessage(cause)); setFailed({ name, action }); },
    ).finally(() => setBusy(null));
  };
  const remove = async () => {
    const yes = await confirmInApp({ title: `Remove "${duty.name}"?`, body: `${bot.name} stops doing it, and its runs are removed with it. Its note stays in ${bot.name}'s home.`, action: "Remove", destructive: true });
    if (yes) act("remove", () => dutiesApi.remove(bot.id, duty.id).then(onBack));
  };
  const last = lastRun(runs);
  const today = todayCounts(runs);
  const spend = dutySpend(runs, spent);
  const note = state?.notes[duty.id] ?? null;
  const reportsTo = reportsToLabel(duty.bot?.reportsTo, bot, bots);
  const status = !duty.enabled ? "Off" : bot.paused ? "Paused with its bot" : "On";
  // A built-in (PRO-477) is switched off, never removed or copied.
  const builtin = builtinOf(duty);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5 scrollbar-thin" data-testid="bot-duty">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 rounded-md text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" data-testid="duty-back">
          <ChevronLeft className="size-3.5" /> Duties
        </button>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="duty-actions">
          {!builtin && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void remove()} aria-label={`Remove ${duty.name}`}><Trash2 /></Button>}
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act("switch", () => dutiesApi.switch(bot.id, duty.id, !duty.enabled))} data-testid="duty-switch">
            {duty.enabled ? <><Pause /> Pause</> : <><Play /> Switch on</>}
          </Button>
          {!builtin && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act("duplicate", () => dutiesApi.duplicate(bot.id, duty.id).then((copy) => onOpenDuty(copy.id, copy)))}><Copy /> Duplicate</Button>}
          <Button size="sm" disabled={!!busy || !!bot.paused} title={bot.paused ? `${bot.name} is paused` : undefined} onClick={() => act("run", () => dutiesApi.run(bot.id, duty.id))} data-testid="duty-run">
            {busy === "run" ? <Loader2 className="animate-spin" /> : <Play />} Run now
          </Button>
        </div>
      </div>
      <h2 className="mt-3 flex min-w-0 items-baseline gap-2 text-[17px] font-semibold text-foreground">
        <span className="truncate" title={duty.name}>{duty.name}</span>
        {builtin && <Chip title="Every bot has it. Switch it off to stop it." data-testid="duty-builtin">Built in</Chip>}
        <span className={cn("shrink-0 text-[12.5px] font-normal", duty.enabled && !bot.paused ? "text-success" : "text-faint")} data-testid="duty-status">· {status}</span>
      </h2>
      {error && <MachineHostError error={error} onRestarted={() => { setError(null); if (failed) act(failed.name, failed.action); }} className="mt-3" />}

      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2" data-testid="duty-stats">
        <Card label="Last run" value={last ? clockOf(runAt(last)) || "–" : "Never"} detail={last ? runOutcome(last, leadName) : "It has not run yet"} />
        {wakeOf(duty) ? (
          <Card label="Next run" value={duty.enabled && !bot.paused ? "On event" : "–"} detail={duty.enabled ? (bot.paused ? "Events wait until you resume" : "When something it waits for happens") : "Switched off"} />
        ) : (
          <Card label="Next run" value={duty.enabled && !bot.paused ? nextWallTime(duty.nextRunAt, duty.schedule.timezone) || "–" : "–"} detail={duty.enabled ? (bot.paused ? "Not while paused" : relativeNext(duty.nextRunAt)) : "Switched off"} />
        )}
        <Card label="Today" value={`${today.checks} checks`} detail={`${today.reports} reported · ${today.nothingNew} nothing new`} />
        <Card label="Spend" value={`${formatCost(spend.today)} today`} detail={`${formatCost(spend.month)} this month`} />
      </div>

      <div className="mt-6 flex flex-wrap gap-x-8 gap-y-6">
        <div className="min-w-0 flex-[1_1_520px]">
          <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">What happens each time</h3>
          <ol className="mt-2 flex flex-col gap-2" data-testid="duty-steps">
            {wakeOf(duty) ? (
              <Step n={1} icon={<CalendarClock />} title="Wakes on an event" action={<Button size="xs" variant="ghost" onClick={onEdit} data-testid="duty-edit"><Pencil /> Edit</Button>}>
                <p className="text-muted-foreground">{wakesOn(duty, leadName)}</p>
                <WakeStatus duty={duty} />
              </Step>
            ) : (
              <Step n={1} icon={<CalendarClock />} title="Wakes on a schedule" action={<Button size="xs" variant="ghost" onClick={onEdit} data-testid="duty-edit"><Pencil /> Edit</Button>}>
                <p className="text-muted-foreground">{describeSchedule(duty.schedule)}{duty.schedule.kind === "cron" && duty.schedule.cron ? <span className="ml-1.5 font-mono text-faint">{duty.schedule.cron}</span> : null}</p>
              </Step>
            )}
            <Step n={2} icon={<Zap />} title="First checks" tag="a script · no model · free">
              {duty.precheck ? (
                <>
                  <pre className="overflow-x-auto rounded-md bg-well px-2.5 py-1.5 font-mono text-[12px] text-foreground scrollbar-thin">{duty.precheck.command}</pre>
                  <p className="mt-1.5 text-faint">If the script prints nothing, the duty ends here. Nobody is told and nothing is spent.</p>
                  {checkRunsHomeFile(duty.precheck.command, state?.home ?? duty.projectPath) && <HomeFileWarning bot={bot} />}
                </>
              ) : (
                <p className="text-faint">No first check: the model looks every time it wakes.</p>
              )}
            </Step>
            <Step n={3} icon={<Sparkles />} title={`Then ${bot.name} looks`} tag={duty.precheck ? "the model · only when the check found something" : "the model"}>
              {builtin ? (
                <p className="text-muted-foreground">
                  {builtin === "tidyMemory"
                    ? "Merges duplicate notes and removes the ones newer notes contradict, as one change you can undo in Memory."
                    : <>Reads what changed and suggests work on its Home tab. It may only read: TerminalX refuses anything else and tells it to suggest it instead.{duty.bot?.focus ? <span className="mt-1 block text-foreground">Focus: {duty.bot.focus}</span> : null}</>}
                </p>
              ) : (
                <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{duty.prompt}</p>
              )}
            </Step>
            <Step n={4} icon={<AppWindow />} title="Reports to">
              <p className="text-muted-foreground">{reportsTo}</p>
              <p className="mt-1 text-faint">A reply of “Nothing new.” tells nobody. A reply that starts “URGENT:” reaches your notifications even in quiet hours.</p>
            </Step>
          </ol>

          <h3 className="mt-6 text-[11px] font-medium tracking-[.06em] text-faint uppercase">Runs</h3>
          {runs.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-faint">No runs yet.</p>
          ) : (
            <div className="mt-2 min-w-0 overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[560px] border-collapse text-[12.5px]" aria-label={`${duty.name} runs`} data-testid="duty-runs">
                <thead>
                  <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-[.06em] text-faint">
                    <th scope="col" className="px-2 py-2 font-medium">When</th>
                    <th scope="col" className="px-2 py-2 font-medium">The check found</th>
                    <th scope="col" className="px-2 py-2 font-medium">Then</th>
                    <th scope="col" className="px-2 py-2 font-medium">Took</th>
                    <th scope="col" className="px-2 py-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const cost = run.sessionId ? spent(run.sessionId) : null;
                    // A check that failed found nothing: what it said on its error output is shown instead.
                    const complaint = run.status === "failed" ? run.precheck?.stderrTail.split("\n").map((line) => line.trim()).find(Boolean) ?? null : null;
                    const found = checkFound(run) ?? complaint;
                    return (
                      <tr key={run.runId} className="border-b border-hairline" data-testid="duty-run-row" data-status={run.status}>
                        <td className="px-2 py-2 whitespace-nowrap font-mono text-faint tabular-nums">{clockOf(runAt(run)) || "–"}{run.repeatCount > 1 ? ` ×${run.repeatCount}` : ""}</td>
                        <td className="px-2 py-2"><span className="block max-w-[240px] truncate text-muted-foreground" title={run.precheck?.stdoutTail || undefined}>{found ?? (run.precheck ? "Nothing" : "–")}</span></td>
                        <td className="px-2 py-2">
                          {run.sessionId ? (
                            <button type="button" onClick={() => onOpenSession(run.sessionId!)} className={cn("block max-w-[240px] truncate text-left hover:underline", reported(run) ? "text-foreground" : "text-muted-foreground")}>{runOutcome(run, leadName)}</button>
                          ) : (
                            <span className={cn("block max-w-[240px] truncate", run.status === "failed" ? "text-destructive" : "text-muted-foreground")} title={run.error ?? undefined}>{runOutcome(run, leadName)}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap text-faint tabular-nums">{tookText(runTook(run))}</td>
                        <td className="px-2 py-2 whitespace-nowrap font-mono text-faint tabular-nums">{run.sessionId ? formatCost(cost ?? 0) : "free"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="flex w-[280px] min-w-0 shrink-0 flex-col gap-5 text-[12.5px]" aria-label="How it runs" data-testid="duty-aside">
          <section>
            <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">How it runs</h3>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              {/* Its runs use the bot's model as it is now (`duties::bind`), not the one stored with the duty (PRO-492). */}
              <Fact label="Model">{bot.model || "The agent's default"}</Fact>
              <Fact label="Runs on">This Mac, in {bot.name}'s home</Fact>
              <Fact label="Conversation">New each time</Fact>
              <Fact label="Access">{accessLabel(bot.access)}</Fact>
              <Fact label="If it fails">You are told, outside quiet hours</Fact>
            </dl>
          </section>
          <section aria-label="Remembers between runs">
            <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">Remembers between runs</h3>
            <p className="mt-1 text-faint">Kept by the duty, so the same news is not sent twice.</p>
            {note && "text" in note ? (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-well px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground scrollbar-thin" data-testid="duty-note">{note.text}{note.cut ? "\n…" : ""}</pre>
            ) : note && "unreadable" in note ? (
              <p className="mt-2 text-destructive">The note cannot be read: {note.unreadable}</p>
            ) : (
              <p className="mt-2 text-muted-foreground">Nothing yet.</p>
            )}
          </section>
          <section aria-label="Quiet hours">
            <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">Quiet hours</h3>
            <p className="mt-1 text-muted-foreground">Follows {bot.name}: {quietText(state?.quietHours ?? null)}</p>
          </section>
          <section>
            <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">Made by</h3>
            <p className="mt-1 text-muted-foreground">{duty.bot?.template ? `${bot.roleTitle}'s role, at hire` : "You"}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** The check runs a file the bot can change, as the owner and without asking. */
export function HomeFileWarning({ bot }: { bot: Pick<Bot, "name"> }) {
  return (
    <p role="note" className="mt-1.5 rounded-md bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning" data-testid="duty-home-file">
      This check runs a file in {bot.name}'s home, which {bot.name} can change. It runs as you, on its schedule, without asking and outside {bot.name}'s access. Keep the script outside the home, or check what it does.
    </p>
  );
}

function Card({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-card px-3 py-2.5" data-testid="duty-stat">
      <p className="text-[11px] text-faint">{label}</p>
      <p className="mt-0.5 truncate text-[14px] font-semibold text-foreground tabular-nums">{value}</p>
      <p className="truncate text-[11.5px] text-faint">{detail}</p>
    </div>
  );
}

function Step({ n, icon, title, tag, action, children }: { n: number; icon: ReactNode; title: string; tag?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3 rounded-lg border border-hairline bg-card px-3 py-2.5 text-[12.5px]" data-testid="duty-step">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-veil text-[11px] text-muted-foreground tabular-nums">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
          <span className="truncate font-medium text-foreground">{title}</span>
          {tag && <span className="truncate text-[11.5px] text-faint">{tag}</span>}
          {action && <span className="ml-auto shrink-0">{action}</span>}
        </div>
        <div className="mt-1.5 min-w-0">{children}</div>
      </div>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-muted-foreground">{children}</dd>
    </>
  );
}

/** How an event duty's source last read: when, why it could not, and what it holds back (`automation_issue_state`). */
function WakeStatus({ duty }: { duty: Automation }) {
  const status = useAutomationStore().issueStates[duty.id];
  if (!status) return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5 text-[11.5px]" data-testid="duty-wake-status">
      {status.lastPolledAt && <span className="text-faint">Last looked at {clockOf(status.lastPolledAt)}</span>}
      {status.lastPollError && <span className="text-destructive">{status.lastPollError}</span>}
      {status.notice && <span className="text-muted-foreground">{status.notice}</span>}
    </div>
  );
}
