import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, FileText, Loader2, Square, TriangleAlert } from "@/icons";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { errorMessage } from "@/lib/api";
import { botHandoffsApi, handoffOpen, handoffStateLabel, useBotHandoffs, useTeamBrief } from "@/lib/botHandoffs";
import { useBotStore } from "@/lib/bots";
import { cn } from "@/lib/cn";
import { restartRequired } from "@/lib/machines";
import { openBot } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import type { Bot } from "@/types/bots";
import type { BotItem } from "@/types/botItems";
import type { Handoff, UndeliveredMessage } from "@/types/botHandoffs";
import { BotAvatar } from "./BotAvatar";

/**
 * Bots as a team (PRO-475, designs 23.04, 23.01 and 23.09): the hand-off cards in a bot's chat, the team brief under
 * "Every bot reads", "Reports to" on a bot's Home, and "Hand to another bot" on an item's page. Shown only inside the
 * Bots views, which exist only while the experimental Bots setting is on.
 */

function nameOf(bots: Bot[], id: string): string {
  return bots.find((bot) => bot.id === id)?.name ?? "a bot no longer here";
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

/** The hand-offs made from or worked in chat `chatId`: the open ones, and the last few closed. */
export function chatHandoffs(handoffs: Handoff[], chatId: string): Handoff[] {
  const here = handoffs.filter((handoff) => handoff.fromSession === chatId || handoff.toSession === chatId);
  const open = here.filter(handoffOpen);
  const closed = here.filter((handoff) => !handoffOpen(handoff)).slice(0, Math.max(0, 3 - open.length));
  return [...open, ...closed];
}

/** Above a bot's open chat: a card for each hand-off it made or works on there (design 23.04). */
export function HandoffCards({ bot, chatId }: { bot: Bot; chatId: string }) {
  const { list, error, reload } = useBotHandoffs(bot.id);
  const shown = chatHandoffs(list?.handoffs ?? [], chatId);
  const now = useTicking(shown.some((handoff) => handoff.state === "working"));
  const undelivered = list?.undelivered ?? [];
  // Messages that are about no hand-off shown here: kept in a strip of their own, so none is lost from view.
  const loose = undelivered.filter((message) => !shown.some((handoff) => handoff.number === message.handoff));
  // A failed read is said, never shown as no hand-offs.
  if (error) {
    return (
      <div className="shrink-0 border-b border-hairline px-4 py-2" data-testid="bot-handoff-cards-error">
        <ReadError what={`${bot.name}'s hand-offs`} error={error} onRetry={reload} />
      </div>
    );
  }
  if (shown.length === 0 && loose.length === 0) return null;
  return (
    <div className="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-hairline px-4 py-2 scrollbar-thin" aria-label="Hand-offs" data-testid="bot-handoff-cards">
      {shown.map((handoff) => <HandoffCard key={handoff.number} handoff={handoff} now={now} undelivered={undelivered.filter((message) => message.handoff === handoff.number)} onResent={reload} />)}
      {loose.length > 0 && <Undelivered messages={loose} onResent={reload} />}
    </div>
  );
}

/** A read that failed: Restart runtime when only that helps, otherwise a Retry. */
function ReadError({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  if (restartRequired(error)) return <MachineHostError error={error} onRestarted={onRetry} />;
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px]">
      <p className="min-w-0 flex-1 text-destructive">Couldn't read {what}: {error}</p>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onRetry} data-testid="bot-handoffs-retry">Retry</Button>
    </div>
  );
}

const KIND_WORD: Record<string, string> = { answer: "An answer", tell: "A message", handoff: "The hand-off", stopped: "A note", failed: "A note" };

