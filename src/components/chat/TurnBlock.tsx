import { memo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Brain, Check, ChevronRight, CircleAlert, Clock, RefreshCw, Shrink, Users, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time";
import type { Turn, WorkItem } from "@/lib/transcript";
import type { StreamBlock } from "@/lib/agentEvents";
import { Markdown } from "./Markdown";
import { ToolCallRow, ToolGroupRow } from "./ToolCallRow";
import { usePrefs } from "@/lib/prefs";

/**
 * One exchange: the prompt, the work under it, the answer. Once the agent has
 * started answering, the tool calls fold behind one line (a setting), and a
 * settled turn's footer says how long it took.
 */
export const TurnBlock = memo(function TurnBlock({
  turn,
  cwd,
  stream,
  working,
  streamingTool,
}: {
  turn: Turn;
  cwd?: string;
  stream: StreamBlock[];
  working: boolean;
  streamingTool?: StreamBlock;
}) {
  const prefs = usePrefs();
  const layout = prefs.transcriptLayout;
  const [expanded, setExpanded] = useState(false);
  const hasAnswer = turn.work.some((w) => w.kind === "text");
  const toolItems = turn.work.filter((w) => w.kind === "tool" || w.kind === "tool_group" || w.kind === "reasoning" || w.kind === "subagent");
  const foldable = prefs.foldToolCalls && !turn.live && toolItems.length > 0 && (hasAnswer || turn.completed);
  const failed = turn.completed && turn.completed.status !== "ok";
  const streamText = stream.filter((s) => s.kind === "text" && s.text);
  const streamThinking = stream.filter((s) => s.kind === "thinking" && s.text && !s.done);

  return (
    <div className="transcript-turn" data-turn={turn.key}>
      {turn.prompt && (
        <div className={cn("mb-4 flex", layout === "chat" ? "justify-end" : "justify-stretch")}>
          <div
            className={cn(
              "select-text whitespace-pre-wrap rounded-xl bg-card px-4 py-3 text-[14px] leading-relaxed shadow-card hairline",
              layout === "chat" ? "max-w-[85%]" : "w-full",
            )}
          >
            {turn.prompt.images?.length ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {turn.prompt.images.map((im, i) => (
                  <img key={i} src={toAssetUrl(im.url)} alt="" className="size-20 rounded-md object-cover hairline" />
                ))}
              </div>
            ) : null}
            {turn.prompt.text}
          </div>
        </div>
      )}

      {foldable ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-veil-raised"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
            {summarize(turn)}
          </button>
          {expanded && (
            <div className="ml-1 mt-1 border-l border-hairline pl-2">
              {turn.work.map((w) => (w.kind === "text" ? null : <WorkRow key={w.key} item={w} cwd={cwd} />))}
            </div>
          )}
          {turn.work.map((w) => (w.kind === "text" ? <WorkRow key={w.key} item={w} cwd={cwd} /> : null))}
        </div>
      ) : (
        <div className="mb-3 space-y-0.5">
          {turn.work.map((w) => (
            <WorkRow key={w.key} item={w} cwd={cwd} />
          ))}
        </div>
      )}

      {streamThinking.map((s) => (
        <div key={`${s.ref.messageId}:${s.ref.index}`} className="mb-2 flex items-start gap-2 text-[13px] text-thinking">
          <Brain className="mt-1 size-3.5 shrink-0 animate-pulse-soft" />
          <div className="line-clamp-3 whitespace-pre-wrap italic opacity-80">{s.text.slice(-600)}</div>
        </div>
      ))}
      {streamingTool && (
        <div className="mb-1 flex items-center gap-2 px-1.5 py-1 text-[13px] text-muted-foreground">
          <span className="text-shimmer">{streamingTool.toolName ?? "Calling a tool"}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-faint">{previewFromPartialJson(streamingTool.partialJson)}</span>
        </div>
      )}
      {streamText.map((s) => (
        <Markdown key={`${s.ref.messageId}:${s.ref.index}`} text={s.text} streaming className="mb-3" />
      ))}

      {working && !streamText.length && !streamThinking.length && !streamingTool && (
        <div className="mb-3 flex items-center gap-2 px-1.5 text-[13px]">
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
          <div className="whitespace-pre-wrap select-text">{turn.finalText}</div>
        </div>
      )}

      {turn.completed && (
        <div className="mb-6 flex items-center gap-1.5 px-1.5 text-xs text-faint">
          {turn.completed.status === "ok" ? (
            <Check className="size-3.5" />
          ) : turn.completed.status === "aborted" ? (
            <X className="size-3.5" />
          ) : (
            <CircleAlert className="size-3.5 text-destructive" />
          )}
          {turn.completed.status === "aborted" ? "Stopped" : turn.completed.status === "ok" ? "Worked" : "Failed"}
          {turn.completed.durationMs != null && ` for ${formatDuration(turn.completed.durationMs)}`}
        </div>
      )}
    </div>
  );
});

