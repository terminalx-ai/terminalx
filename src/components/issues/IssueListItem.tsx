import { CircleDot, Link2 } from "@/icons";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import type { Issue } from "@/lib/api";
import { PipelineStatus } from "@/components/issues/IssuePipelinePanel";
import { AvatarStack } from "@/components/issues/People";
import type { IssuePipeline } from "@/types/issuePipeline";

/** The compact issue rendering shared by the Issues view and trigger preview. */
export function IssueListItem({
  issue,
  selected = false,
  linked = false,
  outOfFilter = null,
  pipeline = null,
  onSelect,
}: {
  issue: Issue;
  selected?: boolean;
  linked?: boolean;
  /** Why the issue, changed since the list was read, no longer matches its filter. It stays, dimmed, until the next refresh. */
  outOfFilter?: string | null;
  /** The issue's pipeline, when a session was started from it. */
  pipeline?: IssuePipeline | null;
  onSelect?: () => void;
}) {
  const assignees = issue.assignees ?? (issue.assignee ? [issue.assignee] : []);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      data-issue-row={`${issue.provider}:${issue.id}`}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30",
        selected ? "bg-selected" : onSelect ? "hover:bg-selected/50" : "cursor-default",
        outOfFilter && "opacity-60",
      )}
    >
      {/* A row that claims no state, for an issue its tracker no longer lists, gets no open-issue green. */}
      <CircleDot
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          !issue.state ? "text-faint" : issue.stateType === "started" ? "text-warning" : issue.stateType === "completed" ? "text-merged" : issue.stateType === "canceled" ? "text-faint" : "text-add",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] text-faint">{issue.identifier}</span>
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", outOfFilter ? "text-muted-foreground" : "text-foreground")}>{issue.title}</span>
          <AvatarStack people={assignees} avatarClassName="size-4" className="self-center" />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
          {issue.state && <span>{issue.state}</span>}
          {issue.labels.slice(0, 4).map((label) => (
            <span key={label.name} className="flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: label.color ? `#${label.color}` : "var(--ink-faint)" }} />
              {label.name}
            </span>
          ))}
          {outOfFilter && <span className="text-warning" title="It leaves the list on the next refresh.">{outOfFilter}</span>}
          {issue.updatedAt && <span>{issue.state ? "· " : ""}{relativeTime(issue.updatedAt)}</span>}
          {pipeline ? <PipelineStatus pipeline={pipeline} /> : linked && <span className="flex items-center gap-1 text-info"><Link2 className="size-3" /> Session</span>}
        </div>
      </div>
    </button>
  );
}