/** Messages between bots that did not reach their chat: why, and a Resend. Never their text. */
function Undelivered({ messages, onResent }: { messages: UndeliveredMessage[]; onResent: () => void }) {
  const { bots } = useBotStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resend = (id: string) => {
    setBusy(id);
    setError(null);
    botHandoffsApi.resend(id).then((answer) => { if (answer.delivery.error) setError(answer.delivery.error); onResent(); }, (cause) => setError(errorMessage(cause))).finally(() => setBusy(null));
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="bot-handoff-undelivered">
      {messages.map((message) => (
        <p key={message.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-warning/10 px-2 py-1 text-[11.5px] text-warning" data-testid="bot-handoff-undelivered-message">
          <TriangleAlert className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 basis-[10rem] truncate" title={message.error}>
            {KIND_WORD[message.kind] ?? "A message"} from {message.from === "terminalx" ? "TerminalX" : nameOf(bots, message.from)} to {nameOf(bots, message.to)} is not delivered{message.held ? " · it goes when that bot's chat starts" : ""}: {message.error}
          </span>
          <Button size="xs" variant="outline" className="shrink-0" disabled={busy !== null} onClick={() => resend(message.id)} data-testid="bot-handoff-resend">
            {busy === message.id ? <Loader2 className="animate-spin" /> : null} Resend
          </Button>
        </p>
      ))}
      {error && <MachineHostError error={error} onRestarted={onResent} onFailed={setError} />}
    </div>
  );
}

function HandoffCard({ handoff, now, undelivered, onResent }: { handoff: Handoff; now: number; undelivered: UndeliveredMessage[]; onResent: () => void }) {
  const { bots } = useBotStore();
  const from = bots.find((bot) => bot.id === handoff.from);
  const to = bots.find((bot) => bot.id === handoff.to);
  const toName = to?.name ?? "a bot no longer here";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = handoffOpen(handoff);
  const stop = () => {
    setBusy(true);
    setError(null);
    botHandoffsApi.stop(handoff.number).then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  const tone = handoff.state === "working" ? "text-warning" : handoff.state === "failed" ? "text-destructive" : handoff.state === "answered" ? "text-add" : "text-muted-foreground";
  return (
    <article className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-hairline bg-card px-3 py-2" aria-label={`Hand-off ${handoff.number}: ${handoff.title}`} data-testid="bot-handoff-card" data-state={handoff.state}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex shrink-0 items-center gap-1" aria-label={`${from?.name ?? "A bot"} to ${toName}`}>
          <BotAvatar roleTemplateId={from?.roleTemplateId ?? ""} size="xs" paused={!!from?.paused} />
          <ArrowRight className="size-3 text-faint" />
          <BotAvatar roleTemplateId={to?.roleTemplateId ?? ""} size="xs" paused={!!to?.paused} />
        </span>
        <span className="min-w-0 flex-1 basis-[7rem] truncate text-[12.5px] font-medium text-foreground" title={handoff.title}>{handoff.title}</span>
        <Chip className={cn("min-w-0 max-w-full", tone)} data-testid="bot-handoff-state" title={handoffStateLabel(handoff, toName, now, !!to?.paused)}>
          {handoff.state === "working" && <Loader2 className="size-3 shrink-0 animate-spin" />}
          <span className="truncate">{handoffStateLabel(handoff, toName, now, !!to?.paused)}</span>
        </Chip>
        {open && (
          <Button size="xs" variant="outline" className="min-w-0 max-w-full" disabled={busy} onClick={stop} data-testid="bot-handoff-stop" aria-label={`Stop ${toName}'s work on hand-off ${handoff.number}`} title={`Stop ${toName}'s work on this hand-off`}>
            {busy ? <Loader2 className="animate-spin" /> : <Square />} <span className="truncate">Stop {toName}</span>
          </Button>
        )}
      </div>
      <p className="min-w-0 truncate text-[11.5px] text-faint">
        #{handoff.number} · {handoff.by === "owner" ? `you handed ${from?.name ?? "a bot"}'s item to ${toName}` : `${from?.name ?? "A bot"} asked ${toName}`}
        {handoff.due ? ` · answer due ${handoff.due}` : ""} · {relativeTime(handoff.created)}
      </p>
      {handoff.scope && <p className="line-clamp-2 min-w-0 text-[12px] whitespace-pre-wrap break-words text-muted-foreground" data-testid="bot-handoff-scope">{handoff.scope}</p>}
      {handoff.answer && (
        <p className={cn("line-clamp-3 min-w-0 border-l-2 pl-2 text-[12px] whitespace-pre-wrap break-words", handoff.answer.failed ? "border-destructive/60 text-destructive" : "border-hairline-strong text-muted-foreground")} data-testid="bot-handoff-answer">
          <span className="font-medium">{handoff.answer.by === "terminalx" ? "TerminalX" : nameOf(bots, handoff.answer.by)} · a bot's words, not an approval:</span> {handoff.answer.text}
        </p>
      )}
      {handoff.waitingMessages > 0 && <p className="text-[11.5px] text-faint">{handoff.waitingMessages === 1 ? "1 message waits" : `${handoff.waitingMessages} messages wait`} for its chat to start.</p>}
      {undelivered.length > 0 && <Undelivered messages={undelivered} onResent={onResent} />}
      {error && <MachineHostError error={error} onRestarted={stop} onFailed={setError} />}
    </article>
  );
}

/** "Every bot reads" in a bot's chat list: the team brief's row. */
export function TeamBriefRow({ selected, onOpen }: { selected: boolean; onOpen: () => void }) {
  const { brief, error } = useTeamBrief();
  const sub = error ? "Couldn't read it" : !brief ? "Reading…" : brief.text.trim() === "" ? "Empty: write one" : `${brief.lines} ${brief.lines === 1 ? "line" : "lines"}${brief.outside ? " · changed outside" : ""}`;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        className={cn("flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left", selected ? "bg-veil-strong" : "hover:bg-veil")}
        data-testid="bot-team-brief-row"
      >
        <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground">Team brief</span>
          <span className={cn("block truncate text-[11.5px]", brief?.outside || error ? "text-warning" : "text-faint")}>{sub}</span>
        </span>
      </button>
    </li>
  );
}

/** The team brief's editor, where a chat would be. Unsaved text survives a failed save and the runtime's restart. */
export function TeamBriefEditor() {
  const { brief, error: readError, reload } = useTeamBrief();
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A save refused because the brief changed since it was opened: the owner's draft, kept while they read the newer.
  const [kept, setKept] = useState<string | null>(null);
  const stale = !!error && error.includes("changed since you opened it");
  const text = draft ?? brief?.text ?? "";
  const changed = draft !== null && draft !== (brief?.text ?? "");
  const limit = brief?.limit ?? 8192;
  const bytes = new TextEncoder().encode(text).length;
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!brief || busy) return;
    setBusy(true);
    setError(null);
    botHandoffsApi.writeBrief(text, base ?? brief.hash).then(
      () => { setDraft(null); setBase(null); setKept(null); setSaved(true); reload(); },
      (cause) => setError(errorMessage(cause)),
    ).finally(() => setBusy(false));
  };
  /** Show the newer brief; the draft stays, to put back. */
  const loadNewer = () => {
    setKept(draft);
    setDraft(null);
    setBase(null);
    setError(null);
    reload();
  };
  /** Put the draft back over the newer brief: the next save writes over the newer, knowingly. */
  const putBack = () => {
    if (kept === null || !brief) return;
    setBase(brief.hash);
    setDraft(kept);
    setKept(null);
  };
  /** Save the draft over the newer brief, read now. */
  const saveOver = () => {
    if (draft === null || busy) return;
    setBusy(true);
    setError(null);
    botHandoffsApi.brief().then((fresh) => botHandoffsApi.writeBrief(draft, fresh.hash)).then(
      () => { setDraft(null); setBase(null); setKept(null); setSaved(true); reload(); },
      (cause) => setError(errorMessage(cause)),
    ).finally(() => setBusy(false));
  };
  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 scrollbar-thin" aria-label="Team brief" data-testid="bot-team-brief">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="flex items-center gap-2 text-[15px] font-semibold text-foreground"><FileText className="size-4 text-muted-foreground" /> Team brief</h1>
        <p className="max-w-[640px] text-[12.5px] text-muted-foreground">
          Every bot is given this at the start of each conversation, as your standing instruction to the whole team. Keep it short: house rules, who to ask, what never to do.
        </p>
      </div>
      {readError && !brief && <p role="alert" className="text-[12.5px] text-destructive">Couldn't read the team brief: {readError}</p>}
      {brief?.unreadable && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">The brief cannot be read ({brief.unreadable}), so it is not written over.</p>}
      {brief?.outside && (
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning" data-testid="bot-team-brief-outside">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> It was changed outside TerminalX since you last saved it, so bots are given it as information, not as your instruction. Save it here to make it yours again.
        </p>
      )}
      <textarea
        spellCheck={false}
        value={text}
        disabled={!brief || !!brief.unreadable}
        onChange={(event) => { if (draft === null && brief) setBase(brief.hash); setDraft(event.target.value); setSaved(false); }}
        placeholder={"- Ask me before anything leaves this Mac.\n- Status updates go in a table."}
        aria-label="Team brief text"
        rows={12}
        className="min-h-[200px] w-full max-w-[760px] min-w-0 flex-1 resize-y rounded-md border border-border bg-transparent px-3 py-2 font-mono text-[12.5px] leading-relaxed text-foreground outline-none focus:border-ring"
      />
      <div className="flex max-w-[760px] min-w-0 flex-wrap items-center gap-2">
        <p className={cn("mr-auto text-[12px]", bytes > limit ? "text-destructive" : "text-faint")} data-testid="bot-team-brief-size">
          {(bytes / 1024).toFixed(1)} of {limit / 1024} KB{brief?.modified ? ` · saved ${relativeTime(brief.modified)}` : ""}{saved && !changed ? " · saved" : ""}
        </p>
        {changed && <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { setDraft(null); setBase(null); setError(null); }}>Discard</Button>}
        <Button size="sm" variant="accent" type="submit" disabled={busy || !changed || bytes > limit} data-testid="bot-team-brief-save">{busy && <Loader2 className="animate-spin" />} Save brief</Button>
      </div>
      {kept !== null && (
        <p className="flex max-w-[760px] min-w-0 flex-wrap items-center gap-2 rounded-md bg-veil px-3 py-2 text-[12.5px] text-muted-foreground" data-testid="bot-team-brief-kept">
          <span className="min-w-0 flex-1">This is the newer brief. Your draft is kept.</span>
          <Button size="sm" variant="outline" type="button" onClick={putBack} disabled={!brief} data-testid="bot-team-brief-put-back">Put my draft back</Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setKept(null)}>Drop my draft</Button>
        </p>
      )}
      {stale ? (
        <div role="alert" className="flex max-w-[760px] min-w-0 flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning" data-testid="bot-team-brief-stale">
          <span className="min-w-0 flex-1">The team brief changed since you opened it, so your draft was not saved.</span>
          <Button size="sm" variant="outline" type="button" disabled={busy} onClick={loadNewer} data-testid="bot-team-brief-load-newer">Load the newer text</Button>
          <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={saveOver} data-testid="bot-team-brief-save-over">Save mine over it</Button>
        </div>
      ) : error && <MachineHostError error={error} onRestarted={() => save()} onFailed={setError} className="max-w-[760px]" />}
    </form>
  );
}

