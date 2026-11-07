import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Loader2, Lock, UserPlus, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAccount } from "@/lib/account";
import {
  api,
  type CloudShareRole,
  type CloudWorkspaceShares,
  type OrganizationGroup,
} from "@/lib/api";
import {
  VISIBILITY_ADMIN_REASON,
  notifyAccessChanged,
} from "@/lib/cloudCollab";
import { loadRosterIn, rememberPeople } from "@/lib/cloudPeople";
import {
  applyShareDraftChanges,
  shareDraft,
  shareDraftDirty,
  reconcileShareDraft,
  shareRowKey,
  type ShareDraft,
  type ShareDraftRow,
} from "@/lib/cloudShareDraft";
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
      if (orgRole === "owner")
        return "Owner (the organization's owner: manages this workspace and who it is shared with)";
      if (orgRole === "admin")
        return "Admin (an organization admin: manages this workspace and who it is shared with)";
      return "Owner or admin of the organization (manages this workspace and who it is shared with)";
    case "driver":
      if (you.canManageShares || creator)
        return "Creator (you created this workspace: can send to agents, type in terminals, approve permissions and manage who it is shared with)";
      // Typing in a terminal (a shell, or an agent's own) needs the approval right too (PRO-88).
      return you.canApprove
        ? `Driver (can send to agents and type in terminals)${approves}`
        : "Driver (can send to agents; typing in terminals also needs the right to approve permissions)";
    case "viewer":
      return `Viewer (can read everything, not send)${approves}`;
    case "none":
      return "No access to this workspace's content";
    default:
      return String(you.role);
  }
}

/** Owners, admins and the workspace's creator see it without a share; the server refuses one for them. */
export function alwaysHasAccess(
  member: { userId: string; role: string },
  createdBy: string | null,
): boolean {
  return (
    member.role === "owner" ||
    member.role === "admin" ||
    (!!createdBy && member.userId === createdBy)
  );
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : String(error);
}

