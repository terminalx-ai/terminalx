import { CloudApiError, type CloudApi, type CloudCredential, type CloudFirstRunSetup, type CloudLaunch, type CloudLifecycle, type CloudOperation, type CloudPreflight, type CloudProvider, type CloudProviderSetup, type CloudQuote, type CloudWorkspace } from "./api";

/**
 * Launching a cloud workspace from the phone, and stopping and deleting one
 * (boards 25.05 and 25.06): what is offered, what is sent, and what the
 * phone says. The server answers with codes only, so every sentence is here.
 * They are the web console's (terminalx-saas `packages/i18n` `console.cloud*`)
 * in the phone's words: workspace, not machine; Stop and Start, not Suspend
 * and Resume; no exclamation marks.
 */

// ── What can be launched on ──

/**
 * The providers a workspace can be launched on from here: connected, open to
 * new workspaces, and billed by the provider itself. One that TerminalX bills
 * (TerminalX Cloud) is left out: the spend confirmation says the provider
 * bills directly, which would be wrong for it, and its own sentence is not
 * written yet.
 *
 * `blocked` says why there is none: nothing is connected, or new workspaces
 * are switched off for every provider that is.
 */
export function launchProviders(providers: readonly CloudProvider[]): { choices: CloudProvider[]; blocked: "not-connected" | "paused" | null } {
  const billed = providers.filter((provider) => provider.descriptor.billedByProvider);
  const choices = billed.filter((provider) => provider.availability === "available");
  if (choices.length) return { choices, blocked: null };
  const paused = billed.some((provider) => provider.availability === "disabled-for-create") && !billed.some((provider) => provider.availability === "not-connected" || provider.availability === "attention-required");
  return { choices, blocked: paused ? "paused" : "not-connected" };
}

/** A provider's name as the server gives it. */
export const providerLabel = (provider: Pick<CloudProvider, "displayName" | "descriptor">): string => provider.descriptor.label || provider.displayName;

// ── The form's choices, in words ──

/** The idle times the server allows for this provider, shortest first, with "never" (0) last. */
export function idleChoices(setup: Pick<CloudProviderSetup, "allowedIdleSuspendMinutes" | "maxIdleSuspendMinutes">): number[] {
  const max = setup.maxIdleSuspendMinutes;
  // An organization's limit on the idle time also rules out "never".
  const allowed = setup.allowedIdleSuspendMinutes.filter((minutes) => max == null || (minutes !== 0 && minutes <= max));
  return [...new Set(allowed)].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
}

/** An idle time as the sheet lists it. */
export const idleChoiceLabel = (minutes: number): string => (minutes === 0 ? "Never: always on" : minutes === 1 ? "1 minute" : `${minutes} minutes`);
/** An idle time as the form's row and the review say it. */
export const idleValue = (minutes: number): string => (minutes === 0 ? "Never" : `After ${idleChoiceLabel(minutes)}`);

const gib = (mib: number): string => String(Math.round((mib / 1024) * 10) / 10);

type MachineClass = CloudProviderSetup["machineClasses"][number];
/** A size on the form's row: its name, and its hourly rate (already written as a price) where the provider gives one. */
export function sizeValue(size: Pick<MachineClass, "label">, hourly: string | null): string {
  return hourly === null ? size.label : `${size.label} · ${hourly} / hour`;
}
/** A size's machine in the sheet, as the console writes it. */
export const sizeDetail = (size: Pick<MachineClass, "vcpu" | "memoryMiB" | "diskGiB">): string => `${size.vcpu} vCPU · ${gib(size.memoryMiB)} GiB memory · ${size.diskGiB} GiB disk`;
/** The quoted machine on the review. */
export function quotedSize(configuration: CloudQuote["configuration"]): string {
  return `${configuration.machineClassLabel} · ${configuration.vcpu} vCPU · ${gib(configuration.memoryMiB)} GiB · ${configuration.diskGiB} GiB`;
}

/** Who bills and how sure the figures are: the provider's own billing line, then the console's sentence on the prices. */
export function pricingNote(provider: Pick<CloudProvider, "descriptor">, pricing: string): string {
  const billing = provider.descriptor.billing.trim().replace(/[.\s]+$/, "");
  const prices = pricing === "provider-rate" ? "Prices come from the provider's live rates." : "Prices shown are estimates.";
  return billing ? `${billing}. ${prices}` : prices;
}

