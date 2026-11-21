import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleStop, Github, Handshake, Inbox, ListChecks, Loader2, MessageSquare, MessageSquareReply, Pause, Play, Receipt, Timer } from "@/icons";
import { Button } from "@/components/ui/button";
import { botsApi, errorMessage } from "@/lib/api";
import { resumeBot } from "@/lib/bots";
import { clockTime, heldEntryStatus, heldEntryText, heldLine, heldNote, keptCount, numberWord, pausedBySentence, skippedCount, usePauseHeld, usePauseHeldError, wasLine } from "@/lib/botPause";
import { needsYouCount, useNeedsYou, useNeedsYouError } from "@/lib/botItems";
import { bindingText, useKeymap } from "@/lib/shortcuts";
import { cn } from "@/lib/cn";
import { openBot } from "@/lib/sessions";
import type { Bot, PauseHeld, PauseHeldEntry } from "@/types/bots";
import { BotAvatar, RunsOnIcon } from "./BotAvatar";
import { runsOnLabel } from "./botLabels";

/** "$9.80": what the page shows for spend, which is shown and never capped. */
export function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

type Spent = { usd: number; day: string } | null;

/**
 * What each bot spent today, read apart from what the pause holds: it reads every transcript. Read again when the
 * bots change (a pause or a resume). `null` for a bot whose spend could not be read; absent while it is read.
 */
