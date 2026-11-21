import { useState, type FormEvent } from "react";
import { CircleQuestionMark, Loader2, MessageSquare, Send, TriangleAlert, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { agent, errorMessage } from "@/lib/api";
import { answerBotItem, dismissUndelivered, openBotItem, refreshNeedsYou, useUndelivered, type Undelivered } from "@/lib/botItems";
import { cn } from "@/lib/cn";
import { openBot, selectSession } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import type { Bot } from "@/types/bots";
import type { BotItem, NeedsYouEntry } from "@/types/botItems";
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

const WHAT: Record<Undelivered["what"], string> = { answer: "Your answer", comment: "Your comment", work: "The work you gave" };

/** What a send that did not reach the home chat says: what the owner did is recorded, the bot was not told. */
export function undeliveredNote(bot: Pick<Bot, "name">, entry: Pick<Undelivered, "number" | "what" | "error">): string {
  return `${WHAT[entry.what]} on item #${entry.number} is recorded, but it could not be sent to ${bot.name}'s home chat${entry.error ? `: ${entry.error}` : ""}. ${bot.name} has not been told: tell it there.`;
}

/**
 * The sends that did not reach a bot: shown where the owner acts (a bot's Home tab and item page, or the Bots page for
 * every bot) until dismissed. Kept in the store, not on the card answered, since answering removes the card.
 */
export function UndeliveredNotes({ bots, botId }: { bots: Bot[]; botId: string | null }) {
  const entries = useUndelivered(botId);
  if (entries.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="bot-undelivered">
      {entries.map((entry) => {
        const bot = bots.find((value) => value.id === entry.botId) ?? { name: "the bot" };
        return (
          <div key={entry.id} role="alert" className="flex min-w-0 items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{undeliveredNote(bot, entry)}</p>
            <button type="button" onClick={() => dismissUndelivered(entry.id)} aria-label="Dismiss" className="shrink-0 rounded hover:text-foreground"><X className="size-3.5" /></button>
          </div>
        );
      })}
    </div>
  );
}

/** The answer buttons of an item's question: the recommended one first and accented, then the others, then "or reply…". */
function Answers({ bot, item, compact }: { bot: Bot; item: BotItem; compact: boolean }) {
  const question = item.question;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  if (!question) return null;
  const order = question.answers.map((_, index) => index).sort((a, b) => Number(b === question.recommended) - Number(a === question.recommended));
  const send = (choice: { answer: number } | { text: string }) => {
    setBusy(true);
    setError(null);
    answerBotItem(bot.id, item.number, choice, question.asked).then(
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
              className="max-w-full"
            >
              <span className="truncate">{question.answers[index]}</span>
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
          <p className="min-w-0 flex-1 text-[13.5px] font-medium whitespace-pre-wrap text-foreground">{item.question.text}</p>
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
  const item = entry.item;
  return (
    <article className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2" data-testid="needs-you-row" data-bot={bot.id}>
      <BotAvatar roleTemplateId={bot.roleTemplateId} size="md" />
      <div className="min-w-[200px] flex-1">
        <p className="truncate text-[13px] text-foreground" title={item.question?.text}>{item.question?.text}</p>
        <p className="truncate text-[11.5px] text-faint">{bot.name} · #{item.number} {item.title}</p>
      </div>
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <RecommendedOnly bot={bot} item={item} />
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
function RecommendedOnly({ bot, item }: { bot: Bot; item: BotItem }) {
  const question = item.question;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = question?.recommended;
  if (!question) return null;
  if (index == null || !question.answers[index]) {
    return <span className="shrink-0 text-[11.5px] text-faint" data-testid="needs-you-choose">{question.answers.length} answers · open to choose</span>;
  }
  const send = () => {
    setBusy(true);
    setError(null);
    answerBotItem(bot.id, item.number, { answer: index }, question.asked).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <>
      <Button size="xs" variant="accent" disabled={busy} onClick={send} title={error ?? undefined} className="max-w-[260px]" data-testid="needs-you-answer">
        <span className="truncate">{question.answers[index]}</span>
        <span className="text-[10px] font-normal opacity-75">recommended</span>
      </Button>
      {error && <span role="alert" className="max-w-[200px] truncate text-[11.5px] text-destructive" title={error}>{error}</span>}
    </>
  );
}

/** Kept for the item rows: when an item was last touched. */
export function touched(item: Pick<BotItem, "modified">): string {
  return relativeTime(item.modified);
}
