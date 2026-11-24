import { phase2Ready } from "@/lib/phase2Readiness";
import { openOrganizationSettings } from "@/lib/settingsLinks";
import { useEffect, useState } from "react";
import { Eye, Users } from "@/icons";
import { api, type CloudWorkspaceListItem, type WorkspaceReassignInput } from "@/lib/api";
import { getAccount, useAccount } from "@/lib/account";
import { refreshCloudCatalog, useCloudCatalog } from "@/lib/cloudCatalog";
import { privacyEnabled, useDataPrivacy } from "@/lib/dataPrivacy";
import { loadRosterIn } from "@/lib/cloudPeople";
import { useOrganizationRoster } from "@/lib/organizationRoster";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MemberProfile, memberName } from "@/components/people/MemberProfile";

export function preferenceScope(): string | null {
  const status = getAccount().status;
  return !privacyEnabled() && status.state === "signed-in" && status.context ? `${status.context.account}:${status.context.revision}` : null;
}
export function mayReassign(item: CloudWorkspaceListItem, userId: string | undefined, role: string | undefined) {
  return !!userId && !!item.workspace.createdBy && (item.workspace.createdBy === userId || role === "owner" || role === "admin");
}
/** One attempt keeps its UUID through an explicit retry. No automatic retries or owner-cache writes. */
export class WorkspacePreferencesController {
  constructor(private transport: Pick<typeof api, "cloudWorkspaceFollow" | "cloudWorkspaceUnfollow" | "cloudWorkspaceReassign"> = api, private scope = preferenceScope, private refresh = refreshCloudCatalog) {}
  async follow(item: CloudWorkspaceListItem, following: boolean) {
    const captured = this.scope();
    if (!captured) throw new Error("Workspace preferences are unavailable.");
    const w = item.workspace;
    await (following ? this.transport.cloudWorkspaceFollow(w.orgId, w.id) : this.transport.cloudWorkspaceUnfollow(w.orgId, w.id));
    if (captured !== this.scope()) return false;
    await this.refresh(w.orgId);
    return captured === this.scope();
  }
  async reassign(item: CloudWorkspaceListItem, input: WorkspaceReassignInput) {
    const captured = this.scope();
    if (!captured || item.workspace.createdBy !== input.expectedOwnerId) throw new Error("Workspace ownership changed. Refresh and try again.");
    await this.transport.cloudWorkspaceReassign(item.workspace.orgId, item.workspace.id, input);
    if (captured !== this.scope()) return false;
    // reassigned:false is a historical receipt. Only an authorized refetch says who owns it now.
    await this.refresh(item.workspace.orgId);
    return captured === this.scope();
  }
}
export const workspacePreferences = new WorkspacePreferencesController();
export function useWorkspacePreferencesAvailable(orgId: string) {
  const { status } = useAccount();
  return !useDataPrivacy().enabled && phase2Ready(status, orgId, "followReassign");
}
export function preferenceError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = {
    workspace_owner_changed: "The owner changed. Refresh and choose again.",
    workspace_reassign_target_not_visible: "This teammate cannot see the workspace. Ownership was not transferred.",
    cloud_workspace_member_concurrency_exceeded: "This teammate has reached their running limit.",
    workspace_reassign_private_confirmation_required: "Private handover needs confirmation, but cross-owner private transfers remain unavailable.",
    workspace_reassign_runtime_unsupported: "This runtime has credentials that cannot be transferred. Ownership was not transferred.",
    workspace_reassign_personal_route_held: "A personal agent route prevents this handover.",
    workspace_reassign_credential_restricted: "Credential restrictions prevent this handover.",
    workspace_reassign_busy: "Work is running. Wait until the workspace is idle and try again.",
    workspace_reassign_idempotency_conflict: "This attempt has different details. Close and start a new attempt.",
    workspace_following_unavailable: "Workspace preferences are unavailable while this feature is held.",
    cloud_workspace_request_outcome_unknown: "The result is uncertain. Refresh before retrying this same attempt.",
  };
  return messages[code] ?? (code ? `The server refused this request (${code}).` : "Could not update the workspace. Refresh and check your access.");
}
export function WorkspaceFollowButton({ item }: { item: CloudWorkspaceListItem }) {
  const available = useWorkspacePreferencesAvailable(item.workspace.orgId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountedScope] = useState(preferenceScope);
  const catalog = useCloudCatalog();
  const org = catalog.orgs[item.workspace.orgId];
  const current = org?.source === "live" && !org.error ? org.workspaces.find((row) => row.workspace.id === item.workspace.id) : undefined;
  const scope = preferenceScope();
  if (!available || !scope || scope !== mountedScope || !current || typeof current.following !== "boolean") return null;
  const following = current.following;
  return <span className="flex items-center gap-2">
    <Button size="sm" variant="ghost" disabled={pending} aria-pressed={following} title={following ? "Following on every device" : "Follow on every device"} onClick={() => {
      setPending(true); setError(null);
      void workspacePreferences.follow(current, !following).catch((error) => { if (scope === preferenceScope()) setError(preferenceError(error)); }).finally(() => { if (scope === preferenceScope()) setPending(false); });
    }}><Eye />{following ? "Following" : "Follow"}</Button>
    {error && <span role="alert" className="max-w-64 text-xs text-destructive">{error}</span>}
  </span>;
}

