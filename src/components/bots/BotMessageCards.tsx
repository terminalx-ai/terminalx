import { useEffect, useState, type ReactNode } from "react";
import { openExternalWebUrl } from "@/lib/externalUrl";
import type { BotMessage, HandoffNote, MentionSource } from "@terminalx/portable/events";
import { messageTime } from "@terminalx/portable/transcript";
import {
  AppWindow, ArrowRight, ArrowRightLeft, ChevronDown, ChevronRight, CornerDownRight, ExternalLink, Eye, GitCommitVertical, GitPullRequest, Github, Hash,
  ListTodo, Loader2, MessageSquare, RotateCw, Send, ShieldOff, Square, SquareKanban, TriangleAlert, UserCheck,
} from "@/icons";
import { useDisclosure } from "@/components/chat/disclosures";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Chip, ChipButton } from "@/components/ui/chip";
import { errorMessage } from "@/lib/api";
import { botHandoffsApi, handoffOpen, handoffStateLabel, useSharedBotHandoffs } from "@/lib/botHandoffs";
import { openBotItem, useBotItems } from "@/lib/botItems";
import { useBotStore } from "@/lib/bots";
import { cn } from "@/lib/cn";
import { showBotsHandoffs } from "@/lib/botsPage";
import { openBot, selectSession } from "@/lib/sessions";
import type { Bot, BotAccess } from "@/types/bots";
import { effectiveAccess } from "@/types/bots";
import type { Handoff, UndeliveredMessage } from "@/types/botHandoffs";
import { BotAvatar } from "./BotAvatar";
import { lowerAccessLine, relationLine } from "./botCardLines";
import { accessLabel } from "./botLabels";

/**
 * What TerminalX puts in a bot's chat, drawn as cards (PRO-539, designs 23.14, 23.15, 23.17 and 23.18): a hand-off, a
 * tell or an answer from another bot, a mention from GitHub, Linear, Slack or Telegram, and the app's own lines.
 *
 * Every card is drawn from the fields the turn carries (`BotMessage`, `HandoffNote`), never from the text the agent
 * was given. That text is shown whole and as written, only inside "What the agent received", closed until opened. A
 * bot's message is never the owner's bubble: it stands on the left under its sender's mark, and says whose words it is.
 *
 * A card sits in a container of its own: in a chat about 24rem wide or less (a 760-wide window with the chat list
 * open, 23.18) the parts stack and nothing is shortened.
 */

/** As the runtime labels a bot's message (`bots::handoffs::BOT_WORDS`). */
const BOT_WORDS = "a bot's words, not an approval";
/** As the runtime labels a mention (`bots::channels::label`). */
const REQUEST_WORDS = "a request, not an approval";
const GONE = "A bot no longer here";
/** The app's own author id on a message (`bots::BY_TERMINALX`). */
const TERMINALX = "terminalx";
const OWNER = "owner";

/** A message of a turn, as the chat holds it. */
export type CardMessage = {
  seq?: number;
  ts?: string;
  messageTs?: string;
  author?: { userId: string; displayName: string };
  bot?: BotMessage;
  text: string;
};

/**
 * Whether TerminalX put this message in the chat for a bot or as itself: it carries a card, or (from a runtime before
 * the cards) its author is a bot or the app. Such a message is never drawn as the owner's bubble. A guest of a shared
 * session has an id of their own and keeps the look they have.
 */
export function botAuthored(message: Pick<CardMessage, "author" | "bot">): boolean {
  if (message.bot) return true;
  const id = message.author?.userId ?? "";
  return id === TERMINALX || id.startsWith("bot:");
}

/**
 * Whether a hand-off's line in a chat is said by a card already there, so it is not drawn again: in the receiving
 * bot's chat the hand-off's own card says it was handed; in the sender's chat the answer's card and the live "Handed
 * to" card say it was answered, and TerminalX's own note says a bot's hand-off was stopped.
 */
export function handoffNoteHidden(note: HandoffNote): boolean {
  if (note.event === "handed") return note.side === "to";
  if (note.event === "answered" || note.event === "couldNot") return note.side === "from";
  if (note.event === "stopped") return note.side === "from" && note.by !== OWNER;
  return false;
}

function At({ ts, className }: { ts?: string; className?: string }) {
  const time = messageTime(ts);
  if (!time) return null;
  return <time dateTime={time.iso} title={time.full} className={cn("shrink-0 text-[11.5px] tabular-nums text-faint", className)} data-testid="bot-card-time">{time.short}</time>;
}

function useBot(id: string | undefined): Bot | null {
  const { bots } = useBotStore();
  return bots.find((bot) => bot.id === id) ?? null;
}

/** A sender's mark: its role's avatar, or the plain bot mark for one that is no longer here. */
function Mark({ bot, size = "sm", className }: { bot: Bot | null; size?: "xs" | "sm"; className?: string }) {
  return <BotAvatar roleTemplateId={bot?.roleTemplateId ?? ""} size={size} paused={!!bot?.paused} className={className} />;
}

