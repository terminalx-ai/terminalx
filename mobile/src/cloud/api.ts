import { z } from "zod";
import { ORGANIZATION_DELETION_REFUSALS, organizationDeletionBlockers } from "@terminalx/portable/organizationDeletion";
import { isPhoneMode, type PhoneMode } from "./agent-settings";
import type { CheckpointEnvelope, CommandEnvelope } from "./crypto";

/**
 * The account service's cloud workspace API as the phone uses it
 * (`/v1/mobile/orgs/:orgId/…`, terminalx-saas contract §2, §11, §12, §20,
 * §21). Every call carries the signed-in account's access token; the server
 * re-reads membership, role and the workspace's visibility on each one, and a
 * phone is always a `participate` attachment. The phone never receives an
 * organization's compute credentials.
 *
 * Nothing here resumes a stopped workspace on its own. The list and the
 * checkpoints only read. `open` is refused by the server for a stopped
 * workspace, and this client never asks it to reconcile the provider. A
 * workspace is started only when the person asks: by a queued command
 * (`enqueue`), which the server reports back as `wake`, or by `resume`, which
 * only its managers may call (§10). With `wake: false` the server starts
 * nothing and refuses a stopped workspace instead (`WORKSPACE_STOPPED`, §11.2.1).
 */

/** The server's refusal of a `wake: false` command for a workspace that is not running. Nothing was stored. */
export const WORKSPACE_STOPPED = "cloud_workspace_stopped";
/** The capability flag of a server that knows `wake: false`; an older one rejects the key. */
const DO_NOT_WAKE_CAPABILITY = "cloud.workspaces.agent-command-wake.v1";
/**
 * The capability flag of a server whose organization delete route takes a
 * phone's token (terminalx-saas#279). Without it the route takes desktop
 * tokens only, so the phone does not offer deletion.
 */
export const ORGANIZATION_DELETE_CAPABILITY = "organizations.delete.mobile.v1";
/**
 * The capability flag of a server that says its organization create route
 * takes a phone's token (terminalx-saas `organizationCreation`, PRO-526).
 * Without it the phone does not offer creating one.
 */
export const ORGANIZATION_CREATE_CAPABILITY = "organizations.create.mobile.v1";
/** An organization's name as the server takes it, after trimming (`inputValidation.ORGANIZATION_NAME`). */
export const ORGANIZATION_NAME = { min: 2, max: 60 } as const;

// Ask for every registered provider. The names are for servers that predate
// the described-provider contract (PRO-415).
export const SUPPORTED_PROVIDERS = "described,machine0,box,terminalx-cloud";

const CONTRACT_HEADERS = {
  "X-TerminalX-Cloud-Workspace-Contract": "providers-v1",
  "X-TerminalX-Cloud-Workspace-Providers": SUPPORTED_PROVIDERS,
  "X-TerminalX-Cloud-Workspace-Lifecycle": "archive-v1",
} as const;

/**
 * Why a request got no usable answer, beside its code: `timeout` (no answer in
 * time, so the server may still have acted on it), `network` (it never left
 * the phone or the connection failed), `unreadable` (an error answer that was
 * not the service's JSON).
 */
export type CloudApiFailureReason = "timeout" | "network" | "unreadable";

export class CloudApiError extends Error {
  constructor(
    readonly code: string,
    /** The HTTP status; null when the request never got an answer (offline, timed out). */
    readonly status: number | null,
    readonly reason: CloudApiFailureReason | null = null,
    /** For `organization_delete_blocked`: what is still in the way, as known blocker codes only. */
    readonly blockers: string[] = [],
  ) {
    super(code);
    this.name = "CloudApiError";
  }

  /** The network or the service, not the workspace: what was shown stays, and the request may be tried again. */
  get unreachable(): boolean {
    return this.status === null || this.status >= 500 || this.status === 408 || this.status === 429;
  }

  /**
   * What went wrong, as one of the kinds a screen has words for. A code the
   * server added since this app was built is `unreachable` when its status
   * says the service could not answer, and `unknown` otherwise; the code
   * itself stays on the error.
   */
  get refusal(): CloudRefusal {
    if (this.status === null || this.reason !== null) return "unreachable";
    return REFUSALS[this.code] ?? (this.unreachable ? "unreachable" : "unknown");
  }
}

/**
 * The kinds of refusal the cloud setup screens tell apart (connecting
 * compute, agent logins, launching a workspace). Each code the account
 * service answers these routes with is one of them (`REFUSALS`).
 */
export type CloudRefusal =
  | "signed-out"
  | "admin-required"
  | "manager-required"
  | "not-found"
  | "provider-not-connected"
  | "provider-needs-attention"
  | "provider-key-invalid"
  | "provider-key-other-account"
  | "provider-permission-denied"
  | "provider-billing-required"
  | "provider-not-offered"
  | "provider-has-machines"
  | "provider-busy"
  | "provider-rate-limited"
  | "provider-unavailable"
  | "plan-required"
  | "limit-reached"
  | "provisioning-paused"
  | "policy-denied"
  | "quote-expired"
  | "idempotency-key-reused"
  | "workspace-busy"
  | "workspace-archived"
  | "operation-not-found"
  | "login-missing"
  | "login-invalid"
  | "login-in-use"
  | "login-check-unavailable"
  | "repository-login-required"
  | "repository-not-accessible"
  | "repository-check-unavailable"
  | "device-login-unavailable"
  | "device-login-not-found"
  | "rate-limited"
  | "invalid-request"
  | "invalid-response"
  | "unreachable"
  | "unknown";

