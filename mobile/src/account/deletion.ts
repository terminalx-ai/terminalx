import { z } from "zod";

/**
 * Deleting your own account from the phone (PRO-584, board 26.01), against
 * terminalx-saas `docs/account-deletion.md` (PRO-581): the read route says
 * what stands in the way and what goes, the confirm stops running cloud
 * workspaces and schedules the deletion 14 days out, and signing in again
 * before then cancels it.
 *
 * Every sentence the page shows is the design's (PRO-580 `copy.mjs`), with the
 * phone's word for workspaces. The server answers with stable codes only; each
 * one the page shows has its sentence here, and nothing the server sends is
 * shown as it is.
 */

/** The phone's word for them; the web console says "cloud machines". */
const W = "cloud workspaces";
const ONE = "cloud workspace";

/** Where the web console is: an organization's page there changes owners and removes members, which the phone cannot. */
export const WEB_CONSOLE = "https://console.terminalx.ai";
export const consoleOrganizationUrl = (organizationId: string) => `${WEB_CONSOLE}/organizations/${encodeURIComponent(organizationId)}`;

export const accountDeletionText = {
  rowTitle: "Delete account",
  rowHint: "Permanently delete your TerminalX account and what is in it.",
  title: "Delete account",
  lede: (graceDays: number) => `Your account is deleted ${graceDays} days after you confirm. Until then, signing in again cancels the deletion.`,

  blockedHead: "Before you can delete",
  owner: (org: string) => `Hand over ${org}`,
  ownerDetail: (n: number) => `You are its only owner and it has ${n} other members. Make another member the owner, or remove the members.`,
  ownerPhone: "The phone cannot change owners yet. Open the web console to do it.",
  openConsole: "Open web console",
  blockedConfirm: "Finish the steps above to delete your account.",

  goneHead: "What is deleted",
  keptHead: "Kept for a while",
  kept: (days: number) => `A record of the deletion, billing and usage records, and audit logs are kept for ${days} days after your account is deleted, then removed.`,

  reauthHead: "Sign in again",
  reauthLede: "For your security, sign in again before you delete your account.",
  reauthButton: "Sign in again",
  reauthBusy: "Signing in…",
  reauthDone: "Signed in just now",

  confirmHead: "Confirm",
  typeLabel: "Type your email address to confirm",
  typeHint: "Upper and lower case do not matter.",
  mismatch: "This is not the email address of this account.",
  confirmButton: "Delete account",
  busy: "Deleting account…",
  stopping: `Stopping ${W}…`,
  signOutNote: (on: string) => `You will be signed out on every device. You can still cancel by signing in again before ${on}.`,

  doneHead: (on: string) => `Your account will be deleted on ${on}`,
  doneBody: "You have been signed out on every device.",
  doneKeep: (on: string) => `Changed your mind? Sign in before ${on} to keep your account.`,
  doneAfter: (on: string) => `After ${on} it cannot be recovered.`,
  doneStopped: (n: number, on: string) => `${n === 1 ? `Your running ${ONE} was` : `Your ${n} running ${W} were`} stopped. ${n === 1 ? "It is" : "They are"} deleted with your account on ${on}.`,
  doneButton: "Done",
  elsewhere: (on: string) => `This account will be deleted on ${on}, so this device was signed out. Sign in before then to keep it.`,

  cancelled: "Account deletion cancelled",
  cancelledBody: "You signed in, so your account will not be deleted. Everything is as you left it.",
  cancelledStopped: `You signed in, so your account will not be deleted. The ${W} stopped when you confirmed are still stopped. Start them again when you need them.`,

  failStale: "Your sign-in is no longer recent. Sign in again, then confirm.",
  failBlocked: "Something changed since you opened this page. Finish the steps above, then confirm again.",
  failRefused: "Your account was not deleted. Nothing was changed. Try again.",
  failStop: (provider: string, name: string, why: string) => `Your account was not deleted and nothing was scheduled: ${provider} did not stop ${name} (${why}). Try again.`,
  failStopKept: (names: readonly string[]) => `Your ${names.length === 1 ? `${ONE} ${names[0]} stopped and stays stopped; start it` : `${W} ${names.slice(0, -1).join(", ")} and ${names.at(-1)} stopped and stay stopped; start them`} again when you need ${names.length === 1 ? "it" : "them"}.`,
  failUnknown: "We could not confirm whether your deletion was scheduled. Check before trying again.",
  check: "Check again",
  offline: "You are offline. Nothing was sent.",
  finishing: "Your account is being deleted",
  finishingBody: "The 14 days have passed, so it can no longer be cancelled. You will be signed out when it finishes.",
  signOut: "Sign out",

  // Not on board 26.01: the page has to say these, and the design has no sentence for them (see the pull request).
  lastAdmin: "This is the only admin account, so it cannot be deleted.",
  cleanup: (org: string) => `Clean up ${org}`,
  cloudCleanupDetail: "Runtime builds, environment images or other cloud resources are still held for it at the provider. Remove them on its page in the web console.",
  sessionRuntimeDetail: "A session runtime in it has not been shut down. Shut it down from its page in the web console.",
  otherAccount: (email: string) => `That was another account. Sign in again with ${email}.`,
  unreadable: "Your account could not be read. Check your connection and try again.",
  tryAgain: "Try again",
} as const;

