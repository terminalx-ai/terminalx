import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Lock, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MemberProfile } from "@/components/people/MemberProfile";
import { useAccount } from "@/lib/account";
import { api, type CloudShareRole, type CloudWorkspaceShares } from "@/lib/api";
import { notifyAccessChanged, VISIBILITY_ADMIN_REASON } from "@/lib/cloudCollab";
import { buildShareRequest, pendingShareEdits, rebaseShareEdits, replaceShareEdit, shareRowKey, shareRows, type ShareEdit, type ShareRow } from "@/lib/cloudShareDraft";
import { alwaysHasAccess, codeOf, MANAGER_APPROVAL_REASON, OUTCOME_UNKNOWN, shareErrorMessage, shareRoleLabel, yourAccessText } from "@/lib/cloudShareLabels";
import { loadRoster, loadRosterIn, rememberPeople } from "@/lib/cloudPeople";
import { featureFlags, useFeatureFlag } from "@/lib/featureFlags";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { readOrganizationRoster, useOrganizationRoster } from "@/lib/organizationRoster";
import type { Access, AccessMode, ShareDialogProps } from "./CloudShareDialog";
import { CloudShareSearch } from "./CloudShareSearch";

type EditorProps = ShareDialogProps & { orgId: string; organization: string; orgRole: string | null; contextRevision: string };
type ShareAttempt = ReturnType<typeof buildShareRequest>;
type RevisionedShares = CloudWorkspaceShares & { accessRevision: string };