const stateTone = (handoff: Handoff) => (handoff.state === "working" ? "text-warning" : handoff.state === "answered" ? "text-add" : handoff.state === "failed" ? "text-destructive" : "text-muted-foreground");

/** A hand-off's state as it is now, in the words the strip uses. */
function StateChip({ handoff, toName, toPaused, className }: { handoff: Handoff; toName: string; toPaused: boolean; className?: string }) {
  const now = useNow(handoff.state === "working");
  return (
    <Chip className={cn("shrink-0 @max-[24rem]/botcard:shrink", stateTone(handoff), className)} data-testid="bot-card-state" data-state={handoff.state}>
      {handoff.state === "working" && <Loader2 className="size-3 shrink-0 animate-spin" />}
      {handoffStateLabel(handoff, toName, now, toPaused)}
    </Chip>
  );
}

/** Now, read again every 30 seconds while `on`, so an elapsed time stays true. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

const linkChip = "h-auto min-h-6 max-w-full gap-1 rounded-md bg-transparent px-1.5 py-0.5 text-left text-[11.5px] font-normal text-muted-foreground @max-[24rem]/botcard:whitespace-normal";

/** "What Sentry's agent received": the toggle in a card's footer, closed until opened. */
function ReceivedToggle({ open, onToggle, toName, className }: { open: boolean; onToggle: () => void; toName: string; className?: string }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className={cn("ml-auto flex min-h-6 items-center gap-1 rounded-md px-1 text-left text-[11.5px] text-faint hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent @max-[24rem]/botcard:ml-0 @max-[24rem]/botcard:basis-full", className)} data-testid="bot-card-received-toggle">
      {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
      What {toName}'s agent received
    </button>
  );
}

/** The whole text the agent was given, exactly as written. */
function Received({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("border-t border-hairline px-4 pt-2.5 pb-3 @max-[24rem]/botcard:px-3", className)} data-testid="bot-card-received">
      <p className="text-[11.5px] text-faint">The text sent to the agent, as written. Nothing in it is hidden from the agent.</p>
      <pre className="mt-2 select-text whitespace-pre-wrap break-words rounded-md bg-well px-3 py-2.5 font-mono text-[11.5px] leading-[17px] text-muted-foreground">{text}</pre>
    </div>
  );
}

