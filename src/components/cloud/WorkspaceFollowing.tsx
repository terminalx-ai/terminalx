import { phase2Ready } from "@/lib/phase2Readiness";
import { openOrganizationSettings } from "@/lib/settingsLinks";
import { useEffect, useState } from "react";
import { Eye, Users } from "@/icons";
import { api, type CloudWorkspaceListItem, type WorkspaceReassignInput } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { relistCloudCatalog, useCloudCatalog } from "@/lib/cloudCatalog";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { loadRosterIn } from "@/lib/cloudPeople";
import { useOrganizationRoster } from "@/lib/organizationRoster";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MemberProfile, memberName } from "@/components/people/MemberProfile";
import { preferenceScope, showWorkspaceReassignReceipt } from "@/lib/workspaceFollowing";

export function mayReassign(item: CloudWorkspaceListItem, userId: string | undefined, role: string | undefined) {
  return !!userId && !!item.workspace.createdBy && (role === "owner" || role === "admin" || (role === "member" && item.workspace.createdBy === userId));
}

function reassignBlock(item: CloudWorkspaceListItem): string | null {
  const workspace = item.workspace;
  if (workspace.accessMode === "private") return "Private cross-owner handover is unavailable. Confirmation cannot grant a teammate access.";
  if (workspace.runtime) return "This workspace has an installed runtime. Runtime handover is unavailable.";
  if (workspace.preparation || workspace.archivedAt || (workspace.state !== "ready" && workspace.state !== "suspended")) return "This workspace is in a state that cannot be reassigned.";
  return null;
}

/** One attempt keeps its UUID through an explicit retry. No automatic retries or owner-cache writes. */
export class WorkspacePreferencesController {
  constructor(private transport: Pick<typeof api, "cloudWorkspaceFollow" | "cloudWorkspaceUnfollow" | "cloudWorkspaceReassign"> = api, private scope = preferenceScope, private refresh = relistCloudCatalog) {}
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
    const receipt = await this.transport.cloudWorkspaceReassign(item.workspace.orgId, item.workspace.id, input);
    if (captured !== this.scope()) return null;
    // reassigned:false is a historical receipt. Only an authorized refetch says who owns it now.
    await this.refresh(item.workspace.orgId).catch(() => undefined);
    return captured === this.scope() ? receipt : null;
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
    cloud_workspace_not_found: "This workspace is no longer available to you.",
    cloud_workspace_manager_required: "You no longer have permission to reassign this workspace.",
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
      if (scope !== preferenceScope()) return;
      setPending(true); setError(null);
      void workspacePreferences.follow(current, !following).catch((error) => { if (scope === preferenceScope()) setError(preferenceError(error)); }).finally(() => { if (scope === preferenceScope()) setPending(false); });
    }}><Eye />{following ? "Following" : "Follow"}</Button>
    {error && <span role="alert" className="max-w-64 text-xs text-destructive">{error}</span>}
  </span>;
}

