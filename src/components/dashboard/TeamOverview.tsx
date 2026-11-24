import { useEffect, useMemo, useState } from "react";
import { thisComputer } from "@/lib/platform";
import { useAccount } from "@/lib/account";
import { phase2Ready } from "@/lib/phase2Readiness";
import { useCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";
import { cloudPresence, useCloudPresence, useCloudPresenceVersion } from "@/lib/cloudPresence";
import { loadRosterIn } from "@/lib/cloudPeople";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { useOrganizationRoster } from "@/lib/organizationRoster";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { MemberProfile } from "@/components/people/MemberProfile";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import type { PresencePerson } from "@/lib/api";

export type TeamView = "everyone" | "mine" | "shared" | "following" | "active";
export const TEAM_VIEWS: { id: TeamView; label: string }[] = [{ id: "everyone", label: "Everyone" }, { id: "mine", label: "Mine" }, { id: "shared", label: "Shared with me" }, { id: "following", label: "Following" }, { id: "active", label: "Active now" }];
export interface TeamRow { id: string; ownerId?: string | null; orgId?: string; workspaceId?: string }
/** Same authorized dataset for rows and counts. Local ownership is presentation only. */
export function teamPredicate(row: TeamRow, view: TeamView, catalog: CloudCatalogState, active: (org: string, workspace: string) => boolean) {
  const local = !row.orgId || !row.workspaceId;
  const org = row.orgId ? catalog.orgs[row.orgId] : undefined;
  const item = org?.source === "live" && !org.error ? org.workspaces.find((item) => item.workspace.id === row.workspaceId) : undefined;
  const mine = local || (!!catalog.viewerUserId && item?.workspace.createdBy === catalog.viewerUserId);
  switch (view) {
    case "everyone": return true;
    case "mine": return mine;
    case "following": return item?.following === true;
    case "shared": return !!item && !mine && !!catalog.viewerUserId && (item.workspace.you?.role === "viewer" || item.workspace.you?.role === "driver");
    case "active": return !local && !!item && active(row.orgId!, row.workspaceId!);
  }
}
export function ownerStorageKey(account: string, org: string) { return `terminalx.overview.by.v1:${encodeURIComponent(account)}:${encodeURIComponent(org)}`; }
export function readOwners(key: string | null): string[] {
  if (!key) return [];
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length <= 128))] : []; } catch { return []; }
}
export function useTeamOverview<T extends TeamRow>(rows: T[], orgId: string | null, rowOwners: Map<string, string>) {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const catalog = useCloudCatalog();
  useCloudPresenceVersion();
  const account = !privacy.enabled && status.state === "signed-in" ? status.context?.account : null;
  const key = account && orgId ? ownerStorageKey(account, orgId) : null;
  const peopleScope = account && orgId ? `${account}:${status.context?.revision}:${orgId}` : null;
  const rosterState = useOrganizationRoster(orgId, !!account && !!orgId);
  const [people, setPeople] = useState<{ scope: string | null; members: OrganizationMember[] }>({ scope: null, members: [] });
  const authorized = !!orgId && catalog.orgs[orgId]?.source === "live" && !catalog.orgs[orgId]?.error;
  useEffect(() => {
    let current = true;
    if (peopleScope && orgId && authorized) void loadRosterIn(orgId).then((members) => {
      if (current) setPeople({ scope: peopleScope, members });
    }).catch(() => {});
    return () => { current = false; };
  }, [peopleScope, orgId, authorized]);
  const members = rosterState.error ? null : rosterState.roster?.members ?? (people.scope === peopleScope ? people.members : null);
  const owners = new Map(rowOwners);
  if (authorized) for (const member of members ?? []) owners.set(member.userId, member.userId === catalog.viewerUserId ? "You" : member.displayName || member.email || `User ${member.userId.slice(0, 8)}`);
  const saved = useMemo(() => readOwners(key), [key]);
  const [selection, setSelection] = useState({ key, ids: saved });
  const [peopleQuery, setPeopleQuery] = useState("");
  const [chosenView, setView] = useState<{ key: string | null; view: TeamView }>({ key, view: "everyone" });
  // Render from the new scope immediately, before effects, including A -> B -> A.
  const selected = selection.key === key ? selection.ids : saved;
  const followReady = (org: string) => !privacy.enabled && phase2Ready(status, org, "followReassign");
  const preferredView = chosenView.key === key ? chosenView.view : "everyone";
  const view = preferredView === "following" && (!orgId || !followReady(orgId)) ? "everyone" : preferredView;
  const choose = (ids: string[]) => {
    setSelection({ key, ids });
    if (key) try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* This Mac's filter still works in memory. */ }
  };
  const visibleOwners = JSON.stringify([...owners.keys()].sort());
  useEffect(() => {
    if (!key) return;
    // Prune only after an authorized catalog has answered. Loading is not revocation.
    if (catalog.orgs[orgId!]?.source !== "live" || catalog.orgs[orgId!]?.error || members === null) return;
    const current = (selection.key === key ? selection.ids : saved).filter((id) => owners.has(id));
    setSelection((previous) => previous.key === key && JSON.stringify(previous.ids) === JSON.stringify(current) ? previous : { key, ids: current });
    try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Filter stays account/org scoped. */ }
  }, [key, orgId, visibleOwners, catalog.orgs, selection, saved, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = (org: string, workspace: string) => {
    const presence = cloudPresence.snapshot(org);
    return presence.state === "live" && presence.workspaces.some((row) => row.workspaceId === workspace && row.activeMembers.length > 0);
  };
  const byRows = rows.filter((row) => !selected.length || selected.includes(!row.orgId ? catalog.viewerUserId ?? "local" : row.ownerId ?? ""));
  const matches = (row: TeamRow, candidate: TeamView) =>
    (candidate !== "following" || (!!row.orgId && followReady(row.orgId))) && teamPredicate(row, candidate, catalog, active);
  const counts = Object.fromEntries(TEAM_VIEWS.map(({ id }) => [id, byRows.filter((row) => matches(row, id)).length])) as Record<TeamView, number>;
  const filtered = byRows.filter((row) => matches(row, view));
  const cloudRows = byRows.filter((row) => row.orgId && row.workspaceId);
  const fact = (row: TeamRow) => {
    const org = catalog.orgs[row.orgId!];
    return org?.source === "live" && !org.error ? org.workspaces.find((item) => item.workspace.id === row.workspaceId) : undefined;
  };
  const known: Record<TeamView, boolean> = {
    everyone: true,
    mine: !cloudRows.length || (!!catalog.viewerUserId && cloudRows.every((row) => {
      const owner = fact(row)?.workspace.createdBy;
      return typeof owner === "string" && owner.length > 0;
    })),
    shared: !cloudRows.length || (!!catalog.viewerUserId && cloudRows.every((row) => { const item = fact(row); return !!item && (item.workspace.createdBy === catalog.viewerUserId || !!item.workspace.you); })),
    following: !!orgId && followReady(orgId) && cloudRows.every((row) => followReady(row.orgId!) && typeof fact(row)?.following === "boolean"),
    active: cloudRows.every((row) => {
      const presence = cloudPresence.snapshot(row.orgId!);
      return !!fact(row) && presence.state === "live" && presence.workspaces.some((workspace) => workspace.workspaceId === row.workspaceId);
    }),
  };
  const controls = <>
    <DropdownMenu onOpenChange={(open) => { if (!open) setPeopleQuery(""); }}><DropdownMenuTrigger asChild><Button variant={selected.length ? "secondary" : "ghost"} size="sm">{selected.length ? `By ${selected.length} ${selected.length === 1 ? "person" : "people"}` : "By Anyone"}</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64"><DropdownMenuLabel>Filter people</DropdownMenuLabel>
        <input aria-label="Filter people" placeholder="Filter people" value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }} className="mx-2 mb-2 w-[calc(100%-1rem)] rounded bg-well px-2 py-1 text-xs" />
        <DropdownMenuItem onSelect={() => choose([])}>Anyone</DropdownMenuItem>
        {[...owners].filter(([, name]) => name.toLowerCase().includes(peopleQuery.toLowerCase())).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <DropdownMenuCheckboxItem key={id} checked={selected.includes(id)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => choose(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id])}>{name}</DropdownMenuCheckboxItem>)}
        <p className="px-2 py-2 text-[10px] text-muted-foreground">Owner filter is saved on {thisComputer}. Local sessions count as yours.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
  const views = <nav aria-label="Views" className="flex w-full shrink-0 flex-wrap gap-1 border-b border-border px-2 pb-3 @min-[600px]:w-44 @min-[600px]:flex-col @min-[600px]:flex-nowrap @min-[600px]:border-b-0 @min-[600px]:border-r"><span className="w-full px-2 py-2 text-[10px] uppercase text-faint">Views</span>{TEAM_VIEWS.map(({ id, label }) => <Button key={id} size="sm" variant={view === id ? "secondary" : "ghost"} className="min-w-0 justify-start gap-2" aria-pressed={view === id} disabled={!known[id]} title={known[id] ? undefined : "Current authorized data is unavailable"} onClick={() => setView({ key, view: id })}>{label}<span className="ml-auto text-faint tabular-nums">{known[id] ? counts[id] : "—"}</span></Button>)}{!known[view] && <p role="status" className="px-2 py-1 text-xs text-faint">Current {view === "active" ? "presence" : "workspace data"} is unavailable. Refresh or choose Everyone.</p>}</nav>;
  return { rows: filtered, controls, views, scoped: view !== "everyone" || selected.length > 0, clearScope: () => { setView({ key, view: "everyone" }); choose([]); } };
}

