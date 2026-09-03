import { CircleDot, Link2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import type { Issue } from "@/lib/api";

/** The compact issue rendering shared by the Issues view and trigger preview. */
export function IssueListItem({
  issue,
  selected = false,
  linked = false,
  onSelect,
}: {
  issue: Issue;
  selected?: boolean;
  linked?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
        selected ? "bg-selected" : onSelect ? "hover:bg-selected/50" : "cursor-default",
      )}
    >
      <CircleDot className={cn("mt-0.5 size-3.5 shrink-0", issue.stateType === "started" ? "text-warning" : "text-add")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] text-faint">{issue.identifier}</span>
          <span className="truncate text-[13px] text-foreground">{issue.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
          <span>{issue.state}</span>
          {issue.labels.slice(0, 4).map((label) => (
            <span key={label.name} className="flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: label.color ? `#${label.color}` : "var(--ink-faint)" }} />
              {label.name}
            </span>
          ))}
          {issue.assignee && <span>· {issue.assignee.name}</span>}
          {issue.updatedAt && <span>· {relativeTime(issue.updatedAt)}</span>}
          {linked && <span className="flex items-center gap-1 text-info"><Link2 className="size-3" /> Session</span>}
        </div>
      </div>
    </button>
  );
}
