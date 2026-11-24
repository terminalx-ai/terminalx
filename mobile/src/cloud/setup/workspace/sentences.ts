import { CloudApiError } from "../../api";
import { refusalText } from "../../words";

/**
 * What the workspace page says while a launch runs, when it does not finish,
 * and around Stop and Delete (boards 25.05 rows 5 and 6, and 25.06), word for
 * word. The server answers the phone with codes; every sentence is the phone's.
 */

/** A launch's stages, in the console's words, in the order the operation goes through them. */
export const LAUNCH_STAGES = ["Queued", "Checking the provider", "Creating the machine", "Installing the runtime", "Connecting to the relay", "Ready"] as const;

export const LAUNCH = {
  launching: "Launching…",
  canceling: "Canceling…",
  canceled: "Launch canceled",
  failed: "The launch failed",
  running: (name: string) => `${name} is running`,
  mayLeave: "You can leave this page. The launch carries on, and the workspace shows in the Cloud tab.",
  noLongerCancelable: "It can no longer be canceled. Once it is running you can stop or delete it.",
  removing: "Removing what was created so far.",
  cleaningUp: "Cleaning up",
  canceledStage: "Canceled",
  opening: "Opening it in a moment…",
  offline: "Offline. The launch carries on without the phone; this page catches up when it is back online.",
  reading: "Reading the launch…",
  readingDetail: "Asking the service how far it is.",
  cancelTitle: "Cancel this launch?",
  /** The owner's words (25.07, question 10), with the provider's name from its descriptor. */
  cancelMessage: (provider: string) => `The machine being created is removed. ${provider} may bill for the time it existed.`,
  cancel: "Cancel launch",
  keep: "Keep launching",
  open: "Open workspace",
  launchAgain: "Launch again",
  backToCloud: "Back to Cloud",
  retrySetup: "Retry setup",
  fixKey: "Fix the provider key",
  delete: "Delete workspace…",
  retryTitle: "Retry setup?",
  retryMessage: "It is billed to the organization while it runs.",
} as const;

/** The operation's events, under the stage they belong to (25.05: credentials, repository). */
export const EVENT_SENTENCES: Readonly<Record<string, string>> = {
  "credentials-installing": "Installing the agent logins",
  "repository-cloning": "Cloning the repository",
};

/** Why a launch failed, in the console's sentence, by the operation's error code. */
export function launchCause(code: string | undefined): { kind: LaunchFailureKind; text: string } {
  switch (code) {
    case "cloud_workspace_runtime_bootstrap_failed":
    case "bootstrap_failed":
      return { kind: "runtime", text: "Installing or starting the runtime on the machine failed." };
    case "cloud_provider_credential_invalid":
      return { kind: "key", text: "The provider rejected the API key." };
    case "cloud_workspace_provisioning_timeout":
    case "provisioning_deadline_exceeded":
      return { kind: "timeout", text: "The workspace’s machine took too long to start." };
    default: {
      // A code the setup screens have words for is said in them; anything else is never shown as a code.
      if (code) {
        const error = new CloudApiError(code, 409);
        if (error.refusal !== "unknown") return { kind: "other", text: refusalText(error) };
      }
      return { kind: "other", text: "The launch did not finish." };
    }
  }
}

export type LaunchFailureKind = "runtime" | "key" | "timeout" | "other";

/** What a launch that ended left at the provider, said plainly because it may cost money. */
export const LEFT = {
  removed: "The machine was removed.",
  none: "No machine was created.",
  stopped: "The machine exists and was stopped to avoid charges after a problem.",
  unknown: (provider: string) => `Check ${provider}’s dashboard if a machine is still listed there.`,
} as const;

/** What can be done next, after what was left. */
export const NEXT = {
  canceled: "Launching again asks for a new price.",
  runtime: "Retry setup tries again on the same machine; delete it if you would rather start over.",
  key: "Connect a working key, then launch again.",
  startOver: "Delete it and launch a new one.",
} as const;

