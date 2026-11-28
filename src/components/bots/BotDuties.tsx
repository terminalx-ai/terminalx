import { useCallback, useEffect, useMemo, useState } from "react";
import { AppWindow, CalendarClock, CircleDot, Github, Hash, Hourglass, Link, Loader2, Moon, Plus, Send, Users, Zap } from "@/icons";
import { Button } from "@/components/ui/button";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { loadAutomationRuns, useAutomationStore } from "@/lib/automations";
import { relativeNext } from "@/lib/automationSchedule";
import { checkFound, clockOf, dutiesApi, dutiesOf, lastRun, reportsToLabel, runAt, runOutcome, todayCounts, wakeFamily, wakeOf, wakesOn } from "@/lib/botDuties";
import { useBotStore } from "@/lib/bots";
import { cn } from "@/lib/cn";
import { sessionSpend } from "@/lib/runFamily";
import { formatCost } from "@/lib/stats";
import { useSessionStore } from "@/lib/sessions";
import type { Automation, AutomationRun } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { DutyInput, DutyState, QuietHours } from "@/types/botDuties";
import { dutyAt } from "@/lib/botCalendar";
import { builtinOf } from "@/lib/botSuggestions";
import { BotDuty } from "./BotDuty";
import { BotDutyEditor } from "./BotDutyEditor";
import type { WakeGroup } from "./BotDutyWake";
import { DutiesCalendar, DutiesViewSwitch, type DutiesView } from "./DutiesCalendar";

type Screen = { kind: "list" } | { kind: "duty"; id: string } | { kind: "edit"; id: string | null; initial?: DutyInput; start?: WakeGroup };

/** List or Calendar (PRO-473), as last chosen on a bot's Duties tab while the app runs. */
let lastView: DutiesView = "list";

/**
 * What wakes a bot, as the "Add a duty" tiles offer it (PRO-472). Each ready one opens the editor on its source;
 * Slack, Telegram or WhatsApp and webhooks need a connector, which comes with the channel tickets.
 */
const WAKES: { label: string; note: string; icon: typeof CalendarClock; group: WakeGroup | null }[] = [
  { label: "A schedule", note: "daily, hourly, cron", icon: CalendarClock, group: "schedule" },
  { label: "GitHub", note: "PR, check, alert, mention", icon: Github, group: "github" },
  { label: "Linear", note: "issue, comment, mention", icon: CircleDot, group: "linear" },
  { label: "Slack", note: "message, mention, reaction", icon: Hash, group: null },
  { label: "Telegram or WhatsApp", note: "a message to this bot", icon: Send, group: null },
  { label: "A webhook", note: "any service that can POST", icon: Link, group: null },
  { label: "Another bot", note: "handoff, question, status", icon: Users, group: "bot" },
  { label: "Wait until", note: "a URL, file or check changes", icon: Hourglass, group: "watch" },
];

/** The icon for what wakes a duty. */
export function wakeIcon(duty: Automation): typeof CalendarClock {
  const wake = wakeOf(duty);
  if (!wake) return CalendarClock;
  return { github: Github, linear: CircleDot, bot: Users, watch: Hourglass, unknown: Zap }[wakeFamily(wake.source)];
}

/** The bot's duty settings and notes, read again whenever its duties or their runs change. */
export function useDutyState(botId: string, key: string): { state: DutyState | null; error: string | null; reload: () => void } {
  const [state, setState] = useState<DutyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    dutiesApi.state(botId).then((value) => { if (live) { setState(value); setError(null); } }, (cause) => { if (live) setError(errorMessage(cause)); });
    return () => { live = false; };
  }, [botId, key, tick]);
  return { state, error, reload: useCallback(() => setTick((value) => value + 1), []) };
}

/** Every run of `duties`, newest first, read once and then kept live by the automation store. */
export function useDutyRuns(duties: readonly Automation[]): Record<string, AutomationRun[]> {
  const store = useAutomationStore();
  const ids = duties.map((duty) => duty.id).join(",");
  useEffect(() => {
    for (const id of ids.split(",").filter(Boolean)) void loadAutomationRuns(id).catch(() => {});
  }, [ids]);
  return store.runs;
}

/**
 * A bot's Duties tab (PRO-471, design 23.05): its duties as a table, the tiles to add one, and beside them today's
 * counts, the log of runs (nothing-new ones included) and its quiet hours. A duty opens on its own page (23.10).
 */
