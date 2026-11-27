// Invitations addressed to the signed-in person (PRO-175): the combined
// invite-and-welcome card shown before joining (12.08, 12.21), and the
// Invitations list in Settings → Organizations (12.20) where an invitation
// waits after "Decide later". Behind `organization.invites-welcome.v1`.

import { useSyncExternalStore } from "react";
import { invoke } from "@/lib/api";
import { getAccount, refreshAccountRoles, subscribeAccount } from "@/lib/account";
import { phase2ReadyAnywhere } from "@/lib/phase2Readiness";

export interface MyInvite {
  id: string;
  organizationName: string;
  role: string;
  expiresAt: number;
  invitedBy?: string;
  createdAt?: number;
  expired?: boolean;
  /** The inviting organization pays for the seat (an active Teams plan). */
  teamsPlan?: boolean;
}

export type WelcomeAgentState = "ready" | "needs_login";

export interface InviteWelcome {
  id: string;
  organizationName: string;
  role: string;
  expiresAt: number;
  createdAt: number;
  invitedBy?: string;
  seatCovered: boolean;
  checkedAt: number;
  github: { state: "ready" | "missing"; repositories: string[] };
  agents: { provider: string; state: WelcomeAgentState; authKind?: string }[];
  computer: { state: "ready" | "building" | "missing"; name?: string; version?: number };
  admins: { name: string; owner: boolean }[];
}

export interface JoinedOrganization {
  organizationId: string;
  organizationName: string;
  role: string;
}

/** Native errors are `{ code }`; anything else reads as unavailable. */
export function inviteErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "organization_invites_unavailable";
}

const ERROR_COPY: Record<string, string> = {
  invite_expired: "This invitation has expired. Ask an admin for a new one.",
  email_unverified: "Verify your email address first, then accept.",
  invite_requires_pro: "Joining this organization needs a Pro plan.",
  organization_member_limit_reached: "This organization has no free seat. Ask an admin.",
  not_found: "This invitation is no longer open.",
};

