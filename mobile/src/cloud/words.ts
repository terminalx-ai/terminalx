import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { leaseLive, type Participant, type TabLease } from "@terminalx/portable/workspaceCollab";
import type { CloudRefusal, CloudRole } from "./api";
import type { CloudLinkProblem } from "./link";
import type { OutboxEntry } from "./outbox";

/** What the phone says about cloud workspaces: states, roles and refusals in words. */

export function stateLabel(state: string): string {
  if (state === "ready") return "Running";
  if (state === "suspended") return "Stopped";
  if (state === "provisioning" || state === "resuming") return "Starting";
  if (state === "suspending") return "Stopping";
  if (state === "archived") return "Archived";
  if (state === "attention-required") return "Needs attention";
  if (state === "deleting") return "Being deleted";
  // A state this app does not know is not shown as its raw name.
  return "Unavailable";
}

export function roleLabel(role: CloudRole | null | undefined): string | null {
  if (role === "manager") return "Manager";
  if (role === "driver") return "Can send";
  if (role === "viewer") return "View only";
  return null;
}

/** The person's role in a workspace as a phrase, for the line under its title ("Stopped · You are a manager"). */
export function rolePhrase(role: CloudRole | null | undefined): string | null {
  if (role === "manager") return "You are a manager";
  if (role === "driver") return "You can send";
  if (role === "viewer") return "You can view";
  return null;
}

/**
 * Who may start a stopped workspace, for someone who may not: its managers,
 * which the server takes to be its creator and the organization's owners and
 * admins (`cloud_workspace_manager_required`), and anyone who may send to
 * it, whose queued message wakes it (contract §11.2).
 */
export function whoCanStart(creator: string | null): string {
  const starters = creator ? `${creator}, its creator, or an organization owner or admin can start it.` : "Its creator or an organization owner or admin can start it.";
  return `${starters} Anyone who can send to it starts it by sending a message.`;
}

/**
 * The failure the service reported for a workspace that needs attention after
 * a failed resume, with a safe fallback for codes this app does not know.
 */
export function attentionDetail(code: string | null | undefined): string {
  switch (code) {
    case "cloud_workspace_runtime_bootstrap_failed": return "The workspace’s runtime could not be set up on its machine.";
    case "cloud_provider_credential_invalid": return "The provider credential is no longer valid. An admin can repair it.";
    case "cloud_provider_permission_denied": return "The provider refused the action. Check its permissions.";
    case "cloud_provider_unavailable": return "The provider did not answer.";
    case "cloud_provider_rate_limited": return "The provider is rate limiting requests.";
    case "cloud_provider_state_conflict": return "The provider reports the workspace's machine in a state that does not allow resuming yet.";
    case "cloud_provider_connection_attention_required": return "The organization's provider connection needs attention. An admin can repair it.";
    case "cloud_workspace_provisioning_timeout": return "The workspace's machine took too long to start.";
    // A failed resume with no code, or one this app does not know: what failed is still said (#1290).
    default: return "The last resume did not finish.";
  }
}

/**
 * A workspace in the Cloud list, as the Sessions list says a session: what
 * it is doing in words, and its mark (working bars, a dot that needs you,
 * else the state's colour).
 */
export function listStatus(workspace: { state: string; runtimeActivity?: { activeTurns?: number; pendingApprovals?: number } | null }): { words: string; mark: "needs" | "working" | "attention" | "running" | "changing" | "idle" } {
  const waiting = workspace.runtimeActivity?.pendingApprovals ?? 0;
  const running = workspace.state === "ready";
  if (workspace.state === "attention-required") return { words: "Needs attention", mark: "attention" };
  if (running && waiting > 0) return { words: waiting === 1 ? "Needs your answer" : `${waiting} waiting for an answer`, mark: "needs" };
  if (running && (workspace.runtimeActivity?.activeTurns ?? 0) > 0) return { words: "Working", mark: "working" };
  const words = stateLabel(workspace.state);
  return { words, mark: running ? "running" : words === "Starting" || words === "Stopping" ? "changing" : "idle" };
}

