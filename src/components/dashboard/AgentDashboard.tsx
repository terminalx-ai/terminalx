import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ListFilter, Search, X } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { AgentCard, AgentCardSkeleton } from "@/components/dashboard/AgentCard";
import { useHotkey } from "@/lib/hotkeys";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { useSessionSummaries } from "@/lib/summaries";
import {
  bucketSessions,
  COLUMNS,
  DONE_PAGE,
  hasFilters,
  NO_FILTERS,
  toggleFilter,
  type Buckets,
  type ColumnId,
  type DashboardFilters,
} from "@/lib/dashboard";
import { cn } from "@/lib/cn";
import type { SessionEntry } from "@/types/session";

/**
 * Every session at once, in three columns: what needs the reader, what is
 * running, what is done. The sidebar answers "what is in this project"; this
 * answers "where should I be looking", which is a different question once more
 * than a couple of agents are working.
 *
 * The columns scroll on their own so the header and the three counts stay put,
 * and the page never scrolls sideways: under 760px of room — narrower than
 * three readable cards — they stack and the whole area scrolls instead.
 */
export function AgentDashboard() {
  const store = useSessionStore();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<DashboardFilters>(NO_FILTERS);
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
  const [cursor, setCursor] = useState<{ column: ColumnId; row: number } | null>(null);

  const live = useMemo(() => store.sessions.filter((s) => !s.archived && s.tabs.length > 0), [store.sessions]);
  const summaries = useSessionSummaries(live, store.loaded);

  const projectName = useCallback(
    (path: string) => store.projects.find((p) => p.path === path)?.name ?? path.replace(/\/+$/, "").split("/").pop() ?? path,
    [store.projects],
  );
  const buckets = useMemo(
    () => bucketSessions(store.sessions, { query, filters, projectName }),
    [store.sessions, query, filters, projectName],
  );
  // Only the done column is capped; the other two are meant to be read whole.
  const shown: Buckets = useMemo(
    () => ({ needs: buckets.needs, working: buckets.working, done: buckets.done.slice(0, doneLimit) }),
    [buckets, doneLimit],
  );

  // Agents to filter by: the ones actually in use, plus whatever is installed.
  const harnesses = useMemo(() => {
    const used = new Set(store.sessions.flatMap((s) => s.tabs.map((t) => t.harness)));
    for (const h of store.harnesses) if (h.available) used.add(h.id);
    return [...used].map((id) => ({ id, name: store.harnesses.find((h) => h.id === id)?.name ?? id }));
  }, [store.sessions, store.harnesses]);
  const agentName = useCallback(
    (s: SessionEntry) => {
      const tab = s.tabs.find((t) => t.id === s.activeTab) ?? s.tabs[0];
      if (!tab) return "Agent";
      return tab.title ?? store.harnesses.find((h) => h.id === tab.harness)?.name ?? tab.harness;
    },
    [store.harnesses],
  );

  // ---- keyboard: a cursor that walks the cards, Enter opens one.
  const at = useCallback(
    (column: ColumnId, row: number): SessionEntry | undefined => shown[column][row],
    [shown],
  );
  const move = useCallback(
    (dColumn: number, dRow: number) => {
      if (menuIsOpen()) return false; // an open menu owns the arrow keys
      setCursor((cur) => {
        const order = COLUMNS.map((c) => c.id);
        // No cursor, or one left stranded when its column emptied out.
        if (!cur || !shown[cur.column].length) {
          const first = order.find((id) => shown[id].length);
          return first ? { column: first, row: 0 } : null;
        }
        if (dRow) {
          const rows = shown[cur.column].length;
          return { column: cur.column, row: Math.min(rows - 1, Math.max(0, cur.row + dRow)) };
        }
        // Sideways lands on the nearest row of the next column that has cards.
        let i = order.indexOf(cur.column);
        for (let step = 0; step < order.length; step++) {
          i = Math.min(order.length - 1, Math.max(0, i + dColumn));
          const next = order[i];
          if (shown[next].length) return { column: next, row: Math.min(cur.row, shown[next].length - 1) };
          if (i === 0 || i === order.length - 1) break;
        }
        return cur;
      });
      return true;
    },
    [shown],
  );

  useHotkey("down", () => move(0, 1));
  useHotkey("up", () => move(0, -1));
  useHotkey("right", () => move(1, 0));
  useHotkey("left", () => move(-1, 0));
  useHotkey("enter", () => {
    if (menuIsOpen()) return false;
    const s = cursor && at(cursor.column, cursor.row);
    if (!s) return false; // nothing focused: let the chord fall through
    selectSession(s.id); // the same thing a click does; the store swaps the workspace over
    return true;
  });

  const total = live.length;
  const loading = !store.loaded || (summaries.loading && total > 0);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3 pt-1">
        <h1 className="text-[15px] font-semibold">Agents</h1>
        <span className="rounded-full bg-veil-raised px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">{total} total</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex h-7 items-center gap-1.5 rounded-md bg-well px-2">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
                e.stopPropagation();
              }}
              placeholder="Search sessions, workspaces or projects…"
              aria-label="Search sessions"
              className="w-56 bg-transparent text-xs outline-none placeholder:text-faint"
            />
            {query && (
              <button type="button" aria-label="Clear search" className="text-faint hover:text-foreground" onClick={() => setQuery("")}>
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant={hasFilters(filters) ? "secondary" : "ghost"} size="sm" className="gap-1.5">
                <ListFilter />
                Filter
                {hasFilters(filters) && (
                  <span className="rounded-full bg-accent/20 px-1.5 text-[10px] text-foreground tabular-nums">
                    {filters.projects.length + filters.harnesses.length + filters.columns.length}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              {store.projects.map((p) => (
                <DropdownMenuCheckboxItem
                  key={p.path}
                  checked={filters.projects.includes(p.path)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setFilters((f) => ({ ...f, projects: toggleFilter(f.projects, p.path) }))}
                >
                  <span className="truncate">{p.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Agent</DropdownMenuLabel>
              {harnesses.map((h) => (
                <DropdownMenuCheckboxItem
                  key={h.id}
                  checked={filters.harnesses.includes(h.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setFilters((f) => ({ ...f, harnesses: toggleFilter(f.harnesses, h.id) }))}
                >
                  <AgentMark id={h.id} decorative />
                  <span className="truncate">{h.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Status</DropdownMenuLabel>
              {COLUMNS.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={filters.columns.includes(c.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setFilters((f) => ({ ...f, columns: toggleFilter(f.columns, c.id) }))}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
              {hasFilters(filters) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setFilters(NO_FILTERS)}>
                    <X /> Clear filters
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 pb-4 @min-[760px]:overflow-hidden">
        <div className="flex flex-col gap-4 @min-[760px]:h-full @min-[760px]:flex-row @min-[760px]:gap-3">
          {COLUMNS.map((c) => (
            <Column key={c.id} id={c.id} label={c.label} count={buckets[c.id].length} loading={loading}>
              {shown[c.id].map((s, row) => (
                <AgentCard
                  key={s.id}
                  session={s}
                  summary={summaries.get(s.id)}
                  column={c.id}
                  project={store.projects.find((p) => p.path === s.projectPath)}
                  agentName={agentName(s)}
                  focused={cursor?.column === c.id && cursor.row === row}
                  onFocus={() => setCursor({ column: c.id, row })}
                />
              ))}
              {c.id === "done" && buckets.done.length > shown.done.length && (
                <Button variant="ghost" size="sm" className="w-full" onClick={() => setDoneLimit((n) => n + DONE_PAGE)}>
                  Show {Math.min(DONE_PAGE, buckets.done.length - shown.done.length)} more
                </Button>
              )}
            </Column>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A card menu or the filter menu takes the arrows and Enter for its own
 * navigation while it is open, so the cursor stands still and the chord falls
 * through to Radix.
 */
function menuIsOpen(): boolean {
  return typeof document !== "undefined" && !!document.querySelector('[role="menu"][data-state="open"]');
}

const EMPTY: Record<ColumnId, string> = {
  needs: "None",
  working: "Nothing running.",
  done: "Nothing finished yet.",
};

function Column({
  id,
  label,
  count,
  loading,
  children,
}: {
  id: ColumnId;
  label: string;
  count: number;
  loading: boolean;
  children: ReactNode;
}) {
  const empty = count === 0 && !loading;
  return (
    // Columns share the width evenly but never squeeze below a readable card;
    // below the breakpoint they stack and the whole area scrolls instead.
    <section aria-label={label} className="flex min-w-0 flex-col @min-[760px]:min-h-0 @min-[760px]:min-w-[220px] @min-[760px]:flex-1">
      <header className="flex shrink-0 items-center gap-1.5 px-1 pb-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            id === "needs" && "bg-warning",
            id === "working" && "bg-info",
            id === "done" && "bg-add",
          )}
        />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="rounded-full bg-veil-raised px-1.5 text-[10px] text-faint tabular-nums">{count}</span>
      </header>
      <div className="flex flex-col gap-1.5 pr-0.5 @min-[760px]:min-h-0 @min-[760px]:flex-1 @min-[760px]:overflow-y-auto scrollbar-thin">
        {loading && count === 0 ? (
          <>
            <AgentCardSkeleton />
            <AgentCardSkeleton />
          </>
        ) : empty ? (
          <div className="rounded-lg px-2 py-3 text-[12px] text-faint">{EMPTY[id]}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
