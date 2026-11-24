import type { SetupHandler } from "./types";

/**
 * The fixture's answers for the launch form, preflight, quote and create
 * (25.05 rows 1 to 4), all placeholders. `fixtureLaunch` (a launch argument)
 * picks the state; without it this area answers nothing, and the requests go
 * on to the other areas.
 *
 * | fixtureLaunch | What the server answers |
 * | --- | --- |
 * | `boat` | Boat alone, with Codex, Claude Code and GitHub logins; every check passes |
 * | `agent37` | Agent37 and Boat: Provider shows, Region is a picker |
 * | `tx` | TerminalX Cloud alone, which TerminalX bills |
 * | `reading` | What Boat offers is never answered |
 * | `connect` | No provider connected |
 * | `paused` | New workspaces paused (`disabled-for-create`) |
 * | `offline` | No network: nothing answers |
 * | `checking` | The preflight is never answered |
 * | `problems` | The repository needs a GitHub token and Codex needs signing in again |
 * | `private` | The repository needs a GitHub token |
 * | `branch` | The branch or tag is not in the repository |
 * | `expired` | The first quote has run out; a new one is $0.020 an hour |
 * | `launching` | The launch is never answered |
 */

const MINUTE = 60_000;
const never = new Promise<never>(() => undefined);
let quotes = 0;

const capabilities = { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: true };
function provider(id: string, label: string, icon: string, billing: string, billedByProvider: boolean, availability: string, locations: string) {
  return {
    id, displayName: label, availability, canManage: true,
    connection: availability === "not-connected" ? undefined : { state: "connected", connectedAt: Date.now() - 3 * 24 * 60 * MINUTE },
    descriptor: {
      id, label, icon, order: 10, description: "", billing, billedByProvider, listed: true,
      credentialSource: id === "terminalx-cloud" ? "platform" : "organization", credentialFields: [], capabilities,
      offering: { locations, sources: "none", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "none" },
      allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0], allowedRetentionDays: [7, 30],
    },
  };
}

const PROVIDERS: Record<string, ReturnType<typeof provider>[]> = {
  boat: [provider("box", "Boat", "ship", "Per second, billed by Boat", true, "available", "automatic")],
  agent37: [provider("agent37", "Agent37", "server", "Hourly, billed by Agent37", true, "available", "required"), provider("box", "Boat", "ship", "Per second, billed by Boat", true, "available", "automatic")],
  tx: [provider("terminalx-cloud", "TerminalX Cloud", "cloud", "Billed by TerminalX", false, "available", "automatic")],
  connect: [provider("box", "Boat", "ship", "Per second, billed by Boat", true, "not-connected", "automatic")],
  paused: [provider("box", "Boat", "ship", "Per second, billed by Boat", true, "disabled-for-create", "automatic")],
};

const BOAT_SIZES = [
  { id: "small", label: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, activeHourlyMicros: 18_000 },
  { id: "default", label: "Default", vcpu: 4, memoryMiB: 8192, diskGiB: 80, activeHourlyMicros: 36_000 },
  { id: "large", label: "Large", vcpu: 8, memoryMiB: 16384, diskGiB: 100, activeHourlyMicros: 72_000 },
];
function setup(providerId: string) {
  const common = { provider: providerId, credentialFingerprint: "fixture", currency: "USD", pricing: "provider-rate", pricingObservedAt: Date.now() - 5 * MINUTE, sources: [{ id: "ubuntu", kind: "image", label: "Ubuntu" }], allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0], allowedRetentionDays: [7, 30], maxIdleSuspendMinutes: null };
  if (providerId === "agent37") return {
    ...common,
    locations: [{ id: "us", label: "United States", placement: "selected" }, { id: "eu", label: "Europe", placement: "selected" }, { id: "sg", label: "Singapore", placement: "selected" }],
    machineClasses: [{ id: "2x4", label: "2 vCPU · 4 GB RAM", vcpu: 2, memoryMiB: 4096, diskGiB: 50 }, { id: "4x8", label: "4 vCPU · 8 GB RAM", vcpu: 4, memoryMiB: 8192, diskGiB: 100 }],
    defaults: { sourceId: "ubuntu", locationId: "us", machineClassId: "2x4", idleSuspendMinutes: 10, retentionDays: 7, networkPolicy: "relay-only" },
  };
  return {
    ...common,
    locations: [{ id: "auto-eu", label: providerId === "box" ? "Automatic EU placement" : "Frankfurt", placement: "automatic" }],
    machineClasses: providerId === "box" ? BOAT_SIZES : [{ id: "small", label: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 10, activeHourlyMicros: 18_000 }],
    defaults: { sourceId: "ubuntu", locationId: "auto-eu", machineClassId: "small", idleSuspendMinutes: 15, retentionDays: 7, networkPolicy: "relay-only" },
  };
}

