import { Clock, GitMerge, Loader2, Split, SquareTerminal } from "@/icons";
import { Chip } from "@/components/ui/chip";
import { useBotItems } from "@/lib/botItems";
import { cn } from "@/lib/cn";
import { conversationTitle, selectSession, useSessionStore } from "@/lib/sessions";
import { checkBackText, clock, runPlanLine, runQuestionsIn, runStateLine, usd, workerLabel, type WorkerHandoff } from "@/lib/botRuns";
import type { Bot } from "@/types/bots";
import type { BotItem, BotItemCheckBack, BotItemRunView, BotRunPiece, BotRunTry } from "@/types/botItems";
import type { SessionEntry } from "@/types/session";
import { ItemQuestionCard } from "./NeedsYou";

/**
 * A bot leads orchestration runs (PRO-476, designs 23.04, 23.09 and 23.01). The run itself is the orchestrator's; what
 * is shown here is what the bot's work item links: the plan its owner is asked to approve (the run plan card, in the
 * bot's chat), each piece handed to a worker with what it cost and reported (the item's activity), and the run and its
 * workers among the item's sessions and links.
 */

/** The run plan cards of the open chat (23.04): each plan its owner is asked to approve, and the question under it. */
export function RunPlanCards({ bot, chatId, chats }: { bot: Bot; chatId: string; chats: readonly SessionEntry[] }) {
  const { list } = useBotItems(bot.id);
  const home = chats.find((chat) => chat.id === chatId)?.bot?.home ?? false;
  const asking = runQuestionsIn(list?.items ?? [], chatId, home, chats);
  if (asking.length === 0) return null;
  // At most 55% of the chat, and never so much that the chat below has no room for its header, a composer whose controls
  // wrap to two rows and the Latest button above it (15rem, in a 760×520 window): the cards scroll first, so neither the
  // composer nor Latest covers the chat's header.
  return (
    <div className="flex max-h-[min(55%,calc(100%-15rem))] shrink-0 flex-col gap-2 overflow-y-auto border-b border-hairline px-4 py-2 scrollbar-thin" aria-label="Run plans" data-testid="bot-run-plans">
      {asking.map((item) => <RunPlanCard key={item.number} bot={bot} item={item} />)}
    </div>
  );
}

