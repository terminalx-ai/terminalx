import type { TurnCheckpointApi } from "@/lib/turnCheckpoints";
import { PrivacyImage } from "@/components/ui/privacy-image";
import { TurnDetailsPopover, turnStats, type TurnFallback } from "./UsagePopovers";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { ArrowLeftRight, Bookmark, Brain, Check, ChevronRight, CircleAlert, CircleX, Clock, Copy, Ellipsis, FileText, FolderGit2, GitFork, Image as ImageIcon, Keyboard, Loader2, Navigation, Pencil, RefreshCw, RotateCcw, Send, Shrink, Square, Unmute, Users, X } from "@/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { canReadAloud, readAloud, stopReading, useReadingAloud } from "@/lib/readAloud";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time";
import { compactionStatus, type Delivery, type Turn, type WorkItem } from "@/lib/transcript";
import type { StreamBlock } from "@/lib/agentEvents";
import { MessageTime } from "./MessageTime";
import { dividerLabel } from "@/lib/turnDivider";
import { messageTime } from "@terminalx/portable/transcript";
import { Markdown } from "./Markdown";
import { LinkedText } from "./LinkedText";
import { iconFor, ToolCallRow, ToolGroupRow } from "./ToolCallRow";
import { ShellBlock } from "./ShellBlock";
import { usePrefs } from "@/lib/prefs";
import { turnFileChanges } from "@/lib/turnChanges";
import { TurnChanges } from "./TurnChanges";
import { DisclosureScope, useDisclosure, useSearchSection } from "./disclosures";
import { ChatMedia } from "./ChatMedia";
import { MessageFiles } from "./MessageFiles";
import { mediaMentions } from "@/lib/chatMedia";
import { classifyRecovery } from "@/lib/recovery";
import { useExposure, useInView, useRecoveryReporter } from "@/lib/recoveryReports";
import { openImageViewer, type ViewerImage } from "@/lib/imageViewer";

/**
 * One exchange: the prompt, the work under it, the answer, and a footer.
 *
 * Once the agent has answered, the work folds behind one header line that
 * says what it did ("> 6 tool calls · 2 files edited", then the kinds of
 * tools). Opened, it lists the work in the order the agent did it, its own
 * words between the steps included. The footer is a single quiet row: how
 * long the turn took and when it ended, its cache hit and output speed, a
 * copy of the answer and a second opinion. A failed turn ends in one error
 * card, with Retry. The reader's own time sits inside their bubble.
 */
export const TurnBlock = memo(function TurnBlock(props: TurnProps) {
  // What is opened or folded in it outlives the turn being drawn (#727).
  return (
    <DisclosureScope value={props.turn.key}>
      <TurnBody {...props} />
    </DisclosureScope>
  );
});

interface TurnProps {
  turn: Turn;
  sessionId: string;
  tabId?: string;
  checkpointTabId?: string;
  /** Where the turn card reads its checkpoint: the runtime's for a remote tab (#1326); this computer's when absent. */
  checkpoints?: TurnCheckpointApi;
  cwd?: string;
  stream: StreamBlock[];
  working: boolean;
  streamingTool?: StreamBlock;
  /** Send a message queued behind the running turn now; absent where that cannot be done (a cloud session). */
  onSendQueuedNow?: (seq: number) => void;
  /** Send a message the agent dropped unanswered again, as a new message (#722); absent where that cannot be done. */
  onSendAgain?: (seq: number) => void;
  onSecondOpinion?: (turn: Turn) => void;
  /** Who a second opinion asks: "Codex" in "Second opinion from Codex". */
  secondOpinionAgent?: string;
  /** Fork the conversation as it stood at this turn's end (PRO-379); absent where that cannot be done. */
  onFork?: (endSeq: number, into: "tab" | "session") => void;
  /** Keep this turn's prompt as a snippet; absent where there is nowhere to keep it. */
  onSaveSnippet?: (text: string) => void;
  /** What the turn details say for settings a turn's own record lacks. */
  turnFallback?: TurnFallback;
  onReset?: (endSeq: number) => void;
  /** The agent's name, for what a message taken mid-turn says ("Codex reads it at its next tool call"). */
  agent?: { id: string; name: string };
  /** When the agent started working on the running turn (ms): the working line counts up from it. */
  workingSince?: number;
  /** Send a failed turn's prompt again, as a new message; absent where that cannot be done. */
  onRetry?: (seq: number) => void;
  /** Take a failed turn's prompt to a new chat. */
  onRetryInNewChat?: (turn: Turn) => void;
  /**
   * Why an action this session cannot take here is off (#1289): shown as a
   * disabled control with that reason where the action would be, instead of
   * leaving it out. Each is ignored while its handler is given.
   */
  forkUnavailable?: string;
  resetUnavailable?: string;
  secondOpinionUnavailable?: string;
  retryInNewChatUnavailable?: string;
}