/** Reuse PRO-128's current roster and profile. Missing roles/emails stay unavailable. */
/** `quiet` renders nothing unless presence is live and someone is there (a table cell beside other text). */
export function PresenceFaces({ orgId, workspaceId, othersOnly = false, compact = false, quiet = false }: { orgId: string; workspaceId?: string; othersOnly?: boolean; compact?: boolean; quiet?: boolean }) {
  const presence = useCloudPresence(orgId);
  const { roster } = useOrganizationRoster(orgId, presence.state === "live");
  const catalog = useCloudCatalog();
  const privacy = useDataPrivacy();
  const unavailable = (label: string) => quiet ? null : <span className="shrink-0 text-[10px] text-faint" aria-label={compact ? label : undefined} title={compact ? label : undefined}>{compact ? "—" : label}</span>;
  if (privacy.enabled || presence.state !== "live") return unavailable(presence.state === "loading" ? "Loading presence…" : presence.state === "stale" ? "Presence stale" : "Presence unavailable");
  const people = (workspaceId ? presence.workspaces.find((row) => row.workspaceId === workspaceId)?.activeMembers : presence.activeMembers);
  if (!people) return unavailable("Presence unavailable");
  const visible = othersOnly ? people.filter((person) => person.userId !== catalog.viewerUserId) : people;
  if (quiet && !visible.length) return null;
  return <span className="inline-flex items-center gap-1" aria-label={workspaceId ? "People here" : "Active now"}>
    {!workspaceId && <span className="mr-1 text-xs text-faint">Active now</span>}
    {visible.map((person: PresencePerson) => {
      const member = roster?.members.find((member) => member.userId === person.userId) ?? { userId: person.userId, displayName: person.displayName ?? undefined, photoUrl: person.photoUrl ?? undefined, email: "", role: "" };
      return <MemberProfile key={person.userId} member={member} online onClick={(event) => event.stopPropagation()} className="size-5" />;
    })}
    {!visible.length && !othersOnly && <span className="text-[10px] text-faint">No one online</span>}
  </span>;
}
export function OwnerProfile({ orgId, userId, name }: { orgId: string; userId: string; name: string }) {
  const { roster } = useOrganizationRoster(orgId, true);
  const presence = useCloudPresence(orgId);
  const member = roster?.members.find((member) => member.userId === userId) ?? { userId, displayName: name, email: "", role: "" };
  return <span className="inline-flex items-center gap-1"><MemberProfile member={member} online={presence.state === "live" ? presence.activeMembers.some((person) => person.userId === userId) : undefined} onClick={(event) => event.stopPropagation()} className="size-5" /><span>{name}</span></span>;
}
