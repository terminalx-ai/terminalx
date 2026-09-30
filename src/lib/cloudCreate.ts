import type {
  CloudProviderSummary,
  CloudWorkspaceClientError,
  CloudWorkspaceCreateInput,
  CloudWorkspaceLaunchInput,
  CloudWorkspaceListItem,
  CloudWorkspacePreflight,
  CloudWorkspaceProviderId,
  CloudWorkspaceQuote,
  CloudWorkspaceQuoteInput,
  CloudWorkspaceRepositoryInput,
  CloudWorkspaceSetup,
  CloudWorkspaceSnapshot,
} from "@/lib/api";

/**
 * Creating a cloud workspace from repositories and a first prompt (PRO-21,
 * terminalx-saas contract §19): the form's checks, the create sequence, and
 * the startup phases the page shows while it runs.
 */

export const MAX_REPOSITORIES = 5;
export const MAX_PROMPT_BYTES = 32 * 1024;
const NAME_MAX = 80;

export interface RepositoryChoice {
  cloneUrl: string;
  fullName: string;
  /** The base branch; empty for the repository's default branch. */
  ref: string;
}

export interface CreateForm {
  name: string;
  provider: CloudWorkspaceProviderId | null;
  /** The primary repository first, then additional ones. */
  repositories: RepositoryChoice[];
  prompt: string;
  agent: string;
  model: string;
  effort: string;
  mode: string;
  accessMode: "private" | "organization";
}

export type FormErrors = Partial<Record<"name" | "provider" | "repositories" | "prompt" | "agent" | `ref:${number}`, string>>;

/** `git check-ref-format --branch`, for the names a person types. */
export function validBranch(name: string): boolean {
  if (!name || name.length > 200 || name === "@") return false;
  if (/^[-/.]/.test(name) || /[/.]$/.test(name) || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Everything the create checks on this machine, before anything is quoted. */
export function validateForm(form: CreateForm): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "Name the workspace.";
  else if ([...name].length > NAME_MAX) errors.name = `At most ${NAME_MAX} characters.`;
  if (!form.provider) errors.provider = "Connect a compute provider in Settings first.";
  if (form.repositories.length > MAX_REPOSITORIES) errors.repositories = `At most ${MAX_REPOSITORIES} repositories.`;
  const seen = new Set<string>();
  form.repositories.forEach((repository, index) => {
    const key = repository.cloneUrl.toLowerCase().replace(/\.git$/, "");
    if (seen.has(key)) errors.repositories = `${repository.fullName} is listed twice.`;
    seen.add(key);
    const ref = repository.ref.trim();
    if (ref && !validBranch(ref)) errors[`ref:${index}`] = "Not a valid branch name.";
  });
  if (new TextEncoder().encode(form.prompt).length > MAX_PROMPT_BYTES) errors.prompt = "The prompt is longer than 32 KB.";
  if (!/^[a-z0-9-]{1,32}$/.test(form.agent)) errors.agent = "Choose an agent.";
  return errors;
}

export function repositoriesInput(form: CreateForm): CloudWorkspaceRepositoryInput[] {
  return form.repositories.map((repository) => ({ cloneUrl: repository.cloneUrl, ref: repository.ref.trim() || null }));
}

export function launchInput(form: CreateForm): CloudWorkspaceLaunchInput {
  return {
    agent: form.agent,
    model: form.model || null,
    effort: form.effort || null,
    mode: form.mode || null,
    prompt: form.prompt.trim() ? form.prompt : null,
  };
}

/** What the API calls look like to the flow; the page passes `api`. */
export interface CreateApi {
  cloudWorkspacePreflight: (repositories: CloudWorkspaceRepositoryInput[]) => Promise<CloudWorkspacePreflight>;
  cloudWorkspaceSetup: (provider: CloudWorkspaceProviderId) => Promise<CloudWorkspaceSetup>;
  cloudWorkspaceQuote: (input: CloudWorkspaceQuoteInput) => Promise<CloudWorkspaceQuote>;
  cloudWorkspaceCreate: (input: CloudWorkspaceCreateInput) => Promise<CloudWorkspaceSnapshot>;
}

/**
 * One create attempt. The idempotency key and the exact request are kept
 * until the server has answered, so a retry after a lost response resends
 * the same bytes and gets the same workspace (and its single launch intent)
 * back instead of a second one.
 */
export interface PendingCreate {
  idempotencyKey: string;
  request: CloudWorkspaceCreateInput;
  createdAt: number;
}

export type CreateStep = "checking" | "quoting" | "creating";

export class CreateRefused extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string | null = null,
  ) {
    super(code);
  }
}