function TurnBody({
  agent,
  turn,
  sessionId,
  tabId,
  checkpointTabId,
  checkpoints,
  cwd,
  stream,
  working,
  streamingTool,
  onSendQueuedNow,
  onSendAgain,
  onSecondOpinion,
  secondOpinionAgent,
  onFork,
  onSaveSnippet,
  turnFallback,
  onReset,
  workingSince,
  onRetry,
  onRetryInNewChat,
  forkUnavailable,
  resetUnavailable,
  secondOpinionUnavailable,
  retryInNewChatUnavailable,
}: TurnProps) {
  const prefs = usePrefs();
  const [expanded, setExpanded] = useDisclosure("fold");
  const hasAnswer = turn.work.some((w) => w.kind === "text");
  const toolItems = turn.work.filter((w) => !outsideFold(w));
  const foldable = prefs.foldToolCalls && !turn.live && toolItems.some(inFoldSummary) && (hasAnswer || turn.completed);
  const streamText = stream.filter((s) => s.kind === "text" && s.text);
  const streamThinking = stream.filter((s) => s.kind === "thinking" && s.text && !s.done);
  const linkContext = useMemo(() => cwd ? { sessionId, cwd } : undefined, [cwd, sessionId]);
  const changes = useMemo(() => (prefs.turnChanges && turn.completed ? turnFileChanges(turn) : []), [prefs.turnChanges, turn]);
  const outcome = turnOutcome(turn);
  // A failed turn says why once (one card), not as an error row and again as the turn's failure.
  const failure = useMemo(() => failureOf(turn), [turn]);
  const work = failure ? turn.work.filter((w) => !failure.merged.has(w.key)) : turn.work;
  // Opened, the fold holds everything up to the last step, in the order it happened: the agent's words before and
  // between its steps stay where it said them. What it said after its last step is the answer, under the fold.
  const lastStep = work.reduce((last, w, i) => (outsideFold(w) ? last : i), -1);
  const row = (w: WorkItem) => <WorkRow key={w.key} item={w} cwd={cwd} linkContext={linkContext} onSendQueuedNow={onSendQueuedNow} onSendAgain={onSendAgain} agent={agent} />;

  return (
    // A block formatting context: a last row's margin stays inside, so the turn's measured height is all the room it takes (#727).
    <div className="transcript-turn group/turn flow-root pb-8" data-turn={turn.key}>
      {turn.prompt && <ReaderMessage message={turn.prompt} cwd={cwd} linkContext={linkContext} className="mb-4" onSendAgain={onSendAgain} />}

      {foldable ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex max-w-full items-center gap-1.5 rounded-md -mx-1.5 px-1.5 py-1 text-[13px] text-muted-foreground hover:bg-veil-raised"
            data-testid="turn-fold"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", expanded && "rotate-90")} />
            <span className="min-w-0 truncate">{summarize(turn)}</span>
            <ToolKinds items={toolItems} />
          </button>
          {expanded ? (
            <>
              <div className="ml-1 mt-1 border-l border-hairline pl-3.5" data-testid="turn-fold-body">
                {work.slice(0, lastStep + 1).map(row)}
              </div>
              {work.slice(lastStep + 1).map(row)}
            </>
          ) : (
            work.filter(outsideFold).map(row)
          )}
        </div>
      ) : (
        <div className="mb-3 space-y-0.5">
          {work.map(row)}
        </div>
      )}

      {streamThinking.map((s) => (
        <div key={`${s.ref.messageId}:${s.ref.index}`} className="mb-2 flex items-start gap-2 text-[13px] text-thinking">
          <Brain className="mt-1 size-3.5 shrink-0 animate-pulse-soft" />
          <div className="line-clamp-3 whitespace-pre-wrap italic opacity-80"><LinkedText text={s.text.slice(-600)} context={linkContext} /></div>
        </div>
      ))}
      {streamingTool && (
        <div className="mb-1 flex items-center gap-2 -mx-1.5 px-1.5 py-1 text-[13px]">
          <Loader2 className="size-4 shrink-0 animate-spin text-warning" />
          <span className="shrink-0 text-warning">{streamingTool.toolName ?? "Calling a tool"}</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground"><LinkedText text={previewFromPartialJson(streamingTool.partialJson)} context={linkContext} /></span>
        </div>
      )}
      {streamText.map((s) => (
        <div key={`${s.ref.messageId}:${s.ref.index}`} className="mb-3"><Markdown text={s.text} streaming linkContext={linkContext} /></div>
      ))}

      {working && !streamText.length && !streamThinking.length && !streamingTool && (
        <div role="status" className="mb-3 flex items-center gap-2 -mx-1.5 px-1.5 text-[13px] text-warning" data-testid="working-line">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <span>Working<Elapsed since={workingSince} /></span>
        </div>
      )}

      {failure && <FailureCard turn={turn} failure={failure} linkContext={linkContext} onRetry={onRetry} onRetryInNewChat={onRetryInNewChat} retryInNewChatUnavailable={retryInNewChatUnavailable} />}

      {prefs.turnChanges && turn.completed && <TurnChanges key={`${sessionId}:${checkpointTabId ?? ""}:${turn.checkpointSeq ?? turn.seq}`} changes={changes} cwd={cwd} linkContext={linkContext} checkpoint={checkpointTabId ? { sessionId, tabId: checkpointTabId, seq: turn.checkpointSeq ?? turn.seq, api: checkpoints } : undefined} range={turn.prompt?.baseline && turn.completed.head ? { base: turn.prompt.baseline, head: turn.completed.head } : null} />}

      {(turn.completed || !turn.live) && <TurnFooter turn={turn} sessionId={sessionId} tabId={tabId} outcome={outcome} fallback={turnFallback} onSecondOpinion={turn.completed && !turn.live ? onSecondOpinion : undefined} secondOpinionAgent={secondOpinionAgent} onReset={onReset} onFork={onFork} onSaveSnippet={onSaveSnippet}
        unavailable={{ fork: forkUnavailable, reset: resetUnavailable, secondOpinion: turn.completed && !turn.live ? secondOpinionUnavailable : undefined }} />}
    </div>
  );
}

/** "· 18s" after Working, counting up each second from when the agent started. */
function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  if (since == null || !Number.isFinite(since)) return null;
  return <span className="tabular-nums">{` · ${formatDuration(Math.max(0, now - since))}`}</span>;
}

