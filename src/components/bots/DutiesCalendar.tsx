import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Loader2, Moon, MousePointerClick, Plus } from "@/icons";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { errorMessage } from "@/lib/api";
import { HOUR_PX, WEEKDAYS, addDays, blockBox, calendarApi, clock, countWarns, dayNumber, dayPhase, dragTarget, eventsText, lanes, logWords, movedSchedule, oftenText, scheduleWords, wallClock, weekLabel, weekShown, weekUnknown } from "@/lib/botCalendar";
import { useLocalRuntime } from "@/lib/localRuntime";
import { OutdatedRuntimeDetails } from "@/components/layout/RuntimeStatus";
import { dutiesApi, dutyInputOf, reportsToLabel } from "@/lib/botDuties";
import { useAutomationStore } from "@/lib/automations";
import { cn } from "@/lib/cn";
import type { Automation, AutomationSchedule } from "@/types/automations";
import type { BlockState, CalendarBlock, DayCount, DutyWeek } from "@/types/botCalendar";
import type { Bot } from "@/types/bots";
import { BotAvatar, roleMark } from "./BotAvatar";

/** The duties view's two ways of showing them. */
export type DutiesView = "list" | "calendar";

/** The List | Calendar switch, on the Bots page's duties and on a bot's Duties tab. */
export function DutiesViewSwitch({ value, onChange }: { value: DutiesView; onChange: (view: DutiesView) => void }) {
  return (
    <Segmented<DutiesView>
      aria-label="Show the duties as"
      packed
      value={value}
      onChange={onChange}
      options={[{ value: "list", label: "List" }, { value: "calendar", label: "Calendar" }]}
    />
  );
}

/** The text colour of a bot's role mark: its blocks are drawn in it. */
function roleText(bot: Bot | undefined): string {
  return roleMark(bot?.roleTemplateId ?? "").tone.split(" ").find((value) => value.startsWith("text-")) ?? "text-muted-foreground";
}

function roleTone(bot: Bot | undefined): string {
  return roleMark(bot?.roleTemplateId ?? "").tone;
}

/** How each state of a block looks: the bot's colour, the warning edge of a report, grey for nothing new, dashed for still to come. */
function blockLook(state: BlockState, bot: Bot | undefined): string {
  switch (state) {
    case "done":
      return roleTone(bot);
    case "reported":
      return cn(roleTone(bot), "shadow-[inset_2px_0_0_var(--warning)]");
    case "quiet":
      return "bg-muted text-muted-foreground";
    case "next":
      return cn("border border-dashed border-current bg-transparent opacity-85", roleText(bot));
    case "running":
      return cn(roleTone(bot), "ring-1 ring-inset ring-current");
    case "failed":
      return "bg-destructive/15 text-destructive shadow-[inset_2px_0_0_var(--destructive)]";
    case "stopped":
      return "border border-hairline bg-muted text-muted-foreground shadow-[inset_2px_0_0_var(--hairline-strong)]";
    case "skipped":
      return "border border-hairline bg-transparent text-faint line-through";
    default:
      // A state a newer runtime knows and this window does not: drawn plainly, never left without a look.
      return "border border-hairline bg-transparent text-muted-foreground";
  }
}

/** How long a run went on, in a few words. */
function lengthWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

const STATE_WORDS: Record<BlockState, string> = {
  done: "Ran and did its work",
  reported: "Ran and reported something",
  quiet: "Ran and found nothing new",
  next: "Still to come",
  running: "Running now",
  failed: "Failed",
  stopped: "Stopped before it finished",
  skipped: "Did not run",
};

/** The four states the key always explains; the others only when the week has them. */
const KEY_ALWAYS: BlockState[] = ["done", "reported", "quiet", "next"];
const KEY_SOMETIMES: BlockState[] = ["running", "failed", "stopped", "skipped"];

/** Where a new duty is to go: a clicked hour, or (from Add a duty) none. */
export type Slot = { day: number; minute: number; timezone: string } | null;