/** The account service's codes for these routes (terminalx-saas `CloudWorkspaceErrorCode`, the auth middleware's `unauthorized`) and this client's own. */
const REFUSALS: Readonly<Record<string, CloudRefusal>> = {
  account_signed_out: "signed-out",
  unauthorized: "signed-out",
  invalid_access_token: "signed-out",
  organization_admin_required: "admin-required",
  active_organization_required: "admin-required",
  cloud_workspace_manager_required: "manager-required",
  cloud_workspace_not_found: "not-found",
  cloud_provider_not_found: "not-found",
  cloud_provider_connection_required: "provider-not-connected",
  machine0_connection_required: "provider-not-connected",
  cloud_provider_connection_attention_required: "provider-needs-attention",
  cloud_provider_credential_invalid: "provider-key-invalid",
  cloud_provider_account_mismatch: "provider-key-other-account",
  cloud_provider_permission_denied: "provider-permission-denied",
  cloud_provider_billing_required: "provider-billing-required",
  cloud_provider_disabled: "provider-not-offered",
  cloud_provider_creation_disabled: "provider-not-offered",
  cloud_workspace_provider_unsupported: "provider-not-offered",
  cloud_provider_disposition_required: "provider-has-machines",
  cloud_provider_operation_in_progress: "provider-busy",
  cloud_provider_rate_limited: "provider-rate-limited",
  cloud_provider_unavailable: "provider-unavailable",
  cloud_provider_invalid_response: "provider-unavailable",
  machine0_unavailable: "provider-unavailable",
  machine0_invalid_response: "provider-unavailable",
  cloud_workspace_runtime_not_ready: "provider-unavailable",
  terminalx_pro_required: "plan-required",
  cloud_workspace_quota_exceeded: "limit-reached",
  cloud_workspace_concurrency_exceeded: "limit-reached",
  cloud_workspace_member_concurrency_exceeded: "limit-reached",
  cloud_workspace_create_budget_exceeded: "limit-reached",
  cloud_provisioning_paused: "provisioning-paused",
  cloud_workspace_policy_denied: "policy-denied",
  cloud_workspace_quote_expired: "quote-expired",
  cloud_environment_changed: "quote-expired",
  idempotency_key_reused: "idempotency-key-reused",
  organization_idempotency_key_reused: "idempotency-key-reused",
  organization_idempotency_key_invalid: "invalid-request",
  organization_name_invalid: "invalid-request",
  cloud_workspace_operation_in_progress: "workspace-busy",
  cloud_workspace_active_work: "workspace-busy",
  cloud_workspace_archived: "workspace-archived",
  cloud_workspace_operation_not_found: "operation-not-found",
  cloud_workspace_credential_required: "login-missing",
  cloud_workspace_agent_credential_required: "login-missing",
  cloud_workspace_credential_invalid: "login-invalid",
  cloud_agent_credential_reauth_required: "login-invalid",
  cloud_workspace_credential_in_use: "login-in-use",
  cloud_workspace_credential_verification_unavailable: "login-check-unavailable",
  cloud_workspace_repository_credential_required: "repository-login-required",
  cloud_workspace_repository_not_accessible: "repository-not-accessible",
  cloud_workspace_repository_ref_not_found: "repository-not-accessible",
  cloud_workspace_github_installation_unavailable: "repository-not-accessible",
  cloud_workspace_repository_verification_unavailable: "repository-check-unavailable",
  cloud_workspace_device_auth_unavailable: "device-login-unavailable",
  cloud_workspace_device_auth_not_found: "device-login-not-found",
  cloud_workspace_rate_limited: "rate-limited",
  cloud_workspace_request_invalid: "invalid-request",
  cloud_workspace_invalid_response: "invalid-response",
  cloud_workspace_unavailable: "unreachable",
};

const ROLE = z.enum(["manager", "driver", "viewer", "none"]);
const youSchema = z.object({ role: ROLE, canApprove: z.boolean(), canManageShares: z.boolean().optional() }).passthrough();

const workspaceSchema = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    name: z.string(),
    provider: z.string(),
    providerDescriptor: z.object({ label: z.string().trim().min(1) }).nullish().catch(undefined),
    state: z.string(),
    accessMode: z.string().optional(),
    authority: z.string().nullish(),
    you: youSchema.nullish(),
    sharedWith: z.number().int().nonnegative().nullish(),
    createdBy: z.string().nullish(),
    lastActivityAt: z.number().nullish(),
    archivedAt: z.number().nullish(),
    deletedAt: z.number().nullish(),
    runtimeActivity: z
      .object({ online: z.boolean().optional(), activeTurns: z.number().optional(), pendingApprovals: z.number().optional(), reportedAt: z.number().optional(), stale: z.boolean().optional() })
      .passthrough()
      .nullish(),
    repositories: z.array(z.object({ identity: z.string().nullish(), fullName: z.string().nullish(), primary: z.boolean().optional() }).passthrough()).nullish(),
    // A launch's first task as the server reports it (contract 19.2): where it is, and once running the tab holding it.
    launch: z
      .object({
        workBranch: z.string().nullish(),
        sessionId: z.string().nullish(),
        tabId: z.string().nullish(),
        phase: z.string().nullish(),
        state: z.string().nullish(),
        agent: z.string().nullish(),
        model: z.string().nullish(),
        effort: z.string().nullish(),
        mode: z.string().nullish(),
        hasPrompt: z.boolean().nullish(),
        category: z.string().nullish(),
        timings: z
          .object({ requestedAt: z.number().nullish(), bootingAt: z.number().nullish(), authenticatingAt: z.number().nullish(), syncingAt: z.number().nullish(), startingAgentAt: z.number().nullish(), runningAt: z.number().nullish(), failedAt: z.number().nullish() })
          .partial()
          .nullish()
          .catch(undefined),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const operationSchema = z.object({ id: z.string(), state: z.string(), action: z.string().nullish(), errorCode: z.string().nullish() }).passthrough();
const snapshotSchema = z.object({ workspace: workspaceSchema, operation: operationSchema }).passthrough();
const listItemSchema = z.object({ workspace: workspaceSchema, latestOperation: operationSchema.nullish() }).passthrough();
const tombstoneSchema = z.object({ id: z.string(), orgId: z.string(), deletedAt: z.number(), expiresAt: z.number() });
const listSchema = z.object({ workspaces: z.array(listItemSchema), tombstones: z.array(tombstoneSchema).optional() }).passthrough();

export type CloudWorkspace = z.infer<typeof workspaceSchema>;
export type CloudWorkspaceItem = z.infer<typeof listItemSchema>;
export type CloudWorkspaceSnapshot = z.infer<typeof snapshotSchema>;
export type CloudTombstone = z.infer<typeof tombstoneSchema>;
export type CloudRole = z.infer<typeof ROLE>;

const organizationSchema = z.object({ orgId: z.string().min(1), name: z.string(), role: z.string(), isPersonal: z.boolean().optional() }).passthrough();
export type CloudOrganization = z.infer<typeof organizationSchema>;
/** The create route's answer (`desktopCreateOrganization`): the new organization and this person's role in it. */
const createdOrganizationSchema = z.object({ id: z.string().min(1), name: z.string(), role: z.string() });

const attachTicketSchema = z.object({ v: z.literal(1), token: z.string().min(1), expiresAt: z.number(), runtimeGeneration: z.number().int().nonnegative(), protocol: z.literal("terminalx-workspace-rpc/1") });
const attachmentSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    state: z.enum(["waiting-for-runtime", "ready"]),
    // A phone never holds runtime scope, whatever its owner's role.
    authority: z.literal("participate"),
    expiresAt: z.number(),
    pairingCode: z.string().min(1).optional(),
    attachTicket: attachTicketSchema.optional(),
  })
  .passthrough();
