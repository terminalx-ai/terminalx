import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref, type RefObject } from "react";
import { ArrowLeft, ArrowLeftRight, ArrowRight, CornerDownRight, Loader2, RotateCw, Square } from "@/icons";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { errorMessage } from "@/lib/api";
import { chainLine, chainOf, handoffChains, stepTime, type ChainStep, type HandoffChain } from "@/lib/botHandoffChains";
import { botHandoffsApi, handoffOpen, handoffStateLabel, useAllBotHandoffs } from "@/lib/botHandoffs";
import { useBotStore } from "@/lib/bots";
import { showBotsTeam, useBotsPage } from "@/lib/botsPage";
import { cn } from "@/lib/cn";
import { restartRequired } from "@/lib/machines";
import type { Bot } from "@/types/bots";
import type { Handoff, HandoffList } from "@/types/botHandoffs";
import { BotAvatar } from "./BotAvatar";

/**
 * The Hand-offs page under Bots (PRO-540, designs 23.16 and 23.19): every chain of hand-offs between bots on the
 * left, one chain's thread on the right. A thread's steps are in the order they were made, stepped in once for each
 * hand-off deeper; each says its number, how deep the limit counts it, and which try it is when it was handed again.
 * Stop on an open step stops that one hand-off, the same call as the strip above a bot's chat makes.
 *
 * What joins hand-offs into a chain is only what each recorded when it was made (`@/lib/botHandoffChains`). The
 * thread shows what the hand-off records hold: the work, its answer in the answering bot's words, a stop. Messages
 * one bot tells another are not in it: they are saved without a hand-off's number.
 *
 * Under 820 wide (the page's own width, which is 492 in a 760 window) the page folds to one column (23.18): the list or
 * one thread, never both. Opening a chain shows its thread with "All hand-offs" above it to go back, and going back shows
 * the list with that chain still marked. Every way in lands on a thread. Steps are stepped in 14 instead of 28.
 */

/** The page folds to one column when it is narrower than this (23.18). */
export const FOLD_BELOW = 820;

/**
 * The page's own width, kept up to date as it changes: null until it is measured. jsdom lays nothing out and measures
 * 0, which is a page that is not laid out, so it never folds.
 */
function usePageWidth(page: RefObject<HTMLDivElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = page.current;
    if (!node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [page]);
  return width;
}

const GONE = "a bot no longer here";

function nameOf(bots: readonly Bot[], id: string): string {
  return bots.find((bot) => bot.id === id)?.name ?? GONE;
}

/** Re-render every 30 seconds while `on`, so an elapsed time stays true. */
function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** "2 hand-offs were saved by a newer TerminalX and can't be shown here. Update the app to see them." */
export function unreadableHandoffsText(count: number): string {
  return `${count === 1 ? "1 hand-off was" : `${count} hand-offs were`} saved by a newer TerminalX and can't be shown here. Update the app to see ${count === 1 ? "it" : "them"}.`;
}

/**
 * What the page says of records this build cannot read. Hand-offs and messages are counted apart: a message that
 * cannot be read is not a hand-off that cannot be shown. A runtime from before the counts were split gives only their
 * sum, which is said as what it is.
 */
export function unreadableNotes(list: Pick<HandoffList, "unreadable" | "unreadableHandoffs" | "unreadableMessages">): { of: "handoffs" | "messages" | "records"; text: string }[] {
  if (list.unreadableHandoffs === undefined) {
    if (list.unreadable <= 0) return [];
    const one = list.unreadable === 1;
    return [{ of: "records", text: `${one ? "1 hand-off or message between bots was" : `${list.unreadable} hand-offs or messages between bots were`} saved by a newer TerminalX and can't be shown here. Update the app to see ${one ? "it" : "them"}.` }];
  }
  const notes: ReturnType<typeof unreadableNotes> = [];
  if (list.unreadableHandoffs > 0) notes.push({ of: "handoffs", text: unreadableHandoffsText(list.unreadableHandoffs) });
  const messages = list.unreadableMessages ?? 0;
  if (messages > 0) notes.push({ of: "messages", text: `${messages === 1 ? "1 message between bots was" : `${messages} messages between bots were`} saved by a newer TerminalX too. This version does not deliver or count ${messages === 1 ? "it" : "them"}.` });
  return notes;
}

