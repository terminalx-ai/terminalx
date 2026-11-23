import { PresenceFaces, OwnerProfile, useTeamOverview } from "./TeamOverview";
import { ThisComputer } from "@/lib/platform";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Cloud, Laptop, Monitor, X } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { AgentCard, AgentCardSkeleton, CloudAgentCard, MachineAgentCard } from "@/components/dashboard/AgentCard";
import { MachineIcon, MachineStateMark } from "@/components/machines/connectionStatus";
import { useHotkey } from "@/lib/hotkeys";
import { openNewSession, selectSession, useSessionStore } from "@/lib/sessions";
import { useSessionSummaries } from "@/lib/summaries";
import {
  bucketSessions,
  COLUMNS,
  DASHBOARD_STATES,
  filterSessions,
  tableColumns,
  nextDashboardSort,
  sortDashboardRows,
  DONE_PAGE,
  hasFilters,
  NO_FILTERS,
  toggleFilter,
  type DashboardState,
  type DashboardFilters,
  type DashboardSort,
} from "@/lib/dashboard";
import { sessionStatus, statusText } from "@terminalx/portable/sessionStatus";
import { useAccount } from "@/lib/account";
import { usePref } from "@/lib/prefs";
import { DEFAULT_DASHBOARD_PREFERENCES } from "@terminalx/portable/dashboard";
import { loadRosterIn, usePeople, userIdForEmail } from "@/lib/cloudPeople";
import { useDashboardPrs } from "@/lib/dashboardPrs";
import { SessionTable, type SessionPlace, type SessionTableRow, type SessionTableHandle } from "./SessionTable";
import { ActiveNow, DisplayMenu, FilterChip, InclusionChip, NewSessionButton, PeopleChip, SearchField, SortChip, type OverviewPerson } from "./OverviewToolbar";
import { cn } from "@/lib/cn";
import { isCloudDashboardSession, openCloudSession, attentionTab, useCloudDashboard, type CloudDashboardSession } from "@/lib/cloudDashboard";
import { isMachineDashboardSession, machineAttentionTab, openMachineSession, useMachineDashboard, type MachineDashboardSession } from "@/lib/machineDashboard";
import { useMachineConnections } from "@/lib/machineConnections";
import { machineSectionKey } from "@/types/target";
import type { SessionEntry } from "@/types/session";
import { isQuickChat, QUICK_CHATS_LABEL } from "@/lib/quickChats";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
import { visibleDashboardSessions } from "@/lib/organizationSessions";
import { useSessionRowFacts } from "@/lib/sessionRowStatus";

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
  const searchRef = useRef<HTMLInputElement>(null);
  // Local sessions count as yours: under your cloud user id once a roster names it.
  const identity = useAccount().status.identity;
  const me = userIdForEmail(identity?.email);
  const catalog = useCloudCatalog();
  const localOwner = catalog.viewerUserId ?? me ?? "local";

  const cloud = useCloudDashboard(true);
  const { visibleIds, selectedOrganization } = useOrganizationVisibility();
  const visibleCloud = useMemo(() => visibleDashboardSessions(cloud, visibleIds, query), [cloud, visibleIds, query]);
  // Sessions on paired machines (PRO-346): none while no machine is paired.
  const machineSessions = useMachineDashboard(true);
  const { machines: pairedMachines, states: machineStates } = useMachineConnections();
  // The Where column and the All machines menu, only with a machine paired: otherwise the overview is as it was.
  const showWhere = pairedMachines.length > 0;
  const [placeChoice, setPlace] = useState<Place>("all");
  const place: Place = showWhere && (placeChoice === "all" || placeChoice === "local" || placeChoice === "cloud" || pairedMachines.some((m) => machineSectionKey(m.machineId) === placeChoice)) ? placeChoice : "all";
  const localFacts = useSessionRowFacts(store.sessions);
  const everywhere = useMemo<CardSession[]>(() => [
    ...store.sessions.map((session) => ({ ...session, ownerId: localOwner, rowStatus: localFacts[session.id] ?? session.rowStatus })),
    ...visibleCloud,
    ...(showWhere ? machineSessions : []),
  ], [store.sessions, visibleCloud, showWhere, machineSessions, localOwner, localFacts]);
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
  const archivedShown = (filters.archived ?? "hide") !== "hide";
  const summarySessions = useMemo(() => store.sessions.filter((s) => s.tabs.length && (!s.archived || archivedShown)), [store.sessions, archivedShown]);
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
    // The people filter is kept with the preferences, on this Mac.
    () => ({ ...filters, owners: preferences.owners, projects: filters.projects.includes(QUICK_CHATS_FILTER) ? [...filters.projects, ...quickPaths] : filters.projects }),
    [filters, quickPaths, preferences.owners],
  );
  const ownerIds = useMemo(() => [...new Set(sessions.flatMap((session) => session.ownerId ? [session.ownerId] : []))], [sessions]);
  // usePeople notifies on roster changes while keeping its resolver identity.
  const ownerNames = JSON.stringify(ownerIds.map((id) => [id, id === "local" || id === catalog.viewerUserId ? "You" : Object.values(catalog.orgs).flatMap((org) => org.workspaces).find((item) => item.workspace.createdBy === id)?.workspace.creator?.displayName ?? personName(id)]));
  const owners = useMemo(() => new Map<string, string>(JSON.parse(ownerNames)), [ownerNames]);
  const baseFiltered = useMemo(
    () => filterSessions(sessions, { query, filters: pathFilters, projectName }),
    [sessions, query, pathFilters, projectName],
  );
  const team = useTeamOverview(baseFiltered, selectedOrganization ?? null, owners);
  const hiddenWorkingAutomations = (filters.automations ?? "hide") === "hide" && bucketSessions(everywhere).working.some((session) => !!session.automation);
  const scoped = !!query.trim() || hasFilters(filters) || preferences.owners.length > 0 || place !== "all" || team.scoped || filters.automations === "only" || filters.archived === "only" || hiddenWorkingAutomations;
  const clearScope = () => {
    setQuery("");
    setFilters({ ...NO_FILTERS, automations: "show", archived: "show" });
    setPreferences({ ...preferences, owners: [] });
    setPlace("all");
    team.clearScope();
  };
  const filtered = team.rows;
  const buckets = useMemo(() => ({
    ...bucketSessions(filtered),
    archived: filtered.filter((s) => s.archived).sort((a, b) => b.modified.localeCompare(a.modified)),
  }), [filtered]);
  const archivedState = DASHBOARD_STATES.filter((state) => state.id === "archived");
  const boardColumns = filters.archived === "only" ? archivedState : filters.archived === "show" ? [...COLUMNS, ...archivedState] : COLUMNS;
  const shown = useMemo(() => ({ ...buckets, done: buckets.done.slice(0, doneLimit) }), [buckets, doneLimit]);
  // Everyone with a session here, and how recently they worked: the people picker and Active now.
  const people = useMemo<OverviewPerson[]>(() => [...owners].map(([id, name]) => {
    const theirs = sessions.filter((session) => session.ownerId === id && !session.archived);
    const activeAt = theirs.map((session) => session.lastMessageAt ?? session.modified).sort().at(-1) ?? null;
    return { id, name, you: id === localOwner, activeAt, working: theirs.some((session) => session.tabs.some((tab) => tab.status === "in_progress")) };
  }).sort((a, b) => Number(b.you) - Number(a.you) || a.name.localeCompare(b.name)), [owners, sessions, localOwner]);
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
      // The session's own status, as its badge reads it ('Checks failing · PR #781'), not the board's bucket.
      status: statusText(sessionStatus(session.rowStatus ?? session)),
      name: session.title,
      project: projectName(session.projectPath),
      ...(showWhere ? { where: isMachineDashboardSession(session) ? session.machineName : at.kind === "cloud" ? "Cloud" : ThisComputer, place: at } : {}),
      branch: session.worktreeRemoved ? session.removedWorkspace?.branch ?? null : session.branch ?? null,
      agent: [...new Set(session.tabs.map((tab) => harnessNames.get(tab.harness) ?? tab.harness))].join(", "),
      agentId: session.tabs[0]?.harness ?? null,
      pr: recorded[0]?.number ?? null,
      prs: recorded,
      additions, deletions,
      changes: additions === null || deletions === null ? null : additions + deletions,
      owner: session.ownerId ? owners.get(session.ownerId) ?? null : null,
      ownerCell: isCloudDashboardSession(session) ? (session.ownerId ? <OwnerProfile orgId={session.orgId} userId={session.ownerId} name={owners.get(session.ownerId) ?? "Owner unavailable"} /> : "Owner unavailable") : undefined,
      locationCell: isCloudDashboardSession(session) ? <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground"><Cloud aria-hidden className="size-[13px] shrink-0 text-info" /><span className="min-w-0 truncate">Cloud</span><PresenceFaces orgId={session.orgId} workspaceId={session.workspaceId} quiet /></span> : undefined,
      // A cloud row's last activity is its workspace's own lastActivityAt and nothing else:
      // absent or invalid stays unknown rather than borrowing another time (docs/PHASE2-PRESENCE-UI.md).
      updated: isCloudDashboardSession(session) ? cloudLastActive(catalog.orgs[session.orgId]?.workspaces.find((item) => item.workspace.id === session.workspaceId)?.workspace.lastActivityAt) : session.lastMessageAt ?? session.modified,
      created: session.created ?? null,
    };
  }), sort) : [], [filtered, workspaceByPath, harnessNames, prs, owners, projectName, sort, preferences.view, showWhere, machineById, catalog]);

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
  useHotkey("/", () => {
    if (menuIsOpen()) return false;
    searchRef.current?.focus();
    return true;
  });
  useHotkey("enter", (event) => {
    // Native buttons (sort, view, links) retain Enter even with a row selected.
    if (menuIsOpen() || (event.target instanceof Element && event.target.closest("button, a"))) return false;
    const candidates = preferences.view === "table" ? filtered : boardColumns.flatMap(({ id }) => shown[id]);
    const session = candidates.find((s) => s.id === cursor);
    if (!session) return false;
    openCard(session);
    return true;
  });

  const total = localLive.length + remoteLive.length + (archivedShown ? sessions.filter((s) => s.archived && s.tabs.length).length : 0);
  const loading = !store.loaded || (preferences.view === "board" && summaries.loading && total > 0);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-1.5 @min-[1100px]:flex-nowrap border-b border-hairline px-4 py-2.5">
        <SearchField inputRef={searchRef} query={query} onQuery={setQuery} />
        <PeopleChip people={people} selected={preferences.owners} onChange={(owners) => setPreferences({ ...preferences, owners })} />
        <InclusionChip kind="automations" value={filters.automations ?? "hide"} onChange={(automations) => setFilters((f) => ({ ...f, automations }))} />
        <InclusionChip kind="archived" value={filters.archived ?? "hide"} onChange={(archived) => setFilters((f) => ({ ...f, archived }))} />
        <SortChip sort={sort} columns={columns} onChange={(sort) => setPreferences({ ...preferences, sort })} />
        <DisplayMenu preferences={preferences} columns={columns} onChange={setPreferences} />
        {/* Where sessions run (PRO-346): only once a machine is paired. */}
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
            <PlaceItem label={ThisComputer} icon={<Laptop />} count={placeCounts.get("local") ?? 0} selected={place === "local"} onSelect={() => setPlace("local")} />
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
        <FilterChip count={filters.projects.length + filters.harnesses.length + filters.columns.length}>
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
              <DropdownMenuItem onSelect={() => setFilters((f) => ({ ...NO_FILTERS, automations: f.automations, archived: f.archived }))}>
                <X /> Clear filters
              </DropdownMenuItem>
            </>
          )}
        </FilterChip>
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 @min-[1100px]:shrink-0 @min-[1100px]:flex-nowrap">
          {[...visibleIds].map((orgId) => <PresenceFaces key={orgId} orgId={orgId} />)}
          {team.controls}
          <ActiveNow people={people} />
          <NewSessionButton onClick={() => openNewSession()} />
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[600px]:flex-row">
      {team.views}
      {preferences.view === "table" ? (
        <SessionTable navigationRef={tableNavigation} containerRef={tableRef} rows={tableRows} hiddenColumns={preferences.hiddenColumns} sort={sort} where={showWhere} compact={preferences.compact}
          onSort={(column) => setPreferences({ ...preferences, sort: nextDashboardSort(sort, column) })}
          selectedId={cursor} onFocus={setCursor}
          onOpen={(id) => {
            const session = filtered.find((s) => s.id === id);
            if (session) openCard(session);
          }}
          loading={loading}
        />
      ) : <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-thin px-4 pt-3 pb-4 @min-[1000px]:overflow-x-auto @min-[1000px]:overflow-y-hidden">
        <div className="flex flex-col gap-4 @min-[1000px]:h-full @min-[1000px]:flex-row @min-[1000px]:gap-3">
          {boardColumns.map((c) => (
            <Column key={c.id} id={c.id} label={c.label} count={buckets[c.id].length} loading={loading} clearScope={c.id === "working" && scoped ? clearScope : undefined}>
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
    </div>
  );
}

/** A workspace's reported last activity as the table's time, or null when it reports none. */
function cloudLastActive(at: number | null | undefined): string | null {
  return at == null || !Number.isFinite(new Date(at).getTime()) ? null : new Date(at).toISOString();
}

/** The All machines button's label: the choice, by name. */
function placeLabel(place: Place, machines: ReadonlyMap<string, { name: string }>): string {
  if (place === "all") return "All machines";
  if (place === "local") return ThisComputer;
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
  clearScope,
}: {
  id: DashboardState;
  label: string;
  count: number;
  loading: boolean;
  children: ReactNode;
  clearScope?: () => void;
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
          <div className="rounded-lg px-2 py-3 text-[12px] text-faint">{clearScope ? <>No running sessions in the current view. <button type="button" className="underline" onClick={clearScope}>Show all sessions</button></> : EMPTY[id]}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