export type CloudAttachment = z.infer<typeof attachmentSchema>;
export type AttachTicket = z.infer<typeof attachTicketSchema>;

const commandSchema = z
  .object({
    clientCommandId: z.string(),
    tabId: z.string(),
    kind: z.string(),
    state: z.string(),
    actorId: z.string().nullish(),
    keyId: z.string(),
    outcomeCategory: z.string().optional(),
    resultIv: z.string().optional(),
    resultCiphertext: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough();
export type CloudCommand = z.infer<typeof commandSchema>;
/** What a queued command did to the workspace's compute (§11.2). */
export type WakeResult = string;

const checkpointMetaSchema = z.object({ tabId: z.string(), epoch: z.number().int(), version: z.number().int(), schemaVersion: z.number().int(), keyId: z.string(), sha256: z.string() }).passthrough();
const checkpointSchema = checkpointMetaSchema.extend({ iv: z.string(), ciphertext: z.string() });
export type CheckpointMeta = z.infer<typeof checkpointMetaSchema>;

const shareSchema = z.object({ userId: z.string(), email: z.string(), name: z.string().nullish(), role: z.enum(["viewer", "driver"]), canApprove: z.boolean(), createdBy: z.string(), createdAt: z.number(), updatedAt: z.number() });
const sharesSchema = z.object({ shares: z.array(shareSchema), you: z.object({ role: ROLE, canApprove: z.boolean(), canManageShares: z.boolean() }) });
export type CloudShare = z.infer<typeof shareSchema>;
export type CloudShares = z.infer<typeof sharesSchema>;

const memberSchema = z.object({ userId: z.string().min(1), email: z.string(), displayName: z.string().nullish(), role: z.string() }).passthrough();
export type CloudMember = z.infer<typeof memberSchema>;

// ── Cloud setup: compute providers, agent logins, launching a workspace ──
//
// The schemas written for these calls drop unknown keys: what the server
// did not promise about a provider, a connection, a login or an operation
// never reaches the app's state. The one exception is the workspace inside a
// lifecycle answer, which is the list's `workspaceSchema` and passes its keys
// through as the list does.

/** The disclosure a person accepts when connecting compute (terminalx-saas `cloudProviderConnection.DISCLOSURE_VERSION`). */
export const PROVIDER_DISCLOSURE_VERSION = "cloud-provider-connections-2026-08-13";
/** What the server takes as an `Idempotency-Key` (`IDEMPOTENCY_KEY_PATTERN`). */
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,128}$/;

/** The only kind of address a screen is ever handed to open. */
const HTTPS_URL = z.string().refine((value) => /^https:\/\/[^\s]+$/.test(value));
const millis = z.number();
const micros = z.number();

const credentialFieldSchema = z.object({
  name: z.string().min(1),
  // A kind this app does not know is treated as a secret: never shown, never kept.
  kind: z.enum(["secret", "text"]).catch("secret"),
  label: z.string(),
  // Anything but an https address is dropped, not shown: the field is still asked for.
  helpUrl: HTTPS_URL.optional().catch(undefined),
});
const providerDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1),
  icon: z.string(),
  order: z.number(),
  description: z.string(),
  billing: z.string(),
  billedByProvider: z.boolean(),
  listed: z.boolean(),
  credentialSource: z.enum(["organization", "platform"]),
  credentialFields: z.array(credentialFieldSchema),
  capabilities: z.object({ pauseResumeWithMemory: z.boolean(), stopStart: z.boolean(), snapshots: z.boolean(), exec: z.boolean(), computeRunsUntilStopped: z.boolean() }),
  offering: z.object({ locations: z.string(), sources: z.string(), machineClasses: z.string(), pricingSource: z.string(), suspendedBilling: z.string() }),
  allowedIdleSuspendMinutes: z.array(z.number()),
  allowedRetentionDays: z.array(z.number()),
});
const providerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  /** `available`, `not-connected`, `attention-required` or `disabled-for-create`. */
  availability: z.string(),
  canManage: z.boolean(),
  connection: z.object({ state: z.string(), connectedAt: millis, lastValidatedAt: millis.optional(), credentialFingerprint: z.string().optional() }).optional(),
  /** What becomes of a machine the provider releases (`archived` or `destroyed`); the descriptor does not say. */
  capabilities: z.object({ releaseDisposition: z.string() }).optional().catch(undefined),
  descriptor: providerDescriptorSchema,
});
export type CloudProvider = z.infer<typeof providerSchema>;
export type CloudProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
export type CloudProviderCredentialField = z.infer<typeof credentialFieldSchema>;

const providerResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  kind: z.string(),
  cleanupRequired: z.boolean(),
  currency: z.string(),
  activeHourlyMicros: micros.nullable(),
  suspendedMonthlyMicros: micros.nullable(),
  releaseDisposition: z.string().nullable(),
  operationState: z.string().nullable(),
  deleteAfter: millis.optional(),
});
const providerConnectionSchema = z.object({
  provider: z.string().min(1),
  state: z.enum(["not-connected", "connected", "attention-required"]),
  canManage: z.boolean(),
  credentialVersion: z.number().optional(),
  providerAccount: z.string().optional(),
  operationsBlocked: z.boolean().optional(),
  disconnectDisposition: z.string().optional(),
  disconnectRetention: z.string().optional(),
  retentionDeadline: millis.optional(),
  resources: z.array(providerResourceSchema).optional(),
  credentialFingerprint: z.string().optional(),
  connectedAt: millis.optional(),
  lastValidatedAt: millis.optional(),
});
export type CloudProviderConnection = z.infer<typeof providerConnectionSchema>;

const NETWORK_POLICY = z.enum(["relay-only", "provider-public-network"]);
const selectionSchema = z.object({ sourceId: z.string(), locationId: z.string(), machineClassId: z.string(), idleSuspendMinutes: z.number(), retentionDays: z.number(), networkPolicy: NETWORK_POLICY });
const providerSetupSchema = z.object({
  provider: z.string().min(1),
  credentialFingerprint: z.string(),
  currency: z.string(),
  pricing: z.string(),
  pricingObservedAt: millis,
  sources: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), description: z.string().optional() })),
  locations: z.array(z.object({ id: z.string(), label: z.string(), placement: z.string() })),
  machineClasses: z.array(z.object({ id: z.string(), label: z.string(), vcpu: z.number(), memoryMiB: z.number(), diskGiB: z.number(), activeHourlyMicros: micros.optional() })),
  defaults: selectionSchema,
  allowedIdleSuspendMinutes: z.array(z.number()),
  allowedRetentionDays: z.array(z.number()),
  maxIdleSuspendMinutes: z.number().nullish(),
});
export type CloudProviderSetup = z.infer<typeof providerSetupSchema>;

const quoteSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  expiresAt: millis,
  currency: z.string(),
  pricing: z.string(),
  pricingObservedAt: millis,
  activeHourlyMicros: micros,
  alwaysOnThirtyDayMicros: micros,
  estimatedSuspendedMonthlyMicros: micros.optional(),
  configuration: selectionSchema.extend({ sourceLabel: z.string(), locationLabel: z.string(), machineClassLabel: z.string(), vcpu: z.number(), memoryMiB: z.number(), diskGiB: z.number(), architecture: z.string() }),
});
export type CloudQuote = z.infer<typeof quoteSchema>;
/** What a quote is asked for: one choice of each thing the provider's setup offers. */
export type CloudQuoteInput = z.infer<typeof selectionSchema> & { provider: string };

const CHECK_STATUS = z.enum(["verified", "failed"]);
const preflightCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository"), cloneUrl: z.string().optional(), status: CHECK_STATUS, errorCode: z.string().optional(), retryable: z.boolean().optional() }),
  z.object({ kind: z.literal("credential"), provider: z.string(), credentialId: z.string(), status: CHECK_STATUS, errorCode: z.string().optional(), retryable: z.boolean().optional() }),
  z.object({ kind: z.literal("agent-credential"), agent: z.string().optional(), provider: z.string().optional(), status: CHECK_STATUS, errorCode: z.string().optional(), reason: z.string().optional(), retryable: z.boolean().optional() }),
]);
const preflightSchema = z.object({ version: z.literal(1), ready: z.boolean(), checks: z.array(preflightCheckSchema) });
export type CloudPreflight = z.infer<typeof preflightSchema>;
export type CloudPreflightCheck = z.infer<typeof preflightCheckSchema>;

/** The first task a launch carries (contract 19.1): the agent to start, how, and what it is told first. */
export interface CloudLaunch {
  v: 1;
  /** The runtime's name for the agent: `claude`, `codex`, `cursor`. */
  agent: string;
  /** Left out for the agent's own default. */
  model?: string;
  effort?: string;
  /** Always named, and never bypass: a launch that names no mode starts in bypass (`cloud_agents/launch.rs`). */
  mode: PhoneMode;
  /** Left out for none; otherwise 1 to 32 KB, as typed. */
  prompt?: string;
}

/** What the server takes as a first task's text: at most 32 KB, no NUL (`launchIntentConstants.maxPromptBytes`). */
export const MAX_LAUNCH_PROMPT_BYTES = 32 * 1024;

/** A first task as the server's parser takes it: exactly these keys, and a mode a phone may send. */
function launchBody(launch: CloudLaunch): CloudLaunch {
  const prompt = launch.prompt;
  if (launch.v !== 1 || !/^[a-z0-9-]{1,32}$/.test(launch.agent) || !isPhoneMode(launch.mode)
    || (launch.model !== undefined && !/^[\x21-\x7e]{1,100}$/.test(launch.model))
    || (launch.effort !== undefined && !/^[a-z]{1,16}$/.test(launch.effort))
    || (prompt !== undefined && (!prompt || prompt.includes("\u0000") || new TextEncoder().encode(prompt).length > MAX_LAUNCH_PROMPT_BYTES))) {
    throw new CloudApiError("cloud_workspace_request_invalid", 422);
  }
  return { v: 1, agent: launch.agent, ...(launch.model !== undefined ? { model: launch.model } : {}), ...(launch.effort !== undefined ? { effort: launch.effort } : {}), mode: launch.mode, ...(prompt !== undefined ? { prompt } : {}) };
}

/** What a new workspace starts with: the repositories to clone and the stored logins to install. */
export interface CloudFirstRunSetup {
  /** At most five, each a GitHub clone URL; none for an empty workspace. */
  repositories?: readonly { cloneUrl: string; ref?: string }[];
  /** Ids from `credentials()`, at most four. */
  credentialIds: readonly string[];
}

// An operation as the lifecycle routes answer it. Its raw provisioning `logs` are left out.
const lifecycleOperationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  type: z.string(),
  action: z.string().optional(),
  state: z.string(),
  stage: z.string().nullable(),
  cancelable: z.boolean(),
  createdAt: millis,
  updatedAt: millis,
  lastProviderContactAt: millis.optional(),
  nextAttemptAt: millis.optional(),
  retryReason: z.string().optional(),
  errorCode: z.string().optional(),
  providerErrorCode: z.string().optional(),
  detailCode: z.string().optional(),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
  progress: z.object({ phase: z.string(), retryAt: millis.optional() }).optional(),
  events: z.array(z.object({ code: z.string(), occurredAt: millis })).optional(),
  checkpoint: z.string().optional(),
  checkpointAt: millis.optional(),
  cleanup: z.object({ complete: z.boolean(), items: z.array(z.object({ kind: z.string(), state: z.string(), providerStage: z.string().optional(), expectedBy: millis.optional() })) }).optional(),
});
const lifecycleSchema = z.object({ workspace: workspaceSchema, operation: lifecycleOperationSchema });
export type CloudOperation = z.infer<typeof lifecycleOperationSchema>;
/** A workspace and the operation acting on it: the answer to create, suspend, delete, and to reading or cancelling an operation. */
export type CloudLifecycle = z.infer<typeof lifecycleSchema>;

/** The agents and services an organization stores a login for. */
export type CloudCredentialProvider = "github" | "codex" | "claude" | "cursor";
export type CloudCredentialAuthKind = "personal-access-token" | "api-key" | "oauth-credentials-json";
const credentialSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  authKind: z.string(),
  fingerprint: z.string(),
  displayIdentity: z.string().optional(),
  version: z.number(),
  updatedAt: millis,
  /** `connected`, `revoked`, `disconnected` or `sign-in-required`. */
  state: z.string(),
  stateReason: z.string().optional(),
  stateChangedAt: millis.optional(),
  sharedUse: z.string(),
  epoch: z.number(),
  configurerLeft: z.boolean().optional(),
});
/** A stored login as the server describes it: who it is and its state, never the secret. */
export type CloudCredential = z.infer<typeof credentialSchema>;

/**
 * The two things a person agrees to before a login is stored: that the
 * organization's workspaces use it, and that it is installed on their
 * machines. The server refuses a save without both, so the screen that asked
 * passes them; this client never fills them in.
 */
export interface CredentialConsent {
  organizationSharing: true;
  machineInstallation: true;
}