const CODES: Record<string, string> = {
  account_signed_out: "Sign in to see your cloud workspaces.",
  cloud_workspace_unavailable: "The service could not be reached. What is shown may be out of date.",
  cloud_provider_unavailable: "The cloud provider is not answering right now.",
  cloud_workspace_not_found: "This workspace is not available to you, or it has stopped.",
  cloud_workspace_forbidden: "You do not have access to this workspace.",
  cloud_workspace_collaboration_forbidden: "Your role in this workspace does not allow that.",
  cloud_workspace_transcript_unreadable: "The saved conversation could not be read.",
  cloud_workspace_invalid_response: "Update the app to use this workspace.",
  "needs-attention": "This workspace needs attention.",
  cloud_workspace_stopped: "This workspace has stopped.",
  cloud_workspace_archived: "This workspace is archived.",
  cloud_workspace_rate_limited: "Too many requests just now. Try again in a moment.",
  cloud_workspace_agent_command_limit: "Too many messages are waiting for this workspace. Wait for the agent, or cancel one.",
  cloud_workspace_share_redundant: "This person already has access as owner, admin or creator.",
  // The server refuses a driver while a managers-only agent login could reach the workspace.
  cloud_workspace_share_credential_restricted: "Can send is not available here while the organization has an agent login that only owners and admins may use. Share as view only, or an admin can share that login with the whole organization first.",
  // PRO-18: the creator stores their own model credential, which reaches only workspaces nobody else can drive.
  cloud_workspace_share_personal_route: "This workspace was handed its creator's own model credential since it last started, so it can't be opened to the organization or shared with Can send yet. Share as view only, or the creator switches that agent to the organization login or a helper and then stops and resumes the workspace.",
  cloud_workspace_share_requires_organization_access: "Make the workspace visible to the organization first.",
  cloud_workspace_share_limit: "This workspace is already shared with the maximum number of people (64). Remove someone first.",
  cloud_workspace_share_forbidden: "Only organization admins and the workspace's creator can change who it is shared with.",
  // PRO-73: a workspace is managed by its creator and by organization owners and admins.
  cloud_workspace_manager_required: "Only this workspace's creator or an organization owner or admin can do that.",
  cloud_workspace_create_budget_exceeded: "You have created as many cloud workspaces as your organization allows one person for now. Try again later.",
  cloud_workspace_member_concurrency_exceeded: "You already have as many cloud workspaces running as your organization allows one person. Stop one of yours first.",
  cloud_workspace_concurrency_exceeded: "Your organization is running as many cloud workspaces as its limit allows.",
  cloud_workspace_share_not_found: "That share was already removed.",
  organization_member_not_found: "This person is no longer a member of this organization.",
  lease_cooldown: "You drove this tab moments ago; others get the first chance. Try again in two minutes.",
  lease_held: "Someone else is driving this tab.",
  forbidden: "Your role in this workspace does not allow that.",
  "tab-closed": "That agent tab was closed.",
  "request-not-pending": "That request was already answered.",
  "lease-held": "Someone else is driving this tab. Your message was not sent.",
  "access-revoked": "Not sent: your access changed.",
  "read-only": "You can view this workspace but not send to it.",
  "cannot-approve": "Only someone allowed to approve can answer this request.",
  "no-key": "This phone has not been connected to this workspace while it was running, so it cannot send to it or read its saved conversation yet.",
  "would-wake": "This workspace is stopped. Sending starts it.",
  unavailable: "This workspace cannot take messages right now.",
};

/** A sentence for a refusal code; the code itself is kept for anything unknown. */
export function codeText(code: string | null | undefined): string | null {
  if (!code) return null;
  // A code this app has no sentence for is never shown as it is.
  return CODES[code] ?? "That did not work. Try again in a moment.";
}

/**
 * A sentence for each kind of refusal the cloud setup screens tell apart
 * (`CloudApiError.refusal`). Where boards 25.01 to 25.06 give the refusal a
 * sentence it is that sentence, with the provider or agent left unnamed since
 * the kind does not say which; the rest are said in the same plain words.
 * Every kind has one, so a code is never shown.
 */
