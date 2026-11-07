import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArrowDown, ArrowUp } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import { TABLE_COLUMNS, type DashboardSort, type DashboardTableRow, type TableColumnId } from "@/lib/dashboard";
import type { PrAssociation } from "@/lib/api";

export interface SessionTableRow extends DashboardTableRow {
  prs: readonly PrAssociation[];
  additions: number | null;
  deletions: number | null;
}

export function SessionTable({ containerRef, rows, hiddenColumns, sort, onSort, selectedId, onFocus, onOpen, loading }: {
  containerRef: RefObject<HTMLDivElement | null>;
  rows: SessionTableRow[];
  hiddenColumns: TableColumnId[];
  sort: DashboardSort;
  onSort: (column: TableColumnId) => void;
  selectedId: string | null;
  onFocus: (id: string) => void;
  onOpen: (id: string) => void;
  loading: boolean;
}) {
  const columns = TABLE_COLUMNS.filter(({ id }) => !hiddenColumns.includes(id));
  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-auto scrollbar-thin px-4 pb-4">
      <table aria-label="Sessions" aria-busy={loading} className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
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
          {rows.map((row) => <Row key={row.id} row={row} columns={columns.map(({ id }) => id)} focused={selectedId === row.id} onFocus={() => onFocus(row.id)} onOpen={() => onOpen(row.id)} />)}
          {!rows.length && <tr><td colSpan={columns.length} className="p-8 text-center text-muted-foreground">{loading ? "Loading sessions…" : "No sessions match your search and filters."}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, columns, focused, onFocus, onOpen }: {
  row: SessionTableRow; columns: TableColumnId[]; focused: boolean; onFocus: () => void; onOpen: () => void;
}) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focused]);
  return (
    <tr ref={ref} tabIndex={0} aria-label={String(row.name)} onFocus={onFocus} onClick={() => { onFocus(); onOpen(); }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault(); event.stopPropagation(); onOpen();
        }
      }}
      data-session={row.id} data-focused={focused || undefined}
      className={cn("scroll-mt-10 cursor-default border-b border-border/50 outline-none hover:bg-selected/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50", focused && "bg-selected/50 ring-2 ring-inset ring-ring/50")}
    >
      {columns.map((column) => <td key={column} className={cn("max-w-64 truncate whitespace-nowrap px-3 py-2.5", column === "name" && "min-w-48 font-medium", (column === "branch" || column === "changes") && "font-mono")} title={row[column] === null ? undefined : String(row[column])}>{cell(row, column)}</td>)}
    </tr>
  );
}

function cell(row: SessionTableRow, column: TableColumnId): ReactNode {
  if (column === "pr") return row.prs.length ? row.prs.map((pr, index) => (
    <button key={pr.url} type="button" className="mr-2 text-foreground hover:underline" aria-label={`Open PR #${pr.number}`} title={pr.url}
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
