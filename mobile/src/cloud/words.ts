import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { CloudRole } from "./api";
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

const CODES: Record<string, string> = {
  account_signed_out: "Sign in to see your cloud workspaces.",
  cloud_workspace_unavailable: "The service could not be reached. What is shown may be out of date.",
  cloud_provider_unavailable: "The cloud provider is not answering right now.",
  cloud_workspace_not_found: "This workspace is not available to you, or it has stopped.",
  cloud_workspace_forbidden: "You do not have access to this workspace.",
  cloud_workspace_collaboration_forbidden: "Your role in this workspace does not allow that.",
  cloud_workspace_transcript_unreadable: "The saved conversation could not be read.",
  cloud_workspace_invalid_response: "Update the app to use this workspace.",
  cloud_workspace_stopped: "This workspace has stopped.",
  cloud_workspace_archived: "This workspace is archived.",
  cloud_workspace_rate_limited: "Too many requests just now. Try again in a moment.",
  cloud_workspace_agent_command_limit: "Too many messages are waiting for this workspace. Wait for the agent, or cancel one.",
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

/** One line for the banner above a workspace's conversation. */
export function connectionLine(connection: WorkspaceConnectionState, listedState: string | null, problem: CloudLinkProblem, starting = false): { tone: "live" | "idle" | "warn"; text: string } {
  if (connection.state === "connected") return { tone: "live", text: "Live · end-to-end encrypted" };
  if (connection.state === "updateRequired") return { tone: "warn", text: "Update the app to connect to this workspace." };
  if (listedState === "archived") return { tone: "idle", text: "Archived. Showing the saved conversation." };
  // Asked to start by a message, or already starting: said as long as it lasts, so a workspace that bills is never shown as stopped.
  if (starting || listedState === "provisioning" || listedState === "resuming") return { tone: "idle", text: "Starting the workspace…" };
  if (listedState === "suspending") return { tone: "idle", text: "Stopping…" };
  if (listedState === "suspended" || connection.state === "suspended") return { tone: "idle", text: "Stopped. Showing the saved conversation; nothing is running." };
  if (listedState === null) return { tone: "warn", text: "This workspace is no longer available to you." };
  if (connection.state === "waitingForRuntime") return { tone: "idle", text: "Starting…" };
  if (connection.state === "reconnecting") return { tone: "warn", text: problem?.kind === "api" && problem.unreachable ? "Offline. Reconnecting…" : "Reconnecting…" };
  if (connection.state === "stopped") return { tone: "warn", text: problem?.kind === "gave-up" ? "Could not connect to this workspace." : ((problem?.kind === "api" ? codeText(problem.code) : null) ?? "Not connected.") };
  return { tone: "idle", text: "Connecting…" };
}

/** Why a workspace that was asked for cannot be shown, by what the list says of this person's access. */
export function accessText(access: "not-shared" | "deleted" | "gone"): { title: string; detail: string } {
  if (access === "not-shared") return { title: "This workspace has not been shared with you", detail: "Ask an organization admin or its creator to share it." };
  if (access === "deleted") return { title: "This workspace was deleted", detail: "Nothing of it is kept on this phone." };
  return { title: "This workspace is no longer shared with you", detail: "What this phone kept of it was removed. Ask an organization admin or its creator if you need it again." };
}

/** What became of something this phone sent; null once there is nothing to say (it was applied). */
export function outboxLine(entry: OutboxEntry, stopped = false): { tone: "idle" | "warn"; text: string } | null {
  if (entry.state === "applied") return null;
  if (entry.state === "unsent") return { tone: "warn", text: stopped ? "Not sent. This workspace is stopped, and sending starts it." : "Not delivered yet. It is sent when the phone is back online." };
  if (entry.state === "queued") return { tone: "idle", text: entry.wake === "queued" || entry.wake === "in-progress" ? "Starting the workspace…" : entry.wake === "unavailable" ? "Waiting: the workspace could not be started." : "Sent. Waiting for the agent." };
  if (entry.state === "leased") return { tone: "idle", text: "Delivering…" };
  if (entry.state === "cancelled") return { tone: "idle", text: "Cancelled." };
  if (entry.state === "outcome-unknown") return { tone: "warn", text: "It is not known whether this arrived." };
  return { tone: "warn", text: codeText(entry.category) ?? "The workspace refused this." };
}