export function WorkspaceReassignDialog({ item, onClose }: { item: CloudWorkspaceListItem; onClose: () => void }) {
  const catalog = useCloudCatalog();
  const { status } = useAccount();
  useDataPrivacy();
  const available = useWorkspacePreferencesAvailable(item.workspace.orgId);
  const [scope] = useState(preferenceScope);
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<WorkspaceReassignInput | null>(null);
  const [complete, setComplete] = useState(false);
  const w = item.workspace;
  const roster = useOrganizationRoster(w.orgId, !!scope && scope === preferenceScope());
  const current = catalog.orgs[w.orgId];
  const latest = current?.source === "live" && !current.error ? current.workspaces.find((row) => row.workspace.id === w.id) : undefined;
  const role = status.organizations?.find((org) => org.id === w.orgId)?.role;
  const permitted = available && scope === preferenceScope() && !!latest && mayReassign(latest, catalog.viewerUserId, role) && latest.workspace.createdBy === w.createdBy;
  const orgName = status.organizations?.find((org) => org.id === w.orgId)?.name ?? "this organization";
  useEffect(() => {
    let live = true;
    if (scope && scope === preferenceScope()) void loadRosterIn(w.orgId, { fresh: true }).then((rows) => {
      if (live && scope === preferenceScope()) setMembers(rows);
    }).catch(() => { if (live && scope === preferenceScope()) setError("The member list is unavailable. Reopen to retry."); });
    return () => { live = false; };
  }, [scope, w.orgId]);
  // An authoritative roster change supersedes the initial request. A failed
  // refresh cannot keep offering members whose visibility is now uncertain.
  const currentMembers = roster.error ? null : roster.roster?.members ?? members;
  const others = currentMembers?.filter((person) => person.userId !== w.createdBy) ?? [];
  const targetAvailable = others.some((person) => person.userId === target);
  const candidates = others.filter((person) => memberName(person).toLowerCase().includes(query.toLowerCase()));
  const privateHandover = w.accessMode === "private";
  const submit = async () => {
    if (!permitted || !targetAvailable || pending || privateHandover || complete) return;
    const input = attempt ?? { targetUserId: target, expectedOwnerId: w.createdBy!, requestId: crypto.randomUUID().toLowerCase(), ...(note ? { note } : {}) };
    setAttempt(input); setPending(true); setError(null);
    try { if (await workspacePreferences.reassign(item, input)) setComplete(true); }
    catch (error) { if (scope === preferenceScope()) setError(preferenceError(error)); }
    finally { if (scope === preferenceScope()) setPending(false); }
  };
  // Every response and render is account/org fenced, including late errors and A-B-A.
  const visible = !!scope && scope === preferenceScope() && !!latest && !!role;
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogContent><DialogHeader><DialogTitle>Reassign {visible ? w.name : "workspace"}</DialogTitle><DialogDescription>Choose a teammate. The server checks access, running limits, schedules and credential restrictions.</DialogDescription></DialogHeader>
      {!visible ? <p role="status">The account changed. Close and reopen this dialog.</p> : complete ? <p role="status">Reassignment recorded. Check the refreshed catalog for current ownership and Following.</p> : <>
        {!permitted && <p role="status">Current ownership or permission is unavailable. Refresh before continuing.</p>}
        <label className="text-xs">Find a teammate<input aria-label="Find a teammate" value={query} disabled={pending} onChange={(e) => setQuery(e.target.value)} className="mt-1 w-full rounded bg-well p-2" /></label>
        {roster.error && <p role="status">The member list is unavailable. Reopen to retry.</p>}
        {currentMembers === null && !error && !roster.error && <p role="status">Loading teammates…</p>}
        {currentMembers && !others.length && <p>No other teammates in {orgName}. Invite someone through organization settings first. {(role === "owner" || role === "admin") && <Button variant="ghost" size="sm" onClick={() => { onClose(); openOrganizationSettings(w.orgId); }}>Invite people</Button>}</p>}
        <div className="max-h-56 overflow-auto" role="group" aria-label="Teammates">{candidates.map((person) => <label key={person.userId} className="flex items-center gap-2 rounded p-2 hover:bg-well">
          <input type="radio" name="reassign-target" value={person.userId} checked={target === person.userId} disabled={pending || !!attempt} onChange={() => setTarget(person.userId)} />
          <MemberProfile member={person} /><span>{memberName(person)}</span>
        </label>)}</div>
        <label className="text-xs">Note to the new owner (optional)<textarea aria-label="Note to the new owner" value={note} disabled={pending || !!attempt} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded bg-well p-2" /></label>
        {privateHandover && <p role="status">Private cross-owner handover is unavailable. Confirmation cannot grant a teammate access.</p>}
        <p className="text-xs text-muted-foreground">Your personal agent login stays with you. Tabs, credentials and runtime sessions are not moved. After a successful transfer the previous owner follows the workspace.</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </>}
      <DialogFooter><Button variant="outline" disabled={pending && visible} onClick={onClose}>{complete ? "Done" : "Close"}</Button>{visible && !complete && <Button disabled={!permitted || !targetAvailable || pending || privateHandover || /[<>\x00-\x08\x0b-\x1f\x7f]/.test(note)} onClick={() => void submit()}><Users />{pending ? "Reassigning…" : attempt ? "Retry same attempt" : "Reassign"}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