/** The console's spend notice, unchanged: said before anything is created. */
export const SPEND_NOTICE = "Your cloud provider bills this machine directly, not TerminalX.";
/** The console's line on who can use a workspace launched for the organization, in the phone's words. */
export const ACCESS_NOTICE = "Every member of this organization can use this workspace and steer its sessions.";

// ── The repository ──

export const REPOSITORY_INVALID = "Enter a GitHub repository URL like https://github.com/organization/repository.";
const REPOSITORY = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;
const REFUSED_SEGMENTS = [".", "..", ".git"];

/**
 * A typed or pasted GitHub repository as the server takes it: the https clone
 * URL, with its `owner/name`. Null for anything else; an empty field is not a
 * repository and is not asked about here.
 */
export function repositoryOf(typed: string): { cloneUrl: string; fullName: string } | null {
  const match = REPOSITORY.exec(typed.trim());
  const owner = match?.[1];
  const name = match?.[2];
  if (!owner || !name || REFUSED_SEGMENTS.includes(owner) || REFUSED_SEGMENTS.includes(name)) return null;
  return { cloneUrl: `https://github.com/${owner}/${name}`, fullName: `${owner}/${name}` };
}

// ── Agent logins ──

const AGENT_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude Code", cursor: "Cursor", github: "GitHub" };
/** An agent or service a login is stored for, by name; one this app does not know keeps the server's word. */
export const credentialName = (provider: string): string => AGENT_NAMES[provider] ?? provider;

/** The stored logins a workspace can be given an agent with: the agents', in a state that works. */
export function agentLogins(credentials: readonly CloudCredential[]): CloudCredential[] {
  return credentials.filter((credential) => credential.provider !== "github" && credential.state === "connected");
}

/** Who a login is, beside its agent: the account it names, else what kind of login it is. */
export function loginDetail(credential: Pick<CloudCredential, "displayIdentity" | "authKind">): string {
  if (credential.displayIdentity) return credential.displayIdentity;
  return credential.authKind === "api-key" ? "API key" : credential.authKind === "personal-access-token" ? "Access token" : "Signed in";
}

export interface LaunchDraft {
  repository: { cloneUrl: string; fullName: string } | null;
  ref: string;
  /** The ids of the agent logins that are ticked. */
  agentIds: readonly string[];
}

/**
 * What the new workspace starts with, as the console builds it: the
 * repository, the saved GitHub token when there is a repository to clone, and
 * the chosen agent logins. Nothing chosen is no setup at all: a bare workspace.
 */
export function firstRunSetup(draft: LaunchDraft, credentials: readonly CloudCredential[]): CloudFirstRunSetup | undefined {
  const github = draft.repository ? credentials.find((credential) => credential.provider === "github" && credential.state === "connected") : undefined;
  const agents = agentLogins(credentials).filter((credential) => draft.agentIds.includes(credential.id));
  const credentialIds = [...(github ? [github.id] : []), ...agents.map((credential) => credential.id)];
  if (!draft.repository && !credentialIds.length) return undefined;
  const ref = draft.ref.trim();
  return { credentialIds, ...(draft.repository ? { repositories: [{ cloneUrl: draft.repository.cloneUrl, ...(ref ? { ref } : {}) }] } : {}) };
}

// ── Preflight ──

const PREFLIGHT_UNAVAILABLE = "Verification is temporarily unavailable. Try again in a moment.";
const PREFLIGHT: Record<string, string> = {
  cloud_agent_credential_reauth_required: "Sign-in required.",
  cloud_workspace_credential_invalid: "A credential failed verification. Replace it and try again.",
  cloud_workspace_credential_verification_unavailable: PREFLIGHT_UNAVAILABLE,
  cloud_workspace_repository_credential_required: "This repository needs a GitHub personal access token.",
  cloud_workspace_repository_not_accessible: "The repository is not accessible with the provided credentials.",
  cloud_workspace_repository_ref_not_found: "That branch or tag was not found in the repository.",
  cloud_workspace_repository_verification_unavailable: PREFLIGHT_UNAVAILABLE,
  cloud_workspace_agent_credential_required: "Connect at least one AI agent.",
};
const REF_NOT_FOUND = "cloud_workspace_repository_ref_not_found";

