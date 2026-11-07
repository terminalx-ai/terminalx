import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { refreshInvitations, respondToInvitation, useInvitations } from "@/lib/organizationInvitations";

/** The same live invitation state in the sidebar and Settings → Organizations. */
export function OrganizationInvitations({ sidebar = false }: { sidebar?: boolean }) {
  const { status } = useAccount();
  const state = useInvitations();
  if (status.state !== "signed-in" || !status.context?.account || state.scope !== JSON.stringify([status.context.account, status.context.revision])) return null;
  if (sidebar && !state.invitations.length && !state.error && !state.notice) return null;
  return (
    <section aria-label="Invitations" data-testid={sidebar ? "sidebar-invitations" : "organization-invitations"} className="my-2 min-w-0 space-y-2 text-xs">
      {!sidebar && <h3 className="text-sm font-semibold">Invitations</h3>}
      {state.loading && <p role="status" className="text-muted-foreground">Checking invitations…</p>}
      {!sidebar && state.loaded && !state.invitations.length && <p className="text-muted-foreground">No pending invitations.</p>}
      {state.invitations.map((invite) => (
        <div key={invite.id} className="min-w-0 rounded-lg border border-hairline bg-well p-3" data-testid="organization-invitation">
          <h4 className="break-words font-medium">Join {invite.organizationName}</h4>
          {invite.invitedBy && <p className="mt-1 break-words text-muted-foreground">Invited by {invite.invitedBy}</p>}
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Invitation to ${invite.organizationName}`}>
            <Button size="xs" disabled={!!state.pending[invite.id]} onClick={() => void respondToInvitation(invite.id, "accept")}>{state.pending[invite.id] === "accept" ? "Accepting…" : "Accept"}</Button>
            <Button size="xs" variant="outline" disabled={!!state.pending[invite.id]} onClick={() => void respondToInvitation(invite.id, "decline")}>{state.pending[invite.id] === "decline" ? "Declining…" : "Decline"}</Button>
          </div>
        </div>
      ))}
      {state.error && <p role="alert" className="break-words text-destructive">{state.error}</p>}
      {state.notice && <p role="status" className="break-words text-muted-foreground">{state.notice}</p>}
      {(!sidebar || state.error || state.notice) && <Button size="xs" variant="ghost" disabled={state.loading} onClick={() => void refreshInvitations()}>Refresh invitations</Button>}
    </section>
  );
}
