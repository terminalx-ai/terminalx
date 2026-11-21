import { useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Circle, Clock, ListChecks, Loader2, Plus } from "@/icons";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { itemRunChip } from "@/lib/botRuns";
import { errorMessage } from "@/lib/api";
import { giveBotWork, needsYouOf, sameDay, snoozed, useBotItems, useNeedsYou } from "@/lib/botItems";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import type { Bot } from "@/types/bots";
import type { BotItem } from "@/types/botItems";
import { AgentQuestionCard, ItemQuestionCard, UndeliveredNotes } from "./NeedsYou";
import { BotReportsTo } from "./BotHandoffs";

/**
 * A bot's Home tab (PRO-469, design 23.01): what needs the owner, with answer buttons, what is in progress, what is
 * planned, and how much was done today or is snoozed. "Give <bot> work" adds an item the owner asked for and tells the
 * bot in its home chat. Who it reports to, and who reports to it, is PRO-475's; Up next and Suggestions are later tickets'.
 */
export function BotHome({ bot, onOpenItem }: { bot: Bot; onOpenItem: (number: number) => void }) {
  const needs = useNeedsYou();
  const { list, error } = useBotItems(bot.id);
  const [giving, setGiving] = useState(false);
  const [open, setOpen] = useState<{ done: boolean; snoozed: boolean }>({ done: false, snoozed: false });
  const items = list?.items ?? [];
  const asking = needsYouOf(needs, bot.id);
  const shown = items.filter((item) => !snoozed(item));
  const working = shown.filter((item) => item.state === "inProgress" || item.state === "waiting" || !KNOWN.includes(item.state));
  const planned = shown.filter((item) => item.state === "planned");
  const doneToday = items.filter((item) => item.state === "done" && sameDay(item.closed));
  const asleep = items.filter((item) => snoozed(item));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-testid="bot-home">
      <div className="flex max-w-[860px] min-w-0 flex-col gap-6 px-5 py-4 sm:px-6">
        {error && !list && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">Couldn't read {bot.name}'s work: {error}</p>}
        {list && list.unreadable > 0 && (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            {list.unreadable === 1 ? "1 item was" : `${list.unreadable} items were`} saved by a newer TerminalX and can't be shown here.
          </p>
        )}
        <UndeliveredNotes bots={[bot]} botId={bot.id} />
        <BotReportsTo bot={bot} />

        {asking.length > 0 && (
          <Section label="Needs you" count={asking.length} accent testId="bot-home-needs-you">
            <div className="divide-y divide-hairline overflow-hidden rounded-lg border border-accent/40 bg-card">
              {asking.map((entry) =>
                entry.kind === "item" ? (
                  <ItemQuestionCard key={`item-${entry.item.number}`} bot={bot} item={entry.item} onOpen={() => onOpenItem(entry.item.number)} />
                ) : (
                  <AgentQuestionCard key={entry.requestId} bot={bot} entry={entry} />
                ),
              )}
            </div>
          </Section>
        )}

        <Section label="In progress" count={working.length} testId="bot-home-in-progress">
          {working.length > 0 ? <ItemRows items={working} onOpen={onOpenItem} /> : <Empty>{list ? `${bot.name} is not working on anything right now.` : <Reading />}</Empty>}
        </Section>

        <Section
          label="Planned"
          count={planned.length}
          testId="bot-home-planned"
          action={
            <Button size="xs" variant="ghost" onClick={() => setGiving((value) => !value)} data-testid="bot-give-work">
              <Plus /> Give {bot.name} work
            </Button>
          }
        >
          {giving && <GiveWork bot={bot} onClose={() => setGiving(false)} onGiven={() => setGiving(false)} />}
          {planned.length > 0 ? <ItemRows items={planned} onOpen={onOpenItem} /> : !giving && <Empty>{list ? "Nothing planned." : <Reading />}</Empty>}
        </Section>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-4 text-[12.5px] text-muted-foreground">
            <Fold label="Done today" count={doneToday.length} open={open.done} onToggle={() => setOpen((value) => ({ ...value, done: !value.done }))} />
            <Fold label="Snoozed" count={asleep.length} open={open.snoozed} onToggle={() => setOpen((value) => ({ ...value, snoozed: !value.snoozed }))} />
          </div>
          {open.done && doneToday.length > 0 && <ItemRows items={doneToday} onOpen={onOpenItem} />}
          {open.snoozed && asleep.length > 0 && <ItemRows items={asleep} onOpen={onOpenItem} />}
        </div>
      </div>
    </div>
  );
}