export function WorkspaceReassignDialog({ item, onClose }: { item: CloudWorkspaceListItem; onClose: () => void }) {
  const catalog = useCloudCatalog();
  const { status } = useAccount();
  const available = useWorkspacePreferencesAvailable(item.workspace.orgId);
  const [scope] = useState(preferenceScope);
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<WorkspaceReassignInput | null>(null);
  const w = item.workspace;
  const current = catalog.orgs[w.orgId];
  const latest = current?.source === "live" && !current.error ? current.workspaces.find((row) => row.workspace.id === w.id) : undefined;
  const organization = status.organizations?.find((org) => org.id === w.orgId);
  const role = organization?.role;
  const sameScope = !!scope && scope === preferenceScope();
  const visible = sameScope && available && !!latest && !!role;
  const permitted = visible && mayReassign(latest, catalog.viewerUserId, role) && latest.workspace.createdBy === w.createdBy;
  const blocked = latest ? reassignBlock(latest) : null;
  const canChoose = permitted && !blocked;
  const roster = useOrganizationRoster(w.orgId, canChoose);
  const orgName = organization?.name ?? "this organization";
  useEffect(() => {
    let live = true;
    if (canChoose) void loadRosterIn(w.orgId, { fresh: true }).then((rows) => {
      if (live && scope === preferenceScope()) setMembers(rows);
    }).catch(() => { if (live && scope === preferenceScope()) setError("The member list is unavailable. Reopen to retry."); });
    return () => { live = false; };
  }, [canChoose, scope, w.orgId]);
  // An authoritative roster change supersedes the initial request. A failed
  // refresh cannot keep offering members whose visibility is now uncertain.
  const currentMembers = roster.error ? null : roster.roster?.members ?? members;
  const others = currentMembers?.filter(({ userId, role }) =>
    userId !== w.createdBy && (role === "owner" || role === "admin" || role === "member")) ?? [];
  const selected = others.find((person) => person.userId === target);
  const candidates = others.filter((person) => memberName(person).toLowerCase().includes(query.toLowerCase()));
  const invalidNote = /[<>\x00-\x08\x0b-\x1f\x7f]/.test(note);
  const canSubmit = canChoose && !!selected && !pending && !invalidNote;
  const submit = async () => {
    if (!canSubmit || !selected || !scope || scope !== preferenceScope()) return;
    const input = attempt ?? { targetUserId: target, expectedOwnerId: w.createdBy!, requestId: crypto.randomUUID().toLowerCase(), ...(note ? { note } : {}) };
    const targetName = memberName(selected);
    setAttempt(input); setPending(true); setError(null);
    try {
      const receipt = await workspacePreferences.reassign(item, input);
      if (receipt) {
        showWorkspaceReassignReceipt({ scope, orgId: w.orgId, workspaceId: receipt.workspaceId, targetName, reassigned: receipt.reassigned });
        onClose();
      }
    } catch (error) {
      if (scope === preferenceScope()) setError(preferenceError(error));
    } finally {
      if (scope === preferenceScope()) setPending(false);
    }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && (!pending || !visible)) onClose(); }}>
    <DialogContent showClose={!pending || !visible}><DialogHeader><DialogTitle>Reassign {visible ? latest.workspace.name : "workspace"}</DialogTitle><DialogDescription>The server checks teammate access, running limits, schedules and credential restrictions.</DialogDescription></DialogHeader>
      {!sameScope && <p role="status">The account changed. Close and reopen this dialog.</p>}
      {sameScope && !permitted && <p role="status">Current ownership or permission is unavailable. Refresh before continuing.</p>}
      {permitted && blocked && <p role="status">{blocked}</p>}
      {canChoose && <>
        <label className="text-xs">Find a teammate<input aria-label="Find a teammate" value={query} disabled={pending} onChange={(e) => setQuery(e.target.value)} className="mt-1 w-full rounded bg-well p-2" /></label>
        {roster.error && <p role="status">The member list is unavailable. Reopen to retry.</p>}
        {currentMembers === null && !error && !roster.error && <p role="status">Loading teammates…</p>}
        {currentMembers && !others.length && <p>No other teammates in {orgName}. Invite someone through organization settings first. {(role === "owner" || role === "admin") && <Button variant="ghost" size="sm" onClick={() => { onClose(); openOrganizationSettings(w.orgId); }}>Invite people</Button>}</p>}
        {!!others.length && !candidates.length && <p role="status">No matching teammates.</p>}
        <div className="max-h-56 overflow-auto" role="group" aria-label="Teammates">{candidates.map((person) => <label key={person.userId} className="flex items-center gap-2 rounded p-2 hover:bg-well">
          <input type="radio" name="reassign-target" value={person.userId} checked={target === person.userId} disabled={pending || !!attempt} onChange={() => setTarget(person.userId)} />
          <MemberProfile member={person} /><span>{memberName(person)}</span>
        </label>)}</div>
        <label className="text-xs">Note to the new owner (optional)<textarea aria-label="Note to the new owner" value={note} disabled={pending || !!attempt} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded bg-well p-2" /></label>
        {invalidNote && <p role="status">Use plain text without angle brackets or control characters.</p>}
        <p className="text-xs text-muted-foreground">Your personal agent login stays with you. After a successful transfer the previous owner follows the workspace.</p>
      </>}
      {visible && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={pending && visible} onClick={onClose}>Close</Button>{visible && <Button disabled={!canSubmit} onClick={() => void submit()}><Users />{pending ? "Reassigning…" : attempt ? "Retry same attempt" : "Reassign"}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