/** The kinds of tools a folded turn used, as small icons after its summary, in the order first used. */
function ToolKinds({ items }: { items: WorkItem[] }) {
  const kinds: string[] = [];
  for (const w of items) {
    const kind = w.kind === "tool" ? w.call.toolType : w.kind === "tool_group" ? w.calls[0]?.toolType : w.kind === "subagent" ? "subagent_spawn" : null;
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  if (!kinds.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-faint" aria-hidden data-testid="tool-kinds">
      {kinds.slice(0, 6).map((kind) => {
        const Icon = iconFor(kind);
        return <Icon key={kind} className="size-3.5" />;
      })}
    </span>
  );
}

/** A failed turn's one error: its words, the error rows that said the same and fold into it, and when it ended. */
type Failure = { text: string; detail?: string; merged: Set<string>; seq?: number };

function failureOf(turn: Turn): Failure | null {
  if (!turn.completed || turn.completed.status === "ok") return null;
  const errors = turn.work.filter((w): w is Extract<WorkItem, { kind: "error" }> => w.kind === "error");
  const text = turn.finalText ?? errors.at(-1)?.text;
  if (!text?.trim()) return null;
  const same = errors.filter((e) => e.text.trim() === text.trim());
  return { text, detail: turn.detail ?? same.at(-1)?.detail, merged: new Set(same.map((e) => e.key)), seq: same.at(-1)?.seq ?? turn.completed.seq };
}

/**
 * A failed turn's error, once: what went wrong and when, then Retry (the same prompt, sent again) and Retry in a new
 * chat. Its time in view, in the tab in front, is told to the tab's recovery incidents (#815), as the error row was.
 */
function FailureCard({ turn, failure, linkContext, onRetry, onRetryInNewChat, retryInNewChatUnavailable }: { turn: Turn; failure: Failure; linkContext?: { sessionId: string; cwd: string }; onRetry?: (seq: number) => void; onRetryInNewChat?: (turn: Turn) => void; retryInNewChatUnavailable?: string }) {
  const section = useSearchSection("failure");
  const reporter = useRecoveryReporter();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, !!reporter?.active);
  useExposure({ reporter, surface: "error_row", present: true, reason: classifyRecovery(failure.text), eventSeq: failure.seq, inView });
  const time = messageTime(turn.completed?.ts);
  const seq = turn.prompt?.seq;
  const retry = onRetry && seq != null && !turn.prompt?.withdrawn ? () => onRetry(seq) : undefined;
  const fresh = onRetryInNewChat && turn.prompt ? () => onRetryInNewChat(turn) : undefined;
  // Not offered here: the control stays, off, with why (#1289).
  const freshOff = !fresh && turn.prompt ? (retryInNewChatUnavailable ?? null) : null;
  return (
    <div ref={ref} role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[13px]" data-testid="turn-failure">
      <div className="flex items-start gap-2">
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 select-text text-foreground">
          <div {...section} className="whitespace-pre-wrap font-medium"><LinkedText text={failure.text} context={linkContext} citations /></div>
          {failure.detail && <AgentSaid text={failure.detail} searchPart="failure-detail" />}
        </div>
        {time && <time dateTime={time.iso} title={time.full} className="shrink-0 text-xs tabular-nums text-faint">{time.short}</time>}
      </div>
      {(retry || fresh || freshOff) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
          {retry && <Button size="xs" variant="secondary" onClick={retry}><RotateCcw /> Retry</Button>}
          {fresh && <Button size="xs" variant="outline" onClick={fresh}>Retry in a new chat</Button>}
          {freshOff && (
            // A disabled button takes no hover, so the reason is on a wrapper that does.
            <span title={freshOff} data-testid="retry-in-new-chat-unavailable">
              <Button size="xs" variant="outline" disabled aria-label={`Retry in a new chat: ${freshOff}`}>Retry in a new chat</Button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The agent's own last line under an error (#667): "update Codex" or "unauthorized (401)" without opening its terminal.
 * Plain text, already bounded and redacted by the runtime.
 */
function AgentSaid({ text, searchPart }: { text: string; searchPart: string }) {
  const section = useSearchSection(searchPart);
  return (
    <p className="mt-1 break-words font-mono text-[12px] text-destructive/80" data-testid="agent-said">
      <span className="sr-only">The agent said: </span>
      <span {...section}>{text}</span>
    </p>
  );
}

/** The steps a fold is for: a turn with none of these has nothing to fold. */
function inFoldSummary(item: WorkItem): boolean {
  return item.kind === "tool" || item.kind === "tool_group" || item.kind === "reasoning" || item.kind === "subagent";
}

/** What a folded turn still shows: the answer, and the reader's own words (#551) and `!` commands (#1294). */
function outsideFold(item: WorkItem): boolean {
  return item.kind === "text" || item.kind === "message" || item.kind === "queued" || item.kind === "media" || item.kind === "shell";
}

type Outcome = { tone: "ok" | "stopped" | "failed"; word: string; label: string; duration: string | null };

/** How a settled turn went, in the words its header or footer uses. */
function turnOutcome(turn: Turn): Outcome | null {
  const done = turn.completed;
  if (!done) return null;
  const duration = done.durationMs != null ? formatDuration(done.durationMs) : null;
  if (done.status === "ok") return { tone: "ok", word: "Worked", label: duration ? `Worked for ${duration}` : "Worked", duration: duration && `for ${duration}` };
  const tone = done.status === "aborted" ? "stopped" : "failed";
  const word = tone === "stopped" ? "Stopped" : "Failed";
  return { tone, word, label: duration ? `${word} after ${duration}` : word, duration: duration && `after ${duration}` };
}

function OutcomeIcon({ tone }: { tone: Outcome["tone"] }) {
  if (tone === "ok") return <Check className="size-3.5 shrink-0" />;
  if (tone === "stopped") return <X className="size-3.5 shrink-0" />;
  return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
}

/**
 * A settled turn's one footer row: how long it took and when it ended (which opens the turn's details), its cache hit
 * and output speed (PRO-378), a copy of the answer, read aloud on hover, a "…" menu with what can be done from this
 * turn (PRO-379), and a second opinion.
 */
function TurnFooter({ turn, sessionId, tabId, outcome, fallback, onSecondOpinion, secondOpinionAgent, onReset, onFork, onSaveSnippet, unavailable }: {
  turn: Turn;
  sessionId: string;
  tabId?: string;
  outcome: Outcome | null;
  fallback?: TurnFallback;
  onSecondOpinion?: (turn: Turn) => void;
  secondOpinionAgent?: string;
  onReset?: (endSeq: number) => void;
  onFork?: (endSeq: number, into: "tab" | "session") => void;
  onSaveSnippet?: (text: string) => void;
  /** Why each action this session cannot take is off, shown as a disabled item with that reason (#1289). */
  unavailable?: { fork?: string; reset?: string; secondOpinion?: string };
}) {
  const answer = turn.work.flatMap((w) => (w.kind === "text" && w.text.trim() ? [w] : []));
  const ts = answer.at(-1)?.messageTs;
  const text = answer.map((w) => w.text).join("\n\n");
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const speechKey = JSON.stringify([sessionId, tabId ?? null, turn.key]);
  const reading = useReadingAloud(speechKey);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  const settled = !!turn.completed && !turn.live;
  const endSeq = turn.completed?.status === "ok" ? turn.completed.seq : undefined;
  const prompt = turn.prompt?.text.trim();
  const fork = endSeq != null ? onFork : undefined;
  const reset = endSeq != null ? onReset : undefined;
  const snippet = prompt ? onSaveSnippet : undefined;
  // Off with a reason only where the action would have been offered.
  const forkOff = !fork && endSeq != null ? unavailable?.fork : undefined;
  const resetOff = !reset && endSeq != null ? unavailable?.reset : undefined;
  const opinionOff = !onSecondOpinion ? unavailable?.secondOpinion : undefined;
  const branching = !!(fork || reset || forkOff || resetOff);
  const hasMenu = !!(branching || text || snippet || onSecondOpinion || opinionOff);
  const ended = messageTime(turn.completed?.ts ?? ts);
  const stats = turnStats(turn);
  if (!messageTime(ts) && !outcome && !text && !turn.completed && !onSecondOpinion && !onReset) return null;
  const quiet = outcome?.tone === "ok";
  const label = [outcome ? (quiet ? outcome.duration?.replace(/^for /, "") ?? outcome.word : outcome.label) : null, ended ? ended.short : null].filter(Boolean).join(" · ");
  const icon = "-my-1 flex size-6 items-center justify-center rounded-md text-faint hover:bg-veil-raised hover:text-foreground focus-visible:outline";
  const hover = "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/turn:opacity-100";
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-2 text-xs text-faint" data-testid="turn-footer">
      {settled ? (
        <TurnDetailsPopover turn={turn} fallback={fallback} label={label}>
          {outcome && !quiet && <OutcomeIcon tone={outcome.tone} />}
          <span className={cn("tabular-nums", outcome?.tone === "failed" && "text-destructive")}>{label}</span>
        </TurnDetailsPopover>
      ) : (
        <MessageTime ts={ts} inline />
      )}
      {stats.cacheHit != null && <span className="tabular-nums" title="Share of this turn's input read from the prompt cache">cache hit {stats.cacheHit}%</span>}
      {stats.tokensPerSecond != null && <span className="tabular-nums" title="Average output rate over the whole turn, tool calls included">{stats.tokensPerSecond} tok/s</span>}
      {text && (
        <button type="button" aria-label="Copy answer" title={copied ? "Copied" : "Copy answer"} onClick={() => void copyText(text).then(() => setCopied(true))} className={icon}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      )}
      {text && canReadAloud() && (
        <button type="button" aria-label={reading ? "Stop reading aloud" : "Read aloud"} title={reading ? "Stop reading aloud" : "Read aloud"} aria-pressed={reading}
          onClick={() => (reading ? stopReading() : readAloud(speechKey, text))} className={cn(icon, !reading && hover, reading && "text-foreground")}>
          {reading ? <Square className="size-3" /> : <Unmute className="size-3.5" />}
        </button>
      )}
      {settled && hasMenu && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Turn actions" title="Turn actions" className={cn(icon, !menuOpen && hover, "data-[state=open]:bg-veil-strong data-[state=open]:text-foreground")}>
              <Ellipsis className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            {fork && <>
              <TurnMenuItem icon={<GitFork />} label="Fork to new tab" hint="Same worktree · knows the chat up to here" onSelect={() => fork(endSeq!, "tab")} />
              <TurnMenuItem icon={<FolderGit2 />} label="Fork to new session" hint="New worktree with this turn's files" onSelect={() => fork(endSeq!, "session")} />
            </>}
            {forkOff && <TurnMenuItem icon={<GitFork />} label="Fork" hint={forkOff} disabled />}
            {(reset || resetOff) && <>
              {(fork || forkOff) && <DropdownMenuSeparator />}
              {reset
                ? <TurnMenuItem icon={<RotateCcw />} label="Reset chat to here…" hint="Removes later turns; can reset files too" onSelect={() => reset(endSeq!)} />
                : <TurnMenuItem icon={<RotateCcw />} label="Reset chat to here…" hint={resetOff} disabled />}
            </>}
            {branching && (text || snippet || onSecondOpinion || opinionOff) && <DropdownMenuSeparator />}
            {text && <TurnMenuItem icon={<FileText />} label="Copy answer as Markdown" onSelect={() => void copyText(text).then(() => setCopied(true))} />}
            {snippet && <TurnMenuItem icon={<Bookmark />} label="Save the prompt as a snippet…" onSelect={() => snippet(prompt!)} />}
            {onSecondOpinion && <TurnMenuItem icon={<ArrowLeftRight />} label={secondOpinionAgent ? `Second opinion from ${secondOpinionAgent}` : "Second opinion"}
              hint={`Opens ${secondOpinionAgent ? `a ${secondOpinionAgent}` : "another agent's"} tab with this turn's diff`} onSelect={() => onSecondOpinion(turn)} />}
            {opinionOff && <TurnMenuItem icon={<ArrowLeftRight />} label="Second opinion" hint={opinionOff} disabled />}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onSecondOpinion && (
        <button type="button" onClick={() => onSecondOpinion(turn)} title={secondOpinionAgent ? `Second opinion from ${secondOpinionAgent}` : undefined}
          className="-mx-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-veil-raised hover:text-foreground">
          <ArrowLeftRight className="size-3.5" />
          Second opinion
        </button>
      )}
    </div>
  );
}

/** A turn action; `disabled`, its hint says why it cannot be taken here. */
function TurnMenuItem({ icon, label, hint, onSelect, disabled = false }: { icon: ReactNode; label: string; hint?: string; onSelect?: () => void; disabled?: boolean }) {
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled} className={cn(hint && "items-start whitespace-normal")}>
      <span className={cn(hint && "mt-0.5")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </DropdownMenuItem>
  );
}

function summarize(turn: Turn): string {
  const parts: string[] = [];
  if (turn.toolCount) parts.push(`${turn.toolCount} tool call${turn.toolCount === 1 ? "" : "s"}`);
  // A call an agent's safety check held is why the turn waited on the reader (#775): said while its row is folded away.
  const held = turn.work.flatMap((w) => (w.kind === "tool" && w.call.result?.safetyCheck ? [w.call.result.safetyCheck] : []));
  if (held.length === 1) parts.push(held[0]);
  else if (held.length > 1) parts.push(`${held.length} held by a safety check`);
  if (turn.editedFiles) parts.push(`${turn.editedFiles} file${turn.editedFiles === 1 ? "" : "s"} edited`);
  const thoughts = turn.work.filter((w) => w.kind === "reasoning").length;
  if (!parts.length && thoughts) parts.push("thought about it");
  return parts.join(" · ") || "Details";
}

export function previewFromPartialJson(partial: string): string {
  // Read the accumulated prefix without parsing it: the first string value of
  // a target-ish key is usually the whole story.
  for (const key of ["file_path", "command", "pattern", "query", "url", "path", "prompt", "description"]) {
    const i = partial.indexOf(`"${key}"`);
    if (i < 0) continue;
    const colon = partial.indexOf(":", i);
    const q = partial.indexOf('"', colon + 1);
    if (q < 0) continue;
    let end = q + 1;
    while (end < partial.length && !(partial[end] === '"' && partial[end - 1] !== "\\")) end++;
    return partial.slice(q + 1, end).replace(/\\n/g, " ").slice(0, 120);
  }
  return "";
}

function WorkRow({ item, cwd, linkContext, onSendQueuedNow, onSendAgain, agent }: { item: WorkItem; cwd?: string; linkContext?: { sessionId: string; cwd: string }; onSendQueuedNow?: (seq: number) => void; onSendAgain?: (seq: number) => void; agent?: { id: string; name: string } }) {
  const section = useSearchSection(item.kind === "queued" ? `message:${item.seq}` : item.key);
  switch (item.kind) {
    case "text":
      return <div className="mb-3"><div {...section}><Markdown text={item.text} linkContext={linkContext} /></div>{linkContext && <MentionedMedia text={item.text} linkContext={linkContext} />}</div>;
    case "reasoning":
      return <ReasoningRow name={item.key} text={item.text} durationMs={item.durationMs} linkContext={linkContext} />;
    case "tool":
      return <ToolCallRow call={item.call} cwd={cwd} linkContext={linkContext} />;
    case "tool_group":
      return <ToolGroupRow name={item.name} calls={item.calls} cwd={cwd} linkContext={linkContext} />;
    case "message":
      // Taken while the agent worked (#551): steering, said above the bubble (PRO-380, 03.12).
      return <ReaderMessage message={item} cwd={cwd} linkContext={linkContext} className="my-3" onSendAgain={onSendAgain} steered={steeringNote(agent)} />;
    case "queued":
      return (
        <QueuedCard
          label={item.withdrawn ? null : "Queued"}
          author={item.author}
          text={item.text}
          section={section}
          linkContext={linkContext}
          time={<MessageTime ts={item.messageTs} />}
          files={item.files?.length ? <MessageFiles files={item.files} sessionId={linkContext?.sessionId} sentAt={item.messageTs} cwd={cwd} open={!!linkContext} /> : null}
          onSendNow={onSendQueuedNow && !item.inputOccupied && !item.withdrawn ? () => onSendQueuedNow(item.seq) : undefined}
        >
          {item.inputOccupied && <InputOccupiedNote />}
          {item.withdrawn && <WithdrawnNote unconfirmed={item.unconfirmed} seq={item.seq} onSendAgain={onSendAgain} />}
        </QueuedCard>
      );
    case "status":
      return (
        <div className="-mx-1.5 px-1.5 py-1 text-xs text-faint">
          <LinkedText text={item.text} context={linkContext} />
          {item.initiatingPrompt?.trim() && <InitiatingPrompt name={item.key} text={item.initiatingPrompt} linkContext={linkContext} />}
        </div>
      );
    case "error":
      return <ErrorRow item={item} linkContext={linkContext} />;
    case "compaction":
      return <CompactionRow item={item} linkContext={linkContext} />;
    case "retry":
      return (
        <div className="my-1 flex items-center gap-2 -mx-1.5 px-1.5 py-1 text-xs text-warning">
          <RefreshCw className="size-3.5 animate-spin" />
          Retrying ({item.attempt}/{item.maxRetries}){item.reason ? <>: <LinkedText text={item.reason} context={linkContext} /></> : null}
        </div>
      );
    case "subagent":
      return (
        <div className="flex items-center gap-2 -mx-1.5 px-1.5 py-1 text-[13px] text-muted-foreground">
          <Users className="size-3.5" />
          <span className={cn(!item.done && "text-shimmer")}><LinkedText text={item.label ?? "Subagent"} context={linkContext} /></span>
          {item.done && <Check className="size-3.5 text-faint" />}
        </div>
      );
    case "shell":
      return <ShellBlock item={item} linkContext={linkContext} />;
    case "media":
      return linkContext ? <div className="mb-3"><ChatMedia paths={item.paths} context={linkContext} /></div> : null;
    case "decision":
      return (
        <div className={cn("-mx-1.5 px-1.5 py-0.5 text-xs", item.allowed ? "text-faint" : "text-destructive/80")}>
          <LinkedText text={item.label} context={linkContext} />
        </div>
      );
  }
}

/** The prompt an automation or a handoff started the session with, folded under its status line. */
/** An error in the conversation. Its time in view, in the tab in front, is told to the tab's recovery incidents (#815). */
function ErrorRow({ item, linkContext }: { item: Extract<WorkItem, { kind: "error" }>; linkContext?: { sessionId: string; cwd: string } }) {
  const section = useSearchSection(item.key);
  const reporter = useRecoveryReporter();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, !!reporter?.active);
  useExposure({ reporter, surface: "error_row", present: true, reason: classifyRecovery(item.text), eventSeq: item.seq, inView });
  return (
    <div ref={ref} className="my-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 select-text">
        <span {...section} className="whitespace-pre-wrap"><LinkedText text={item.text} context={linkContext} /></span>
        {item.detail && <AgentSaid text={item.detail} searchPart={`${item.key}:detail`} />}
      </div>
    </div>
  );
}

function InitiatingPrompt({ name, text, linkContext }: { name: string; text: string; linkContext?: { sessionId: string; cwd: string } }) {
  const [open, setOpen] = useDisclosure(name);
  return (
    <details className="mt-1" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2">Initiating prompt</summary>
      <div className="mt-2 whitespace-pre-wrap break-words select-text"><LinkedText text={text} context={linkContext} /></div>
    </details>
  );
}

/**
 * A message the agent has not taken yet: queued behind the running turn in a
 * local session, or on its way to a cloud workspace (#1291). One card for
 * both; what is under it (`children`) says why it waits.
 */
export function QueuedCard({
  label,
  author,
  text,
  section,
  linkContext,
  time,
  files,
  onSendNow,
  children,
  ...data
}: {
  /** "Queued", or what else it is ("Steer"); null for none (a message withdrawn). */
  label: string | null;
  author?: { userId: string; displayName: string } | null;
  text: string;
  section?: ReturnType<typeof useSearchSection>;
  linkContext?: { sessionId: string; cwd: string };
  time?: ReactNode;
  files?: ReactNode;
  /** Interrupt the agent's turn so this goes now; absent where it cannot. */
  onSendNow?: () => void;
  children?: ReactNode;
  [key: `data-${string}`]: string | undefined;
}) {
  return (
    <div className="my-3 rounded-lg border border-dashed border-hairline-strong px-3 py-2 text-[13px] text-muted-foreground" data-testid="queued-message" {...data}>
      <div className="flex flex-wrap items-center gap-2">
        <Clock className="size-3.5 shrink-0" />
        {label && <span className="text-xs">{label}</span>}
        {author && <span className="min-w-0 wrap-anywhere" data-user-id={author.userId}>{author.displayName}:</span>}
        {onSendNow && (
          <WithTooltip label="Interrupt the agent and send this now">
            <Button size="xs" variant="outline" className="ml-auto shrink-0" onClick={onSendNow}>
              <Send /> Send now
            </Button>
          </WithTooltip>
        )}
      </div>
      {files ? <div className="mt-1.5">{files}</div> : null}
      <div className="mt-1 min-w-0 whitespace-pre-wrap wrap-anywhere select-text"><span {...section}><LinkedText text={text} context={linkContext} /></span>{time}</div>
      {children}
    </div>
  );
}

/**
 * Why a message has not been typed yet (#722): the agent's input box holds something else, and typing would send
 * the two as one prompt. It goes in once the box is empty.
 */
function InputOccupiedNote() {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-warning" data-testid="input-occupied">
      <Keyboard className="mt-0.5 size-3.5 shrink-0" />
      <span>Waiting: the agent&apos;s input box already has text in it. Send or clear that text in the terminal, and this message goes in after it.</span>
    </p>
  );
}

/** A message stopped before the agent took it (#722, #746): not sent, and offered again. */
function WithdrawnNote({ seq, unconfirmed, onSendAgain }: { seq?: number; unconfirmed?: boolean; onSendAgain?: (seq: number) => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-warning" data-testid="prompt-withdrawn">
      <CircleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{unconfirmed ? "Delivery was not confirmed. Check the conversation before sending again." : "Not sent: the agent was stopped before it took this message."}</span>
      {onSendAgain && seq !== undefined && !unconfirmed && (
        <Button size="xs" variant="outline" className="shrink-0" onClick={() => onSendAgain(seq)}>
          <Send /> Send again
        </Button>
      )}
    </div>
  );
}

function MentionedMedia({ text, linkContext }: { text: string; linkContext: { sessionId: string; cwd: string } }) {
  const paths = useMemo(() => mediaMentions(text), [text]);
  return <ChatMedia paths={paths} context={linkContext} />;
}

/** The reader's own words: a turn's prompt, or a message the agent took while the turn ran. */
/**
 * A message the reader has just sent, before the runtime has it (#727): it is
 * in the chat at once, said to be sending, and is replaced by the message the
 * runtime records. Not a turn yet: nothing is measured or folded here.
 */
export function SendingMessage({ message, cwd, failed = false }: { message: { text: string; images: { url: string; name?: string }[]; files?: { name: string }[] }; cwd?: string; failed?: boolean }) {
  const layout = usePrefs().transcriptLayout;
  return (
    <div className="transcript-turn flow-root" data-testid="sending-message" aria-busy={!failed}>
      <ReaderMessage message={message} cwd={cwd} className="mb-1 opacity-70" />
      {!failed && <div role="status" className={cn("mb-4 flex px-1 text-[11px] text-muted-foreground", layout === "chat" && "justify-end")}>
        Sending…
      </div>}
    </div>
  );
}

/** A table's row of dashes: cells of `-` (with `:` for alignment) between pipes, at least one pipe. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * A message split into its GitHub-style tables and the text around them: a table is a row with a pipe, the row of
 * dashes under it, and the rows with pipes after that.
 */
export function splitMarkdownTables(text: string): { table: boolean; text: string }[] {
  const lines = text.split("\n");
  const parts: { table: boolean; text: string }[] = [];
  const push = (table: boolean, line: string) => {
    const last = parts.at(-1);
    if (last && last.table === table) last.text += `\n${line}`;
    else parts.push({ table, text: line });
  };
  for (let i = 0; i < lines.length; i++) {
    const rule = lines[i + 1];
    if (lines[i].includes("|") && rule !== undefined && rule.includes("|") && TABLE_RULE.test(rule)) {
      // A new block even right after another table, so two tables stay two.
      parts.push({ table: true, text: `${lines[i]}\n${rule}` });
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) parts.at(-1)!.text += `\n${lines[i++]}`;
      i--;
    } else push(false, lines[i]);
  }
  return parts;
}

