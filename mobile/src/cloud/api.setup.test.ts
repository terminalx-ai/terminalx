import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudApi, CloudApiError, PROVIDER_DISCLOSURE_VERSION, type CloudRefusal } from "./api";

/**
 * The cloud setup calls (PRO-525) against the account service's answers.
 *
 * Every answer here is built the way terminalx-saas builds it at
 * origin/main 18affb1e, field for field, from:
 * - `controllers/mobile/cloudMachineAdmin.ts` (routes, statuses, `{ error }`),
 * - `controllers/cloudWorkspaceBodyParsers.ts` (the exact keys of each body),
 * - `services/cloudProviderConnections` (`summaryFor`, `connectionResponse`),
 * - `services/cloudWorkspaces` (`cloudWorkspaceProviderOfferings.setup`,
 *   `quoteProvider`, `preflight`, `workspaceResponse`, `operationResponse`),
 * - `services/cloudWorkspaceCredentials` (`credentialResponseFor`,
 *   `agentCredentialConnectAttempts`).
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Answer = { status?: number; body?: unknown; text?: string };

const ORIGIN = "https://login.terminalx.ai";
const ORG = `${ORIGIN}/v1/mobile/orgs/org-1`;

// A plain function, not a spy: nothing but `calls` remembers what was sent.
function api(answers: (call: Call) => Answer | Promise<Answer>, token: string | null = "access-token") {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const answer = await answers(call);
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body)) } as Response;
  };
  return { client: new CloudApi({ origin: ORIGIN, accessToken: async () => token, fetch: fetcher as never }), calls };
}

const refused = (code: string, status: number) => api(() => ({ status, body: { error: code } }));

/** A client whose server never answers: each call is aborted at the 30 s limit. */
async function timedOut<T>(run: (client: CloudApi) => Promise<T>): Promise<{ error: unknown; calls: Call[] }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const calls: Call[] = [];
    const fetcher = (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    const pending = run(new CloudApi({ origin: ORIGIN, accessToken: async () => "access-token", fetch: fetcher as never })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    return { error: await pending, calls };
  } finally {
    vi.useRealTimers();
  }
}

// ── Answers, as the server builds them ──

// `cloudProviderPublicDescriptor` of the Hetzner descriptor.
const hetznerDescriptor = {
  id: "hetzner",
  label: "Hetzner Cloud",
  icon: "server",
  order: 20,
  description: "Machines in Falkenstein, Nuremberg, Helsinki, Ashburn and Hillsboro.",
  billing: "Hourly, billed by Hetzner",
  billedByProvider: true,
  listed: true,
  credentialSource: "organization",
  credentialFields: [{ name: "credential", kind: "secret", label: "Hetzner API token", helpUrl: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token" }],
  capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false },
  offering: { locations: "required", sources: "optional", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "full-rate" },
  allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0],
  allowedRetentionDays: [7, 30, 90],
};
// A platform provider: nothing to connect, no fields, never a `connection`.
const platformDescriptor = { ...hetznerDescriptor, id: "terminalx-cloud", label: "TerminalX Cloud", icon: "cloud", order: 5, description: "Machines on TerminalX Cloud.", billing: "Billed by TerminalX", billedByProvider: false, credentialSource: "platform", credentialFields: [] };
const summaryCapabilities = { create: true, suspend: true, resume: true, locationSelection: "required", sourceSelection: "optional", pricing: "provider-rate" };
// `summaryFor`: an admin sees the connection; `capabilities` is the server's own descriptor block.
const connectedProvider = { id: "hetzner", displayName: "Hetzner Cloud", availability: "available", canManage: true, connection: { state: "connected", connectedAt: 1_795_000_000_000, lastValidatedAt: 1_795_000_100_000, credentialFingerprint: "sha256:9f2c" }, capabilities: summaryCapabilities, descriptor: hetznerDescriptor };
const platformProvider = { id: "terminalx-cloud", displayName: "TerminalX Cloud", availability: "available", canManage: true, capabilities: summaryCapabilities, descriptor: platformDescriptor };
// What a member who is not an admin is told: no `connection`.
const memberProvider = { id: "hetzner", displayName: "Hetzner Cloud", availability: "not-connected", canManage: false, capabilities: summaryCapabilities, descriptor: hetznerDescriptor };

// `connectionResponse` after a successful connect.
const connected = { provider: "hetzner", state: "connected", canManage: true, credentialVersion: 1, providerAccount: "project 4821", operationsBlocked: false, credentialFingerprint: "sha256:9f2c", connectedAt: 1_795_000_000_000, lastValidatedAt: 1_795_000_000_000 };
// The answer to a disconnect with nothing left on the provider.
const disconnected = { provider: "hetzner", state: "not-connected", canManage: true, credentialVersion: 2, providerAccount: "project 4821", operationsBlocked: true, resources: [] };

const selection = { sourceId: "ubuntu-24.04", locationId: "fsn1", machineClassId: "cx32", idleSuspendMinutes: 30, retentionDays: 30, networkPolicy: "relay-only" };
// `cloudWorkspaceProviderOfferings.setup` through `withIdleSuspendPolicy`.
const providerSetup = {
  provider: "hetzner",
  credentialFingerprint: "sha256:9f2c",
  currency: "EUR",
  pricing: "provider-rate",
  pricingObservedAt: 1_795_000_200_000,
  sources: [{ id: "ubuntu-24.04", kind: "image", label: "Ubuntu 24.04", description: "The TerminalX runtime is installed on first start." }],
  locations: [{ id: "fsn1", label: "Falkenstein", placement: "selected" }, { id: "hel1", label: "Helsinki", placement: "selected" }],
  machineClasses: [{ id: "cx32", label: "CX32", vcpu: 4, memoryMiB: 8192, diskGiB: 80, activeHourlyMicros: 11_300 }, { id: "cx42", label: "CX42", vcpu: 8, memoryMiB: 16_384, diskGiB: 160 }],
  defaults: selection,
  allowedIdleSuspendMinutes: [5, 10, 15, 30, 60],
  allowedRetentionDays: [7, 30, 90],
  maxIdleSuspendMinutes: 60,
};
// `quoteProvider`.
const quote = {
  id: "quote_5b1e",
  provider: "hetzner",
  expiresAt: 1_795_000_500_000,
  currency: "EUR",
  pricing: "provider-rate",
  pricingObservedAt: 1_795_000_200_000,
  activeHourlyMicros: 11_300,
  alwaysOnThirtyDayMicros: 8_136_000,
  estimatedSuspendedMonthlyMicros: 8_136_000,
  configuration: { ...selection, sourceLabel: "Ubuntu 24.04", locationLabel: "Falkenstein", machineClassLabel: "CX32", vcpu: 4, memoryMiB: 8192, diskGiB: 80, architecture: "x86_64" },
};