const deviceLoginSchema = z.object({ attemptId: z.string().min(1), deviceAuthId: z.string().min(1), userCode: z.string().min(1), verificationUri: HTTPS_URL, intervalSeconds: z.number().positive(), expiresInSeconds: z.number().positive() });
/** A Codex device login in progress. `userCode` is shown to the person; the rest only names the attempt to the server. */
export type CodexDeviceLogin = z.infer<typeof deviceLoginSchema>;
type DeviceLoginReference = Pick<CodexDeviceLogin, "attemptId" | "deviceAuthId" | "userCode">;
const deviceLoginPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.enum(["failed", "expired", "canceled"]) }),
  z.object({ status: z.literal("complete"), credential: credentialSchema }),
]);
export type CodexDeviceLoginPoll = z.infer<typeof deviceLoginPollSchema>;
const deviceLoginCancelSchema = z.object({ status: z.enum(["waiting", "connected", "expired", "canceled", "failed"]) });
export type CodexDeviceLoginState = z.infer<typeof deviceLoginCancelSchema>["status"];

export interface CloudApiOptions {
  /** `https://login.terminalx.ai`. */
  origin: string;
  /** A current access token, refreshed by the caller; null when signed out. */
  accessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const id = (value: string) => encodeURIComponent(value);

export class CloudApi {
  private readonly fetcher: typeof fetch;

  /** The server's clock minus this phone's, from the last answer's `Date` header; 0 until one was read. */
  private clockOffsetMs = 0;

  /** Whether the server knows `wake: false`; null until its capabilities were read. */
  private doNotWakeKnown: boolean | null = null;

  /** Whether the server takes this phone's token for deleting an organization, from the last capabilities read. */
  private phoneDeletion = false;

  /** Whether the server takes this phone's token for creating an organization, from the last capabilities read. */
  private phoneCreation = false;

  constructor(private readonly options: CloudApiOptions) {
    this.fetcher = options.fetch ?? fetch;
    // An answer in a shape this app does not know is one thing to every caller: `cloud_workspace_invalid_response`.
    for (const name of ["organizations", "workspaces", "open", "resume", "enqueue", "commands", "commandStatuses", "cancelCommand", "checkpoints", "checkpoint", "members", "shares", "putShare", "revokeShare", "deleteOrganization"] as const) {
      const self = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = self[name]!.bind(this);
      self[name] = (...args) =>
        original(...args).catch((error: unknown) => {
          throw error instanceof z.ZodError ? new CloudApiError("cloud_workspace_invalid_response", 200) : error;
        });
    }
  }

  /**
   * The time by the server's clock. Expiry times the server hands out (an
   * attach ticket, a relay invite) are compared with this, never with the
   * phone's own clock, which may be minutes off.
   */
  serverNow = (): number => Date.now() + this.clockOffsetMs;

  /** The organizations this account belongs to, with its role in each. */
  async organizations(): Promise<CloudOrganization[]> {
    const body = await this.request("POST", "/v1/desktop/auth/capabilities", {});
    const parsed = z.object({ organizations: z.array(organizationSchema), capabilities: z.object({ flags: z.record(z.string(), z.unknown()) }).passthrough().nullish() }).passthrough().parse(body);
    this.doNotWakeKnown = parsed.capabilities?.flags[DO_NOT_WAKE_CAPABILITY] === true;
    this.phoneDeletion = parsed.capabilities?.flags[ORGANIZATION_DELETE_CAPABILITY] === true;
    this.phoneCreation = parsed.capabilities?.flags[ORGANIZATION_CREATE_CAPABILITY] === true;
    return parsed.organizations;
  }

  /**
   * Whether a command may be posted with `wake: false`. False for a server
   * that does not say so, and while that could not be read: the caller then
   * decides from the list, as before.
   */
  async doNotWake(): Promise<boolean> {
    if (this.doNotWakeKnown === null) await this.organizations().catch(() => undefined);
    return this.doNotWakeKnown === true;
  }

  /**
   * Delete an organization (#1292). The server re-checks that this person
   * owns it, that it is not a personal organization, that nothing still holds
   * it, and that `confirmationName` is its name exactly; send the
   * organization's own name, never what was typed. Only an answer naming this
   * organization as deleted is success: anything else may or may not have
   * deleted it (`organization_delete_outcome_unknown`).
   */
  async deleteOrganization(orgId: string, confirmationName: string): Promise<void> {
    let body: unknown;
    try {
      body = await this.request("POST", `/v1/desktop/orgs/${id(orgId)}/delete`, { confirmationName });
    } catch (error) {
      // As the desktop decodes it: a known refusal, or signed out before sending; anything else may have deleted it.
      // The auth middleware refuses a bad bearer with 401 `unauthorized` before the handler runs (#1349).
      if (error instanceof CloudApiError && error.status === 401 && error.code === "unauthorized") throw new CloudApiError("invalid_access_token", 401);
      if (error instanceof CloudApiError && (error.code === "account_signed_out" || (ORGANIZATION_DELETION_REFUSALS as readonly string[]).includes(error.code))) throw error;
      throw new CloudApiError("organization_delete_outcome_unknown", error instanceof CloudApiError ? error.status : null);
    }
    const answer = z.object({ organizationId: z.string(), deleted: z.boolean() }).passthrough().safeParse(body);
    if (!answer.success || answer.data.organizationId !== orgId || answer.data.deleted !== true) throw new CloudApiError("organization_delete_outcome_unknown", 200);
  }

  /** Whether this server deletes organizations for a phone, as of the last organizations read. */
  deletesOrganizations(): boolean {
    return this.phoneDeletion;
  }

  /** Whether this server creates organizations for a phone, as of the last organizations read. */
  createsOrganizations(): boolean {
    return this.phoneCreation;
  }

  /**
   * Create an organization, of which this person becomes the owner (PRO-526).
   * The server asks for a name only. One `idempotencyKey` names one attempt
   * at one name: sent again after a lost answer it returns the organization
   * the first request made, never a second one; with another name the server
   * refuses it (`organization_idempotency_key_reused`).
   */
  async createOrganization(name: string, idempotencyKey: string): Promise<CloudOrganization> {
    const trimmed = name.trim();
    // Refused here as the server would refuse it, so nothing is sent that cannot be taken.
    if (trimmed.length < ORGANIZATION_NAME.min || trimmed.length > ORGANIZATION_NAME.max) throw new CloudApiError("organization_name_invalid", 400);
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new CloudApiError("organization_idempotency_key_invalid", 400);
    const created = read(createdOrganizationSchema, await this.request("POST", "/v1/desktop/orgs", { name: trimmed }, { "Idempotency-Key": idempotencyKey }));
    // A team organization: the server makes a personal one only at sign-up.
    return { orgId: created.id, name: created.name, role: created.role, isPersonal: false };
  }

