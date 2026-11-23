import { useState } from "react";
import { ChevronLeft, Loader2 } from "@/icons";
import { PrecheckSection, precheckReady } from "@/components/automations/PrecheckSection";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Segmented, Switch } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { describeSchedule } from "@/lib/automationSchedule";
import { HOME_ENV, REPORT_TARGETS, checkRunsHomeFile, dutiesApi, dutyInputOf, newDutyInput, reportsToLabel } from "@/lib/botDuties";
import { builtinOf } from "@/lib/botSuggestions";
import { cn } from "@/lib/cn";
import type { Automation, AutomationInput, AutomationSchedule, ScheduleKind, SchedulePreset } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { DutyInput } from "@/types/botDuties";
import { HomeFileWarning } from "./BotDuty";
import { BotDutyWake, wakeForGroup, wakeGroupOf, wakeReady, type WakeGroup } from "./BotDutyWake";

const WAKE_GROUPS: { value: WakeGroup; label: string }[] = [
  { value: "schedule", label: "A schedule" },
  { value: "github", label: "GitHub" },
  { value: "linear", label: "Linear" },
  { value: "bot", label: "Another bot" },
  { value: "watch", label: "Wait until" },
];

const INPUT = "h-8 w-full rounded-md bg-well px-2.5 text-[13px] outline-none ring-offset-background focus:ring-2 focus:ring-ring/30";
const LABEL = "flex flex-col gap-1.5 text-xs font-medium";
const DAYS = [["MO", "Monday"], ["TU", "Tuesday"], ["WE", "Wednesday"], ["TH", "Thursday"], ["FR", "Friday"], ["SA", "Saturday"], ["SU", "Sunday"]];

/**
 * Add or change a duty that wakes on a schedule (PRO-471) or an event (PRO-472): GitHub, Linear, another bot, or a
 * change it waits for. `start` is the tile it was opened from. Its agent, model, access and folder are its bot's, so the
 * editor asks only what the duty does: its name, when it wakes, its first check, what the bot looks at, and where the
 * result goes. Slack, Telegram and a pull request are shown, switched off, until their tickets land.
 */