/** One plan: its goal, its pieces and who builds each, its estimate, then the bot's question with its answers. */
export function RunPlanCard({ bot, item }: { bot: Bot; item: BotItem }) {
  const { harnesses } = useSessionStore();
  const run = (item.runViews ?? []).find((view) => view.id === item.question?.run);
  const merge = item.question?.purpose === "mergeRun";
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-hairline bg-card" aria-label={`Run plan: ${run?.goal ?? item.title}`} data-testid="bot-run-plan" data-run={run?.id}>
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-2">
        {merge ? <GitMerge className="size-3.5 shrink-0 text-accent" /> : <Split className="size-3.5 shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 basis-[12rem] truncate text-[13px] font-medium text-foreground" title={run?.goal}>
          {merge ? "Ready to merge" : "Run plan"} · {run?.goal ?? item.title}
        </span>
        {run && !run.gone && <span className="shrink-0 text-[12px] text-faint" data-testid="bot-run-plan-line">{runPlanLine(run)}</span>}
      </header>
      {run?.gone ? (
        <p className="px-3 py-2 text-[12.5px] text-faint">This run is no longer kept. Ask {bot.name} for a new plan.</p>
      ) : (
        <ol className="flex flex-col divide-y divide-hairline">
          {(run?.pieces ?? []).map((piece, index) => (
            <li key={piece.id} className="flex min-w-0 items-center gap-3 px-3 py-1.5" data-testid="bot-run-plan-piece">
              <span className="w-4 shrink-0 text-right text-[11.5px] text-faint tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground" title={piece.title}>{piece.title}</span>
              <span className="shrink-0 text-[11.5px] text-faint">{workerLabel(piece.agent, harnesses)}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="border-t border-hairline">
        <ItemQuestionCard bot={bot} item={item} />
      </div>
    </article>
  );
}

/** A worker's session, as an item's links show it: "Codex worker · done · 18 min". */
function trySubline(piece: BotRunPiece, attempt: BotRunTry, harnesses: { id: string; name: string }[] | undefined): string {
  const agent = (harnesses ?? []).find((harness) => harness.id === piece.agent)?.name ?? piece.agent;
  const parts = [`${agent} worker`, attempt.outcome ?? (attempt.ended ? "ended" : piece.state)];
  const started = attempt.started ? Date.parse(attempt.started) : NaN;
  const ended = attempt.ended ? Date.parse(attempt.ended) : NaN;
  if (!Number.isNaN(started) && !Number.isNaN(ended) && ended >= started) parts.push(`${Math.max(1, Math.round((ended - started) / 60_000))} min`);
  return parts.join(" · ");
}

/** The run rows of an item's "Sessions and links": each run, its state, and each worker it handed a piece to. */
export function RunLinks({ runs }: { runs: BotItemRunView[] }) {
  const { sessions, harnesses } = useSessionStore();
  if (runs.length === 0) return null;
  return (
    <>
      {runs.map((run) => {
        const lead = sessions.find((session) => session.id === run.leadSessionId) ?? null;
        return (
          <li key={run.id} className="flex flex-col gap-1 py-1.5" data-testid="bot-item-run-link">
            <button type="button" disabled={!lead} onClick={() => lead && selectSession(lead.id)} className="flex w-full min-w-0 items-start gap-2 rounded-md text-left enabled:hover:bg-veil">
              <Split className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-foreground" title={run.goal ?? run.id}>Run · {run.goal ?? run.id}</span>
                <span className="block truncate text-[11.5px] text-faint">{runStateLine(run)}{lead ? ` · led in ${conversationTitle(lead)}` : ""}</span>
              </span>
            </button>
            {(run.pieces ?? []).flatMap((piece) =>
              piece.tries.filter((attempt) => attempt.sessionId).map((attempt, index) => {
                const worker = sessions.find((session) => session.id === attempt.sessionId) ?? null;
                return (
                  <button
                    key={`${piece.id}:${index}`}
                    type="button"
                    disabled={!worker}
                    onClick={() => worker && selectSession(worker.id)}
                    className="ml-5 flex min-w-0 items-start gap-2 rounded-md text-left enabled:hover:bg-veil"
                    data-testid="bot-item-run-worker"
                  >
                    <SquareTerminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-foreground" title={piece.title}>{piece.title}</span>
                      <span className="block truncate text-[11.5px] text-faint">{trySubline(piece, attempt, harnesses)}</span>
                    </span>
                  </button>
                );
              }),
            )}
          </li>
        );
      })}
    </>
  );
}

/** "Handed Register the Mac mini … to a worker": the worker's agent, worktree, what it reported and what it cost. */
export function HandoffRow({ handoff }: { handoff: WorkerHandoff }) {
  const { harnesses } = useSessionStore();
  const { piece, attempt } = handoff;
  const agent = (harnesses ?? []).find((harness) => harness.id === piece.agent)?.name ?? piece.agent;
  const running = !attempt.ended && !attempt.outcome;
  const reported = attempt.ended ? `${attempt.outcome ?? "ended"} at ${clock(attempt.ended)}` : null;
  const meta = [agent, attempt.branch ? `worktree ${attempt.branch}` : null, handoff.tryNumber > 1 ? `try ${handoff.tryNumber}` : null, reported].filter(Boolean).join(" · ");
  return (
    <li className="flex min-w-0 gap-3 border-b border-hairline py-2 last:border-b-0" data-testid="bot-item-handoff-row">
      <span className="w-12 shrink-0 pt-0.5 font-mono text-[11.5px] text-faint" title={handoff.at}>{clock(handoff.at)}</span>
      <Split className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] text-foreground">
          <span className="break-words">Handed {piece.title} to a worker</span>
          {running && <Chip className="text-warning"><Loader2 className="size-3 animate-spin" /> running</Chip>}
          {attempt.costUsd != null && <span className="ml-auto shrink-0 font-mono text-[11.5px] text-muted-foreground">{usd(attempt.costUsd)}</span>}
        </p>
        <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground" title={meta}>{meta}</p>
        {attempt.report && (
          <p className="mt-0.5 line-clamp-3 border-l-2 border-hairline-strong pl-2 text-[12px] break-words whitespace-pre-wrap text-muted-foreground" data-testid="bot-item-handoff-report">
            <span className="rounded border border-hairline px-1.5 text-[10.5px] text-faint">the worker's report · not an approval</span> {attempt.report}
          </p>
        )}
      </div>
    </li>
  );
}

/** The waiting line at the foot of the item's activity (23.09): when the bot checks back, and that nothing runs meanwhile. */
export function CheckBackRow({ bot, checkBack }: { bot: Bot; checkBack: BotItemCheckBack | undefined }) {
  const when = checkBackText(checkBack);
  if (!when || !checkBack) return null;
  const said = checkBack.at ? `${bot.name} checks back at ${when.replace(", or on a report", "")}${checkBack.onReport ? ", or sooner when a worker reports" : ""}` : `${bot.name} checks back when a worker reports`;
  return (
    <li className="flex min-w-0 gap-3 py-2" data-testid="bot-item-check-back">
      <span className="w-12 shrink-0 pt-0.5 font-mono text-[11.5px] text-faint">{checkBack.at ? clock(checkBack.at) : ""}</span>
      <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{said}</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">Nothing runs and nothing is spent while it waits.</p>
      </div>
    </li>
  );
}

/** A "Started by" row for a run the bot leads: "Run · <goal>" and where it is. Opens the lead's session. */
export function StartedRunRow({ goal, state, selected, onOpen }: { goal: string; state: string; selected: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" aria-current={selected ? "page" : undefined} onClick={onOpen} className={cn("flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left", selected ? "bg-veil-strong" : "hover:bg-veil")} data-testid="bot-started-run">
        <Split className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground" title={goal}>Run · {goal}</span>
          <span className={cn("block truncate text-[11.5px]", state === "plan waits for you" ? "text-accent" : "text-faint")}>{state}</span>
        </span>
      </button>
    </li>
  );
}