/** A state's colour: working is under way, answered is done, could-not is a failure; the rest are quiet. */
function stateTone(handoff: Pick<Handoff, "state">): string {
  switch (handoff.state) {
    case "working":
      return "text-warning";
    case "answered":
      return "text-add";
    case "failed":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

/** A chain's state in the list, in a word or two: no elapsed time, and no bot's name, which its avatars show. */
function chainState(chain: HandoffChain, bots: readonly Bot[]): string {
  const lead = chain.lead;
  if (lead.state === "working") return "Working";
  if (lead.state === "waiting") return "Waiting";
  return handoffStateLabel(lead, nameOf(bots, lead.to));
}

export function BotsHandoffs() {
  const page = useBotsPage();
  const { bots } = useBotStore();
  const { list, error, reload } = useAllBotHandoffs();
  const chains = useMemo(() => handoffChains(list?.handoffs ?? []), [list]);
  // The chain picked in the list, by a hand-off in it; and the step a way in asked for, which the thread opens at.
  const asked = page.page === "handoffs" ? page.number : undefined;
  const [picked, setPicked] = useState<number | null>(asked ?? null);
  const [step, setStep] = useState<number | null>(asked ?? null);
  // Folded, which of the two shows. Every way in lands on a thread: the asked-for one, or the one the wide page opens at.
  const [view, setView] = useState<"list" | "thread">("thread");
  // Where the keyboard goes once the folded page shows what was asked for: the thread's title, or the marked chain.
  const focusNext = useRef<"thread" | "list" | null>("thread");
  // Every request is taken, the same number asked again too: `page` is a new value for each.
  useEffect(() => {
    setPicked(asked ?? null);
    setStep(asked ?? null);
    setView("thread");
    focusNext.current = "thread";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  const root = useRef<HTMLDivElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const width = usePageWidth(root);
  const folded = width !== null && width > 0 && width < FOLD_BELOW;

  const found = picked === null ? null : chainOf(chains, picked);
  const chain = found ?? chains[0] ?? null;
  // Asked for a hand-off that is not among those read: said, never shown as some other one.
  const missing = !!list && step !== null && !chainOf(chains, step) ? step : null;
  const open = chains.filter((value) => value.open).length;
  const waitsPaused = (list?.handoffs ?? []).filter((handoff) => handoff.state === "waiting" && !!bots.find((bot) => bot.id === handoff.to)?.paused).length;
  const notes = list ? unreadableNotes(list) : [];
  // "No hand-offs yet" is true only of a read that worked, found none, and left none unread.
  const none = !!list && list.handoffs.length === 0 && (list.unreadableHandoffs ?? list.unreadable) === 0;
  // Which of its kind the shown chain is, for the folded thread's bar: "1 of 2 open".
  const kin = chain ? chains.filter((value) => value.open === chain.open) : [];
  const position = chain ? `${kin.indexOf(chain) + 1} of ${kin.length} ${chain.open ? "open" : "closed"}` : "";

  // Folded, a thread that opens takes the keyboard to its title, and "All hand-offs" takes it to the marked chain. Wide,
  // the list stays where it is. Nothing moves until the page is measured and the read has ended.
  useEffect(() => {
    const want = focusNext.current;
    if (!want || width === null || (!list && !error)) return;
    if (!folded || error || !chain) {
      focusNext.current = null;
      return;
    }
    const target = want === "thread" ? heading.current : root.current?.querySelector<HTMLElement>("[data-testid=bots-handoffs-chain][aria-current=true]");
    // Asked in the same commit that changes what shows: it is there on the next one.
    if (!target) return;
    focusNext.current = null;
    target.focus();
  });
  const pick = (number: number) => {
    setPicked(number);
    setStep(null);
    setView("thread");
    if (folded) focusNext.current = "thread";
  };
  const back = (number: number) => {
    // The same chain stays marked, even if a newer one comes first by the time the list shows.
    setPicked(number);
    setView("list");
    focusNext.current = "list";
  };
  const gutter = folded ? "px-4" : "px-6";

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" data-testid="bots-handoffs" data-folded={folded ? "true" : "false"}>
      <header className={cn("flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-hairline py-2", folded ? "gap-y-1 px-4" : "gap-y-2 px-6")} data-testid="bots-handoffs-header">
        <Button variant="ghost" size="sm" className="-ml-2 shrink-0 text-muted-foreground" onClick={() => showBotsTeam(true)} data-testid="bots-handoffs-back">
          <ArrowLeft /> Bots
        </Button>
        <h1 className="shrink-0 text-[15px] font-semibold text-foreground">Hand-offs</h1>
        {/* Folded, the sentence takes its own line under the title, whole, so the counts keep their place. */}
        <p className={cn("min-w-0 text-[12.5px] text-faint", folded ? "order-last basis-full leading-[18px] break-words" : "flex-1 basis-[12rem] truncate")} data-testid="bots-handoffs-about">Work your bots passed to each other, one thread for each chain.</p>
        {/* No counts until the read ends, and none over a read that failed. */}
        {list && !error && (open > 0 || waitsPaused > 0) && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2" data-testid="bots-handoffs-counts">
            {open > 0 && <Chip className="whitespace-nowrap text-warning">{open} open</Chip>}
            {waitsPaused > 0 && <Chip className="whitespace-nowrap text-muted-foreground">{waitsPaused === 1 ? "1 waits" : `${waitsPaused} wait`} for a paused bot</Chip>}
          </div>
        )}
      </header>

      {error ? (
        // The read failed: said in the Bots page's own row, and nothing of an earlier read stays under it.
        <div className={cn("min-h-0 flex-1 py-4", gutter)}>
          <ReadError error={error} onRetry={reload} />
        </div>
      ) : !list ? (
        <div className={cn("min-h-0 flex-1 py-4", gutter)}>
          <p role="status" className="flex items-center gap-2 text-[12.5px] text-faint" data-testid="bots-handoffs-reading">
            <Loader2 className="size-3.5 animate-spin" /> Reading the hand-offs…
          </p>
        </div>
      ) : (
        <>
          {(notes.length > 0 || missing !== null) && (
            <div className={cn("flex shrink-0 flex-col gap-2 border-b border-hairline py-3", gutter)}>
              {notes.map((note) => (
                <p key={note.of} className="rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning" data-testid="bots-handoffs-unreadable" data-of={note.of}>{note.text}</p>
              ))}
              {missing !== null && (
                <p role="status" className="rounded-md bg-veil px-3 py-2 text-[12.5px] text-muted-foreground" data-testid="bots-handoffs-missing">
                  Hand-off {missing} is not among the hand-offs kept here. It may be older than what is kept, or saved by a newer TerminalX.
                </p>
              )}
            </div>
          )}
          {none ? (
            <div className={cn("flex min-h-0 flex-1 items-center justify-center pb-16", gutter)} data-testid="bots-handoffs-empty">
              <div className="w-full max-w-[440px] text-center">
                <span className="inline-flex size-11 items-center justify-center rounded-xl border border-hairline bg-card text-muted-foreground"><ArrowLeftRight className="size-5" /></span>
                <h2 className="mt-3 text-[15px] font-semibold text-foreground">No hand-offs yet</h2>
                <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
                  When one bot hands work to another, the chain shows here as one thread. To hand a bot's item on yourself, open the item and choose Hand to another bot.
                </p>
              </div>
            </div>
          ) : chain ? (
            <div className="flex min-h-0 flex-1">
              {(!folded || view === "list") && <ChainList chains={chains} bots={bots} selected={chain.root} folded={folded} onPick={pick} />}
              {(!folded || view === "thread") && (
                <Thread
                  key={chain.root}
                  chain={chain}
                  bots={bots}
                  list={list}
                  step={step !== null && chainOf([chain], step) ? step : null}
                  folded={folded}
                  position={position}
                  heading={heading}
                  onBack={() => back(chain.root)}
                />
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A read that failed, as the Bots page says its own: the error as written with Retry, or Restart runtime when only that helps. */
function ReadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (restartRequired(error)) return <MachineHostError error={error} onRestarted={onRetry} className="rounded-md bg-destructive/10 px-3 py-2" />;
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive" data-testid="bots-handoffs-error">
      <span className="min-w-0 flex-1 basis-[12rem] break-words">Couldn't read the hand-offs: {error}</span>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry} data-testid="bots-handoffs-retry">
        <RotateCw /> Retry
      </Button>
    </div>
  );
}

/** The bots a chain passed through, as small avatars with arrows between. */
function BotPath({ ids, bots, names = false }: { ids: readonly string[]; bots: readonly Bot[]; names?: boolean }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1" aria-label={ids.map((id) => nameOf(bots, id)).join(" to ")}>
      {ids.map((id, index) => {
        const bot = bots.find((value) => value.id === id);
        return (
          <span key={id} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ArrowRight className="size-[11px] shrink-0 text-faint" />}
            <BotAvatar roleTemplateId={bot?.roleTemplateId ?? ""} size="xs" paused={!!bot?.paused} />
            {names && <span className="min-w-0 truncate text-foreground">{bot?.name ?? GONE}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** The chains, open ones first. The one whose thread shows, or showed last when folded, is marked. Folded, it fills the page. */
function ChainList({ chains, bots, selected, folded, onPick }: { chains: readonly HandoffChain[]; bots: readonly Bot[]; selected: number; folded: boolean; onPick: (root: number) => void }) {
  const groups = [
    { label: "Open", chains: chains.filter((chain) => chain.open) },
    { label: "Closed", chains: chains.filter((chain) => !chain.open) },
  ].filter((group) => group.chains.length > 0);
  return (
    <nav aria-label="Chains of hand-offs" className={cn("overflow-y-auto p-2 scrollbar-thin", folded ? "min-w-0 flex-1" : "w-[clamp(11rem,34%,20.75rem)] shrink-0 border-r border-hairline")} data-testid="bots-handoffs-list">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label} className="mb-2 last:mb-0">
          <h2 className="flex h-8 items-center px-3 text-[11px] font-medium uppercase tracking-[.08em] text-faint">{group.label}</h2>
          <ul className="flex flex-col">
            {group.chains.map((chain) => {
              const state = chainState(chain, bots);
              return (
                <li key={chain.root}>
                  <button
                    type="button"
                    aria-current={chain.root === selected ? "true" : undefined}
                    onClick={() => onPick(chain.root)}
                    className={cn("flex w-full min-w-0 flex-col rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40", chain.root === selected ? "bg-veil-strong" : "hover:bg-veil")}
                    data-testid="bots-handoffs-chain"
                    data-chain={chain.root}
                    data-open={chain.open ? "true" : "false"}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <BotPath ids={chain.bots} bots={bots} />
                      <Chip className={cn("ml-auto min-w-0 whitespace-nowrap", stateTone(chain.lead))} title={state} data-testid="bots-handoffs-chain-state">
                        {chain.lead.state === "working" && <Loader2 className="size-3 shrink-0 animate-spin" />}
                        <span className="truncate">{state}</span>
                      </Chip>
                    </span>
                    <span className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-[18px] break-words text-foreground" title={chain.title}>{chain.title}</span>
                    <span className="mt-0.5 truncate text-[11.5px] text-faint" data-testid="bots-handoffs-chain-line">{chainLine(chain)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** How deep the chain got, of how deep one may get: a bar for each level, then the same in words. */
function DepthMeter({ depth, max }: { depth: number; max: number | undefined }) {
  if (!max) return <span className="whitespace-nowrap" data-testid="bots-handoffs-depth">{depth} deep</span>;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" data-testid="bots-handoffs-depth">
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: max }, (_, index) => <span key={index} className={cn("h-1.5 w-3.5 rounded-sm", index < depth ? "bg-warning" : "bg-veil-strong")} />)}
      </span>
      {depth} of {max} deep · a chain stops at {max}
    </span>
  );
}

interface ThreadProps {
  chain: HandoffChain;
  bots: readonly Bot[];
  list: HandoffList;
  step: number | null;
  /** The page is one column: the thread fills it, under a bar with "All hand-offs" and which of its kind it is. */
  folded: boolean;
  position: string;
  heading: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
}

/**
 * One chain: its title, its bots, how deep it got, the trust line, then its steps. Opens at `step` when a way in asked
 * for one. Folded, "All hand-offs" above it goes back to the list.
 */
function Thread({ chain, bots, list, step, folded, position, heading, onBack }: ThreadProps) {
  const now = useTicking(chain.steps.some(({ handoff }) => handoff.state === "working"));
  const [stopping, setStopping] = useState<number[]>([]);
  // Why a Stop failed, by hand-off number, kept until it is tried again.
  const [stopErrors, setStopErrors] = useState<Record<number, string>>({});
  const setStopError = (number: number, message: string | null) => setStopErrors((errors) => {
    const rest = { ...errors };
    delete rest[number];
    return message === null ? rest : { ...rest, [number]: message };
  });
  // The strip's Stop, for this one hand-off: nothing else in the chain is asked to stop.
  const stop = (number: number) => {
    setStopping((numbers) => [...numbers, number]);
    setStopError(number, null);
    botHandoffsApi.stop(number).then(() => undefined, (cause) => setStopError(number, errorMessage(cause))).finally(() => setStopping((numbers) => numbers.filter((value) => value !== number)));
  };
  const at = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (step !== null) at.current?.scrollIntoView?.({ block: "center" });
  }, [step]);

  return (
    <section aria-label={`Thread: ${chain.title}`} className="flex min-w-0 flex-1 flex-col" data-testid="bots-handoffs-thread" data-chain={chain.root}>
      {folded && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-2" data-testid="bots-handoffs-thread-bar">
          <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={onBack} data-testid="bots-handoffs-all">
            <ArrowLeft /> All hand-offs
          </Button>
          <span className="ml-auto pr-2 text-[11.5px] whitespace-nowrap text-faint" data-testid="bots-handoffs-position">{position}</span>
        </div>
      )}
      <div className={cn("shrink-0 border-b border-hairline pb-3", folded ? "px-4 pt-3" : "px-6 pt-4")}>
        <h2 ref={heading} tabIndex={-1} className="text-[15px] font-semibold leading-5 break-words text-foreground outline-none" data-testid="bots-handoffs-title">{chain.title}</h2>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted-foreground">
          <BotPath ids={chain.bots} bots={bots} names />
          {/* Folded, the bots wrap and the depth takes the next line. */}
          <span className={folded ? "basis-full" : "ml-auto"}><DepthMeter depth={chain.depth} max={list.maxDepth} /></span>
        </div>
        <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] leading-4 text-faint" data-testid="bots-handoffs-trust">
          <CornerDownRight className="mt-[2.5px] size-[11px] shrink-0" />
          <span className="min-w-0">Every step and message in this thread is a bot's words, not an approval.</span>
        </p>
      </div>
      <ol className={cn("min-h-0 flex-1 overflow-y-auto pt-4 scrollbar-thin", folded ? "px-4" : "px-6")} data-testid="bots-handoffs-steps">
        {chain.steps.map((value, index) => (
          <Step
            key={value.handoff.number}
            ref={value.handoff.number === step ? at : undefined}
            step={value}
            bots={bots}
            list={list}
            now={now}
            last={index === chain.steps.length - 1}
            current={value.handoff.number === step}
            folded={folded}
            busy={stopping.includes(value.handoff.number)}
            stopError={stopErrors[value.handoff.number] ?? null}
            onStop={() => stop(value.handoff.number)}
            onStopFailed={(message) => setStopError(value.handoff.number, message)}
          />
        ))}
      </ol>
    </section>
  );
}

/** How far a step is stepped in for each hand-off deeper: half as far when the page is folded (23.18). */
const INDENT = 28;
const FOLDED_INDENT = 14;

interface StepProps {
  step: ChainStep;
  bots: readonly Bot[];
  list: HandoffList;
  now: number;
  last: boolean;
  current: boolean;
  folded: boolean;
  busy: boolean;
  stopError: string | null;
  onStop: () => void;
  onStopFailed: (message: string) => void;
  ref?: Ref<HTMLLIElement>;
}

/**
 * One hand-off in the thread: who to whom, its number and how deep the limit counts it, its state, a Stop while it is
 * open, and when it was made; under them the work, and its answer in the words of whoever gave it.
 */
function Step({ step, bots, list, now, last, current, folded, busy, stopError, onStop, onStopFailed, ref }: StepProps) {
  const { handoff, level } = step;
  const from = bots.find((bot) => bot.id === handoff.from);
  const to = bots.find((bot) => bot.id === handoff.to);
  const fromName = from?.name ?? GONE;
  const toName = to?.name ?? GONE;
  const state = handoffStateLabel(handoff, toName, now, !!to?.paused);
  const depth = Math.max(1, handoff.depth || 1);
  const tries = list.maxRetries === undefined ? null : list.maxRetries + 1;
  const answer = handoff.answer;
  // What TerminalX said when it could not start or reach the bot is the app's word, not a bot's.
  const answeredBy = answer ? (answer.by === "terminalx" ? "TerminalX" : `${nameOf(bots, answer.by)} · a bot's words, not an approval`) : "";
  const failed = handoff.state === "failed" || !!answer?.failed;
  const waits = handoff.waitingMessages > 0 ? `${handoff.waitingMessages === 1 ? "1 message waits" : `${handoff.waitingMessages} messages wait`} for its chat to start.` : null;
  return (
    <li ref={ref} className="flex min-w-0 gap-3" style={{ marginLeft: level * (folded ? FOLDED_INDENT : INDENT) }} aria-label={`Hand-off ${handoff.number}: ${handoff.title}`} aria-current={current ? "step" : undefined} data-testid="bots-handoffs-step" data-number={handoff.number} data-level={level} data-state={handoff.state}>
      <span className="flex w-7 shrink-0 flex-col items-center">
        <BotAvatar roleTemplateId={from?.roleTemplateId ?? ""} size="sm" paused={!!from?.paused} />
        {!last && <span className="mt-1 w-px flex-1 bg-border" />}
      </span>
      <div className="min-w-0 flex-1 pb-4">
        <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 text-[12px]", folded ? "gap-y-1.5" : "gap-y-1")}>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{handoff.by === "owner" ? "You" : fromName}</span>
            <ArrowRight className="size-3 shrink-0 text-faint" />
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground">
              <BotAvatar roleTemplateId={to?.roleTemplateId ?? ""} size="xs" paused={!!to?.paused} />
              <span className="min-w-0 truncate">{toName}</span>
            </span>
            <span className="whitespace-nowrap text-faint" data-testid="bots-handoffs-step-depth">#{handoff.number} · {list.maxDepth ? `${depth} of ${list.maxDepth}` : `depth ${depth}`}</span>
          </span>
          {/* Folded, the state, Stop and the time take their own line under the names. */}
          <span className={cn("flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1", folded ? "basis-full" : "ml-auto justify-end")} data-testid="bots-handoffs-step-status">
            <Chip className={cn("min-w-0 whitespace-nowrap", stateTone(handoff))} title={state} data-testid="bots-handoffs-step-state">
              {handoff.state === "working" && <Loader2 className="size-3 shrink-0 animate-spin" />}
              <span className="truncate">{state}</span>
            </Chip>
            {handoffOpen(handoff) && (
              <Button size="xs" variant="outline" className="min-w-0 max-w-full shrink-0" disabled={busy} onClick={onStop} data-testid="bots-handoffs-stop" aria-label={`Stop ${toName}'s work on hand-off ${handoff.number}`} title={`Stop ${toName}'s work on this hand-off`}>
                {busy ? <Loader2 className="animate-spin" /> : <Square />} <span className="truncate">Stop {toName}</span>
              </Button>
            )}
            <time className={cn("shrink-0 whitespace-nowrap text-[11.5px] text-faint", folded && "ml-auto")} dateTime={handoff.created} title={handoff.created}>{stepTime(handoff.created, now)}</time>
          </span>
        </div>
        {stopError && <MachineHostError error={stopError} onRestarted={onStop} onFailed={onStopFailed} className="mt-1.5" />}
        <div className={cn("mt-1.5 min-w-0 rounded-xl border bg-card py-2.5", folded ? "px-3" : "px-4", current ? "border-accent/60" : "border-hairline")}>
          <p className="text-[13.5px] font-medium leading-5 break-words text-foreground">{handoff.title}</p>
          {handoff.by === "owner" && (
            <p className="mt-1 text-[11.5px] leading-[17px] text-muted-foreground" data-testid="bots-handoffs-step-owner">
              You handed {handoff.fromItem ? `${fromName}'s item #${handoff.fromItem}` : `this work of ${fromName}'s`} to {toName}. Its title is {fromName}'s words.
            </p>
          )}
          {handoff.by === "owner" && handoff.note && (
            <p className="mt-1.5 border-l-2 border-accent/50 pl-2.5 text-[12.5px] leading-[19px] break-words whitespace-pre-wrap text-foreground" data-testid="bots-handoffs-step-note">
              <span className="font-medium">Your note · your own words:</span> {handoff.note}
            </p>
          )}
          {typeof handoff.retryOf === "number" && (
            <p className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-[17px] text-muted-foreground" data-testid="bots-handoffs-step-retry">
              <RotateCw className="mt-[2.5px] size-3 shrink-0" />
              <span className="min-w-0">{fromName} handed hand-off {handoff.retryOf} again · try {(handoff.attempt ?? 0) + 1}{tries ? ` of ${tries}` : ""}</span>
            </p>
          )}
          {/* The work as its sender scoped it, until there is an answer to read in its place. Two lines on the wide page;
              folded, whole, so nothing the wide page shows in full is cut short in the narrow one. */}
          {!answer && handoff.by !== "owner" && handoff.scope && (
            <p className={cn("mt-1 text-[12.5px] leading-[19px] break-words text-muted-foreground", !folded && "line-clamp-2")} title={handoff.scope} data-testid="bots-handoffs-step-scope">{handoff.scope}</p>
          )}
          {answer && (
            <p className={cn("mt-2 border-l-2 pl-2.5 text-[12.5px] leading-[19px] break-words whitespace-pre-wrap", failed ? "border-destructive/60 text-destructive" : "border-hairline-strong text-muted-foreground")} data-testid="bots-handoffs-step-answer">
              <span className="font-medium">{answeredBy}:</span> {answer.text}
            </p>
          )}
          {waits && <p className="mt-1 text-[11.5px] text-faint" data-testid="bots-handoffs-step-waiting">{waits}</p>}
        </div>
      </div>
    </li>
  );
}
