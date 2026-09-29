import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type CloudShareRole, type CloudWorkspaceShare, type CloudWorkspaceShares } from "@/lib/api";
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
    case "cloud_workspace_request_outcome_unknown":
      return "The server did not answer, so it is unknown whether this changed. Check the list and try again.";
    default:
      return `Could not change the share (${code}).`;
  }
}

/** Who a cloud workspace is shared with; managers and the creator can change it (PRO-30). */
export function CloudShareDialog({ workspaceId, name, onClose }: { workspaceId: string; name: string; onClose: () => void }) {
  const [listed, setListed] = useState<CloudWorkspaceShares | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ userId: string; role: CloudShareRole; canApprove: boolean }>({ userId: "", role: "viewer", canApprove: false });

  const reload = useCallback(async () => {
    try {
      const next = await api.cloudWorkspaceShares(workspaceId);
      rememberPeople(next.shares);
      setListed(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(codeOf(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
    void loadRoster().then(setMembers);
  }, [reload]);

  const manage = listed?.you.canManageShares ?? false;
  const shared = useMemo(() => new Set(listed?.shares.map((share) => share.userId) ?? []), [listed]);
  // Owners and admins always have access; offering them would only be refused.
  const candidates = members.filter((member) => !shared.has(member.userId) && member.role !== "owner" && member.role !== "admin");
  const nameOf = (userId: string) => {
    const member = members.find((m) => m.userId === userId);
    return member?.displayName || member?.email || listed?.shares.find((s) => s.userId === userId)?.name || "This person";
  };

  const change = async (key: string, who: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await reload();
      return true;
    } catch (e) {
      setError(shareErrorMessage(e, who));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const put = (share: Pick<CloudWorkspaceShare, "userId" | "role" | "canApprove">) =>
    change(`put:${share.userId}`, nameOf(share.userId), () => api.cloudWorkspaceSharePut(workspaceId, share.userId, share.role, share.canApprove));

  const add = async () => {
    if (!adding.userId) return;
    if (await put(adding)) setAdding({ userId: "", role: "viewer", canApprove: false });
  };

  const select = "rounded-md border border-hairline bg-transparent px-2 py-1 text-xs";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[36rem]" data-testid="cloud-share-dialog">
        <DialogHeader>
          <DialogTitle>Share {name}</DialogTitle>
          <DialogDescription>
            People you share with see this workspace's agent tabs, terminals, files and Git. Drivers can also send to agents and type in terminals.
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
            {listed.shares.length === 0 ? (
              <p className="text-muted-foreground">Not shared with anyone yet. Organization admins and the creator always have access.</p>
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
                          onClick={() => void change(`revoke:${share.userId}`, share.name || share.email, () => api.cloudWorkspaceShareRevoke(workspaceId, share.userId))}
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
            {manage && (
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
                <Button size="sm" disabled={!adding.userId || busy !== null} onClick={() => void add()}>
                  <UserPlus className="size-3.5" /> Share
                </Button>
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
