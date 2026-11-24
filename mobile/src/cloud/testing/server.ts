import { CloudApi } from "../api";

/**
 * The account service as the launch and manage screens meet it, for tests:
 * the real `CloudApi` over a fetch that answers the way terminalx-saas does
 * (`controllers/mobile/cloudMachineAdmin.ts`: the routes, the statuses and
 * `{ error }`). Each answer below is built field for field from the server's
 * own builders: `cloudProviderPublicDescriptor` of the Boat and Agent37
 * descriptors, `cloudWorkspaceProviderOfferings.setup`, `quoteProvider`,
 * `preflight`, `workspaceResponse`, `operationResponse`, `credentialResponseFor`.
 */

export type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
export type Answer = { status?: number; body?: unknown } | "timeout" | "offline";

export const ORIGIN = "https://login.terminalx.ai";

/** A client whose server is `answer`; `calls` remembers what was sent. A `timeout` never answers, `offline` fails at once. */
export function server(answer: (call: Call) => Answer | Promise<Answer>, options: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const call = { path: url.replace(`${ORIGIN}/v1/mobile/orgs/org-1`, ""), method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const said = await answer(call);
    if (said === "offline") throw new TypeError("Network request failed");
    if (said === "timeout") return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const status = said.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (said.body === undefined ? "" : JSON.stringify(said.body)) } as unknown as Response;
  };
  return { api: new CloudApi({ origin: ORIGIN, accessToken: async () => "access-token", fetch: fetcher as never, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }), calls };
}

export const refuse = (code: string, status: number): Answer => ({ status, body: { error: code } });

const IDLE = [5, 10, 15, 30, 60, 0];
const RETENTION = [7, 30, 90];
const capabilities = { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false };

// Boat (`box`): places the machine itself, billed per second by Boat, nothing billed while stopped.
export const boatDescriptor = {
  id: "box", label: "Boat", icon: "ship", order: 10, description: "Sandboxes with fast start and suspend.", billing: "Per second, billed by Boat", billedByProvider: true, listed: true,
  credentialSource: "organization", credentialFields: [{ name: "credential", kind: "secret", label: "Boat API key", helpUrl: "https://docs.boat.dev/api-keys.md" }], capabilities,
  offering: { locations: "automatic", sources: "optional", machineClasses: "catalog", pricingSource: "estimate", suspendedBilling: "none" }, allowedIdleSuspendMinutes: IDLE, allowedRetentionDays: RETENTION,
};
// Agent37: the location is chosen; only the disk bills while asleep.
export const agent37Descriptor = {
  id: "agent37", label: "Agent37", icon: "server", order: 25, description: "Full virtual machines with Docker in the US, France and India. Sleeps when idle.", billing: "Per minute from your Agent37 wallet; only disk bills while asleep", billedByProvider: true, listed: true,
  credentialSource: "organization", credentialFields: [{ name: "credential", kind: "secret", label: "Agent37 API key", helpUrl: "https://www.agent37.com/dashboard/cloud/api-keys" }], capabilities,
  offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "estimate", suspendedBilling: "unknown" }, allowedIdleSuspendMinutes: IDLE, allowedRetentionDays: RETENTION,
};
// TerminalX Cloud: a platform provider, billed by TerminalX, nothing to connect.
export const terminalxCloudDescriptor = { ...boatDescriptor, id: "terminalx-cloud", label: "TerminalX Cloud", icon: "cloud", order: 5, description: "Machines on TerminalX Cloud.", billing: "Billed by TerminalX", billedByProvider: false, credentialSource: "platform", credentialFields: [] };

const connection = { state: "connected", connectedAt: 1_795_000_000_000, lastValidatedAt: 1_795_000_100_000, credentialFingerprint: "sha256:9f2c" };
export const boat = { id: "box", displayName: "Boat", availability: "available", canManage: true, connection, descriptor: boatDescriptor };
export const agent37 = { id: "agent37", displayName: "Agent37", availability: "available", canManage: true, connection, descriptor: agent37Descriptor };
export const terminalxCloud = { id: "terminalx-cloud", displayName: "TerminalX Cloud", availability: "available", canManage: true, descriptor: terminalxCloudDescriptor };