  /** An organization's workspaces as this person may see them. Reading the list never starts compute. */
  async workspaces(orgId: string): Promise<{ workspaces: CloudWorkspaceItem[]; tombstones: CloudTombstone[] }> {
    const list = listSchema.parse(await this.request("GET", `${base(orgId)}/cloud-workspaces`));
    // A row for another organization is not this one's.
    if (list.workspaces.some((item) => item.workspace.orgId !== orgId)) throw new CloudApiError("cloud_workspace_invalid_response", 200);
    return { workspaces: list.workspaces, tombstones: list.tombstones ?? [] };
  }

  /**
   * Ask for an attachment to a running workspace. The server refuses a
   * stopped one (`cloud_workspace_not_found`) and resumes nothing; the
   * provider is never asked to reconcile from here.
   */
  async open(orgId: string, workspaceId: string, clientInstallationId: string, options: { refreshPairing?: boolean } = {}): Promise<CloudAttachment> {
    const body = { clientInstallationId, ...(options.refreshPairing ? { refreshPairing: true } : {}) };
    return attachmentSchema.parse(await this.request("POST", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/open?attachTicket=1`, body));
  }

  /**
   * Start a stopped workspace, as the person asked. The server allows it to
   * the workspace's managers (its creator, organization owners and admins)
   * and refuses anyone else (`cloud_workspace_manager_required`). It answers
   * with the workspace and the queued operation; the list says when it runs.
   */
  async resume(orgId: string, workspaceId: string): Promise<CloudWorkspaceSnapshot> {
    const parsed = snapshotSchema.safeParse(await this.request("POST", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/resume`, {}));
    // An answer this app cannot read is said as such, not as a failure with no reason (#1290).
    if (!parsed.success) throw new CloudApiError("cloud_workspace_invalid_response", 200);
    const snapshot = parsed.data;
    // An answer about another workspace is not the answer to this request.
    if (snapshot.workspace.id !== workspaceId || snapshot.workspace.orgId !== orgId) throw new CloudApiError("cloud_workspace_invalid_response", 200);
    return snapshot;
  }

  /**
   * Queue an encrypted command. The same envelope may be posted again: the
   * server answers with the first outcome. With `wake: false` (only for a
   * server where `doNotWake()`) nothing is started: a workspace that is not
   * running is refused with `WORKSPACE_STOPPED` and the command is not stored.
   */
  async enqueue(orgId: string, workspaceId: string, envelope: CommandEnvelope, options: { wake?: boolean } = {}): Promise<{ command: CloudCommand; existing: boolean; wake: WakeResult | null }> {
    const body = options.wake === false ? { ...envelope, wake: false } : envelope;
    const answer = z.object({ command: commandSchema, existing: z.boolean().optional(), wake: z.string().nullish() }).parse(await this.request("POST", `${mailbox(orgId, workspaceId)}`, body));
    return { command: answer.command, existing: answer.existing ?? false, wake: answer.wake ?? null };
  }

  async commands(orgId: string, workspaceId: string, tabId?: string): Promise<CloudCommand[]> {
    const query = tabId ? `?tabId=${id(tabId)}` : "";
    return z.object({ commands: z.array(commandSchema) }).parse(await this.request("GET", `${mailbox(orgId, workspaceId)}${query}`)).commands;
  }

  /** At most 100 ids per call (§11.1). */
  async commandStatuses(orgId: string, workspaceId: string, clientCommandIds: string[]): Promise<CloudCommand[]> {
    const out: CloudCommand[] = [];
    for (let index = 0; index < clientCommandIds.length; index += 100) {
      const answer = await this.request("POST", `${mailbox(orgId, workspaceId)}/status`, { v: 1, clientCommandIds: clientCommandIds.slice(index, index + 100) });
      out.push(...z.object({ commands: z.array(commandSchema) }).parse(answer).commands);
    }
    return out;
  }

  async cancelCommand(orgId: string, workspaceId: string, clientCommandId: string): Promise<CloudCommand> {
    return z.object({ command: commandSchema }).parse(await this.request("POST", `${mailbox(orgId, workspaceId)}/${id(clientCommandId)}/cancel`, {})).command;
  }

  async checkpoints(orgId: string, workspaceId: string): Promise<CheckpointMeta[]> {
    return z.object({ checkpoints: z.array(checkpointMetaSchema) }).parse(await this.request("GET", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/transcript-checkpoints`)).checkpoints;
  }

  /** The newest checkpoint of a tab after `(epoch, version)`, still encrypted; null when there is none newer. */
  async checkpoint(orgId: string, workspaceId: string, tabId: string, after?: { epoch: number; version: number } | null): Promise<CheckpointEnvelope | null> {
    const query = after ? `?afterEpoch=${after.epoch}&afterVersion=${after.version}` : "";
    try {
      const answer = z.object({ checkpoint: checkpointSchema.nullable() }).parse(await this.request("GET", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/transcript-checkpoints/${id(tabId)}${query}`));
      return answer.checkpoint;
    } catch (error) {
      if (error instanceof CloudApiError && error.code === "cloud_workspace_transcript_checkpoint_not_found") return null;
      throw error;
    }
  }

  /** The organization's members: the names behind user ids, and the people a workspace can be shared with. */
  async members(orgId: string): Promise<CloudMember[]> {
    return z.object({ members: z.array(memberSchema) }).passthrough().parse(await this.request("GET", `/v1/desktop/orgs/${id(orgId)}/members`)).members;
  }

  shares(orgId: string, workspaceId: string): Promise<CloudShares> {
    return this.request("GET", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/shares`).then((body) => sharesSchema.parse(body));
  }

  async putShare(orgId: string, workspaceId: string, userId: string, share: { role: "viewer" | "driver"; canApprove: boolean }): Promise<CloudShare> {
    const answer = await this.request("PUT", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/shares/${id(userId)}`, { v: 1, role: share.role, canApprove: share.canApprove });
    const parsed = z.object({ share: shareSchema }).passthrough().parse(answer).share;
    // An answer about someone else is not the answer to this request.
    if (parsed.userId !== userId) throw new CloudApiError("cloud_workspace_invalid_response", 200);
    return parsed;
  }