const T = accountDeletionText;

// ── What the server answers (contract "Routes" and "The attempt") ──────────────────────────────────────────

const blockerSchema = z.object({
  code: z.string(),
  organizationId: z.string().nullish(),
  organizationName: z.string().nullish(),
  otherMembers: z.number().int().nonnegative().nullish(),
}).passthrough();

const stoppedSchema = z.object({ workspaceId: z.string(), workspaceName: z.string().nullish(), provider: z.string().nullish() }).passthrough();

const failureSchema = z.object({
  code: z.string(),
  provider: z.string().nullish(),
  workspaceId: z.string().nullish(),
  workspaceName: z.string().nullish(),
  reason: z.string().nullish(),
  stopped: z.array(stoppedSchema).nullish(),
}).passthrough();

const attemptSchema = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.string(),
  step: z.string().nullish(),
  requestedAt: z.string(),
  deleteAfter: z.string().nullish(),
  cancelledAt: z.string().nullish(),
  failure: failureSchema.nullish(),
  workspaces: z.array(z.object({
    workspaceId: z.string(),
    workspaceName: z.string().nullish(),
    provider: z.string().nullish(),
    action: z.string().nullish(),
    state: z.string(),
  }).passthrough()).nullish(),
}).passthrough();

const named = z.object({ id: z.string(), name: z.string() }).passthrough();

export const accountDeletionReadSchema = z.object({
  graceDays: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
  recentSignIn: z.boolean(),
  blockers: z.array(blockerSchema),
  deleted: z.object({
    authMethods: z.array(z.string()),
    runningWorkspaces: z.array(z.object({ id: z.string(), name: z.string(), provider: z.string(), organizationId: z.string() }).passthrough()),
    organizations: z.array(named.extend({ isPersonal: z.boolean(), workspaces: z.number().int().nonnegative() })),
    leftOrganizations: z.array(named),
    computeKeys: z.number().int().nonnegative(),
    agentLogins: z.number().int().nonnegative(),
    githubConnections: z.number().int().nonnegative(),
    pairedDevices: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
  }).passthrough(),
  deletion: attemptSchema.nullable(),
  notice: z.string().nullable(),
}).passthrough();

export type AccountDeletionRead = z.infer<typeof accountDeletionReadSchema>;
export type AccountDeletionAttempt = z.infer<typeof attemptSchema>;
export type AccountDeletionBlocker = z.infer<typeof blockerSchema>;
export type AccountDeletionFailure = z.infer<typeof failureSchema>;
export const accountDeletionAttemptSchema = attemptSchema;

/** The refusal codes of the routes (contract "Refusal codes"). */
export const ACCOUNT_DELETION_ERRORS = {
  blocked: "account_deletion_blocked",
  mismatch: "account_deletion_confirmation_mismatch",
  recentSignIn: "account_deletion_recent_sign_in_required",
  alreadyRequested: "account_deletion_already_requested",
  inProgress: "account_deletion_in_progress",
  notFound: "account_deletion_not_found",
  busy: "account_deletion_busy",
} as const;

const BLOCKERS = ["sole_owner_with_members", "last_admin", "session_runtime_cleanup_required", "cloud_cleanup_required"] as const;

// ── The page's rows ─────────────────────────────────────────────────────────────────────────────────────────

/** One row of Before you can delete, with where to fix it: an organization's page in the web console. */
export interface BlockerRow { key: string; title: string; detail: string; consoleUrl: string | null }

/**
 * Before you can delete, one row per blocker the phone has words for. A code
 * it does not know is left out of the list; the page still counts it as
 * standing in the way.
 */
export function blockerRows(blockers: readonly AccountDeletionBlocker[]): BlockerRow[] {
  return blockers.flatMap((blocker, index): BlockerRow[] => {
    const org = blocker.organizationName?.trim() || null;
    const url = blocker.organizationId ? consoleOrganizationUrl(blocker.organizationId) : null;
    const key = `${blocker.code}:${blocker.organizationId ?? index}`;
    switch (blocker.code) {
      case "sole_owner_with_members":
        return org ? [{ key, title: T.owner(org), detail: `${T.ownerDetail(blocker.otherMembers ?? 0)} ${T.ownerPhone}`, consoleUrl: url }] : [];
      case "last_admin":
        return [{ key, title: T.lastAdmin, detail: "", consoleUrl: null }];
      case "cloud_cleanup_required":
        return org ? [{ key, title: T.cleanup(org), detail: T.cloudCleanupDetail, consoleUrl: url }] : [];
      case "session_runtime_cleanup_required":
        return org ? [{ key, title: T.cleanup(org), detail: T.sessionRuntimeDetail, consoleUrl: url }] : [];
      default:
        return [];
    }
  });
}

export function isBlockerCode(code: string): boolean {
  return (BLOCKERS as readonly string[]).includes(code) || code === "admin_self";
}