export interface PreflightProblems {
  /** Every failed check, one line each, named by what it is about. */
  items: string[];
  /** The sentence for the repository's own field, and for its branch. */
  repository: string | null;
  ref: string | null;
  /** The repository is private and no GitHub token is saved: the way on is Agent logins. */
  needsGithubToken: boolean;
  /** The agents (by login provider) whose login failed its check: a first task on one of them is marked. */
  agents?: string[];
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** The heading over the failed checks. */
export function problemsTitle(count: number): string {
  return `${NUMBERS[count] ?? count} ${count === 1 ? "thing" : "things"} to fix before this can be priced`;
}

/**
 * The failed checks of a preflight, in the console's sentences. There are no
 * warnings: anything that failed blocks, so each one is listed.
 */
export function preflightProblems(preflight: CloudPreflight, draft: Pick<LaunchDraft, "repository">, credentials: readonly CloudCredential[]): PreflightProblems | null {
  const failed = preflight.checks.filter((check) => check.status === "failed");
  // Not ready with nothing named: said as the check itself not having worked.
  if (!failed.length) return preflight.ready ? null : { items: [PREFLIGHT_UNAVAILABLE], repository: null, ref: null, needsGithubToken: false };
  const problems: PreflightProblems = { items: [], repository: null, ref: null, needsGithubToken: false };
  for (const check of failed) {
    const name = check.kind === "agent-credential" ? check.agent ?? check.provider : check.kind === "credential" ? check.provider ?? credentials.find((credential) => credential.id === check.credentialId)?.provider : undefined;
    const label = name ? credentialName(name) : null;
    const sentence = check.errorCode === "cloud_workspace_credential_invalid" && label && check.kind !== "repository"
      ? `The ${label} credential failed verification. It may have expired.`
      : (check.errorCode ? PREFLIGHT[check.errorCode] : undefined) ?? PREFLIGHT_UNAVAILABLE;
    if (check.kind === "repository") {
      const subject = (check.cloneUrl ? repositoryOf(check.cloneUrl)?.fullName : null) ?? draft.repository?.fullName ?? "Repository";
      problems.items.push(`${subject}: ${lowerFirst(sentence)}`);
      if (check.errorCode === REF_NOT_FOUND) problems.ref = sentence;
      else problems.repository = sentence;
      if (check.errorCode === "cloud_workspace_repository_credential_required") problems.needsGithubToken = true;
    } else {
      problems.items.push(label && !sentence.includes(label) ? `${label}: ${lowerFirst(sentence)}` : sentence);
      if (name && !(problems.agents ??= []).includes(name)) problems.agents.push(name);
    }
  }
  return problems;
}

// ── Refusals ──

/** What a refusal leaves to do: a new price, compute to connect or repair, or nothing but waiting. */
export type LaunchFix = "new-price" | "compute" | null;
export interface LaunchRefusal {
  text: string;
  fix: LaunchFix;
  /** Nothing can be launched here for now: said in place of the form. */
  closed: boolean;
}

export const QUOTE_EXPIRED = "That estimate expired. Nothing was launched. Get a new price to carry on.";
const PAUSED = "New cloud workspaces are paused for this organization.";
const RUNTIME_NOT_READY = "Cloud workspaces are not available yet: the server has not installed a compatible TerminalX runtime. Try again later.";
const DID_NOT_WORK = "That did not work. Try again in a moment.";
/** The desktop's sentence for `cloud_workspace_launch_invalid`: a first task's agent, model or effort was refused. */
export const LAUNCH_INVALID = "Choose a valid agent, model and effort.";
/** The desktop's 32 KB sentence, about the phone's first task. */
export const FIRST_TASK_TOO_LONG = "The first task is longer than 32 KB.";

const REFUSED: Record<string, string> = {
  cloud_workspace_quote_expired: QUOTE_EXPIRED,
  cloud_environment_changed: QUOTE_EXPIRED,
  cloud_provider_connection_required: "Connect a compute provider first.",
  machine0_connection_required: "Connect a compute provider first.",
  cloud_workspace_credential_required: "Connect at least one AI agent.",
  cloud_workspace_agent_credential_required: "Connect at least one AI agent.",
  cloud_workspace_quota_exceeded: "This organization has reached its limit on cloud workspaces, stopped ones included. Delete one, then try again.",
  cloud_workspace_concurrency_exceeded: "Your organization is running as many cloud workspaces as its limit allows.",
  cloud_workspace_member_concurrency_exceeded: "You already have as many cloud workspaces running as your organization allows one person. Stop one of yours first.",
  cloud_workspace_create_budget_exceeded: "You have created as many cloud workspaces as your organization allows one person for now. Try again later.",
  cloud_workspace_policy_denied: "That size, region or idle setting is not allowed by this organization’s limits.",
  cloud_provisioning_paused: PAUSED,
  cloud_provider_creation_disabled: PAUSED,
  cloud_provider_disabled: PAUSED,
  cloud_workspace_runtime_not_ready: RUNTIME_NOT_READY,
  terminalx_pro_required: "An active TerminalX Pro license is required to start machines TerminalX hosts.",
  cloud_workspace_rate_limited: "Too many requests just now. Try again in a moment.",
  cloud_provider_rate_limited: "The provider rate-limited TerminalX.",
  cloud_provider_unavailable: "The cloud provider is not answering right now.",
  cloud_provider_billing_required: "The provider account needs a billing fix before it will act.",
  cloud_provider_permission_denied: "The provider refused this action, but the API key is still valid.",
  cloud_provider_credential_invalid: "The provider rejected the API key.",
  cloud_workspace_manager_required: "Only this workspace's creator or an organization owner or admin can do that.",
  cloud_workspace_operation_in_progress: "Something else is still under way on this workspace. Try again when it has finished.",
  cloud_workspace_active_work: "An agent is working here, or is waiting for an answer. Stop it or answer it, then delete.",
  cloud_workspace_request_invalid: "That workspace request is not valid. Check the name, the repository and the branch.",
  cloud_workspace_launch_invalid: LAUNCH_INVALID,
  cloud_workspace_prompt_too_long: FIRST_TASK_TOO_LONG,
  cloud_workspace_invalid_response: "Update the app to launch a workspace.",
  account_signed_out: "Sign in to launch a cloud workspace.",
  organization_admin_required: "An organization owner or admin must do that.",
};

/** What the phone says for a refused or failed request of these screens, and what it leaves to do. */
export function launchRefusal(error: unknown, provider: string | null = null): LaunchRefusal {
  if (!(error instanceof CloudApiError)) return { text: DID_NOT_WORK, fix: null, closed: false };
  const kind = error.refusal;
  if (kind === "unreachable" && !REFUSED[error.code]) return { text: "The service could not be reached. Nothing was launched.", fix: null, closed: false };
  if (kind === "provider-needs-attention") return { text: `${provider ?? "The provider"} rejected the stored key on its last check. Replace the key to continue.`, fix: "compute", closed: false };
  const text = REFUSED[error.code] ?? (kind === "signed-out" ? REFUSED.account_signed_out! : DID_NOT_WORK);
  return {
    text,
    fix: kind === "quote-expired" ? "new-price" : kind === "provider-not-connected" || kind === "provider-key-invalid" ? "compute" : null,
    closed: kind === "provisioning-paused" || kind === "provider-not-offered" || error.code === "cloud_workspace_runtime_not_ready",
  };
}

/** No readable answer came: the request may or may not have been acted on. */
export function unanswered(error: unknown): boolean {
  return error instanceof CloudApiError && (error.status === null || error.reason !== null);
}

// ── Launching once ──

export interface LaunchInput { name: string; quoteId: string; setup?: CloudFirstRunSetup; launch?: CloudLaunch }

/** How long to wait before asking again whether a launch that got no answer started. */
export const LAUNCH_RETRY_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * One confirmed launch and its retries. The idempotency key is made when the
 * person confirms and belongs to exactly what they confirmed (organization,
 * name, quote, setup): every retry of it, by this code after a timeout or by
 * the person tapping Launch again, sends the same key, so the server answers
 * with the first launch instead of starting a second. A different quote or
 * name is a different launch and gets its own key.
 *
 * The server keeps a key only for a launch it accepted, so a refused launch
 * can be confirmed again under the same key once what refused it is fixed.
 */
export class LaunchAttempt {
  private key: string | null = null;
  private confirmed = "";