function summarize(turn: Turn): string {
  const parts: string[] = [];
  if (turn.toolCount) parts.push(`${turn.toolCount} tool call${turn.toolCount === 1 ? "" : "s"}`);
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

function WorkRow({ item, cwd }: { item: WorkItem; cwd?: string }) {
  switch (item.kind) {
    case "text":
      return <Markdown text={item.text} className="mb-3" />;
    case "reasoning":
      return <ReasoningRow text={item.text} />;
    case "tool":
      return <ToolCallRow call={item.call} cwd={cwd} />;
    case "tool_group":
      return <ToolGroupRow name={item.name} calls={item.calls} cwd={cwd} />;
    case "queued":
      return (
        <div className="my-3 flex items-center gap-2 rounded-lg border border-dashed border-hairline-strong px-3 py-2 text-[13px] text-muted-foreground">
          <Clock className="size-3.5" />
          <span className="whitespace-pre-wrap">{item.text}</span>
        </div>
      );
    case "status":
      return <div className="px-1.5 py-1 text-xs text-faint">{item.text}</div>;
    case "error":
      return (
        <div className="my-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="whitespace-pre-wrap select-text">{item.text}</span>
        </div>
      );
    case "compaction":
      return (
        <div className="my-1 flex items-center gap-2 px-1.5 py-1 text-xs text-faint">
          <Shrink className="size-3.5" />
          Context compacted{item.preTokens ? ` from ${Math.round(item.preTokens / 1000)}k` : ""}
          {item.postTokens ? ` to ${Math.round(item.postTokens / 1000)}k tokens` : ""}
        </div>
      );
    case "retry":
      return (
        <div className="my-1 flex items-center gap-2 px-1.5 py-1 text-xs text-warning">
          <RefreshCw className="size-3.5 animate-spin" />
          Retrying ({item.attempt}/{item.maxRetries}){item.reason ? `: ${item.reason}` : ""}
        </div>
      );
    case "subagent":
      return (
        <div className="flex items-center gap-2 px-1.5 py-1 text-[13px] text-muted-foreground">
          <Users className="size-3.5" />
          <span className={cn(!item.done && "text-shimmer")}>{item.label ?? "Subagent"}</span>
          {item.done && <Check className="size-3.5 text-faint" />}
        </div>
      );
    case "decision":
      return (
        <div className={cn("px-1.5 py-0.5 text-xs", item.allowed ? "text-faint" : "text-destructive/80")}>
          {item.label}
        </div>
      );
  }
}

function ReasoningRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-thinking hover:bg-veil-raised"
      >
        <Brain className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate italic opacity-80">{open ? "Thinking" : first}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="ml-6 mb-2 whitespace-pre-wrap text-[13px] italic text-thinking/90 select-text">{text}</div>}
    </div>
  );
}

export function toAssetUrl(p: string): string {
  if (p.startsWith("data:") || p.startsWith("http") || p.startsWith("asset:")) return p;
  try {
    return convertFileSrc(p);
  } catch {
    return p;
  }
}