// `workspaceResponse` and `operationResponse` for a create just queued (202).
const createdWorkspace = { id: "ws-9", orgId: "org-1", name: "fix-login", provider: "hetzner", state: "provisioning", accessMode: "organization", createdAt: 1_795_000_300_000, updatedAt: 1_795_000_300_000 };
const createOperation = { id: "op-9", workspaceId: "ws-9", type: "create", state: "queued", stage: "queued", cancelable: true, createdAt: 1_795_000_300_000, updatedAt: 1_795_000_300_000 };
const created = { workspace: createdWorkspace, operation: createOperation };

// `credentialResponseFor`.
const codexLogin = { id: "cred_codex", provider: "codex", authKind: "oauth-credentials-json", fingerprint: "sha256:41aa", displayIdentity: "dev@example.com", version: 3, updatedAt: 1_795_000_400_000, state: "connected", sharedUse: "organization", epoch: 2 };
const claudeKey = { id: "cred_claude", provider: "claude", authKind: "api-key", fingerprint: "sha256:77b0", version: 1, updatedAt: 1_795_000_400_000, state: "connected", sharedUse: "organization", epoch: 0 };

const CONSENT = { organizationSharing: true, machineInstallation: true } as const;
const ACCEPTED = { providerBilling: true, organizationUse: true } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compute providers", () => {
  it("lists the providers in the server's order, with the connection only an admin is shown", async () => {
    const { client, calls } = api(() => ({ body: { providers: [platformProvider, connectedProvider] } }));
    const providers = await client.providers("org-1");
    expect(calls).toEqual([expect.objectContaining({ method: "GET", url: `${ORG}/cloud-providers`, body: undefined })]);
    expect(calls[0].headers).toMatchObject({ authorization: "Bearer access-token", "X-TerminalX-Cloud-Workspace-Lifecycle": "archive-v1" });
    expect(providers.map((provider) => [provider.id, provider.availability, provider.descriptor.credentialSource, provider.descriptor.credentialFields.length])).toEqual([
      ["terminalx-cloud", "available", "platform", 0],
      ["hetzner", "available", "organization", 1],
    ]);
    expect(providers[0].connection).toBeUndefined();
    expect(providers[1].connection).toEqual({ state: "connected", connectedAt: 1_795_000_000_000, lastValidatedAt: 1_795_000_100_000, credentialFingerprint: "sha256:9f2c" });
    expect(providers[1].descriptor.credentialFields[0]).toEqual({ name: "credential", kind: "secret", label: "Hetzner API token", helpUrl: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token" });

    const member = await api(() => ({ body: { providers: [memberProvider] } })).client.providers("org-1");
    expect(member[0]).toMatchObject({ availability: "not-connected", canManage: false });
    expect(member[0].connection).toBeUndefined();
  });

  it("treats a credential field of a kind it does not know as a secret", async () => {
    const odd = { ...connectedProvider, descriptor: { ...hetznerDescriptor, credentialFields: [{ name: "credential", kind: "passphrase", label: "Passphrase" }] } };
    const providers = await api(() => ({ body: { providers: [odd] } })).client.providers("org-1");
    expect(providers[0].descriptor.credentialFields[0].kind).toBe("secret");
  });

  it("connects with the key and the accepted disclosure, in exactly the keys the server's parser takes", async () => {
    const { client, calls } = api(() => ({ body: connected }));
    expect(await client.connectProvider("org-1", "hetzner", { credential: "hcloud-key-1" }, ACCEPTED)).toEqual(connected);
    expect(calls).toEqual([
      expect.objectContaining({
        method: "POST",
        url: `${ORG}/cloud-providers/hetzner/connect`,
        body: { credential: "hcloud-key-1", disclosure: { version: PROVIDER_DISCLOSURE_VERSION, providerBillingAccepted: true, organizationUseAccepted: true } },
      }),
    ]);
    expect(PROVIDER_DISCLOSURE_VERSION).toBe("cloud-provider-connections-2026-08-13");
  });

  it("sends several credential fields as one JSON object, and nothing at all for an empty one", async () => {
    const { client, calls } = api(() => ({ body: { ...connected, provider: "agent37" } }));
    await client.connectProvider("org-1", "agent37", { apiKey: "k-1", accountId: "acct-7" }, ACCEPTED);
    expect(JSON.parse((calls[0].body as { credential: string }).credential)).toEqual({ apiKey: "k-1", accountId: "acct-7" });
    for (const fields of [{}, { credential: "" }] as Record<string, string>[]) {
      await expect(client.connectProvider("org-1", "agent37", fields, ACCEPTED)).rejects.toMatchObject({ code: "cloud_workspace_request_invalid", refusal: "invalid-request" });
    }
    expect(calls).toHaveLength(1);
  });

  it("disconnects with an empty body, and is told when the provider still holds machines", async () => {
    const { client, calls } = api(() => ({ body: disconnected }));
    expect(await client.disconnectProvider("org-1", "hetzner")).toMatchObject({ state: "not-connected", resources: [] });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-providers/hetzner/disconnect`, body: {} });
    // The mobile route passes no disposition, so a provider with machines is refused.
    await expect(refused("cloud_provider_disposition_required", 409).client.disconnectProvider("org-1", "hetzner")).rejects.toMatchObject({ status: 409, refusal: "provider-has-machines" });
  });

  it("does not take an answer about another provider", async () => {
    const { client } = api(() => ({ body: { ...connected, provider: "box" } }));
    await expect(client.connectProvider("org-1", "hetzner", { credential: "k" }, ACCEPTED)).rejects.toMatchObject({ code: "cloud_workspace_invalid_response", refusal: "invalid-response" });
    await expect(client.disconnectProvider("org-1", "hetzner")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
  });
});

describe("launching a workspace", () => {
  it("reads what a provider offers", async () => {
    const { client, calls } = api(() => ({ body: providerSetup }));
    const setup = await client.providerSetup("org-1", "hetzner");
    expect(calls[0]).toMatchObject({ method: "GET", url: `${ORG}/cloud-workspaces/setup?provider=hetzner` });
    expect(setup).toEqual(providerSetup);
    // No cap set by the organization.
    const uncapped = await api(() => ({ body: { ...providerSetup, maxIdleSuspendMinutes: null } })).client.providerSetup("org-1", "hetzner");
    expect(uncapped.maxIdleSuspendMinutes).toBeNull();
    await expect(api(() => ({ body: { ...providerSetup, provider: "box" } })).client.providerSetup("org-1", "hetzner")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
  });

  it("asks for a quote with exactly the seven keys of a selection", async () => {
    const { client, calls } = api(() => ({ body: quote }));
    // A caller's object with more on it: only the selection is sent.
    const input = { provider: "hetzner", ...selection, networkPolicy: "relay-only" as const, label: "not for the server" };
    expect(await client.quote("org-1", input)).toEqual(quote);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-workspaces/quote` });
    expect(calls[0].body).toEqual({ provider: "hetzner", ...selection });
    // A provider with no estimate for a stopped machine leaves the field out.
    const { estimatedSuspendedMonthlyMicros: _omitted, ...bare } = quote;
    expect((await api(() => ({ body: bare })).client.quote("org-1", input)).estimatedSuspendedMonthlyMicros).toBeUndefined();
  });

  it("preflights a setup and reads each kind of check", async () => {
    const answer = {
      version: 1,
      ready: false,
      checks: [
        { kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "verified" },
        { kind: "repository", cloneUrl: "https://github.com/acme/private.git", status: "failed", errorCode: "cloud_workspace_repository_not_accessible", retryable: false },
        { kind: "credential", provider: "codex", credentialId: "cred_codex", status: "failed", errorCode: "cloud_workspace_credential_verification_unavailable", retryable: true },
        { kind: "agent-credential", status: "failed", errorCode: "cloud_workspace_agent_credential_required", retryable: false },
      ],
    };
    const { client, calls } = api(() => ({ body: answer }));
    const preflight = await client.preflight("org-1", { repositories: [{ cloneUrl: "https://github.com/acme/app.git", ref: "main" }, { cloneUrl: "https://github.com/acme/private.git" }], credentialIds: ["cred_codex"] });
    expect(preflight).toEqual(answer);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-workspaces/preflight` });
    expect(calls[0].body).toEqual({
      setup: {
        version: 1,
        credentialIds: ["cred_codex"],
        repositories: [
          { sourceProvider: "github", cloneUrl: "https://github.com/acme/app.git", ref: "main" },
          { sourceProvider: "github", cloneUrl: "https://github.com/acme/private.git" },
        ],
      },
    });
    // No repositories: the key is left out, since the server refuses an empty list.
    await client.preflight("org-1", { repositories: [], credentialIds: [] });
    expect(calls[1].body).toEqual({ setup: { version: 1, credentialIds: [] } });
  });

  it("creates with the idempotency key in its header and the person's confirmation in the body", async () => {
    const { client, calls } = api(() => ({ status: 202, body: created }));
    const answer = await client.createWorkspace("org-1", { name: "fix-login", quoteId: "quote_5b1e", confirmProviderSpend: true, setup: { credentialIds: ["cred_codex"] } }, "launch-7f3a");
    expect(answer.workspace).toMatchObject({ id: "ws-9", state: "provisioning" });
    expect(answer.operation).toEqual(createOperation);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-workspaces` });
    expect(calls[0].headers).toMatchObject({ "Idempotency-Key": "launch-7f3a", authorization: "Bearer access-token" });
    expect(calls[0].body).toEqual({ name: "fix-login", quoteId: "quote_5b1e", confirmProviderSpend: true, setup: { version: 1, credentialIds: ["cred_codex"] } });
    // Without a setup the key is not sent at all.
    await client.createWorkspace("org-1", { name: "empty", quoteId: "quote_5b1e", confirmProviderSpend: true }, "launch-7f3b");
    expect(calls[1].body).toEqual({ name: "empty", quoteId: "quote_5b1e", confirmProviderSpend: true });
  });

  it("retries a timed-out create with the same key, so the server answers with the first launch", async () => {
    const input = { name: "fix-login", quoteId: "quote_5b1e", confirmProviderSpend: true as const };
    const first = await timedOut((client) => client.createWorkspace("org-1", input, "launch-7f3a"));
    // No answer: the server may have started the machine.
    expect(first.error).toMatchObject({ code: "cloud_workspace_unavailable", status: null, reason: "timeout", refusal: "unreachable", unreachable: true });
    // The server keeps one launch per key and answers a repeat with it.
    const launches = new Map<string, unknown>();
    const { client, calls } = api((call) => {
      const key = call.headers["Idempotency-Key"]!;
      if (!launches.has(key)) launches.set(key, created);
      return { status: 202, body: launches.get(key) };
    });
    const retried = await client.createWorkspace("org-1", input, "launch-7f3a");
    const again = await client.createWorkspace("org-1", input, "launch-7f3a");
    expect([first.calls[0].headers["Idempotency-Key"], calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]]).toEqual(["launch-7f3a", "launch-7f3a", "launch-7f3a"]);
    expect(calls[0].body).toEqual(first.calls[0].body);
    expect(launches.size).toBe(1);
    expect(again.workspace.id).toBe(retried.workspace.id);
  });

  it("sends no create without a key the server would take", async () => {
    const { client, calls } = api(() => ({ status: 202, body: created }));
    for (const key of ["", "x".repeat(129), "launch\n7f3a", "launch-é"]) {
      await expect(client.createWorkspace("org-1", { name: "n", quoteId: "q", confirmProviderSpend: true }, key)).rejects.toMatchObject({ code: "cloud_workspace_request_invalid", refusal: "invalid-request" });
    }
    expect(calls).toEqual([]);
  });

  it("is told when a key was already used for another launch, and when the quote ran out", async () => {
    const input = { name: "n", quoteId: "q", confirmProviderSpend: true as const };
    await expect(refused("idempotency_key_reused", 409).client.createWorkspace("org-1", input, "k")).rejects.toMatchObject({ status: 409, refusal: "idempotency-key-reused" });
    await expect(refused("cloud_workspace_quote_expired", 410).client.createWorkspace("org-1", input, "k")).rejects.toMatchObject({ status: 410, refusal: "quote-expired" });
  });

  it("suspends and deletes with an empty body, and takes only an answer about that workspace", async () => {
    const running = { ...createdWorkspace, state: "ready" };
    // `operationResponse` with progress, as a queued suspend and a delete in cleanup report it.
    const suspending = { ...createOperation, id: "op-10", action: "suspend", stage: "queued", progress: { phase: "suspending" } };
    const deleting = { ...createOperation, id: "op-11", action: "delete", state: "running", stage: "cleanup", cancelable: false, progress: { phase: "releasing", retryAt: 1_795_000_900_000 }, cleanup: { complete: false, items: [{ kind: "provider-compute", state: "pending", expectedBy: 1_795_000_900_000 }, { kind: "runtime-credentials", state: "removed" }] } };
    const { client, calls } = api((call) => ({ status: 202, body: { workspace: running, operation: call.url.endsWith("/suspend") ? suspending : deleting } }));
    expect((await client.suspend("org-1", "ws-9")).operation).toEqual(suspending);
    expect((await client.deleteWorkspace("org-1", "ws-9")).operation).toEqual(deleting);
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ["POST", `${ORG}/cloud-workspaces/ws-9/suspend`, {}],
      ["POST", `${ORG}/cloud-workspaces/ws-9/delete`, {}],
    ]);
    await expect(client.suspend("org-1", "ws-other")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
    await expect(refused("cloud_workspace_manager_required", 403).client.deleteWorkspace("org-1", "ws-9")).rejects.toMatchObject({ refusal: "manager-required" });
    await expect(refused("cloud_workspace_operation_in_progress", 409).client.suspend("org-1", "ws-9")).rejects.toMatchObject({ refusal: "workspace-busy" });
  });
});

