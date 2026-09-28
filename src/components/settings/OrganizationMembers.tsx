import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isInvitableEmail,
  membersErrorMessage,
  organizationMembers,
  type AssignableRole,
  type IssuedInvite,
  type OrganizationMember,
  type OrganizationRoster,
  type PendingInvite,
} from "@/lib/organizationMembers";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;
const selectClass = "h-7 rounded-md border border-hairline bg-background px-1.5 text-xs disabled:opacity-60";

export function OrganizationMembers({
  accountEmail,
  contextRevision,
}: {
  accountEmail: string;
  /** The account's context revision; a change reloads the roster. */
  contextRevision: string;
}) {
  const [roster, setRoster] = useState<OrganizationRoster | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Drops results that land after the account or organization changed.
  const contextEpoch = useRef(0);
  // Orders roster reads so an older list never overwrites a newer one.
  const loadSeq = useRef(0);

  // A reload after a refused action keeps the refusal on screen.
  const load = useCallback(async (keepError = false) => {
    const current = ++loadSeq.current;
    const context = contextEpoch.current;
    const fresh = () => current === loadSeq.current && context === contextEpoch.current;
    setLoading(true);
    try {
      const next = await organizationMembers.list();
      if (fresh()) {
        setRoster(next);
        if (!keepError) setError(null);
      }
    } catch (failure) {
      if (fresh()) setError(membersErrorMessage(failure));
    } finally {
      if (fresh()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setRoster(null);
    setIssued(null);
    setConfirmRemove(null);
    setBusy(null);
    setError(null);
    void load();
    return () => {
      contextEpoch.current += 1;
    };
  }, [contextRevision, load]);

  const mutate = async (key: string, run: (revision: string) => Promise<OrganizationRoster>) => {
    if (!roster || busy) return null;
    const current = contextEpoch.current;
    setBusy(key);
    setError(null);
    try {
      const next = await run(roster.contextRevision);
      if (current !== contextEpoch.current) return null;
      setRoster(next);
      return next;
    } catch (failure) {
      if (current !== contextEpoch.current) return null;
      setError(membersErrorMessage(failure));
      // The server is authoritative; re-read so the list shows what it holds.
      void load(true);
      return null;
    } finally {
      if (current === contextEpoch.current) setBusy(null);
    }
  };

  const invite = async (address: string, inviteRole: AssignableRole) => {
    const next = await mutate(`invite:${address}`, (revision) => organizationMembers.invite(address, inviteRole, revision));
    if (next?.invite) {
      setIssued(next.invite);
      setCopied(false);
      if (address === email.trim()) setEmail("");
    }
  };

  if (!roster) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        <div className="text-sm font-medium">Members</div>
        {loading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading members…
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <p className="text-xs text-destructive">{error}</p>
            <Button variant="ghost" size="xs" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  const self = accountEmail.trim().toLowerCase();
  const manage = roster.canManageMembers;
  const trimmed = email.trim();
  const emailInvalid = trimmed.length > 0 && !isInvitableEmail(trimmed);
  const alreadyMember = roster.members.some((member) => member.email.toLowerCase() === trimmed.toLowerCase());

  return (
    <div className="rounded-lg border border-hairline p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Members</div>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh members" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      {!manage && (
        <p className="mt-1 text-[11px] text-muted-foreground">Only owners and admins can invite or manage members.</p>
      )}

      <ul aria-label="Organization members" className="mt-2 flex flex-col divide-y divide-hairline">
        {roster.members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            isSelf={member.email.toLowerCase() === self}
            manage={manage}
            busy={busy}
            confirming={confirmRemove === member.userId}
            onRole={(next) => void mutate(`role:${member.userId}`, (revision) => organizationMembers.updateRole(member.userId, next, revision))}
            onRemove={() => setConfirmRemove(member.userId)}
            onCancelRemove={() => setConfirmRemove(null)}
            onConfirmRemove={() =>
              void mutate(`remove:${member.userId}`, (revision) => organizationMembers.remove(member.userId, revision)).then(() => setConfirmRemove(null))
            }
          />
        ))}
      </ul>

      {roster.pendingInvites.length > 0 && (
        <>
          <div className="mt-3 text-xs font-medium text-muted-foreground">Pending invitations</div>
          <ul aria-label="Pending invitations" className="mt-1 flex flex-col divide-y divide-hairline">
            {roster.pendingInvites.map((pending) => (
              <InviteRow
                key={pending.email}
                invite={pending}
                manage={manage}
                busy={busy}
                onResend={() => void invite(pending.email, pending.role === "admin" ? "admin" : "member")}
                onRevoke={() => void mutate(`revoke:${pending.email}`, (revision) => organizationMembers.revokeInvite(pending.email, revision))}
              />
            ))}
          </ul>
        </>
      )}

      {manage && (
        <form
          className="mt-3 flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && !emailInvalid && !alreadyMember) void invite(trimmed, role);
          }}
        >
          <div className="text-xs font-medium text-muted-foreground">Invite by email</div>
          <div className="flex gap-2">
            <input
              aria-label="Invite email"
              type="email"
              placeholder="teammate@example.com"
              className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 text-xs"
              value={email}
              maxLength={320}
              disabled={Boolean(busy)}
              onChange={(event) => setEmail(event.target.value)}
            />
            <select
              aria-label="Invite role"
              className={`${selectClass} h-8`}
              value={role}
              disabled={Boolean(busy)}
              onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button size="sm" className="h-8" type="submit" disabled={Boolean(busy) || !trimmed || emailInvalid || alreadyMember}>
              {busy?.startsWith("invite:") ? <Loader2 className="animate-spin" /> : "Invite"}
            </Button>
          </div>
          {emailInvalid && <p className="text-[11px] text-destructive">Enter a valid email address.</p>}
          {alreadyMember && <p className="text-[11px] text-muted-foreground">That person is already a member.</p>}
          <p className="text-[11px] leading-relaxed text-faint">
            Invitees get no access to workspaces or compute until they accept. Admins can invite, change roles, and remove members.
          </p>
        </form>
      )}

      {issued && <IssuedNotice invite={issued} copied={copied} onCopied={() => setCopied(true)} />}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  manage,
  busy,
  confirming,
  onRole,
  onRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  member: OrganizationMember;
  isSelf: boolean;
  manage: boolean;
  busy: string | null;
  confirming: boolean;
  onRole: (role: AssignableRole) => void;
  onRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const name = member.displayName ?? member.email;
  // The owner is immutable here and nobody edits themselves; the server
  // enforces both, so the controls only mirror it.
  const editable = manage && !isSelf && member.role !== "owner";
  const rowBusy = busy === `role:${member.userId}` || busy === `remove:${member.userId}`;
  return (
    <li className="py-2" aria-label={member.email}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {name}
            {isSelf && <span className="ml-1 font-normal text-faint">(you)</span>}
          </div>
          {member.displayName && <div className="truncate text-[11px] text-muted-foreground">{member.email}</div>}
        </div>
        {rowBusy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {editable ? (
          <>
            <select
              aria-label={`Role for ${member.email}`}
              className={selectClass}
              value={member.role}
              disabled={Boolean(busy)}
              onChange={(event) => onRole(event.target.value === "admin" ? "admin" : "member")}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={onRemove} aria-label={`Remove ${member.email}`}>
              Remove
            </Button>
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">{roleLabel(member.role)}</span>
        )}
      </div>
      {confirming && (
        <div className="mt-2 rounded-md border border-destructive/25 bg-destructive/5 p-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {name} loses access to this organization immediately, including any open cloud workspace connections.
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="destructive" size="xs" disabled={Boolean(busy)} onClick={onConfirmRemove}>
              Confirm removal
            </Button>
            <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={onCancelRemove}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function InviteRow({
  invite,
  manage,
  busy,
  onResend,
  onRevoke,
}: {
  invite: PendingInvite;
  manage: boolean;
  busy: string | null;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const expired = invite.status === "expired";
  return (
    <li className="flex items-center gap-2 py-2" aria-label={invite.email}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs">{invite.email}</div>
        <div className="text-[11px] text-muted-foreground">
          {roleLabel(invite.role)} · {expired ? "Expired" : "Pending"}
          {!expired && invite.expiresAt ? ` until ${new Date(invite.expiresAt).toLocaleDateString()}` : ""}
        </div>
      </div>
      {manage && (
        <>
          <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={onResend} aria-label={`Resend invite to ${invite.email}`}>
            {busy === `invite:${invite.email}` ? <Loader2 className="animate-spin" /> : "Resend"}
          </Button>
          <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={onRevoke} aria-label={`Revoke invite to ${invite.email}`}>
            {busy === `revoke:${invite.email}` ? <Loader2 className="animate-spin" /> : "Revoke"}
          </Button>
        </>
      )}
    </li>
  );
}

function IssuedNotice({ invite, copied, onCopied }: { invite: IssuedInvite; copied: boolean; onCopied: () => void }) {
  if (invite.deduplicated) {
    return <p className="mt-2 text-[11px] text-muted-foreground">An invite to {invite.email} was already sent moments ago.</p>;
  }
  return (
    <div className="mt-2 rounded-md bg-well p-2 text-[11px]" role="status">
      <p className="text-muted-foreground">
        {invite.emailSent
          ? `Invite emailed to ${invite.email}.`
          : `The email to ${invite.email} could not be sent. Share this link with them directly.`}
      </p>
      {invite.inviteUrl && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[10px]">{invite.inviteUrl}</code>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy invite link"
            onClick={() => void navigator.clipboard?.writeText(invite.inviteUrl!).then(onCopied, () => {})}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      )}
    </div>
  );
}