export function hasMarkdownTable(text: string): boolean {
  return splitMarkdownTables(text).some((part) => part.table);
}

function ReaderMessage({
  message,
  cwd,
  linkContext,
  className,
  onSendAgain,
  steered,
}: {
  /** Said above a message the agent took mid-turn; the bubble is edged in blue and keeps its time inside. */
  steered?: string;
  message: { seq?: number; messageTs?: string; author?: { userId: string; displayName: string }; text: string; images?: { url: string; name?: string }[]; files?: readonly { name: string; path?: string }[] } & Delivery;
  cwd?: string;
  linkContext?: { sessionId: string; cwd: string };
  className: string;
  onSendAgain?: (seq: number) => void;
}) {
  const layout = usePrefs().transcriptLayout;
  const section = useSearchSection(`message:${message.seq}`);
  return (
    <div className={cn(className, "group/msg relative flex", steered ? cn("flex-col", layout === "chat" ? "items-end" : "items-stretch") : layout === "chat" ? "justify-end" : "justify-stretch")} data-testid="reader-message">
      {steered && (
        <p className="mb-1 flex items-center justify-end gap-1.5 text-[11px] text-info" data-testid="steered-note">
          <Navigation aria-hidden className="size-[11px] shrink-0" />
          {steered}
        </p>
      )}
      <div
        className={cn(
          "min-w-0 select-text whitespace-pre-wrap wrap-anywhere rounded-xl border bg-card px-4 pt-3 pb-2 text-[14px] leading-relaxed",
          layout === "chat" ? "max-w-[min(85%,560px)]" : "w-full",
          steered ? "border-info/40" : "border-hairline",
        )}
      >
        {message.images?.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.images.map((im, i) =>
              // A cloud tab's image is a file on its workspace, not here: its name, not a broken thumbnail.
              cwd || isLoadableUrl(im.url) ? (
                <button
                  key={i}
                  type="button"
                  aria-label={`View ${im.name || "image"}`}
                  onClick={() => {
                    const all = viewable(message.images ?? [], cwd);
                    openImageViewer(all, all.findIndex((v) => v.src === toAssetUrl(im.url)));
                  }}
                  className="cursor-zoom-in rounded-md outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <PrivacyImage src={toAssetUrl(im.url)} alt="" className="size-20 rounded-md object-cover hairline" />
                </button>
              ) : (
                <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-veil-raised px-2 py-1 text-xs text-muted-foreground" data-testid="prompt-image-name">
                  <ImageIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{im.name || "Image"}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
        {/* Attached files (PRO-290): a sent one opens its stored copy; a sending one is only named. */}
        {message.files?.length ? <MessageFiles files={message.files} sessionId={linkContext?.sessionId} sentAt={message.messageTs} cwd={cwd} open={!!linkContext && message.seq != null} /> : null}
        {message.author && <div className="mb-1 text-xs text-muted-foreground" data-user-id={message.author.userId}>{message.author.displayName}</div>}
        <div {...(message.seq == null ? {} : section)} className={cn((message.replaced || message.withdrawn) && "text-muted-foreground")}>
          {/* A pasted table reads as a table; every other line stays the plain text that was typed. Web links only, no
              remote images: it is someone's paste, not the agent's reply. */}
          {hasMarkdownTable(message.text)
            ? splitMarkdownTables(message.text).map((part, i) =>
                part.table
                  ? <div key={i} className="my-2 whitespace-normal"><Markdown text={part.text} streaming={false} linkContext={linkContext} webLinksOnly remoteImages={false} /></div>
                  : <LinkedText key={i} text={part.text.replace(/^\n+|\n+$/g, "")} context={linkContext} />)
            : <LinkedText text={message.text} context={linkContext} />}
        </div>
        {message.sent !== undefined && (
          <details className="mt-2 text-xs text-muted-foreground" data-testid="prompt-changed">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2">
              <Pencil className="size-3.5 shrink-0" />
              Changed on the way: this is what the agent received. Show what was sent
            </summary>
            <div className="mt-1.5 border-l border-hairline pl-2 whitespace-pre-wrap wrap-anywhere select-text"><LinkedText text={message.sent} context={linkContext} /></div>
          </details>
        )}
        {message.inputOccupied && <InputOccupiedNote />}
        {message.withdrawn && <WithdrawnNote unconfirmed={message.unconfirmed} seq={message.seq} onSendAgain={onSendAgain} />}
        {message.replaced && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-warning" data-testid="prompt-replaced">
            <CircleAlert className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">Not answered: the agent dropped this turn before replying, and took a later prompt in its place.</span>
            {onSendAgain && message.seq !== undefined && (
              <Button size="xs" variant="outline" className="shrink-0" onClick={() => onSendAgain(message.seq!)}>
                <Send /> Send again
              </Button>
            )}
          </div>
        )}
        <BubbleTime ts={message.messageTs} />
      </div>
    </div>
  );
}

/** The reader's message time, in the bubble's bottom-right corner: the time today, with the day before that. */
function BubbleTime({ ts }: { ts?: string }) {
  const time = messageTime(ts);
  if (!time) return null;
  const at = new Date(time.iso);
  const now = new Date();
  const today = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return (
    <div className="mt-1 flex justify-end whitespace-normal">
      <time dateTime={time.iso} title={time.full} aria-label={`Message time: ${time.full}`} className="text-xs leading-4 tabular-nums text-faint" data-testid="message-time">
        {today ? time.short : dividerLabel(at, now)}
      </time>
    </div>
  );
}

/** What a message the agent took mid-turn says above it: Codex reads one at its next tool call. */
export function steeringNote(agent?: { id: string; name: string }): string {
  if (agent?.id === "codex") return `Sent mid-turn · ${agent.name} reads it at its next tool call`;
  return agent ? `Sent mid-turn · ${agent.name} read it while it worked` : "Sent mid-turn";
}

/**
 * The line a compaction leaves in the chat. What the agent kept of the
 * conversation is its own memory, not anybody's message (#524): it folds
 * under the line, as Claude Code keeps it behind ctrl+o.
 */
function CompactionRow({ item, linkContext }: { item: Extract<WorkItem, { kind: "compaction" }>; linkContext?: { sessionId: string; cwd: string } }) {
  const [open, setOpen] = useDisclosure(item.key);
  // The existing Chat indicator owns animation; do not add a second spinner.
  const status = compactionStatus(item);
  if (status === null) return null;
  const count = (value: number) => value < 1000 ? String(value) : `${Math.round(value / 1000)}K`;
  const tokens = item.preTokens != null && item.postTokens != null
    ? ` · ${count(item.preTokens)} → ${count(item.postTokens)} tokens`
    : item.preTokens != null ? ` · from ${count(item.preTokens)} tokens` : item.postTokens != null ? ` · ${count(item.postTokens)} tokens` : "";
  const label = <>{status === "Context compacted" ? "Chat compacted" : status}{tokens}</>;
  // A divider across the column: what came before it is the agent's summary now, not its memory of each message.
  return (
    <div className="my-3">
      <div className="flex items-center gap-3 text-xs text-faint" data-testid="compaction-row">
        <span aria-hidden className="h-px flex-1 bg-hairline" />
        {item.summary ? (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-veil-raised hover:text-muted-foreground">
            <Shrink className="size-3.5 shrink-0" />
            <span>{label}</span>
            <span>· {open ? "Hide summary" : "Show summary"}</span>
          </button>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5">
            <Shrink className="size-3.5 shrink-0" />
            <span>{label}</span>
          </span>
        )}
        <span aria-hidden className="h-px flex-1 bg-hairline" />
      </div>
      {open && item.summary && (
        <div data-testid="compaction-summary" className="mt-2 mb-2 max-h-72 overflow-auto scrollbar-thin border-l border-hairline pl-3 text-xs leading-relaxed whitespace-pre-wrap text-faint select-text">
          <LinkedText text={item.summary} context={linkContext} />
        </div>
      )}
    </div>
  );
}

function ReasoningRow({ name, text, durationMs, linkContext }: { name: string; text: string; durationMs?: number; linkContext?: { sessionId: string; cwd: string } }) {
  const [open, setOpen] = useDisclosure(name);
  const section = useSearchSection(name);
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const label = durationMs != null && durationMs >= 1000 ? `Thought for ${formatDuration(durationMs)}` : "Thought";
  return (
    <div>
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md -mx-1.5 px-1.5 py-1.5 text-left text-[13.5px] hover:bg-veil-raised"
      >
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-expanded={open} aria-label={open ? "Collapse reasoning" : "Expand reasoning"} className="flex shrink-0 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <Brain className="size-4 shrink-0 text-thinking" />
          <span className="shrink-0 text-thinking">{label}</span>
        </button>
        {!open && first && <span className="min-w-0 truncate text-[13px] italic text-muted-foreground"><LinkedText text={first} context={linkContext} /></span>}
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </div>
      {open && <div {...section} className="ml-6 mb-2 whitespace-pre-wrap text-[13px] italic text-thinking/90 select-text"><LinkedText text={text} context={linkContext} /></div>}
    </div>
  );
}

/** A URL the web view loads as it is, rather than a path on some computer. */
function isLoadableUrl(p: string): boolean {
  // `blob:`: a composer's own thumbnail, on a message drawn while it is being sent (#727).
  return p.startsWith("data:") || p.startsWith("blob:") || p.startsWith("http") || p.startsWith("asset:");
}

/** A message's images the viewer can draw: loadable ones, or files when there is a checkout to read them from. */
function viewable(images: { url: string; name?: string | null }[], cwd?: string): ViewerImage[] {
  return images
    .filter((im) => cwd || isLoadableUrl(im.url))
    .map((im) => ({ src: toAssetUrl(im.url), name: im.name || (isLoadableUrl(im.url) ? "Image" : im.url.split("/").pop() || "Image"), path: isLoadableUrl(im.url) ? undefined : im.url }));
}

export function toAssetUrl(p: string): string {
  if (isLoadableUrl(p)) return p;
  try {
    return convertFileSrc(p);
  } catch {
    return p;
  }
}
