import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { ArrowDown, ArrowUp, Cloud, Laptop } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import { tableColumns, type DashboardSort, type DashboardTableRow, type TableColumnId } from "@/lib/dashboard";
import { MachineIcon } from "@/components/machines/connectionStatus";
import type { PairedMachine } from "@/types/machines";
import type { PrAssociation } from "@/lib/api";
import { SessionStatus } from "@/components/ui/SessionStatus";
import type { StatusSession } from "@/lib/sessionRowStatus";
import { AgentMark } from "@/components/AgentMark";
import { PersonFace } from "./OverviewToolbar";

/** Where a row's session runs, for the Where column's icon (PRO-346). */
export type SessionPlace = { kind: "local" } | { kind: "cloud" } | { kind: "machine"; machine: PairedMachine | null };

export interface SessionTableRow extends DashboardTableRow {
  session?: StatusSession;
  ownerCell?: ReactNode;
  locationCell?: ReactNode;
  place?: SessionPlace;
  prs: readonly PrAssociation[];
  additions: number | null;
  deletions: number | null;
  /** The harness of the session's first tab, for the agent's mark. */
  agentId?: string | null;
}
export interface SessionTableHandle { focusRow: (id: string) => void }
const ROW_HEIGHT = 44;
const COMPACT_ROW_HEIGHT = 36;
const HEADER_HEIGHT = 36;
const OVERSCAN = 6;
/**
 * Fixed widths for every column but the session's, which takes the rest. The
 * default set (02.01, 02.05) needs 864px plus the name's minimum, so it fits
 * the table's 1140px at a 1440-wide window with the sidebar open.
 */
const WIDTHS: Record<Exclude<TableColumnId, "name">, number> = { project: 120, where: 84, branch: 140, changes: 88, status: 196, agent: 116, pr: 80, owner: 60, updated: 60, created: 80 };
const NAME_MIN = 220;
const width = (id: TableColumnId) => id === "name" ? undefined : WIDTHS[id];

