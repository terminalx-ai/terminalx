import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Lock, UserPlus, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAccount, useAccount } from "@/lib/account";
import { api, type AccountStatus, type CloudShareRole, type CloudWorkspaceGeneralAccess, type CloudWorkspaceShare, type CloudWorkspaceShares } from "@/lib/api";
import { VISIBILITY_ADMIN_REASON, notifyAccessChanged } from "@/lib/cloudCollab";
import { loadRoster, loadRosterIn, rememberPeople } from "@/lib/cloudPeople";
import { readOrganizationRoster, useOrganizationRoster } from "@/lib/organizationRoster";
import { privacyEnabled, useDataPrivacy } from "@/lib/dataPrivacy";
import { featureFlags, useFeatureFlag } from "@/lib/featureFlags";
import { phase2Ready } from "@/lib/phase2Readiness";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { MemberProfile } from "@/components/people/MemberProfile";
import { ADMIN_SHARE_LABEL, alwaysHasAccess, codeOf, MANAGER_APPROVAL_REASON, OUTCOME_UNKNOWN, shareErrorMessage, shareRoleLabel, yourAccessText } from "@/lib/cloudShareLabels";
import { CloudGeneralAccessControls } from "./CloudGeneralAccessControls";
import { CloudShareEditor } from "./CloudShareEditor";

export { alwaysHasAccess, shareErrorMessage, yourAccessText } from "@/lib/cloudShareLabels";

export type AccessMode = "private" | "organization";
/** `unknown`: a visibility change got no answer and the workspace could not be read back. */
export type Access = AccessMode | "unknown";
type Confirming = { kind: "share" } | { kind: "private" } | null;
type Person = { userId: string; role: CloudShareRole; canApprove: boolean };
const REVISION_CONFLICT = "cloud_workspace_access_revision_conflict";
const GENERAL_ACCESS_UNAVAILABLE = "cloud_workspace_general_access_unavailable";

export type ShareDialogProps = {
  orgId?: string | null;
  workspaceId: string;
  name: string;
  accessMode?: AccessMode;
  createdBy?: string | null;
  canManage?: boolean;
  onClose: () => void;
};

function editorScope(status: AccountStatus, orgId: string | undefined | null): string | null {
  if (status.state !== "signed-in" || !status.context?.revision || !orgId) return null;
  if (status.organizations && !status.organizations.some((org) => org.id === orgId)) return null;
  const { account, scope, revision } = status.context;
  return JSON.stringify([account, scope, revision, status.identity?.organizationId, orgId]);
}

function shareAccountScope(status: AccountStatus): string {
  return JSON.stringify([status.state, status.identity?.email, status.identity?.organizationId,
    status.context?.account, status.context?.scope, status.context?.revision]);
}

