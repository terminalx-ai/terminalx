import { memo, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { Brain, Check, ChevronRight, CircleAlert, Clock, Copy, Image as ImageIcon, Keyboard, Pencil, RefreshCw, Send, Shrink, Users, X } from "@/icons";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time";
import { compactionStatus, type Delivery, type Turn, type WorkItem } from "@/lib/transcript";
import type { StreamBlock } from "@/lib/agentEvents";
import { HoverTime, MessageTime } from "./MessageTime";
import { messageTime } from "@terminalx/portable/transcript";
import { Markdown } from "./Markdown";
import { LinkedText } from "./LinkedText";
import { ToolCallRow, ToolGroupRow } from "./ToolCallRow";
import { usePrefs } from "@/lib/prefs";
import { turnFileChanges } from "@/lib/turnChanges";
import { TurnChanges } from "./TurnChanges";
import { DisclosureScope, useDisclosure } from "./disclosures";
import { ChatMedia } from "./ChatMedia";
import { mediaMentions } from "@/lib/chatMedia";
import { classifyRecovery } from "@/lib/recovery";
import { useExposure, useInView, useRecoveryReporter } from "@/lib/recoveryReports";

/**
 * One exchange: the prompt, the work under it, the answer, and a footer.
 *
 * Once the agent has answered, the work folds behind one header line that
 * says how it went ("Worked for 14s · 2 tool calls"). The footer is a single
 * quiet row: when the answer came, how long it took when no header said so,
 * and a copy button that shows on hover. Times stay in the transcript but
 * out of the reading: the answer's in the footer, the reader's own under
 * their bubble on hover.
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
  checkpointTabId?: string;
  cwd?: string;
  stream: StreamBlock[];
  working: boolean;
  streamingTool?: StreamBlock;
  /** Send a message queued behind the running turn now; absent where that cannot be done (a cloud session). */
  onSendQueuedNow?: (seq: number) => void;
  /** Send a message the agent dropped unanswered again, as a new message (#722); absent where that cannot be done. */
  onSendAgain?: (seq: number) => void;
  /** The time line above the turn when it opens a new sitting ("Yesterday, 5:21 PM"); see \`turnDivider\`. */
  divider?: string | null;
}