  constructor(
    private readonly api: Pick<CloudApi, "createWorkspace">,
    private readonly makeKey: () => string,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Launch what was confirmed. `onUnanswered` is told when no answer came and
   * the same request is being asked again. Throws the server's refusal; when
   * every try went unanswered, the last such error, with the key kept for the
   * next call.
   */
  async launch(orgId: string, input: LaunchInput, onUnanswered?: () => void): Promise<CloudLifecycle> {
    // The first task is part of what was confirmed: the same key never carries a different one.
    const confirmed = JSON.stringify([orgId, input.name, input.quoteId, input.setup ?? null, input.launch ?? null]);
    if (this.key === null || confirmed !== this.confirmed) {
      this.key = this.makeKey();
      this.confirmed = confirmed;
    }
    const key = this.key;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const answer = await this.api.createWorkspace(orgId, { name: input.name, quoteId: input.quoteId, confirmProviderSpend: true, ...(input.setup ? { setup: input.setup } : {}), ...(input.launch ? { launch: input.launch } : {}) }, key);
        this.key = null;
        return answer;
      } catch (error) {
        const delay = LAUNCH_RETRY_MS[attempt];
        if (!unanswered(error) || delay === undefined) throw error;
        onUnanswered?.();
        await this.wait(delay);
      }
    }
  }
}

