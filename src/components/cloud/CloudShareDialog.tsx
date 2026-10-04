import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Loader2, Lock, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccount } from "@/lib/account";
import { api, type CloudShareRole, type CloudWorkspaceShare, type CloudWorkspaceShares } from "@/lib/api";
import { VISIBILITY_ADMIN_REASON, notifyAccessChanged } from "@/lib/cloudCollab";
import { loadRoster, loadRosterIn, rememberPeople } from "@/lib/cloudPeople";
import type { OrganizationMember } from "@/lib/organizationMembers";

/**
 * This person's access in words: Owner, Admin, Creator, Driver or Viewer.
 * The API's `manager` role is an organization owner's or admin's, so the
 * organization role says which of the two it is; the one person who manages
 * the shares without being a manager is the workspace's creator.
 */
export function yourAccessText(
  you: CloudWorkspaceShares["you"],
  /** This person's role in the workspace's organization (`owner`, `admin`, `member`); null when not known. */
  orgRole: string | null,
  /** Whether they created the workspace; null when not known. */
  creator: boolean | null = null,
): string {
  const approves = you.canApprove ? ", can approve permissions" : "";
  switch (you.role) {
    case "manager":
      if (orgRole === "owner") return "Owner (the organization's owner: manages this workspace and who it is shared with)";
      if (orgRole === "admin") return "Admin (an organization admin: manages this workspace and who it is shared with)";
      return "Owner or admin of the organization (manages this workspace and who it is shared with)";
    case "driver":
      if (you.canManageShares || creator) return "Creator (you created this workspace: can send to agents, type in terminals, approve permissions and manage who it is shared with)";
      // Typing in a terminal (a shell, or an agent's own) needs the approval right too (PRO-88).
      return you.canApprove ? `Driver (can send to agents and type in terminals)${approves}` : "Driver (can send to agents; typing in terminals also needs the right to approve permissions)";
    case "viewer":
      return `Viewer (can read everything, not send)${approves}`;
    case "none":
      return "No access to this workspace's content";
    default:
      return String(you.role);
  }
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : String(error);
}

/** What a refused share change means, in words. */
export function shareErrorMessage(error: unknown, who?: string): string {
  const code = codeOf(error);
  switch (code) {
    case "cloud_workspace_share_redundant":
      return `${who ?? "This person"} already has access as owner/admin/creator.`;
    case "cloud_workspace_share_requires_organization_access":
      return "Make the workspace visible to the organization first.";
    case "cloud_workspace_share_limit":
      return "This workspace is already shared with the maximum number of people (64). Revoke someone first.";
    case "cloud_workspace_share_forbidden":
      return "Only organization admins and the workspace's creator can change who it is shared with.";
    case "organization_member_not_found":
      return `${who ?? "This person"} is no longer a member of this organization.`;
    case "cloud_workspace_share_not_found":
      return "That share was already revoked.";
    case "cloud_workspace_not_found":
      return "This workspace no longer exists.";
    case "cloud_workspace_manager_required":
      return "Only this workspace's creator or an organization owner or admin can change whether it is private or visible to the organization. Ask one of them to change it.";
    case "organization_admin_required":
      return "Only an organization owner or admin can change whether a workspace is private or visible to the organization. Ask one to change it.";
    case "cloud_workspace_request_outcome_unknown":
      return "The server did not answer, so it is unknown whether this changed. Check the list and try again.";
    default:
      return `Could not change the share (${code}).`;
  }
}

type AccessMode = "private" | "organization";
/** `unknown`: a visibility change got no answer and the workspace could not be read back. */
type Access = AccessMode | "unknown";
type Confirming = { kind: "share" } | { kind: "private" } | null;
type Person = { userId: string; role: CloudShareRole; canApprove: boolean };

const OUTCOME_UNKNOWN = "cloud_workspace_request_outcome_unknown";

/**
 * Who a cloud workspace is shared with; managers and the creator can change it
 * (PRO-30). `orgId` is the workspace's organization: every organization is
 * live (CS-18), and the share routes are authorized by membership in it.
 *
 * A workspace starts private (only its creator sees it). Sharing it with the
 * first person makes it visible in the organization's sidebar, after the
 * person confirms that here; "Make private again" hides it and revokes every
 * share. Both go through the API's `/access` route, which is for whoever
 * manages the workspace: its creator, or an organization owner or admin
 * (PRO-73). Against a server from before that rule a creator who is a plain
 * member only manages the shares of a workspace that is already
 * organization-visible, and is told who can change its visibility.
 */