const REFUSAL_SENTENCES: Readonly<Record<CloudRefusal, string>> = {
  "signed-out": "Sign in to see your cloud workspaces.",
  // 25.01, said to a member: only an owner or admin sets up compute and agent logins.
  "admin-required": "Only an organization owner or admin can do that.",
  "manager-required": "Only this workspace's creator or an organization owner or admin can do that.",
  "not-found": "That is no longer there. It may have been removed.",
  // 25.05, cloud_provider_connection_required.
  "provider-not-connected": "Connect a compute provider first.",
  // 25.03 and 25.05, cloud_provider_connection_attention_required.
  "provider-needs-attention": "The provider rejected the stored key on its last check. Replace the key to continue.",
  // 25.03, cloud_provider_credential_invalid.
  "provider-key-invalid": "The provider rejected that key. Paste it again, or make a new one.",
  "provider-key-other-account": "That key is for a different provider account than the one connected here. Use a key from the same account.",
  // 25.03, cloud_provider_permission_denied.
  "provider-permission-denied": "The key is valid but not allowed to do something TerminalX needs. Check the permissions of the key.",
  // 25.03, cloud_provider_billing_required.
  "provider-billing-required": "The provider needs billing set up on that account before it will act.",
  "provider-not-offered": "That provider is not offered for new cloud workspaces here.",
  // 25.03, cloud_provider_disposition_required.
  "provider-has-machines": "The provider still holds this organization's workspaces. Delete them first, then disconnect. Nothing was changed.",
  "provider-busy": "Something else is still under way with this provider. Try again when it has finished.",
  // 25.03, cloud_provider_rate_limited.
  "provider-rate-limited": "The cloud provider is not answering right now. Try again in a moment.",
  // 25.05, cloud_provider_unavailable.
  "provider-unavailable": "The cloud provider is not answering right now.",
  // 25.05, terminalx_pro_required.
  "plan-required": "An active TerminalX Pro license is required to start machines TerminalX hosts.",
  "limit-reached": "This organization has reached a limit on cloud workspaces. Stop or delete one, then try again.",
  // 25.05, cloud_provisioning_paused.
  "provisioning-paused": "New cloud workspaces are paused for this organization.",
  // 25.05, cloud_workspace_policy_denied.
  "policy-denied": "That size, region or idle setting is not allowed by this organization’s limits.",
  // 25.05, cloud_workspace_quote_expired.
  "quote-expired": "That estimate expired. Nothing was launched. Get a new price to carry on.",
  "idempotency-key-reused": "That request was already sent with other details. Start it again.",
  // 25.06, cloud_workspace_operation_in_progress.
  "workspace-busy": "Something else is still under way on this workspace. Try again when it has finished.",
  "workspace-archived": "This workspace is archived.",
  "operation-not-found": "The service no longer knows that operation. Read the workspace again to see where it is.",
  // 25.05, cloud_workspace_credential_required.
  "login-missing": "Connect at least one AI agent.",
  // 25.04, cloud_workspace_credential_invalid.
  "login-invalid": "The login failed verification. It may have expired. Paste a fresh key, or sign in again.",
  // 25.04, cloud_workspace_credential_in_use.
  "login-in-use": "A workspace that is running was set up with this login. Delete that workspace first, or replace the login instead.",
  // 25.04, cloud_workspace_credential_verification_unavailable.
  "login-check-unavailable": "Verification is temporarily unavailable. The key was not saved. Try again in a moment.",
  // 25.05, cloud_workspace_repository_credential_required.
  "repository-login-required": "This repository needs a GitHub personal access token.",
  "repository-not-accessible": "That repository could not be reached with this organization's GitHub login.",
  "repository-check-unavailable": "The repository could not be checked right now. Try again in a moment.",
  // 25.04, cloud_workspace_device_auth_unavailable.
  "device-login-unavailable": "OpenAI’s device sign-in is not answering right now. Try again in a moment, or use an API key.",
  // 25.04: a device login the server no longer has is one whose code expired.
  "device-login-not-found": "The code expired. Start device login again.",
  "rate-limited": "Too many requests just now. Try again in a moment.",
  "invalid-request": "The service did not accept that. Check what was entered and try again.",
  "invalid-response": "The service answered in a way this app does not understand. Update the app.",
  "unreachable": "The service could not be reached. Try again in a moment.",
  "unknown": "That did not work. Try again in a moment.",
};

/**
 * Codes whose kind is shared with others but that the boards give a sentence
 * of their own (25.05's table of refusals, 25.06's delete page).
 */