function TurnBody({
  turn,
  sessionId,
  checkpointTabId,
  cwd,
  stream,
  working,
  streamingTool,
  onSendQueuedNow,
  onSendAgain,
  divider,
}: TurnProps) {
  const prefs = usePrefs();
  const [expanded, setExpanded] = useDisclosure("fold");
  const hasAnswer = turn.work.some((w) => w.kind === "text");
  const toolItems = turn.work.filter((w) => w.kind === "tool" || w.kind === "tool_group" || w.kind === "reasoning" || w.kind === "subagent");
  const foldable = prefs.foldToolCalls && !turn.live && toolItems.length > 0 && (hasAnswer || turn.completed);
  const failed = turn.completed && turn.completed.status !== "ok";
  const streamText = stream.filter((s) => s.kind === "text" && s.text);
  const streamThinking = stream.filter((s) => s.kind === "thinking" && s.text && !s.done);
  const linkContext = useMemo(() => cwd ? { sessionId, cwd } : undefined, [cwd, sessionId]);
  const changes = useMemo(() => (prefs.turnChanges && turn.completed ? turnFileChanges(turn) : []), [prefs.turnChanges, turn]);
  const outcome = turnOutcome(turn);
  // The header leads with how the turn went when that says something: how long it took, or that it stopped or failed.
  const lead = outcome && (outcome.tone !== "ok" || outcome.duration) ? outcome : null;

  return (
    // A block formatting context: a last row's margin stays inside, so the turn's measured height is all the room it takes (#727).
    <div className="transcript-turn group/turn flow-root pb-8" data-turn={turn.key}>
      {divider && <TurnDivider label={divider} />}
      {turn.prompt && <ReaderMessage message={turn.prompt} cwd={cwd} linkContext={linkContext} className="mb-4" onSendAgain={onSendAgain} />}

      {foldable ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex max-w-full items-center gap-1.5 rounded-md -mx-1.5 px-1.5 py-1 text-[13px] hover:bg-veil-raised"
          >
            {lead && lead.tone !== "ok" && <OutcomeIcon tone={lead.tone} />}
            <span className={cn("shrink-0", lead?.tone === "failed" ? "text-destructive" : "text-muted-foreground")}>{lead ? lead.label : summarize(turn)}</span>
            {/* The space before the dot is for the text (a screen reader, a copy); the flex gap draws the room. */}
            {lead && <span className="min-w-0 truncate text-faint">{` · ${summarize(turn)}`}</span>}
            <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", expanded && "rotate-90")} />
          </button>
          {expanded && (
            <div className="ml-1 mt-1 border-l border-hairline pl-3.5">
              {turn.work.map((w) => (outsideFold(w) ? null : <WorkRow key={w.key} item={w} cwd={cwd} linkContext={linkContext} onSendQueuedNow={onSendQueuedNow} onSendAgain={onSendAgain} />))}
            </div>
          )}
          {turn.work.map((w) => (outsideFold(w) ? <WorkRow key={w.key} item={w} cwd={cwd} linkContext={linkContext} onSendQueuedNow={onSendQueuedNow} onSendAgain={onSendAgain} /> : null))}
        </div>
      ) : (
        <div className="mb-3 space-y-0.5">
          {turn.work.map((w) => (
            <WorkRow key={w.key} item={w} cwd={cwd} linkContext={linkContext} onSendQueuedNow={onSendQueuedNow} onSendAgain={onSendAgain} />
          ))}
        </div>
      )}

      {streamThinking.map((s) => (
        <div key={`${s.ref.messageId}:${s.ref.index}`} className="mb-2 flex items-start gap-2 text-[13px] text-thinking">
          <Brain className="mt-1 size-3.5 shrink-0 animate-pulse-soft" />
          <div className="line-clamp-3 whitespace-pre-wrap italic opacity-80"><LinkedText text={s.text.slice(-600)} context={linkContext} /></div>
        </div>
      ))}
      {streamingTool && (
        <div className="mb-1 flex items-center gap-2 -mx-1.5 px-1.5 py-1 text-[13px] text-muted-foreground">
          <span className="text-shimmer">{streamingTool.toolName ?? "Calling a tool"}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-faint"><LinkedText text={previewFromPartialJson(streamingTool.partialJson)} context={linkContext} /></span>
        </div>
      )}
      {streamText.map((s) => (
        <div key={`${s.ref.messageId}:${s.ref.index}`} className="mb-3"><Markdown text={s.text} streaming linkContext={linkContext} /></div>
      ))}

      {working && !streamText.length && !streamThinking.length && !streamingTool && (
        <div className="mb-3 flex items-center gap-2 -mx-1.5 px-1.5 text-[13px]">
          <span className="relative flex size-3.5 items-center justify-center">
            <span className="absolute size-3.5 rounded-full bg-accent/30 animate-ping" />
            <span className="size-2 rounded-full bg-accent" />
          </span>
          <span className="text-shimmer">Working</span>
        </div>
      )}

      {failed && turn.finalText && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 select-text">
            <div className="whitespace-pre-wrap"><LinkedText text={turn.finalText} context={linkContext} citations /></div>
            {turn.detail && <AgentSaid text={turn.detail} />}
          </div>
        </div>
      )}

      {prefs.turnChanges && turn.completed && <TurnChanges changes={changes} cwd={cwd} linkContext={linkContext} checkpoint={checkpointTabId ? { sessionId, tabId: checkpointTabId, seq: turn.checkpointSeq ?? turn.seq } : undefined} />}

      {(turn.completed || !turn.live) && <TurnFooter turn={turn} outcome={foldable ? null : outcome} />}
    </div>
  );
}

/**
 * The agent's own last line under an error (#667): "update Codex" or "unauthorized (401)" without opening its terminal.
 * Plain text, already bounded and redacted by the runtime.
 */
function AgentSaid({ text }: { text: string }) {
  return (
    <p className="mt-1 break-words font-mono text-[12px] text-destructive/80" data-testid="agent-said">
      <span className="sr-only">The agent said: </span>
      {text}
    </p>
  );
}