export const STOP = {
  action: "Stop workspace",
  start: "Start workspace",
  delete: "Delete workspace…",
  title: "Stop this workspace?",
  message: "Its agents stop until it is started again.",
  workingTitle: "Stop while an agent is working?",
  working: (agent: string | null) => `${agent ?? "An agent"} is in the middle of a turn. Stopping interrupts it; what it has not saved may be lost.`,
  confirm: "Stop",
  confirmWorking: "Stop anyway",
  cancel: "Cancel",
  busyTitle: "Not right now",
  refusedTitle: "The workspace was not stopped",
  ok: "OK",
  stoppingTitle: "Stopping the workspace…",
  /** The console's two waiting sentences, joined. */
  stoppingDetail: "Saving the workspace, then suspending the machine.",
  stoppingButton: "Stopping…",
  stoppingShort: "Stopping…",
  failedTitle: "The workspace did not stop",
  failedDetail: (cause: string) => `${cause} It may still be running, and billing.`,
  retry: "Retry stop",
  startTitle: "Start this workspace?",
  startMessage: "It is billed to the organization while it runs.",
  startConfirm: "Start",
  startFailedTitle: "The workspace did not start",
} as const;

/** Why a stop did not finish, by the operation's error code. */
export function stopCause(code: string | null | undefined): string {
  if (code === "cloud_provider_unavailable" || code === "cloud_provider_invalid_response" || code === "cloud_provider_rate_limited") return "The provider could not be reached.";
  if (code === "cloud_provider_permission_denied") return "The provider refused to stop it.";
  return "The stop did not finish.";
}

/**
 * The provider's own billing line from its descriptor, after its name, as the
 * Stop alert quotes it ("Boat: per second, billed by Boat."). Nothing more is
 * claimed about what a stopped workspace costs (25.07, question 15).
 */
export function billingLine(provider: { label: string; billing: string } | null): string | null {
  if (!provider) return null;
  const line = provider.billing.trim();
  if (!line) return null;
  // "Per second, …" reads on after the name; a name it starts with ("TerminalX …", "Boat …") keeps its capital.
  const word = line.split(/[\s,.;:]/)[0] ?? "";
  const name = /[A-Z]/.test(word.slice(1)) || provider.label.split(/\s/)[0] === word;
  const joined = name ? line : `${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  return `${provider.label}: ${joined.endsWith(".") ? joined : `${joined}.`}`;
}

export const DELETE = {
  pageTitle: "Delete workspace",
  question: (name: string) => `Delete ${name} permanently?`,
  facts: (provider: string) => [
    { label: "Compute", value: "The machine is removed." },
    { label: "Data", value: `Its disk, snapshots and saved conversations are removed once ${provider} confirms.` },
    { label: "Charges", value: `Stop once ${provider} confirms the removal.` },
    { label: "Undo", value: "Not possible." },
  ],
  keep: "Push or copy out any work you want to keep before deleting.",
  acknowledge: "I understand this cannot be undone: the machine, its disk and snapshots, and the saved conversations are removed.",
  confirm: "Delete permanently",
  sending: "Deleting…",
  cancel: "Cancel",
  offline: "No connection. Nothing was deleted. Try again when the phone is back online.",
  unavailable: "Workspace unavailable",
  unavailableDetail: "Sign in, then open it again from the Cloud tab.",
  reading: "Reading the workspace…",
  readingDetail: "From the list of workspaces in your account.",
  /** When the provider's name could not be read at all. */
  someProvider: "the provider",
  removedHeading: "What was removed",
  again: "Delete again",
  billed: (provider: string) => `Until ${provider} confirms, the machine may still be billed.`,
  refused: (provider: string, code: string | undefined) => `${provider} refused to delete this machine${code ? ` (${code})` : ""}. Check it in your ${provider} dashboard; if it is still there, delete it there, then press Delete again to clear it here.`,
  unconfirmed: (provider: string) => `${provider} did not confirm the removal. Check it in your ${provider} dashboard; if it is still there, delete it there, then press Delete again to clear it here.`,
} as const;

/** The cleanup report's parts, in plain words (25.06). */
export const CLEANUP_KINDS: Readonly<Record<string, string>> = {
  "runtime-credentials": "Runtime credentials",
  "client-attachments": "Phones and desktops",
  "provider-compute": "Machine",
  "provider-storage": "Disk and snapshots",
  "workspace-content": "Saved conversations",
};

/** One part's state, and how it is drawn: done, waiting, or what may still cost money. */
export function cleanupState(kind: string, state: string): { value: string; tone: "success" | "warning" | "danger" } {
  if (state === "removed") return { value: kind === "client-attachments" ? "Disconnected" : "Removed", tone: "success" };
  if (state === "pending") return { value: "Pending", tone: "warning" };
  return { value: "Not confirmed", tone: "danger" };
}
