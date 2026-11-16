import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Cloud, Laptop, ListFilter, Monitor, Search, X } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { AgentCard, AgentCardSkeleton, CloudAgentCard, MachineAgentCard } from "@/components/dashboard/AgentCard";
import { MachineIcon, MachineStateMark } from "@/components/machines/connectionStatus";
import { useHotkey } from "@/lib/hotkeys";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { useSessionSummaries } from "@/lib/summaries";
import {
  bucketSessions,
  COLUMNS,
  DASHBOARD_STATES,
  filterSessions,
  tableColumns,
  toggleTableColumn,
  nextDashboardSort,
  sortDashboardRows,
  sessionColumn,
  DONE_PAGE,
  hasFilters,
  NO_FILTERS,
  toggleFilter,
  type DashboardState,
  type DashboardFilters,
  type DashboardSort,
} from "@/lib/dashboard";
import { usePref } from "@/lib/prefs";
import { DEFAULT_DASHBOARD_PREFERENCES } from "@terminalx/portable/dashboard";
import { loadRosterIn, usePeople } from "@/lib/cloudPeople";
import { useDashboardPrs } from "@/lib/dashboardPrs";
import { SessionTable, type SessionPlace, type SessionTableRow, type SessionTableHandle } from "./SessionTable";
import { cn } from "@/lib/cn";
import { isCloudDashboardSession, openCloudSession, attentionTab, useCloudDashboard, type CloudDashboardSession } from "@/lib/cloudDashboard";
import { isMachineDashboardSession, machineAttentionTab, openMachineSession, useMachineDashboard, useMachineDashboardEnabled, type MachineDashboardSession } from "@/lib/machineDashboard";
import { useMachineConnections } from "@/lib/machineConnections";
import { machineSectionKey } from "@/types/target";
import type { SessionEntry } from "@/types/session";
import { isQuickChat, QUICK_CHATS_LABEL } from "@/lib/quickChats";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
import { visibleDashboardSessions } from "@/lib/organizationSessions";

/** A card: a local session, a cloud one (PRO-23 CS-19) or one on a paired machine (PRO-346), in the same columns. */
type CardSession = (SessionEntry | CloudDashboardSession | MachineDashboardSession) & { ownerId?: string | null };

function openCard(session: CardSession) {
  // A cloud card opens its session on the tab that wants the reader, and only looks: nothing wakes it.
  if (isCloudDashboardSession(session)) openCloudSession(session.key, attentionTab(session)?.tabId);
  // A machine card opens its session in the machine's view.
  else if (isMachineDashboardSession(session)) openMachineSession(session.key);
  else selectSession(session.id);
}

/** The All machines menu's choice: every session, this Mac's, the cloud's, or one machine's (`machine:<id>`). */
type Place = "all" | "local" | "cloud" | `machine:${string}`;

function placeOf(session: CardSession): Exclude<Place, "all"> {
  if (isCloudDashboardSession(session)) return "cloud";
  if (isMachineDashboardSession(session)) return machineSectionKey(session.machineId);
  return "local";
}

/**
 * Every session at once: what needs the reader, what is running, what is done,
 * and what has not started. The sidebar answers "what is in this project"; this
 * answers "where should I be looking", which is a different question once more
 * than a couple of agents are working.
 *
 * The columns scroll on their own so the header and counts stay put,
 * and the page never scrolls sideways: under 1000px of room — narrower than
 * four readable cards — they stack and the whole area scrolls instead.
 */
/** The dashboard filter that stands for every quick chat: no project path can be this. */
const QUICK_CHATS_FILTER = "quick:";