/** What a refused share change means, in words. */
export function shareErrorMessage(error: unknown, who?: string): string {
  const code = codeOf(error);
  switch (code) {
    case "cloud_workspace_share_redundant":
      return `${who ?? "This person"} already has access as owner/admin/creator.`;
    case "cloud_workspace_share_credential_restricted":
      return "Can send is not available here while the organization has an agent login that only owners and admins may use. Share as view only, or share that login with the whole organization first (Settings → Organizations → Agent logins).";
    case "cloud_workspace_share_personal_route":
      return "This workspace was handed its creator's own model credential (Settings → Organizations → Your model access) since it last started, and its sessions may still hold it, so it can't be opened to the organization or shared with Can send yet. Share as view only, or the creator switches that agent to the organization login or a credential helper and then stops and resumes the workspace.";
    case "cloud_workspace_share_requires_organization_access":
      return "Make the workspace visible to the organization first.";
    case "cloud_workspace_group_member_limit":
      return "This group would exceed the workspace runtime’s member limit. Remove members or another group first.";
    case "organization_group_not_found":
      return `${who ?? "This group"} no longer exists in this organization.`;
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

export function CloudShareDialog({
  orgId = null,
  workspaceId,
  name,
  accessMode = "organization",
  createdBy = null,
  canManage: manageHint,
  onClose,
}: {
  orgId?: string | null;
  workspaceId: string;
  name: string;
  accessMode?: AccessMode;
  createdBy?: string | null;
  canManage?: boolean;
  onClose: () => void;
}) {
  const { status } = useAccount();
  const org = orgId ?? status.identity?.organizationId;
  const context = `${status.identity?.email ?? ""}:${org ?? ""}:${workspaceId}`;
  const generation = useRef(0);
  const saving = useRef(false);
  const rosterRequest = useRef(0);
  const groupRequest = useRef(0);
  const [listed, setListed] = useState<CloudWorkspaceShares | null>(null);
  const [base, setBase] = useState<ShareDraft>({
    access: accessMode,
    rows: [],
  });
  const [draft, setDraft] = useState<ShareDraft>({
    access: accessMode,
    rows: [],
  });
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [groups, setGroups] = useState<OrganizationGroup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<
    "share" | "private" | "discard" | null
  >(null);
  const [unknownAccess, setUnknownAccess] = useState(false);
  const [adding, setAdding] = useState({
    id: "",
    role: "viewer" as CloudShareRole,
    canApprove: false,
  });
  const readRoster = useCallback(async () => {
    const current = generation.current;
    const request = ++rosterRequest.current;
    try {
      if (!org) return undefined;
      const next = await loadRosterIn(org, { fresh: true });
      if (current === generation.current && request === rosterRequest.current) {
        setMembers(next);
        setRosterError(null);
        return next;
      }
    } catch (error) {
      if (current === generation.current && request === rosterRequest.current)
        setRosterError(codeOf(error));
    }
    return undefined;
  }, [org]);
  const readGroups = useCallback(async () => {
    const current = generation.current;
    const request = ++groupRequest.current;
    try {
      const next = await api.cloudOrganizationGroups(orgId);
      if (current === generation.current && request === groupRequest.current) {
        setGroups(next.groups);
        setGroupError(null);
        return next.groups;
      }
    } catch (error) {
      if (current === generation.current && request === groupRequest.current)
        setGroupError(codeOf(error));
    }
    return undefined;
  }, [orgId]);
  useEffect(() => {
    const current = ++generation.current;
    saving.current = false;
    setBusy(false);
    setListed(null);
    setLoadError(null);
    setMembers([]);
    setGroups([]);
    setGroupError(null);
    setErrors([]);
    setConfirming(null);
    setUnknownAccess(false);
    setBase({ access: accessMode, rows: [] });
    setDraft({ access: accessMode, rows: [] });
    void api.cloudWorkspaceShares(workspaceId, orgId).then(
      (next) => {
        if (current !== generation.current) return;
        rememberPeople(next.shares);
        setListed(next);
        setBase(shareDraft(next, accessMode));
        setDraft(shareDraft(next, accessMode));
      },
      (error: unknown) => {
        if (current === generation.current) setLoadError(codeOf(error));
      },
    );
    void readRoster();
    void readGroups();
    return () => {
      generation.current++;
    };
  }, [context, workspaceId, orgId, accessMode, readRoster, readGroups]);

  const manage = listed?.you.canManageShares ?? false;
  const mayChangeVisibility = listed?.you.role === "manager";
  const unknownShares = !!base.unresolved?.length;
  const dirty = unknownAccess || shareDraftDirty(base, draft);
  const me = members.find(
    (member) => member.email === status.identity?.email,
  )?.userId;
  const creator = createdBy && me ? createdBy === me : null;
  const orgRole =
    status.organizations?.find((candidate) => candidate.id === org)?.role ??
    members.find((member) => member.userId === me)?.role ??
    null;
  const candidates: ShareDraftRow[] = [
    ...members
      .filter((member) => !alwaysHasAccess(member, createdBy))
      .map(
        (member): ShareDraftRow => ({
          kind: "person",
          id: member.userId,
          name: member.displayName || member.email,
          role: adding.role,
          canApprove: adding.canApprove,
        }),
      ),
    ...groups.map(
      (group): ShareDraftRow => ({
        kind: "group",
        id: group.id,
        name: group.name,
        memberCount: group.memberCount,
        role: adding.role,
        canApprove: adding.canApprove,
      }),
    ),
  ].filter(
    (row) =>
      !draft.rows.some(
        (existing) => shareRowKey(existing) === shareRowKey(row),
      ),
  );
  const update = (row: ShareDraftRow) =>
    setDraft((before) => ({
      ...before,
      rows: before.rows.map((item) =>
        shareRowKey(item) === shareRowKey(row) ? row : item,
      ),
    }));
  const stageAdd = () => {
    const row = candidates.find((item) => shareRowKey(item) === adding.id);
    if (!row) return;
    if (draft.access === "private" && confirming !== "share") {
      setConfirming("share");
      return;
    }
    setDraft((before) => ({
      access: "organization",
      rows: [...before.rows, row],
    }));
    setAdding({ id: "", role: "viewer", canApprove: false });
    setConfirming(null);
  };
  const requestClose = () => {
    if (saving.current) return;
    if (dirty) setConfirming("discard");
    else onClose();
  };
  const readAccess = async () =>
    (await api.cloudWorkspaces(orgId)).workspaces.find(
      (item) => item.workspace.id === workspaceId,
    )?.workspace.accessMode;
  const reconcile = async (
    saved: ShareDraft,
    intended: ShareDraft,
    lifecycle = false,
  ) => {
    const current = generation.current;
    const [actual, roster, latestGroups] = await Promise.all([
      api.cloudWorkspaceShares(workspaceId, orgId),
      lifecycle ? readRoster() : Promise.resolve(undefined),
      lifecycle ? readGroups() : Promise.resolve(undefined),
    ]);
    if (current !== generation.current) return undefined;
    const absent = new Set(
      intended.rows
        .filter((row) =>
          row.kind === "person"
            ? roster !== undefined &&
              !roster.some((member) => member.userId === row.id)
            : latestGroups !== undefined &&
              !latestGroups.some((group) => group.id === row.id),
        )
        .map(shareRowKey),
    );
    const result = reconcileShareDraft(
      saved,
      intended,
      shareDraft(actual, saved.access),
      absent,
    );
    rememberPeople(actual.shares);
    setListed(actual);
    setDraft(result.draft);
    return result.saved;
  };
  const save = async () => {
    if (saving.current || !manage || !dirty || unknownAccess || unknownShares)
      return;
    saving.current = true;
    setBusy(true);
    setErrors([]);
    const current = generation.current;
    const valid = () => current === generation.current;
    let saved = base;
    const failures: string[] = [];
    try {
      if (saved.access !== draft.access) {
        try {
          const next = await api.cloudWorkspaceSetAccess(
            workspaceId,
            draft.access,
            orgId,
          );
          if (next.accessMode !== draft.access)
            throw new Error("Visibility did not change");
        } catch (error) {
          if (codeOf(error) !== "cloud_workspace_request_outcome_unknown")
            throw error;
          const actual = await readAccess().catch(() => undefined);
          if (!valid()) return;
          if (!actual) {
            setUnknownAccess(true);
            throw error;
          }
          saved = { ...saved, access: actual };
          if (actual !== draft.access) throw error;
        }
        saved = {
          ...saved,
          access: draft.access,
          rows: draft.access === "private" ? [] : saved.rows,
        };
        if (valid()) setBase(saved);
        if (draft.access === "private") {
          if (valid()) {
            setDraft(saved);
            notifyAccessChanged(org);
            if (creator === false) onClose();
          }
          return;
        }
      }
      const result = await applyShareDraftChanges(
        saved,
        draft,
        async (change) => {
          if (!valid()) throw new Error("Account or organization changed");
          const row = change.after ?? change.before!;
          if (row.kind === "group")
            return api.cloudWorkspaceGroupShareSet(
              workspaceId,
              row.id,
              change.after?.role ?? null,
              change.after?.canApprove ?? false,
              orgId,
            );
          if (change.after)
            return api.cloudWorkspaceSharePut(
              workspaceId,
              row.id,
              row.role,
              row.canApprove,
              orgId,
            );
          try {
            return await api.cloudWorkspaceShareRevoke(
              workspaceId,
              row.id,
              orgId,
            );
          } catch (error) {
            if (codeOf(error) !== "cloud_workspace_share_not_found")
              throw error;
          }
        },
        (error) => shareErrorMessage(error),
      );
      if (!valid()) return;
      saved = result.saved;
      failures.push(...result.failures);
      const lifecycle = result.failedChanges.some(({ error }) =>
        [
          "organization_member_not_found",
          "organization_group_not_found",
        ].includes(codeOf(error)),
      );
      if (saved.unresolved?.length || lifecycle) {
        try {
          saved = (await reconcile(saved, draft, lifecycle)) ?? saved;
        } catch (error) {
          failures.push(
            `Could not refresh access: ${shareErrorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      failures.push(`Workspace visibility: ${shareErrorMessage(error)}`);
    } finally {
      if (valid()) {
        setBase(saved);
        setErrors(failures);
        setBusy(false);
        notifyAccessChanged(org);
      }
      if (valid()) saving.current = false;
    }
  };
  const recheckShares = async () => {
    if (saving.current) return;
    const current = generation.current;
    saving.current = true;
    setBusy(true);
    try {
      const next = await reconcile(base, draft, true);
      if (next) {
        setBase(next);
        setErrors([]);
      }
    } catch (error) {
      if (current === generation.current) setErrors([shareErrorMessage(error)]);
    } finally {
      if (current === generation.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  };
  const recheck = async () => {
    const current = generation.current;
    setBusy(true);
    try {
      const actual = await readAccess();
      if (current !== generation.current) return;
      if (!actual) throw new Error("Workspace could not be read");
      setBase((before) => ({
        ...before,
        access: actual,
        rows: actual === "private" ? [] : before.rows,
      }));
      setUnknownAccess(false);
      setErrors([]);
    } catch (error) {
      if (current === generation.current) setErrors([shareErrorMessage(error)]);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const select =
    "rounded-md border border-hairline bg-transparent px-2 py-1 text-xs";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        width="max-w-[36rem]"
        data-testid="cloud-share-dialog"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {(listed ? manage : manageHint)
              ? `Share ${name}`
              : "Who has access"}
          </DialogTitle>
          <DialogDescription>
            People with access to {name} see its agent tabs, terminals, files
            and Git. Drivers can also send to agents, and type in terminals if
            they can approve permissions. Access changes apply when you save.
          </DialogDescription>
        </DialogHeader>
        {!listed && !loadError && <Loader2 className="size-4 animate-spin" />}
        {loadError && <p role="alert">Could not load access ({loadError}).</p>}
        {listed && (
          <div className="flex flex-col gap-3 text-xs">
            <p data-testid="cloud-share-you">
              Your access: {yourAccessText(listed.you, orgRole, creator)}.
            </p>
            {draft.access === "private" && (
              <p data-testid="cloud-share-private">
                This workspace is private: only its creator can see it. Sharing
                makes it visible in the organization's sidebar. The people and
                groups you add and organization admins can open it; other
                members see only that it exists.
                {!mayChangeVisibility && ` ${VISIBILITY_ADMIN_REASON}.`}
              </p>
            )}
            {unknownAccess && (
              <div role="alert" data-testid="cloud-share-access-unknown">
                The server did not answer. Check visibility before saving again.
                <Button disabled={busy} onClick={() => void recheck()}>
                  Check again
                </Button>
              </div>
            )}
            {unknownShares && (
              <div role="alert" data-testid="cloud-share-rows-unknown">
                Some access changes could not be confirmed. Check access before
                saving again.
                <Button disabled={busy} onClick={() => void recheckShares()}>
                  Check access
                </Button>
              </div>
            )}
            {!draft.rows.length && (
              <p>
                Not shared with anyone. Organization admins and the creator have
                access when visible to the organization.
              </p>
            )}
            <ul
              aria-label="People and groups with access"
              className="flex flex-col divide-y divide-hairline rounded-md border border-hairline"
            >
              {draft.rows.map((row) => (
                <li
                  key={shareRowKey(row)}
                  className="flex flex-wrap items-center gap-2 px-3 py-2"
                  data-testid="cloud-share-row"
                >
                  <div className="min-w-0 flex-1">
                    <span>{row.name}</span>
                    {row.kind === "group" && (
                      <span className="ml-2 text-muted-foreground">
                        Group · {row.memberCount} members
                      </span>
                    )}
                  </div>
                  {manage ? (
                    <>
                      <select
                        aria-label={`Role for ${row.name}`}
                        className={select}
                        value={row.role}
                        disabled={busy}
                        onChange={(event) =>
                          update({
                            ...row,
                            role: event.target.value as CloudShareRole,
                          })
                        }
                      >
                        <option value="viewer">Viewer</option>
                        <option value="driver">Driver</option>
                      </select>
                      <label>
                        <Switch
                          size="sm"
                          aria-label={`Can approve permissions: ${row.name}`}
                          checked={row.canApprove}
                          disabled={busy}
                          onCheckedChange={(checked) =>
                            update({ ...row, canApprove: checked })
                          }
                        />{" "}
                        Can approve permissions
                      </label>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Revoke ${row.name}`}
                        disabled={busy}
                        onClick={() =>
                          setDraft((before) => ({
                            ...before,
                            rows: before.rows.filter(
                              (item) => shareRowKey(item) !== shareRowKey(row),
                            ),
                          }))
                        }
                      >
                        <X />
                      </Button>
                    </>
                  ) : (
                    <span>
                      {row.role === "driver" ? "Driver" : "Viewer"}
                      {row.canApprove ? " · can approve" : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {rosterError && (
              <p role="alert" data-testid="cloud-share-roster-error">
                Could not load this organization's members ({rosterError}).{" "}
                <Button onClick={() => void readRoster()}>Retry</Button>
              </p>
            )}
            {groupError && (
              <p role="alert">
                Could not load groups ({groupError}). Existing shares can still
                be changed.
              </p>
            )}
            {manage && (
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="cloud-share-add"
              >
                <select
                  aria-label="Add person or group"
                  className={`${select} min-w-0 flex-1`}
                  value={adding.id}
                  disabled={busy}
                  onChange={(event) =>
                    setAdding((before) => ({
                      ...before,
                      id: event.target.value,
                    }))
                  }
                >
                  <option value="">Add person or group…</option>
                  {candidates.map((row) => (
                    <option key={shareRowKey(row)} value={shareRowKey(row)}>
                      {row.name}
                      {row.kind === "group"
                        ? ` (Group · ${row.memberCount} members)`
                        : ""}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="New share role"
                  className={select}
                  value={adding.role}
                  disabled={busy}
                  onChange={(event) =>
                    setAdding((before) => ({
                      ...before,
                      role: event.target.value as CloudShareRole,
                    }))
                  }
                >
                  <option value="viewer">Viewer</option>
                  <option value="driver">Driver</option>
                </select>
                <label>
                  <Switch
                    size="sm"
                    aria-label="New share can approve permissions"
                    checked={adding.canApprove}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setAdding((before) => ({
                        ...before,
                        canApprove: checked,
                      }))
                    }
                  />{" "}
                  Can approve permissions
                </label>
                <Button
                  size="sm"
                  disabled={
                    !adding.id ||
                    busy ||
                    unknownAccess ||
                    (draft.access === "private" && !mayChangeVisibility)
                  }
                  onClick={stageAdd}
                >
                  <UserPlus /> Add
                </Button>
              </div>
            )}
            {manage && draft.access === "organization" && (
              <div className="flex items-center gap-2">
                <span>
                  Visible in the organization's sidebar.
                  {!mayChangeVisibility && ` ${VISIBILITY_ADMIN_REASON}.`}
                </span>
                <Button
                  variant="outline"
                  disabled={busy || !mayChangeVisibility}
                  onClick={() => setConfirming("private")}
                >
                  <Lock /> Make private again
                </Button>
              </div>
            )}
            {confirming === "share" && (
              <div
                role="alertdialog"
                aria-label="Make visible and share"
                data-testid="cloud-share-confirm"
              >
                <p>
                  Make {name} visible to the organization and share it when you
                  save?
                </p>
                <Button variant="ghost" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button onClick={stageAdd}>Make visible and share</Button>
              </div>
            )}
            {confirming === "private" && (
              <div
                role="alertdialog"
                aria-label="Make this workspace private again"
                data-testid="cloud-private-confirm"
              >
                <p>
                  Make {name} private again? All direct and group shares will be
                  revoked when you save. Everyone else's open sessions close,
                  including admins.
                  {creator === false
                    ? " You did not create it, so you will stop seeing it too."
                    : " Only its creator will still see it."}
                </p>
                <Button variant="ghost" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDraft({ access: "private", rows: [] });
                    setConfirming(null);
                  }}
                >
                  Revoke all and make private
                </Button>
              </div>
            )}
            {confirming === "discard" && (
              <div role="alertdialog" aria-label="Discard access changes?">
                <p>Discard access changes?</p>
                <Button onClick={() => setConfirming(null)}>
                  Keep editing
                </Button>
                <Button variant="destructive" onClick={onClose}>
                  Discard
                </Button>
              </div>
            )}
            {errors.length > 0 && (
              <ul role="alert" data-testid="cloud-share-error">
                {errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            )}
            {manage && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={busy} onClick={requestClose}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    busy ||
                    !dirty ||
                    unknownAccess ||
                    unknownShares ||
                    confirming !== null
                  }
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
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