/** What a folded turn still shows: the answer, and the reader's own words (#551). */
function outsideFold(item: WorkItem): boolean {
  return item.kind === "text" || item.kind === "message" || item.kind === "queued" || item.kind === "media";
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
 * A settled turn's one footer row: when the answer came, how the turn went
 * when no header said so, and a copy of the answer on hover.
 */
function TurnFooter({ turn, outcome }: { turn: Turn; outcome: Outcome | null }) {
  const answer = turn.work.flatMap((w) => (w.kind === "text" && w.text.trim() ? [w] : []));
  const ts = answer.at(-1)?.messageTs;
  const text = answer.map((w) => w.text).join("\n\n");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  const quiet = outcome?.tone === "ok";
  if (!messageTime(ts) && !outcome && !text) return null;
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-1.5 text-xs text-faint" data-testid="turn-footer">
      <MessageTime ts={ts} inline />
      {outcome && (
        <span className={cn("flex items-center gap-1.5", outcome.tone === "failed" && "text-destructive")}>
          {!quiet && <OutcomeIcon tone={outcome.tone} />}
          <span>{outcome.word}</span>
          {outcome.duration && <span className="-ml-1">{outcome.duration}</span>}
        </span>
      )}
      {text && (
          <button
            type="button"
            aria-label="Copy answer"
            title={copied ? "Copied" : "Copy answer"}
            onClick={() => void copyText(text).then(() => setCopied(true))}
            className="-my-1 flex size-6 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-veil-raised hover:text-foreground focus-visible:opacity-100 group-hover/turn:opacity-100"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
      )}
    </div>
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

function WorkRow({ item, cwd, linkContext, onSendQueuedNow, onSendAgain }: { item: WorkItem; cwd?: string; linkContext?: { sessionId: string; cwd: string }; onSendQueuedNow?: (seq: number) => void; onSendAgain?: (seq: number) => void }) {
  switch (item.kind) {
    case "text":
      return <div className="mb-3"><Markdown text={item.text} linkContext={linkContext} />{linkContext && <MentionedMedia text={item.text} linkContext={linkContext} />}</div>;
    case "reasoning":
      return <ReasoningRow name={item.key} text={item.text} linkContext={linkContext} />;
    case "tool":
      return <ToolCallRow call={item.call} cwd={cwd} linkContext={linkContext} />;
    case "tool_group":
      return <ToolGroupRow name={item.name} calls={item.calls} cwd={cwd} linkContext={linkContext} />;
    case "message":
      return <ReaderMessage message={item} cwd={cwd} linkContext={linkContext} className="my-3" onSendAgain={onSendAgain} />;
    case "queued":
      return (
        <div className="my-3 rounded-lg border border-dashed border-hairline-strong px-3 py-2 text-[13px] text-muted-foreground" data-testid="queued-message">
          <div className="flex items-center gap-2">
            <Clock className="size-3.5 shrink-0" />
            {item.author && <span data-user-id={item.author.userId}>{item.author.displayName}:</span>}
            <div className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere select-text"><LinkedText text={item.text} context={linkContext} /><MessageTime ts={item.messageTs} /></div>
            {onSendQueuedNow && !item.inputOccupied && !item.withdrawn && (
              <WithTooltip label="Interrupt the agent and send this now">
                <Button size="xs" variant="outline" className="shrink-0" onClick={() => onSendQueuedNow(item.seq)}>
                  <Send /> Send now
                </Button>
              </WithTooltip>
            )}
          </div>
          {item.inputOccupied && <InputOccupiedNote />}
          {item.withdrawn && <WithdrawnNote seq={item.seq} onSendAgain={onSendAgain} />}
        </div>
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
  const reporter = useRecoveryReporter();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, !!reporter?.active);
  useExposure({ reporter, surface: "error_row", present: true, reason: classifyRecovery(item.text), eventSeq: item.seq, inView });
  return (
    <div ref={ref} className="my-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 select-text">
        <span className="whitespace-pre-wrap"><LinkedText text={item.text} context={linkContext} /></span>
        {item.detail && <AgentSaid text={item.detail} />}
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
function WithdrawnNote({ seq, onSendAgain }: { seq?: number; onSendAgain?: (seq: number) => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-warning" data-testid="prompt-withdrawn">
      <CircleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Not sent: the agent was stopped before it took this message.</span>
      {onSendAgain && seq !== undefined && (
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
export function SendingMessage({ message, cwd }: { message: { text: string; images: { url: string; name?: string }[] }; cwd?: string }) {
  const layout = usePrefs().transcriptLayout;
  return (
    <div className="transcript-turn flow-root" data-testid="sending-message" aria-busy>
      <ReaderMessage message={message} cwd={cwd} className="mb-1 opacity-70" />
      <div role="status" className={cn("mb-4 flex px-1 text-[11px] text-muted-foreground", layout === "chat" && "justify-end")}>
        Sending…
      </div>
    </div>
  );
}

function ReaderMessage({
  message,
  cwd,
  linkContext,
  className,
  onSendAgain,
}: {
  message: { seq?: number; messageTs?: string; author?: { userId: string; displayName: string }; text: string; images?: { url: string; name?: string }[] } & Delivery;
  cwd?: string;
  linkContext?: { sessionId: string; cwd: string };
  className: string;
  onSendAgain?: (seq: number) => void;
}) {
  const layout = usePrefs().transcriptLayout;
  return (
    <div className={cn(className, "group/msg relative flex", layout === "chat" ? "justify-end" : "justify-stretch")} data-testid="reader-message">
      <div
        className={cn(
          "min-w-0 select-text whitespace-pre-wrap wrap-anywhere rounded-xl bg-card px-4 py-3 text-[14px] leading-relaxed",
          layout === "chat" ? "max-w-[85%]" : "w-full",
        )}
      >
        {message.images?.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.images.map((im, i) =>
              // A cloud tab's image is a file on its workspace, not here: its name, not a broken thumbnail.
              cwd || isLoadableUrl(im.url) ? (
                <img key={i} src={toAssetUrl(im.url)} alt="" className="size-20 rounded-md object-cover hairline" />
              ) : (
                <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-veil-raised px-2 py-1 text-xs text-muted-foreground" data-testid="prompt-image-name">
                  <ImageIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{im.name || "Image"}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
        {message.author && <div className="mb-1 text-xs text-muted-foreground" data-user-id={message.author.userId}>{message.author.displayName}</div>}
        <div className={cn((message.replaced || message.withdrawn) && "text-muted-foreground")}><LinkedText text={message.text} context={linkContext} /></div>
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
        {message.withdrawn && <WithdrawnNote seq={message.seq} onSendAgain={onSendAgain} />}
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
      </div>
      <HoverTime ts={message.messageTs} />
    </div>
  );
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
  const count = (value: number) => value < 1000 ? String(value) : `${Math.round(value / 1000)}k`;
  const label = (
    <>
      {status}{item.preTokens != null ? ` from ${count(item.preTokens)}` : ""}
      {item.postTokens != null ? ` to ${count(item.postTokens)} tokens` : ""}
    </>
  );
  if (!item.summary) {
    return (
      <div className="my-1 flex items-center gap-2 -mx-1.5 px-1.5 py-1 text-xs text-faint">
        <Shrink className="size-3.5" />
        {label}
      </div>
    );
  }
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md -mx-1.5 px-1.5 py-1 text-left text-xs text-faint hover:bg-veil-raised"
      >
        <Shrink className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{label}</span>
        <span className="shrink-0">{open ? "Hide summary" : "Show summary"}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div data-testid="compaction-summary" className="mb-2 ml-4.5 max-h-72 overflow-auto scrollbar-thin border-l border-hairline pl-3 text-xs leading-relaxed whitespace-pre-wrap text-faint select-text">
          <LinkedText text={item.summary} context={linkContext} />
        </div>
      )}
    </div>
  );
}

function ReasoningRow({ name, text, linkContext }: { name: string; text: string; linkContext?: { sessionId: string; cwd: string } }) {
  const [open, setOpen] = useDisclosure(name);
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div>
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md -mx-1.5 px-1.5 py-1 text-left text-[13px] text-thinking hover:bg-veil-raised"
      >
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-label={open ? "Collapse reasoning" : "Expand reasoning"}><Brain className="size-3.5 shrink-0" /></button>
        <span className="min-w-0 flex-1 truncate italic opacity-80">{open ? "Thinking" : <LinkedText text={first} context={linkContext} />}</span>
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-label={open ? "Collapse reasoning details" : "Expand reasoning details"}><ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} /></button>
      </div>
      {open && <div className="ml-4.5 mb-2 whitespace-pre-wrap text-[13px] italic text-thinking/90 select-text"><LinkedText text={text} context={linkContext} /></div>}
    </div>
  );
}

/** A URL the web view loads as it is, rather than a path on some computer. */
function isLoadableUrl(p: string): boolean {
  // `blob:`: a composer's own thumbnail, on a message drawn while it is being sent (#727).
  return p.startsWith("data:") || p.startsWith("blob:") || p.startsWith("http") || p.startsWith("asset:");
}

export function toAssetUrl(p: string): string {
  if (isLoadableUrl(p)) return p;
  try {
    return convertFileSrc(p);
  } catch {
    return p;
  }
}

/** The time above a turn that opens a new sitting: a hairline each side, the day and time between. */
function TurnDivider({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="mb-6 flex items-center gap-3 text-[11px] text-faint" data-testid="turn-divider">
      <span className="h-px flex-1 bg-hairline" />
      <span className="shrink-0">{label}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}