  async revokeShare(orgId: string, workspaceId: string, userId: string): Promise<void> {
    await this.request("DELETE", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/shares/${id(userId)}`);
  }

  // ── Compute providers ──

  /** The compute providers this organization may use, in the server's order, with each one's connection as this person may see it. */
  async providers(orgId: string): Promise<CloudProvider[]> {
    return read(z.object({ providers: z.array(providerSchema) }), await this.request("GET", `${base(orgId)}/cloud-providers`)).providers;
  }

  /**
   * Connect a provider with the organization's own key: the value of the one
   * field its `credentialFields` asks for, sent as it is. Every provider the
   * server registers asks for one; a provider that asks for several is not
   * connected from here until the server says how they are sent. The key
   * goes to the server in this one request and nowhere else: this client
   * keeps no copy, and the answer describes the connection by fingerprint only.
   */
  async connectProvider(orgId: string, providerId: string, credential: string, accepted: { providerBilling: true; organizationUse: true }): Promise<CloudProviderConnection> {
    // Refused here as the server would, before anything is sent.
    if (typeof credential !== "string" || !credential) throw new CloudApiError("cloud_workspace_request_invalid", 422);
    const body = {
      credential,
      disclosure: { version: PROVIDER_DISCLOSURE_VERSION, providerBillingAccepted: accepted.providerBilling, organizationUseAccepted: accepted.organizationUse },
    };
    return connectionFor(providerId, await this.request("POST", `${base(orgId)}/cloud-providers/${id(providerId)}/connect`, body, {}, [credential]));
  }

  /**
   * Disconnect a provider. While it still holds machines the server refuses
   * (`provider-has-machines`): what happens to them is decided on the
   * desktop or the web console, not here.
   */
  async disconnectProvider(orgId: string, providerId: string): Promise<CloudProviderConnection> {
    return connectionFor(providerId, await this.request("POST", `${base(orgId)}/cloud-providers/${id(providerId)}/disconnect`, {}));
  }

  // ── Launching a workspace ──

  /** What a connected provider offers right now: images, locations, machine sizes and its defaults. */
  async providerSetup(orgId: string, providerId: string): Promise<CloudProviderSetup> {
    const setup = read(providerSetupSchema, await this.request("GET", `${base(orgId)}/cloud-workspaces/setup?provider=${id(providerId)}`));
    if (setup.provider !== providerId) throw invalidResponse();
    return setup;
  }

  /** Price one choice. The quote is what `createWorkspace` launches, and it expires (`expiresAt`, by `serverNow()`). */
  async quote(orgId: string, input: CloudQuoteInput): Promise<CloudQuote> {
    const body = { provider: input.provider, sourceId: input.sourceId, locationId: input.locationId, machineClassId: input.machineClassId, idleSuspendMinutes: input.idleSuspendMinutes, retentionDays: input.retentionDays, networkPolicy: input.networkPolicy };
    const quote = read(quoteSchema, await this.request("POST", `${base(orgId)}/cloud-workspaces/quote`, body));
    if (quote.provider !== input.provider) throw invalidResponse();
    return quote;
  }

  /** Check a setup before paying for a machine: that each repository can be cloned and each login still works. Nothing is created. */
  async preflight(orgId: string, setup: CloudFirstRunSetup): Promise<CloudPreflight> {
    return read(preflightSchema, await this.request("POST", `${base(orgId)}/cloud-workspaces/preflight`, { setup: firstRun(setup) }));
  }

  /**
   * Launch a workspace from a quote. `confirmProviderSpend` is the person's
   * own yes to the quoted price. `idempotencyKey` names this one launch:
   * make it once when the person confirms and send the same key on every
   * retry. After a timeout the server may already have started the machine;
   * the same key with the same input then answers with that first launch
   * instead of starting a second, and with a different input it is refused
   * (`idempotency-key-reused`).
   *
   * `launch` is the first task (PRO-547): the runtime starts that agent in
   * the new workspace and sends it the prompt once. Its mode is always one a
   * phone may name; anything else is refused here, before anything is sent.
   */
  async createWorkspace(orgId: string, input: { name: string; quoteId: string; confirmProviderSpend: true; setup?: CloudFirstRunSetup; launch?: CloudLaunch }, idempotencyKey: string): Promise<CloudLifecycle> {
    // Refused here as the server would, before anything is sent.
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new CloudApiError("cloud_workspace_request_invalid", 422);
    const body = { name: input.name, quoteId: input.quoteId, confirmProviderSpend: input.confirmProviderSpend, ...(input.setup ? { setup: firstRun(input.setup) } : {}), ...(input.launch ? { launch: launchBody(input.launch) } : {}) };
    const answer = read(lifecycleSchema, await this.request("POST", `${base(orgId)}/cloud-workspaces`, body, { "Idempotency-Key": idempotencyKey }));
    if (answer.workspace.orgId !== orgId || answer.operation.workspaceId !== answer.workspace.id) throw invalidResponse();
    return answer;
  }

  /** Stop a running workspace, as its managers may. */
  suspend(orgId: string, workspaceId: string): Promise<CloudLifecycle> {
    return this.lifecycle(orgId, workspaceId, "suspend");
  }

  /** Delete a workspace and release its machine, as its managers may. The answer's operation reports the cleanup. */
  deleteWorkspace(orgId: string, workspaceId: string): Promise<CloudLifecycle> {
    return this.lifecycle(orgId, workspaceId, "delete");
  }

  private async lifecycle(orgId: string, workspaceId: string, action: "suspend" | "delete"): Promise<CloudLifecycle> {
    const answer = read(lifecycleSchema, await this.request("POST", `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/${action}`, {}));
    // An answer about another workspace is not the answer to this request.
    if (answer.workspace.id !== workspaceId || answer.workspace.orgId !== orgId || answer.operation.workspaceId !== workspaceId) throw invalidResponse();
    return answer;
  }

  // ── Operations ──

  /** How far an operation is: its state, stage and progress, with the workspace as it now stands. */
  async operation(orgId: string, operationId: string): Promise<CloudLifecycle> {
    return operationFor(orgId, operationId, await this.request("GET", `${base(orgId)}/cloud-workspace-operations/${id(operationId)}`));
  }

  /** Ask a running operation to stop (only while it is `cancelable`). The answer says whether it has yet. */
  async cancelOperation(orgId: string, operationId: string): Promise<CloudLifecycle> {
    return operationFor(orgId, operationId, await this.request("POST", `${base(orgId)}/cloud-workspace-operations/${id(operationId)}/cancel`, {}));
  }

  // ── Agent logins ──

  /** The logins the organization stores for its workspaces, for its owners and admins. */
  async credentials(orgId: string): Promise<CloudCredential[]> {
    return read(z.object({ credentials: z.array(credentialSchema) }), await this.request("GET", `${base(orgId)}/cloud-workspace-credentials`)).credentials;
  }

  /**
   * Store or replace the organization's login for one agent or service. The
   * secret goes to the server in this one request and nowhere else: this
   * client keeps no copy, and the answer names the login by fingerprint only.
   */
  async saveCredential(orgId: string, provider: CloudCredentialProvider, input: { authKind: CloudCredentialAuthKind; secret: string; displayIdentity?: string | null; sharedUse?: "organization" | "managers" }, consent: CredentialConsent): Promise<CloudCredential> {
    const body = {
      authKind: input.authKind,
      secret: input.secret,
      displayIdentity: input.displayIdentity ?? null,
      ...(input.sharedUse ? { sharedUse: input.sharedUse } : {}),
      confirmOrganizationSharing: consent.organizationSharing,
      confirmMachineInstallation: consent.machineInstallation,
    };
    return credentialFor(provider, await this.request("PUT", `${base(orgId)}/cloud-workspace-credentials/${id(provider)}`, body, {}, [input.secret]));
  }

  /** Remove a stored login. Refused while a workspace was set up with it (`login-in-use`). */
  async deleteCredential(orgId: string, provider: CloudCredentialProvider): Promise<void> {
    await this.request("DELETE", `${base(orgId)}/cloud-workspace-credentials/${id(provider)}`);
  }

  /** Stop workspaces from being handed a login, without removing it. Saving it again makes it usable. */
  async revokeCredential(orgId: string, provider: CloudCredentialProvider): Promise<CloudCredential> {
    return credentialFor(provider, await this.request("POST", `${base(orgId)}/cloud-workspace-credentials/${id(provider)}/revoke`, {}));
  }

  /** Begin "Sign in with ChatGPT" for Codex: the code to show and where the person enters it. */
  async startCodexLogin(orgId: string): Promise<CodexDeviceLogin> {
    return read(deviceLoginSchema, await this.request("POST", `${base(orgId)}/cloud-workspace-credentials/codex/device-start`, {}));
  }

  /**
   * Ask whether the person finished signing in; no sooner than every
   * `intervalSeconds`. `complete` carries the login the server stored: the
   * tokens themselves never come to the phone.
   */
  async pollCodexLogin(orgId: string, login: DeviceLoginReference, consent: CredentialConsent): Promise<CodexDeviceLoginPoll> {
    const body = { attemptId: login.attemptId, deviceAuthId: login.deviceAuthId, userCode: login.userCode, confirmOrganizationSharing: consent.organizationSharing, confirmMachineInstallation: consent.machineInstallation };
    const answer = read(deviceLoginPollSchema, await this.request("POST", `${base(orgId)}/cloud-workspace-credentials/codex/device-poll`, body));
    if (answer.status === "complete" && answer.credential.provider !== "codex") throw invalidResponse();
    return answer;
  }

  /** Give up a device login. The answer is where the attempt ended, which is `connected` when the sign-in won the race. */
  async cancelCodexLogin(orgId: string, login: DeviceLoginReference): Promise<CodexDeviceLoginState> {
    const body = { attemptId: login.attemptId, deviceAuthId: login.deviceAuthId, userCode: login.userCode };
    return read(deviceLoginCancelSchema, await this.request("POST", `${base(orgId)}/cloud-workspace-credentials/codex/device-cancel`, body)).status;
  }

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, headers: Record<string, string> = {}, secrets: readonly string[] = []): Promise<unknown> {
    const token = await this.options.accessToken();
    if (!token) throw new CloudApiError("account_signed_out", 401);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...CONTRACT_HEADERS, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new CloudApiError("cloud_workspace_unavailable", null, timedOut ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
    const stamp = Date.parse(response.headers?.get?.("date") ?? "");
    // The header has whole seconds; a difference that small is noise, not skew.
    if (Number.isFinite(stamp)) this.clockOffsetMs = Math.abs(stamp - Date.now()) < 2_000 ? 0 : stamp - Date.now();
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : null;
      // Only a plain token crosses to the UI as a code.
      // Nor does a key or token this request sent: one echoed back as the "code" is not kept as one.
      if (code === null || !/^[a-z0-9_.-]{1,96}$/i.test(code) || secrets.some((secret) => echoes(secret, code))) throw new CloudApiError("cloud_workspace_unavailable", response.status, "unreadable");
      throw new CloudApiError(code, response.status, null, code === "organization_delete_blocked" ? organizationDeletionBlockers(parsed) : []);
    }
    if (parsed === null && response.status !== 204) throw new CloudApiError("cloud_workspace_invalid_response", response.status);
    return parsed;
  }
}

const base = (orgId: string) => `/v1/mobile/orgs/${id(orgId)}`;
const mailbox = (orgId: string, workspaceId: string) => `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/agent-commands`;

/**
 * Whether `code` repeats a secret the request carried, whole or in a part
 * long enough to be a key. Only the secret is compared: a workspace or an
 * organization may be named with a word the server's codes use.
 */
function echoes(secret: unknown, code: string): boolean {
  if (typeof secret === "string") {
    if (secret === code || (code.length >= 8 && secret.includes(code)) || (secret.length >= 8 && code.includes(secret))) return true;
    // An agent's login file travels as JSON in one string: its values are the tokens.
    if (!secret.startsWith("{")) return false;
    try {
      return echoes(JSON.parse(secret) as unknown, code);
    } catch {
      return false;
    }
  }
  if (secret && typeof secret === "object") return Object.values(secret).some((value) => echoes(value, code));
  return false;
}

const invalidResponse = () => new CloudApiError("cloud_workspace_invalid_response", 200);

/** Parse an answer; one this app cannot read is `cloud_workspace_invalid_response`, and nothing of it is kept. */
function read<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

// An answer about another provider, operation or login is not the answer to this request.
function connectionFor(providerId: string, body: unknown): CloudProviderConnection {
  const connection = read(providerConnectionSchema, body);
  if (connection.provider !== providerId) throw invalidResponse();
  return connection;
}

function operationFor(orgId: string, operationId: string, body: unknown): CloudLifecycle {
  const answer = read(lifecycleSchema, body);
  if (answer.operation.id !== operationId || answer.workspace.orgId !== orgId || answer.operation.workspaceId !== answer.workspace.id) throw invalidResponse();
  return answer;
}

function credentialFor(provider: CloudCredentialProvider, body: unknown): CloudCredential {
  const credential = read(credentialSchema, body);
  if (credential.provider !== provider) throw invalidResponse();
  return credential;
}

/** A setup as the server's parser takes it: exactly these keys, and no `repositories` when there are none. */
function firstRun(setup: CloudFirstRunSetup) {
  const repositories = (setup.repositories ?? []).map((repository) => ({ sourceProvider: "github" as const, cloneUrl: repository.cloneUrl, ...(repository.ref ? { ref: repository.ref } : {}) }));
  return { version: 1 as const, credentialIds: [...setup.credentialIds], ...(repositories.length ? { repositories } : {}) };
}