export function CloudShareDialog(props: ShareDialogProps) {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const orgId = props.orgId ?? status.identity?.organizationId;
  const contextRevision = status.context?.revision;
  const generalReady = !!orgId && !!contextRevision && !privacy.enabled && phase2Ready(status, orgId, "generalAccess");
  const adminReady = !!orgId && !!contextRevision && !privacy.enabled && phase2Ready(status, orgId, "adminShare");
  const accountScope = shareAccountScope(status);
  const [openedIn] = useState(accountScope);
  const [gatedUsed, setGatedUsed] = useState(generalReady || adminReady);
  const currentAccount = accountScope === openedIn;
  const closed = (generalReady || adminReady || gatedUsed) && !currentAccount;
  const { onClose } = props;
  useEffect(() => {
    if ((generalReady || adminReady) && currentAccount) setGatedUsed(true);
    if (closed) onClose();
  }, [generalReady, adminReady, currentAccount, closed, onClose]);
  const scope = editorScope(status, orgId);
  const isCurrentScope = useCallback(() => {
    const now = getAccount().status;
    return scope !== null && scope === editorScope(now, props.orgId ?? now.identity?.organizationId);
  }, [scope, props.orgId]);
  const canRequest = useCallback(() =>
    !privacyEnabled() && !!orgId && isCurrentScope() && phase2Ready(getAccount().status, orgId, "workspaceGroups"),
  [orgId, isCurrentScope]);
  if (closed) return null;
  const fallback = <LegacyCloudShareDialog {...props} status={status} generalReady={generalReady} adminReady={adminReady} />;
  if (scope && orgId && contextRevision) {
    const organization = status.organizations?.find((item) => item.id === orgId);
    const organizationName = organization?.name ?? (orgId === status.identity?.organizationId ? status.identity?.organization : undefined);
    return <CloudShareEditor key={JSON.stringify([scope, props.workspaceId])} {...props}
      orgId={orgId} organization={organizationName || "this organization"} orgRole={organization?.role ?? null} contextRevision={contextRevision}
      ready={phase2Ready(status, orgId, "workspaceGroups")} privacy={privacy.enabled}
      isCurrentScope={isCurrentScope} canRequest={canRequest} generalReady={generalReady} fallback={fallback} />;
  }
  return fallback;
}

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
function LegacyCloudShareDialog({
  orgId = null,
  workspaceId,
  name,
  accessMode: initialAccess = "organization",
  createdBy = null,
  canManage: manageHint,
  onClose,
  status,
  generalReady,
  adminReady,
}: ShareDialogProps & { status: AccountStatus; generalReady: boolean; adminReady: boolean }) {
  // The default organization's roster comes with the account; another
  // organization's (every one is live, PRO-71) is read by its own id.
  const defaultOrg = !orgId || !status.identity?.organizationId || status.identity.organizationId === orgId;
  const [listed, setListed] = useState<CloudWorkspaceShares | null>(null);
  const org = orgId ?? status.identity?.organizationId;
  const profiles = useFeatureFlag(featureFlags.teamRoster, org);
  const rosterState = useOrganizationRoster(org, profiles);
  const [legacyMembers, setLegacyMembers] = useState<OrganizationMember[]>([]);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const members = profiles ? rosterState.roster?.members ?? [] : legacyMembers;
  const rosterError = profiles ? rosterState.error ? codeOf(rosterState.error) : null : legacyError;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<Person>({ userId: "", role: "viewer", canApprove: false });
  const [access, setAccess] = useState<Access>(initialAccess);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [generalDraft, setGeneralDraft] = useState<{ mode: CloudWorkspaceGeneralAccess["mode"]; revision: string } | null>(null);
  /** The workspace was made organization-visible, but the share that was the reason for it did not go through. */
  const [unshared, setUnshared] = useState<{ person: Person; why: string } | null>(null);

  const contextRevision = status.context?.revision ?? "";
  const scope = shareAccountScope(status);
  const isCurrentAccount = useCallback(() => shareAccountScope(getAccount().status) === scope, [scope]);

  const listRead = useRef(0);
  const reload = useCallback(async () => {
    if (!isCurrentAccount()) return false;
    const read = ++listRead.current;
    try {
      const next = await api.cloudWorkspaceShares(workspaceId, orgId);
      if (!isCurrentAccount() || read !== listRead.current) return false;
      rememberPeople(next.shares);
      setListed(next);
      setLoadError(null);
      return true;
    } catch (e) {
      if (isCurrentAccount() && read === listRead.current) setLoadError(codeOf(e));
      return false;
    }
  }, [workspaceId, orgId, isCurrentAccount]);

  const membersRead = useRef(0);
  const loadMembers = useCallback((fresh = true) => {
    if (profiles) {
      void readOrganizationRoster(org, { fresh, active: defaultOrg, contextRevision }).catch(() => {});
      return;
    }
    const read = ++membersRead.current;
    setLegacyError(null);
    const pending = defaultOrg ? loadRoster({ fresh: true }) : loadRosterIn(orgId!, { fresh: true });
    void pending.then(
      (next) => { if (read === membersRead.current) setLegacyMembers(next); },
      (error: unknown) => { if (read === membersRead.current) setLegacyError(codeOf(error)); },
    );
  }, [org, orgId, defaultOrg, contextRevision, profiles]);

  /** A refusal that says the person left the organization: what is shown of them is out of date, so both lists are read again. */
  const leftOrganization = (e: unknown, userId: string) => {
    if (codeOf(e) !== "organization_member_not_found") return;
    setAdding((before) => (before.userId === userId ? { userId: "", role: "viewer", canApprove: false } : before));
    loadMembers();
    void reload();
  };

  useEffect(() => {
    void reload();
    loadMembers(false);
    return () => { listRead.current++; membersRead.current++; };
  }, [reload, loadMembers]);

  const manage = listed?.you.canManageShares ?? false;
  const offerAdmin = adminReady && manage && listed?.you.role === "manager";
  const canGrantAdmin = () => offerAdmin && !!org && isCurrentAccount() && !privacyEnabled()
    && phase2Ready(getAccount().status, org, "adminShare");
  const writeShare = (person: Pick<Person, "userId" | "role" | "canApprove">) => person.role === "manager"
    ? canGrantAdmin()
      ? api.cloudWorkspaceSharePut(workspaceId, person.userId, person.role, person.canApprove, orgId, contextRevision)
      : Promise.reject({ code: "cloud_workspace_runtime_not_ready" })
    : api.cloudWorkspaceSharePut(workspaceId, person.userId, person.role, person.canApprove, orgId);
  const generalAccess = generalReady && org && access === "organization"
    ? listed?.generalAccess : undefined;
  const everyoneLabel = `Everyone at ${status.organizations?.find((candidate) => candidate.id === org)?.name
    || (status.identity?.organizationId === org ? status.identity?.organization : null)
    || "this organization"}`;
  const generalRevision = contextRevision && manage && listed?.capabilities?.canChangeGeneralAccess && !loadError
    ? listed.accessRevision : undefined;
  const pendingGeneralMode = generalRevision && generalDraft?.revision === generalRevision ? generalDraft.mode : null;
  // Private or organization-visible is the API's owner-or-admin switch; the list says who this is up front.
  const mayChangeVisibility = listed?.you.role === "manager";
  const isPrivate = access === "private";
  const shared = useMemo(() => new Set(listed?.shares.map((share) => share.userId) ?? []), [listed]);
  // Owners, admins and the creator always have access; offering them would only be refused.
  const candidates = members.filter((member) => !shared.has(member.userId) && !alwaysHasAccess(member, createdBy));
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

  const change = async (key: string, who: string, run: () => Promise<unknown>, userId?: string) => {
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
      if (userId) leftOrganization(e, userId);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const put = (share: Pick<CloudWorkspaceShare, "userId" | "role" | "canApprove">) => {
    if (share.role === "manager" && !share.canApprove) {
      setError(MANAGER_APPROVAL_REASON);
      return Promise.resolve(false);
    }
    return change(`put:${share.userId}`, nameOf(share.userId), () => writeShare(share), share.userId);
  };

  const saveGeneralAccess = async () => {
    if (!org || !generalAccess || !pendingGeneralMode || generalAccess.mode === pendingGeneralMode
      || !generalRevision || busy || confirming || !isCurrentAccount()
      || privacyEnabled() || !phase2Ready(getAccount().status, org, "generalAccess")) return;
    const policy: CloudWorkspaceGeneralAccess = pendingGeneralMode === "organisation"
      ? { mode: "organisation", role: "read" }
      : { mode: "invited_only" };
    setBusy("general-access");
    setError(null);
    try {
      const receipt = await api.cloudWorkspaceGeneralAccessPut(
        workspaceId, org, { accessRevision: generalRevision, generalAccess: policy }, contextRevision,
      );
      if (!isCurrentAccount()) return;
      setListed((before) => before && { ...before, ...receipt });
      notifyAccessChanged(org);
      await reload();
    } catch (e) {
      if (!isCurrentAccount()) return;
      const code = codeOf(e);
      setError(code === REVISION_CONFLICT
        ? "Workspace access changed. Review the current General access before saving again."
        : code === GENERAL_ACCESS_UNAVAILABLE
          ? "General access is unavailable for this organization."
          : code === "account_context_changed"
            ? "The account session changed during the request. Review the current General access before saving again."
            : shareErrorMessage(e, name));
      if (code === REVISION_CONFLICT || code === OUTCOME_UNKNOWN || code === "account_context_changed") notifyAccessChanged(org);
      await reload();
    } finally {
      if (isCurrentAccount()) {
        setGeneralDraft(null);
        setBusy(null);
      }
    }
  };

  /** Grant the share that a visibility change was made for; a refusal leaves the workspace visible but unshared, and says so. */
  const shareAfterVisible = async (person: Person) => {
    try {
      await writeShare(person);
      setUnshared(null);
      setAdding({ userId: "", role: "viewer", canApprove: false });
    } catch (e) {
      setUnshared({ person, why: shareErrorMessage(e, nameOf(person.userId)) });
      leftOrganization(e, person.userId);
    }
    await reload();
    notifyAccessChanged(org);
  };

  const add = async () => {
    if (!adding.userId || (adding.role === "manager" && !canGrantAdmin())) return;
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
            {offerAdmin && " Admin grants include permission approval."}
          </DialogDescription>
        </DialogHeader>
        {!listed && !loadError && <Loader2 className="size-4 animate-spin" />}
        {loadError && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <p className="flex-1">Could not load who this workspace is shared with ({loadError}).</p>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void reload()}>Try again</Button>
          </div>
        )}
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
                {isPrivate ? "Not shared with anyone." : generalAccess?.mode === "organisation"
                  ? "No individual shares."
                  : "Not shared with anyone yet. Organization admins and the creator always have access."}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline" aria-label="People with access">
                {listed.shares.map((share) => (
                  <li key={share.userId} className="flex items-center gap-2 px-3 py-2" data-testid="cloud-share-row">
                    {profiles && <MemberProfile className="size-7" member={members.find((member) => member.userId === share.userId) ?? { userId: share.userId, email: share.email, displayName: share.name ?? undefined, role: "" }} />}
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
                          onChange={(e) => {
                            const role = e.target.value as CloudShareRole;
                            void put({ ...share, role, canApprove: role === "manager" || share.canApprove });
                          }}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="driver">Driver</option>
                          {offerAdmin ? <option value="manager">{ADMIN_SHARE_LABEL}</option>
                            : share.role === "manager" && <option value="manager" disabled>Admin</option>}
                        </select>
                        <label className="flex items-center gap-1.5 text-muted-foreground">
                          <Switch
                            size="sm"
                            aria-label={`Can approve permissions: ${share.name || share.email}`}
                            checked={share.canApprove}
                            disabled={busy !== null || (share.role === "manager" && share.canApprove)}
                            title={share.role === "manager" && share.canApprove ? MANAGER_APPROVAL_REASON : undefined}
                            aria-description={share.role === "manager" && share.canApprove ? MANAGER_APPROVAL_REASON : undefined}
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
                        {shareRoleLabel(share.role)}
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
                <Button size="sm" variant="outline" onClick={() => loadMembers()}>
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
                  onChange={(e) => {
                    const role = e.target.value as CloudShareRole;
                    setAdding((current) => ({ ...current, role, canApprove: role === "manager" || current.canApprove }));
                  }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="driver">Driver</option>
                  {offerAdmin && <option value="manager">{ADMIN_SHARE_LABEL}</option>}
                </select>
                <label className="flex items-center gap-1.5 text-muted-foreground">
                  <Switch
                    size="sm"
                    aria-label="New person can approve permissions"
                    checked={adding.canApprove}
                    disabled={adding.role === "manager"}
                    title={adding.role === "manager" ? MANAGER_APPROVAL_REASON : undefined}
                    onCheckedChange={(checked) => setAdding((current) => ({ ...current, canApprove: checked }))}
                  />
                  Can approve permissions
                </label>
                <Button
                  size="sm"
                  disabled={!adding.userId || busy !== null || confirming !== null || addBlocked || (adding.role === "manager" && !offerAdmin)}
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
            {generalAccess && (
              <CloudGeneralAccessControls mode={generalAccess.mode} pending={pendingGeneralMode}
                everyone={everyoneLabel} editable={!!generalRevision} disabled={busy !== null || confirming !== null}
                onChoose={(mode) => setGeneralDraft(generalRevision ? { mode, revision: generalRevision } : null)}
                onSave={() => void saveGeneralAccess()} />
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
                  {generalAccess?.mode === "organisation" && "Organization members will lose General access. "}
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