export function inviteErrorMessage(error: unknown): string {
  return ERROR_COPY[inviteErrorCode(error)] ?? "Couldn’t reach TerminalX. Try again.";
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
export const agentName = (provider: string) => AGENT_NAMES[provider] ?? provider;

// ---- what the person chose on this Mac ------------------------------------

const DEFERRED_KEY = "terminalx.invites.decideLater.v1";

function deferredKey(): string | null {
  const status = getAccount().status;
  const email = status.state === "signed-in" ? status.identity?.email : undefined;
  return email ? `${DEFERRED_KEY}:${email.toLowerCase()}` : null;
}

function readDeferred(): string[] {
  const key = deferredKey();
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeDeferred(ids: string[]) {
  const key = deferredKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // The choice is only remembered for this window then.
  }
}

// ---- the store ------------------------------------------------------------

export interface InvitesState {
  /** The readiness key is on, so the surfaces show. */
  enabled: boolean;
  invites: MyInvite[];
  /** Invitation ids the person chose Decide later for (this Mac, this account). */
  deferred: string[];
  /** The invitation whose welcome card is open. */
  open: string | null;
  /** The organization just joined, for the "You joined" notice (01.08). */
  joined: JoinedOrganization | null;
  /** An invitation kept for later, for its notice (12.20). */
  kept: MyInvite | null;
}

const EMPTY: InvitesState = { enabled: false, invites: [], deferred: [], open: null, joined: null, kept: null };
let state: InvitesState = EMPTY;
const listeners = new Set<() => void>();
let generation = 0;

function set(next: Partial<InvitesState>) {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

export function getInvites(): InvitesState {
  return state;
}

export function useInvites(): InvitesState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

const pending = (invite: MyInvite) => !invite.expired && invite.expiresAt > Date.now();

/** The open invitations and the recently expired ones, as the server listed them. */
export async function loadInvites(): Promise<void> {
  const enabled = phase2ReadyAnywhere(getAccount().status, "invitesWelcome");
  if (!enabled) {
    if (state.enabled || state.invites.length) set({ ...EMPTY });
    return;
  }
  const asked = ++generation;
  try {
    const answer = await invoke<{ invites?: MyInvite[] }>("my_invites");
    if (asked !== generation) return;
    const invites = Array.isArray(answer?.invites) ? answer.invites : [];
    const deferred = readDeferred().filter((id) => invites.some((invite) => invite.id === id));
    // A new open invitation, not put off, shows its card once by itself.
    const first = state.open ?? invites.find((invite) => pending(invite) && !deferred.includes(invite.id) && !shown.has(invite.id))?.id ?? null;
    if (first) shown.add(first);
    set({ enabled: true, invites, deferred, open: first });
  } catch {
    // Keep what was listed; the next refresh asks again.
    if (asked === generation) set({ enabled: true });
  }
}

/** Invitations whose card already opened by itself in this window. */
const shown = new Set<string>();

export function openInvite(id: string | null) {
  if (id) shown.add(id);
  set({ open: id });
}

/** "Decide later": close the card; the invitation waits in Settings → Organizations. */
export function decideLater(id: string) {
  const deferred = state.deferred.includes(id) ? state.deferred : [...state.deferred, id];
  writeDeferred(deferred);
  set({ deferred, open: null, kept: state.invites.find((invite) => invite.id === id) ?? null });
}

export function dismissKept() {
  set({ kept: null });
}

export function dismissJoined() {
  set({ joined: null });
}

function forget(id: string) {
  const deferred = state.deferred.filter((other) => other !== id);
  writeDeferred(deferred);
  set({
    invites: state.invites.filter((invite) => invite.id !== id),
    deferred,
    open: state.open === id ? null : state.open,
    kept: state.kept?.id === id ? null : state.kept,
  });
}

/** Accept and join; the organization appears without a restart once the roles are read again. */
export async function acceptInvite(id: string): Promise<JoinedOrganization> {
  const joined = await invoke<JoinedOrganization>("my_invite_accept", { inviteId: id });
  forget(id);
  set({ joined });
  await refreshAccountRoles(true);
  return joined;
}

/** Decline (or Remove an expired one): the server deletes the invitation. */
export async function declineInvite(id: string): Promise<void> {
  await invoke("my_invite_decline", { inviteId: id });
  forget(id);
}

export function fetchWelcome(id: string): Promise<InviteWelcome> {
  return invoke<InviteWelcome>("my_invite_welcome", { inviteId: id });
}

// ---- when to read the list again --------------------------------------------

/** About as often as the organizations and the catalog are read again. */
export const INVITES_REFRESH_MS = 60_000;

let watching = false;
let lastIdentity: string | null = null;

/** Read the list when the account or its readiness changes, and about once a minute while visible. */
export function watchInvites(): () => void {
  if (watching) return () => undefined;
  watching = true;
  const identity = () => {
    const status = getAccount().status;
    const email = status.state === "signed-in" ? (status.identity?.email ?? "") : "";
    return `${email}:${phase2ReadyAnywhere(status, "invitesWelcome")}`;
  };
  const onAccount = () => {
    const next = identity();
    if (next === lastIdentity) return;
    if (lastIdentity !== null && lastIdentity.split(":")[0] !== next.split(":")[0]) {
      shown.clear();
      set({ ...EMPTY });
    }
    lastIdentity = next;
    void loadInvites();
  };
  const unsubscribe = subscribeAccount(onAccount);
  onAccount();
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadInvites();
  }, INVITES_REFRESH_MS);
  return () => {
    unsubscribe();
    window.clearInterval(timer);
    watching = false;
    lastIdentity = null;
  };
}

export function resetInvitesForTest() {
  state = EMPTY;
  generation = 0;
  shown.clear();
  watching = false;
  lastIdentity = null;
}