export function BotDutyEditor({ bot, bots, duty, home, initial, start = "schedule", onClose }: {
  bot: Bot;
  bots: readonly Bot[];
  duty: Automation | null;
  home: string | null;
  /** Where a new duty starts: an hour clicked on the week's calendar (PRO-473). */
  initial?: DutyInput;
  /** What it wakes on, as the tile it was opened from (PRO-472). */
  start?: WakeGroup;
  /** The duty as saved, or nothing when the editor was left without saving. */
  onClose: (saved: Automation | null) => void;
}) {
  const [input, setInput] = useState<DutyInput>(() => (duty ? dutyInputOf(duty) : initial ?? { ...newDutyInput(), wake: wakeForGroup(start, bot) }));
  const group = wakeGroupOf(input.wake);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (value: Partial<DutyInput>) => setInput((current) => ({ ...current, ...value }));
  const patchSchedule = (value: Partial<AutomationSchedule>) => setInput((current) => ({ ...current, schedule: { ...current.schedule, ...value } }));
  const setScheduleKind = (kind: ScheduleKind) => {
    if (kind === "cron") patchSchedule({ kind, preset: undefined, cron: input.schedule.cron ?? "0 * * * *" });
    else patchSchedule({ kind, preset: input.schedule.preset ?? "weekdays", cron: undefined });
  };
  const setPreset = (preset: SchedulePreset) => {
    const weekdays = preset === "weekdays" ? ["MO", "TU", "WE", "TH", "FR"] : preset === "weekly" ? [input.schedule.weekdays[0] ?? "MO"] : [];
    patchSchedule({ preset, weekdays });
  };
  // The first check runs in a folder of the duty's own, as the owner; Try it runs it there once, recording nothing.
  const precheckInput = { projectPath: home ?? "", workspace: "newWorktree", sessionId: null, precheck: input.precheck } as unknown as AutomationInput;
  // A target a newer app wrote stays as it is, and is shown as such.
  const unknownTarget = !REPORT_TARGETS.some((target) => target.id === input.reportsTo);
  // A built-in's name and prompt are TerminalX's (PRO-477): its editor changes when it wakes, its check, and Look
  // around's focus line.
  const builtin = duty ? builtinOf(duty) : null;
  const canSave = !!input.name.trim() && (!!builtin || !!input.prompt.trim()) && precheckReady(input.precheck) && wakeReady(input.wake)
    && (!!input.wake || input.schedule.kind !== "cron" || !!input.schedule.cron?.trim());

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await dutiesApi.save(bot.id, duty?.id ?? null, { ...input, name: input.name.trim() });
      onClose(saved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5 scrollbar-thin" data-testid="duty-editor">
      <button type="button" onClick={() => onClose(null)} className="flex w-fit items-center gap-1 rounded-md text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
        <ChevronLeft className="size-3.5" /> {duty ? duty.name : "Duties"}
      </button>
      <h2 className="mt-3 text-[15px] font-semibold text-foreground">{builtin ? `Change ${duty?.name}` : duty ? "Change the duty" : `Add a duty for ${bot.name}`}</h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">
        {builtin
          ? builtin === "tidyMemory"
            ? `Built in. ${bot.name} merges its duplicate notes and removes the ones newer notes contradict, as one change you can undo in Memory.`
            : `Built in. ${bot.name} reads what changed and suggests work on its Home tab. It may only read while it looks: TerminalX refuses anything else.`
          : <>It runs as {bot.name}: its agent, model, access and home. A quick check runs first; the model runs only when the check finds something.</>}
      </p>

      <div className="mt-5 grid max-w-[720px] grid-cols-2 gap-4">
        {!builtin && (
          <label className={`${LABEL} col-span-2`}>
            Name
            <input value={input.name} maxLength={80} onChange={(event) => patch({ name: event.target.value })} className={INPUT} placeholder="Queue time on main" autoFocus />
          </label>
        )}

        <div className="col-span-2 flex flex-col gap-1.5 border-t border-hairline pt-3">
          <span className="text-xs font-medium">Wakes on</span>
          {group === "unknown" ? (
            <span role="note" className="text-[11px] text-faint">An event this version does not know: it is kept as it is and not checked here.</span>
          ) : (
            <Segmented<WakeGroup> aria-label="Wakes on" value={group} onChange={(next) => patch({ wake: wakeForGroup(next, bot) })} options={WAKE_GROUPS} />
          )}
        </div>
        {input.wake ? (group !== "unknown" && <BotDutyWake bot={bot} bots={bots} home={home} wake={input.wake} onChange={(wake) => patch({ wake })} />) : <>
        <div className="col-span-2 flex flex-col gap-1.5">
          <span className="text-[11px] text-faint">{describeSchedule(input.schedule)} · {input.schedule.timezone}</span>
          <Segmented<ScheduleKind> aria-label="Schedule type" value={input.schedule.kind} onChange={setScheduleKind} options={[{ value: "preset", label: "Preset" }, { value: "cron", label: "Cron" }]} />
        </div>
        {input.schedule.kind === "preset" ? (
          <>
            <label className={LABEL}>
              Repeats
              <select value={input.schedule.preset ?? "weekdays"} onChange={(event) => setPreset(event.target.value as SchedulePreset)} className={INPUT}>
                <option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option>
              </select>
            </label>
            {input.schedule.preset === "hourly" ? (
              <label className={LABEL}>Minute<input type="number" min={0} max={59} value={input.schedule.minute ?? 0} onChange={(event) => patchSchedule({ minute: Number(event.target.value) })} className={INPUT} /></label>
            ) : (
              <div className="flex gap-3">
                {input.schedule.preset === "weekly" && (
                  <label className={`${LABEL} flex-1`}>Day<select value={input.schedule.weekdays[0] ?? "MO"} onChange={(event) => patchSchedule({ weekdays: [event.target.value] })} className={INPUT}>{DAYS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                )}
                <label className={`${LABEL} flex-1`}>Time<input type="time" value={`${String(input.schedule.hour ?? 9).padStart(2, "0")}:${String(input.schedule.minute ?? 0).padStart(2, "0")}`} onChange={(event) => { const [hour, minute] = event.target.value.split(":").map(Number); patchSchedule({ hour, minute }); }} className={INPUT} /></label>
              </div>
            )}
          </>
        ) : (
          <label className={`${LABEL} col-span-2`}>Five-field cron expression<input value={input.schedule.cron ?? ""} onChange={(event) => patchSchedule({ cron: event.target.value })} className={`${INPUT} font-mono`} placeholder="*/30 * * * *" spellCheck={false} /></label>
        )}
        </>}

        <PrecheckSection
          input={precheckInput}
          onChange={(precheck) => patch({ precheck })}
          onTry={(precheck) => dutiesApi.tryCheck(bot.id, duty?.id ?? null, precheck)}
          where={`Runs as you, not as ${bot.name}: in an empty folder of the duty's own, never in ${bot.name}'s home, which is in $${HOME_ENV}.`}
        />
        {input.precheck && checkRunsHomeFile(input.precheck.command, home) && <div className="col-span-2 -mt-2"><HomeFileWarning bot={bot} /></div>}

        {builtin === "lookAround" && (
          <label className={`${LABEL} col-span-2 border-t border-hairline pt-3`}>
            Focus
            <span className="font-normal text-faint">What to look at first, in a line. Empty, {bot.name} looks at everything it can see.</span>
            <input value={input.focus ?? ""} maxLength={200} onChange={(event) => patch({ focus: event.target.value || null })} className={INPUT} placeholder="Open pull requests on the release branch" data-testid="duty-focus" />
          </label>
        )}
        {!builtin && <label className={`${LABEL} col-span-2 border-t border-hairline pt-3`}>
          Then {bot.name} looks
          <span className="font-normal text-faint">What to do with what the check found. The check's output goes with it.</span>
          <textarea
            value={input.prompt}
            onChange={(event) => patch({ prompt: event.target.value })}
            rows={5}
            className="w-full resize-y rounded-lg bg-well px-3 py-2 text-[13px] leading-relaxed outline-none focus:ring-2 focus:ring-ring/30"
            placeholder="Say which jobs are slow and why. Say nothing new when nothing changed."
          />
        </label>}

        {builtin ? (
          <p className="col-span-2 border-t border-hairline pt-3 text-[11px] text-faint">Its report is a note in {bot.name}'s home chat. Nothing reaches your notifications unless it is urgent.</p>
        ) : <div className="col-span-2 flex flex-col gap-1.5 border-t border-hairline pt-3" role="radiogroup" aria-label="Reports to">
          <span className="text-xs font-medium">Reports to</span>
          <div className="flex flex-wrap gap-1.5" data-testid="duty-reports-to">
            {REPORT_TARGETS.map((target) => {
              const chip = (
                <button
                  key={target.id}
                  type="button"
                  role="radio"
                  aria-checked={input.reportsTo === target.id}
                  disabled={!target.ready}
                  onClick={() => patch({ reportsTo: target.id })}
                  className={cn(
                    "h-7 rounded-md border px-2.5 text-[12px]",
                    input.reportsTo === target.id ? "border-primary bg-primary/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-veil",
                    !target.ready && "cursor-not-allowed opacity-50 hover:bg-transparent",
                  )}
                >
                  {target.id === "lead" ? reportsToLabel("lead", bot, bots) : target.label}
                </button>
              );
              return target.ready ? chip : <WithTooltip key={target.id} label="Coming with the channels a bot can report to">{chip}</WithTooltip>;
            })}
            {unknownTarget && <span className="flex h-7 items-center rounded-md border border-primary bg-primary/10 px-2.5 text-[12px] text-foreground">{input.reportsTo}</span>}
          </div>
          <span className="text-[11px] text-faint">
            {input.reportsTo === "lead"
              ? "A note in its lead's home chat. Nothing reaches your notifications unless it is urgent."
              : "A note in its home chat and a notification. In quiet hours only urgent ones notify."}
          </span>
        </div>}

        <label className="col-span-2 flex items-center justify-between gap-3 border-t border-hairline pt-3 text-xs">
          <span><span className="block font-medium">On</span><span className="text-faint">Switched off, it wakes only when you run it.</span></span>
          <Switch aria-label="Duty on" checked={input.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
        </label>
      </div>

      {/* The draft stays in this editor while the runtime restarts; the save is sent again after. */}
      {error && <MachineHostError error={error} onRestarted={() => { setError(null); void save(); }} onFailed={setError} className="mt-4 max-w-[720px]" />}
      <div className="mt-5 flex max-w-[720px] justify-end gap-2">
        <Button variant="ghost" onClick={() => onClose(null)} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} disabled={!canSave || saving} data-testid="duty-save">{saving ? <Loader2 className="animate-spin" /> : null} {duty ? "Save" : "Add the duty"}</Button>
      </div>
    </div>
  );
}