export function BotDuties({ bot, onOpenSession }: { bot: Bot; onOpenSession: (sessionId: string) => void }) {
  const automations = useAutomationStore();
  const bots = useBotStore();
  const sessions = useSessionStore();
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [view, setView] = useState<DutiesView>(lastView);
  const choose = (next: DutiesView) => {
    lastView = next;
    setView(next);
  };
  const duties = useMemo(() => dutiesOf(automations.automations, bot.id), [automations.automations, bot.id]);
  const runs = useDutyRuns(duties);
  const stateKey = useMemo(() => duties.map((duty) => `${duty.id}:${duty.modified}:${duty.lastRunAt ?? ""}`).join("|"), [duties]);
  const { state, error: stateError, reload } = useDutyState(bot.id, stateKey);
  // Restart runtime's own failure, shown in place of the read error it was offered for until that error changes (PRO-489).
  const [restartFailure, setRestartFailure] = useState<{ for: string; message: string } | null>(null);
  const shownStateError = stateError && restartFailure?.for === stateError ? restartFailure.message : stateError;
  const spent = useCallback((sessionId: string) => sessionSpend(sessions.sessions.find((session) => session.id === sessionId)), [sessions.sessions]);
  const leadName = useCallback((id: string) => bots.bots.find((other) => other.id === id)?.name ?? null, [bots.bots]);

  // A duty just saved or copied, as the call answered, until the store lists it (PRO-492): its page opens on it
  // rather than finding it missing and going back to the list.
  const [made, setMade] = useState<Automation | null>(null);
  const listed = screen.kind === "duty" ? duties.find((duty) => duty.id === screen.id) ?? null : null;
  const shown = listed ?? (screen.kind === "duty" && made?.id === screen.id ? made : null);
  useEffect(() => {
    if (made && duties.some((duty) => duty.id === made.id)) setMade(null);
  }, [made, duties]);
  // A duty that is gone (removed here or elsewhere) leaves its page.
  useEffect(() => {
    if (screen.kind === "duty" && !shown && automations.loaded) setScreen({ kind: "list" });
  }, [screen.kind, shown, automations.loaded]);
  const open = (id: string, duty?: Automation) => {
    if (duty) setMade(duty);
    setScreen({ kind: "duty", id });
  };

  if (screen.kind === "edit") {
    const duty = screen.id ? duties.find((value) => value.id === screen.id) ?? null : null;
    return (
      <BotDutyEditor
        bot={bot}
        bots={bots.bots}
        duty={duty}
        initial={screen.initial}
        home={state?.home ?? duty?.projectPath ?? null}
        start={screen.start}
        onClose={(saved) => (saved ? open(saved.id, saved) : setScreen(duty ? { kind: "duty", id: duty.id } : { kind: "list" }))}
      />
    );
  }
  if (shown) {
    return (
      <BotDuty
        bot={bot}
        bots={bots.bots}
        duty={shown}
        runs={runs[shown.id] ?? []}
        state={state}
        spent={spent}
        leadName={leadName}
        onBack={() => setScreen({ kind: "list" })}
        onEdit={() => setScreen({ kind: "edit", id: shown.id })}
        onOpenSession={onOpenSession}
        onOpenDuty={open}
        onChanged={reload}
      />
    );
  }

  if (view === "calendar") {
    return (
      <DutiesCalendar
        bots={bots.bots.some((other) => other.id === bot.id) ? bots.bots : [bot, ...bots.bots]}
        single={bot}
        lead={<><h2 className="text-[15px] font-semibold text-foreground">Duties</h2><DutiesViewSwitch value={view} onChange={choose} /></>}
        onAdd={(_, slot) => setScreen({ kind: "edit", id: null, initial: slot ? dutyAt(slot.day, slot.minute, slot.timezone) : undefined })}
        onOpenDuty={(_, id) => setScreen({ kind: "duty", id })}
        onOpenSession={onOpenSession}
      />
    );
  }

  const all = duties.flatMap((duty) => (runs[duty.id] ?? []).map((run) => ({ duty, run })));
  const log = all.filter(({ run }) => runAt(run)).sort((a, b) => (runAt(b.run) ?? "").localeCompare(runAt(a.run) ?? "")).slice(0, 12);
  const today = todayCounts(all.map(({ run }) => run));
  return (
    <div className="flex min-h-0 flex-1 flex-wrap content-start gap-x-8 gap-y-6 overflow-y-auto px-6 py-5 scrollbar-thin" data-testid="bot-duties">
      <section className="min-w-0 flex-[1_1_520px]" aria-label="Duties">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h2 className="text-[15px] font-semibold text-foreground">Duties</h2>
              <DutiesViewSwitch value={view} onChange={choose} />
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">What wakes {bot.name}. A quick check runs first; the model runs only when there is something to say.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setScreen({ kind: "edit", id: null })} data-testid="duty-add"><Plus /> Add a duty</Button>
        </div>
        {stateError && shownStateError && (
          <MachineHostError
            error={shownStateError}
            onRestarted={() => { setRestartFailure(null); reload(); }}
            onFailed={(message) => setRestartFailure({ for: stateError, message })}
            className="mt-3"
          />
        )}
        {!automations.loaded ? (
          <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the duties…</p>
        ) : duties.length === 0 ? (
          <p className="mt-6 rounded-lg border border-dashed border-hairline px-4 py-8 text-center text-[12.5px] text-muted-foreground">{bot.name} has no duties yet. Add one that wakes it on a schedule or an event.</p>
        ) : (
          <div className="mt-4 min-w-0 overflow-x-auto scrollbar-thin" data-testid="duties-table-scroll">
            <table className="w-full min-w-[520px] table-fixed border-collapse text-[12.5px]" aria-label={`${bot.name}'s duties`} data-testid="duties-table">
              <thead>
                <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-[.06em] text-faint">
                  <th scope="col" className="w-[40%] px-2 py-2 font-medium">Duty</th>
                  <th scope="col" className="w-[19%] px-2 py-2 font-medium">Wakes on</th>
                  <th scope="col" className="w-[17%] px-2 py-2 font-medium">Reports to</th>
                  <th scope="col" className="w-[24%] px-2 py-2 font-medium">Last result</th>
                </tr>
              </thead>
              <tbody>
                {duties.map((duty) => {
                  const last = lastRun(runs[duty.id] ?? []);
                  const WakeIcon = wakeIcon(duty);
                  const wakes = wakesOn(duty, leadName);
                  return (
                    <tr key={duty.id} className="group cursor-pointer border-b border-hairline hover:bg-veil" onClick={() => setScreen({ kind: "duty", id: duty.id })} data-testid="duty-row" data-duty={duty.id}>
                      <td className="px-2 py-2.5 align-top">
                        <button type="button" className="block max-w-full truncate text-left text-[13px] text-foreground outline-none group-hover:underline focus-visible:ring-2 focus-visible:ring-ring/40" onClick={(event) => { event.stopPropagation(); setScreen({ kind: "duty", id: duty.id }); }}>
                          {duty.name}
                        </button>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] text-faint">
                          <Zap className="size-3 shrink-0" />
                          <span className="truncate" title={duty.precheck?.command}>{builtinOf(duty) ? `Built in · ${builtinCheck(duty)}` : duty.precheck ? `First checks: ${duty.precheck.command}` : "No first check: the model looks each time"}</span>
                        </span>
                      </td>
                      <td className="px-2 py-2.5 align-top text-muted-foreground"><span className="block truncate" title={wakes}><WakeIcon className="mr-1.5 inline size-3.5 align-[-2px]" />{wakes}</span></td>
                      <td className="px-2 py-2.5 align-top text-muted-foreground"><span className="block truncate" title={reportsToLabel(duty.bot?.reportsTo, bot, bots.bots)}><AppWindow className="mr-1.5 inline size-3.5 align-[-2px]" />{reportsToLabel(duty.bot?.reportsTo, bot, bots.bots)}</span></td>
                      <td className="px-2 py-2.5 align-top">
                        <span className="block truncate text-foreground">{last ? `${runOutcome(last, leadName)} · ${clockOf(runAt(last))}` : "Never ran"}</span>
                        <span className="block truncate text-[11.5px] text-faint">{duty.enabled ? (bot.paused ? (wakeOf(duty) ? "Paused: events wait" : "Paused with its bot") : wakeOf(duty) ? "Next: on event" : `Next: ${relativeNext(duty.nextRunAt) || "soon"}`) : "Off"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <h3 className="mt-7 text-[11px] font-medium tracking-[.06em] text-faint uppercase">Add a duty that wakes on</h3>
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2" data-testid="duty-wakes">
          {WAKES.map(({ label, note, icon: Icon, group }) => {
            const ready = group !== null;
            const tile = (
              <button
                key={label}
                type="button"
                disabled={!ready}
                onClick={() => group && setScreen({ kind: "edit", id: null, start: group })}
                className={cn("flex w-full min-w-0 items-start gap-2.5 rounded-lg border border-hairline bg-card px-3 py-2.5 text-left", ready ? "hover:bg-veil" : "cursor-not-allowed opacity-55")}
                data-testid="duty-wake"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-foreground">{label}</span>
                  <span className="block truncate text-[11.5px] text-faint">{note}</span>
                </span>
              </button>
            );
            return ready ? tile : <WithTooltip key={label} label="Needs a connector"><span className="inline-flex w-full min-w-0">{tile}</span></WithTooltip>;
          })}
        </div>
      </section>

      <aside className="flex w-[280px] min-w-0 shrink-0 flex-col gap-5" aria-label="Today" data-testid="duties-aside">
        <section>
          <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">Today</h3>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Stat value={today.checks} label="checks" />
            <Stat value={today.nothingNew} label="nothing new" />
            <Stat value={today.reports} label="reports" accent />
          </div>
          <p className="mt-2 text-[11.5px] text-faint">A check that finds nothing new costs nothing and tells nobody.</p>
        </section>
        <section aria-label="Log">
          <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">Log</h3>
          {log.length === 0 ? (
            <p className="mt-2 text-[12px] text-faint">Nothing has run yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1" data-testid="duties-log">
              {log.map(({ duty, run }) => {
                const cost = run.sessionId ? spent(run.sessionId) : null;
                return (
                  <li key={run.runId} className="flex min-w-0 items-baseline gap-2 text-[12px]">
                    <span className="shrink-0 font-mono text-faint tabular-nums">{clockOf(runAt(run))}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={checkFound(run) ?? undefined}>
                      {duty.name} · {runOutcome(run, leadName).toLowerCase()}{run.repeatCount > 1 ? ` ×${run.repeatCount}` : ""}
                    </span>
                    {cost != null && <span className="shrink-0 font-mono text-faint tabular-nums">{formatCost(cost)}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <QuietHoursCard bot={bot} quiet={state?.quietHours ?? null} loaded={!!state} onSaved={reload} />
      </aside>
    </div>
  );
}

function Stat({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-card px-2.5 py-2" data-testid="duties-stat">
      <p className={cn("text-[18px] font-semibold tabular-nums", accent ? "text-primary" : "text-foreground")}>{value}</p>
      <p className="truncate text-[11px] text-faint">{label}</p>
    </div>
  );
}

/** The words for a bot's quiet hours. */
export function quietText(quiet: QuietHours | null): string {
  return quiet ? `${quiet.from}–${quiet.to}: only urgent reports reach your notifications` : "None: every report reaches your notifications";
}

/** A bot's quiet hours, and their editor. Every report still goes in the home chat. */
export function QuietHoursCard({ bot, quiet, loaded, onSaved }: { bot: Bot; quiet: QuietHours | null; loaded: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(quiet?.from ?? "22:00");
  const [to, setTo] = useState(quiet?.to ?? "07:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The quiet hours that failed, sent again once a restarted runtime can confirm them.
  const [pending, setPending] = useState<{ value: QuietHours | null } | null>(null);
  useEffect(() => {
    if (!editing) {
      setFrom(quiet?.from ?? "22:00");
      setTo(quiet?.to ?? "07:00");
    }
  }, [quiet?.from, quiet?.to, editing]);
  const save = (value: QuietHours | null) => {
    setBusy(true);
    setPending({ value });
    dutiesApi.quietHours(bot.id, value).then(() => { setError(null); setPending(null); setEditing(false); onSaved(); }, (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <section aria-label="Quiet hours" data-testid="quiet-hours">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium tracking-[.06em] text-faint uppercase">Quiet hours</h3>
        {!editing && <Button size="xs" variant="ghost" disabled={!loaded} onClick={() => setEditing(true)} data-testid="quiet-hours-edit">Edit</Button>}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <label className="flex items-center gap-1.5">From <input type="time" value={from} onChange={(event) => setFrom(event.target.value)} className="h-7 rounded-md bg-well px-2 text-[12.5px] text-foreground outline-none focus:ring-2 focus:ring-ring/30" /></label>
            <label className="flex items-center gap-1.5">to <input type="time" value={to} onChange={(event) => setTo(event.target.value)} className="h-7 rounded-md bg-well px-2 text-[12.5px] text-foreground outline-none focus:ring-2 focus:ring-ring/30" /></label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" disabled={busy || !from || !to || from === to} onClick={() => save({ from, to })}>Save</Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => save(null)}>No quiet hours</Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 flex items-start gap-2 text-[12.5px] text-muted-foreground"><Moon className="mt-0.5 size-3.5 shrink-0" /> {quietText(quiet)}</p>
      )}
      {error && <MachineHostError error={error} onRestarted={() => { setError(null); if (pending) save(pending.value); }} onFailed={setError} className="mt-1.5" />}
    </section>
  );
}

/** A built-in duty's free check, in words (PRO-477): what lets it skip the model. */
function builtinCheck(duty: Automation): string {
  if (duty.precheck) return `first checks: ${duty.precheck.command}`;
  return builtinOf(duty) === "tidyMemory" ? "skips when memory has not changed" : "skips when nothing it can see has changed";
}