describe("operations", () => {
  // A create that is installing the runtime, then one that failed at the provider.
  const installing = { ...createOperation, state: "running", stage: "bootstrapping", lastProviderContactAt: 1_795_000_350_000, progress: { phase: "installing-runtime" }, events: [{ code: "operation-queued", occurredAt: 1_795_000_300_000 }, { code: "machine-allocation-started", occurredAt: 1_795_000_310_000 }, { code: "runtime-installation-started", occurredAt: 1_795_000_340_000 }] };
  const failed = { ...createOperation, state: "failed", stage: "creating-machine", cancelable: false, errorCode: "cloud_provider_permission_denied", providerErrorCode: "forbidden", detailCode: "provider_quota" };

  it("reads an operation's progress and its failure", async () => {
    const { client, calls } = api(() => ({ body: { workspace: createdWorkspace, operation: installing } }));
    const progress = await client.operation("org-1", "op-9");
    expect(calls[0]).toMatchObject({ method: "GET", url: `${ORG}/cloud-workspace-operations/op-9` });
    expect(progress.operation).toMatchObject({ state: "running", stage: "bootstrapping", progress: { phase: "installing-runtime" } });
    expect(progress.operation.events?.map((event) => event.code)).toEqual(["operation-queued", "machine-allocation-started", "runtime-installation-started"]);
    const ended = await api(() => ({ body: { workspace: { ...createdWorkspace, state: "attention-required" }, operation: failed } })).client.operation("org-1", "op-9");
    expect(ended.operation).toMatchObject({ state: "failed", errorCode: "cloud_provider_permission_denied", providerErrorCode: "forbidden", detailCode: "provider_quota" });
  });

  it("leaves the raw provisioning logs out of what it returns", async () => {
    const withLogs = { ...installing, logs: [{ source: "cloud-init", content: "raw machine output", occurredAt: 1_795_000_345_000 }] };
    const answer = await api(() => ({ body: { workspace: createdWorkspace, operation: withLogs } })).client.operation("org-1", "op-9");
    expect(JSON.stringify(answer.operation)).not.toContain("raw machine output");
    expect("logs" in answer.operation).toBe(false);
  });

  it("cancels an operation and reports where it stands", async () => {
    const { client, calls } = api(() => ({ body: { workspace: createdWorkspace, operation: { ...createOperation, state: "cancel-requested", cancelable: false, progress: { phase: "allocating" } } } }));
    expect((await client.cancelOperation("org-1", "op-9")).operation).toMatchObject({ state: "cancel-requested", cancelable: false });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-workspace-operations/op-9/cancel`, body: {} });
    await expect(refused("cloud_workspace_operation_not_found", 404).client.cancelOperation("org-1", "op-9")).rejects.toMatchObject({ status: 404, refusal: "operation-not-found" });
  });

  it("does not take an answer about another operation or organization", async () => {
    await expect(api(() => ({ body: { workspace: createdWorkspace, operation: { ...installing, id: "op-other" } } })).client.operation("org-1", "op-9")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
    await expect(api(() => ({ body: { workspace: { ...createdWorkspace, orgId: "org-2" }, operation: installing } })).client.operation("org-1", "op-9")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
    await expect(api(() => ({ body: { workspace: createdWorkspace, operation: { ...installing, workspaceId: "ws-other" } } })).client.cancelOperation("org-1", "op-9")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
  });
});

describe("agent logins", () => {
  it("lists the stored logins", async () => {
    const revoked = { ...claudeKey, state: "revoked", stateChangedAt: 1_795_000_450_000, configurerLeft: true };
    const { client, calls } = api(() => ({ body: { credentials: [codexLogin, revoked] } }));
    expect(await client.credentials("org-1")).toEqual([codexLogin, revoked]);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${ORG}/cloud-workspace-credentials` });
    await expect(refused("organization_admin_required", 403).client.credentials("org-1")).rejects.toMatchObject({ refusal: "admin-required" });
  });

  it("saves a login with both confirmations and a display identity that is a string or null", async () => {
    const { client, calls } = api(() => ({ body: claudeKey }));
    expect(await client.saveCredential("org-1", "claude", { authKind: "api-key", secret: "sk-ant-1" }, CONSENT)).toEqual(claudeKey);
    await client.saveCredential("org-1", "claude", { authKind: "api-key", secret: "sk-ant-1", displayIdentity: "Team key", sharedUse: "managers" }, CONSENT);
    expect(calls.map((call) => [call.method, call.url])).toEqual([["PUT", `${ORG}/cloud-workspace-credentials/claude`], ["PUT", `${ORG}/cloud-workspace-credentials/claude`]]);
    // `parseCredentialUpsert`: the five keys, `displayIdentity` present even when there is none, `sharedUse` only when chosen.
    expect(calls[0].body).toEqual({ authKind: "api-key", secret: "sk-ant-1", displayIdentity: null, confirmOrganizationSharing: true, confirmMachineInstallation: true });
    expect(calls[1].body).toEqual({ authKind: "api-key", secret: "sk-ant-1", displayIdentity: "Team key", sharedUse: "managers", confirmOrganizationSharing: true, confirmMachineInstallation: true });
    await expect(api(() => ({ body: codexLogin })).client.saveCredential("org-1", "claude", { authKind: "api-key", secret: "sk-ant-1" }, CONSENT)).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
  });

  it("is told why a login was not stored: rejected by the provider, or not checkable just now", async () => {
    const save = (client: CloudApi) => client.saveCredential("org-1", "claude", { authKind: "api-key", secret: "sk-ant-1" }, CONSENT);
    await expect(save(refused("cloud_workspace_credential_invalid", 422).client)).rejects.toMatchObject({ status: 422, refusal: "login-invalid", unreachable: false });
    await expect(save(refused("cloud_workspace_credential_verification_unavailable", 503).client)).rejects.toMatchObject({ status: 503, refusal: "login-check-unavailable", unreachable: true });
    await expect(save(refused("cloud_workspace_request_invalid", 422).client)).rejects.toMatchObject({ refusal: "invalid-request" });
  });

  it("deletes and revokes a login", async () => {
    const { client, calls } = api((call) => (call.method === "DELETE" ? { body: {} } : { body: { ...codexLogin, state: "revoked", stateChangedAt: 1_795_000_460_000, epoch: 3 } }));
    await expect(client.deleteCredential("org-1", "codex")).resolves.toBeUndefined();
    expect(await client.revokeCredential("org-1", "codex")).toMatchObject({ state: "revoked", epoch: 3 });
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ["DELETE", `${ORG}/cloud-workspace-credentials/codex`, undefined],
      ["POST", `${ORG}/cloud-workspace-credentials/codex/revoke`, {}],
    ]);
    await expect(refused("cloud_workspace_credential_in_use", 409).client.deleteCredential("org-1", "codex")).rejects.toMatchObject({ status: 409, refusal: "login-in-use" });
    await expect(refused("cloud_workspace_credential_required", 404).client.revokeCredential("org-1", "codex")).rejects.toMatchObject({ status: 404, refusal: "login-missing" });
  });

  // `agentCredentialConnectAttempts.start`: Codex's device codes and the attempt.
  const login = { deviceAuthId: "dev-auth-3c", userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/codex/device", intervalSeconds: 5, expiresInSeconds: 900, attemptId: "attempt_0b6f2c1e-7a54-4d0a-9f11-2c3d4e5f6a7b" };

  it("starts a Codex device login", async () => {
    const { client, calls } = api(() => ({ body: login }));
    expect(await client.startCodexLogin("org-1")).toEqual(login);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-workspace-credentials/codex/device-start`, body: {} });
    await expect(refused("cloud_workspace_device_auth_unavailable", 503).client.startCodexLogin("org-1")).rejects.toMatchObject({ status: 503, refusal: "device-login-unavailable" });
    // Where the person is sent is only ever an https address.
    await expect(api(() => ({ body: { ...login, verificationUri: "javascript:alert(1)" } })).client.startCodexLogin("org-1")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
  });

  it("polls a device login through each answer, and gets the stored login but never its tokens", async () => {
    const answers: unknown[] = [{ status: "pending" }, { status: "failed" }, { status: "expired" }, { status: "canceled" }, { status: "complete", credential: codexLogin }];
    let turn = 0;
    const { client, calls } = api(() => ({ body: answers[turn++] }));
    const seen = [];
    for (let index = 0; index < answers.length; index += 1) seen.push(await client.pollCodexLogin("org-1", login, CONSENT));
    expect(seen).toEqual(answers);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-workspace-credentials/codex/device-poll` });
    // `parseDevicePoll`: the code pair, the attempt and both confirmations, nothing else of what `start` answered.
    expect(calls[0].body).toEqual({ attemptId: login.attemptId, deviceAuthId: "dev-auth-3c", userCode: "ABCD-1234", confirmOrganizationSharing: true, confirmMachineInstallation: true });
    await expect(refused("cloud_workspace_device_auth_not_found", 404).client.pollCodexLogin("org-1", login, CONSENT)).rejects.toMatchObject({ status: 404, refusal: "device-login-not-found" });
    await expect(api(() => ({ body: { status: "complete", credential: claudeKey } })).client.pollCodexLogin("org-1", login, CONSENT)).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
    await expect(api(() => ({ body: { status: "complete" } })).client.pollCodexLogin("org-1", login, CONSENT)).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
  });

  it("cancels a device login and reports where the attempt ended", async () => {
    const { client, calls } = api(() => ({ body: { status: "canceled" } }));
    expect(await client.cancelCodexLogin("org-1", login)).toBe("canceled");
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORG}/cloud-workspace-credentials/codex/device-cancel` });
    expect(calls[0].body).toEqual({ attemptId: login.attemptId, deviceAuthId: "dev-auth-3c", userCode: "ABCD-1234" });
    // The sign-in finished first: the cancel is told so.
    expect(await api(() => ({ body: { status: "connected" } })).client.cancelCodexLogin("org-1", login)).toBe("connected");
  });
});

describe("refusals, as kinds a screen has words for", () => {
  // Each code these routes answer with (terminalx-saas `CloudWorkspaceError` throws reached from
  // `cloudMachineAdmin`, and the mobile auth middleware), at the status the server sends it.
  const SERVER_REFUSALS: [string, number, CloudRefusal][] = [
    ["unauthorized", 401, "signed-out"],
    ["organization_admin_required", 403, "admin-required"],
    ["active_organization_required", 403, "admin-required"],
    ["cloud_workspace_manager_required", 403, "manager-required"],
    ["cloud_workspace_not_found", 404, "not-found"],
    ["cloud_provider_not_found", 404, "not-found"],
    ["cloud_provider_connection_required", 409, "provider-not-connected"],
    ["machine0_connection_required", 409, "provider-not-connected"],
    ["cloud_provider_connection_attention_required", 409, "provider-needs-attention"],
    ["cloud_provider_credential_invalid", 422, "provider-key-invalid"],
    ["cloud_provider_account_mismatch", 422, "provider-key-other-account"],
    ["cloud_provider_permission_denied", 422, "provider-permission-denied"],
    ["cloud_provider_billing_required", 503, "provider-billing-required"],
    ["cloud_provider_disabled", 403, "provider-not-offered"],
    ["cloud_provider_creation_disabled", 409, "provider-not-offered"],
    ["cloud_workspace_provider_unsupported", 422, "provider-not-offered"],
    ["cloud_provider_disposition_required", 409, "provider-has-machines"],
    ["cloud_provider_operation_in_progress", 409, "provider-busy"],
    ["cloud_provider_rate_limited", 429, "provider-rate-limited"],
    ["cloud_provider_unavailable", 503, "provider-unavailable"],
    ["cloud_provider_invalid_response", 502, "provider-unavailable"],
    ["cloud_workspace_runtime_not_ready", 503, "provider-unavailable"],
    ["terminalx_pro_required", 402, "plan-required"],
    ["cloud_workspace_quota_exceeded", 409, "limit-reached"],
    ["cloud_workspace_concurrency_exceeded", 409, "limit-reached"],
    ["cloud_workspace_member_concurrency_exceeded", 409, "limit-reached"],
    ["cloud_workspace_create_budget_exceeded", 409, "limit-reached"],
    ["cloud_provisioning_paused", 409, "provisioning-paused"],
    ["cloud_workspace_policy_denied", 422, "policy-denied"],
    ["cloud_workspace_quote_expired", 410, "quote-expired"],
    ["cloud_environment_changed", 409, "quote-expired"],
    ["idempotency_key_reused", 409, "idempotency-key-reused"],
    ["cloud_workspace_operation_in_progress", 409, "workspace-busy"],
    ["cloud_workspace_active_work", 409, "workspace-busy"],
    ["cloud_workspace_archived", 409, "workspace-archived"],
    ["cloud_workspace_operation_not_found", 404, "operation-not-found"],
    ["cloud_workspace_credential_required", 409, "login-missing"],
    ["cloud_workspace_agent_credential_required", 422, "login-missing"],
    ["cloud_workspace_credential_invalid", 422, "login-invalid"],
    ["cloud_agent_credential_reauth_required", 422, "login-invalid"],
    ["cloud_workspace_credential_in_use", 409, "login-in-use"],
    ["cloud_workspace_credential_verification_unavailable", 503, "login-check-unavailable"],
    ["cloud_workspace_repository_credential_required", 422, "repository-login-required"],
    ["cloud_workspace_repository_not_accessible", 422, "repository-not-accessible"],
    ["cloud_workspace_repository_ref_not_found", 422, "repository-not-accessible"],
    ["cloud_workspace_github_installation_unavailable", 422, "repository-not-accessible"],
    ["cloud_workspace_repository_verification_unavailable", 503, "repository-check-unavailable"],
    ["cloud_workspace_device_auth_unavailable", 503, "device-login-unavailable"],
    ["cloud_workspace_device_auth_not_found", 404, "device-login-not-found"],
    ["cloud_workspace_rate_limited", 429, "rate-limited"],
    ["cloud_workspace_request_invalid", 422, "invalid-request"],
  ];

  it.each(SERVER_REFUSALS)("%s (%i) is %s", async (code, status, refusal) => {
    const error = await refused(code, status).client.createWorkspace("org-1", { name: "n", quoteId: "q", confirmProviderSpend: true }, "k").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({ code, status, refusal });
  });

  it("keeps a code it does not know, as unknown, or as unreachable when the service could not answer", async () => {
    await expect(refused("cloud_something_new", 409).client.providers("org-1")).rejects.toMatchObject({ code: "cloud_something_new", refusal: "unknown" });
    await expect(refused("cloud_something_new", 503).client.providers("org-1")).rejects.toMatchObject({ code: "cloud_something_new", refusal: "unreachable" });
    // An error that is not the service's JSON, or whose code is not a plain token.
    await expect(api(() => ({ status: 502, text: "<html>Bad gateway</html>" })).client.providers("org-1")).rejects.toMatchObject({ code: "cloud_workspace_unavailable", reason: "unreadable", refusal: "unreachable" });
    await expect(api(() => ({ status: 422, body: { error: "<b>bad</b>" } })).client.providers("org-1")).rejects.toMatchObject({ code: "cloud_workspace_unavailable", refusal: "unreachable" });
  });

  it("sends nothing while signed out", async () => {
    const { client, calls } = api(() => ({ body: {} }), null);
    await expect(client.connectProvider("org-1", "hetzner", { credential: "k" }, ACCEPTED)).rejects.toMatchObject({ code: "account_signed_out", refusal: "signed-out" });
    await expect(client.saveCredential("org-1", "claude", { authKind: "api-key", secret: "s" }, CONSENT)).rejects.toMatchObject({ refusal: "signed-out" });
    expect(calls).toEqual([]);
  });
});

describe("timeouts and answers it cannot read", () => {
  const login = { attemptId: "attempt_0b6f2c1e-7a54-4d0a-9f11-2c3d4e5f6a7b", deviceAuthId: "dev-auth-3c", userCode: "ABCD-1234" };
  const CALLS: [string, (client: CloudApi) => Promise<unknown>][] = [
    ["providers", (client) => client.providers("org-1")],
    ["connectProvider", (client) => client.connectProvider("org-1", "hetzner", { credential: "k" }, ACCEPTED)],
    ["disconnectProvider", (client) => client.disconnectProvider("org-1", "hetzner")],
    ["providerSetup", (client) => client.providerSetup("org-1", "hetzner")],
    ["quote", (client) => client.quote("org-1", { provider: "hetzner", ...selection, networkPolicy: "relay-only" })],
    ["preflight", (client) => client.preflight("org-1", { credentialIds: [] })],
    ["createWorkspace", (client) => client.createWorkspace("org-1", { name: "n", quoteId: "q", confirmProviderSpend: true }, "k")],
    ["suspend", (client) => client.suspend("org-1", "ws-9")],
    ["deleteWorkspace", (client) => client.deleteWorkspace("org-1", "ws-9")],
    ["operation", (client) => client.operation("org-1", "op-9")],
    ["cancelOperation", (client) => client.cancelOperation("org-1", "op-9")],
    ["credentials", (client) => client.credentials("org-1")],
    ["saveCredential", (client) => client.saveCredential("org-1", "claude", { authKind: "api-key", secret: "s" }, CONSENT)],
    ["revokeCredential", (client) => client.revokeCredential("org-1", "codex")],
    ["startCodexLogin", (client) => client.startCodexLogin("org-1")],
    ["pollCodexLogin", (client) => client.pollCodexLogin("org-1", login, CONSENT)],
    ["cancelCodexLogin", (client) => client.cancelCodexLogin("org-1", login)],
    ["deleteCredential", (client) => client.deleteCredential("org-1", "codex")],
  ];

  it.each(CALLS)("%s says a timeout as one, sent once", async (_name, run) => {
    const { error, calls } = await timedOut(run);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({ code: "cloud_workspace_unavailable", status: null, reason: "timeout", refusal: "unreachable" });
    expect(calls).toHaveLength(1);
  });

  it.each(CALLS)("%s tells a dropped connection from a timeout", async (_name, run) => {
    const client = new CloudApi({ origin: ORIGIN, accessToken: async () => "access-token", fetch: (async () => { throw new TypeError("Network request failed"); }) as never });
    await expect(run(client)).rejects.toMatchObject({ code: "cloud_workspace_unavailable", status: null, reason: "network", refusal: "unreachable" });
  });

  // `deleteCredential` reads nothing from its answer.
  it.each(CALLS.slice(0, -1))("%s reports an answer in a shape it does not know as one code", async (_name, run) => {
    for (const body of [{}, { providers: "no" }, [], { status: "brand-new" }]) {
      const error = await run(api(() => ({ status: 200, body })).client).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CloudApiError);
      expect(error).toMatchObject({ code: "cloud_workspace_invalid_response", refusal: "invalid-response", unreachable: false });
    }
  });
});

describe("a key or token is sent once and never kept", () => {
  const PROVIDER_KEY = "hcloud-SECRET-4f9a1c7e2b";
  const AGENT_KEY = "sk-ant-SECRET-8d3e5a6f10";
  const OAUTH_JSON = JSON.stringify({ tokens: { access_token: "oauth-SECRET-access-77c1", refresh_token: "oauth-SECRET-refresh-52be" } });
  const SECRETS = [PROVIDER_KEY, AGENT_KEY, "oauth-SECRET-access-77c1", "oauth-SECRET-refresh-52be"];

  // Everything a log line, saved state or a support report could be made from.
  const everythingOf = (value: unknown): string => {
    const parts = [inspect(value, { depth: Infinity, showHidden: true, getters: true, maxArrayLength: null, maxStringLength: null, breakLength: Infinity })];
    try {
      parts.push(JSON.stringify(value) ?? "");
    } catch {
      // Not serializable: `inspect` has it.
    }
    if (value instanceof Error) parts.push(String(value), value.message, value.stack ?? "", inspect((value as { cause?: unknown }).cause, { depth: Infinity }));
    return parts.join("\n");
  };

  it("leaves no secret in logs, in the client, in what it returns or in what it throws", async () => {
    const logged: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));

    // How the server could answer a request that carried a secret, including a
    // faulty one that echoes it back in every place an answer has.
    const echo = { credential: PROVIDER_KEY, secret: AGENT_KEY, raw: OAUTH_JSON };
    const outcomes: ((call: Call) => Answer | Promise<Answer>)[] = [
      (call) => ({ body: call.url.includes("cloud-providers") ? connected : call.url.endsWith("/device-poll") ? { status: "complete", credential: codexLogin } : call.url.endsWith("/codex") ? codexLogin : claudeKey }),
      (call) => ({ body: call.url.includes("cloud-providers") ? { ...connected, ...echo, resources: [{ id: "r", name: "fix-login", state: "ready", kind: "workspace", cleanupRequired: false, currency: "EUR", activeHourlyMicros: null, suspendedMonthlyMicros: null, releaseDisposition: null, operationState: null, token: PROVIDER_KEY }] } : call.url.endsWith("/device-poll") ? { ...echo, status: "complete", credential: { ...codexLogin, ...echo } } : { ...(call.url.endsWith("/codex") ? codexLogin : claudeKey), ...echo } }),
      () => ({ status: 422, body: { error: "cloud_provider_credential_invalid", ...echo, detail: `rejected ${PROVIDER_KEY} ${AGENT_KEY} ${OAUTH_JSON}` } }),
      () => ({ status: 422, body: { error: `${PROVIDER_KEY} ${AGENT_KEY}` } }),
      // A secret that reads as a plain code, whole or inside one.
      (call) => ({ status: 400, body: { error: plainSecretOf(call) } }),
      (call) => ({ status: 400, body: { error: `rejected_${plainSecretOf(call)}` } }),
      () => ({ status: 502, text: `<html>${PROVIDER_KEY} ${AGENT_KEY} ${OAUTH_JSON}</html>` }),
      () => ({ status: 200, body: { unexpected: [PROVIDER_KEY, AGENT_KEY, OAUTH_JSON] } }),
      () => ({ status: 200, text: `not json ${PROVIDER_KEY} ${AGENT_KEY} ${OAUTH_JSON}` }),
      () => Promise.reject(new Error(`connect ECONNRESET while sending ${PROVIDER_KEY} ${AGENT_KEY} ${OAUTH_JSON}`)),
    ];
    const login = { attemptId: "attempt_0b6f2c1e-7a54-4d0a-9f11-2c3d4e5f6a7b", deviceAuthId: "dev-auth-3c", userCode: "ABCD-1234" };
    // The secret this request carried, in a form that passes for a code (a poll carries none).
    function plainSecretOf(call: Call): string {
      const body = call.body as { credential?: string; secret?: string };
      if (body.credential) return PROVIDER_KEY;
      if (body.secret) return body.secret === OAUTH_JSON ? "oauth-SECRET-access-77c1" : body.secret;
      return "cloud_workspace_request_invalid";
    }
    const sends: ((client: CloudApi) => Promise<unknown>)[] = [
      (client) => client.connectProvider("org-1", "hetzner", { credential: PROVIDER_KEY }, ACCEPTED),
      (client) => client.connectProvider("org-1", "hetzner", { apiKey: PROVIDER_KEY, accountId: "acct-7" }, ACCEPTED),
      (client) => client.saveCredential("org-1", "claude", { authKind: "api-key", secret: AGENT_KEY }, CONSENT),
      (client) => client.saveCredential("org-1", "codex", { authKind: "oauth-credentials-json", secret: OAUTH_JSON, displayIdentity: "dev@example.com" }, CONSENT),
      (client) => client.pollCodexLogin("org-1", login, CONSENT),
    ];

    const kept: unknown[] = [];
    let sent = 0;
    for (const outcome of outcomes) {
      for (const send of sends) {
        const { client, calls } = api(outcome);
        kept.push(await send(client).catch((error: unknown) => error), client);
        // The secret did go out, once, in the body of the one request.
        expect(calls).toHaveLength(1);
        sent += 1;
      }
    }
    // And when the server never answers.
    for (const send of sends) {
      const { error, calls } = await timedOut(send);
      kept.push(error);
      expect(calls).toHaveLength(1);
    }
    expect(sent).toBe(outcomes.length * sends.length);

    const everything = [...kept.map(everythingOf), everythingOf(logged)].join("\n");
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    // The check can see a secret when one is there.
    expect(everythingOf(new CloudApiError(AGENT_KEY, 400))).toContain(AGENT_KEY);
    expect(everythingOf({ deep: [{ token: PROVIDER_KEY }] })).toContain(PROVIDER_KEY);
    // What the screens do get is the login's public description.
    expect(kept.filter((value) => !(value instanceof Error) && !(value instanceof CloudApi)).length).toBeGreaterThan(0);
    expect(everything).toContain("sha256:9f2c");
  });

  it("keeps the secret out of the request line and headers: it travels in the body only", async () => {
    const { client, calls } = api((call) => ({ body: call.url.includes("cloud-providers") ? connected : claudeKey }));
    await client.connectProvider("org-1", "hetzner", { credential: PROVIDER_KEY }, ACCEPTED);
    await client.saveCredential("org-1", "claude", { authKind: "api-key", secret: AGENT_KEY }, CONSENT);
    for (const call of calls) {
      expect(call.url).not.toMatch(/SECRET/);
      expect(JSON.stringify(call.headers)).not.toMatch(/SECRET/);
    }
    expect((calls[0].body as { credential: string }).credential).toBe(PROVIDER_KEY);
    expect((calls[1].body as { secret: string }).secret).toBe(AGENT_KEY);
  });
});