export function CloudShareDialog({
  orgId = null,
  workspaceId,
  name,
  accessMode: initialAccess = "organization",
  createdBy = null,
  canManage: manageHint,
  onClose,
}: {
  orgId?: string | null;
  workspaceId: string;
  name: string;
  /** What the workspace list says; the dialog follows its own changes after that. */
  accessMode?: AccessMode;
  /** The workspace's creator, to say who still sees it once private. */
  createdBy?: string | null;
  /** What the list says about managing shares, for the title before the share list has loaded. */
  canManage?: boolean;
  onClose: () => void;
}) {
  const { status } = useAccount();
  // The default organization's roster comes with the account; another
  // organization's (every one is live, PRO-71) is read by its own id.
  const defaultOrg = !orgId || !status.identity?.organizationId || status.identity.organizationId === orgId;
  const [listed, setListed] = useState<CloudWorkspaceShares | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  /** Why the organization's members could not be read; nobody can be added then. */
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<Person>({ userId: "", role: "viewer", canApprove: false });
  const [access, setAccess] = useState<Access>(initialAccess);
  const [confirming, setConfirming] = useState<Confirming>(null);
  /** The workspace was made organization-visible, but the share that was the reason for it did not go through. */
  const [unshared, setUnshared] = useState<{ person: Person; why: string } | null>(null);
  const org = orgId ?? status.identity?.organizationId;

  const reload = useCallback(async () => {
    try {
      const next = await api.cloudWorkspaceShares(workspaceId, orgId);
      rememberPeople(next.shares);
      setListed(next);
      setLoadError(null);
      return true;
    } catch (e) {
      setLoadError(codeOf(e));
      return false;
    }
  }, [workspaceId, orgId]);

  const loadMembers = useCallback(() => {
    setRosterError(null);
    if (defaultOrg) return void loadRoster().then(setMembers);
    void loadRosterIn(orgId!).then(setMembers, (e: unknown) => setRosterError(codeOf(e)));
  }, [defaultOrg, orgId]);

  useEffect(() => {
    void reload();
    loadMembers();
  }, [reload, loadMembers]);

  const manage = listed?.you.canManageShares ?? false;
  // Private or organization-visible is the API's owner-or-admin switch; the list says who this is up front.
  const mayChangeVisibility = listed?.you.role === "manager";
  const isPrivate = access === "private";
  const shared = useMemo(() => new Set(listed?.shares.map((share) => share.userId) ?? []), [listed]);
  // Owners and admins always have access; offering them would only be refused.
  const candidates = members.filter((member) => !shared.has(member.userId) && member.role !== "owner" && member.role !== "admin");
  const nameOf = (userId: string) => {
    const member = members.find((m) => m.userId === userId);
    return member?.displayName || member?.email || listed?.shares.find((s) => s.userId === userId)?.name || "This person";
  };
  // Private means its creator alone: an admin who did not create it stops seeing it too.
  const me = members.find((member) => member.email === status.identity?.email)?.userId ?? null;
  const creator = createdBy && me ? createdBy === me : null;
  // Owner or admin: the account's own word for this organization, else the roster's.
  const orgRole = status.organizations?.find((candidate) => candidate.id === org)?.role ?? members.find((member) => member.email === status.identity?.email)?.role ?? null;

  /** What the server says the workspace's visibility is now; null when that cannot be read. */
  const readAccess = async (): Promise<AccessMode | null> => {
    try {
      const list = await api.cloudWorkspaces(orgId);
      return list.workspaces.find((item) => item.workspace.id === workspaceId)?.workspace.accessMode ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Switch the visibility. A lost answer says nothing about whether it
   * changed, so the workspace is read back before anything is shown: true
   * when it is now `mode`, false (with the reason shown) when it is not or
   * cannot be told.
   */
  const switchAccess = async (mode: AccessMode): Promise<boolean> => {
    try {
      const workspace = await api.cloudWorkspaceSetAccess(workspaceId, mode, orgId);
      setAccess(workspace.accessMode);
      notifyAccessChanged(org);
      return workspace.accessMode === mode;
    } catch (e) {
      if (codeOf(e) !== OUTCOME_UNKNOWN) {
        setError(shareErrorMessage(e, name));
        return false;
      }
      const now = await readAccess();
      notifyAccessChanged(org);
      if (now === null) {
        // Private and unlisted look the same to someone who is not its creator; say only what is known.
        setAccess("unknown");
        setError("The server did not answer, and the workspace could not be read back, so it is unknown whether its visibility changed. Check again before sharing.");
        return false;
      }
      setAccess(now);
      if (now !== mode) setError(`The server did not answer, and the workspace is still ${now === "private" ? "private" : "visible to the organization"}. Try again.`);
      return now === mode;
    }
  };

  const change = async (key: string, who: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await reload();
      // The sidebar's rows, chips and share counts follow at once.
      notifyAccessChanged(org);
      return true;
    } catch (e) {
      setError(shareErrorMessage(e, who));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const put = (share: Pick<CloudWorkspaceShare, "userId" | "role" | "canApprove">) =>
    change(`put:${share.userId}`, nameOf(share.userId), () => api.cloudWorkspaceSharePut(workspaceId, share.userId, share.role, share.canApprove, orgId));

  /** Grant the share that a visibility change was made for; a refusal leaves the workspace visible but unshared, and says so. */
  const shareAfterVisible = async (person: Person) => {
    try {
      await api.cloudWorkspaceSharePut(workspaceId, person.userId, person.role, person.canApprove, orgId);
      setUnshared(null);
      setAdding({ userId: "", role: "viewer", canApprove: false });
    } catch (e) {
      setUnshared({ person, why: shareErrorMessage(e, nameOf(person.userId)) });
    }
    await reload();
    notifyAccessChanged(org);
  };

  const add = async () => {
    if (!adding.userId) return;
    if (!isPrivate) {
      if (await put(adding)) setAdding({ userId: "", role: "viewer", canApprove: false });
      return;
    }
    // Sharing a private workspace changes who can see it: ask first.
    if (confirming?.kind !== "share") {
      setError(null);
      setConfirming({ kind: "share" });
      return;
    }
    setConfirming(null);
    const person = adding;
    setBusy(`put:${person.userId}`);
    setError(null);
    try {
      if (await switchAccess("organization")) await shareAfterVisible(person);
    } finally {
      setBusy(null);
    }
  };

  const retryShare = async () => {
    if (!unshared) return;
    setBusy(`put:${unshared.person.userId}`);
    setError(null);
    try {
      await shareAfterVisible(unshared.person);
    } finally {
      setBusy(null);
    }
  };

  const makePrivate = async () => {
    setConfirming(null);
    setBusy("private");
    setError(null);
    try {
      // The server revokes every share and closes their connections in the same transaction.
      if (!(await switchAccess("private"))) return;
      setUnshared(null);
      // Private is its creator's alone: anyone else has nothing left to read here.
      if (creator === false || !(await reload())) onClose();
    } finally {
      setBusy(null);
    }
  };

  const recheckAccess = async () => {
    setBusy("access");
    setError(null);
    try {
      const now = await readAccess();
      if (now === null) setError("The workspace still could not be read. It may be private to its creator now, or the server is not answering.");
      else setAccess(now);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const manages = listed ? manage : !!manageHint;
  const sharedCount = listed?.shares.length ?? 0;
  // A private workspace cannot be shared by someone who may not make it visible.
  const addBlocked = isPrivate && !mayChangeVisibility;

  const select = "rounded-md border border-hairline bg-transparent px-2 py-1 text-xs";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[36rem]" data-testid="cloud-share-dialog">
        <DialogHeader>
          <DialogTitle>{manages ? `Share ${name}` : "Who has access"}</DialogTitle>
          <DialogDescription>
            {manages
              ? "People you share with see this workspace's agent tabs, terminals, files and Git. Drivers can also send to agents, and type in terminals if they can approve permissions."
              : `People with access to ${name} see its agent tabs, terminals, files and Git. Drivers can also send to agents, and type in terminals if they can approve permissions.`}
          </DialogDescription>
        </DialogHeader>
        {!listed && !loadError && <Loader2 className="size-4 animate-spin" />}
        {loadError && <p className="text-xs text-destructive">Could not load who this workspace is shared with ({loadError}).</p>}
        {listed && (
          <div className="flex flex-col gap-3 text-xs">
            <p className="text-muted-foreground" data-testid="cloud-share-you">
              Your access: {yourAccessText(listed.you, orgRole, creator)}.
            </p>
            {manage && isPrivate && (
              <p className="flex items-start gap-2 rounded-md border border-hairline bg-well/40 px-3 py-2 text-muted-foreground" data-testid="cloud-share-private">
                <Lock className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  This workspace is private: only you can see it. Sharing it makes it visible in the organization's sidebar. The people you add here and
                  organization admins can open it; other members see only that it exists.
                  {!mayChangeVisibility && ` ${VISIBILITY_ADMIN_REASON}: ask one to make it visible, then share it from here.`}
                </span>
              </p>
            )}
            {access === "unknown" && (
              <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2" role="alert" data-testid="cloud-share-access-unknown">
                <span className="min-w-0 flex-1">It is not known whether this workspace is private or visible to the organization right now.</span>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void recheckAccess()}>
                  Check again
                </Button>
              </div>
            )}
            {unshared && (
              <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2" role="alert" data-testid="cloud-share-unshared">
                <p>
                  {name} is now visible to the organization, but it is not shared with {nameOf(unshared.person.userId)} yet. {unshared.why}
                </p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => (setError(null), setConfirming({ kind: "private" }))}>
                    Make private again
                  </Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => void retryShare()}>
                    Retry sharing
                  </Button>
                </div>
              </div>
            )}
            {listed.shares.length === 0 ? (
              <p className="text-muted-foreground">
                {isPrivate ? "Not shared with anyone." : "Not shared with anyone yet. Organization admins and the creator always have access."}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline" aria-label="People with access">
                {listed.shares.map((share) => (
                  <li key={share.userId} className="flex items-center gap-2 px-3 py-2" data-testid="cloud-share-row">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{share.name || share.email}</span>
                      {share.name && <span className="truncate text-muted-foreground">{share.email}</span>}
                    </div>
                    {manage ? (
                      <>
                        <select
                          aria-label={`Role for ${share.name || share.email}`}
                          className={select}
                          value={share.role}
                          disabled={busy !== null}
                          onChange={(e) => void put({ ...share, role: e.target.value as CloudShareRole })}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="driver">Driver</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-muted-foreground">
                          <Switch
                            size="sm"
                            aria-label={`Can approve permissions: ${share.name || share.email}`}
                            checked={share.canApprove}
                            disabled={busy !== null}
                            onCheckedChange={(checked) => void put({ ...share, canApprove: checked })}
                          />
                          Can approve permissions
                        </label>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Revoke ${share.name || share.email}`}
                          disabled={busy !== null}
                          onClick={() => void change(`revoke:${share.userId}`, share.name || share.email, () => api.cloudWorkspaceShareRevoke(workspaceId, share.userId, orgId))}
                        >
                          <X />
                        </Button>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {share.role === "driver" ? "Driver" : "Viewer"}
                        {share.canApprove ? " · can approve" : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {manage && rosterError && (
              <p className="flex items-center gap-2 text-muted-foreground" data-testid="cloud-share-roster-error">
                <span className="min-w-0 flex-1">
                  {rosterError === "cloud_organization_unavailable"
                    ? "This organization's members can only be read while it is your default organization (Settings). You can still change or revoke the shares above."
                    : `Could not load this organization's members (${rosterError}), so nobody can be added right now. You can still change or revoke the shares above.`}
                </span>
                <Button size="sm" variant="outline" onClick={loadMembers}>
                  Retry
                </Button>
              </p>
            )}
            {manage && !rosterError && access !== "unknown" && !unshared && (
              <div className="flex flex-wrap items-center gap-2" data-testid="cloud-share-add">
                <select
                  aria-label="Add person"
                  className={`${select} min-w-0 flex-1`}
                  value={adding.userId}
                  onChange={(e) => setAdding((current) => ({ ...current, userId: e.target.value }))}
                >
                  <option value="">Add person…</option>
                  {candidates.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName ? `${member.displayName} (${member.email})` : member.email}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="New person's role"
                  className={select}
                  value={adding.role}
                  onChange={(e) => setAdding((current) => ({ ...current, role: e.target.value as CloudShareRole }))}
                >
                  <option value="viewer">Viewer</option>
                  <option value="driver">Driver</option>
                </select>
                <label className="flex items-center gap-1.5 text-muted-foreground">
                  <Switch
                    size="sm"
                    aria-label="New person can approve permissions"
                    checked={adding.canApprove}
                    onCheckedChange={(checked) => setAdding((current) => ({ ...current, canApprove: checked }))}
                  />
                  Can approve permissions
                </label>
                <Button
                  size="sm"
                  disabled={!adding.userId || busy !== null || confirming !== null || addBlocked}
                  title={addBlocked ? VISIBILITY_ADMIN_REASON : undefined}
                  aria-description={addBlocked ? VISIBILITY_ADMIN_REASON : undefined}
                  onClick={() => void add()}
                >
                  <UserPlus className="size-3.5" /> Share
                </Button>
              </div>
            )}
            {confirming?.kind === "share" && (
              <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2" role="alertdialog" aria-label="Make this workspace visible to the organization" data-testid="cloud-share-confirm">
                <p>
                  Share with {nameOf(adding.userId)} and make {name} visible to the organization? It will appear in every member's sidebar. Only{" "}
                  {nameOf(adding.userId)} and organization admins will be able to open it.
                </p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => void add()}>
                    Make visible and share
                  </Button>
                </div>
              </div>
            )}
            {manage && access === "organization" && confirming?.kind !== "private" && !unshared && (
              <div className="flex items-center gap-2 border-t border-hairline pt-3 text-muted-foreground">
                <span className="min-w-0 flex-1" data-testid="cloud-share-visibility">
                  Visible in the organization's sidebar.{!mayChangeVisibility && ` ${VISIBILITY_ADMIN_REASON}.`}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !mayChangeVisibility}
                  title={mayChangeVisibility ? undefined : VISIBILITY_ADMIN_REASON}
                  aria-description={mayChangeVisibility ? undefined : VISIBILITY_ADMIN_REASON}
                  onClick={() => (setError(null), setConfirming({ kind: "private" }))}
                >
                  <Lock className="size-3.5" /> Make private again
                </Button>
              </div>
            )}
            {confirming?.kind === "private" && (
              <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2" role="alertdialog" aria-label="Make this workspace private again" data-testid="cloud-private-confirm">
                <p>
                  Make {name} private again?{" "}
                  {sharedCount > 0
                    ? `${sharedCount === 1 ? "The 1 person" : `All ${sharedCount} people`} it is shared with ${sharedCount === 1 ? "loses" : "lose"} access now and their open sessions close. `
                    : ""}
                  It disappears from everyone else's sidebar, organization admins included.{" "}
                  {creator === false
                    ? "You did not create it, so you will stop seeing it too: only its creator will."
                    : creator === null
                      ? "Only its creator will still see it."
                      : "Only you will still see it."}
                </p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void makePrivate()}>
                    {sharedCount > 0 ? "Revoke all and make private" : "Make private"}
                  </Button>
                </div>
              </div>
            )}
            {error && (
              <p className="text-destructive" role="alert" data-testid="cloud-share-error">
                {error}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}


/** The workspace whose share dialog is open, wherever it was opened from (sidebar row or session header). */
export interface ShareTarget {
  orgId: string;
  workspaceId: string;
  name: string;
  /** From the workspace list: whether it is still private, who created it, and whether this person manages its shares. */
  accessMode?: "private" | "organization";
  createdBy?: string | null;
  canManage?: boolean;
}

let shareTarget: ShareTarget | null = null;
const shareListeners = new Set<() => void>();

export function openShareDialog(target: ShareTarget | null) {
  shareTarget = target;
  for (const listener of [...shareListeners]) listener();
}

/** Mounted once (AppShell): the share dialog for `openShareDialog`. */
export function CloudShareDialogHost() {
  const target = useSyncExternalStore(
    (listener) => {
      shareListeners.add(listener);
      return () => shareListeners.delete(listener);
    },
    () => shareTarget,
    () => null,
  );
  if (!target) return null;
  return (
    <CloudShareDialog
      key={`${target.orgId}:${target.workspaceId}`}
      orgId={target.orgId}
      workspaceId={target.workspaceId}
      name={target.name}
      accessMode={target.accessMode}
      createdBy={target.createdBy}
      canManage={target.canManage}
      onClose={() => openShareDialog(null)}
    />
  );
}