/**
 * On a bot's Home: who it reports to, and the bots that report to it with the hand-offs it gave each (design 23.01's
 * right column). Nothing when it has neither.
 */
export function BotReportsTo({ bot }: { bot: Bot }) {
  const { bots } = useBotStore();
  const lead = bots.find((other) => other.id === bot.reportsTo);
  const reports = bots.filter((other) => other.reportsTo === bot.id);
  const { list, error, reload } = useBotHandoffs(reports.length > 0 ? bot.id : null);
  if (!lead && reports.length === 0) return null;
  const open = (list?.handoffs ?? []).filter(handoffOpen);
  return (
    <section aria-label={`Reports to ${bot.name}`} className="flex min-w-0 flex-col gap-2" data-testid="bot-reports-to">
      {lead && (
        <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground" data-testid="bot-lead">
          Reports to
          <button type="button" onClick={() => openBot(lead.id)} className="inline-flex min-w-0 items-center gap-1 rounded px-1 text-foreground hover:bg-veil">
            <BotAvatar roleTemplateId={lead.roleTemplateId} size="xs" paused={!!lead.paused} /> <span className="truncate">{lead.name}</span>
          </button>
        </p>
      )}
      {reports.length > 0 && (
        <>
          <h2 className="text-[11px] font-medium uppercase tracking-[.08em] text-faint">Reports to {bot.name} <span className="ml-1">{reports.length}</span></h2>
          {error && <ReadError what={`${bot.name}'s hand-offs`} error={error} onRetry={reload} />}
          <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card">
            {reports.map((report) => {
              const given = open.filter((handoff) => handoff.to === report.id);
              return (
                <li key={report.id}>
                  <button type="button" onClick={() => openBot(report.id)} className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left hover:bg-veil" data-testid="bot-report">
                    <BotAvatar roleTemplateId={report.roleTemplateId} paused={!!report.paused} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{report.name}</span>
                      <span className="block truncate text-[11.5px] text-faint">{report.roleTitle}{report.paused ? " · paused" : ""}</span>
                    </span>
                    {given.length > 0 && <Chip className="shrink-0" title={given.map((handoff) => handoff.title).join("\n")}>{given.length === 1 ? "1 hand-off" : `${given.length} hand-offs`}</Chip>}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * "Hand to another bot" on an item's page: the owner picks a bot and adds their own note. The item's title and
 * summary reach that bot as this bot's words; only the note is the owner's. Unsaved input survives a failed hand and
 * the runtime's restart.
 */
export function HandToBot({ bot, item, onClose, onHanded }: { bot: Bot; item: BotItem; onClose: () => void; onHanded: (handoff: Handoff) => void }) {
  const { bots } = useBotStore();
  const others = bots.filter((other) => other.id !== bot.id);
  const [to, setTo] = useState(() => others.find((other) => other.reportsTo === bot.id || other.id === bot.reportsTo)?.id ?? others[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = others.find((other) => other.id === to);
  const hand = (event?: FormEvent) => {
    event?.preventDefault();
    if (!to || busy) return;
    setBusy(true);
    setError(null);
    botHandoffsApi.hand(bot.id, item.number, to, note.trim(), due.trim()).then((answer) => onHanded(answer.handoff), (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  if (others.length === 0) {
    return <p className="rounded-lg border border-dashed border-hairline-strong px-4 py-3 text-[12.5px] text-faint" data-testid="bot-hand-none">There is no other bot to hand it to. Hire one first.</p>;
  }
  return (
    <form onSubmit={hand} className="flex min-w-0 flex-col gap-2 rounded-lg border border-hairline bg-card px-4 py-3" aria-label={`Hand item #${item.number} to another bot`} data-testid="bot-hand-form">
      <label className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        Hand to
        <select value={to} onChange={(event) => setTo(event.target.value)} aria-label="Bot to hand it to" className="h-7 min-w-0 max-w-full rounded-md border border-border bg-transparent px-1.5 text-[13px] text-foreground outline-none focus:border-ring">
          {others.map((other) => <option key={other.id} value={other.id}>{other.name} · {other.roleTitle}{other.paused ? " (paused)" : ""}</option>)}
        </select>
      </label>
      <textarea
        autoFocus
        spellCheck={false}
        value={note}
        maxLength={4000}
        rows={3}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        placeholder="Your note: what you want from it (optional)"
        aria-label="Your note"
        className="min-w-0 resize-y rounded-md border border-border bg-transparent px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-ring"
      />
      <input
        spellCheck={false}
        value={due}
        maxLength={200}
        onChange={(event) => setDue(event.target.value)}
        placeholder="When the answer is due (optional)"
        aria-label="When the answer is due"
        className="h-8 min-w-0 rounded-md border border-border bg-transparent px-2 text-[13px] text-foreground outline-none focus:border-ring"
      />
      <p className="min-w-0 text-[12px] text-faint">
        {target?.name ?? "It"} gets a chat of its own for it, under its own access{target?.paused ? ", once you resume it" : ""}. The item's text goes as {bot.name}'s words; your note goes as yours. Its answer comes back to {bot.name}.
      </p>
      {error && <MachineHostError error={error} onRestarted={() => hand()} onFailed={setError} />}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="accent" type="submit" disabled={busy || !to} data-testid="bot-hand-submit">{busy && <Loader2 className="animate-spin" />} Hand to {target?.name ?? "bot"}</Button>
      </div>
    </form>
  );
}