/**
 * Check, quote and create; or, with `pending`, resend that exact create.
 * `onPending` is told the request before it is sent so it can be kept.
 */
export async function createWorkspace(
  api: CreateApi,
  form: CreateForm,
  options: {
    pending?: PendingCreate | null;
    onStep?: (step: CreateStep) => void;
    onPending?: (pending: PendingCreate | null) => void;
    /** Told the workspace and the exact request it came from (the catalog's `createMemory`). */
    onCreated?: (snapshot: CloudWorkspaceSnapshot, request: CloudWorkspaceCreateInput) => void;
    newKey?: () => string;
    now?: () => number;
  } = {},
): Promise<CloudWorkspaceSnapshot> {
  const { onStep, onPending } = options;
  let pending = options.pending ?? null;
  if (!pending) {
    const errors = validateForm(form);
    const first = Object.values(errors)[0];
    if (first) throw new CreateRefused("cloud_workspace_form_invalid", first);
    const repositories = repositoriesInput(form);
    if (repositories.length) {
      onStep?.("checking");
      const preflight = await api.cloudWorkspacePreflight(repositories);
      const failed = preflight.checks.find((check) => check.status === "failed" && check.kind !== "agent-credential");
      if (failed) throw new CreateRefused(failed.errorCode ?? "cloud_workspace_request_invalid", failed.cloneUrl);
    }
    onStep?.("quoting");
    const setup = await api.cloudWorkspaceSetup(form.provider!);
    const quote = await api.cloudWorkspaceQuote({ provider: form.provider!, ...setup.defaults });
    pending = {
      idempotencyKey: options.newKey?.() ?? crypto.randomUUID(),
      createdAt: options.now?.() ?? Date.now(),
      request: {
        name: form.name.trim(),
        quoteId: quote.id,
        accessMode: form.accessMode,
        confirmProviderSpend: true,
        idempotencyKey: "",
        repositories,
        launch: launchInput(form),
      },
    };
    pending.request.idempotencyKey = pending.idempotencyKey;
  }
  onPending?.(pending);
  onStep?.("creating");
  try {
    const snapshot = await api.cloudWorkspaceCreate(pending.request);
    onPending?.(null);
    options.onCreated?.(snapshot, pending.request);
    return snapshot;
  } catch (error) {
    // Only an outcome the server may still have applied keeps the key; a
    // definite refusal starts over with a fresh quote next time.
    if (!isClientError(error) || !error.retryWithSameIdempotencyKey) onPending?.(null);
    throw error;
  }
}

export function isClientError(error: unknown): error is CloudWorkspaceClientError {
  return Boolean(error) && typeof error === "object" && "code" in (error as object) && "retryWithSameIdempotencyKey" in (error as object);
}

const PENDING_KEY = "terminalx.cloudCreate.pending";

