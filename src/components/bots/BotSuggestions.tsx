import { useMemo, useState } from "react";
import { CalendarClock, Eraser, Loader2, Play, Telescope, Zap } from "@/icons";
import { Button } from "@/components/ui/button";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { errorMessage } from "@/lib/api";
import { useAutomationStore } from "@/lib/automations";
import { relativeNext } from "@/lib/automationSchedule";
import { clockOf, dutiesApi, dutiesOf } from "@/lib/botDuties";
import { builtinOf, lookLine, suggestionsApi, upNext, useBotSuggestions } from "@/lib/botSuggestions";
import { relativeTime } from "@/lib/time";
import type { Automation } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { BotSuggestion, BuiltinStatus } from "@/types/botSuggestions";
import { BotReportsTo } from "./BotHandoffs";

/**
 * The right column of a bot's Home tab (design 23.01): who it reports to (PRO-475), Up next, its next duty runs, and
 * Suggestions from its look around (PRO-477), each with Start and Dismiss under a line saying how the last look went.
 */
export function BotHomeAside({ bot }: { bot: Bot }) {
  return (
    <aside className="flex min-w-0 flex-col gap-6" aria-label={`${bot.name} at a glance`} data-testid="bot-home-aside">
      <BotReportsTo bot={bot} />
      <UpNext bot={bot} />
      <Suggestions bot={bot} />
    </aside>
  );
}

function Heading({ children, detail }: { children: React.ReactNode; detail?: string }) {
  return (
    <div className="flex h-6 min-w-0 items-baseline justify-between gap-2">
      <h2 className="shrink-0 text-[11px] font-medium uppercase tracking-[.08em] text-faint">{children}</h2>
      {detail && <span className="min-w-0 truncate text-[11.5px] text-faint" title={detail}>{detail}</span>}
    </div>
  );
}