const login = (id: string, kind: string, authKind: string, displayIdentity?: string) => ({ id, provider: kind, authKind, fingerprint: `fixture-${kind}`, ...(displayIdentity ? { displayIdentity } : {}), version: 1, updatedAt: Date.now() - 2 * 24 * 60 * MINUTE, state: "connected", sharedUse: "organization", epoch: 1 });
const LOGINS = [login("cred-codex", "codex", "oauth-credentials-json", "alex@example.com"), login("cred-claude", "claude", "api-key"), login("cred-github", "github", "personal-access-token", "alex-example")];

function preflight(scenario: string) {
  const repository = (errorCode?: string) => ({ kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: errorCode ? "failed" : "verified", ...(errorCode ? { errorCode, retryable: false } : {}) });
  const codex = (errorCode?: string) => ({ kind: "credential", provider: "codex", credentialId: "cred-codex", status: errorCode ? "failed" : "verified", ...(errorCode ? { errorCode, retryable: false } : {}) });
  if (scenario === "problems") return { version: 1, ready: false, checks: [repository("cloud_workspace_repository_credential_required"), codex("cloud_agent_credential_reauth_required")] };
  if (scenario === "private") return { version: 1, ready: false, checks: [repository("cloud_workspace_repository_credential_required"), codex()] };
  if (scenario === "branch") return { version: 1, ready: false, checks: [repository("cloud_workspace_repository_ref_not_found"), codex()] };
  return { version: 1, ready: true, checks: [repository(), codex()] };
}

function quote(scenario: string, input: Record<string, unknown>) {
  quotes += 1;
  const offered = setup(String(input.provider));
  const size = offered.machineClasses.find((entry) => entry.id === input.machineClassId) ?? offered.machineClasses[0]!;
  const location = offered.locations.find((entry) => entry.id === input.locationId) ?? offered.locations[0]!;
  // `expired`: the first price has already run out, and the next is higher.
  const first = scenario === "expired" && quotes === 1;
  const rated: number = (size as { activeHourlyMicros?: number }).activeHourlyMicros ?? 18_000;
  const hourly: number = scenario === "expired" && !first ? 20_000 : rated;
  return {
    id: `fixture-quote-${quotes}`, provider: input.provider, expiresAt: first ? Date.now() - 1_000 : Date.now() + 4 * MINUTE + 39_000,
    currency: "USD", pricing: "provider-rate", pricingObservedAt: Date.now() - 5 * MINUTE,
    activeHourlyMicros: hourly, alwaysOnThirtyDayMicros: hourly * 720,
    configuration: {
      sourceId: input.sourceId, locationId: location.id, machineClassId: size.id, idleSuspendMinutes: input.idleSuspendMinutes, retentionDays: input.retentionDays, networkPolicy: input.networkPolicy,
      sourceLabel: "Ubuntu", locationLabel: location.label, machineClassLabel: size.label, vcpu: size.vcpu, memoryMiB: size.memoryMiB, diskGiB: size.diskGiB, architecture: "x86_64",
    },
  };
}

export const handle: SetupHandler = (request) => {
  const scenario = request.argument("fixtureLaunch");
  if (!scenario) return undefined;
  const match = /^\/v1\/mobile\/orgs\/([^/]+)\/(cloud-providers|cloud-workspace-credentials|cloud-workspaces\/setup|cloud-workspaces\/preflight|cloud-workspaces\/quote|cloud-workspaces)$/.exec(request.path);
  if (!match) return undefined;
  const [, orgId, route] = match;
  // No network: the request never gets an answer back.
  if (scenario === "offline") return Promise.reject(new TypeError("Network request failed"));
  if (route === "cloud-providers" && request.method === "GET") return request.json(200, { providers: PROVIDERS[scenario] ?? PROVIDERS.boat });
  if (route === "cloud-workspace-credentials" && request.method === "GET") return request.json(200, { credentials: LOGINS });
  if (route === "cloud-workspaces/setup" && request.method === "GET") {
    if (scenario === "reading") return never;
    return request.json(200, setup(request.query.get("provider") ?? "box"));
  }
  if (route === "cloud-workspaces/preflight" && request.method === "POST") {
    if (scenario === "checking") return never;
    return request.json(200, preflight(scenario));
  }
  if (route === "cloud-workspaces/quote" && request.method === "POST") return request.json(200, quote(scenario, (request.body ?? {}) as Record<string, unknown>));
  if (route === "cloud-workspaces" && request.method === "POST") {
    if (scenario === "launching") return never;
    const body = (request.body ?? {}) as { name?: string };
    const now = Date.now();
    return request.json(201, {
      workspace: { id: "ws-launched", orgId: decodeURIComponent(orgId!), name: body.name ?? "", provider: "box", state: "provisioning", accessMode: "organization", you: { role: "manager", canApprove: true, canManageShares: true } },
      operation: { id: "op-launch", workspaceId: "ws-launched", type: "create", state: "queued", stage: null, cancelable: true, createdAt: now, updatedAt: now },
    });
  }
  return undefined;
};
