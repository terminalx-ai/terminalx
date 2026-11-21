import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowLeftRight, ArrowUp, Check, Circle, GitPullRequest, Hash, Link, Loader2, MessageSquare, RotateCcw, Square, SquareTerminal, Users } from "@/icons";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { errorMessage } from "@/lib/api";
import { useBotStore } from "@/lib/bots";
import { commentOnBotItem, reopenBotItem, resendBotItem, stopBotItem, useBotItem } from "@/lib/botItems";
import { cn } from "@/lib/cn";
import { confirmInApp } from "@/lib/confirm";
import { conversationTitle, selectSession, useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { effectiveAccess, type Bot } from "@/types/bots";
import type { BotItem, BotItemActivity, BotItemLink } from "@/types/botItems";
import type { SessionEntry } from "@/types/session";
import { StateIcon } from "./BotHome";
import { ItemQuestionCard } from "./NeedsYou";
import { HandToBot } from "./BotHandoffs";
import { CheckBackRow, HandoffRow, RunLinks } from "./BotRuns";
import { checkBackText, runningWorkers, withHandoffs } from "@/lib/botRuns";

const STATE_LABEL: Record<string, string> = { planned: "Planned", inProgress: "In progress", needsYou: "Needs you", waiting: "Waiting", done: "Done", dropped: "Dropped" };

/** An item's state in words; one a newer app wrote is shown as itself. */
export function itemStateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Who did something: you, the bot, or TerminalX itself (a check-back it woke the bot for). */
function who(by: string, bot: Bot): string {
  return by === "owner" ? "You" : by === bot.id ? bot.name : by === "terminalx" ? "TerminalX" : by;
}

/** What the bot may do on this item, from its access. */
export function mayDoHere(bot: Bot): string {
  switch (effectiveAccess(bot.access)) {
    case "full":
      return `Full access: ${bot.name} works here the way your own sessions do, without asking. Pause it to stop work you have not seen.`;
    case "askOutward":
      return `${bot.name} may change files and run commands here, and asks you before anything that leaves this computer: a push, a message, a post, a deploy or a purchase.`;
    default:
      return `${bot.name} reads and reports only: it changes nothing here.`;
  }
}

/**
 * A work item's page (PRO-469, design 23.09): its title, state and links, its summary, what done means, its activity
 * and a comment box; on the right, about the item, its sessions and links, and what the bot may do here. "Take it
 * over" opens the item's session; "Stop this item" stops its sessions and drops it; "Hand to another bot" hands it on
 * with the owner's note (PRO-475).
 */
export function BotItemPage({ bot, number, onBack }: { bot: Bot; number: number; onBack: () => void }) {
  const item = useBotItem(bot.id, number);
  const store = useSessionStore();
  const { bots } = useBotStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Hand to another bot" (PRO-475).
  const [handing, setHanding] = useState(false);
  const [handed, setHanded] = useState<number | null>(null);

  if (!item) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4" data-testid="bot-item-page">
        <Back bot={bot} number={number} onBack={onBack} />
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading item #{number}…</p>
      </div>
    );
  }

  const sessions = (item.links ?? []).filter((link) => link.kind === "session").map((link) => store.sessions.find((session) => session.id === link.target)).filter((session): session is SessionEntry => !!session);
  // The item's own work first (a session the bot started for it), then the chat it was added from; newest first.
  const takeOver = [...sessions].sort((a, b) => Number(!!a.bot) - Number(!!b.bot) || (b.modified || b.created).localeCompare(a.modified || a.created))[0] ?? null;
  const closed = item.state === "done" || item.state === "dropped";
  // PRO-476: the runs it links, with their workers; a run link that has a view is shown as the run, not as a bare id.
  const runs = item.runViews ?? [];
  const shownRuns = new Set(runs.map((run) => run.id));
  const otherLinks = (item.links ?? []).filter((link) => !(link.kind === "run" && shownRuns.has(link.target)));
  const workers = runs.reduce((sum, run) => sum + runningWorkers(run), 0);
  const lines = item.doneMeans ?? [];
  const met = lines.filter((line) => line.met).length;

  const stop = async () => {
    const yes = await confirmInApp({
      title: `Stop item #${item.number}?`,
      body: `Its sessions stop and the item is dropped. ${bot.name}'s chats go on.`,
      action: "Stop this item",
      destructive: true,
    });
    if (!yes) return;
    setBusy(true);
    stopBotItem(bot.id, item.number).then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };

  const reopen = () => {
    setBusy(true);
    reopenBotItem(bot.id, item.number).then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-testid="bot-item-page">
      <div className="flex min-w-0 flex-wrap items-start gap-x-8 gap-y-6 px-5 py-4 sm:px-6">
        <main className="flex min-w-[min(100%,420px)] flex-1 basis-[560px] flex-col gap-5" aria-label={`Item #${item.number}`}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Back bot={bot} number={item.number} onBack={onBack} />
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" disabled={!takeOver} onClick={() => takeOver && selectSession(takeOver.id)} title={takeOver ? `Open ${conversationTitle(takeOver)}` : "No session works on this item"} data-testid="bot-item-take-over">
                <SquareTerminal /> Take it over
              </Button>
              <Button size="sm" variant="outline" disabled={closed} aria-expanded={handing} onClick={() => { setHanding((value) => !value); setHanded(null); }} title={closed ? "Reopen it before handing it on" : undefined} data-testid="bot-item-hand">
                <ArrowLeftRight /> Hand to another bot
              </Button>
              {closed ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={reopen} data-testid="bot-item-reopen">
                  <RotateCcw /> Reopen
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()} data-testid="bot-item-stop">
                  <Square /> Stop this item
                </Button>
              )}
            </div>
          </div>

          {handing && !closed && <HandToBot bot={bot} item={item} onClose={() => setHanding(false)} onHanded={(handoff) => { setHanding(false); setHanded(handoff.number); }} />}
          {handed !== null && <p className="text-[12.5px] text-muted-foreground" role="status" data-testid="bot-item-handed">Handed on as hand-off {handed}. Its card shows in the receiving bot's chat; the answer comes back to {bot.name}.</p>}

          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-[19px] font-semibold break-words text-foreground">{item.title}</h1>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-faint">
              <Chip className={cn(item.state === "needsYou" && "text-accent", item.state === "inProgress" && "text-warning")}>
                <StateIcon item={item} className="size-3" /> {itemStateLabel(item.state)}
              </Chip>
              {sessions.length > 0 && <Chip><SquareTerminal className="size-3" /> {sessions.length === 1 ? "1 session" : `${sessions.length} sessions`}</Chip>}
              {workers > 0 && <Chip title="Workers of its runs at work now" data-testid="bot-item-workers"><Users className="size-3" /> {workers === 1 ? "1 worker" : `${workers} workers`}</Chip>}
              {(item.links ?? []).filter((link) => link.kind === "pullRequest" || link.kind === "ticket").slice(0, 3).map((link) => (
                <Chip key={`${link.kind}:${link.target}`} title={link.title || link.target}>{link.kind === "pullRequest" ? <GitPullRequest className="size-3" /> : <Hash className="size-3" />} {link.target}</Chip>
              ))}
              <span className="ml-1">started {relativeTime(item.created)} · asked by {askedBy(item, bot, bots)}</span>
            </div>
          </div>

          {item.summary && <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground" data-testid="bot-item-summary">{item.summary}</p>}
          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}
          <NotDelivered bot={bot} item={item} />

          {item.question && (
            <section aria-label="Needs you" className="overflow-hidden rounded-lg border border-accent/40 bg-card">
              <ItemQuestionCard bot={bot} item={item} />
            </section>
          )}

          <section aria-label="Done means" className="flex min-w-0 flex-col gap-2" data-testid="bot-item-done-means">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[11px] font-medium uppercase tracking-[.08em] text-faint">Done means</h2>
              <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{bot.name} marks each line met itself and closes the item once all are; you can reopen it</span>
              {lines.length > 0 && <span className="shrink-0 text-[12px] text-muted-foreground">{met} of {lines.length}</span>}
            </div>
            {lines.length > 0 ? (
              <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card">
                {lines.map((line, index) => (
                  <li key={index} className="flex min-w-0 items-center gap-3 px-3 py-2" data-testid="bot-item-done-line" data-met={line.met ? "true" : "false"}>
                    {line.met ? <Check aria-label="Met" className="size-4 shrink-0 text-add" /> : <Circle aria-label="Not met" className="size-4 shrink-0 text-faint" />}
                    <span className="min-w-0 flex-1 text-[13px] break-words text-foreground">{line.text}</span>
                    <span className="shrink-0 text-[11.5px] text-faint">{[line.how, line.met && line.metAt ? clock(line.metAt) : ""].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-hairline-strong px-4 py-3 text-[12.5px] text-faint">{bot.name} has not written what done means for this item yet.</p>
            )}
          </section>

          <section aria-label="Activity" className="flex min-w-0 flex-col gap-2" data-testid="bot-item-activity">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[11px] font-medium uppercase tracking-[.08em] text-faint">Activity</h2>
              <span className="text-[12px] text-faint">{usd.format(item.spentUsd || 0)} spent on this item</span>
            </div>
            <ol className="flex flex-col">
              {withHandoffs(item.activity ?? [], runs).map((row, index) =>
                row.kind === "entry" ? <ActivityRow key={index} entry={row.entry} bot={bot} /> : <HandoffRow key={index} handoff={row.handoff} />,
              )}
              {!closed && <CheckBackRow bot={bot} checkBack={item.checkBack} />}
            </ol>
          </section>

          <CommentBox bot={bot} item={item} />
        </main>

        <aside className="flex w-full min-w-0 flex-col gap-6 sm:w-[280px] sm:shrink-0" aria-label="About this item" data-testid="bot-item-aside">
          <Panel label="About this item">
            <Fact label="Owner">{bot.name}</Fact>
            <Fact label="Asked by">{askedBy(item, bot, bots)}</Fact>
            <Fact label="Spend"><span className="font-mono">{usd.format(item.spentUsd || 0)}</span> so far</Fact>
            <Fact label="Started">{relativeTime(item.created)}</Fact>
            <Fact label="Updated">{relativeTime(item.modified)}</Fact>
            {item.closed && <Fact label={item.state === "done" ? "Done" : "Closed"}>{relativeTime(item.closed)}</Fact>}
            {item.snoozedUntil && <Fact label="Snoozed until">{new Date(item.snoozedUntil).toLocaleString()}</Fact>}
            {!closed && checkBackText(item.checkBack) && <Fact label="Checks back">{checkBackText(item.checkBack)}</Fact>}
          </Panel>
          <Panel label="Sessions and links">
            {otherLinks.length === 0 && runs.length === 0 ? (
              <p className="text-[12.5px] text-faint">None yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline">
                <RunLinks runs={runs} />
                {otherLinks.map((link) => <LinkRow key={`${link.kind}:${link.target}`} link={link} session={store.sessions.find((session) => session.id === link.target) ?? null} />)}
              </ul>
            )}
          </Panel>
          <Panel label={`What ${bot.name} may do here`}>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">{mayDoHere(bot)}</p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/**
 * Who asked for it: you when you gave the work; the sending bot when another bot handed it on (PRO-475), as
 * TerminalX recorded it; otherwise who the bot says asked, as the bot's word.
 */
export function askedBy(item: BotItem, bot: Bot, bots: Bot[] = []): string {
  if (item.addedBy === "owner") return "you";
  if (item.addedBy && item.addedBy !== bot.id) {
    const sender = bots.find((other) => other.id === item.addedBy);
    return `${sender?.name ?? "a bot no longer here"} (a bot), through a hand-off`;
  }
  const said = item.askedBy === "owner" ? "you" : item.askedBy;
  return `${said}, as ${bot.name} noted`;
}

function Back({ bot, number, onBack }: { bot: Bot; number: number; onBack: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
      <Button size="xs" variant="ghost" onClick={onBack} data-testid="bot-item-back"><ArrowLeft /> Home</Button>
      <span className="truncate text-faint">· item {number} of {bot.name}'s work</span>
    </div>
  );
}

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2">
      <h2 className="text-[11px] font-medium uppercase tracking-[.08em] text-faint">{label}</h2>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3 border-b border-hairline pb-1.5 text-[12.5px]">
      <span className="w-[92px] shrink-0 text-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{children}</span>
    </div>
  );
}

function linkIcon(kind: string) {
  switch (kind) {
    case "session":
      return SquareTerminal;
    case "pullRequest":
      return GitPullRequest;
    case "ticket":
      return Hash;
    default:
      return Link;
  }
}

const LINK_KIND_LABEL: Record<string, string> = { pullRequest: "Pull request", ticket: "Ticket", run: "Run", url: "Link" };

function LinkRow({ link, session }: { link: BotItemLink; session: SessionEntry | null }) {
  const Icon = linkIcon(link.kind);
  const title = link.kind === "session" ? (session ? conversationTitle(session) : "A session that is gone") : link.title || link.target;
  const sub = link.kind === "session" ? (session?.bot ? "Chat" : "Session") : link.title ? link.target : (LINK_KIND_LABEL[link.kind] ?? link.kind);
  const content = (
    <>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-foreground" title={title}>{title}</span>
        <span className="block truncate text-[11.5px] text-faint" title={sub}>{sub}</span>
      </span>
    </>
  );
  return (
    <li className="py-1.5">
      {session ? (
        <button type="button" onClick={() => selectSession(session.id)} className="flex w-full min-w-0 items-start gap-2 rounded-md text-left hover:bg-veil">{content}</button>
      ) : (
        <div className="flex min-w-0 items-start gap-2">{content}</div>
      )}
    </li>
  );
}

function ActivityRow({ entry, bot }: { entry: BotItemActivity; bot: Bot }) {
  const owners = entry.by === "owner";
  // A bot's notes are its own words: shown as such, never as an instruction or an approval.
  const words = entry.kind === "comment" || entry.kind === "chose" || entry.kind === "asked" || entry.kind === "done" || entry.kind === "added";
  const app = entry.by === "terminalx";
  // A typed answer is the owner's words, in the entry's text. A chosen answer's label, kept as its detail, is the
  // bot's own wording of that answer: shown as the bot's, never as the owner's.
  const detailLabel = entry.kind === "chose" ? `${bot.name}'s wording of that answer` : owners ? "your words" : `${bot.name}'s words · not an approval`;
  return (
    <li className="flex min-w-0 gap-3 border-b border-hairline py-2 last:border-b-0" data-testid="bot-item-activity-row" data-by={owners ? "owner" : app ? "terminalx" : "bot"}>
      <span className="w-12 shrink-0 pt-0.5 font-mono text-[11.5px] text-faint" title={entry.at}>{clock(entry.at)}</span>
      <MessageSquare className={cn("mt-0.5 size-3.5 shrink-0", owners ? "text-accent" : app ? "text-faint" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] text-foreground">
          <span className="break-words">{entry.text || `${who(entry.by, bot)}: ${entry.kind}`}</span>
          {words && entry.detail && (
            <span className="rounded border border-hairline px-1.5 text-[10.5px] text-faint">{detailLabel}</span>
          )}
        </p>
        {entry.detail && <p className="mt-0.5 text-[12.5px] break-words whitespace-pre-wrap text-muted-foreground">{entry.detail}</p>}
      </div>
    </li>
  );
}

const SAID: Record<string, string> = { answer: "Your answer", comment: "Your comment", work: "The work you gave" };

/**
 * The owner's messages about this item that have not reached the bot yet, as the app keeps them: each is sent to the
 * home chat once its agent next starts, or now with Send again, and cleared only once sent. A paused bot's wait for its
 * resume, which sends them.
 */
function NotDelivered({ bot, item }: { bot: Bot; item: BotItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = item.undelivered ?? [];
  if (waiting.length === 0) return null;
  const again = () => {
    setBusy(true);
    setError(null);
    resendBotItem(bot.id, item.number).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  const why = waiting[waiting.length - 1]?.error;
  // A paused bot gets nothing from a chat start, and Send again is refused: only its resume sends these (PRO-474).
  const paused = !!bot.paused;
  return (
    <section aria-label="Not delivered yet" role="alert" className="flex min-w-0 flex-col gap-2 rounded-lg bg-warning/10 px-4 py-3 text-[12.5px] text-warning" data-testid="bot-item-undelivered">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {paused ? (
          <p className="min-w-0 flex-1 font-medium">Kept while paused: {bot.name} gets {waiting.length === 1 ? "this" : "these"} when you resume it.</p>
        ) : (
          <>
            <p className="min-w-0 flex-1 font-medium">Not delivered yet: {bot.name} gets {waiting.length === 1 ? "this" : "these"} when its home chat next starts{why ? ` (${why})` : ""}.</p>
            <Button size="xs" variant="outline" disabled={busy} onClick={again}>{busy ? <Loader2 className="animate-spin" /> : null} Send again</Button>
          </>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {waiting.map((message) => (
          <li key={message.id} className="min-w-0 break-words whitespace-pre-wrap text-muted-foreground">
            {message.choice ? (
              <>
                <span className="text-warning">You chose answer {message.choice}, {relativeTime(message.at)}.</span>{" "}
                <span className="rounded border border-hairline px-1.5 text-[10.5px] text-faint">{bot.name}'s wording of that answer</span>{" "}
                {message.label}
              </>
            ) : (
              <>
                <span className="text-warning">{SAID[message.kind] ?? "Your message"}, {relativeTime(message.at)}:</span> {message.text}
              </>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-destructive">{error}</p>}
    </section>
  );
}

function CommentBox({ bot, item }: { bot: Bot; item: BotItem }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    commentOnBotItem(bot.id, item.number, text.trim()).then(
      () => setText(""),
      (cause) => setError(errorMessage(cause)),
    ).finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-1" data-testid="bot-item-comment">
      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-hairline-strong bg-card px-3 py-2">
        <input
          spellCheck={false}
          value={text}
          maxLength={4000}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Comment, or tell ${bot.name} what to change on this item`}
          aria-label={`Comment, or tell ${bot.name} what to change on this item`}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
        />
        <Button size="icon-xs" variant="secondary" type="submit" disabled={busy || !text.trim()} aria-label="Send">
          {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
    </form>
  );
}