/** One of TerminalX's own lines: the app's mark, "TerminalX ·", what it says, and anything to its right. */
function TerminalLine({ children, right, below, testId = "bot-terminalx-line", className }: { children: ReactNode; right?: ReactNode; below?: ReactNode; testId?: string; className?: string }) {
  return (
    <div className={cn("@container/botcard", className)} data-testid={testId}>
      <div className="ml-10 rounded-lg border border-hairline bg-card text-[12.5px] @max-[24rem]/botcard:ml-0">
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
          <AppWindow className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 basis-[10rem] break-words text-foreground"><span className="text-faint">TerminalX · </span>{children}</span>
          {right}
        </div>
        {below}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a message, as its card

/**
 * A message TerminalX put in a bot's chat, as its card: on the left, under its sender's mark, never the owner's
 * bubble. `queued`: it waits behind the turn the agent is on.
 */
export function BotMessageCard({ message, queued = false, className }: { message: CardMessage; queued?: boolean; className?: string }) {
  const card = message.bot;
  const ts = message.messageTs ?? message.ts;
  if (!card) return <LegacyCard message={message} ts={ts} className={className} />;
  if (card.kind === "mention" && card.mention) return <MentionCard card={card} source={card.mention} text={message.text} seq={message.seq} ts={ts} queued={queued} className={className} />;
  if (card.kind === "handoff" && card.from === OWNER) return <OwnerHandedCard card={card} text={message.text} seq={message.seq} ts={ts} queued={queued} className={className} />;
  if ((card.kind === "handoff" || card.kind === "tell" || card.kind === "answer") && card.from !== OWNER && card.from !== TERMINALX) {
    return <IncomingCard card={card} text={message.text} seq={message.seq} ts={ts} queued={queued} className={className} />;
  }
  return <AppNote card={card} label={message.author?.displayName} text={message.text} seq={message.seq} ts={ts} className={className} />;
}

function kindWords(card: BotMessage, toName: string): string {
  if (card.kind === "handoff") return `hand-off to ${toName}`;
  if (card.kind === "answer") return `answer to ${toName}`;
  return card.status ? `status to ${toName}` : `message to ${toName}`;
}

const ACCESS_RANK: Record<string, number> = { readReport: 0, askOutward: 1, full: 2 };
const rank = (access: string) => ACCESS_RANK[effectiveAccess(access as BotAccess)] ?? 0;

/** A hand-off, a tell or an answer from another bot (23.14): whose words, what it is, the words, and what it links. */
function IncomingCard({ card, text, seq, ts, queued, className }: { card: BotMessage; text: string; seq?: number; ts?: string; queued: boolean; className?: string }) {
  const from = useBot(card.from);
  const to = useBot(card.to);
  const fromName = from?.name ?? GONE;
  const toName = to?.name ?? (card.toName || "a bot no longer here");
  const isHandoff = card.kind === "handoff";
  const { list } = useSharedBotHandoffs(isHandoff ? card.to : null);
  const live = isHandoff ? list?.handoffs.find((handoff) => handoff.number === card.handoff) ?? null : null;
  const [open, setOpen] = useDisclosure(`received:${seq ?? card.handoff ?? ""}`);
  // What one bot is to the other holds while both are here: a deleted sender reports to no one. The lower-access
  // sentence names a deleted sender mid-sentence, as the chips do.
  const relation = from && to ? relationLine(card, from.name, to.name) : null;
  const lower = !!card.fromAccess && !!card.toAccess && rank(card.fromAccess) < rank(card.toAccess);
  const lowerLine = lower && to ? lowerAccessLine(card, from?.name ?? GONE.toLowerCase(), to.name) : null;
  const hasFooterLinks = isHandoff || card.handoff !== undefined;
  return (
    <article className={cn("@container/botcard", className)} aria-label={`${fromName}: ${kindWords(card, toName)}`} data-testid="bot-message-card" data-kind={card.kind} data-from={card.from}>
      <div className="flex gap-3 @max-[24rem]/botcard:block">
        <Mark bot={from} className="@max-[24rem]/botcard:hidden" />
        <div className="min-w-0 flex-1">
          <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <Mark bot={from} className="hidden @max-[24rem]/botcard:inline-flex" />
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 @max-[24rem]/botcard:flex-1 @max-[24rem]/botcard:flex-col">
              <span className="break-words text-[13px] font-medium text-foreground" data-testid="bot-card-sender">{fromName}</span>
              <span className="break-words text-faint">
                {from?.roleTitle}
                <span className="hidden @max-[24rem]/botcard:inline">{from?.roleTitle && messageTime(ts) ? " · " : ""}<At ts={ts} /></span>
              </span>
            </span>
            <span className="inline-flex min-h-5 min-w-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-border px-1.5 text-[11px] text-faint @max-[24rem]/botcard:basis-full @max-[24rem]/botcard:items-start @max-[24rem]/botcard:whitespace-normal @max-[24rem]/botcard:py-0.5" data-testid="bot-card-label">
              <CornerDownRight className="size-3 shrink-0 @max-[24rem]/botcard:mt-0.5" />
              <span className="min-w-0 break-words">{kindWords(card, toName)} · {BOT_WORDS}</span>
            </span>
            {queued && <Chip className="shrink-0 text-muted-foreground" data-testid="bot-card-queued">Queued</Chip>}
            <At ts={ts} className="ml-auto @max-[24rem]/botcard:hidden" />
          </header>
          <div className="mt-1.5 rounded-xl border border-hairline bg-card">
            <div className="px-4 pt-3 pb-3 @max-[24rem]/botcard:px-3">
              {(card.title || live || (card.kind === "answer" && card.failed)) && (
                <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                  {card.title && <h3 className="min-w-0 flex-1 basis-[12rem] break-words text-[14px] font-medium leading-5 text-foreground @max-[24rem]/botcard:basis-full" data-testid="bot-card-title">{card.title}</h3>}
                  {live && <StateChip handoff={live} toName={toName} toPaused={!!to?.paused} />}
                  {card.kind === "answer" && card.failed && <Chip className="shrink-0 text-destructive" data-testid="bot-card-failed">Could not do it</Chip>}
                </div>
              )}
              {card.due && <p className="mt-1 break-words text-[12px] text-faint" data-testid="bot-card-due">Answer due: {card.due}</p>}
              {card.body && <p className={cn("select-text whitespace-pre-wrap break-words text-[13.5px] leading-[21px] text-foreground", (card.title || card.due) && "mt-1.5")} data-testid="bot-card-body">{card.body}</p>}
              {relation && (
                <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-[18px] text-muted-foreground" data-testid="bot-card-relation"><UserCheck className="mt-[3px] size-3 shrink-0" /><span className="min-w-0 flex-1 break-words">{relation}</span></p>
              )}
              {lower && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="bot-card-access">
                  <Chip className="text-muted-foreground"><Eye className="size-3 shrink-0" />{fromName}: {accessLabel(card.fromAccess as BotAccess)}</Chip>
                  <Chip className="text-warning"><ShieldOff className="size-3 shrink-0" />{toName}: {accessLabel(card.toAccess as BotAccess)}</Chip>
                  {lowerLine && <span className="min-w-0 basis-[16rem] grow break-words text-[12px] leading-[18px] text-muted-foreground" data-testid="bot-card-lower-access">{lowerLine}</span>}
                </div>
              )}
            </div>
            <footer className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 border-t border-hairline px-4 py-2 @max-[24rem]/botcard:px-3">
              {isHandoff && card.item !== undefined && (
                <ChipButton className={linkChip} onClick={() => openBotItem(card.to, card.item!, openBot)} data-testid="bot-card-item"><ListTodo className="size-3 shrink-0" />Item #{card.item}</ChipButton>
              )}
              {isHandoff && card.item !== undefined && <ItemLinks botId={card.to} item={card.item} />}
              {isHandoff && card.handoff !== undefined && <ChainChip card={card} />}
              {!isHandoff && card.handoff !== undefined && (
                <Chip className={linkChip} data-testid="bot-card-about"><ArrowRightLeft className="size-3 shrink-0" />About hand-off {card.handoff}</Chip>
              )}
              <ReceivedToggle open={open} onToggle={() => setOpen((value) => !value)} toName={toName} className={hasFooterLinks ? undefined : "ml-0"} />
            </footer>
            {open && <Received text={text} />}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * "Hand-off 2 · 2 of 3 in its chain". It opens the Hand-offs page (PRO-540) at this hand-off's step in its thread,
 * whoever sent it: the page holds a chain whose sender is gone too.
 */
function ChainChip({ card }: { card: BotMessage }) {
  const words = <><ArrowRightLeft className="size-3 shrink-0" />Hand-off {card.handoff}{card.depth && card.maxDepth ? ` · ${card.depth} of ${card.maxDepth} in its chain` : ""}</>;
  return (
    <ChipButton className={linkChip} title={`Open hand-off ${card.handoff} in its thread`} onClick={() => showBotsHandoffs(card.handoff)} data-testid="bot-card-chain">{words}</ChipButton>
  );
}

/** The pull requests and tickets a bot's item links, as its page names them. */
function ItemLinks({ botId, item }: { botId: string; item: number }) {
  const { list } = useBotItems(botId);
  const links = (list?.items.find((value) => value.number === item)?.links ?? []).filter((link) => link.kind === "pullRequest" || link.kind === "ticket").slice(0, 3);
  return (
    <>
      {links.map((link) => (
        <Chip key={`${link.kind}:${link.target}`} className={linkChip} title={link.title || link.target} data-testid="bot-card-item-link">
          {link.kind === "pullRequest" ? <GitPullRequest className="size-3 shrink-0" /> : <Hash className="size-3 shrink-0" />}{link.target}
        </Chip>
      ))}
    </>
  );
}

/**
 * An item the owner handed on in the window (23.17): TerminalX's line in the owner's own words, then their note as
 * theirs and the item as the other bot's words. The agent's text still says "your owner"; it is in the toggle.
 */
function OwnerHandedCard({ card, text, seq, ts, queued, className }: { card: BotMessage; text: string; seq?: number; ts?: string; queued: boolean; className?: string }) {
  const to = useBot(card.to);
  const writer = useBot(card.wordsOf);
  const toName = to?.name ?? (card.toName || "a bot no longer here");
  const writerName = writer?.name ?? GONE;
  const [open, setOpen] = useDisclosure(`received:${seq ?? card.handoff ?? ""}`);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-testid="bot-message-card" data-kind="handoff" data-from={OWNER}>
      <TerminalLine right={<>{queued && <Chip className="shrink-0 text-muted-foreground">Queued</Chip>}<At ts={ts} /></>}>You handed {toName} this item</TerminalLine>
      <div className="@container/botcard">
        <div className="ml-10 rounded-xl border border-hairline bg-card @max-[24rem]/botcard:ml-0">
          <div className="px-4 py-3 @max-[24rem]/botcard:px-3">
            {card.note && (
              <>
                <p className="text-[11.5px] text-faint">Your note</p>
                <p className="mt-0.5 select-text whitespace-pre-wrap break-words text-[13.5px] leading-[21px] text-foreground" data-testid="bot-card-note">{card.note}</p>
                <div className="my-2.5 border-t border-hairline" />
              </>
            )}
            <p className="break-words text-[11.5px] text-faint" data-testid="bot-card-words-of">Item{card.fromItem !== undefined ? ` #${card.fromItem}` : ""} as {writerName} wrote it · {BOT_WORDS}</p>
            {card.title && <h3 className="mt-0.5 break-words text-[13.5px] font-medium text-foreground" data-testid="bot-card-title">{card.title}</h3>}
            {card.body && <p className="mt-1 select-text whitespace-pre-wrap break-words text-[12.5px] leading-[19px] text-muted-foreground" data-testid="bot-card-body">{card.body}</p>}
          </div>
          <footer className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 border-t border-hairline px-4 py-2 @max-[24rem]/botcard:px-3">
            {card.item !== undefined && (
              <ChipButton className={linkChip} onClick={() => openBotItem(card.to, card.item!, openBot)} data-testid="bot-card-item"><ListTodo className="size-3 shrink-0" />Item #{card.item}</ChipButton>
            )}
            {card.handoff !== undefined && <Chip className={linkChip} data-testid="bot-card-chain"><ArrowRightLeft className="size-3 shrink-0" />Hand-off {card.handoff}</Chip>}
            <ReceivedToggle open={open} onToggle={() => setOpen((value) => !value)} toName={toName} />
          </footer>
          {open && <Received text={text} />}
        </div>
      </div>
    </div>
  );
}

const SERVICES: Record<string, { name: string; on: string; open: string; icon: typeof Github }> = {
  github: { name: "GitHub", on: "on GitHub", open: "Open on GitHub", icon: Github },
  linear: { name: "Linear", on: "on Linear", open: "Open in Linear", icon: SquareKanban },
  slack: { name: "Slack", on: "on Slack", open: "Open in Slack", icon: Hash },
  telegram: { name: "Telegram", on: "on Telegram", open: "Open in Telegram", icon: Send },
};

/** A mention from outside TerminalX (23.17): the service's mark, who wrote and where, and that it is a request. */
function MentionCard({ card, source, text, seq, ts, queued, className }: { card: BotMessage; source: MentionSource; text: string; seq?: number; ts?: string; queued: boolean; className?: string }) {
  const to = useBot(card.to);
  const toName = to?.name ?? (card.toName || "a bot no longer here");
  const service = SERVICES[source.service] ?? { name: source.service, on: `on ${source.service}`, open: "Open", icon: MessageSquare };
  const Icon = service.icon;
  const where = source.direct ? "direct chat" : source.place;
  const [open, setOpen] = useDisclosure(`received:${seq ?? ""}`);
  const [failed, setFailed] = useState<string | null>(null);
  const mark = (extra: string) => (
    <span aria-hidden className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-card text-muted-foreground", extra)} data-testid="bot-card-service" data-service={source.service}><Icon className="size-3.5" /></span>
  );
  return (
    <article className={cn("@container/botcard", className)} aria-label={`${source.by} mentioned ${toName} ${service.on}`} data-testid="bot-message-card" data-kind="mention" data-service={source.service}>
      <div className="flex gap-3 @max-[24rem]/botcard:block">
        {mark("@max-[24rem]/botcard:hidden")}
        <div className="min-w-0 flex-1">
          <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            {mark("hidden @max-[24rem]/botcard:inline-flex")}
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 @max-[24rem]/botcard:flex-1 @max-[24rem]/botcard:flex-col">
              <span className="break-words text-[13px] font-medium text-foreground" data-testid="bot-card-sender">{source.by}</span>
              <span className="break-words text-faint">
                {service.on}
                <span className="hidden @max-[24rem]/botcard:inline">{messageTime(ts) ? " · " : ""}<At ts={ts} /></span>
              </span>
            </span>
            <span className="inline-flex min-h-5 min-w-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-border px-1.5 text-[11px] text-faint @max-[24rem]/botcard:basis-full @max-[24rem]/botcard:items-start @max-[24rem]/botcard:whitespace-normal @max-[24rem]/botcard:py-0.5" data-testid="bot-card-label">
              <CornerDownRight className="size-3 shrink-0 @max-[24rem]/botcard:mt-0.5" />
              <span className="min-w-0 break-words">mentioned {toName}{where ? ` (${where})` : ""} · {REQUEST_WORDS}</span>
            </span>
            {queued && <Chip className="shrink-0 text-muted-foreground" data-testid="bot-card-queued">Queued</Chip>}
            <At ts={ts} className="ml-auto @max-[24rem]/botcard:hidden" />
          </header>
          <div className="mt-1.5 rounded-xl border border-hairline bg-card">
            <div className="px-4 py-3 @max-[24rem]/botcard:px-3">
              {source.title && <h3 className="mb-1 break-words text-[12px] text-faint" data-testid="bot-card-thread-title">{source.title}</h3>}
              <p className="select-text whitespace-pre-wrap break-words text-[13.5px] leading-[21px] text-foreground" data-testid="bot-card-body">{card.body}</p>
            </div>
            <footer className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 border-t border-hairline px-4 py-2 @max-[24rem]/botcard:px-3">
              {source.place && <Chip className={linkChip} data-testid="bot-card-place"><Hash className="size-3 shrink-0" />{source.place}</Chip>}
              {source.url && (
                <ChipButton className={linkChip} onClick={() => { setFailed(null); void openExternalWebUrl(source.url!).catch((cause) => setFailed(errorMessage(cause))); }} data-testid="bot-card-open">
                  <ExternalLink className="size-3 shrink-0" />{service.open}
                </ChipButton>
              )}
              <ReceivedToggle open={open} onToggle={() => setOpen((value) => !value)} toName={toName} className={source.place || source.url ? undefined : "ml-0"} />
            </footer>
            {failed && <p role="alert" className="border-t border-hairline px-4 py-2 text-[12px] text-destructive">Couldn't open it: {failed}</p>}
            {open && <Received text={text} />}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * One of TerminalX's own notes to a bot's agent: the owner's Stop, a hand-off it could not start or reach, a message
 * it gave up on, a check-back. In the owner's view a Stop is theirs ("You stopped hand-off 2"); the others keep the
 * name the app gave them. The agent's text is in the toggle.
 */
function AppNote({ card, label, text, seq, ts, className }: { card: BotMessage; label?: string; text: string; seq?: number; ts?: string; className?: string }) {
  const to = useBot(card.to);
  const toName = to?.name ?? (card.toName || "a bot no longer here");
  const [open, setOpen] = useDisclosure(`received:${seq ?? `${card.kind}:${card.handoff ?? ""}`}`);
  const stopped = card.kind === "stopped" && card.from === OWNER && card.handoff !== undefined;
  // The app's own name for the note, without the "TerminalX · " the line already says.
  const named = (label ?? "").replace(/^TerminalX(?: · )?/, "");
  return (
    <TerminalLine
      className={className}
      testId="bot-message-card"
      right={<At ts={ts} />}
      below={
        <>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 border-t border-hairline px-3 py-1.5">
            {!stopped && card.handoff !== undefined && <Chip className={linkChip} data-testid="bot-card-about"><ArrowRightLeft className="size-3 shrink-0" />About hand-off {card.handoff}</Chip>}
            <ReceivedToggle open={open} onToggle={() => setOpen((value) => !value)} toName={toName} className={!stopped && card.handoff !== undefined ? undefined : "ml-0"} />
          </div>
          {open && <Received text={text} className="px-3" />}
        </>
      }
    >
      <span data-testid="bot-card-app-note" data-kind={card.kind}>{stopped ? `You stopped hand-off ${card.handoff}` : named}</span>
    </TerminalLine>
  );
}

/**
 * A bot's or the app's message from a runtime before the cards: it carries no fields, so nothing is read out of its
 * text. It stands on the left under the label its author was given, with its text in the toggle.
 */
function LegacyCard({ message, ts, className }: { message: CardMessage; ts?: string; className?: string }) {
  const id = message.author?.userId ?? "";
  const bot = useBot(id.startsWith("bot:") ? id.slice(4) : undefined);
  const [open, setOpen] = useDisclosure(`received:${message.seq ?? ""}`);
  const fromApp = id === TERMINALX;
  return (
    <article className={cn("@container/botcard", className)} data-testid="bot-message-card" data-kind="legacy">
      <div className="flex gap-3 @max-[24rem]/botcard:block">
        {fromApp ? (
          <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-card text-muted-foreground @max-[24rem]/botcard:mb-1"><AppWindow className="size-3.5" /></span>
        ) : (
          <Mark bot={bot} className="@max-[24rem]/botcard:mb-1" />
        )}
        <div className="min-w-0 flex-1">
          <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span className="inline-flex min-h-5 min-w-0 items-start gap-1 rounded-[5px] border border-border px-1.5 py-0.5 text-[11px] text-faint" data-testid="bot-card-label">
              <CornerDownRight className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{message.author?.displayName}</span>
            </span>
            <At ts={ts} className="ml-auto" />
          </header>
          <div className="mt-1.5 rounded-xl border border-hairline bg-card">
            <div className="flex px-4 py-2 @max-[24rem]/botcard:px-3">
              <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-h-6 items-center gap-1 rounded-md px-1 text-left text-[11.5px] text-faint hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent" data-testid="bot-card-received-toggle">
                {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                What the agent received
              </button>
            </div>
            {open && <Received text={message.text} />}
          </div>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- a hand-off's line, as its card

/**
 * One of the lines a hand-off leaves in its two chats, drawn from what it is about: in the sender's chat, the live
 * "Handed to" card; in the receiving bot's, "answered hand-off 2 · it reached the other chat"; and TerminalX's own
 * lines in the owner's words. Null for a line a card in the same chat already says ([`handoffNoteHidden`]).
 */
export function HandoffNoteRow({ note, text, ts, name, className }: { note: HandoffNote; text: string; ts?: string; name: string; className?: string }) {
  if (handoffNoteHidden(note)) return null;
  if (note.event === "handed" && note.side === "from" && note.by !== OWNER) return <HandedCard note={note} ts={ts} className={className} />;
  if ((note.event === "answered" || note.event === "couldNot") && note.side === "to") return <AnsweredLine note={note} text={text} ts={ts} name={name} className={className} />;
  if (note.event === "stopped") return <TerminalLine className={className} right={<At ts={ts} />}>You stopped hand-off {note.number}</TerminalLine>;
  // What the app said, in its own words: the owner handed an item on, a hand-off did not start, or it could not be reached.
  return <TerminalLine className={className} right={<At ts={ts} />}>{text}</TerminalLine>;
}

const KIND_WORD: Record<string, string> = { answer: "An answer", tell: "A message", handoff: "The hand-off", stopped: "A note", failed: "A note" };

/**
 * "Handed to Sentry" (23.15): the card in the sender's chat where it handed the work on, with the hand-off's state as
 * it is now and the only Stop, which stops that bot's work on it and nothing else. The answer shows under it when it
 * comes, as the bot's words or as TerminalX's; so do a retry, a message that waits and one that was not delivered.
 */
function HandedCard({ note, ts, className }: { note: HandoffNote; ts?: string; className?: string }) {
  const from = useBot(note.from);
  const to = useBot(note.to);
  const fromName = from?.name ?? GONE;
  const toName = to?.name ?? "a bot no longer here";
  const { list, error } = useSharedBotHandoffs(note.from);
  const handoff = list?.handoffs.find((value) => value.number === note.number) ?? null;
  const retry = list?.handoffs.find((value) => value.retryOf === note.number) ?? null;
  const undelivered = (list?.undelivered ?? []).filter((message) => message.handoff === note.number);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const stop = () => {
    setStopping(true);
    setStopError(null);
    botHandoffsApi.stop(note.number).then(() => undefined, (cause) => setStopError(errorMessage(cause))).finally(() => setStopping(false));
  };
  const title = handoff?.title ?? note.title ?? "";
  const answer = handoff?.answer;
  const waits = handoff && handoff.waitingMessages > 0 ? `${handoff.waitingMessages === 1 ? "1 message waits" : `${handoff.waitingMessages} messages wait`} for its chat to start.` : null;
  const depth = handoff?.depth;
  return (
    <div className={cn("@container/botcard", className)}>
      <article className="ml-10 rounded-xl border border-hairline bg-card @max-[24rem]/botcard:ml-0" aria-label={`Handed to ${toName}: hand-off ${note.number}`} data-testid="bot-handed-card" data-state={handoff?.state ?? ""}>
        <header className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-hairline px-4 py-1.5 @max-[24rem]/botcard:px-3">
          <span className="flex shrink-0 items-center gap-1" aria-label={`${fromName} to ${toName}`}>
            <Mark bot={from} size="xs" />
            <ArrowRight className="size-3 text-faint" />
            <Mark bot={to} size="xs" />
          </span>
          <span className="min-w-0 flex-1 break-words text-[12.5px] text-muted-foreground @max-[24rem]/botcard:basis-full">Handed to <span className="font-medium text-foreground">{toName}</span></span>
          {handoff && <StateChip handoff={handoff} toName={toName} toPaused={!!to?.paused} />}
          {handoff && handoffOpen(handoff) && (
            <Button size="xs" variant="outline" className="max-w-full shrink-0 @max-[24rem]/botcard:h-auto @max-[24rem]/botcard:min-h-6 @max-[24rem]/botcard:shrink @max-[24rem]/botcard:whitespace-normal @max-[24rem]/botcard:py-0.5 @max-[24rem]/botcard:text-left" disabled={stopping} onClick={stop} aria-label={`Stop ${toName}'s work on hand-off ${note.number}`} title={`Stop ${toName}'s work on this hand-off`} data-testid="bot-handed-stop">
              {stopping ? <Loader2 className="animate-spin" /> : <Square />} Stop {toName}
            </Button>
          )}
          <At ts={ts} />
        </header>
        <div className="px-4 py-2.5 @max-[24rem]/botcard:px-3">
          {title && <h3 className="break-words text-[13.5px] font-medium text-foreground" data-testid="bot-card-title">{title}</h3>}
          {handoff?.scope && <p className="mt-1 line-clamp-2 select-text whitespace-pre-wrap break-words text-[12.5px] leading-[19px] text-muted-foreground @max-[24rem]/botcard:line-clamp-none" data-testid="bot-handed-scope">{handoff.scope}</p>}
          {waits && <p className="mt-1.5 text-[11.5px] text-faint" data-testid="bot-handed-waits">{waits}</p>}
          {answer && (
            <p className={cn("mt-2 select-text whitespace-pre-wrap break-words border-l-2 pl-2.5 text-[12.5px] leading-[19px]", handoff?.state === "failed" ? "border-destructive/50 text-destructive" : "border-hairline-strong text-muted-foreground")} data-testid="bot-handed-answer">
              <span className="font-medium text-foreground">{answer.by === TERMINALX ? "TerminalX:" : `${toName} · ${BOT_WORDS}:`}</span> {answer.text}
            </p>
          )}
          {retry && (
            <p className="mt-2 flex items-start gap-1.5 break-words text-[12px] text-muted-foreground" data-testid="bot-handed-retry">
              <RotateCw className="mt-0.5 size-3 shrink-0" />
              {fromName} handed it again as hand-off {retry.number}{list?.maxRetries !== undefined ? ` · try ${(retry.attempt ?? 0) + 1} of ${list.maxRetries + 1}` : ""}
            </p>
          )}
          {handoff?.state === "stopped" && handoff.stoppedBy === OWNER && (
            <p className="mt-2 flex items-start gap-1.5 break-words text-[12px] text-muted-foreground" data-testid="bot-handed-stopped"><AppWindow className="mt-0.5 size-3 shrink-0" />TerminalX · You stopped hand-off {note.number}</p>
          )}
          {undelivered.map((message) => <UndeliveredRow key={message.id} message={message} />)}
          {stopError && <MachineHostError error={stopError} onRestarted={stop} onFailed={setStopError} className="mt-2" />}
          {error && !list && <p role="alert" className="mt-2 break-words text-[12px] text-destructive" data-testid="bot-handed-error">Couldn't read {fromName}'s hand-offs: {error}</p>}
        </div>
        <footer className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 border-t border-hairline px-4 py-2 @max-[24rem]/botcard:px-3">
          <ChipButton className={linkChip} title={`Open hand-off ${note.number} in its thread`} onClick={() => showBotsHandoffs(note.number)} data-testid="bot-handed-number"><ArrowRightLeft className="size-3 shrink-0" />Hand-off {note.number}</ChipButton>
          {depth && list?.maxDepth ? <Chip className={linkChip} data-testid="bot-handed-chain"><GitCommitVertical className="size-3 shrink-0" />{depth} of {list.maxDepth} in its chain</Chip> : null}
          {handoff?.item !== undefined && <ItemLinks botId={note.to} item={handoff.item} />}
          {handoff?.toSession && to && (
            <ChipButton className={linkChip} onClick={() => selectSession(handoff.toSession!)} data-testid="bot-handed-chat"><MessageSquare className="size-3 shrink-0" />{toName}'s chat</ChipButton>
          )}
          {retry && <Chip className={linkChip} data-testid="bot-handed-retry-chip"><RotateCw className="size-3 shrink-0" />Hand-off {retry.number}</Chip>}
        </footer>
      </article>
    </div>
  );
}

/** A message about a hand-off that did not reach its chat: who to whom, why, and a Resend. Never its text. */
function UndeliveredRow({ message }: { message: UndeliveredMessage }) {
  const { bots } = useBotStore();
  const nameOf = (id: string) => (id === TERMINALX ? "TerminalX" : bots.find((bot) => bot.id === id)?.name ?? "a bot no longer here");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resend = () => {
    setBusy(true);
    setError(null);
    botHandoffsApi.resend(message.id).then((answer) => { if (answer.delivery.error) setError(answer.delivery.error); }, (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="bot-handed-undelivered">
      <p className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 rounded-md bg-warning/10 px-2 py-1 text-[11.5px] text-warning">
        <TriangleAlert className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 flex-1 basis-[8rem] break-words">
          {KIND_WORD[message.kind] ?? "A message"} from {nameOf(message.from)} to {nameOf(message.to)} is not delivered{message.held ? " · it goes when that bot's chat starts" : ""}: {message.error}
        </span>
        <Button size="xs" variant="outline" className="shrink-0" disabled={busy} onClick={resend} data-testid="bot-handed-resend">
          {busy ? <Loader2 className="animate-spin" /> : null} Resend
        </Button>
      </p>
      {error && <MachineHostError error={error} onRestarted={resend} onFailed={setError} />}
    </div>
  );
}

/**
 * In the receiving bot's chat, once it answered (23.14): one line that says so and, when the answer is not among what
 * waits undelivered, that it reached the sender's chat; while it waits, why, with a Resend (23.17). "Show the answer"
 * opens the answer's words.
 */
function AnsweredLine({ note, text, ts, name, className }: { note: HandoffNote; text: string; ts?: string; name: string; className?: string }) {
  const from = useBot(note.from);
  const to = useBot(note.to);
  const fromName = from?.name ?? GONE;
  const toName = to?.name ?? GONE;
  const { list } = useSharedBotHandoffs(note.to);
  const handoff = list?.handoffs.find((value) => value.number === note.number) ?? null;
  // The answer, while it has not reached the sender's chat: said here too, with its Resend.
  const held = (list?.undelivered ?? []).filter((message) => message.kind === "answer" && message.handoff === note.number);
  const reached = !!list && held.length === 0;
  const [open, setOpen] = useDisclosure(`answer:${name}`);
  const answer = handoff?.answer;
  return (
    <div className={cn("@container/botcard", className)} data-testid="bot-answered-line" data-event={note.event}>
      <div className="ml-10 rounded-lg border border-hairline bg-card text-[12.5px] @max-[24rem]/botcard:ml-0">
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
          <span className="flex shrink-0 items-center gap-1" aria-label={`${toName} to ${fromName}`}>
            <Mark bot={to} size="xs" />
            <ArrowRight className="size-3 text-faint" />
            <Mark bot={from} size="xs" />
          </span>
          <span className="min-w-0 flex-1 basis-[10rem] break-words text-muted-foreground">
            <span className="font-medium text-foreground">{note.event === "answered" ? `${toName} answered hand-off ${note.number}` : text}</span>
            {note.event === "answered" && reached ? ` · it reached ${fromName}'s chat` : ""}
          </span>
          {answer && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-h-6 shrink-0 items-center gap-1 rounded-md px-1 text-[11.5px] text-faint hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent" data-testid="bot-answered-show">
              {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
              Show the answer
            </button>
          )}
          <At ts={ts} />
        </div>
        {open && answer && <p className="select-text whitespace-pre-wrap break-words border-t border-hairline px-3 py-2 text-[12.5px] leading-[19px] text-foreground" data-testid="bot-answered-text">{answer.text}</p>}
        {held.length > 0 && <div className="border-t border-hairline px-3 pb-2">{held.map((message) => <UndeliveredRow key={message.id} message={message} />)}</div>}
      </div>
    </div>
  );
}