// ── Progress ──

const STAGE_ORDER = ["queued", "preflight", "creating-machine", "bootstrapping", "connecting-relay", "ready"] as const;
/** A launch's stages in order, in the console's words. */
export const LAUNCH_STAGES: readonly string[] = ["Queued", "Checking the provider", "Creating the machine", "Installing the runtime", "Connecting to the relay", "Ready"];

/** What the runtime reports while it installs: shown under the stage it belongs to. */
export const RUNTIME_EVENTS: Readonly<Record<string, string>> = {
  "credentials-installing": "Installing credentials",
  "credentials-ready": "Credentials ready",
  "repository-cloning": "Cloning the repository",
  "repository-ready": "Repository ready",
  "repository-clone-failed": "Repository clone failed",
};

/** Whether an operation is still under way. */
export const operationActive = (operation: Pick<CloudOperation, "state"> | { state: string } | null | undefined): boolean =>
  !!operation && (operation.state === "queued" || operation.state === "running" || operation.state === "cancel-requested");

/** A launch is a `create` operation with no action; the same operation type carries stop, start and delete. */
export const isLaunch = (operation: { action?: string | null } | null | undefined): boolean => !!operation && !operation.action;

const CAUSES: Record<string, string> = {
  cloud_provider_invalid_response: "The provider returned an unexpected response.",
  cloud_provider_unavailable: "The provider could not be reached. It may be down or blocking requests.",
  machine0_unavailable: "The provider could not be reached. It may be down or blocking requests.",
  provider_rate_limited: "The provider rate-limited TerminalX.",
  cloud_provider_rate_limited: "The provider rate-limited TerminalX.",
  cloud_provider_credential_invalid: "The provider rejected the API key.",
  cloud_provider_billing_required: "The provider account needs a billing fix before it will act.",
  relay_attestation_pending: "The workspace did not connect to the relay in time.",
  bootstrap_failed: "Installing or starting the runtime on the machine failed.",
  cloud_workspace_runtime_bootstrap_failed: "Installing or starting the runtime on the machine failed.",
  cloud_workspace_runtime_unsupported: "This workspace installed a TerminalX runtime that this server no longer supports, and the provider cannot update it in place, so it was not started.",
  cloud_workspace_runtime_not_ready: "The server had no compatible TerminalX runtime to install.",
  cloud_provider_state_conflict: "The provider reported a conflicting machine state.",
  cloud_provider_permission_denied: "The provider refused this action, but the API key is still valid.",
  cloud_provider_not_found: "The provider could not find this machine. It may have been removed outside TerminalX.",
  cloud_workspace_provisioning_timeout: "The workspace’s machine took too long to start.",
  provisioning_deadline_exceeded: "The workspace’s machine took too long to start.",
};
const CAUSE_UNKNOWN = "Something failed on the provider side.";