export function AgentDashboard() {
  const store = useSessionStore();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<DashboardFilters>(NO_FILTERS);
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
  const tableRef = useRef<HTMLDivElement>(null);
  const tableNavigation = useRef<SessionTableHandle>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [preferences, setPreferences] = usePref("dashboard");
  const personName = usePeople(false);

  const cloud = useCloudDashboard(true);
  const { visibleIds } = useOrganizationVisibility();
  const visibleCloud = useMemo(() => visibleDashboardSessions(cloud, visibleIds, query), [cloud, visibleIds, query]);
  // Sessions on paired machines (PRO-346): none while Experimental → Machines is off.
  const machinesOn = useMachineDashboardEnabled();
  const machineSessions = useMachineDashboard(true);
  const { machines: pairedMachines, states: machineStates } = useMachineConnections();
  // The Where column and the All machines menu, only with Machines on and a machine paired: otherwise the overview is as it was.
  const showWhere = machinesOn && pairedMachines.length > 0;
  const [placeChoice, setPlace] = useState<Place>("all");
  const place: Place = showWhere && (placeChoice === "all" || placeChoice === "local" || placeChoice === "cloud" || pairedMachines.some((m) => machineSectionKey(m.machineId) === placeChoice)) ? placeChoice : "all";
  const everywhere = useMemo<CardSession[]>(() => [
    ...store.sessions.map((session) => ({ ...session, ownerId: "local" })),
    ...visibleCloud,
    ...(showWhere ? machineSessions : []),
  ], [store.sessions, visibleCloud, showWhere, machineSessions]);
  const sessions = useMemo(() => (place === "all" ? everywhere : everywhere.filter((session) => placeOf(session) === place)), [everywhere, place]);
  // The menu's counts: sessions with an agent that are not archived, wherever the other filters stand.
  const placeCounts = useMemo(() => {
    const counts = new Map<Place, number>();
    for (const session of everywhere) {
      if (session.archived || !session.tabs.length) continue;
      const at = placeOf(session);
      counts.set(at, (counts.get(at) ?? 0) + 1);
      counts.set("all", (counts.get("all") ?? 0) + 1);
    }
    return counts;
  }, [everywhere]);
  const hasCloud = visibleCloud.length > 0;
  const machineById = useMemo(() => new Map(pairedMachines.map((machine) => [machine.machineId, machine])), [pairedMachines]);
  const localLive = useMemo(() => sessions.filter((s) => !isCloudDashboardSession(s) && !isMachineDashboardSession(s) && !s.archived && s.tabs.length > 0), [sessions]);
  const summarySessions = useMemo(() => store.sessions.filter((s) => s.tabs.length && (!s.archived || filters.columns.includes("archived"))), [store.sessions, filters.columns]);
  const summaries = useSessionSummaries(summarySessions, store.loaded && preferences.view === "board");
  const remoteLive = useMemo(() => sessions.filter((s) => (isCloudDashboardSession(s) || isMachineDashboardSession(s)) && !s.archived && s.tabs.length > 0), [sessions]);
  // Cloud projects to filter by and name: `cloud:<orgId>:<identity>` → "acme/api · Acme".
  const cloudProjects = useMemo(() => {
    const names = new Map<string, string>();
    for (const s of visibleCloud) names.set(s.projectKey, `${s.projectName} · ${s.orgName}`);
    // A machine's projects the same way: `machine:<machineId>:<projectId>` → "terminalx · Mac mini".
    if (showWhere) for (const s of machineSessions) names.set(s.projectKey, `${s.projectName} · ${s.machineName}`);
    return names;
  }, [visibleCloud, showWhere, machineSessions]);

  // Quick chats have no project. They are named, searched and filtered as one group, under a key no path can be.
  const quickPaths = useMemo(() => new Set(store.sessions.filter(isQuickChat).map((s) => s.projectPath)), [store.sessions]);
  const hasQuickChats = store.sessions.some(isQuickChat);
  const projectName = useCallback(
    (path: string) => (quickPaths.has(path) ? QUICK_CHATS_LABEL : (cloudProjects.get(path) ?? store.projects.find((p) => p.path === path)?.name ?? path.replace(/\/+$/, "").split("/").pop() ?? path)),
    [store.projects, cloudProjects, quickPaths],
  );
  // The filter holds project paths; choosing "Quick chats" stands for every quick chat's own path.
  const pathFilters = useMemo(
    // The key itself stays in the list: with no quick chat left it still matches nothing, rather than turning the filter off.
    () => (filters.projects.includes(QUICK_CHATS_FILTER) ? { ...filters, projects: [...filters.projects, ...quickPaths] } : filters),
    [filters, quickPaths],
  );
  const filtered = useMemo(
    () => filterSessions(sessions, { query, filters: pathFilters, projectName }),
    [sessions, query, pathFilters, projectName],
  );
  const buckets = useMemo(() => ({
    ...bucketSessions(filtered),
    archived: filtered.filter((s) => s.archived).sort((a, b) => b.modified.localeCompare(a.modified)),
  }), [filtered]);
  const boardColumns = filters.columns.includes("archived") ? DASHBOARD_STATES.filter((state) => filters.columns.includes(state.id)) : COLUMNS;
  const shown = useMemo(() => ({ ...buckets, done: buckets.done.slice(0, doneLimit) }), [buckets, doneLimit]);
  const ownerIds = useMemo(() => [...new Set(sessions.flatMap((session) => session.ownerId ? [session.ownerId] : []))], [sessions]);
  // usePeople notifies on roster changes while keeping its resolver identity.
  const ownerNames = JSON.stringify(ownerIds.map((id) => [id, id === "local" ? "This Mac" : personName(id)]));
  const owners = useMemo(() => new Map<string, string>(JSON.parse(ownerNames)), [ownerNames]);
  const orgs = JSON.stringify([...new Set(visibleCloud.map((session) => session.orgId))].sort());
  useEffect(() => {
    for (const orgId of JSON.parse(orgs) as string[]) void loadRosterIn(orgId).catch(() => undefined);
  }, [orgs]);
  // Pull requests are this Mac's index: a machine's sessions are not in it.
  const prSessions = useMemo(() => filtered.filter((s) => !isMachineDashboardSession(s)), [filtered]);
  const prs = useDashboardPrs(prSessions, preferences.view === "table");
  const columns = tableColumns(showWhere);
  // A sort by Where while it is not offered falls back to the default.
  const sort: DashboardSort = !showWhere && preferences.sort.column === "where" ? DEFAULT_DASHBOARD_PREFERENCES.sort : preferences.sort;

  // Agents to filter by: the ones actually in use, plus whatever is installed.
  const harnesses = useMemo(() => {
    const used = new Set(sessions.flatMap((s) => s.tabs.map((t) => t.harness)));
    for (const h of store.harnesses) if (h.available) used.add(h.id);
    return [...used].map((id) => ({ id, name: store.harnesses.find((h) => h.id === id)?.name ?? id }));
  }, [sessions, store.harnesses]);
  const agentName = useCallback(
    (s: CardSession) => {
      const tab = isCloudDashboardSession(s) ? attentionTab(s) : isMachineDashboardSession(s) ? machineAttentionTab(s) : (s.tabs.find((t) => t.id === s.activeTab) ?? s.tabs[0]);
      if (!tab) return "Agent";
      return tab.title ?? store.harnesses.find((h) => h.id === tab.harness)?.name ?? tab.harness;
    },
    [store.harnesses],
  );

  const workspaceByPath = useMemo(() => new Map(Object.values(store.workspaces ?? {}).flat().map((workspace) => [workspace.path, workspace])), [store.workspaces]);
  const harnessNames = useMemo(() => new Map(store.harnesses.map((harness) => [harness.id, harness.name])), [store.harnesses]);
  const tableRows = useMemo<SessionTableRow[]>(() => preferences.view === "table" ? sortDashboardRows(filtered.map((session) => {
    const local = !isCloudDashboardSession(session) && !isMachineDashboardSession(session);
    const at: SessionPlace = isCloudDashboardSession(session) ? { kind: "cloud" }
      : isMachineDashboardSession(session) ? { kind: "machine", machine: machineById.get(session.machineId) ?? null } : { kind: "local" };
    const workspace = local && !session.worktreeRemoved ? workspaceByPath.get(session.cwd) : undefined;
    const recorded = [...(prs.get(session.id) ?? [])].sort((a, b) => a.number - b.number || a.url.localeCompare(b.url));
    const additions = workspace ? workspace.branchAdditions ?? workspace.additions : null;
    const deletions = workspace ? workspace.branchDeletions ?? workspace.deletions : null;
    return {
      id: session.id,
      session,
      status: DASHBOARD_STATES.find((state) => state.id === (session.archived ? "archived" : sessionColumn(session)))!.label,
      name: session.title,
      project: projectName(session.projectPath),
      ...(showWhere ? { where: isMachineDashboardSession(session) ? session.machineName : at.kind === "cloud" ? "Cloud" : "This Mac", place: at } : {}),
      branch: session.worktreeRemoved ? session.removedWorkspace?.branch ?? null : session.branch ?? null,
      agent: [...new Set(session.tabs.map((tab) => harnessNames.get(tab.harness) ?? tab.harness))].join(", "),
      pr: recorded[0]?.number ?? null,
      prs: recorded,
      additions, deletions,
      changes: additions === null || deletions === null ? null : additions + deletions,
      owner: session.ownerId ? owners.get(session.ownerId) ?? null : null,
      updated: session.modified,
      created: session.created ?? null,
    };
  }), sort) : [], [filtered, workspaceByPath, harnessNames, prs, owners, projectName, sort, preferences.view, showWhere, machineById]);

  // Keep selection by identity when rows reorder, filters change, or the view switches.
  const move = (dColumn: number, dRow: number) => {
    if (menuIsOpen()) return false;
    if (preferences.view === "table") {
      if (!dRow) return false;
      const index = tableRows.findIndex((row) => row.id === cursor);
      const next = index < 0 ? 0 : Math.max(0, Math.min(tableRows.length - 1, index + dRow));
      const id = tableRows[next]?.id ?? null;
      setCursor(id);
      if (id) tableNavigation.current?.focusRow(id);
      return true;
    }
    const currentColumn = boardColumns.find(({ id }) => shown[id].some((s) => s.id === cursor))?.id;
    if (!currentColumn) {
      setCursor(boardColumns.flatMap(({ id }) => shown[id])[0]?.id ?? null);
      return true;
    }
    const row = shown[currentColumn].findIndex((s) => s.id === cursor);
    if (dRow) setCursor(shown[currentColumn][Math.max(0, Math.min(shown[currentColumn].length - 1, row + dRow))]?.id ?? null);
    else {
      for (let i = boardColumns.findIndex(({ id }) => id === currentColumn) + dColumn; i >= 0 && i < boardColumns.length; i += dColumn) {
        const next = shown[boardColumns[i].id];
        if (next.length) { setCursor(next[Math.min(row, next.length - 1)].id); break; }
      }
    }
    return true;
  };
  useHotkey("down", () => move(0, 1));
  useHotkey("up", () => move(0, -1));
  useHotkey("right", () => move(1, 0));
  useHotkey("left", () => move(-1, 0));
  useHotkey("enter", (event) => {
    // Native buttons (sort, view, links) retain Enter even with a row selected.
    if (menuIsOpen() || (event.target instanceof Element && event.target.closest("button, a"))) return false;
    const candidates = preferences.view === "table" ? filtered : boardColumns.flatMap(({ id }) => shown[id]);
    const session = candidates.find((s) => s.id === cursor);
    if (!session) return false;
    openCard(session);
    return true;
  });

  const total = localLive.length + remoteLive.length + (filters.columns.includes("archived") ? sessions.filter((s) => s.archived && s.tabs.length).length : 0);
  const loading = !store.loaded || (preferences.view === "board" && summaries.loading && total > 0);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3 pt-1">
        <h1 className="text-[15px] font-semibold">Agents</h1>
        <span className="rounded-full bg-veil-raised px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">{total} total</span>
        <div role="group" aria-label="Dashboard view" className="flex items-center rounded-md bg-well p-0.5">
          {(["board", "table"] as const).map((view) => (
            <Button key={view} size="sm" variant={preferences.view === view ? "secondary" : "ghost"}
              aria-pressed={preferences.view === view} onClick={() => setPreferences({ ...preferences, view })}>
              {view === "board" ? "Board" : "Table"}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {showWhere && <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant={place === "all" ? "ghost" : "secondary"} size="sm" className="gap-1.5">
                <Monitor />
                {placeLabel(place, machineById)}
                <ChevronDown className="size-3 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <PlaceItem label="All machines" icon={<Monitor />} count={placeCounts.get("all") ?? 0} selected={place === "all"} onSelect={() => setPlace("all")} />
              <DropdownMenuSeparator />
              <PlaceItem label="This Mac" icon={<Laptop />} count={placeCounts.get("local") ?? 0} selected={place === "local"} onSelect={() => setPlace("local")} />
              {pairedMachines.map((machine) => {
                const key = machineSectionKey(machine.machineId);
                return (
                  <PlaceItem key={key} label={machine.name} icon={<MachineIcon machine={machine} />} count={placeCounts.get(key) ?? 0} selected={place === key} onSelect={() => setPlace(key)}
                    mark={<MachineStateMark state={machineStates[machine.machineId] ?? { state: "idle" }} />} />
                );
              })}
              {hasCloud && <PlaceItem label="Cloud" icon={<Cloud />} count={placeCounts.get("cloud") ?? 0} selected={place === "cloud"} onSelect={() => setPlace("cloud")} />}
            </DropdownMenuContent>
          </DropdownMenu>}
          {preferences.view === "table" && <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="sm">Columns</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              {columns.map(({ id, label }) => (
                <DropdownMenuCheckboxItem key={id}
                  checked={!preferences.hiddenColumns.includes(id)}
                  disabled={!preferences.hiddenColumns.includes(id) && columns.every((column) => column.id === id || preferences.hiddenColumns.includes(column.id))}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setPreferences({ ...preferences, hiddenColumns: toggleTableColumn(preferences.hiddenColumns, id, columns) })}>
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>}

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
                    {filters.projects.length + filters.harnesses.length + filters.columns.length + (filters.owners?.length ?? 0) + Number(!!filters.automated)}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-(--radix-dropdown-menu-content-available-height) w-56 overflow-y-auto scrollbar-thin">
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              {hasQuickChats && (
                <DropdownMenuCheckboxItem
                  checked={filters.projects.includes(QUICK_CHATS_FILTER)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setFilters((f) => ({ ...f, projects: toggleFilter(f.projects, QUICK_CHATS_FILTER) }))}
                >
                  <span className="truncate">{QUICK_CHATS_LABEL}</span>
                </DropdownMenuCheckboxItem>
              )}
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
              {[...cloudProjects].map(([key, name]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={filters.projects.includes(key)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setFilters((f) => ({ ...f, projects: toggleFilter(f.projects, key) }))}
                >
                  <span className="truncate">{name}</span>
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
              {DASHBOARD_STATES.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={filters.columns.includes(c.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setFilters((f) => ({ ...f, columns: toggleFilter(f.columns, c.id) }))}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={!!filters.automated} onSelect={(e) => e.preventDefault()}
                onCheckedChange={(automated) => setFilters((f) => ({ ...f, automated: automated === true }))}>
                Started by automation
              </DropdownMenuCheckboxItem>
              {owners.size > 0 && <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Owner</DropdownMenuLabel>
                {[...owners].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => (
                  <DropdownMenuCheckboxItem key={id} checked={!!filters.owners?.includes(id)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => setFilters((f) => ({ ...f, owners: toggleFilter(f.owners ?? [], id) }))}>
                    <span className="truncate" title={name}>{name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </>}
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

      {preferences.view === "table" ? (
        <SessionTable navigationRef={tableNavigation} containerRef={tableRef} rows={tableRows} hiddenColumns={preferences.hiddenColumns} sort={sort} where={showWhere}
          onSort={(column) => setPreferences({ ...preferences, sort: nextDashboardSort(sort, column) })}
          selectedId={cursor} onFocus={setCursor}
          onOpen={(id) => {
            const session = filtered.find((s) => s.id === id);
            if (session) openCard(session);
          }}
          loading={loading}
        />
      ) : <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 pb-4 @min-[1000px]:overflow-x-auto @min-[1000px]:overflow-y-hidden">
        <div className="flex flex-col gap-4 @min-[1000px]:h-full @min-[1000px]:flex-row @min-[1000px]:gap-3">
          {boardColumns.map((c) => (
            <Column key={c.id} id={c.id} label={c.label} count={buckets[c.id].length} loading={loading}>
              {shown[c.id].map((s) =>
                isMachineDashboardSession(s) ? (
                  <MachineAgentCard
                    key={s.id}
                    session={s}
                    machine={machineById.get(s.machineId) ?? null}
                    column={c.id}
                    agentName={agentName(s)}
                    focused={cursor === s.id}
                    onFocus={() => setCursor(s.id)}
                    onOpen={() => openCard(s)}
                  />
                ) : isCloudDashboardSession(s) ? (
                  <CloudAgentCard
                    key={s.id}
                    session={s}
                    column={c.id}
                    agentName={agentName(s)}
                    focused={cursor === s.id}
                    onFocus={() => setCursor(s.id)}
                    onOpen={() => openCard(s)}
                  />
                ) : (
                  <AgentCard
                    key={s.id}
                    session={s}
                    summary={summaries.get(s.id)}
                    column={c.id}
                    project={store.projects.find((p) => p.path === s.projectPath)}
                    agentName={agentName(s)}
                    focused={cursor === s.id}
                    onFocus={() => setCursor(s.id)}
                  />
                ),
              )}
              {c.id === "done" && buckets.done.length > shown.done.length && (
                <Button variant="ghost" size="sm" className="w-full shrink-0" onClick={() => setDoneLimit((n) => n + DONE_PAGE)}>
                  Show {Math.min(DONE_PAGE, buckets.done.length - shown.done.length)} more
                </Button>
              )}
            </Column>
          ))}
        </div>
      </div>}
    </div>
  );
}

/** The All machines button's label: the choice, by name. */
function placeLabel(place: Place, machines: ReadonlyMap<string, { name: string }>): string {
  if (place === "all") return "All machines";
  if (place === "local") return "This Mac";
  if (place === "cloud") return "Cloud";
  return machines.get(place.slice("machine:".length))?.name ?? "All machines";
}

/** One choice in the All machines menu: icon, name, state mark for a machine, and its session count. */
function PlaceItem({ label, icon, mark, count, selected, onSelect }: { label: string; icon: ReactNode; mark?: ReactNode; count: number; selected: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect} aria-current={selected || undefined} data-place-count={count}>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {mark}
      <span className="ml-auto flex items-center gap-1.5 text-[11px] text-faint tabular-nums">
        {count}
        <Check aria-hidden className={cn("size-3.5", !selected && "invisible")} />
      </span>
    </DropdownMenuItem>
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

const EMPTY: Record<DashboardState, string> = {
  archived: "No archived sessions.",
  needs: "None",
  working: "Nothing running.",
  done: "Nothing finished yet.",
  "not-started": "No chats waiting to start.",
};

function Column({
  id,
  label,
  count,
  loading,
  children,
}: {
  id: DashboardState;
  label: string;
  count: number;
  loading: boolean;
  children: ReactNode;
}) {
  const empty = count === 0 && !loading;
  return (
    // Columns share the width evenly but never squeeze below a readable card;
    // below the breakpoint they stack and the whole area scrolls instead.
    <section aria-label={label} className="flex min-w-0 flex-col @min-[1000px]:min-h-0 @min-[1000px]:min-w-[220px] @min-[1000px]:flex-1">
      <header className="flex shrink-0 items-center gap-1.5 px-1 pb-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            id === "needs" && "bg-warning",
            id === "working" && "bg-info",
            id === "done" && "bg-add",
            (id === "not-started" || id === "archived") && "bg-faint",
          )}
        />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="rounded-full bg-veil-raised px-1.5 text-[10px] text-faint tabular-nums">{count}</span>
      </header>
      <div className="flex flex-col gap-1.5 pr-0.5 @min-[1000px]:min-h-0 @min-[1000px]:flex-1 @min-[1000px]:overflow-y-auto scrollbar-thin">
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