const REFUSAL_CODE_SENTENCES: Readonly<Record<string, string>> = {
  cloud_workspace_quota_exceeded: "This organization has reached its limit on cloud workspaces, stopped ones included. Delete one, then try again.",
  cloud_workspace_concurrency_exceeded: "Your organization is running as many cloud workspaces as its limit allows.",
  cloud_workspace_member_concurrency_exceeded: "You already have as many cloud workspaces running as your organization allows one person. Stop one of yours first.",
  cloud_workspace_create_budget_exceeded: "You have created as many cloud workspaces as your organization allows one person for now. Try again later.",
  cloud_provider_creation_disabled: "New cloud workspaces are paused for this organization.",
  cloud_workspace_runtime_not_ready: "Cloud workspaces are not available yet: the server has not installed a compatible TerminalX runtime. Try again later.",
  cloud_workspace_active_work: "An agent is working here, or is waiting for an answer. Stop it or answer it, then delete.",
  cloud_workspace_repository_ref_not_found: "That branch or tag was not found in the repository.",
  cloud_agent_credential_reauth_required: "This login is no longer accepted. Sign in again to keep the agent working.",
};

/**
 * What a refusal says, as one sentence. Given the error itself rather than
 * only its kind, a code the boards say more precisely is said that way. Never
 * a code: a kind this app does not know reads as `unknown`.
 */
export function refusalText(refusal: CloudRefusal | { refusal: CloudRefusal; code: string }): string {
  if (typeof refusal !== "string") return REFUSAL_CODE_SENTENCES[refusal.code] ?? refusalText(refusal.refusal);
  return REFUSAL_SENTENCES[refusal] ?? REFUSAL_SENTENCES.unknown;
}

/**
 * One line for the state of a workspace, said under its title with the
 * person's role. `short` is what fits there; `text` says more, and a warning
 * is also shown in full under the header. Neither ever says what the
 * conversation below holds: that is the body's to say (#988). A connection is
 * live only for someone with a role there: with none (access taken away, or
 * never given) or before the runtime knows (#475), nothing of it is shown, and
 * the banner says so instead of "Live".
 */
export function connectionLine(connection: WorkspaceConnectionState, listedState: string | null, problem: CloudLinkProblem, starting = false, access: { role: CloudRole | null; checking: boolean } = { role: null, checking: false }): { tone: "live" | "idle" | "warn"; text: string; short: string } {
  if (listedState === "attention-required") return { tone: "warn", text: "This workspace needs attention.", short: "Needs attention" };
  if (connection.state === "connected") {
    if (access.checking) return { tone: "idle", text: "Checking your access…", short: "Checking access…" };
    if (access.role === "none") return { tone: "warn", text: "No access: this workspace is not shared with you.", short: "No access" };
    return { tone: "live", text: "Live · end-to-end encrypted", short: "Live" };
  }
  if (connection.state === "updateRequired") return { tone: "warn", text: "Update the app to connect to this workspace.", short: "Update needed" };
  if (listedState === "archived") return { tone: "idle", text: "Archived", short: "Archived" };
  // Asked to start by a message, or already starting: said as long as it lasts, so a workspace that bills is never shown as stopped.
  if (starting || listedState === "provisioning" || listedState === "resuming") return { tone: "idle", text: "Starting the workspace…", short: "Starting…" };
  if (listedState === "suspending") return { tone: "idle", text: "Stopping…", short: "Stopping…" };
  if (listedState === "suspended" || connection.state === "suspended") return { tone: "idle", text: "Stopped", short: "Stopped" };
  if (listedState === null) return { tone: "warn", text: "This workspace is no longer available to you.", short: "Unavailable" };
  if (connection.state === "waitingForRuntime") return { tone: "idle", text: "Starting…", short: "Starting…" };
  if (connection.state === "reconnecting") {
    const offline = problem?.kind === "api" && problem.unreachable;
    return { tone: "warn", text: offline ? "Offline. Reconnecting…" : "Reconnecting…", short: offline ? "Offline" : "Reconnecting…" };
  }
  if (connection.state === "stopped") return { tone: "warn", text: problem?.kind === "gave-up" ? "Could not connect to this workspace." : problem?.kind === "api" ? openRefusalText(problem.code) : "Not connected to this workspace.", short: "Not connected" };
  return { tone: "idle", text: "Connecting…", short: "Connecting…" };
}

