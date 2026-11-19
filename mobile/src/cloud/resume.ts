import { CloudApiError, type CloudWorkspaceItem } from "./api";
import { codeText } from "./words";

/**
 * Resuming a stopped cloud workspace from the phone (#1290): what a failure
 * says, what can be done next, and what goes to the connection log.
 *
 * Stages: `request`: the resume was asked for and the service refused it, or
 * no answer came; `answer`: an answer came that this app cannot read;
 * `operation`: the service took the resume and it failed afterwards (the
 * workspace then needs attention); `open`: the workspace runs and connecting
 * this phone to it was refused.
 */
export type ResumeStage = "request" | "answer" | "operation" | "open";

export interface ResumeFailure {
  stage: ResumeStage;
  /** The service's code, or this app's name for what happened when there was none. */
  code: string;
  status: number | null;
  /** What failed and what to do next, in plain words. */
  text: string;
  /** Whether asking again can help: the Start button is then "Try again". */
  retry: boolean;
}

/** Codes a resume can be refused with, said for a resume (the shared `codeText` says them for any request). */
const RESUME_TEXT: Record<string, { text: string; retry: boolean }> = {
  account_signed_out: { text: "This phone is signed out. Sign in again from Settings, then start the workspace.", retry: false },
  cloud_workspace_operation_in_progress: { text: "Another action on this workspace is still running. Try again when it finishes.", retry: true },
  cloud_workspace_archived: { text: "This workspace is archived. Unarchive it on the desktop, then start it.", retry: false },
  cloud_workspace_not_found: { text: "This workspace is no longer available to you, so it cannot be started.", retry: false },
  cloud_workspace_manager_required: { text: "Only this workspace's creator or an organization owner or admin can start it.", retry: false },
  cloud_workspace_member_concurrency_exceeded: { text: "You already have as many cloud workspaces running as your organization allows one person. Stop one of yours, then try again.", retry: true },
  cloud_workspace_concurrency_exceeded: { text: "Your organization is running as many cloud workspaces as its limit allows. Stop one, then try again.", retry: true },
  cloud_workspace_rate_limited: { text: "Too many requests just now. Try again in a moment.", retry: true },
  cloud_provider_unavailable: { text: "The cloud provider is not answering right now. Try again in a moment.", retry: true },
  cloud_provider_rate_limited: { text: "The cloud provider is rate limiting requests. Try again in a moment.", retry: true },
  cloud_provider_credential_invalid: { text: "The provider credential is no longer valid. An owner or admin can repair it in Settings on the desktop, then try again.", retry: true },
  cloud_provider_connection_attention_required: { text: "The organization's provider connection needs attention. An owner or admin can repair it in Settings on the desktop, then try again.", retry: true },
  cloud_workspace_policy_denied: { text: "Your organization's compute policy does not allow starting this workspace. An owner or admin can check its limits on the desktop.", retry: false },
};

/**
 * A resume that may have been under way (no answer, the service failed, or it
 * said another action runs), with whether the list was read again to check:
 * `listChecked` false when that read failed too, so nothing is said about it.
 */
export class ResumeUnconfirmed extends CloudApiError {
  constructor(from: CloudApiError, readonly listChecked: boolean) {
    super(from.code, from.status, from.reason);
    this.name = "ResumeUnconfirmed";
  }
}

/** Why asking to resume failed, from what `CloudCatalog.start` threw. */
export function resumeFailure(error: unknown): ResumeFailure {
  if (!(error instanceof CloudApiError)) {
    // Nothing the service said: something on this phone stopped the request.
    return { stage: "request", code: "client_error", status: null, text: "This phone could not send the request to start the workspace. Try again.", retry: true };
  }
  const { code, status, reason } = error;
  if (code === "cloud_workspace_invalid_response") {
    return { stage: "answer", code, status, text: "The service answered in a way this version of the app cannot read. The workspace may be starting anyway; update the app to follow it here.", retry: false };
  }
  if (reason === "timeout") {
    // Only said to be checked when the list was read again after the timeout (`CloudCatalog.start`).
    const checked = error instanceof ResumeUnconfirmed && error.listChecked;
    return { stage: "request", code: "timeout", status, text: checked
      ? "The service did not answer in time, and the list does not show the workspace starting. Try again."
      : "The service did not answer in time, and the list could not be read to check whether the workspace is starting. If it stays stopped, try again.", retry: true };
  }
  if (reason === "network") {
    return { stage: "request", code: "network", status, text: "This phone could not reach the service. Check its connection, then try again.", retry: true };
  }
  if (reason === "unreadable") {
    return { stage: "request", code: `http_${status ?? "none"}`, status, text: "The service had a problem and did not start the workspace. Try again in a moment.", retry: true };
  }
  const known = RESUME_TEXT[code];
  if (known) return { stage: "request", code, status, ...known };
  // A code the shared words know (said for any request), else one this app does not know: never shown as it is.
  const shared = codeText(code);
  if (shared && !shared.startsWith("That did not work")) return { stage: "request", code, status, text: `The workspace was not started: ${lowerFirst(shared)}`, retry: error.unreachable };
  return { stage: "request", code, status, text: "The service would not start this workspace. Try again; if it keeps failing, open it on the desktop to see why.", retry: true };
}

/**
 * Whether a resume the person asked for may be under way although asking
 * failed: no answer came (or the service failed), or it says another action
 * runs. The list, read again, then says whether it is.
 */
export function mayBeUnderWay(error: unknown): boolean {
  if (!(error instanceof CloudApiError)) return false;
  if (error.code === "cloud_workspace_operation_in_progress" || error.code === "cloud_workspace_invalid_response") return true;
  return error.reason === "timeout" || (error.status !== null && error.status >= 500);
}

/** Whether the list shows the workspace starting, or already running: a resume is under way or done. */
export function listedAsStarting(item: Pick<CloudWorkspaceItem, "workspace" | "latestOperation"> | null | undefined): boolean {
  if (!item) return false;
  const { state } = item.workspace;
  if (state === "resuming" || state === "provisioning" || state === "ready") return true;
  const operation = item.latestOperation;
  return operation?.action === "resume" && (operation.state === "queued" || operation.state === "running");
}

/** Whether "Retry resume" is offered for a workspace that needs attention: its last resume failed, as the desktop offers it. */
export function resumeRetryable(operation: { state: string; action?: string | null } | null | undefined): boolean {
  return operation?.state === "failed" && operation.action === "resume";
}

/** One line for the connection log: the stage and code of a failed resume, so a report can include them. */
export function resumeLogDetail(failure: Pick<ResumeFailure, "stage" | "code" | "status">, workspaceId: string): string {
  return `workspace ${workspaceId.slice(0, 8)} · stage ${failure.stage} · code ${failure.code}${failure.status !== null ? ` · HTTP ${failure.status}` : ""}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