/** Why a failed operation failed, in one sentence. */
export function failureCause(operation: Pick<CloudOperation, "errorCode" | "detailCode">): string {
  return (operation.errorCode ? CAUSES[operation.errorCode] : undefined) ?? (operation.detailCode ? CAUSES[operation.detailCode] : undefined) ?? CAUSE_UNKNOWN;
}

export type LaunchRecovery = "fix-key" | "retry-setup" | "delete" | "ask-admin";

/**
 * What can be done about a failed launch, as the console decides it (its
 * `operationRecoveryFor`, which mirrors the server's gate): a rejected key is
 * fixed first; a launch whose provider kept the machine can be set up again
 * on it; anything else is deleted and launched anew. Someone who does not
 * manage the workspace can do none of these.
 */
export function launchRecovery(workspace: Pick<CloudWorkspace, "state" | "provider" | "you">, operation: Pick<CloudOperation, "errorCode" | "detailCode">): LaunchRecovery {
  if (workspace.you?.role !== "manager") return "ask-admin";
  if (operation.errorCode === "cloud_workspace_runtime_unsupported") return "delete";
  if (operation.errorCode === "cloud_provider_credential_invalid") return "fix-key";
  const tookTooLong = [operation.errorCode, operation.detailCode].some((code) => code === "cloud_workspace_provisioning_timeout" || code === "provisioning_deadline_exceeded");
  if (workspace.state === "attention-required" && workspace.provider !== "machine0" && !tookTooLong) return "retry-setup";
  return "delete";
}

export interface LaunchProgress {
  phase: "launching" | "canceling" | "canceled" | "failed" | "running";
  /** Where the operation is among `LAUNCH_STAGES`. */
  stage: number;
  status: "running" | "failed" | "finished";
  /** Under the current stage: the latest event, or why it stopped. */
  detail?: string;
  /** Whether the server would still take a cancel. */
  cancelable: boolean;
}

/**
 * A launch as the progress page draws it. `lastStage` is the stage it was
 * last seen at: a cancel moves the operation to its cleanup, which is not
 * one of the launch's own stages, and the page stays where the launch stopped.
 */
export function launchProgress(lifecycle: Pick<CloudLifecycle, "operation"> & { workspace: Pick<CloudWorkspace, "state"> }, lastStage = 0): LaunchProgress {
  const { operation, workspace } = lifecycle;
  const at = STAGE_ORDER.indexOf(operation.stage as (typeof STAGE_ORDER)[number]);
  const stage = at >= 0 ? at : lastStage;
  if (operation.state === "succeeded") return { phase: "running", stage: STAGE_ORDER.length - 1, status: "finished", cancelable: false };
  if (operation.state === "canceled") return { phase: "canceled", stage, status: "failed", detail: "Canceled", cancelable: false };
  if (operation.state === "failed") return { phase: "failed", stage, status: "failed", detail: failureCause(operation), cancelable: false };
  if (operation.state === "cancel-requested") return { phase: "canceling", stage, status: "running", detail: "Cleaning up", cancelable: false };
  // An operation this app cannot place is shown as under way, where it was last seen.
  const latest = operation.events?.length ? operation.events.reduce((newest, event) => (event.occurredAt >= newest.occurredAt ? event : newest)) : null;
  const detail = STAGE_ORDER[stage] === "bootstrapping" && latest ? RUNTIME_EVENTS[latest.code] : undefined;
  return { phase: "launching", stage, status: "running", ...(detail ? { detail } : {}), cancelable: operation.cancelable && workspace.state !== "ready" };
}

// ── Stop and delete ──

/** Who may stop, start and delete a workspace: its managers, as the server has it. */
export const mayManage = (workspace: Pick<CloudWorkspace, "you"> | null | undefined): boolean => workspace?.you?.role === "manager";

