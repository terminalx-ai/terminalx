import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Keyboard, Loader2, Moon, MousePointerClick, Plus, Trash2 } from "@/icons";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/api";
import { HOUR_PX, WEEKDAYS, addDays, blockBox, calendarApi, clock, countWarns, dayNumber, dayPhase, dragTarget, eventsText, firstWeekday, fitLanes, goesOn, lanes, lanesThatFit, logWords, movedSchedule, oftenText, scheduleWords, stepCell, stepMove, wallClock, weekLabel, weekShown, weekUnknown, weekdayOf, type Cell } from "@/lib/botCalendar";
import { useLocalRuntime } from "@/lib/localRuntime";
import { OutdatedRuntimeDetails } from "@/components/layout/RuntimeStatus";
import { dutiesApi, dutyInputOf, reportsToLabel, runAt, runOutcome, runTook, tookText } from "@/lib/botDuties";
import { useAutomationStore } from "@/lib/automations";
import { cn } from "@/lib/cn";
import type { Automation, AutomationSchedule } from "@/types/automations";
import type { BlockState, CalendarBlock, DayCount, DutyWeek, KeptLog } from "@/types/botCalendar";
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

/** Where a new duty is to go: a clicked hour, or (from Add a duty) none. `day` is the weekday, 0 for Monday … 6. */
export type Slot = { day: number; minute: number; timezone: string } | null;

/**
 * A block being dragged, or moved with the keyboard (`pointer` is then {@link KEYBOARD}). `moved` once it has left its
 * place: let go back there, it is put back, not opened.
 */
