import { useLayoutEffect, useState, type FormEvent } from "react";
import { CircleQuestionMark, Loader2, MessageSquare, RotateCw, Send, TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";
import { agent, errorMessage } from "@/lib/api";
import { answerBotItem, openBotItem, questionKey, refreshNeedsYou, resendBotItem, useNeedsYou } from "@/lib/botItems";
import { cn } from "@/lib/cn";
import { openBot, selectSession } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import type { Bot } from "@/types/bots";
import type { BotItem, NeedsYouEntry, NeedsYouUndelivered } from "@/types/botItems";
import { BotAvatar } from "./BotAvatar";

/**
 * "Needs you" (PRO-469, designs 23.01 and 23.02): a bot's question to its owner, asked once, with its answers and the
 * one it recommends. Choosing an answer, or typing one, records "You answered …" on the item and sends the answer to
 * the bot's home chat. A question card open in one of the bot's sessions (AskUserQuestion) shows here too.
 */

/** "8m", "21m", "2h": how long it has waited. */
export function waited(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const WHAT: Record<string, string> = { answer: "Your answer", comment: "Your comment", work: "The work you gave" };

/** What a message that has not reached the home chat says: what the owner did is recorded, the bot was not told yet. */
export function undeliveredNote(bot: Pick<Bot, "name">, entry: Pick<NeedsYouUndelivered, "number" | "kind" | "count" | "error">): string {
  const what = entry.count > 1 ? `${entry.count} of your messages` : WHAT[entry.kind] ?? "Your message";
  return `${what} on item #${entry.number} ${entry.count > 1 ? "are" : "is"} recorded but not delivered yet${entry.error ? `: ${entry.error}` : ""}. ${bot.name} gets ${entry.count > 1 ? "them" : "it"} when its home chat next starts, or send again now.`;
}

/**
 * The owner's messages that have not reached a bot (PRO-469 review): kept on the item by the app until they are
 * delivered (at the home chat's next start, or by Send again), so the notice outlives the card that was answered and
 * a restart. On a bot's Home tab and item page for that bot; on the Bots page for every bot.
 */
export function UndeliveredNotes({ bots, botId, number }: { bots: Bot[]; botId: string | null; number?: number }) {
  const needs = useNeedsYou();
  const entries = (needs?.undelivered ?? []).filter((entry) => (botId === null || entry.botId === botId) && (number === undefined || entry.number === number));
  if (entries.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="bot-undelivered">
      {entries.map((entry) => {
        const bot = bots.find((value) => value.id === entry.botId);
        return bot ? <UndeliveredNote key={`${entry.botId}#${entry.number}`} bot={bot} entry={entry} /> : null;
      })}
    </div>
  );
}

function UndeliveredNote({ bot, entry }: { bot: Bot; entry: NeedsYouUndelivered }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const again = () => {
    setBusy(true);
    setError(null);
    resendBotItem(bot.id, entry.number).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <div role="alert" className="flex min-w-0 items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{undeliveredNote(bot, entry)}{error ? ` ${error}` : ""}</p>
      <Button size="xs" variant="outline" disabled={busy} onClick={again} className="shrink-0">{busy ? <Loader2 className="animate-spin" /> : <RotateCw />} Send again</Button>
    </div>
  );
}

/** The answer buttons of an item's question, numbered in the bot's order with the recommended one accented, then "or reply…". */
function Answers({ bot, item, compact }: { bot: Bot; item: BotItem; compact: boolean }) {
  const question = item.question;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  if (!question) return null;
  // In the bot's own order and numbered as it numbered them, so "You chose answer 2" is the button marked 2.
  const order = question.answers.map((_, index) => index);
  const send = (choice: { answer: number } | { text: string }) => {
    setBusy(true);
    setError(null);
    answerBotItem(bot.id, item.number, choice, questionKey(question)).then(
      () => {
        setReply("");
        setReplying(false);
      },
      (cause) => setError(errorMessage(cause)),
    ).finally(() => setBusy(false));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reply.trim()) send({ text: reply.trim() });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label={`Answers to ${bot.name}'s question`}>
        {order.map((index) => {
          const recommended = index === question.recommended;
          return (
            <Button
              key={index}
              size={compact ? "xs" : "sm"}
              variant={recommended ? "accent" : "outline"}
              disabled={busy}
              onClick={() => send({ answer: index })}
              data-testid="needs-you-answer"
              className="h-auto max-w-full py-1 text-left whitespace-normal"
            >
              {/* Whole, wrapped: the owner clicks what they read, never a label cut short. */}
              <span className="shrink-0 font-mono text-[10.5px] opacity-70">{index + 1}</span>
              <span className="min-w-0 break-words">{question.answers[index]}</span>
              {recommended && <span className="text-[10.5px] font-normal opacity-75">recommended</span>}
            </Button>
          );
        })}
        {!compact && !replying && (
          <button type="button" className="text-[12px] text-faint hover:text-foreground" onClick={() => setReplying(true)} disabled={busy}>
            or reply…
          </button>
        )}
        {busy && <Loader2 aria-label="Sending" className="size-3.5 animate-spin text-faint" />}
      </div>
      {replying && (
        <form onSubmit={submit} className="flex min-w-0 items-center gap-2">
          <input
            autoFocus
            spellCheck={false}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setReplying(false); }}
            placeholder={`Your answer to ${bot.name}`}
            aria-label={`Your answer to ${bot.name}`}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-[12.5px] text-foreground outline-none focus:border-ring"
          />
          <Button size="sm" variant="outline" type="submit" disabled={busy || !reply.trim()}><Send /> Answer</Button>
        </form>
      )}
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

/** A Needs you card on the bot's Home tab and on an item's page. */
export function ItemQuestionCard({ bot, item, onOpen }: { bot: Bot; item: BotItem; onOpen?: () => void }) {
  if (!item.question) return null;
  return (
    <article className="flex min-w-0 gap-3 px-4 py-3" data-testid="needs-you-card" aria-label={`${bot.name} asks: ${item.question.text}`}>
      <CircleQuestionMark className="mt-0.5 size-4 shrink-0 text-accent" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <QuestionText text={item.question.text} />
          <span className="shrink-0 text-[11.5px] text-faint" title={item.question.asked}>{waited(item.question.asked)}</span>
        </div>
        {onOpen ? (
          <button type="button" onClick={onOpen} className="w-fit max-w-full truncate text-left text-[12.5px] text-muted-foreground hover:text-foreground hover:underline">
            #{item.number} {item.title}
          </button>
        ) : null}
        {item.summary && onOpen && <p className="line-clamp-2 text-[12.5px] whitespace-pre-wrap text-muted-foreground">{item.summary}</p>}
        <Answers bot={bot} item={item} compact={false} />
      </div>
    </article>
  );
}

/**
 * Whether the element shows less than it holds, measured as laid out: lines clamped (its height) or a line cut (its
 * width). Measured whenever an element mounts (the callback ref), its `key` (what it shows) changes, or it is
 * resized. `null` until the element showing `key` has been measured: callers take that as cut.
 */
export function useCutOff<T extends HTMLElement>(key: string): [(element: T | null) => void, boolean | null] {
  const [element, setElement] = useState<T | null>(null);
  const [measured, setMeasured] = useState<{ element: T; key: string; cut: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setMeasured({ element, key, cut: element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, key]);
  return [setElement, measured && element && measured.element === element && measured.key === key ? measured.cut : null];
}

/** A question on its card: four lines, and Show all when the four cut it short. */
function QuestionText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const [ref, cut] = useCutOff<HTMLParagraphElement>(`${all}\u0000${text}`);
  return (
    <div className="min-w-0 flex-1">
      <p ref={ref} className={cn("text-[13.5px] font-medium break-words whitespace-pre-wrap text-foreground", !all && "line-clamp-4")} data-testid="needs-you-question">{text}</p>
      {(cut !== false || all) && (
        <button type="button" onClick={() => setAll((value) => !value)} className="text-[12px] text-faint hover:text-foreground" aria-expanded={all}>
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** A question card open in one of the bot's sessions: answered here when it has one choice to make, else opened. */
export function AgentQuestionCard({ bot, entry, compact = false }: { bot: Bot; entry: Extract<NeedsYouEntry, { kind: "agentQuestion" }>; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = entry.questions[0];
  const simple = entry.questions.length === 1 && !!first && !first.multiSelect && (first.options?.length ?? 0) > 0;
  const choose = (label: string) => {
    if (!first) return;
    setBusy(true);
    setError(null);
    agent.answerQuestions(entry.sessionId, entry.tabId, entry.requestId, { [first.question]: label }).then(
      () => refreshNeedsYou(),
      (cause) => setError(errorMessage(cause)),
    ).finally(() => setBusy(false));
  };
  const open = () => selectSession(entry.sessionId);
  const title = first?.question ?? `${bot.name} asks a question`;
  const more = entry.questions.length > 1 ? ` (+${entry.questions.length - 1} more)` : "";
  return (
    <article className={cn("flex min-w-0 gap-3", compact ? "items-center px-3 py-2" : "px-4 py-3")} data-testid="needs-you-agent-question" aria-label={`${bot.name} asks: ${title}`}>
      {compact ? <BotAvatar roleTemplateId={bot.roleTemplateId} size="md" /> : <MessageSquare className="mt-0.5 size-4 shrink-0 text-accent" />}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={title}>{title}{more}</p>
          {!compact && <span className="shrink-0 text-[11.5px] text-faint">{waited(entry.at)}</span>}
        </div>
        <p className="truncate text-[12px] text-faint">{compact ? `${bot.name} · ` : ""}asked in {entry.sessionTitle || "a session"}</p>
        {!compact && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {simple && first!.options!.map((option) => (
              <Button key={option.label} size="sm" variant="outline" disabled={busy} title={option.description} onClick={() => choose(option.label)}>
                <span className="truncate">{option.label}</span>
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={open}>Open the session</Button>
          </div>
        )}
        {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      </div>
      {compact && (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="xs" variant="outline" onClick={open}>Open</Button>
          <span className="w-8 text-right text-[11.5px] text-faint">{waited(entry.at)}</span>
        </div>
      )}
    </article>
  );
}

/** One row of the Bots page's Needs you queue (23.02): the question, whose it is, the recommended answer and Open. */
export function NeedsYouRow({ bot, entry }: { bot: Bot; entry: NeedsYouEntry }) {
  if (entry.kind === "agentQuestion") return <AgentQuestionCard bot={bot} entry={entry} compact />;
  return <ItemRow bot={bot} item={entry.item} />;
}

function ItemRow({ bot, item }: { bot: Bot; item: BotItem }) {
  const [questionRef, questionCut] = useCutOff<HTMLParagraphElement>(item.question?.text ?? "");
  return (
    <article className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2" data-testid="needs-you-row" data-bot={bot.id}>
      <BotAvatar roleTemplateId={bot.roleTemplateId} size="md" />
      <div className="min-w-[200px] flex-1">
        <p ref={questionRef} className="line-clamp-3 text-[13px] break-words whitespace-pre-wrap text-foreground" title={item.question?.text} data-testid="needs-you-question">{item.question?.text}</p>
        <p className="truncate text-[11.5px] text-faint">{bot.name} · #{item.number} {item.title}</p>
      </div>
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <RecommendedOnly bot={bot} item={item} questionCut={questionCut !== false} />
        <Button size="xs" variant="outline" onClick={() => openBotItem(bot.id, item.number, openBot)} data-testid="needs-you-open">Open</Button>
        <span className="w-8 shrink-0 text-right text-[11.5px] text-faint" title={item.question?.asked}>{item.question ? waited(item.question.asked) : ""}</span>
      </div>
    </article>
  );
}

/**
 * The row's one answer button: the answer the bot recommends, the rest on the item's page. With no recommendation
 * there is no one-click answer: every answer is read on the item's page first.
 */
function RecommendedOnly({ bot, item, questionCut }: { bot: Bot; item: BotItem; questionCut: boolean }) {
  const question = item.question;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = question?.recommended;
  const label = index == null ? "" : question?.answers[index] ?? "";
  // Measured on the answer button as laid out, which stays in the row (hidden while it is not offered) so a new label
  // or a wider row is measured again; a label not measured yet counts as cut.
  const [labelRef, labelCut] = useCutOff<HTMLSpanElement>(label);
  if (!question) return null;
  if (index == null || !question.answers[index]) {
    return <span className="shrink-0 text-[11.5px] text-faint" data-testid="needs-you-choose">{question.answers.length} answers · open to choose</span>;
  }
  // One click answers only what the row shows whole: a question its three lines cut, or an answer its button cuts,
  // is read on the item's page first.
  const whole = !questionCut && labelCut === false;
  const send = () => {
    setBusy(true);
    setError(null);
    answerBotItem(bot.id, item.number, { answer: index }, questionKey(question)).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <>
      <span className="relative inline-flex min-w-0 max-w-[260px]">
        <Button
          size="xs"
          variant="accent"
          disabled={busy || !whole}
          onClick={send}
          title={error ?? undefined}
          aria-hidden={!whole}
          tabIndex={whole ? undefined : -1}
          className={cn("max-w-full", !whole && "invisible")}
          data-testid={whole ? "needs-you-answer" : "needs-you-answer-measured"}
        >
          <span ref={labelRef} className="truncate">{label}</span>
          <span className="text-[10px] font-normal opacity-75">recommended</span>
        </Button>
        {!whole && (
          <Button size="xs" variant="accent" onClick={() => openBotItem(bot.id, item.number, openBot)} className="absolute top-1/2 left-0 -translate-y-1/2" data-testid="needs-you-read">
            Read and answer
          </Button>
        )}
      </span>
      {error && <span role="alert" className="max-w-[200px] truncate text-[11.5px] text-destructive" title={error}>{error}</span>}
    </>
  );
}

/** Kept for the item rows: when an item was last touched. */
export function touched(item: Pick<BotItem, "modified">): string {
  return relativeTime(item.modified);
}