/** A duty's icon: the telescope for Look around, the eraser for Tidy memory, a bolt for one an event wakes. */
function DutyIcon({ duty }: { duty: Automation }) {
  const kind = builtinOf(duty);
  const Icon = kind === "lookAround" ? Telescope : kind === "tidyMemory" ? Eraser : duty.eventTrigger || duty.issueTrigger ? Zap : CalendarClock;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

/** The bot's next duty runs, soonest first. */
function UpNext({ bot }: { bot: Bot }) {
  const automations = useAutomationStore();
  const duties = useMemo(() => dutiesOf(automations.automations, bot.id), [automations.automations, bot.id]);
  const next = upNext(duties);
  return (
    <section aria-label="Up next" className="flex min-w-0 flex-col gap-2" data-testid="bot-up-next">
      <Heading>Up next</Heading>
      {bot.paused ? (
        <p className="text-[12.5px] text-faint">Paused: no duty runs until {bot.name} is resumed.</p>
      ) : next.length === 0 ? (
        <p className="text-[12.5px] text-faint">{automations.loaded ? "No duty is switched on." : "Reading its duties…"}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {next.map(({ duty, at }) => (
            <li key={duty.id} className="flex min-w-0 items-center gap-2 text-[12.5px]" data-testid="bot-up-next-row">
              <DutyIcon duty={duty} />
              <span className="min-w-0 flex-1 truncate text-foreground" title={duty.name}>{duty.name}</span>
              <span className="shrink-0 tabular-nums text-faint" title={at ?? undefined}>{at ? nextLabel(at) : "on event"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** When a duty runs next: its clock time today, else how far off. */
function nextLabel(at: string, now = Date.now()): string {
  const when = Date.parse(at);
  if (!Number.isFinite(when)) return "";
  const today = new Date(now).toDateString() === new Date(when).toDateString();
  return today ? clockOf(at) : relativeNext(at, now);
}

/** Suggestions from its look around, with how the last look went. */
function Suggestions({ bot }: { bot: Bot }) {
  const { view, error, reload } = useBotSuggestions(bot.id);
  const look = view?.status.lookAround ?? null;
  const open = view?.suggestions ?? [];
  const latest = open.find((suggestion) => suggestion.from.kind === "lookAround");
  const detail = latest ? `from Look around, ${clockOf(latest.created) || relativeTime(latest.created)}` : undefined;
  return (
    <section aria-label="Suggestions" className="flex min-w-0 flex-col gap-2" data-testid="bot-suggestions">
      <Heading detail={detail}>Suggestions{open.length > 0 && <span className="ml-1">{open.length}</span>}</Heading>
      {error && !view && <MachineHostError error={`Couldn't read ${bot.name}'s suggestions: ${error}`} onRestarted={reload} />}
      {view && <LookStatus bot={bot} look={look} onChanged={reload} />}
      {view && view.unreadable > 0 && (
        <p className="text-[12px] text-warning">{view.unreadable === 1 ? "1 suggestion was" : `${view.unreadable} suggestions were`} saved by a newer TerminalX and can't be shown here.</p>
      )}
      {open.length > 0 && (
        <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card" aria-label={`${bot.name}'s suggestions`}>
          {open.map((suggestion) => <SuggestionRow key={suggestion.number} bot={bot} suggestion={suggestion} onChanged={reload} />)}
        </ul>
      )}
      {view && open.length === 0 && <p className="rounded-lg border border-dashed border-hairline-strong px-3 py-2.5 text-[12.5px] text-faint">No suggestions waiting.</p>}
    </section>
  );
}

/** When the bot last looked and what came of it; a look that was refused or did nothing says why; off, a way on. */
function LookStatus({ bot, look, onChanged }: { bot: Bot; look: BuiltinStatus | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = lookLine(look, bot.name, (at) => {
    const since = relativeTime(at);
    return since === "now" ? "just now" : /^\d+[mhd]$/.test(since) ? `${since} ago` : `on ${since}`;
  });
  const refused = look?.last?.status === "completed" ? look.last.refusedWhat : [];
  const switchOn = () => {
    if (!look) return;
    setBusy(true);
    setError(null);
    dutiesApi.switch(bot.id, look.dutyId, true).then(onChanged, (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[12px] text-muted-foreground" data-testid="bot-look-status">
      <p className="min-w-0 break-words">
        {look?.running && <Loader2 className="mr-1 inline size-3 animate-spin align-[-2px]" aria-hidden />}
        {line}
        {bot.paused && " Paused: it does not look while paused."}
      </p>
      {refused.length > 0 && (
        <p className="min-w-0 break-words text-faint" data-testid="bot-look-refused">Refused: {refused.join(", ")}. It suggested them instead of doing them.</p>
      )}
      {look && !look.enabled && (
        <Button size="xs" variant="secondary" className="w-fit" disabled={busy} onClick={switchOn} data-testid="bot-look-switch-on">
          {busy ? <Loader2 className="animate-spin" /> : <Telescope />} Switch on Look around
        </Button>
      )}
      {error && <MachineHostError error={error} onRestarted={() => { setError(null); switchOn(); }} />}
    </div>
  );
}

function SuggestionRow({ bot, suggestion, onChanged }: { bot: Bot; suggestion: BotSuggestion; onChanged: () => void }) {
  const [busy, setBusy] = useState<"start" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<"start" | "dismiss" | null>(null);
  const act = (what: "start" | "dismiss") => {
    setBusy(what);
    setError(null);
    const call = what === "start" ? suggestionsApi.start(bot.id, suggestion.number) : suggestionsApi.dismiss(bot.id, suggestion.number);
    call.then(
      (answer) => {
        // Started, the item is made even when its message could not reach the home chat; that is said on the Home tab.
        if (what === "start" && "delivery" in answer && answer.delivery && !answer.delivery.sent) setError(`Item made, but ${bot.name} was not told: ${answer.delivery.error ?? "its home chat could not take the message"}`);
        onChanged();
      },
      (cause) => { setError(errorMessage(cause)); setFailed(what); },
    ).finally(() => setBusy(null));
  };
  return (
    <li className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5" data-testid="bot-suggestion" data-number={suggestion.number}>
      <span className="block break-words text-[12.5px] text-foreground">{suggestion.title}</span>
      <span className="block break-words text-[12px] text-faint">{suggestion.why}</span>
      <div className="flex items-center gap-3">
        <Button size="xs" disabled={!!busy || !!bot.paused} title={bot.paused ? `${bot.name} is paused` : `Make it an item and tell ${bot.name} to start`} onClick={() => act("start")} data-testid="bot-suggestion-start">
          {busy === "start" ? <Loader2 className="animate-spin" /> : <Play />} Start
        </Button>
        <button type="button" disabled={!!busy} onClick={() => act("dismiss")} className="text-[12px] text-faint outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50" data-testid="bot-suggestion-dismiss">
          Dismiss
        </button>
      </div>
      {error && <MachineHostError error={error} onRestarted={() => { setError(null); if (failed) act(failed); }} />}
    </li>
  );
}