type Drag = { index: number; pointer: number; startY: number; to: { day: number; minute: number } | null; moved: boolean };
/** The pointer id of a move made with the keyboard: no pointer has it. */
const KEYBOARD = -1;
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
export function DutiesCalendar({ bots, single, lead, onAdd, onOpenDuty, onOpenSession }: {
  bots: readonly Bot[];
  /** One bot's calendar (its Duties tab): no filter, and its week only. */
  single?: Bot;
  lead?: ReactNode;
  /** Add a duty for a bot (or one to be chosen when `bot` is null) at `slot`. */
  onAdd: (bot: Bot | null, slot: Slot) => void;
  onOpenDuty: (bot: Bot, dutyId: string) => void;
  /** Open a run's session, from a deleted duty's kept log; without it the log only says what each run did. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const automations = useAutomationStore();
  // The week starts where the system's region starts it (PRO-499): read once, as the window's locale is.
  const firstDay = useMemo(() => firstWeekday(), []);
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
  // The hour the grid's keyboard focus is on, and how many blocks fit side by side in a day's column.
  const [cell, setCell] = useState<Cell>({ day: 0, hour: 9 });
  const [laneRoom, setLaneRoom] = useState(Infinity);
  // A deleted duty whose kept log is open.
  const [kept, setKept] = useState<{ bot: Bot; dutyId: string } | null>(null);
  const cells = useRef(new Map<string, HTMLDivElement>());
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
    calendarApi.week(botId, week, firstDay).then((value) => { if (live) { setData(value); setError(null); } }, (cause) => { if (live) { setData(null); setError(errorMessage(cause)); } });
    return () => { live = false; };
  }, [botId, week, changeKey, tick, epoch, firstDay]);
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
  const fitted = useMemo(() => fitLanes(blocks, placed, laneRoom), [blocks, placed, laneRoom]);
  const wall = data ? wallClock(data.timezone, now) : null;
  const today = data && wall ? data.days.indexOf(wall.ymd) : -1;
  /** A column's weekday name, from its date: an older runtime's week starts on Monday whatever was asked. */
  const dayName = (column: number) => (data ? WEEKDAYS[weekdayOf(data.days[column])] : WEEKDAYS[column]);

  // The grid opens at the morning, or earlier when a block is earlier; its keyboard focus starts on now, or the morning.
  useLayoutEffect(() => {
    if (!data || scrolled.current || !scroller.current) return;
    scrolled.current = true;
    const earliest = Math.min(8 * 60, ...data.blocks.filter((block) => !block.continued).map((block) => block.minute));
    scroller.current.scrollTop = Math.max(0, Math.floor(earliest / 60) - 1) * HOUR_PX;
    setCell(today >= 0 && wall ? { day: today, hour: Math.floor(wall.minute / 60) } : { day: 0, hour: 9 });
  }, [data, today, wall]);

  // How many blocks a day's column holds side by side, as it is laid out now.
  const shown = !!data;
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const measure = () => setLaneRoom(lanesThatFit(node.getBoundingClientRect().width / 7));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);

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

  /** A block's duty opens; a deleted one's kept log, as it has no page any more. */
  const openBlock = (block: CalendarBlock) => {
    const bot = byId.get(block.botId);
    if (!bot) return;
    if (block.deleted) setKept({ bot, dutyId: block.dutyId });
    else onOpenDuty(bot, block.dutyId);
  };

  /** Save a block's duty moved to `to`, or say why its schedule cannot move there. */
  const commit = (block: CalendarBlock, to: { day: number; minute: number }) => {
    const duty = duties.get(block.dutyId);
    if (!duty || !data) return;
    const result = movedSchedule(duty.schedule, block, to, data.timezone);
    if ("reason" in result) {
      setNotice(`${duty.name} was not moved. ${result.reason}`);
      return;
    }
    setNotice(null);
    move({ block, duty, schedule: result.schedule, before: duty.schedule });
  };

  const onBlockDown = (event: ReactPointerEvent, index: number) => {
    if (event.button !== 0 || blocks[index]?.state !== "next" || blocks[index]?.deleted) return;
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
      openBlock(block);
      return;
    }
    event.stopPropagation();
    commit(block, to);
  };
  /**
   * A block's keys (PRO-499): Enter or Space opens it. Alt (Option) and the arrow keys move one still to come, by a
   * drag's step up and down and a day left and right, shown where it would go; Enter saves it there, Escape puts it back.
   */
  const onBlockKey = (event: ReactKeyboardEvent, index: number) => {
    const block = blocks[index];
    if (!block) return;
    const moving = drag?.pointer === KEYBOARD && drag.index === index ? drag : null;
    if (event.altKey && event.key.startsWith("Arrow")) {
      event.preventDefault();
      if (block.state !== "next" || block.deleted) {
        setNotice(`${dutyName(block.dutyId)} is not moved: only a block still to come moves.`);
        return;
      }
      const to = stepMove(moving?.to ?? { day: block.day, minute: block.minute }, event.key);
      if (!to) return;
      const home = to.day === block.day && to.minute === block.minute;
      setNotice(null);
      setDrag({ index, pointer: KEYBOARD, startY: 0, to: home ? null : to, moved: true });
      return;
    }
    if (moving && event.key === "Escape") {
      event.preventDefault();
      setDrag(null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (moving) {
        setDrag(null);
        if (moving.to) commit(block, moving.to);
        return;
      }
      openBlock(block);
    }
  };

  /** The bot a duty added here is for: the one shown, or the only one; none when one is still to be chosen. */
  const chosenBot = () => single ?? (only ? byId.get(only) ?? null : bots.length === 1 ? bots[0] : null);
  /** Add a duty at hour `hour` of column `column`, on its weekday, whatever day the week starts on. */
  const addAt = (column: number, hour: number) => {
    if (!data) return;
    onAdd(chosenBot(), { day: weekdayOf(data.days[column]), minute: hour * 60, timezone: data.timezone });
  };
  /** The grid's keys (PRO-499): the arrows between hours and days, Home and End, Page Up and Down; Enter adds a duty. */
  const onCellKey = (event: ReactKeyboardEvent, at: Cell) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      addAt(at.day, at.hour);
      return;
    }
    const next = stepCell(at, event.key);
    if (!next) return;
    event.preventDefault();
    setCell(next);
    const node = cells.current.get(`${next.day}:${next.hour}`);
    node?.focus();
    node?.scrollIntoView?.({ block: "nearest" });
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
  // A deleted duty is no longer among the duties: the week names it.
  const deletedNames = new Map((data?.deleted ?? []).map((gone) => [gone.dutyId, gone.name]));
  const dutyName = (id: string) => duties.get(id)?.name ?? deletedNames.get(id) ?? "A duty";
  const dragged = drag?.to ? blocks[drag.index] : null;
  const keyMoving = drag?.pointer === KEYBOARD ? blocks[drag.index] : null;
  // What each hour of the grid holds, for its cell's name: the blocks that begin in it.
  const startsIn = new Map<string, string[]>();
  for (const block of blocks) {
    if (block.continued) continue;
    const key = `${block.day}:${Math.floor(block.minute / 60)}`;
    startsIn.set(key, [...(startsIn.get(key) ?? []), dutyName(block.dutyId)]);
  }
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

      <div className="@container/calendar flex min-h-0 flex-1 flex-col @4xl/calendar:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto px-6 pt-3 pb-3 scrollbar-thin" data-testid="calendar-main">
          {error && <WeekError error={error} onRestarted={() => { setError(null); setTick((value) => value + 1); }} />}
          {moveError && pending && (
            <MachineHostError error={moveError} onRestarted={() => { setMoveError(null); move(pending); }} onFailed={setMoveError} className="mb-2" />
          )}
          {notice && <p role="status" className="mb-2 rounded-md bg-warning/10 px-3 py-1.5 text-[12px] text-warning" data-testid="calendar-notice">{notice}</p>}
          {keyMoving && drag && (
            <p role="status" className="mb-2 rounded-md bg-veil px-3 py-1.5 text-[12px] text-muted-foreground" data-testid="calendar-key-move">
              {drag.to ? `Moving ${dutyName(keyMoving.dutyId)} to ${dayName(drag.to.day)} ${clock(drag.to.minute)}: Enter saves it there, Escape puts it back.` : `${dutyName(keyMoving.dutyId)} is where it was: Alt (Option) and the arrow keys move it.`}
            </p>
          )}
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
                {data.days.map((ymd, day) => (
                  <div key={ymd} className={cn("flex h-9 min-w-0 items-center gap-1.5 border-l border-hairline px-2 text-[12px]", day === today ? "font-medium text-foreground" : "text-muted-foreground")} data-testid="calendar-day-head">
                    {dayName(day)}
                    <span className={day === today ? "inline-grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground" : "text-faint"}>{dayNumber(ymd)}</span>
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
                    {/* The hours, under the blocks: a click or Enter on one adds a duty there, the arrows move between them. */}
                    <div role="grid" aria-label={`Hours of the week of ${weekLabel(data.days, wall?.ymd)}`} aria-rowcount={24} aria-colcount={7} className="absolute inset-0" data-testid="calendar-cells">
                      {Array.from({ length: 24 }, (_, hour) => (
                        <div key={hour} role="row" aria-rowindex={hour + 1} className="absolute right-0 left-0 grid grid-cols-7" style={{ top: hour * HOUR_PX, height: HOUR_PX }}>
                          {data.days.map((ymd, day) => {
                            const here = startsIn.get(`${day}:${hour}`) ?? [];
                            return (
                              <div
                                key={ymd}
                                ref={(node) => { if (node) cells.current.set(`${day}:${hour}`, node); else cells.current.delete(`${day}:${hour}`); }}
                                role="gridcell"
                                aria-colindex={day + 1}
                                tabIndex={cell.day === day && cell.hour === hour ? 0 : -1}
                                aria-label={`${dayName(day)} ${dayNumber(ymd)}, ${clock(hour * 60)}${here.length ? `: ${here.join(", ")}` : ""}`}
                                className="cursor-cell outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                                onClick={() => { setCell({ day, hour }); addAt(day, hour); }}
                                onFocus={() => setCell({ day, hour })}
                                onKeyDown={(event) => onCellKey(event, { day, hour })}
                                data-testid="calendar-cell"
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    {data.days.map((ymd, day) => (
                      <div
                        key={ymd}
                        className={cn("pointer-events-none relative h-full border-l border-hairline", day === today && "bg-primary/[.04]")}
                        role="group"
                        aria-label={`${dayName(day)} ${dayNumber(ymd)}`}
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
                          // Too many side by side to read: drawn in a "+N more" below.
                          const lane = fitted.shown.get(index);
                          if (!lane) return null;
                          const bot = byId.get(block.botId);
                          const name = dutyName(block.dutyId);
                          const box = blockBox(block);
                          return (
                            <button
                              key={`${block.dutyId}-${block.at}-${index}`}
                              type="button"
                              title={blockTitle(block, name, bot)}
                              aria-label={blockTitle(block, name, bot)}
                              onPointerDown={(event) => onBlockDown(event, index)}
                              onPointerMove={onBlockMove}
                              onPointerUp={(event) => onBlockUp(event, index)}
                              onPointerCancel={() => setDrag(null)}
                              onKeyDown={(event) => onBlockKey(event, index)}
                              onBlur={() => setDrag((current) => (current?.pointer === KEYBOARD && current.index === index ? null : current))}
                              className={cn(
                                "pointer-events-auto absolute flex items-center gap-1 overflow-hidden rounded-[5px] px-1.5 text-left text-[11px] leading-[20px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                                block.state === "next" && !block.deleted ? "cursor-grab touch-none" : "cursor-pointer",
                                blockLook(block.state, bot),
                                // A deleted duty's run: dimmed, and it cannot be moved.
                                block.deleted && "opacity-55 grayscale",
                                // A run across midnight: open at the edge where it goes on.
                                block.continued && "rounded-t-none",
                                goesOn(block) && "rounded-b-none",
                                drag?.index === index && drag.to && "opacity-40",
                              )}
                              style={{ top: box.top, height: box.height, left: `calc(${(lane.lane / lane.of) * 100}% + 3px)`, width: `calc(${100 / lane.of}% - 6px)` }}
                              data-testid="calendar-block"
                              data-state={block.state}
                              data-duty={block.dutyId}
                              data-deleted={block.deleted ? "true" : undefined}
                              data-continued={block.continued ? "true" : undefined}
                            >
                              {block.deleted && <Trash2 aria-hidden className="size-3 shrink-0" data-testid="calendar-block-deleted" />}
                              <span className="min-w-0 truncate">{block.continued ? "↳ " : ""}{name}{block.count > 1 ? ` ×${block.count}` : ""}</span>
                            </button>
                          );
                        })}
                        {fitted.more.filter((more) => more.day === day).map((more) => {
                          const first = blocks[more.members[0]];
                          const at = first ? (first.continued ? "00:00" : clock(first.minute)) : "";
                          const label = `${more.members.length} more at ${at}`;
                          return (
                            <Popover key={`more-${more.members[0]}`}>
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`${label}: ${more.members.map((index) => dutyName(blocks[index].dutyId)).join(", ")}`}
                                  className="pointer-events-auto absolute flex items-start justify-center overflow-hidden rounded-[5px] border border-hairline bg-card px-1 text-[11px] leading-[20px] whitespace-nowrap text-muted-foreground outline-none hover:bg-veil focus-visible:ring-2 focus-visible:ring-ring/50"
                                  style={{ top: more.top, height: more.height, left: `calc(${(more.lane / more.of) * 100}% + 3px)`, width: `calc(${100 / more.of}% - 6px)` }}
                                  data-testid="calendar-more"
                                >
                                  +{more.members.length} more
                                </button>
                              </PopoverTrigger>
                              <PopoverContent label={`${dayName(day)} ${dayNumber(ymd)}: ${label}`} className="w-72">
                                <ul className="flex flex-col" data-testid="calendar-more-list">
                                  {more.members.map((index) => {
                                    const block = blocks[index];
                                    const bot = byId.get(block.botId);
                                    return (
                                      <li key={index}>
                                        <button type="button" onClick={() => openBlock(block)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] outline-none hover:bg-veil focus-visible:ring-2 focus-visible:ring-ring/40" data-testid="calendar-more-item">
                                          <span className="w-10 shrink-0 font-mono text-[11px] text-faint tabular-nums">{block.continued ? "00:00" : clock(block.minute)}</span>
                                          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-[3px]", blockLook(block.state, bot), block.deleted && "opacity-55 grayscale")} />
                                          <span className="min-w-0 truncate text-foreground">{dutyName(block.dutyId)}{block.deleted ? " (deleted)" : ""}</span>
                                          <span className="ml-auto shrink-0 truncate text-[11px] text-faint">{bot?.name ?? "A bot"}</span>
                                        </button>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </PopoverContent>
                            </Popover>
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
              <p className="mt-1 flex shrink-0 items-start gap-2 text-[12px] text-faint" data-testid="calendar-keys">
                <Keyboard className="mt-0.5 size-3.5 shrink-0" />
                On the grid, the arrow keys move between hours and days and Enter adds a duty at the hour. On a block still to come, Alt (Option) and the arrow keys move it; Enter saves it there.
              </p>
            </>
          )}
        </div>

        <aside className="max-h-[35%] w-full shrink-0 overflow-y-auto border-t border-hairline px-5 py-4 scrollbar-thin @4xl/calendar:max-h-none @4xl/calendar:w-[288px] @4xl/calendar:border-t-0 @4xl/calendar:border-l" aria-label="This week" data-testid="calendar-aside">
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
      {kept && (
        <KeptLogDialog
          bot={kept.bot}
          dutyId={kept.dutyId}
          timezone={data?.timezone}
          lead={(id) => bots.find((bot) => bot.id === id)?.name ?? null}
          onOpenSession={onOpenSession && ((sessionId) => { setKept(null); onOpenSession(sessionId); })}
          onClose={() => setKept(null)}
        />
      )}
    </div>
  );
}

/** What a block says it is, for its title and its name to a screen reader. */
function blockTitle(block: CalendarBlock, name: string, bot: Bot | undefined): string {
  const end = clock(block.minute + (block.minutes ?? 0));
  // A run's later day says when it ends; its first how long it went on, and that it goes on past midnight.
  const when = block.continued ? `on from the day before, until ${goesOn(block) ? "after midnight" : end}` : clock(block.minute);
  const length = !block.continued && block.minutes && block.minutes >= 1 ? ` · ${block.state === "running" ? "for" : "ran"} ${lengthWords(block.minutes)}${goesOn(block) ? ", on past midnight" : ""}` : "";
  return `${name}${block.deleted ? " (deleted)" : ""} · ${bot?.name ?? "A bot"} · ${when} · ${STATE_WORDS[block.state] ?? "Ran"}${block.count > 1 ? ` ×${block.count}` : ""}${length}${block.note ? ` · ${block.note}` : ""}`;
}

/** A time in the week's time zone, with its day: `Tue 17 Nov, 09:00`. */
function dayAndTime(iso: string | null, timezone: string | undefined): string {
  if (!iso) return "–";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  try {
    return at.toLocaleString("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return at.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  }
}

/**
 * A deleted duty's kept log (PRO-499): its runs as its page listed them, read from the log the runtime keeps when a
 * duty is deleted. Nothing in it can be changed or run again.
 */
function KeptLogDialog({ bot, dutyId, timezone, lead, onOpenSession, onClose }: {
  bot: Bot;
  dutyId: string;
  timezone: string | undefined;
  lead: (id: string) => string | null;
  onOpenSession?: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [log, setLog] = useState<KeptLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    calendarApi.keptLog(bot.id, dutyId).then((value) => { if (live) setLog(value); }, (cause) => { if (live) setError(errorMessage(cause)); });
    return () => { live = false; };
  }, [bot.id, dutyId]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent width="max-w-[36rem]" className="p-4" data-testid="calendar-kept-log">
        <DialogTitle className="mr-8 truncate text-sm font-semibold">{log ? `${log.name} (deleted)` : "A deleted duty"}</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-[18px] text-muted-foreground">
          {log ? `${bot.name}'s duty, deleted ${dayAndTime(log.deletedAt, timezone)}. Its runs are kept so the weeks they ran in still show them; it runs no more.` : `${bot.name}'s deleted duty.`}
        </DialogDescription>
        {error ? (
          <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{weekUnknown(error.replace("dutyKeptLog", "dutyWeek")) ? "The TerminalX runtime running is older than this app and does not keep a deleted duty's runs." : error}</p>
        ) : !log ? (
          <p className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading its runs…</p>
        ) : log.runs.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-faint">No runs are kept.</p>
        ) : (
          <div className="mt-3 max-h-[50vh] min-w-0 overflow-auto scrollbar-thin">
            <table className="w-full border-collapse text-[12.5px]" aria-label={`${log.name} runs`} data-testid="calendar-kept-runs">
              <thead>
                <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-[.06em] text-faint">
                  <th scope="col" className="px-2 py-2 font-medium">When</th>
                  <th scope="col" className="px-2 py-2 font-medium">Then</th>
                  <th scope="col" className="px-2 py-2 font-medium">Took</th>
                </tr>
              </thead>
              <tbody>
                {log.runs.map((run) => (
                  <tr key={run.runId} className="border-b border-hairline" data-testid="calendar-kept-run">
                    <td className="px-2 py-2 whitespace-nowrap font-mono text-faint tabular-nums">{dayAndTime(runAt(run), timezone)}{run.repeatCount > 1 ? ` ×${run.repeatCount}` : ""}</td>
                    <td className="px-2 py-2">
                      {run.sessionId && onOpenSession ? (
                        <button type="button" onClick={() => onOpenSession(run.sessionId!)} className="block max-w-[280px] truncate text-left text-foreground hover:underline">{runOutcome(run, lead)}</button>
                      ) : (
                        <span className={cn("block max-w-[280px] truncate", run.status === "failed" ? "text-destructive" : "text-muted-foreground")} title={run.error ?? undefined}>{runOutcome(run, lead)}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-faint tabular-nums">{tookText(runTook(run))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