/** Why the service would not connect this phone to a workspace (#1290): its own word, never a bare "Not connected". */
export function openRefusalText(code: string): string {
  const known = CODES[code];
  if (known) return known;
  return "The service would not connect this phone to the workspace.";
}

/** Why a workspace that was asked for cannot be shown, by what the list says of this person's access. */
export function accessText(access: "not-shared" | "deleted" | "gone"): { title: string; detail: string } {
  if (access === "not-shared") return { title: "This workspace has not been shared with you", detail: "Ask an organization admin or its creator to share it." };
  if (access === "deleted") return { title: "This workspace was deleted", detail: "Nothing of it is kept on this phone." };
  return { title: "This workspace is no longer shared with you", detail: "What this phone kept of it was removed. Ask an organization admin or its creator if you need it again." };
}

type NameOf = (userId: string | null | undefined) => string;

/** Who drives a tab, in words, and what this person may do about it. */
export function leaseLine(lease: TabLease | null | undefined, selfId: string | null, role: CloudRole | null, now: number, nameOf: NameOf): { text: string; mine: boolean; heldByOther: boolean; canTake: boolean; canRelease: boolean; canTakeOver: boolean } {
  const live = leaseLive(lease, now) ? lease : null;
  const mine = !!live && live.holderId === selfId;
  const heldByOther = !!live && !mine;
  const drives = role === "manager" || role === "driver";
  return {
    text: mine ? "You are driving" : live ? `Driving: ${nameOf(live.holderId)}` : "No one is driving",
    mine,
    heldByOther,
    canTake: drives && !live,
    canRelease: mine,
    canTakeOver: heldByOther && role === "manager",
  };
}

const PRESENCE_SHOWN = 3;

/** The other people here, each with what they are doing. */
export function presenceLine(participants: Participant[], selfId: string | null, tabTitle: (tabId: string) => string | null, nameOf: NameOf): string | null {
  const others = participants.filter((person) => person.userId !== selfId);
  if (!others.length) return null;
  // Whole names only: three people in full, the rest as a count, so the line never ends mid-name.
  const shown = others.slice(0, PRESENCE_SHOWN).map((person) => {
    const where = person.tabId ? tabTitle(person.tabId) : null;
    return `${nameOf(person.userId)}${person.role === "viewer" ? " (viewing only)" : ""}${person.activity === "typing" ? " · typing" : ""}${where ? ` · on ${where}` : ""}`;
  });
  const more = others.length - shown.length;
  return `Also here: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** What became of something this phone sent; null once there is nothing to say (it was applied). */
export function outboxLine(entry: OutboxEntry, stopped = false, nameOf: NameOf = () => "Someone else"): { tone: "idle" | "warn"; text: string } | null {
  if (entry.state === "applied") return null;
  if (entry.state === "rejected" && entry.category === "lease-held") {
    const holder = entry.receipt?.holderId;
    return { tone: "warn", text: `${typeof holder === "string" ? nameOf(holder) : "Someone else"} is driving. Your message was not sent.` };
  }
  if (entry.state === "rejected" && entry.category === "access-revoked") return { tone: "warn", text: "Not sent: your access changed." };
  if (entry.asleep) return { tone: "warn", text: "Not started. This workspace is stopped, and sending starts it." };
  if (entry.state === "unsent") return { tone: "warn", text: stopped ? "Not sent. This workspace is stopped, and sending starts it." : "Not delivered yet. It is sent when the phone is back online." };
  if (entry.state === "queued") return { tone: "idle", text: entry.wake === "queued" || entry.wake === "in-progress" ? "Starting the workspace…" : entry.wake === "unavailable" ? "Waiting: the workspace could not be started." : "Sent. Waiting for the agent." };
  if (entry.state === "leased") return { tone: "idle", text: "Delivering…" };
  if (entry.state === "cancelled") return { tone: "idle", text: "Cancelled." };
  if (entry.state === "outcome-unknown") return { tone: "warn", text: "It is not known whether this arrived." };
  return { tone: "warn", text: codeText(entry.category) ?? "The workspace refused this." };
}

const ORGANIZATION_ROLES: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
/** A person's role in an organization, in words; a role this app does not know reads as Member. */
export const organizationRoleName = (role: string): string => ORGANIZATION_ROLES[role] ?? "Member";