export function CloudShareEditor({ orgId, organization, orgRole, contextRevision, workspaceId, name, accessMode = "organization", createdBy, canManage, onClose }: EditorProps) {
  const { status } = useAccount();
  const profiles = useFeatureFlag(featureFlags.teamRoster, orgId);
  const active = status.identity?.organizationId === orgId;
  const roster = useOrganizationRoster(orgId, profiles);
  const [legacyMembers, setLegacyMembers] = useState<OrganizationMember[]>([]);
  const [legacyRosterFailed, setLegacyRosterFailed] = useState(false);
  const members = profiles ? roster.roster?.members ?? [] : legacyMembers;
  const rosterFailed = profiles ? !!roster.error : legacyRosterFailed;

  const [listed, setListed] = useState<RevisionedShares | null>(null);
  const [access, setAccess] = useState<Access>(accessMode);
  const [edits, setEdits] = useState<ShareEdit[]>([]);
  const [attempt, setAttempt] = useState<ShareAttempt | null>(null);
  const [failures, setFailures] = useState<{ key: string; name: string; message: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [becameVisible, setBecameVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "visible" | "private" | null>(null);
  const inFlight = useRef(false);
  const current = useRef(false);

  const loadMembers = useCallback((fresh: boolean) => {
    if (profiles) return readOrganizationRoster(orgId, { fresh, active, contextRevision }).then(() => {});
    setLegacyRosterFailed(false);
    return (active ? loadRoster({ fresh: true }) : loadRosterIn(orgId, { fresh: true })).then(
      (value) => { if (current.current) setLegacyMembers(value); },
      () => { if (current.current) setLegacyRosterFailed(true); },
    );
  }, [orgId, active, profiles, contextRevision]);

  const readShares = useCallback(async (): Promise<RevisionedShares> => {
    const next = await api.cloudWorkspaceShares(workspaceId, orgId, contextRevision);
    if (!next.accessRevision || !Array.isArray(next.groupShares)) throw new Error("cloud_workspace_groups_unavailable");
    return { ...next, accessRevision: next.accessRevision };
  }, [workspaceId, orgId, contextRevision]);

  useEffect(() => {
    current.current = true;
    let reading = true;
    void readShares().then(
      (next) => { if (reading) { rememberPeople(next.shares); setListed(next); } },
      (e: unknown) => { if (reading) setError(`Could not load who has access (${codeOf(e)}).`); },
    );
    return () => { current.current = false; reading = false; };
  }, [readShares]);

  useEffect(() => { void loadMembers(false).catch(() => {}); }, [loadMembers]);

  const base = useMemo(() => listed ? shareRows(listed) : [], [listed]);
  const pending = pendingShareEdits(base, edits);
  const byKey = new Map(pending.map((edit) => [shareRowKey(edit.row), edit]));
  const baseKeys = new Set(base.map(shareRowKey));
  const rows = [...base.map((row) => byKey.get(shareRowKey(row))?.row ?? row), ...pending.filter((edit) => !baseKeys.has(shareRowKey(edit.row))).map((edit) => edit.row)];
  const shared = new Set(rows.filter((row) => byKey.get(shareRowKey(row))?.op !== "remove").map(shareRowKey));
  const people = members.filter((member) => !alwaysHasAccess(member, createdBy ?? null) && !shared.has(`user:${member.userId}`))
    .map((member): ShareRow => ({
      subject: { type: "user", id: member.userId },
      name: member.displayName || member.email,
      detail: member.displayName ? member.email : undefined,
      role: "viewer",
      canApprove: false,
    }));
  const manage = listed?.you.canManageShares ?? false;
  const canChangeVisibility = listed?.you.role === "manager" && manage;
  const email = status.identity?.email;
  const self = members.find((member) => member.email === email);
  const creator = createdBy && self ? createdBy === self.userId : null;
  const mayEdit = manage && access !== "unknown" && (access !== "private" || canChangeVisibility);
  const locked = working || !!confirm || !!attempt || refreshRequired;
  const dirty = pending.length > 0 || !!attempt;

  const stage = (row: ShareRow, op?: ShareEdit["op"]) => {
    if (!mayEdit || locked) return;
    setEdits((previous) => pendingShareEdits(base, replaceShareEdit(previous, row, op)));
    setFailures((previous) => previous.filter((failure) => failure.key !== shareRowKey(row)));
    setNotice(null);
    setError(null);
  };

  const close = () => {
    if (inFlight.current) return;
    if (dirty) setConfirm("discard");
    else onClose();
  };

  const run = async (operation: () => Promise<void>) => {
    if (inFlight.current || !current.current) return;
    inFlight.current = true;
    setWorking(true);
    setError(null);
    try {
      await operation();
    } finally {
      inFlight.current = false;
      if (current.current) setWorking(false);
    }
  };

  const accept = (next: RevisionedShares, remaining: ShareEdit[]) => {
    rememberPeople(next.shares);
    setListed(next);
    setEdits(pendingShareEdits(shareRows(next), remaining));
    setRefreshRequired(false);
  };

  const refresh = async () => {
    try {
      const next = await readShares();
      if (!current.current) return;
      accept(next, rebaseShareEdits(base, shareRows(next), pending));
      if (refreshRequired && pending.length) setNotice("Access refreshed. Review the unsaved changes before saving.");
    } catch (e) {
      if (!current.current) return;
      if (codeOf(e) === "cloud_workspace_not_found") {
        setListed(null);
        setRefreshRequired(false);
      }
      setError(`Could not refresh access (${codeOf(e)}).`);
    }
  };

  const apply = async (snapshot: RevisionedShares, batch: ShareAttempt) => {
    setNotice(null);
    try {
      const result = await api.cloudWorkspaceSharesApply(workspaceId, orgId, batch.request, contextRevision);
      if (!current.current) return;
      const failures = result.results.flatMap((result, index) => {
        if (result.status === "applied") return [];
        const { row } = batch.ordered[index];
        const message = result.code === "cloud_workspace_share_limit" || result.code === "cloud_workspace_group_share_not_found"
          || result.code === "organization_group_not_found" || result.code === "cloud_workspace_unknown_error"
          ? result.message : shareErrorMessage(result, row.name);
        return [{ key: shareRowKey(row), name: row.name, message }];
      });
      const failed = new Set(failures.map((failure) => failure.key));
      const remaining = batch.ordered.filter(({ row }) => failed.has(shareRowKey(row)));
      setAttempt(null);
      setFailures(failures);
      // The apply snapshot is authoritative for the batch, including receipts
      // replayed after a lost reply. Recheck standing and concurrent writes
      // before allowing a new batch from this editor.
      const updated = { you: snapshot.you, shares: result.shares, groupShares: result.groupShares, accessRevision: result.accessRevision };
      accept(updated, remaining);
      const applied = result.results.length - failures.length;
      if (applied > 0) notifyAccessChanged(orgId);
      setNotice(failures.length ? `${applied} of ${result.results.length} changes saved.` : "Access changes saved.");
      try {
        const next = await readShares();
        if (current.current) accept(next, rebaseShareEdits(shareRows(updated), shareRows(next), remaining));
      } catch (e) {
        if (!current.current) return;
        setRefreshRequired(true);
        if (codeOf(e) === "cloud_workspace_not_found") {
          setListed(null);
          setError("You no longer have access to this workspace.");
        } else {
          setError("Refresh access before making more changes.");
        }
      }
    } catch (e) {
      if (!current.current) return;
      const code = codeOf(e);
      if (code === OUTCOME_UNKNOWN || (typeof e === "object" && e !== null && "retryWithSameIdempotencyKey" in e && e.retryWithSameIdempotencyKey)) {
        setAttempt(batch);
        setError("The server did not confirm whether these changes were saved. Retry the same changes to check.");
        return;
      }
      setAttempt(null);
      if (code === "cloud_workspace_access_revision_conflict") {
        setRefreshRequired(true);
        setError("Workspace access changed while you were editing. Refresh access and review your changes before saving.");
      } else if (code === "account_context_changed" || code === "cloud_workspace_groups_unavailable" || code === "cloud_workspace_share_forbidden" || code === "cloud_workspace_not_found" || code === "idempotency_key_reused") {
        setRefreshRequired(true);
        setError(code === "cloud_workspace_share_forbidden" ? "You no longer have permission to manage access to this workspace." : shareErrorMessage(e));
      } else {
        setError(shareErrorMessage(e));
      }
    }
  };

  const switchVisibility = async (mode: AccessMode): Promise<Access> => {
    try {
      const result = await api.cloudWorkspaceSetAccess(workspaceId, mode, orgId, contextRevision);
      if (!current.current) return "unknown";
      setAccess(result.accessMode);
      notifyAccessChanged(orgId);
      return result.accessMode;
    } catch (e) {
      if (!current.current) return "unknown";
      if (codeOf(e) !== OUTCOME_UNKNOWN) {
        setError(shareErrorMessage(e));
        return access;
      }
      setAccess("unknown");
      setError("The server did not confirm the workspace’s visibility. Check visibility before changing access.");
      return "unknown";
    }
  };

  const checkVisibility = async () => {
    try {
      const result = await api.cloudWorkspaces(orgId);
      const mode = result.workspaces.find(({ workspace }) => workspace.id === workspaceId)?.workspace.accessMode;
      if (!current.current) return;
      if (mode) {
        setAccess(mode);
        notifyAccessChanged(orgId);
        await refresh();
        return;
      }
    } catch {
      if (!current.current) return;
    }
    setError("Could not confirm the workspace’s visibility.");
  };

  const save = () => {
    if (!listed || !mayEdit || working || refreshRequired || confirm) return;
    if (attempt) {
      void run(() => apply(listed, attempt));
      return;
    }
    if (pending.length === 0 || pending.length > 128) return;
    if (access === "private") setConfirm("visible");
    else void run(() => apply(listed, buildShareRequest(listed.accessRevision, pending)));
  };

  const makeVisibleAndSave = () => {
    setConfirm(null);
    void run(async () => {
      if (await switchVisibility("organization") !== "organization" || !current.current) return;
      setBecameVisible(true);
      try {
        const next = await readShares();
        if (!current.current) return;
        const remaining = rebaseShareEdits(base, shareRows(next), pending);
        accept(next, remaining);
        if (remaining.length && next.you.canManageShares) await apply(next, buildShareRequest(next.accessRevision, remaining));
      } catch (e) {
        if (!current.current) return;
        setRefreshRequired(true);
        setError(`The workspace is visible. Refresh access before saving (${codeOf(e)}).`);
      }
    });
  };

  const makePrivate = () => {
    setConfirm(null);
    void run(async () => {
      if (await switchVisibility("private") !== "private" || !current.current) return;
      setBecameVisible(false);
      if (creator === false) { onClose(); return; }
      setNotice(null);
      setFailures([]);
      setRefreshRequired(true);
      await refresh();
    });
  };

  const select = "max-w-full rounded-md border border-hairline bg-transparent px-2 py-1 text-xs";
  const title = (listed ? manage : canManage) ? `Share ${name}` : "Who has access";
  const pendingLabel = `${pending.length} unsaved ${pending.length === 1 ? "change" : "changes"}`;
  const confirmationTitle = confirm === "discard" ? "Discard access changes?" : confirm === "visible" ? "Make workspace visible and save?" : "Make workspace private?";
  const cannotSave = working || !!confirm || refreshRequired || !mayEdit || (!attempt && (pending.length === 0 || pending.length > 128));

  return <Dialog open onOpenChange={(open) => { if (!open && !confirm) close(); }}>
    <DialogContent width="max-w-[36rem]" data-testid="cloud-share-dialog">
      <DialogHeader>
        <div className="flex items-start justify-between gap-2 pr-6">
          <DialogTitle className="min-w-0 break-words">{title}</DialogTitle>
          {manage && <Button size="sm" className="shrink-0" disabled={cannotSave} onClick={save}>{attempt ? "Retry save" : "Save"}</Button>}
        </div>
        <DialogDescription>People with access see agent tabs, terminals, files and Git. Drivers can send to agents. Typing in terminals also needs permission approval.</DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 flex-col gap-3 text-xs" data-testid="cloud-share-editor">
        {!listed && !error && <Loader2 className="size-4 animate-spin" aria-label="Loading access" />}
        {listed && <>
          {mayEdit && <CloudShareSearch {...{ orgId, organization, contextRevision, people, shared }}
            disabled={locked} onSelect={(row) => stage(row, "put")} />}
          {manage && rosterFailed && <div className="flex items-center justify-between gap-2 text-muted-foreground" role="alert">
            Could not load organization members.
            <Button size="sm" variant="outline" disabled={working} onClick={() => void loadMembers(true).catch(() => {})}>Retry members</Button>
          </div>}
          <p className="text-muted-foreground" data-testid="cloud-share-you">
            Your access: {yourAccessText(listed.you, orgRole ?? self?.role ?? null, creator)}.
          </p>
          {rows.length > 0 ? <>
            <h3 className="font-medium">People and groups with access</h3>
            <ul className="divide-y divide-hairline rounded-md border border-hairline" aria-label="People and groups with access">
              {rows.map((row) => {
                const key = shareRowKey(row);
                const removed = byKey.get(key)?.op === "remove";
                return <li key={key} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2" data-testid="cloud-share-row">
                  {profiles && row.subject.type === "user" && <MemberProfile className="size-7" member={members.find((member) => member.userId === row.subject.id)
                    ?? { userId: row.subject.id, email: row.detail ?? row.name, displayName: row.detail ? row.name : undefined, role: "" }} />}
                  <div className="min-w-0 flex-[1_1_8rem]" title={row.name}>
                    <span className={`block truncate text-sm ${removed ? "line-through" : ""}`}>{row.name}</span>
                    {row.detail && <span className="block truncate text-muted-foreground">{row.detail}</span>}
                  </div>
                  <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    {mayEdit && removed ? <>
                      <span className="text-muted-foreground">Removing access</span>
                      <Button size="sm" variant="ghost" disabled={locked} onClick={() => stage(row)}>Undo</Button>
                    </> : mayEdit ? <>
                      <select className={select} aria-label={`Role for ${row.name}`} value={row.role} disabled={locked}
                        onChange={(e) => {
                          const role = e.target.value as CloudShareRole;
                          stage({ ...row, role, canApprove: role === "manager" || row.canApprove }, "put");
                        }}>
                        <option value="viewer">Viewer</option>
                        <option value="driver">Driver</option>
                        <option value="manager">Admin</option>
                      </select>
                      <label className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <Switch size="sm" aria-label={`Can approve permissions: ${row.name}`} checked={row.canApprove}
                          disabled={locked || row.role === "manager"} title={row.role === "manager" ? MANAGER_APPROVAL_REASON : undefined}
                          onCheckedChange={(canApprove) => stage({ ...row, canApprove }, "put")} />
                        Can approve permissions
                      </label>
                      <Button size="icon-xs" variant="ghost" aria-label={`Revoke ${row.name}`} disabled={locked}
                        onClick={() => stage(row, "remove")}><X /></Button>
                    </> : <span className="text-muted-foreground">{shareRoleLabel(row.role)}{row.canApprove ? " · can approve" : ""}</span>}
                  </div>
                </li>;
              })}
            </ul>
          </> : <p className="text-muted-foreground">
            {access === "private" ? "Only the creator can see this private workspace." : "No people or groups have been added. Organization admins and the creator already have access."}
          </p>}
          {access === "organization" && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3 text-muted-foreground">
            <span>{becameVisible ? "Workspace is now visible in the organization’s sidebar." : "Visible in the organization’s sidebar."}</span>
            {canChangeVisibility && <Button size="sm" variant="outline" disabled={locked || dirty} onClick={() => setConfirm("private")}>
              <Lock className="size-3.5" /> Make private again
            </Button>}
          </div>}
          {access === "private" && !canChangeVisibility && <p className="text-muted-foreground">{VISIBILITY_ADMIN_REASON}.</p>}
        </>}
        {failures.length > 0 && <div role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-destructive">
          <p>Could not save these changes</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {failures.map((failure) => <li key={failure.key} className="break-words"><strong>{failure.name}</strong> · {failure.message}</li>)}
          </ul>
        </div>}
        {error && <p className="break-words text-destructive" role="alert">{error}</p>}
        {notice && <p className="text-muted-foreground" role="status">{notice}</p>}
        {access === "unknown" && <Button size="sm" variant="outline" disabled={working} onClick={() => void run(checkVisibility)}>Check visibility</Button>}
        {access !== "unknown" && (refreshRequired || (!listed && error)) && <Button size="sm" variant="outline" disabled={working} onClick={() => void run(refresh)}>Refresh access</Button>}
        {manage && dirty && <p className="border-t border-hairline pt-3 text-warning" aria-live="polite">
          {attempt ? "Save outcome unknown" : pending.length > 128 ? "Save up to 128 changes at a time." : `${pendingLabel} · nothing changes until you press Save`}
        </p>}
      </div>

      {confirm && <Dialog open onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent showClose={false} width="max-w-[28rem]">
          <DialogHeader>
            <DialogTitle>{confirmationTitle}</DialogTitle>
            <DialogDescription>
              {confirm === "discard" ? attempt ? "The save may have reached the server. Closing ends this retry." : "Your unsaved changes will be lost."
                : confirm === "visible" ? "The workspace will appear in every member’s sidebar. The people and groups you add, the creator and organization admins can open it."
                : "Making the workspace private revokes all people and group grants and closes their connections. Only its creator will still see it."}
            </DialogDescription>
          </DialogHeader>
          {confirm === "discard" && <ul className="max-h-36 list-disc space-y-1 overflow-y-auto break-words pl-5 text-sm">
            {pending.map(({ row, op }) => <li key={shareRowKey(row)}>
              {row.name}{row.subject.type === "group" ? " (Group)" : ""} · {op === "remove" ? "Remove access"
                : `${baseKeys.has(shareRowKey(row)) ? "Change to" : "Add as"} ${shareRoleLabel(row.role)}${row.canApprove ? ", can approve permissions" : ", approval off"}`}
            </li>)}
          </ul>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" autoFocus onClick={() => setConfirm(null)}>{confirm === "discard" ? "Keep editing" : "Cancel"}</Button>
            <Button size="sm" variant={confirm === "visible" ? "default" : "destructive"}
              onClick={confirm === "discard" ? onClose : confirm === "visible" ? makeVisibleAndSave : makePrivate}>
              {confirm === "discard" ? "Discard changes" : confirm === "visible" ? "Make visible and save" : "Make private"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>}
    </DialogContent>
  </Dialog>;
}