/** What the list says a workspace is doing about stopping. */
export function stopState(workspace: Pick<CloudWorkspace, "state"> | null | undefined, operation: { action?: string | null; state: string } | null | undefined): "stopping" | "failed" | null {
  if (!workspace) return null;
  if (workspace.state === "suspending" || (operation?.action === "suspend" && operationActive(operation) && workspace.state !== "suspended")) return "stopping";
  if (workspace.state === "attention-required" && operation?.action === "suspend" && operation.state === "failed") return "failed";
  return null;
}

/** The Stop alert's words: what stopping does, then the provider's own billing line, and nothing more about cost. */
export function stopQuestion(provider: Pick<CloudProvider, "displayName" | "descriptor"> | null, working: boolean): { title: string; message: string } {
  const billing = provider?.descriptor.billing.trim().replace(/[.\s]+$/, "");
  const line = provider && billing ? ` ${providerLabel(provider)}: ${lowerFirst(billing)}.` : "";
  return working
    ? { title: "Stop while an agent is working?", message: `An agent is in the middle of a turn. Stopping interrupts it; what it has not saved may be lost.${line}` }
    : { title: "Stop this workspace?", message: `Its agents stop until it is started again.${line}` };
}

/** The delete page's four facts, the console's word for word, with the provider's name from the server. */
export function deleteFacts(provider: string): { label: string; value: string }[] {
  return [
    { label: "Compute", value: "The machine is removed." },
    { label: "Data", value: `Its disk, snapshots and saved conversations are removed once ${provider} confirms.` },
    { label: "Charges", value: `Stop once ${provider} confirms the removal.` },
    { label: "Undo", value: "Not possible." },
  ];
}
export const DELETE_KEEP_WORK = "Push or copy out any work you want to keep before deleting.";
export const DELETE_ACKNOWLEDGE = "I understand this cannot be undone: the machine, its disk and snapshots, and the saved conversations are removed.";

/** Whether a request's outcome is not known: it may have reached the server, whose answer never came. */
export const outcomeUnknown = (error: unknown): boolean => unanswered(error);

/** Why a delete did not go through. Only a refusal the server gave says nothing was deleted; with no answer, that is not known. */
export function deleteRefusal(error: unknown): string {
  if (outcomeUnknown(error)) return "No answer came back, so the delete may or may not have started. Check the workspace in the Cloud tab before trying again.";
  if (error instanceof CloudApiError && error.refusal === "unreachable") return "The service could not be reached. Nothing was deleted. Try again in a moment.";
  return launchRefusal(error).text;
}

const CLEANUP_KINDS: Record<string, string> = {
  "runtime-credentials": "Runtime credentials",
  "client-attachments": "Phones and desktops",
  "provider-compute": "Machine",
  "provider-storage": "Disk and snapshots",
  "workspace-content": "Saved conversations",
};

/** A delete's cleanup report in plain words, so what may still cost money is not hidden. */
export interface CleanupFact { label: string; value: string; tone: "success" | "warning" | "danger" }
export function cleanupFacts(cleanup: NonNullable<CloudOperation["cleanup"]>): CleanupFact[] {
  const facts: CleanupFact[] = [];
  for (const item of cleanup.items) {
    const label = CLEANUP_KINDS[item.kind];
    // A kind this app does not know is left out rather than guessed at.
    if (!label) continue;
    if (item.state === "removed") facts.push({ label, value: item.kind === "client-attachments" ? "Disconnected" : "Removed", tone: "success" });
    else if (item.state === "pending") facts.push({ label, value: "Pending", tone: "warning" });
    else if (item.state === "retained-by-provider") facts.push({ label, value: "Kept by the provider", tone: "warning" });
    else facts.push({ label, value: "Not confirmed", tone: "danger" });
  }
  return facts;
}

/** Why a delete that started did not finish, as the console says it. */
export function deleteFailure(operation: Pick<CloudOperation, "errorCode" | "detailCode" | "providerErrorCode">, provider: string): string {
  if (operation.detailCode === "box_deleted_sandbox_present") return `${provider} accepted the deletion but still reports the machine. Contact ${provider} support.`;
  if (operation.errorCode === "cloud_provider_permission_denied") {
    return `${provider} refused to delete this machine (${operation.providerErrorCode ?? "permission denied"}). Check it in your ${provider} dashboard; if it is still there, delete it there, then press Delete again to clear it here.`;
  }
  return failureCause(operation);
}
