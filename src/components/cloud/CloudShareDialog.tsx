import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Loader2, Lock, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccount } from "@/lib/account";
import { api, type CloudShareRole, type CloudWorkspaceShare, type CloudWorkspaceShares } from "@/lib/api";
import { notifyAccessChanged } from "@/lib/cloudCollab";
import { loadRoster, rememberPeople } from "@/lib/cloudPeople";
import type { OrganizationMember } from "@/lib/organizationMembers";

const ROLE_TEXT: Record<string, string> = {
  manager: "Admin (manages the workspace)",
  driver: "Driver (can send to agents and type in terminals)",
  viewer: "Viewer (can read everything, not send)",
  none: "No access to this workspace's content",
};

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
    case "organization_admin_required":
      return "Only an organization owner or admin can change whether a workspace is private or visible to the organization. Ask one to change it.";
    case "cloud_workspace_request_outcome_unknown":
      return "The server did not answer, so it is unknown whether this changed. Check the list and try again.";
    default:
      return `Could not change the share (${code}).`;
  }
}

type AccessMode = "private" | "organization";
type Confirming = { kind: "share" } | { kind: "private" } | null;

/**
 * Who a cloud workspace is shared with; managers and the creator can change it
 * (PRO-30). `orgId` is the workspace's organization: every organization is
 * live (CS-18), and the share routes are authorized by membership in it.
 *
 * A workspace starts private (only its creator sees it). Sharing it with the
 * first person makes it visible in the organization's sidebar, after the
 * person confirms that here; "Make private again" hides it and revokes every
 * share. Both go through the API's `/access` route.
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
  // The member picker reads the default organization's roster; for another
  // organization it would offer the wrong people.
  const rosterApplies = !orgId || !status.identity?.organizationId || status.identity.organizationId === orgId;
  const [listed, setListed] = useState<CloudWorkspaceShares | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ userId: string; role: CloudShareRole; canApprove: boolean }>({ userId: "", role: "viewer", canApprove: false });
  const [access, setAccess] = useState<AccessMode>(initialAccess);
  const [confirming, setConfirming] = useState<Confirming>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.cloudWorkspaceShares(workspaceId, orgId);
      rememberPeople(next.shares);
      setListed(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(codeOf(e));
    }
  }, [workspaceId, orgId]);

  useEffect(() => {
    void reload();
    if (rosterApplies) void loadRoster().then(setMembers);
  }, [reload, rosterApplies]);

  const manage = listed?.you.canManageShares ?? false;
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

  const change = async (key: string, who: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await reload();
      // The sidebar's rows, chips and share counts follow at once.
      notifyAccessChanged(orgId ?? status.identity?.organizationId);
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

  const add = async () => {
    if (!adding.userId) return;
    // Sharing a private workspace changes who can see it: ask first.
    if (isPrivate && confirming?.kind !== "share") {
      setError(null);
      setConfirming({ kind: "share" });
      return;
    }
    setConfirming(null);
    const person = adding;
    const done = await change(`put:${person.userId}`, nameOf(person.userId), async () => {
      if (isPrivate) {
        const workspace = await api.cloudWorkspaceSetAccess(workspaceId, "organization", orgId);
        setAccess(workspace.accessMode);
      }
      await api.cloudWorkspaceSharePut(workspaceId, person.userId, person.role, person.canApprove, orgId);
    });
    if (done) setAdding({ userId: "", role: "viewer", canApprove: false });
    // Made visible but the share itself was refused: the list and the sidebar still follow.
    else notifyAccessChanged(orgId ?? status.identity?.organizationId);
  };

  const makePrivate = async () => {
    setConfirming(null);
    setBusy("private");
    setError(null);
    try {
      // The server revokes every share and closes their connections in the same transaction.
      const workspace = await api.cloudWorkspaceSetAccess(workspaceId, "private", orgId);
      setAccess(workspace.accessMode);
      notifyAccessChanged(orgId ?? status.identity?.organizationId);
      // Private is its creator's alone: anyone else has nothing left to read here.
      if (creator === false) return onClose();
      try {
        const next = await api.cloudWorkspaceShares(workspaceId, orgId);
        setListed(next);
      } catch {
        onClose();
      }
    } catch (e) {
      setError(shareErrorMessage(e, name));
    } finally {
      setBusy(null);
    }
  };

  const manages = listed ? manage : !!manageHint;
  const sharedCount = listed?.shares.length ?? 0;

  const select = "rounded-md border border-hairline bg-transparent px-2 py-1 text-xs";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[36rem]" data-testid="cloud-share-dialog">
        <DialogHeader>
          <DialogTitle>{manages ? `Share ${name}` : "Who has access"}</DialogTitle>
          <DialogDescription>
            {manages
              ? "People you share with see this workspace's agent tabs, terminals, files and Git. Drivers can also send to agents and type in terminals."
              : `People with access to ${name} see its agent tabs, terminals, files and Git. Drivers can also send to agents and type in terminals.`}
          </DialogDescription>
        </DialogHeader>
        {!listed && !loadError && <Loader2 className="size-4 animate-spin" />}
        {loadError && <p className="text-xs text-destructive">Could not load who this workspace is shared with ({loadError}).</p>}
        {listed && (
          <div className="flex flex-col gap-3 text-xs">
            <p className="text-muted-foreground" data-testid="cloud-share-you">
              Your access: {ROLE_TEXT[listed.you.role] ?? listed.you.role}
              {listed.you.canApprove && listed.you.role !== "manager" ? ", can approve permissions" : ""}.
            </p>
            {manage && isPrivate && (
              <p className="flex items-start gap-2 rounded-md border border-hairline bg-well/40 px-3 py-2 text-muted-foreground" data-testid="cloud-share-private">
                <Lock className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  This workspace is private: only you can see it. Sharing it makes it visible in the organization's sidebar. The people you add here and
                  organization admins can open it; other members see only that it exists.
                </span>
              </p>
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
            {manage && !rosterApplies && (
              <p className="text-muted-foreground" data-testid="cloud-share-other-org">
                To add people, make this workspace's organization your default in Settings. You can change or revoke the shares above from here.
              </p>
            )}
            {manage && rosterApplies && (
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
                <Button size="sm" disabled={!adding.userId || busy !== null || confirming !== null} onClick={() => void add()}>
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
            {manage && !isPrivate && confirming?.kind !== "private" && (
              <div className="flex items-center gap-2 border-t border-hairline pt-3 text-muted-foreground">
                <span className="min-w-0 flex-1">Visible in the organization's sidebar.</span>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => (setError(null), setConfirming({ kind: "private" }))}>
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
