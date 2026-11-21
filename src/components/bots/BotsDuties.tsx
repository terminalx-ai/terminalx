import { useMemo, useState } from "react";
import { CalendarClock, ChevronRight, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { useAutomationStore } from "@/lib/automations";
import { relativeNext } from "@/lib/automationSchedule";
import { WEEKDAYS, clock, dutyAt } from "@/lib/botCalendar";
import { clockOf, dutiesOf, runAt, runOutcome, wakesOn } from "@/lib/botDuties";
import { useBotStore } from "@/lib/bots";
import { showBotsTeam } from "@/lib/botsPage";
import type { Automation } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { DutyInput } from "@/types/botDuties";
import { BotAvatar } from "./BotAvatar";
import { BotDutyEditor } from "./BotDutyEditor";
import { useDutyRuns, useDutyState } from "./BotDuties";
import { DutiesCalendar, DutiesViewSwitch, type DutiesView, type Slot } from "./DutiesCalendar";

/** The view last chosen here, kept while the app runs. */
let lastView: DutiesView = "calendar";

type Editing = { bot: Bot; duty: Automation | null; initial: DutyInput | null };

/**
 * The Bots page's duties (PRO-473, design 23.13), reached from its Calendar button: every bot's duties as a week, or
 * as a list. A duty is added or changed here in the same editor as on a bot's Duties tab, through the same guarded
 * route; adding one at a clicked hour starts it there.
 */
export function BotsDuties() {
  const store = useBotStore();
  const automations = useAutomationStore();
  const [view, setView] = useState<DutiesView>(lastView);
  const [editing, setEditing] = useState<Editing | null>(null);
  // Where a new duty goes while its bot is being chosen.
  const [choosing, setChoosing] = useState<{ slot: Slot } | null>(null);
  const bots = store.bots;
  const choose = (next: DutiesView) => {
    lastView = next;
    setView(next);
  };
  const add = (bot: Bot | null, slot: Slot) => {
    if (!bot) {
      setChoosing({ slot });
      return;
    }
    setChoosing(null);
    setEditing({ bot, duty: null, initial: slot ? dutyAt(slot.day, slot.minute, slot.timezone) : null });
  };
  // A duty not (or no longer) among the automations opens nothing, never a new one.
  const open = (bot: Bot, dutyId: string) => {
    const duty = automations.automations.find((value) => value.id === dutyId && value.bot?.id === bot.id);
    if (duty) setEditing({ bot, duty, initial: null });
  };

  const lead = (
    <>
      <button type="button" onClick={() => showBotsTeam()} className="rounded-md text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" data-testid="bots-duties-back">Bots</button>
      <ChevronRight className="size-3.5 text-faint" />
      <h1 className="text-[15px] font-semibold text-foreground">Duties this week</h1>
      <DutiesViewSwitch value={view} onChange={choose} />
    </>
  );

  if (editing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-duties">
        <DutyEditor key={`${editing.bot.id}:${editing.duty?.id ?? "new"}`} editing={editing} bots={bots} onClose={() => setEditing(null)} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-duties">
      {choosing && (
        <div role="dialog" aria-label="Which bot" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-veil px-6 py-2 text-[12.5px]" data-testid="bots-duties-choose">
          <span className="text-muted-foreground">
            {choosing.slot ? `Add a duty on ${WEEKDAYS[choosing.slot.day]} at ${clock(choosing.slot.minute)} for` : "Add a duty for"}
          </span>
          {bots.map((bot) => (
            <Button key={bot.id} variant="outline" size="xs" onClick={() => add(bot, choosing.slot)} data-testid="bots-duties-choose-bot">
              <BotAvatar roleTemplateId={bot.roleTemplateId} size="xs" /> {bot.name}
            </Button>
          ))}
          <Button variant="ghost" size="xs" onClick={() => setChoosing(null)}>Cancel</Button>
        </div>
      )}
      {view === "calendar" ? (
        <DutiesCalendar bots={bots} lead={lead} onAdd={add} onOpenDuty={open} />
      ) : (
        <>
          <div className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-6 py-2">
            {lead}
            <Button className="ml-auto" variant="accent" size="sm" onClick={() => add(bots.length === 1 ? bots[0] : null, null)} disabled={!bots.length}>Add a duty</Button>
          </div>
          <AllDuties bots={bots} onOpen={open} />
        </>
      )}
    </div>
  );
}

/** The duty editor, with the bot's home read as its Duties tab reads it, so a new duty's check is placed there too. */
function DutyEditor({ editing, bots, onClose }: { editing: Editing; bots: readonly Bot[]; onClose: () => void }) {
  const { state } = useDutyState(editing.bot.id, editing.duty?.id ?? "new");
  return (
    <BotDutyEditor
      bot={editing.bot}
      bots={bots}
      duty={editing.duty}
      initial={editing.initial ?? undefined}
      home={state?.home ?? editing.duty?.projectPath ?? null}
      onClose={onClose}
    />
  );
}

/** Every bot's duties as one list: the bot, the duty, what wakes it, and how it last went. */
function AllDuties({ bots, onOpen }: { bots: readonly Bot[]; onOpen: (bot: Bot, dutyId: string) => void }) {
  const automations = useAutomationStore();
  const rows = useMemo(() => bots.flatMap((bot) => dutiesOf(automations.automations, bot.id).map((duty) => ({ bot, duty }))), [bots, automations.automations]);
  const runs = useDutyRuns(rows.map(({ duty }) => duty));
  const lead = (id: string) => bots.find((bot) => bot.id === id)?.name ?? null;
  if (!automations.loaded) return <p className="flex items-center gap-2 px-6 py-6 text-[12.5px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the duties…</p>;
  if (!rows.length) return <p className="mx-6 mt-6 rounded-lg border border-dashed border-hairline px-4 py-8 text-center text-[12.5px] text-muted-foreground">No bot has a duty yet.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-4 scrollbar-thin">
      <table className="w-full min-w-[640px] table-fixed border-collapse text-[12.5px]" aria-label="Every bot's duties" data-testid="bots-duties-list">
        <thead>
          <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-[.06em] text-faint">
            <th scope="col" className="w-[20%] px-2 py-2 font-medium">Bot</th>
            <th scope="col" className="w-[34%] px-2 py-2 font-medium">Duty</th>
            <th scope="col" className="w-[20%] px-2 py-2 font-medium">Wakes on</th>
            <th scope="col" className="w-[26%] px-2 py-2 font-medium">Last result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ bot, duty }) => {
            const last = (runs[duty.id] ?? [])[0] ?? null;
            return (
              <tr key={duty.id} className="cursor-pointer border-b border-hairline hover:bg-veil" onClick={() => onOpen(bot, duty.id)} data-testid="bots-duties-row">
                <td className="px-2 py-2.5"><span className="flex min-w-0 items-center gap-2"><BotAvatar roleTemplateId={bot.roleTemplateId} size="xs" paused={!!bot.paused} /><span className="truncate">{bot.name}</span></span></td>
                <td className="px-2 py-2.5"><span className="block truncate text-foreground">{duty.name}</span></td>
                <td className="px-2 py-2.5 text-muted-foreground"><span className="block truncate"><CalendarClock className="mr-1.5 inline size-3.5 align-[-2px]" />{wakesOn(duty)}</span></td>
                <td className="px-2 py-2.5">
                  <span className="block truncate text-foreground">{last ? `${runOutcome(last, lead)} · ${clockOf(runAt(last))}` : "Never ran"}</span>
                  <span className="block truncate text-[11.5px] text-faint">{duty.enabled ? (bot.paused ? "Paused with its bot" : `Next: ${relativeNext(duty.nextRunAt) || "soon"}`) : "Off"}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