/** A block being dragged. `moved` once it has left its place: let go back there, it is put back, not opened. */
type Drag = { index: number; pointer: number; startY: number; to: { day: number; minute: number } | null; moved: boolean };
/** A move being saved: `before` is the schedule it replaces; `undoing` when it puts one back. */
type PendingMove = { block: CalendarBlock; duty: Automation; schedule: AutomationSchedule; before: AutomationSchedule; undoing?: boolean };

/**
 * A week of duties (PRO-473, design 23.13): one block per scheduled run in four states (ran and did its work, ran and
 * reported, ran and found nothing new, still to come), with a "now" line on today. Duties that wake many times a day,
 * and those that wake on events, are counted in the two rows on top. Clicking an empty hour adds a duty there; dragging
 * a block still to come moves its duty's time. The right column has what is next today, the week so far, the key and
 * quiet hours. Everything shown is read from the run logs and the schedules by the runtime, in the owner's time zone.
 *
 * `bots` are the bots it may show; with `filter` the toolbar offers to show one of them. `lead` fills the start of the
 * toolbar (the title and the List | Calendar switch).
 */
export function DutiesCalendar({ bots, single, lead, onAdd, onOpenDuty }: {
  bots: readonly Bot[];
  /** One bot's calendar (its Duties tab): no filter, and its week only. */
  single?: Bot;
  lead?: ReactNode;
  /** Add a duty for a bot (or one to be chosen when `bot` is null) at `slot`. */
  onAdd: (bot: Bot | null, slot: Slot) => void;
  onOpenDuty: (bot: Bot, dutyId: string) => void;
}) {
  const automations = useAutomationStore();
  const [week, setWeek] = useState<string | null>(null);
  const [only, setOnly] = useState<string | null>(null);
  const [data, setData] = useState<DutyWeek | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  // The last move saved, said with its Undo.
  const [moved, setMoved] = useState<PendingMove | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => new Date());
  const grid = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const botId = single?.id ?? only;
  // The runtime attached: once another replaces it (an older one restarted), the week is read again.
  const runtime = useLocalRuntime().state;
  const epoch = runtime?.state === "connected" ? runtime.epoch : null;

  // Read again when a duty or its last run changes, and every few minutes; the now line moves every minute.
  const changeKey = useMemo(() => automations.automations.filter((value) => value.bot).map((value) => `${value.id}:${value.modified}:${value.lastRunAt ?? ""}:${value.nextRunAt}`).join("|"), [automations.automations]);
  useEffect(() => {
    let live = true;
    // A week that could not be read leaves nothing of the one before drawn under the error.
    calendarApi.week(botId, week).then((value) => { if (live) { setData(value); setError(null); } }, (cause) => { if (live) { setData(null); setError(errorMessage(cause)); } });
    return () => { live = false; };
  }, [botId, week, changeKey, tick, epoch]);
  // Only while the window is shown: hidden, nothing ticks, and on coming back the week is read again at once.
  useEffect(() => {
    let timers: number[] = [];
    const stop = () => { timers.forEach((timer) => window.clearInterval(timer)); timers = []; };
    const start = () => {
      stop();
      timers = [window.setInterval(() => setNow(new Date()), 60_000), window.setInterval(() => setTick((value) => value + 1), 5 * 60_000)];
    };
    const shown = () => {
      if (document.hidden) { stop(); return; }
      setNow(new Date());
      setTick((value) => value + 1);
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", shown);
    return () => { stop(); document.removeEventListener("visibilitychange", shown); };
  }, []);

  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const duties = useMemo(() => new Map(automations.automations.filter((value) => value.bot).map((value) => [value.id, value])), [automations.automations]);
  const blocks = data?.blocks ?? [];
  const placed = useMemo(() => lanes(blocks), [blocks]);
  const wall = data ? wallClock(data.timezone, now) : null;
  const today = data && wall ? data.days.indexOf(wall.ymd) : -1;

  // The grid opens at the morning, or earlier when a block is earlier.
  useLayoutEffect(() => {
    if (!data || scrolled.current || !scroller.current) return;
    scrolled.current = true;
    const earliest = Math.min(8 * 60, ...data.blocks.map((block) => block.minute));
    scroller.current.scrollTop = Math.max(0, Math.floor(earliest / 60) - 1) * HOUR_PX;
  }, [data]);

  /** The day column under the pointer. */
  const dayAt = useCallback((clientX: number) => {
    const box = grid.current?.getBoundingClientRect();
    if (!box || !box.width) return null;
    const day = Math.floor(((clientX - box.left) / box.width) * 7);
    return day >= 0 && day < 7 ? day : null;
  }, []);

  const move = useCallback((value: PendingMove) => {
    setPending(value);
    setMoveError(null);
    setMoved(null);
    const bot = byId.get(value.block.botId);
    if (!bot) return;
    // The duty as the store has it now, with only its schedule changed.
    const current = duties.get(value.duty.id) ?? value.duty;
    dutiesApi.save(bot.id, value.duty.id, { ...dutyInputOf(current), schedule: value.schedule }).then(
      () => { setPending(null); setMoved(value); setTick((tick) => tick + 1); },
      (cause) => setMoveError(errorMessage(cause)),
    );
  }, [byId, duties]);

  const onBlockDown = (event: ReactPointerEvent, index: number) => {
    if (event.button !== 0 || blocks[index]?.state !== "next") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ index, pointer: event.pointerId, startY: event.clientY, to: null, moved: false });
  };
  const onBlockMove = (event: ReactPointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const block = blocks[drag.index];
    const day = dayAt(event.clientX);
    if (!block || day === null) return;
    // From the block's own time by whole steps of the pointer's travel: a wobble is not a move.
    const to = dragTarget(block, day, event.clientY - drag.startY);
    const home = to.day === block.day && to.minute === block.minute;
    setDrag({ ...drag, to: home ? null : to, moved: drag.moved || !home });
  };
  const onBlockUp = (event: ReactPointerEvent, index: number) => {
    const current = drag;
    setDrag(null);
    // Only the main button opens or moves a duty.
    if (event.button !== 0) return;
    const block = blocks[index];
    const bot = block && byId.get(block.botId);
    if (!block || !bot) return;
    const to = current?.index === index ? current.to : null;
    if (!to) {
      // Dragged away and brought back: put back where it was, and nothing opens.
      if (current?.index === index && current.moved) return;
      onOpenDuty(bot, block.dutyId);
      return;
    }
    const duty = duties.get(block.dutyId);
    if (!duty || !data) return;
    event.stopPropagation();
    const result = movedSchedule(duty.schedule, block, to, data.timezone);
    if ("reason" in result) {
      setNotice(`${duty.name} was not moved. ${result.reason}`);
      return;
    }
    setNotice(null);
    move({ block, duty, schedule: result.schedule, before: duty.schedule });
  };
  const onColumnClick = (event: React.MouseEvent<HTMLDivElement>, day: number) => {
    if (event.target !== event.currentTarget || !data) return;
    const box = event.currentTarget.getBoundingClientRect();
    const minute = Math.min(23, Math.max(0, Math.floor((event.clientY - box.top) / HOUR_PX))) * 60;
    const chosen = single ?? (only ? byId.get(only) ?? null : bots.length === 1 ? bots[0] : null);
    onAdd(chosen, { day, minute, timezone: data.timezone });
  };

  const counted = (row: DayCount[] | undefined, text: (count: DayCount, phase: ReturnType<typeof dayPhase>, any: boolean, first: boolean) => string, any: boolean) =>
    WEEKDAYS.map((_, day) => {
      const count = row?.[day] ?? { ran: 0, reports: 0, failed: 0, planned: 0, scheduled: 0, notKept: 0, capped: false };
      const phase = data && wall ? dayPhase(data.days, day, wall.ymd) : "future";
      return { day, words: text(count, phase, any, day === 0), warn: countWarns(count) };
    });
  const oftenCells = counted(data?.often, oftenText, !!data?.oftenDuties.length);
  const eventCells = counted(data?.events, eventsText, !!data?.eventDuties.length);
  const states = new Set(blocks.map((block) => block.state));
  const dutyName = (id: string) => duties.get(id)?.name ?? "A duty";
  const dragged = drag?.to ? blocks[drag.index] : null;
  const notKept = data?.notKept ?? [];
  const logs = data?.logs ?? [];
  // The duties drawn this week: a day's "history not kept" covers its column only when it is true of all of them.
  const drawn = new Set([...blocks.map((block) => block.dutyId), ...notKept.flat().map((gap) => gap.dutyId)]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="duties-calendar">
      <div className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-6 py-2" data-testid="calendar-toolbar">
        {lead}
        <span className="flex items-center gap-1 text-[12.5px] text-muted-foreground" data-testid="calendar-week">
          <Button variant="ghost" size="icon-xs" aria-label="The week before" disabled={!data || !weekShown(addDays(data.days[0], -7))} onClick={() => data && setWeek(addDays(data.days[0], -7))}><ChevronLeft /></Button>
          <span className="min-w-[88px] text-center tabular-nums">{data ? weekLabel(data.days, wall?.ymd) : "This week"}</span>
          <Button variant="ghost" size="icon-xs" aria-label="The week after" disabled={!data || !weekShown(addDays(data.days[0], 7))} onClick={() => data && setWeek(addDays(data.days[0], 7))}><ChevronRight /></Button>
          {week !== null && <Button variant="ghost" size="xs" onClick={() => setWeek(null)}>This week</Button>}
        </span>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {!single && bots.length > 1 && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Show one bot's duties" data-testid="calendar-filter">
              {bots.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  aria-pressed={only === bot.id}
                  onClick={() => setOnly((current) => (current === bot.id ? null : bot.id))}
                  className={cn("inline-flex h-6 max-w-[140px] items-center gap-1.5 rounded-md border pr-2 pl-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40", only === bot.id ? "border-primary bg-primary/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-veil", only && only !== bot.id && "opacity-55")}
                  data-testid="calendar-filter-bot"
                >
                  <BotAvatar roleTemplateId={bot.roleTemplateId} size="xs" paused={!!bot.paused} />
                  <span className="truncate">{bot.name}</span>
                </button>
              ))}
            </div>
          )}
          <Button variant="accent" size="sm" onClick={() => onAdd(single ?? (only ? byId.get(only) ?? null : bots.length === 1 ? bots[0] : null), null)} data-testid="calendar-add"><Plus /> Add a duty</Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-6 pt-3 pb-3" data-testid="calendar-main">
          {error && <WeekError error={error} onRestarted={() => { setError(null); setTick((value) => value + 1); }} />}
          {moveError && pending && (
            <MachineHostError error={moveError} onRestarted={() => { setMoveError(null); move(pending); }} className="mb-2" />
          )}
          {notice && <p role="status" className="mb-2 rounded-md bg-warning/10 px-3 py-1.5 text-[12px] text-warning" data-testid="calendar-notice">{notice}</p>}
          {moved && !pending && (
            <p role="status" className="mb-2 flex min-w-0 items-center gap-2 rounded-md bg-veil px-3 py-1 text-[12px] text-muted-foreground" data-testid="calendar-moved">
              <span className="min-w-0 truncate">
                {moved.undoing ? `${moved.duty.name} is back to ${scheduleWords(moved.schedule)}.` : `${moved.duty.name} moved: ${scheduleWords(moved.before)} → ${scheduleWords(moved.schedule)}.`}
              </span>
              {!moved.undoing && (
                <Button variant="ghost" size="xs" className="ml-auto shrink-0" onClick={() => move({ ...moved, schedule: moved.before, before: moved.schedule, undoing: true })} data-testid="calendar-undo">Undo</Button>
              )}
            </p>
          )}
          {logs.length > 0 && (
            <ul className="mb-2 flex flex-col gap-1" data-testid="calendar-logs">
              {logs.map((log) => (
                <li key={log.dutyId} className={cn("rounded-md px-3 py-1 text-[12px]", log.unreadable ? "bg-destructive/10 text-destructive" : "bg-veil text-muted-foreground")} data-testid="calendar-log">
                  {logWords(log, dutyName(log.dutyId), data?.timezone)}
                </li>
              ))}
            </ul>
          )}
          {!data && !error ? (
            <p className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the week…</p>
          ) : data && (
            <>
              <div className="grid shrink-0 grid-cols-[44px_repeat(7,minmax(0,1fr))]" data-testid="calendar-head">
                <div />
                {WEEKDAYS.map((name, day) => (
                  <div key={name} className={cn("flex h-9 min-w-0 items-center gap-1.5 border-l border-hairline px-2 text-[12px]", day === today ? "font-medium text-foreground" : "text-muted-foreground")}>
                    {name}
                    <span className={day === today ? "inline-grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground" : "text-faint"}>{dayNumber(data.days[day])}</span>
                  </div>
                ))}
              </div>
              <CountedRow label="Often" cells={oftenCells} testId="calendar-often" />
              <CountedRow label="Events" cells={eventCells} testId="calendar-events" />
              <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto border-t border-hairline scrollbar-thin" data-testid="calendar-scroll">
                <div className="relative grid grid-cols-[44px_minmax(0,1fr)]" style={{ height: 24 * HOUR_PX }}>
                  <div aria-hidden>
                    {Array.from({ length: 24 }, (_, hour) => (
                      <div key={hour} className="pt-1.5 font-mono text-[10.5px] leading-none text-faint" style={{ height: HOUR_PX }}>{clock(hour * 60)}</div>
                    ))}
                  </div>
                  <div ref={grid} role="group" aria-label={`The week of ${weekLabel(data.days, wall?.ymd)}, by day`} className="relative grid grid-cols-7" data-testid="calendar-grid">
                    {Array.from({ length: 23 }, (_, line) => (
                      <div key={line} aria-hidden className="pointer-events-none absolute right-0 left-0 border-t border-hairline" style={{ top: (line + 1) * HOUR_PX }} />
                    ))}
                    {WEEKDAYS.map((name, day) => (
                      <div
                        key={name}
                        className={cn("relative h-full cursor-cell border-l border-hairline", day === today && "bg-primary/[.04]")}
                        onClick={(event) => onColumnClick(event, day)}
                        role="group"
                        aria-label={`${name} ${dayNumber(data.days[day])}`}
                        data-testid="calendar-day"
                      >
                        {day === today && wall && (
                          <div aria-hidden className="pointer-events-none absolute right-0 left-0 z-10 h-px bg-primary" style={{ top: (wall.minute / 60) * HOUR_PX }} data-testid="calendar-now">
                            <span className="absolute -top-[3px] -left-[3px] size-[7px] rounded-full bg-primary" />
                          </div>
                        )}
                        {(notKept[day] ?? []).length > 0 && (() => {
                          const gaps = notKept[day];
                          // Of every duty drawn: the whole column. Of some: a strip at its edge, so the others' blocks
                          // are not read as covered too (the notice above names each).
                          const whole = [...drawn].every((id) => gaps.some((gap) => gap.dutyId === id));
                          return (
                            <div
                              aria-hidden
                              className={cn("pointer-events-none absolute top-0 left-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--hairline)_6px_7px)]", whole ? "right-0 border-b border-dashed border-hairline" : "w-[5px] border-r border-dashed border-hairline-strong")}
                              style={{ height: (Math.max(...gaps.map((gap) => gap.untilMinute)) / 60) * HOUR_PX }}
                              title={`History not kept: ${gaps.map((gap) => dutyName(gap.dutyId)).join(", ")}`}
                              data-testid="calendar-not-kept"
                              data-whole={whole}
                            >
                              {whole && <span className="sticky top-1 ml-1 inline-block rounded bg-background/90 px-1 text-[10.5px] text-faint">history not kept</span>}
                            </div>
                          );
                        })()}
                        {blocks.map((block, index) => {
                          if (block.day !== day) return null;
                          const lane = placed.get(index) ?? { lane: 0, of: 1 };
                          const bot = byId.get(block.botId);
                          const name = dutyName(block.dutyId);
                          const length = block.minutes && block.minutes >= 1 ? ` · ${block.state === "running" ? "for" : "ran"} ${lengthWords(block.minutes)}` : "";
                          const title = `${name} · ${bot?.name ?? "A bot"} · ${clock(block.minute)} · ${STATE_WORDS[block.state] ?? "Ran"}${block.count > 1 ? ` ×${block.count}` : ""}${length}${block.note ? ` · ${block.note}` : ""}`;
                          const box = blockBox(block);
                          return (
                            <button
                              key={`${block.dutyId}-${block.at}-${index}`}
                              type="button"
                              title={title}
                              aria-label={title}
                              onPointerDown={(event) => onBlockDown(event, index)}
                              onPointerMove={onBlockMove}
                              onPointerUp={(event) => onBlockUp(event, index)}
                              onPointerCancel={() => setDrag(null)}
                              onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && bot) { event.preventDefault(); onOpenDuty(bot, block.dutyId); } }}
                              className={cn(
                                "absolute truncate rounded-[5px] px-1.5 text-left text-[11px] leading-[20px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                                block.state === "next" ? "cursor-grab touch-none" : "cursor-pointer",
                                blockLook(block.state, bot),
                                drag?.index === index && drag.to && "opacity-40",
                              )}
                              style={{ top: box.top, height: box.height, left: `calc(${(lane.lane / lane.of) * 100}% + 3px)`, width: `calc(${100 / lane.of}% - 6px)` }}
                              data-testid="calendar-block"
                              data-state={block.state}
                              data-duty={block.dutyId}
                            >
                              {name}{block.count > 1 ? ` ×${block.count}` : ""}
                            </button>
                          );
                        })}
                        {dragged && drag?.to?.day === day && (
                          <div aria-hidden className={cn("pointer-events-none absolute right-[3px] left-[3px] truncate rounded-[5px] px-1.5 text-[11px] leading-[20px]", blockLook("next", byId.get(dragged.botId)))} style={blockBox({ minute: drag.to.minute })} data-testid="calendar-drop">
                            {clock(drag.to.minute)} {dutyName(dragged.dutyId)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mt-3 flex shrink-0 items-start gap-2 text-[12px] text-faint" data-testid="calendar-hint">
                <MousePointerClick className="mt-0.5 size-3.5 shrink-0" />
                Click an empty hour to add a duty there. Drag a block still to come to move it. Checks that run many times a day, and duties that wake on an event, are counted in the two rows on top.
              </p>
            </>
          )}
        </div>

        <aside className="w-[288px] shrink-0 overflow-y-auto border-l border-hairline px-5 py-4 scrollbar-thin" aria-label="This week" data-testid="calendar-aside">
          <h3 className="mb-1 text-[11px] font-medium tracking-[.06em] text-faint uppercase">Next today</h3>
          {data && data.nextToday.length > 0 && today >= 0 ? (
            <ul data-testid="calendar-next">
              {data.nextToday.filter((next) => !wall || next.minute >= wall.minute).map((next) => {
                const bot = byId.get(next.botId);
                const duty = duties.get(next.dutyId);
                return (
                  <li key={next.dutyId} className="flex h-10 min-w-0 items-center gap-2.5 border-t border-hairline first:border-t-0">
                    <span className="w-10 shrink-0 font-mono text-[11.5px] text-faint tabular-nums">{clock(next.minute)}</span>
                    {bot && <BotAvatar roleTemplateId={bot.roleTemplateId} size="xs" />}
                    <span className="min-w-0 leading-4">
                      <span className="block truncate text-[12.5px] text-foreground">{duty?.name ?? "A duty"}</span>
                      <span className="block truncate text-[11.5px] text-faint">{bot ? `${bot.name} · to ${reportsToLabel(duty?.bot?.reportsTo, bot, bots)}` : ""}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[12px] text-faint">{data && today < 0 ? "This week is not the current one." : "Nothing more today."}</p>
          )}

          <h3 className="mt-5 mb-2 text-[11px] font-medium tracking-[.06em] text-faint uppercase">{today >= 0 ? "This week so far" : "This week"}</h3>
          <div className="grid grid-cols-3 gap-2 text-center" data-testid="calendar-totals">
            <Total value={data?.totals.checks} label="checks" atLeast={data?.totals.atLeast} />
            <Total value={data?.totals.nothingNew} label="nothing new" atLeast={data?.totals.atLeast} />
            <Total value={data?.totals.reports} label="reports" atLeast={data?.totals.atLeast} />
          </div>

          <h3 className="mt-5 mb-1 text-[11px] font-medium tracking-[.06em] text-faint uppercase">How to read it</h3>
          <ul data-testid="calendar-key">
            {[...KEY_ALWAYS, ...KEY_SOMETIMES.filter((state) => states.has(state))].map((state) => (
              <li key={state} className="flex h-7 items-center gap-2.5 text-[12px] text-muted-foreground" data-testid="calendar-key-row">
                <span className={cn("h-[14px] w-9 shrink-0 rounded-[4px]", blockLook(state, single ?? (only ? byId.get(only) : undefined) ?? bots[0]))} />
                {STATE_WORDS[state]}
              </li>
            ))}
          </ul>

          <h3 className="mt-5 mb-1.5 text-[11px] font-medium tracking-[.06em] text-faint uppercase">Quiet hours</h3>
          <QuietHoursList data={data} bots={single ? [single] : only ? bots.filter((bot) => bot.id === only) : bots} />
        </aside>
      </div>
    </div>
  );
}

/**
 * The week could not be read. A runtime older than this app, one that does not know the week of duties, is offered the
 * status bar's own Restart now (#730), which names what it stops and replaces it with the app's runtime; the week is
 * read again once another runtime is attached. Any other failure is a guarded command's (`MachineHostError`).
 */
function WeekError({ error, onRestarted }: { error: string; onRestarted: () => void }) {
  const { state } = useLocalRuntime();
  if (weekUnknown(error)) {
    const outdated = state?.state === "connected" ? state.outdated : undefined;
    return (
      <div role="alert" className="mb-2 grid gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px]" data-testid="calendar-older-runtime">
        <p className="text-destructive">The TerminalX runtime running does not know the week of duties: it is older than this app.</p>
        {outdated && state?.state === "connected"
          ? <OutdatedRuntimeDetails epoch={state.epoch} outdated={outdated} />
          : <p className="text-muted-foreground">It does not say it is older, so nothing is offered to restart: this app and the runtime running are different builds.</p>}
      </div>
    );
  }
  return <MachineHostError error={error} onRestarted={onRestarted} className="mb-2" />;
}

function CountedRow({ label, cells, testId }: { label: string; cells: { day: number; words: string; warn: boolean }[]; testId: string }) {
  return (
    <div className="grid shrink-0 grid-cols-[44px_repeat(7,minmax(0,1fr))] border-t border-hairline" data-testid={testId}>
      <div className="flex h-7 items-center text-[10.5px] text-faint">{label}</div>
      {cells.map(({ day, words, warn }) => (
        <div key={day} className={cn("flex h-7 min-w-0 items-center border-l border-hairline px-2 text-[11px]", warn ? "text-warning" : "text-faint")} data-testid="calendar-count">
          <span className="truncate" title={words}>{words}</span>
        </div>
      ))}
    </div>
  );
}

function Total({ value, label, atLeast }: { value: number | undefined; label: string; atLeast?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-hairline bg-card py-2" data-testid="calendar-total" title={atLeast ? "At least: some history is not kept" : undefined}>
      <p className="text-[16px] font-semibold text-foreground tabular-nums">{atLeast && value !== undefined && <span className="mr-0.5 text-[11px] font-normal text-faint">at least</span>}{value ?? "–"}</p>
      <p className="truncate text-[11px] text-faint">{label}</p>
    </div>
  );
}

function QuietHoursList({ data, bots }: { data: DutyWeek | null; bots: readonly Bot[] }) {
  const quiet = bots.flatMap((bot) => {
    const hours = data?.quietHours[bot.id];
    return hours ? [{ bot, hours }] : [];
  });
  if (!quiet.length) return <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground"><Moon className="mt-0.5 size-3.5 shrink-0" /> None: every report reaches your notifications.</p>;
  return (
    <ul className="flex flex-col gap-1.5" data-testid="calendar-quiet">
      {quiet.map(({ bot, hours }) => (
        <li key={bot.id} className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
          <Moon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{bots.length > 1 ? `${bot.name}: ` : ""}{hours.from}–{hours.to}, only urgent reports reach your notifications</span>
        </li>
      ))}
    </ul>
  );
}
