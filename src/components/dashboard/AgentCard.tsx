import { useEffect, useRef, type ReactNode } from "react";
import { Archive, CircleDot, FolderOpen, GitBranch, MessageSquare, PanelsTopLeft, Square } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AgentMark, agentName as agentDisplayName } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { agent, errorMessage, type SessionSummary } from "@/lib/api";
import { archiveSession, selectSession } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { workspaceName, type ColumnId } from "@/lib/dashboard";
import type { Project, SessionEntry } from "@/types/session";

/**
 * One session as a card.
 *
 * The card answers "can I leave this alone?" without opening the session, so
 * it carries the last thing said in both directions — and, when the agent is
 * parked on a decision, what it is parked on instead of its last reply, which
 * by then is stale news.
 */
export function AgentCard({
  session,
  summary,
  column,
  project,
  agentName,
  focused,
  onFocus,
}: {
  session: SessionEntry;
  summary?: SessionSummary;
  column: ColumnId;
  project?: Project;
  agentName: string;
  focused: boolean;
  onFocus: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const harnesses = [...new Set(session.tabs.map((t) => t.harness))];
  const running = session.tabs.filter((t) => t.status === "in_progress");

  // The keyboard cursor lives in the dashboard; the card follows it into view.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const open = () => selectSession(session.id);
  const stop = () => {
    for (const t of running) {
      void agent.interrupt(session.id, t.id).catch((e) => console.error("stop failed", errorMessage(e)));
    }
  };

  return (
    <DropdownMenu>
      <div
        ref={ref}
        role="button"
        tabIndex={-1}
        aria-label={`${session.title}, ${harnesses.map(agentDisplayName).join(", ")}`}
        onClick={() => {
          onFocus();
          open();
        }}
        onFocus={onFocus}
        onKeyDown={(e) => e.key === "Enter" && open()}
        className={cn(
          "group relative flex cursor-default flex-col gap-1.5 overflow-hidden rounded-lg bg-card p-2.5 pl-3 text-left shadow-card outline-none hairline transition-colors hover:bg-selected/50",
          focused && "ring-2 ring-ring/50",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-2 bottom-2 w-0.5 rounded-full",
            column === "needs" && "bg-warning",
            column === "working" && "bg-info animate-pulse-soft",
            column === "done" && "bg-add",
          )}
        />

        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 -space-x-1 text-muted-foreground">
            {harnesses.map((h) => (
              <AgentMark key={h} id={h} className="size-4 rounded-full bg-background" decorative />
            ))}
          </div>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{session.title}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-faint group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0">
            {relativeTime(session.modified)}
          </span>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Session menu"
              className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[13px] leading-none">…</span>
            </Button>
          </DropdownMenuTrigger>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-veil-raised px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <GitBranch className="size-2.5 shrink-0" />
            <span className="truncate font-mono">{workspaceName(session)}</span>
          </span>
          {session.issue && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openUrl(session.issue!.url);
              }}
              title={session.issue.title}
              className="flex shrink-0 items-center gap-1 rounded-sm bg-veil-raised px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <CircleDot className="size-2.5" />
              <span className="font-mono">{session.issue.identifier}</span>
            </button>
          )}
        </div>

        <Snippet who="You" text={summary?.lastPrompt} icon={<MessageSquare className="size-3" />} />
        {column === "needs" ? (
          <Snippet who={agentName} text={summary?.waitingOn ?? summary?.lastReply} tone="warning" />
        ) : (
          <Snippet who={agentName} text={summary?.lastReply} />
        )}

        <div className="flex min-w-0 items-center gap-1.5 pt-0.5 text-[11px] text-faint">
          {project ? <ProjectGlyph project={project} size={12} /> : <FolderOpen className="size-3" />}
          <span className="min-w-0 truncate">{project?.name ?? session.projectPath.split("/").pop()}</span>
          {session.tabs.length > 1 && <span className="shrink-0">· {session.tabs.length} tabs</span>}
        </div>
      </div>

      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={open}>
          <PanelsTopLeft /> Open
        </DropdownMenuItem>
        {running.length > 0 && (
          <DropdownMenuItem onSelect={stop}>
            <Square /> Stop
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void archiveSession(session.id, true)}>
          <Archive /> Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One line of what was said: who said it, then as much as fits. */
function Snippet({ who, text, tone, icon }: { who: string; text?: string | null; tone?: "warning"; icon?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-snug">
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-faint">
        {icon}
        {who}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", tone === "warning" ? "text-warning" : "text-muted-foreground", !text && "text-faint")}>
        {text ?? "—"}
      </span>
    </div>
  );
}

/** What a card looks like before its snippets have been read off disk. */
export function AgentCardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 rounded-lg bg-card p-2.5 pl-3 shadow-card hairline">
      <div className="h-3 w-2/3 rounded-sm bg-veil-raised" />
      <div className="h-2.5 w-1/3 rounded-sm bg-veil-raised" />
      <div className="h-2.5 w-5/6 rounded-sm bg-veil-raised" />
      <div className="h-2.5 w-1/2 rounded-sm bg-veil-raised" />
    </div>
  );
}