function useSpentToday(bots: readonly Bot[]): Record<string, Spent> {
  const [spent, setSpent] = useState<Record<string, Spent>>({});
  const key = bots.map((bot) => `${bot.id}:${bot.paused?.at ?? ""}`).join("|");
  useEffect(() => {
    let live = true;
    const ids = key ? key.split("|").map((part) => part.split(":")[0]) : [];
    void Promise.all(ids.map((id) => botsApi.spentToday(id).then((answer): [string, Spent] => [id, answer], (): [string, Spent] => [id, null]))).then((pairs) => {
      if (live) setSpent(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return spent;
}

/**
 * What the paused bots spent since their pause: today's spend less what each pause recorded it had spent (all of
 * today's, for one paused on an earlier day). `null` when a bot's spend or its pause's record is not known.
 */
export function spendSincePause(bots: readonly Bot[], spent: Record<string, Spent | undefined>): number | null {
  let since = 0;
  for (const bot of bots.filter((value) => value.paused)) {
    const now = spent[bot.id];
    const before = bot.paused?.stopped?.spent;
    if (!now || !before) return null;
    since += before.day === now.day ? Math.max(0, now.usd - before.usd) : now.usd;
  }
  return since;
}

/**
 * Every bot paused (23.12): who paused them, from where and when; what is working, what needs you, what is held and
 * what was spent; each bot's state with what is held for it and its Resume; "Held while paused"; and what pause does.
 * Pause is loud, and says what it stopped. Resume all and Resume one by one are the way out.
 */
export function BotsPaused({ bots, busy, onResumeAll, onError, children }: { bots: Bot[]; busy: boolean; onResumeAll: () => void; onError: (error: string | null) => void; children?: ReactNode }) {
  const held = usePauseHeld();
  const heldError = usePauseHeldError();
  const needs = useNeedsYou();
  const needsError = useNeedsYouError();
  const spent = useSpentToday(bots);
  const team = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  // "18 minutes ago" moves on while the page is open.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const entries = held?.entries ?? [];
  const inTurn = held?.bots.reduce((sum, bot) => sum + bot.inTurn, 0) ?? 0;
  const workersStopped = bots.reduce((sum, bot) => sum + (bot.paused?.stopped?.workers ?? 0), 0);
  const asking = needsYouCount(needs, null);
  const spentValues = bots.map((bot) => spent[bot.id]);
  const spentToday = spentValues.some((value) => value === undefined) ? undefined : spentValues.some((value) => value === null) ? null : spentValues.reduce<number>((sum, value) => sum + (value?.usd ?? 0), 0);
  const since = spentToday === undefined ? undefined : spendSincePause(bots, spent);

  const resumeOneByOne = () => {
    team.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    team.current?.querySelector<HTMLButtonElement>("[data-testid=bots-paused-resume]")?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="bots-paused">
      <section role="status" aria-labelledby="bots-paused-title" className="flex flex-wrap items-start gap-3.5 rounded-lg border border-warning/40 bg-warning/[.07] px-4 py-3.5" data-testid="bots-paused-banner">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning"><Pause className="size-[18px]" /></span>
        <div className="min-w-[240px] flex-1">
          <h2 id="bots-paused-title" className="text-[14px] font-semibold text-foreground">
            {bots.length === 1 ? `${bots[0].name} is paused` : bots.length === 2 ? "Both bots are paused" : `All ${numberWord(bots.length)} bots are paused`}
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-5 text-muted-foreground" data-testid="bots-paused-by">
            {pausedBySentence(bots)} {inTurn > 0 ? `Nothing new starts on its own; ${inTurn === 1 ? "1 worker finishes the step it is on" : `${inTurn} workers finish the step they are on`}, then stops.` : "Nothing runs on its own."} A message you send to a bot is still answered, and the answer says the bot is paused; answering is the only thing it spends on.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={resumeOneByOne} data-testid="bots-resume-one-by-one"><ListChecks /> Resume one by one</Button>
          <Button variant="accent" size="sm" disabled={busy} onClick={onResumeAll} data-testid="bots-paused-resume-all">
            {busy ? <Loader2 className="animate-spin" /> : <Play />} Resume all
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 @4xl/editor-host:grid-cols-4" data-testid="bots-stats">
        <Stat label="Working now" value={String(inTurn)} note={inTurn > 0 ? `${inTurn === 1 ? "1 worker finishes" : `${inTurn} workers finish`} its current step` : workersStopped > 0 ? `${workersStopped === 1 ? "1 worker" : `${workersStopped} workers`} stopped at a safe point` : "Nothing was cut short"} />
        <Stat label="Needs you" value={needsError ? "—" : String(asking)} note={needsError ? "Couldn't be read" : "you can still answer; used on resume"} warn={asking > 0} />
        <Stat label="Held while paused" value={heldError && !held ? "—" : String(skippedCount(entries) + keptCount(entries))} note={heldError && !held ? "Couldn't be read" : heldNote(entries)} />
        <Stat label="Spent today" value={spentToday === undefined ? "…" : spentToday === null ? "—" : dollars(spentToday)} note={since === undefined ? "Reading…" : since === null ? "Since the pause: not known" : `${dollars(since)} since the pause`} />
      </div>

      {/* What needs you, to answer while paused: the answer is kept and used on resume. */}
      {children}

      <div className="flex min-w-0 flex-col gap-6 @5xl/editor-host:flex-row">
        <div className="min-w-0 flex-1" ref={team}>
          <h2 className="mb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Team</h2>
          <div className="min-w-0 overflow-x-auto scrollbar-thin" data-testid="bots-paused-team-scroll">
            <div className="min-w-[600px]" role="table" aria-label="Team">
              <div role="row" className="grid h-8 grid-cols-[190px_minmax(0,1fr)_150px_92px] items-center gap-x-3 border-b border-hairline px-4 text-[11px] font-medium uppercase tracking-[.06em] text-faint">
                <span role="columnheader">Bot</span>
                <span role="columnheader">State and what is held</span>
                <span role="columnheader">Runs on</span>
                <span role="columnheader"><span className="sr-only">Resume</span></span>
              </div>
              {bots.map((bot) => <PausedRow key={bot.id} bot={bot} held={held} onError={onError} />)}
            </div>
          </div>

          <h2 className="mb-1 mt-5 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Held while paused</h2>
          <HeldList entries={entries} bots={bots} held={held} error={heldError} />
        </div>
        <WhatPauseDoes />
      </div>
    </div>
  );
}

function Stat({ label, value, note, warn = false }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-card px-4 py-3" data-testid="bots-stat">
      <p className="truncate text-[11px] font-medium uppercase tracking-[.08em] text-faint">{label}</p>
      <p className={cn("mt-1 truncate text-[20px] font-semibold tracking-[-.01em]", warn ? "text-warning" : "text-foreground")}>{value}</p>
      <p className="mt-0.5 text-[12px] text-faint">{note}</p>
    </div>
  );
}

function PausedRow({ bot, held, onError }: { bot: Bot; held: PauseHeld | null; onError: (error: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const resume = () => {
    setBusy(true);
    resumeBot(bot.id).then(() => onError(null), (cause) => onError(errorMessage(cause))).finally(() => setBusy(false));
  };
  const was = wasLine(bot);
  const holding = heldLine(bot, held);
  return (
    <div role="row" className="grid h-[54px] grid-cols-[190px_minmax(0,1fr)_150px_92px] items-center gap-x-3 border-b border-hairline px-4" data-testid="bots-paused-row" data-bot={bot.id}>
      <span role="cell" className="min-w-0">
        <button type="button" onClick={() => openBot(bot.id)} aria-label={`Open ${bot.name}`} className="flex w-full min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <BotAvatar roleTemplateId={bot.roleTemplateId} size="md" paused />
          <span className="min-w-0 leading-4">
            <span className="block truncate text-[13px] text-foreground" title={bot.name}>{bot.name}</span>
            <span className="block truncate text-[11.5px] text-faint">{bot.roleTitle}</span>
          </span>
        </button>
      </span>
      <span role="cell" className="flex min-w-0 items-start gap-2 text-[12.5px] leading-4">
        <Pause className="mt-px size-[13px] shrink-0 text-warning" />
        <span className="min-w-0">
          <span className="block truncate text-foreground" title={was} data-testid="bots-paused-was">{bot.resumeRequest ? "Paused · asks to resume" : was}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-faint" title={holding} data-testid="bots-paused-held">{holding}</span>
        </span>
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted-foreground">
        <RunsOnIcon runsOn={bot.runsOn} className="size-[13px] shrink-0" />
        <span className="truncate">{runsOnLabel(bot.runsOn)}</span>
      </span>
      <span role="cell" className="justify-self-end">
        <Button variant="outline" size="xs" disabled={busy} onClick={resume} aria-label={`Resume ${bot.name}`} data-testid="bots-paused-resume">
          {busy ? <Loader2 className="animate-spin" /> : <Play />} Resume
        </Button>
      </span>
    </div>
  );
}

function entryIcon(entry: PauseHeldEntry) {
  switch (entry.source) {
    case "duty":
      return Timer;
    case "events":
      return Github;
    case "handoff":
      return Handshake;
    case "message":
      return MessageSquare;
    default:
      return MessageSquareReply;
  }
}

/** "Held while paused": what came due, arrived or was answered since the pause, oldest first, with what happens to it. */
export function HeldList({ entries, bots, held, error }: { entries: readonly PauseHeldEntry[]; bots: readonly Bot[]; held: PauseHeld | null; error: string | null }) {
  const problems = [...(held?.errors ?? []), ...(error ? [`What is held could not be read: ${error}`] : [])];
  return (
    <div className="min-w-0" data-testid="bots-held">
      {problems.map((problem) => (
        <p key={problem} role="alert" className="mb-1.5 rounded-md bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{problem}</p>
      ))}
      <ul className="rounded-lg border border-hairline bg-card/60 px-3.5" aria-label="Held while paused">
        {!held && !error && <li className="flex h-9 items-center text-[12.5px] text-faint">Reading what is held…</li>}
        {held && entries.length === 0 && <li className="flex h-9 items-center text-[12.5px] text-faint" data-testid="bots-held-empty">Nothing has come due or arrived since the pause.</li>}
        {entries.map((entry, index) => {
          const Icon = entryIcon(entry);
          const text = heldEntryText(entry, bots);
          return (
            <li key={`${entry.source}-${entry.botId}-${entry.at}-${index}`} className="flex h-9 min-w-0 items-center gap-2.5 border-t border-hairline text-[12.5px] first:border-t-0" data-testid="bots-held-entry" data-kind={entry.kind}>
              <span className="w-10 shrink-0 font-mono text-[11.5px] text-faint">{clockTime(entry.at)}</span>
              <Icon className="size-[13px] shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground" title={text}>{text}</span>
              <span className={cn("shrink-0 whitespace-nowrap pl-3 text-[12px]", entry.kind === "kept" ? "text-muted-foreground" : "text-faint")}>{heldEntryStatus(entry)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What pause does, and where it can be done from (23.12). */
function WhatPauseDoes() {
  const keys = useKeymap()["app.pauseAllBots"] ?? [];
  const items = [
    { icon: CircleStop, warn: true, title: "Stops everything unattended", text: "Duties, look-arounds, hand-offs and runs. A worker finishes the step it is on, then stops." },
    { icon: MessageSquare, title: "Keeps direct chat", text: "Your own messages are answered. The bot starts no work from them until you resume." },
    { icon: Inbox, title: "Keeps what arrives", text: "Events are kept and handled on resume. Scheduled checks that were due are skipped, not run late." },
    { icon: Receipt, title: "Stops spending", text: "Nothing starts on its own, so once the workers finish their step only the answers to your own messages are spent on." },
  ];
  return (
    <aside className="w-full shrink-0 @5xl/editor-host:w-[300px]" aria-labelledby="bots-pause-does" data-testid="bots-pause-does">
      <h2 id="bots-pause-does" className="mb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">What pause does</h2>
      {items.map(({ icon: Icon, warn, title, text }) => (
        <div key={title} className="flex gap-3 border-t border-hairline py-2.5 first-of-type:border-t-0">
          <Icon className={cn("mt-0.5 size-[15px] shrink-0", warn ? "text-warning" : "text-muted-foreground")} />
          <div className="leading-[18px]">
            <p className="text-[12.5px] font-medium text-foreground">{title}</p>
            <p className="mt-0.5 text-[12px] text-faint">{text}</p>
          </div>
        </div>
      ))}
      <h2 className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Where you can pause</h2>
      <p className="text-[12.5px] leading-[19px] text-muted-foreground" data-testid="bots-pause-where">
        The Pause button on every bot and its row's menu, Pause all here
        {keys.length > 0 ? <>, and <kbd className="rounded border border-hairline bg-well px-1 font-sans text-[11.5px] text-foreground">{bindingText(keys[0])}</kbd> from anywhere in TerminalX</> : null}
        . From a terminal, <code className="font-mono text-[11.5px]">terminalx bots pause-all</code>.
      </p>
    </aside>
  );
}
