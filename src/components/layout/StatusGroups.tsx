import type { ReactNode } from "react";
import { ChevronDown } from "@/icons";
import { manualStatusLabel, type ManualStatus } from "@terminalx/portable/manualStatus";
import { ManualStatusIcon } from "@/components/session/ManualStatus";
import { groupSessionsByStatus } from "@/lib/sidebarView";
import { cn } from "@/lib/cn";
import { useFold } from "./useFold";

export function StatusGroups<T extends { manualStatus?: ManualStatus }>({ sessions, children, scope = "local", renderGroup }: { sessions: T[]; children: (session: T) => ReactNode; scope?: string; renderGroup?: (sessions: T[], children: ReactNode) => ReactNode }) {
  return <>{groupSessionsByStatus(sessions).map((group) => <StatusGroup key={group.status} status={group.status} count={group.sessions.length} scope={scope}>
    {renderGroup ? renderGroup(group.sessions, group.sessions.map(children)) : group.sessions.map(children)}
  </StatusGroup>)}</>;
}

function StatusGroup({ status, count, scope, children }: { status: ManualStatus; count: number; scope: string; children: ReactNode }) {
  const [open, toggle] = useFold(`status:${scope}:${status}`, true);
  return <li data-status-group={status}>
    <button type="button" onClick={toggle} aria-expanded={open} aria-label={`${manualStatusLabel(status)} ${count}`} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40">
      <ManualStatusIcon status={status} /><span className="flex-1">{manualStatusLabel(status)}</span><span className="tabular-nums">{count}</span><ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
    </button>
    {open && <ul className="mb-2 flex flex-col gap-px">{children}</ul>}
  </li>;
}