export const boatSelection = { sourceId: "default", locationId: "auto-eu", machineClassId: "small", idleSuspendMinutes: 15, retentionDays: 30, networkPolicy: "relay-only" };
export const boatSetup = {
  provider: "box", credentialFingerprint: "sha256:9f2c", currency: "USD", pricing: "estimate", pricingObservedAt: 1_795_000_200_000,
  sources: [{ id: "default", kind: "template", label: "Default image" }],
  locations: [{ id: "auto-eu", label: "Automatic EU placement", placement: "automatic" }],
  machineClasses: [
    { id: "small", label: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, activeHourlyMicros: 18_000 },
    { id: "default", label: "Default", vcpu: 4, memoryMiB: 8192, diskGiB: 80, activeHourlyMicros: 36_000 },
    { id: "large", label: "Large", vcpu: 8, memoryMiB: 16_384, diskGiB: 100, activeHourlyMicros: 72_000 },
  ],
  defaults: boatSelection, allowedIdleSuspendMinutes: IDLE, allowedRetentionDays: RETENTION, maxIdleSuspendMinutes: null,
};
export const agent37Selection = { sourceId: "base", locationId: "us", machineClassId: "2x4", idleSuspendMinutes: 10, retentionDays: 30, networkPolicy: "relay-only" };
export const agent37Setup = {
  provider: "agent37", credentialFingerprint: "sha256:9f2c", currency: "USD", pricing: "estimate", pricingObservedAt: 1_795_000_200_000,
  sources: [{ id: "base", kind: "image", label: "Base image" }],
  locations: [{ id: "us", label: "United States", placement: "selected" }, { id: "fr", label: "France", placement: "selected" }, { id: "in", label: "India", placement: "selected" }],
  machineClasses: [{ id: "2x4", label: "2 vCPU · 4 GB RAM", vcpu: 2, memoryMiB: 4096, diskGiB: 40 }, { id: "4x8", label: "4 vCPU · 8 GB RAM", vcpu: 4, memoryMiB: 8192, diskGiB: 80 }],
  defaults: agent37Selection, allowedIdleSuspendMinutes: IDLE, allowedRetentionDays: RETENTION, maxIdleSuspendMinutes: 60,
};

/** `quoteProvider` for the Boat default, holding until `expiresAt`. */
export const boatQuote = (expiresAt: number, more: Record<string, unknown> = {}) => ({
  id: "quote_5b1e", provider: "box", expiresAt, currency: "USD", pricing: "estimate", pricingObservedAt: 1_795_000_200_000, activeHourlyMicros: 18_000, alwaysOnThirtyDayMicros: 12_960_000, estimatedSuspendedMonthlyMicros: 0,
  configuration: { ...boatSelection, sourceLabel: "Default image", locationLabel: "Automatic EU placement", machineClassLabel: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, architecture: "x86_64" },
  ...more,
});

export const codexLogin = { id: "cred_codex", provider: "codex", authKind: "oauth-credentials-json", fingerprint: "sha256:41aa", displayIdentity: "alex@example.com", version: 3, updatedAt: 1_795_000_400_000, state: "connected", sharedUse: "organization", epoch: 2 };
export const claudeKey = { id: "cred_claude", provider: "claude", authKind: "api-key", fingerprint: "sha256:77b0", version: 1, updatedAt: 1_795_000_400_000, state: "connected", sharedUse: "organization", epoch: 0 };
export const githubToken = { id: "cred_github", provider: "github", authKind: "personal-access-token", fingerprint: "sha256:1c0d", displayIdentity: "acme-bot", version: 1, updatedAt: 1_795_000_400_000, state: "connected", sharedUse: "organization", epoch: 0 };

/** `workspaceResponse` as a manager is answered. */
export const workspace = (more: Record<string, unknown> = {}) => ({ id: "ws-9", orgId: "org-1", name: "Checkout redesign", provider: "box", providerDescriptor: { label: "Boat" }, state: "provisioning", accessMode: "organization", you: { role: "manager", canApprove: true, canManageShares: true }, createdAt: 1_795_000_300_000, updatedAt: 1_795_000_300_000, ...more });
/** `operationResponse`; a launch is a `create` with no `action`. */
export const operation = (more: Record<string, unknown> = {}) => ({ id: "op-9", workspaceId: "ws-9", type: "create", state: "queued", stage: "queued", cancelable: true, createdAt: 1_795_000_300_000, updatedAt: 1_795_000_300_000, ...more });
export const lifecycle = (ws: Record<string, unknown> = {}, op: Record<string, unknown> = {}) => ({ workspace: workspace(ws), operation: operation(op) });
