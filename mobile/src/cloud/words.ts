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
  return state;
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
  "read-only": "You can view this workspace but not send to it.",
  "cannot-approve": "Only someone allowed to approve can answer this request.",
  "no-key": "This phone has not been connected to this workspace while it was running, so it cannot send to it or read its saved conversation yet.",
  "would-wake": "This workspace is stopped. Sending starts it.",
  unavailable: "This workspace cannot take messages right now.",
};

/** A sentence for a refusal code; the code itself is kept for anything unknown. */
export function codeText(code: string | null | undefined): string | null {
  if (!code) return null;
  return CODES[code] ?? `That did not work (${code.replace(/_/g, " ")}).`;
}

/** One line for the banner above a workspace's conversation. */
export function connectionLine(connection: WorkspaceConnectionState, listedState: string | null, problem: CloudLinkProblem): { tone: "live" | "idle" | "warn"; text: string } {
  if (connection.state === "connected") return { tone: "live", text: "Live · end-to-end encrypted" };
  if (connection.state === "updateRequired") return { tone: "warn", text: "Update the app to connect to this workspace." };
  if (listedState === "archived") return { tone: "idle", text: "Archived. Showing the saved conversation." };
  if (listedState === "suspended" || connection.state === "suspended") return { tone: "idle", text: "Stopped. Showing the saved conversation; nothing is running." };
  if (listedState === null) return { tone: "warn", text: "This workspace is no longer available to you." };
  if (connection.state === "waitingForRuntime") return { tone: "idle", text: "Starting…" };
  if (connection.state === "reconnecting") return { tone: "warn", text: problem?.kind === "api" && problem.unreachable ? "Offline. Reconnecting…" : "Reconnecting…" };
  if (connection.state === "stopped") return { tone: "warn", text: (problem?.kind === "api" ? codeText(problem.code) : null) ?? "Not connected." };
  return { tone: "idle", text: "Connecting…" };
}

/** What became of something this phone sent; null once there is nothing to say (it was applied). */
export function outboxLine(entry: OutboxEntry): { tone: "idle" | "warn"; text: string } | null {
  if (entry.state === "applied") return null;
  if (entry.state === "unsent") return { tone: "warn", text: "Not delivered yet. It is sent when the phone is back online." };
  if (entry.state === "queued") return { tone: "idle", text: entry.wake === "queued" || entry.wake === "in-progress" ? "Starting the workspace…" : entry.wake === "unavailable" ? "Waiting: the workspace could not be started." : "Sent. Waiting for the agent." };
  if (entry.state === "leased") return { tone: "idle", text: "Delivering…" };
  if (entry.state === "cancelled") return { tone: "idle", text: "Cancelled." };
  if (entry.state === "outcome-unknown") return { tone: "warn", text: "It is not known whether this arrived." };
  return { tone: "warn", text: codeText(entry.category) ?? "The workspace refused this." };
}
