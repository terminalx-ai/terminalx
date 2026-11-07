import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getAccount, refreshMembershipsAfterInvite, subscribeAccount } from "./account";

export interface OrganizationInvitation {
  id: string;
  organizationName: string;
  role: string;
  expiresAt: number;
  invitedBy?: string | null;
}
export const invitationApi = {
  list: (contextRevision: string) => invoke<{ invites: OrganizationInvitation[] }>("account_invitations", { contextRevision }),
  accept: (inviteId: string, contextRevision: string) => invoke<{ organizationId: string; organizationName: string; role: string }>("account_invitation_accept", { inviteId, contextRevision }),
  decline: (inviteId: string, contextRevision: string) => invoke<{ declined: boolean }>("account_invitation_decline", { inviteId, contextRevision }),
};
interface InvitationsState {
  scope: string | null;
  invitations: OrganizationInvitation[];
  loading: boolean;
  loaded: boolean;
  pending: Record<string, "accept" | "decline">;
  error: string | null;
  notice: string | null;
  membershipRefreshNeeded: boolean;
}
const empty = (scope: string | null): InvitationsState => ({ scope, invitations: [], loading: false, loaded: false, pending: {}, error: null, notice: null, membershipRefreshNeeded: false });
let state = empty(null);
let epoch = 0;
let sequence = 0;
// List freshness and action feedback have different lifetimes: a membership read
// may outlive its sibling list, but must never overwrite a later action's outcome.
let actionVersion = 0;
let flight: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const scopeOf = () => {
  const { status } = getAccount();
  return status.state === "signed-in" && status.context?.account && status.context.revision
    ? JSON.stringify([status.context.account, status.context.revision]) : null;
};
const emit = (patch: Partial<InvitationsState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
const sync = () => {
  const scope = scopeOf();
  if (scope === state.scope) return;
  epoch++;
  sequence++;
  flight = null;
  state = empty(scope);
  for (const listener of listeners) listener();
  if (scope) void refreshInvitations();
};
const current = (started: number, scope: string) => epoch === started && state.scope === scope && scopeOf() === scope;

export function invitationError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "invite_expired": return "This invitation has expired. Ask an organization admin for a new invitation.";
    case "not_found": return "This invitation is no longer available. It may have been accepted or revoked.";
    case "email_unverified": return "Verify your account email before accepting this invitation.";
    case "invite_requires_pro": return "Accepting this invitation requires TerminalX Pro.";
    case "forbidden": case "unauthorized": return "Your account does not have permission to use this invitation. Refresh or sign in again.";
    case "organization_members_outcome_unknown": return "The response was lost. The invitation may have changed; refresh before trying again.";
    case "account_context_changed": case "account_context_changed_after_send": return "Your account changed. Refresh invitations before trying again.";
    default: return "Invitations could not be updated. Try refreshing.";
  }
}

/** Account-wide, including accounts that have no cloud organization yet. No invite data is saved. */
export function bootInvitations() {
  if (unsubscribe) return;
  unsubscribe = subscribeAccount(sync);
  timer = setInterval(() => {
    // Expired rows disappear even when a later request fails.
    const invitations = state.invitations.filter((invite) => invite.expiresAt > Date.now());
    if (invitations.length !== state.invitations.length) emit({ invitations });
    if (document.visibilityState !== "hidden") void refreshInvitations();
  }, 30_000);
  sync();
}
export function refreshInvitations(): Promise<void> {
  sync();
  if (!state.scope) return Promise.resolve();
  if (flight) return flight;
  const scope = state.scope;
  const started = epoch;
  const request = ++sequence;
  const revision = getAccount().status.context!.revision;
  emit({ loading: true });
  if (state.membershipRefreshNeeded && !Object.values(state.pending).includes("accept")) {
    const recoveringAction = actionVersion;
    const context = getAccount().status.context!;
    void refreshMembershipsAfterInvite(context).then((fresh) => {
      if (current(started, scope) && recoveringAction === actionVersion && fresh) emit({ membershipRefreshNeeded: false, notice: "Organizations refreshed.", error: null });
    });
  }
  const work = invitationApi.list(revision).then(({ invites }) => {
    if (current(started, scope) && request === sequence) emit({ invitations: invites.filter((invite) => invite.expiresAt > Date.now()), loaded: true, error: state.membershipRefreshNeeded ? "Your organization membership could not be refreshed. Refresh again to check whether the invitation was accepted." : null });
  }).catch((error) => {
    if (current(started, scope) && request === sequence) emit({ error: invitationError(error) });
  }).finally(() => {
    if (current(started, scope) && flight === work) { flight = null; emit({ loading: false }); }
  });
  flight = work;
  return work;
}

export async function respondToInvitation(id: string, action: "accept" | "decline"): Promise<void> {
  sync();
  const scope = state.scope;
  const invite = state.invitations.find((candidate) => candidate.id === id);
  if (!scope || !invite || state.pending[id]) return;
  const respondingAction = ++actionVersion;
  if (invite.expiresAt <= Date.now()) { emit({ invitations: state.invitations.filter((candidate) => candidate.id !== id), error: invitationError({ code: "invite_expired" }) }); return; }
  const started = epoch;
  const context = getAccount().status.context!;
  // A list started before a mutation must never resurrect its consumed invite.
  sequence++;
  flight = null;
  emit({ pending: { ...state.pending, [id]: action }, error: null, notice: null, loading: false });
  try {
    const answer = await invitationApi[action](id, context.revision);
    if (action === "decline" && (!("declined" in answer) || !answer.declined)) throw { code: "organization_members_outcome_unknown" };
    if (!current(started, scope)) return;
    sequence++;
    emit({ invitations: state.invitations.filter((candidate) => candidate.id !== id) });
    if (action === "accept") {
      emit({ membershipRefreshNeeded: true });
      const fresh = await refreshMembershipsAfterInvite(context);
      if (!current(started, scope) || respondingAction !== actionVersion) return;
      emit({ membershipRefreshNeeded: !fresh, notice: fresh ? `Joined ${invite.organizationName}.` : `Joined ${invite.organizationName}. Refresh to load your updated organizations.` });
    }
  } catch (error) {
    if (!current(started, scope)) return;
    const code = (error as { code?: string })?.code;
    if (code === "not_found" || code === "invite_expired") {
      // A poll started during the mutation may still contain this now-consumed/revoked row.
      sequence++;
      flight = null;
      emit({ invitations: state.invitations.filter((candidate) => candidate.id !== id), loading: false });
    }
    // Even a lost response can have committed membership. Preserve read-only recovery
    // until a fresh membership read succeeds; never silently resend the mutation.
    if (action === "accept") {
      emit({ membershipRefreshNeeded: true });
      const fresh = await refreshMembershipsAfterInvite(context);
      if (current(started, scope) && respondingAction === actionVersion) emit({ membershipRefreshNeeded: !fresh });
    }
    if (current(started, scope) && respondingAction === actionVersion) emit({ error: invitationError(error) });
  } finally {
    if (current(started, scope)) {
      const pending = { ...state.pending }; delete pending[id]; emit({ pending });
    }
  }
}

export const getInvitations = () => state;
export function useInvitations() {
  useEffect(bootInvitations, []);
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getInvitations, getInvitations);
}
/** Test teardown; invalidates every in-flight result. */
export function resetInvitations() {
  unsubscribe?.(); unsubscribe = null;
  if (timer) clearInterval(timer); timer = null;
  epoch++; sequence++; flight = null; state = empty(null);
  for (const listener of listeners) listener();
}
