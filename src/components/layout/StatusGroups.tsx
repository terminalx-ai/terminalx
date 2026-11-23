import type { ReactNode } from "react";
import { ChevronDown, Plus } from "@/icons";
import { manualStatusLabel, type ManualStatus } from "@terminalx/portable/manualStatus";
import { ManualStatusIcon } from "@/components/session/ManualStatus";
import { Button } from "@/components/ui/button";
import { groupSessionsByStatus } from "@/lib/sidebarView";
import { RowActions, actionRow } from "./RowActions";
import { cn } from "@/lib/cn";
import { useFold } from "./useFold";

/** Sessions under one header per status (02.13). `onAdd` puts a + on each header, shown on hover, that starts a session. */
export function StatusGroups<T extends { manualStatus?: ManualStatus }>({ sessions, children, scope = "local", renderGroup, onAdd }: { sessions: T[]; children: (session: T) => ReactNode; scope?: string; renderGroup?: (sessions: T[], children: ReactNode) => ReactNode; onAdd?: () => void }) {
  return <>{groupSessionsByStatus(sessions).map((group) => <StatusGroup key={group.status} status={group.status} count={group.sessions.length} scope={scope} onAdd={onAdd}>
    {renderGroup ? renderGroup(group.sessions, group.sessions.map(children)) : group.sessions.map(children)}
  </StatusGroup>)}</>;
}

/** A status's header, chevron first, then its icon, name and count; its rows below. */
function StatusGroup({ status, count, scope, onAdd, children }: { status: ManualStatus; count: number; scope: string; onAdd?: () => void; children: ReactNode }) {
  const [open, toggle] = useFold(`status:${scope}:${status}`, true);
  const label = manualStatusLabel(status);
  return <li data-status-group={status}>
    <div className={cn(actionRow, "relative mt-2 flex h-7 min-w-0 items-center rounded-md pr-1")}>
      <button type="button" onClick={toggle} aria-expanded={open} aria-label={`${label} ${count}`} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <ChevronDown aria-hidden className={cn("size-3 shrink-0 text-faint transition-transform", !open && "-rotate-90")} />
        <ManualStatusIcon status={status} />
        <span className="truncate text-[12.5px] font-medium">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-faint">{count}</span>
      </button>
      {onAdd && <RowActions><Button variant="ghost" size="icon-xs" aria-label={`New session (${label})`} onClick={onAdd}><Plus /></Button></RowActions>}
    </div>
    {open && <ul className="flex flex-col [--indent:10px]">{children}</ul>}
  </li>;
}
