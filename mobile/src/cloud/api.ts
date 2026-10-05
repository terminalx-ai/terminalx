import { z } from "zod";
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
 * workspace is woken only by a queued command (`enqueue`), which the server
 * reports back as `wake`; with `wake: false` the server starts nothing and
 * refuses a stopped workspace instead (`WORKSPACE_STOPPED`, §11.2.1).
 */

/** The server's refusal of a `wake: false` command for a workspace that is not running. Nothing was stored. */
export const WORKSPACE_STOPPED = "cloud_workspace_stopped";
/** The capability flag of a server that knows `wake: false`; an older one rejects the key. */
const DO_NOT_WAKE_CAPABILITY = "cloud.workspaces.agent-command-wake.v1";

const CONTRACT_HEADERS = {
  "X-TerminalX-Cloud-Workspace-Contract": "providers-v1",
  "X-TerminalX-Cloud-Workspace-Providers": "machine0,box",
  "X-TerminalX-Cloud-Workspace-Lifecycle": "archive-v1",
} as const;

export class CloudApiError extends Error {
  constructor(
    readonly code: string,
    /** The HTTP status; null when the request never got an answer (offline, timed out). */
    readonly status: number | null,
  ) {
    super(code);
    this.name = "CloudApiError";
  }

  /** The network or the service, not the workspace: what was shown stays, and the request may be tried again. */
  get unreachable(): boolean {
    return this.status === null || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

const ROLE = z.enum(["manager", "driver", "viewer", "none"]);
const youSchema = z.object({ role: ROLE, canApprove: z.boolean(), canManageShares: z.boolean().optional() }).passthrough();

const workspaceSchema = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    name: z.string(),
    provider: z.string(),
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
    launch: z.object({ workBranch: z.string().nullish(), sessionId: z.string().nullish(), tabId: z.string().nullish(), phase: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const operationSchema = z.object({ id: z.string(), state: z.string(), action: z.string().nullish(), errorCode: z.string().nullish() }).passthrough();
const listItemSchema = z.object({ workspace: workspaceSchema, latestOperation: operationSchema.nullish() }).passthrough();
const tombstoneSchema = z.object({ id: z.string(), orgId: z.string(), deletedAt: z.number(), expiresAt: z.number() });
const listSchema = z.object({ workspaces: z.array(listItemSchema), tombstones: z.array(tombstoneSchema).optional() }).passthrough();

export type CloudWorkspace = z.infer<typeof workspaceSchema>;
export type CloudWorkspaceItem = z.infer<typeof listItemSchema>;
export type CloudTombstone = z.infer<typeof tombstoneSchema>;
export type CloudRole = z.infer<typeof ROLE>;

const organizationSchema = z.object({ orgId: z.string().min(1), name: z.string(), role: z.string() }).passthrough();
export type CloudOrganization = z.infer<typeof organizationSchema>;

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

  constructor(private readonly options: CloudApiOptions) {
    this.fetcher = options.fetch ?? fetch;
    // An answer in a shape this app does not know is one thing to every caller: `cloud_workspace_invalid_response`.
    for (const name of ["organizations", "workspaces", "open", "enqueue", "commands", "commandStatuses", "cancelCommand", "checkpoints", "checkpoint", "members", "shares", "putShare", "revokeShare"] as const) {
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

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    const token = await this.options.accessToken();
    if (!token) throw new CloudApiError("account_signed_out", 401);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...CONTRACT_HEADERS },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new CloudApiError("cloud_workspace_unavailable", null);
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
      const code = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : "cloud_workspace_unavailable";
      // Only a plain token crosses to the UI as a code.
      throw new CloudApiError(/^[a-z0-9_.-]{1,96}$/i.test(code) ? code : "cloud_workspace_unavailable", response.status);
    }
    if (parsed === null && response.status !== 204) throw new CloudApiError("cloud_workspace_invalid_response", response.status);
    return parsed;
  }
}

const base = (orgId: string) => `/v1/mobile/orgs/${id(orgId)}`;
const mailbox = (orgId: string, workspaceId: string) => `${base(orgId)}/cloud-workspaces/${id(workspaceId)}/agent-commands`;