export function SessionTable({ containerRef, navigationRef, rows, hiddenColumns, sort, onSort, selectedId, onFocus, onOpen, loading, compact = false, where = false }: {
  containerRef: RefObject<HTMLDivElement | null>;
  navigationRef?: Ref<SessionTableHandle>;
  rows: SessionTableRow[];
  hiddenColumns: TableColumnId[];
  sort: DashboardSort;
  onSort: (column: TableColumnId) => void;
  selectedId: string | null;
  onFocus: (id: string) => void;
  onOpen: (id: string) => void;
  loading: boolean;
  compact?: boolean;
  /** Offer the Where column: a machine is paired. */
  where?: boolean;
}) {
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  const columns = useMemo(() => tableColumns(where).filter(({ id }) => !hiddenColumns.includes(id)), [hiddenColumns, where]);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const [focusRequest, requestFocus] = useState(0);
  const pendingFocus = useRef<string | null>(null);
  const selectedIndex = rows.findIndex((row) => row.id === selectedId);
  const virtual = rows.length > 80;
  const start = virtual ? Math.max(0, Math.min(rows.length - 1, Math.floor((viewport.top - HEADER_HEIGHT) / rowHeight) - OVERSCAN)) : 0;
  const end = virtual ? Math.min(rows.length, start + Math.ceil(viewport.height / rowHeight) + OVERSCAN * 2) : rows.length;
  const tabIndex = selectedIndex >= start && selectedIndex < end ? selectedIndex : start;
  const measure = () => {
    const element = containerRef.current;
    if (element) setViewport((previous) => {
      const next = { top: element.scrollTop, height: element.clientHeight || 480 };
      return previous.top === next.top && previous.height === next.height ? previous : next;
    });
  };
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [containerRef]);
  useImperativeHandle(navigationRef, () => ({ focusRow: (id) => {
    pendingFocus.current = id;
    requestFocus((value) => value + 1);
  } }), []);
  // Scroll before focusing. A row outside the rendered window is mounted on
  // the following render, so keyboard navigation can cross every window edge.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || selectedIndex < 0) return;
    const top = HEADER_HEIGHT + selectedIndex * rowHeight;
    const height = element.clientHeight || 480;
    if (top < element.scrollTop + HEADER_HEIGHT) element.scrollTop = top - HEADER_HEIGHT;
    else if (top + rowHeight > element.scrollTop + height) element.scrollTop = top + rowHeight - height;
    measure();
  }, [selectedId, selectedIndex, focusRequest, containerRef, rowHeight]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = [...(containerRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-session]") ?? [])].find((row) => row.dataset.session === pendingFocus.current);
    if (row) { row.focus({ preventScroll: true }); pendingFocus.current = null; }
  });
  return (
    <div ref={containerRef} onScroll={measure} className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-thin px-4 pb-4">
      <table aria-label="Sessions" aria-busy={loading} aria-rowcount={rows.length + 1} className="w-full table-fixed border-collapse text-left text-[13px]" style={{ minWidth: columns.reduce((sum, column) => sum + (width(column.id) ?? NAME_MIN), 0) }}>
        <colgroup>{columns.map(({ id }) => <col key={id} style={{ width: width(id) }} />)}</colgroup>
        <thead className="sticky top-0 z-10 bg-background">
          <tr style={{ height: HEADER_HEIGHT }} aria-rowindex={1}>
            {columns.map(({ id, label }) => (
              <th key={id} scope="col" aria-sort={sort.column === id ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className={cn("border-b border-hairline text-[11px] font-medium uppercase tracking-[.07em]", sort.column === id ? "text-muted-foreground" : "text-faint")}>
                <button type="button" onClick={() => onSort(id)} className="flex w-full items-center gap-1 whitespace-nowrap px-3 py-2 text-left uppercase hover:text-foreground focus-visible:outline focus-visible:outline-ring">
                  {label}
                  {sort.column === id && (sort.direction === "asc" ? <ArrowUp aria-hidden className="size-[11px]" /> : <ArrowDown aria-hidden className="size-[11px]" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: start * rowHeight, padding: 0, border: 0 }} /></tr>}
          {rows.slice(start, end).map((row, offset) => {
            const focused = selectedId === row.id;
            const tabbable = start + offset === tabIndex;
            return <tr key={row.id} tabIndex={tabbable ? 0 : -1} aria-rowindex={start + offset + 2}
              onFocus={() => onFocus(row.id)} onClick={() => { onFocus(row.id); onOpen(row.id); }}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault(); event.stopPropagation(); onOpen(row.id);
                }
              }}
              data-session={row.id} data-focused={focused || undefined} style={{ height: rowHeight }}
              className={cn("scroll-mt-9 cursor-default border-b border-hairline outline-none hover:bg-selected/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50", focused && "bg-selected/50 ring-2 ring-inset ring-ring/50")}
            >
              {columns.map(({ id }) => <td key={id} className={cn("truncate whitespace-nowrap px-3 py-0", id === "project" && "text-muted-foreground", (id === "branch" || id === "changes") && "font-mono text-[12px]", id === "branch" && "text-muted-foreground", id === "updated" && "text-[12px] text-faint")}
                title={id === "status" || id === "owner" || row[id] === null ? undefined : String(row[id])}>{cell(row, id, tabbable)}</td>)}
            </tr>;
          })}
          {end < rows.length && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: (rows.length - end) * rowHeight, padding: 0, border: 0 }} /></tr>}
          {!rows.length && <tr><td colSpan={columns.length} className="p-8 text-center text-muted-foreground">{loading ? "Loading sessions…" : "No sessions match your search and filters."}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function cell(row: SessionTableRow, column: TableColumnId, tabbable: boolean): ReactNode {
  if (column === "owner" && row.ownerCell) return row.ownerCell;
  if (column === "where" && row.locationCell) return row.locationCell;
  if (column === "name") return <span data-session-title className="block truncate">{row.name}</span>;
  // The session's own status, icon and label ('Checks failing · PR #781'). The
  // badge mounts only for visible rows, sharing the sidebar's cached status polling.
  if (column === "status") return row.session ? <SessionStatus session={row.session} className="max-w-full text-[12.5px] text-foreground" /> : row.status ?? <span className="text-faint">—</span>;
  if (column === "agent" && row.agent) return <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground" title={String(row.agent)}>
    {row.agentId && <AgentMark id={row.agentId} decorative className="size-[13px]" />}<span className="truncate">{row.agent}</span>
  </span>;
  if (column === "owner" && row.owner) return <span title={String(row.owner)} aria-label={String(row.owner)} role="img" className="inline-flex align-middle"><PersonFace name={String(row.owner)} /></span>;
  if (column === "pr") return row.prs.length ? row.prs.map((pr, index) => (
    <button key={pr.url} type="button" tabIndex={tabbable ? 0 : -1} className="mr-2 text-foreground hover:underline" aria-label={`Open PR #${pr.number}`} title={pr.url}
      onClick={(event) => {
        event.stopPropagation();
        // Only web links are valid PR destinations, including on enterprise hosts.
        if (/^https?:\/\//i.test(pr.url)) void openUrl(pr.url);
      }}
    >{index > 0 ? "· " : ""}#{pr.number}</button>
  )) : <span className="text-faint">—</span>;
  if (column === "where") {
    if (!row.where) return <span className="text-faint">—</span>;
    const icon = row.place?.kind === "machine" ? <MachineIcon machine={row.place.machine} className="size-[13px] shrink-0" />
      : row.place?.kind === "cloud" ? <Cloud aria-hidden className="size-[13px] shrink-0 text-info" />
      : <Laptop aria-hidden className="size-[13px] shrink-0" />;
    return <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">{icon}<span className="min-w-0 truncate">{row.where}</span></span>;
  }
  if (column === "changes" && row.changes !== null) return <span title="Workspace changes"><span className="text-add">+{row.additions}</span> <span className="text-del">−{row.deletions}</span></span>;
  if (column === "updated" || column === "created") {
    // Active is when the session last saw a message (else its last change).
    const value = String(row[column] ?? "");
    return Number.isFinite(Date.parse(value)) ? <time dateTime={value} title={new Date(value).toLocaleString()}>{relativeTime(value)}</time> : <span className="text-faint">—</span>;
  }
  return row[column] ?? <span className="text-faint">—</span>;
}
