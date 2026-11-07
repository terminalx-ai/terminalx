import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { ArrowDown, ArrowUp } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import { TABLE_COLUMNS, type DashboardSort, type DashboardTableRow, type TableColumnId } from "@/lib/dashboard";
import type { PrAssociation } from "@/lib/api";
import { SessionStatus } from "@/components/ui/SessionStatus";
import type { StatusSession } from "@/lib/sessionRowStatus";

export interface SessionTableRow extends DashboardTableRow {
  session?: StatusSession;
  prs: readonly PrAssociation[];
  additions: number | null;
  deletions: number | null;
}
export interface SessionTableHandle { focusRow: (id: string) => void }
const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 40;
const OVERSCAN = 6;
const WIDTHS: Record<TableColumnId, number> = { status: 112, name: 240, project: 160, branch: 180, agent: 140, pr: 120, changes: 112, owner: 160, updated: 112, created: 112 };

export function SessionTable({ containerRef, navigationRef, rows, hiddenColumns, sort, onSort, selectedId, onFocus, onOpen, loading }: {
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
}) {
  const columns = useMemo(() => TABLE_COLUMNS.filter(({ id }) => !hiddenColumns.includes(id)), [hiddenColumns]);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const [focusRequest, requestFocus] = useState(0);
  const pendingFocus = useRef<string | null>(null);
  const selectedIndex = rows.findIndex((row) => row.id === selectedId);
  const virtual = rows.length > 80;
  const start = virtual ? Math.max(0, Math.min(rows.length - 1, Math.floor((viewport.top - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN)) : 0;
  const end = virtual ? Math.min(rows.length, start + Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN * 2) : rows.length;
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
    const top = HEADER_HEIGHT + selectedIndex * ROW_HEIGHT;
    const height = element.clientHeight || 480;
    if (top < element.scrollTop + HEADER_HEIGHT) element.scrollTop = top - HEADER_HEIGHT;
    else if (top + ROW_HEIGHT > element.scrollTop + height) element.scrollTop = top + ROW_HEIGHT - height;
    measure();
  }, [selectedId, selectedIndex, focusRequest, containerRef]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = [...(containerRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-session]") ?? [])].find((row) => row.dataset.session === pendingFocus.current);
    if (row) { row.focus({ preventScroll: true }); pendingFocus.current = null; }
  });
  return (
    <div ref={containerRef} onScroll={measure} className="min-h-0 flex-1 overflow-auto scrollbar-thin px-4 pb-4">
      <table aria-label="Sessions" aria-busy={loading} aria-rowcount={rows.length + 1} className="w-full table-fixed border-collapse text-left text-xs" style={{ minWidth: columns.reduce((sum, column) => sum + WIDTHS[column.id], 0) }}>
        <colgroup>{columns.map(({ id }) => <col key={id} style={{ width: WIDTHS[id] }} />)}</colgroup>
        <thead className="sticky top-0 z-10 bg-background">
          <tr style={{ height: HEADER_HEIGHT }} aria-rowindex={1}>
            {columns.map(({ id, label }) => (
              <th key={id} scope="col" aria-sort={sort.column === id ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="border-b border-border font-medium text-muted-foreground">
                <button type="button" onClick={() => onSort(id)} className="flex w-full items-center gap-1 whitespace-nowrap px-3 py-2.5 text-left hover:text-foreground focus-visible:outline focus-visible:outline-ring">
                  {label}
                  {sort.column === id && (sort.direction === "asc" ? <ArrowUp aria-hidden className="size-3" /> : <ArrowDown aria-hidden className="size-3" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: start * ROW_HEIGHT, padding: 0, border: 0 }} /></tr>}
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
              data-session={row.id} data-focused={focused || undefined} style={{ height: ROW_HEIGHT }}
              className={cn("scroll-mt-10 cursor-default border-b border-border/50 outline-none hover:bg-selected/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50", focused && "bg-selected/50 ring-2 ring-inset ring-ring/50")}
            >
              {columns.map(({ id }) => <td key={id} className={cn("truncate whitespace-nowrap px-3 py-2.5", id === "name" && "font-medium", (id === "branch" || id === "changes") && "font-mono")} title={row[id] === null ? undefined : String(row[id])}>{cell(row, id, tabbable)}</td>)}
            </tr>;
          })}
          {end < rows.length && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: (rows.length - end) * ROW_HEIGHT, padding: 0, border: 0 }} /></tr>}
          {!rows.length && <tr><td colSpan={columns.length} className="p-8 text-center text-muted-foreground">{loading ? "Loading sessions…" : "No sessions match your search and filters."}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function cell(row: SessionTableRow, column: TableColumnId, tabbable: boolean): ReactNode {
  // The workflow column keeps its grouping/sort meaning. The automatic badge
  // mounts only for visible rows, sharing the sidebar's cached status polling.
  if (column === "name") return <span className="flex min-w-0 items-center gap-2">
    <span data-session-title className="min-w-0 flex-1 truncate">{row.name}</span>
    {row.session && <SessionStatus session={row.session} className="max-w-[55%] shrink font-normal" />}
  </span>;
  if (column === "pr") return row.prs.length ? row.prs.map((pr, index) => (
    <button key={pr.url} type="button" tabIndex={tabbable ? 0 : -1} className="mr-2 text-foreground hover:underline" aria-label={`Open PR #${pr.number}`} title={pr.url}
      onClick={(event) => {
        event.stopPropagation();
        // Only web links are valid PR destinations, including on enterprise hosts.
        if (/^https?:\/\//i.test(pr.url)) void openUrl(pr.url);
      }}
    >{index > 0 ? "· " : ""}#{pr.number}</button>
  )) : <span className="text-faint">—</span>;
  if (column === "changes" && row.changes !== null) return <span title="Workspace changes"><span className="text-add">+{row.additions}</span> <span className="text-del">−{row.deletions}</span></span>;
  if (column === "updated" || column === "created") {
    const value = String(row[column] ?? "");
    return Number.isFinite(Date.parse(value)) ? <time dateTime={value} title={new Date(value).toLocaleString()}>{relativeTime(value)}</time> : <span className="text-faint">—</span>;
  }
  return row[column] ?? <span className="text-faint">—</span>;
}