const KNOWN = ["planned", "inProgress", "needsYou", "waiting", "done", "dropped"];

function Reading() {
  return <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Reading the list…</span>;
}

function Section({ label, count, accent = false, action, testId, children }: { label: string; count: number; accent?: boolean; action?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <section aria-label={label} data-testid={testId} className="flex min-w-0 flex-col gap-2">
      <div className="flex h-6 items-center justify-between gap-2">
        <h2 className={cn("text-[11px] font-medium uppercase tracking-[.08em]", accent ? "text-accent" : "text-faint")}>
          {label} <span className="ml-1">{count}</span>
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-hairline-strong px-4 py-3 text-[12.5px] text-faint">{children}</p>;
}

function Fold({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} disabled={count === 0} className="inline-flex items-center gap-1 hover:text-foreground disabled:hover:text-muted-foreground" data-testid={`bot-home-${label === "Done today" ? "done" : "snoozed"}`}>
      {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {label} · {count}
    </button>
  );
}

export function StateIcon({ item, className }: { item: Pick<BotItem, "state">; className?: string }) {
  switch (item.state) {
    case "inProgress":
      return <Loader2 aria-label="In progress" className={cn("text-warning", className)} />;
    case "waiting":
      return <Clock aria-label="Waiting" className={cn("text-muted-foreground", className)} />;
    case "done":
      return <ListChecks aria-label="Done" className={cn("text-add", className)} />;
    default:
      return <Circle aria-label={item.state} className={cn("text-faint", className)} />;
  }
}

/** A short line under an item's title: its summary's first line, else what happened last. */
function subline(item: BotItem): string {
  const summary = item.summary?.split("\n").find((line) => line.trim());
  return summary?.trim() ?? item.lastActivity?.text ?? "";
}

function ItemRows({ items, onOpen }: { items: BotItem[]; onOpen: (number: number) => void }) {
  return (
    <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card" aria-label="Items">
      {items.map((item) => {
        const lines = item.doneMeans ?? [];
        const met = lines.filter((line) => line.met).length;
        const sub = subline(item);
        return (
          <li key={item.number}>
            <button type="button" onClick={() => onOpen(item.number)} className="flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left hover:bg-veil" data-testid="bot-item-row" data-state={item.state}>
              <StateIcon item={item} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground" title={item.title}>{item.title}</span>
                {sub && <span className="block truncate text-[12px] text-faint" title={sub}>{sub}</span>}
              </span>
              <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
                {itemRunChip(item) && <Chip title="The runs it links" data-testid="bot-item-run-chip">{itemRunChip(item)}</Chip>}
                {lines.length > 0 && <Chip title="Done means met">{met} of {lines.length}</Chip>}
                {item.state === "waiting" && <span className="text-[12px] text-muted-foreground">Waiting</span>}
                {!KNOWN.includes(item.state) && <Chip title="A state this version of TerminalX does not know">{item.state}</Chip>}
              </span>
              <span className="w-10 shrink-0 text-right text-[11.5px] text-faint" title={item.modified}>{relativeTime(item.modified)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Give <bot> work": a title and, if wanted, what it is about. */
function GiveWork({ bot, onClose, onGiven }: { bot: Bot; onClose: () => void; onGiven: () => void }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    giveBotWork(bot.id, title.trim(), summary.trim()).then(() => onGiven(), (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-2 rounded-lg border border-hairline bg-card px-4 py-3" data-testid="bot-give-work-form" aria-label={`Give ${bot.name} work`}>
      <input
        autoFocus
        spellCheck={false}
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        placeholder="What should it do?"
        aria-label="What should it do?"
        className="h-8 min-w-0 rounded-md border border-border bg-transparent px-2 text-[13px] text-foreground outline-none focus:border-ring"
      />
      <textarea
        spellCheck={false}
        value={summary}
        maxLength={4000}
        rows={2}
        onChange={(event) => setSummary(event.target.value)}
        placeholder="More about it (optional)"
        aria-label="More about it"
        className="min-w-0 resize-y rounded-md border border-border bg-transparent px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-ring"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="mr-auto min-w-0 text-[12px] text-faint">{bot.name} is told in its home chat, and plans it in its list.</p>
        {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
        <Button size="sm" variant="ghost" type="button" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="accent" type="submit" disabled={busy || !title.trim()}>{busy && <Loader2 className="animate-spin" />} Give work</Button>
      </div>
    </form>
  );
}
