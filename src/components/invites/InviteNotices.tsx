import { useEffect } from "react";
import { CheckCircle2, Clock, UserPlus, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { dismissJoined, dismissKept, dismissNoticed, openInvite, useInvites } from "@/lib/myInvites";
import { organizationSwitchTargets, switchOrganization } from "@/lib/organizationVisibility";
import { useOrganizationSwitchingEnabled } from "@/lib/organizationVisibilityGate";

/** How long "kept for later" stays before it goes by itself. */
export const KEPT_NOTICE_MS = 8000;

const dayMonth = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function Dismiss({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Dismiss" onClick={onClick} className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
      <X className="size-3.5" />
    </button>
  );
}

/** A new invitation (opens its card on a click), "<org> invitation kept for later" (12.20) and "You joined <org>" (01.08). */
export function InviteNotices() {
  const { kept, joined, noticed, invites, open } = useInvites();
  const invitation = noticed && !open ? invites.find((invite) => invite.id === noticed) : undefined;
  const { status } = useAccount();
  const switching = useOrganizationSwitchingEnabled();

  useEffect(() => {
    if (!kept) return;
    const timer = window.setTimeout(dismissKept, KEPT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [kept]);

  // The joined organization shows once the roles are read again; only then can it be switched to.
  const canSwitch = Boolean(joined && switching && organizationSwitchTargets(status).some((target) => target.id === joined.organizationId));

  return (
    <>
      {invitation && (
        <div role="status" aria-label={`Invitation to ${invitation.organizationName}`} className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm shadow-surface hairline animate-fade-in">
          <UserPlus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium break-words">You have an invitation from {invitation.organizationName}</div>
            {invitation.invitedBy && <div className="mt-0.5 text-xs text-muted-foreground break-words">{invitation.invitedBy} invited you to join.</div>}
            <Button size="xs" className="mt-2.5" onClick={() => openInvite(invitation.id)}>
              Open
            </Button>
          </div>
          <Dismiss onClick={dismissNoticed} />
        </div>
      )}
      {kept && (
        <div role="status" aria-label="Invitation kept for later" className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm shadow-surface hairline animate-fade-in">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{kept.organizationName} invitation kept for later</div>
            <div className="mt-0.5 text-xs text-muted-foreground">It waits in Settings › Organizations until {dayMonth(kept.expiresAt)}.</div>
          </div>
          <Dismiss onClick={dismissKept} />
        </div>
      )}
      {joined && (
        <div role="status" aria-label={`You joined ${joined.organizationName}`} className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm shadow-surface hairline animate-fade-in">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-add" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">You joined {joined.organizationName}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">Switch to it to see your team’s sessions and start one in the cloud.</div>
            {canSwitch && (
              <Button size="xs" className="mt-2.5" onClick={() => { switchOrganization(joined.organizationId); dismissJoined(); }}>
                Switch to {joined.organizationName}
              </Button>
            )}
          </div>
          <Dismiss onClick={dismissJoined} />
        </div>
      )}
    </>
  );
}