/** The create in flight, kept across a reload so its retry reuses the key. */
export function loadPending(organizationId: string): PendingCreate | null {
  try {
    const key = `${PENDING_KEY}.${organizationId}`;
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as PendingCreate | null;
    // The server replays a create by its key for as long as the launch intent
    // lives (a day); an older one is not worth resending, and its prompt is
    // not kept on this machine any longer than the server keeps it.
    if (stored && Date.now() - stored.createdAt < 24 * 60 * 60 * 1000) return stored;
    localStorage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

export function savePending(organizationId: string, pending: PendingCreate | null): void {
  try {
    if (pending) localStorage.setItem(`${PENDING_KEY}.${organizationId}`, JSON.stringify(pending));
    else localStorage.removeItem(`${PENDING_KEY}.${organizationId}`);
  } catch {
    /* private window: the retry works for this session only */
  }
}

/** A provider the create can use now. */
export function usableProviders(providers: CloudProviderSummary[]): CloudProviderSummary[] {
  return providers.filter((provider) => provider.availability === "available");
}

// ---- Startup phases --------------------------------------------------------

export const PHASES = [
  { id: "allocating", label: "Allocating" },
  { id: "booting", label: "Booting" },
  { id: "authenticating-runtime", label: "Authenticating runtime" },
  { id: "syncing-repository", label: "Syncing repository" },
  { id: "starting-agent", label: "Starting agent" },
  { id: "running", label: "Running" },
] as const;

export type PhaseId = (typeof PHASES)[number]["id"] | "failed" | "canceled";

/**
 * Where a workspace is in its startup. The server derives it (§19.2) when
 * the workspace has a launch intent; a workspace without one (or an older
 * server) is placed from its create operation.
 */
export function phaseOf(item: CloudWorkspaceListItem | CloudWorkspaceSnapshot): PhaseId {
  const workspace = item.workspace;
  const operation = "operation" in item ? item.operation : item.latestOperation;
  const phase = workspace.launch?.phase;
  if (phase && (PHASES.some((p) => p.id === phase) || phase === "failed" || phase === "canceled")) return phase as PhaseId;
  if (operation?.state === "canceled") return "canceled";
  if (operation?.state === "failed" || workspace.state === "attention-required") return "failed";
  if (workspace.state === "ready") return workspace.launch ? "authenticating-runtime" : "running";
  switch (operation?.stage) {
    case "bootstrapping":
      return "booting";
    case "connecting-relay":
    case "ready":
      return "authenticating-runtime";
    default:
      return "allocating";
  }
}

export function settled(phase: PhaseId): boolean {
  return phase === "running" || phase === "failed" || phase === "canceled";
}

/**
 * How long a Ready workspace may leave its launch intent unclaimed before the
 * page says so. A runtime claims it within seconds of connecting; one that
 * cannot run launch intents never does, and the server would otherwise keep
 * the intent pending until it expires a day later.
 */
export const RUNTIME_PICKUP_MS = 2 * 60 * 1000;

/**
 * When a Ready workspace's runtime has not picked up its launch intent after
 * `RUNTIME_PICKUP_MS`, the time it has been waiting since; otherwise null.
 * Measured from when the launch reached the runtime phase, else from when
 * the create operation succeeded.
 */
export function runtimeNotPickedUp(item: CloudWorkspaceListItem | CloudWorkspaceSnapshot, now: number): number | null {
  const launch = item.workspace.launch;
  if (!launch || item.workspace.state !== "ready" || launch.state !== "pending") return null;
  if (phaseOf(item) !== "authenticating-runtime") return null;
  const operation = "operation" in item ? item.operation : item.latestOperation;
  const since =
    launch.timings?.authenticatingAt ?? (operation?.state === "succeeded" ? operation.updatedAt : null) ?? launch.timings?.requestedAt ?? null;
  if (since === null) return null;
  const waited = now - since;
  return waited >= RUNTIME_PICKUP_MS ? waited : null;
}

export const RUNTIME_NOT_PICKED_UP =
  "The workspace is ready, but its runtime has not picked up the first task. It may not support starting agents from a first prompt. Open the session to start the agent yourself.";

/** Milliseconds from the request to running, when both are known. */
export function launchLatency(item: CloudWorkspaceListItem | CloudWorkspaceSnapshot): number | null {
  const timings = item.workspace.launch?.timings;
  if (!timings?.requestedAt || !timings.runningAt) return null;
  return timings.runningAt - timings.requestedAt;
}

// ---- Words -----------------------------------------------------------------

const MESSAGES: Record<string, string> = {
  cloud_workspace_quota_exceeded: "Your organization is at its cloud workspace limit. Suspend or delete a workspace, or ask an admin to raise the limit.",
  cloud_workspace_concurrency_exceeded: "Your organization is running as many cloud workspaces as its limit allows. Stop one to start another.",
  cloud_workspace_policy_denied: "Your organization's compute policy does not allow this provider, location or machine size.",
  cloud_provisioning_paused: "An admin has paused new cloud workspaces for this organization.",
  organization_admin_required: "Only organization owners and admins can create cloud workspaces.",
  cloud_provider_connection_required: "Connect a compute provider in Settings first.",
  cloud_provider_connection_attention_required: "The compute provider connection needs attention in Settings.",
  cloud_provider_billing_required: "The compute provider account needs billing set up.",
  cloud_provider_permission_denied: "The provider key is valid but lacks a permission TerminalX needs. An admin can check its scope in the provider console.",
  cloud_workspace_repository_not_accessible: "The GitHub App cannot read that repository. Choose it in Settings → GitHub.",
  cloud_workspace_repository_ref_not_found: "That branch does not exist in the repository.",
  cloud_workspace_repository_credential_required: "Connect GitHub in Settings to use private repositories.",
  cloud_workspace_repository_verification_unavailable: "GitHub could not be reached to check the repositories. Try again.",
  cloud_workspace_repository_invalid: "That repository cannot be used.",
  cloud_environment_repository_not_in_image: "That repository is not in the organization's environment image. Add it and rebuild the environment first.",
  cloud_environment_changed: "The environment was republished while you were creating. Try again.",
  github_repository_not_granted: "The GitHub App has not been granted that repository.",
  github_app_not_configured: "GitHub is not set up for this organization.",
  cloud_workspace_quote_expired: "The price quote expired. Try again.",
  cloud_workspace_rate_limited: "Too many requests. Wait a minute and try again.",
  idempotency_key_reused: "This create was already sent with different settings.",
  cloud_workspace_create_outcome_unknown: "The server may have created the workspace. Retry to find out; it will not create a second one.",
  account_context_changed: "You switched account or organization while creating. Switch back to retry.",
  cloud_workspace_name_invalid: "Name the workspace (at most 80 characters).",
  cloud_workspace_repository_ref_invalid: "A base branch is not a valid branch name.",
  cloud_workspace_repository_duplicate: "A repository is listed twice.",
  cloud_workspace_repositories_too_many: `At most ${MAX_REPOSITORIES} repositories.`,
  cloud_workspace_prompt_too_long: "The prompt is longer than 32 KB.",
  cloud_workspace_launch_invalid: "Choose a valid agent, model and effort.",
};

export function createErrorMessage(code: string, detail: string | null = null): string {
  if (code === "cloud_workspace_form_invalid") return detail ?? "Check the form.";
  const message = MESSAGES[code] ?? `The workspace could not be created (${code}).`;
  return detail && code.startsWith("cloud_workspace_repository") ? `${message} (${detail.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")})` : message;
}

const FAILURES: Record<string, string> = {
  "agent-unavailable": "The agent is not installed in the workspace image.",
  "repository-sync-failed": "A repository could not be switched to its branch.",
  "branch-create-failed": "The work branch could not be created.",
  "agent-start-failed": "The agent could not be started.",
  "runtime-interrupted": "The workspace restarted while starting the agent. The prompt may not have been sent.",
  "runtime-storage-replaced": "The workspace lost its state while starting the agent. The prompt may not have been sent.",
  "payload-invalid": "The launch settings were not accepted by the workspace.",
  "launch-intent-unavailable": "The first prompt could not be read back on the server, so it was not sent.",
  "runtime-unsupported": "This workspace's runtime cannot start agents from a first prompt, so it was not sent. Open the session to start the agent yourself.",
};

/** Why a launch failed, from the operation or the launch category. */
export function failureMessage(item: CloudWorkspaceListItem | CloudWorkspaceSnapshot): string {
  const category = item.workspace.launch?.category;
  if (category) return FAILURES[category] ?? `The agent did not start (${category}).`;
  if (item.workspace.launch?.state === "expired") return "The workspace took too long to start, and its first prompt expired.";
  const operation = "operation" in item ? item.operation : item.latestOperation;
  const code = operation?.errorCode;
  return code ? `Provisioning failed (${code}).` : "Provisioning failed.";
}