const METHOD_WORDS: Record<string, string> = { google: "Google", github: "GitHub", email: "emailed codes" };

/** "A, B and C". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What is deleted, built from the account: its sign-in ways, running cloud workspaces, organizations and what it saved. */
export function goneRows(read: AccountDeletionRead, email: string): [string, string][] {
  const { deleted } = read;
  const rows: [string, string][] = [];
  const methods = deleted.authMethods.map((method) => METHOD_WORDS[method]).filter((word): word is string => !!word);
  rows.push(["Your profile and your sign-in", methods.length ? `${email}, with ${listWords(methods)}` : email]);
  const running = deleted.runningWorkspaces;
  if (running.length) {
    const orgName = (id: string) => [...deleted.organizations, ...deleted.leftOrganizations].find((organization) => organization.id === id)?.name ?? null;
    const names = running.map((workspace) => {
      const org = orgName(workspace.organizationId);
      return org ? `${workspace.name} in ${org}` : workspace.name;
    });
    rows.push([running.length === 1 ? `Your running ${ONE}` : `Your ${running.length} running ${W}`, `${names.join(", ")}: stopped when you confirm, deleted after the ${read.graceDays} days`]);
  }
  for (const organization of deleted.organizations) {
    const detail = organization.workspaces > 0 ? `With its stopped ${W}` : "";
    rows.push([organization.isPersonal ? `Your personal organization, ${organization.name}` : `Your organization, ${organization.name}`, detail]);
  }
  const saved = [
    ...(deleted.computeKeys ? ["Compute keys"] : []),
    ...(deleted.agentLogins ? ["agent logins"] : []),
    ...(deleted.githubConnections ? ["the GitHub connection"] : []),
  ];
  if (saved.length) rows.push(["Keys and connections you saved", capitalize(listWords(saved))]);
  rows.push(["Machines and phones paired to your account", "Every signed-in session ends"]);
  const left = deleted.leftOrganizations.map((organization) => organization.name);
  if (left.length) rows.push(["Your place in other organizations", `You leave ${listWords(left)}; ${left.length === 1 ? "it keeps its work" : "they keep their work"}`]);
  return rows;
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

// ── Confirming ──────────────────────────────────────────────────────────────────────────────────────────────

/** The typed address is the account's: upper and lower case, and spaces at either end, do not matter. */
export function emailConfirmed(typed: string, email: string): boolean {
  const expected = email.trim().toLowerCase();
  return expected !== "" && typed.trim().toLowerCase() === expected;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "9 December 2026", on the phone's own calendar. */
export function deletionDate(at: number | Date): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a deletion confirmed at `now` would be deleted. */
export function deleteAfterFrom(now: number, graceDays: number): number {
  return now + graceDays * DAY_MS;
}

/** The provider's reason for not stopping a workspace, in words; the server sends an allowlisted code. */
const REASONS: Record<string, string> = {
  provider_timed_out: "the provider is not answering",
  provider_unavailable: "the provider is not answering",
  provider_retry_exhausted: "the provider is not answering",
  service_unavailable: "the provider is not answering",
  provider_refused: "the provider refused",
  provider_rate_limited: "the provider is limiting requests",
  provider_credential_invalid: "the organization's provider key is not valid",
  workspace_needs_attention: "it needs attention",
  workspace_busy: "it is busy with another change",
  stop_unsupported: "the provider cannot stop it",
};
const UNKNOWN_REASON = "the provider did not say why";

/**
 * The sentence for a refused attempt: a workspace that did not stop names it
 * and the ones that did; a blocker found after confirming says something
 * changed; anything else is "not deleted, nothing changed".
 */
export function refusalSentence(failure: AccountDeletionFailure | null | undefined, providerName: (id: string) => string, workspaceName: (id: string) => string | null): { tone: "danger" | "warning"; text: string; blocked: boolean } {
  if (failure?.code === "workspace_stop_failed") {
    const name = failure.workspaceName ?? (failure.workspaceId ? workspaceName(failure.workspaceId) : null);
    if (name && failure.provider) {
      const why = (failure.reason && REASONS[failure.reason]) || UNKNOWN_REASON;
      const kept = (failure.stopped ?? []).map((entry) => entry.workspaceName ?? workspaceName(entry.workspaceId)).filter((value): value is string => !!value);
      return { tone: "danger", text: kept.length ? `${T.failStop(providerName(failure.provider), name, why)} ${T.failStopKept(kept)}` : T.failStop(providerName(failure.provider), name, why), blocked: false };
    }
  }
  if (failure && isBlockerCode(failure.code)) return { tone: "warning", text: T.failBlocked, blocked: true };
  return { tone: "danger", text: T.failRefused, blocked: false };
}

/** How many running cloud workspaces a deletion stopped when the person confirmed. */
export function stoppedAtConfirm(attempt: AccountDeletionAttempt | null | undefined): number {
  return (attempt?.workspaces ?? []).filter((workspace) => workspace.action === "stop" && workspace.state === "stopped").length;
}
