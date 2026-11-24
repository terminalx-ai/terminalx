import type { SetupHandler, SetupRequest } from "./types";

/**
 * The fixture's answers for launch progress, stop and delete (25.05 progress
 * and failures, 25.06). The state is the launch argument `fixtureWorkspace`;
 * without it nothing here answers. Every name, provider and code is a
 * placeholder, as the boards' own examples are.
 *
 * | `fixtureWorkspace` | What the service answers |
 * | --- | --- |
 * | `launch-queued`, `launch-creating`, `launch-installing` | A launch at that stage ("Checkout redesign", `ws-launch`) |
 * | `launch-running` | The launch at its last stage, then done on the next read |
 * | `launch-canceling`, `launch-canceled` | A canceled launch cleaning up, then canceled with the machine removed |
 * | `launch-runtime`, `launch-key`, `launch-timeout` | A launch that failed installing the runtime, on the provider's key, or taking too long |
 * | `launch-offline` | The launch, then no network on the next read |
 * | `manage-running`, `manage-working` | "Checkout redesign" running (an agent in a turn, for `-working`); Stop is accepted and stays under way |
 * | `manage-busy` | The same, and Stop is refused: something else is under way |
 * | `manage-failed-stop` | A stop that did not go through: the provider could not be reached |
 * | `manage-provider-refused` | A delete the provider refused, with its cleanup report |
 * | `manage-being-deleted` | "Checkout redesign" being deleted in the list |
 * | `manage-old-link` | `ws-gone`, deleted: only its tombstone is listed |
 * | `delete-pending`, `delete-active-work`, `delete-busy`, `delete-offline` | Delete gets no answer, is refused (an agent is working, something else is under way), or finds no network |
 * | `manage-stopped`, `manage-not-manager` | The fixture's own list; only the provider is answered here |
 */

const MINUTE = 60_000;
const ACME = "org-acme";
const LAUNCH = "ws-launch";
const CHECKOUT = "ws-checkout";
const never = new Promise<never>(() => undefined);
const offline = () => Promise.reject(new TypeError("Network request failed"));

/** The provider as the server describes it: Boat, with its own billing line. */
const BOAT = {
  id: "box", displayName: "Boat", availability: "available", canManage: true,
  connection: { state: "connected", connectedAt: Date.now() - 30 * 24 * 60 * MINUTE },
  descriptor: {
    id: "box", label: "Boat", icon: "box", order: 1, description: "Fast-start sandboxes that sleep when idle. Part of the disk resets on resume.", billing: "Per second, billed by Boat.", billedByProvider: true, listed: true,
    credentialSource: "organization", credentialFields: [{ name: "apiKey", kind: "secret", label: "API key" }],
    capabilities: { pauseResumeWithMemory: true, stopStart: true, snapshots: true, exec: true, computeRunsUntilStopped: true },
    offering: { locations: "automatic", sources: "image", machineClasses: "fixed", pricingSource: "provider", suspendedBilling: "none" },
    allowedIdleSuspendMinutes: [5, 10, 15, 30, 60], allowedRetentionDays: [7, 30],
  },
};

function workspace(id: string, name: string, state: string, fields: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id, orgId: ACME, name, provider: "box", providerDescriptor: { label: "Boat" }, state, accessMode: "organization",
    you: { role: "manager", canApprove: true, canManageShares: true }, sharedWith: 0, createdBy: "fixture", lastActivityAt: now,
    runtimeActivity: state === "ready" ? { online: true, activeTurns: 0, pendingApprovals: 0, reportedAt: now, stale: false } : null,
    repositories: [{ identity: "acme/app", fullName: "acme/app", primary: true }],
    launch: { workBranch: "checkout-redesign", sessionId: `${id}-session`, tabId: `${id}-tab`, phase: state === "ready" ? "ready" : null },
    ...fields,
  };
}

function operation(id: string, workspaceId: string, fields: Record<string, unknown>) {
  const now = Date.now();
  return { id, workspaceId, type: "create", state: "running", stage: "queued", cancelable: true, createdAt: now - 2 * MINUTE, updatedAt: now, ...fields };
}

const at = (minutes: number) => Date.now() - minutes * MINUTE;
const events = (...codes: string[]) => codes.map((code, index) => ({ code, occurredAt: at(codes.length - index) }));

/** Each launch state: the workspace and its create operation as the operation route answers them. */
const LAUNCHES: Record<string, { state: string; operation: Record<string, unknown> }> = {
  "launch-queued": { state: "provisioning", operation: { state: "queued", stage: "queued", events: events("operation-queued") } },
  "launch-creating": { state: "provisioning", operation: { stage: "creating-machine", events: events("operation-queued", "provider-preflight-started", "machine-allocation-started") } },
  "launch-installing": { state: "provisioning", operation: { stage: "bootstrapping", cancelable: false, events: events("operation-queued", "provider-preflight-started", "machine-allocation-started", "runtime-installation-started", "repository-cloning") } },
  "launch-running": { state: "provisioning", operation: { stage: "connecting-relay", cancelable: false, events: events("operation-queued", "provider-preflight-started", "machine-allocation-started", "runtime-installation-started", "relay-connection-started") } },
  "launch-canceling": { state: "provisioning", operation: { state: "cancel-requested", stage: "cleanup", cancelable: false, events: events("operation-queued", "provider-preflight-started", "machine-allocation-started", "provider-cleanup-started") } },
  "launch-canceled": { state: "destroyed", operation: { state: "canceled", stage: "cleanup", cancelable: false, events: events("operation-queued", "provider-preflight-started", "machine-allocation-started", "provider-cleanup-started", "operation-canceled"), cleanup: { complete: true, items: [{ kind: "provider-compute", state: "removed" }] } } },
  "launch-runtime": { state: "attention-required", operation: { state: "failed", stage: "bootstrapping", cancelable: false, errorCode: "cloud_workspace_runtime_bootstrap_failed", reason: "attention-stopped", events: events("operation-queued", "provider-preflight-started", "machine-allocation-started", "runtime-installation-started", "operation-failed") } },
  "launch-key": { state: "attention-required", operation: { state: "failed", stage: "preflight", cancelable: false, errorCode: "cloud_provider_credential_invalid", events: events("operation-queued", "provider-preflight-started", "operation-failed") } },
  "launch-timeout": { state: "attention-required", operation: { state: "failed", stage: "creating-machine", cancelable: false, errorCode: "cloud_workspace_provisioning_timeout", events: events("operation-queued", "provider-preflight-started", "machine-allocation-started", "operation-failed") } },
  "launch-offline": { state: "provisioning", operation: { stage: "creating-machine", events: events("operation-queued", "provider-preflight-started", "machine-allocation-started") } },
};

/** The stop this phone was told is under way, and the failed one, and the delete the provider refused. */
const STOP_ID = "op-stop";
const DELETE_ID = "op-delete";
const REFUSED_DELETE = operation(DELETE_ID, CHECKOUT, {
  action: "delete", state: "failed", stage: "cleanup", cancelable: false, errorCode: "cloud_provider_permission_denied", providerErrorCode: "403",
  cleanup: { complete: false, items: [
    { kind: "runtime-credentials", state: "removed" },
    { kind: "client-attachments", state: "removed" },
    { kind: "provider-compute", state: "unconfirmed" },
    { kind: "provider-storage", state: "unconfirmed" },
    { kind: "workspace-content", state: "pending" },
  ] },
});

/** How many times the launch was read in this run: `launch-running` is done from the second read on. */
let launchReads = 0;

function launchAnswer(scenario: string) {
  const launch = LAUNCHES[scenario]!;
  const done = scenario === "launch-running" && launchReads > 1;
  const op = operation("op-launch", LAUNCH, done ? { state: "succeeded", stage: "ready", cancelable: false, events: [...(launch.operation.events as unknown[]), { code: "workspace-ready", occurredAt: Date.now() }] } : launch.operation);
  return { workspace: workspace(LAUNCH, "Checkout redesign", done ? "ready" : launch.state), operation: op };
}

/** Acme's workspaces for a state: the one it is about, and a stopped one beside it as the board draws. */
function acmeList(scenario: string) {
  const stopped = { workspace: workspace("ws-billing-export", "Billing export", "suspended", { lastActivityAt: at(2 * 24 * 60), repositories: [{ identity: "acme/api", fullName: "acme/api", primary: true }] }), latestOperation: null };
  const launch = LAUNCHES[scenario];
  if (launch) {
    const answer = launchAnswer(scenario);
    return [{ workspace: { ...answer.workspace, state: launch.state }, latestOperation: { id: answer.operation.id, state: launch.operation.state ?? "running", action: null, type: "create", errorCode: launch.operation.errorCode ?? null } }, stopped];
  }
  const checkout = (state: string, fields: Record<string, unknown> = {}, latestOperation: Record<string, unknown> | null = null) => ({ workspace: workspace(CHECKOUT, "Checkout redesign", state, fields), latestOperation });
  switch (scenario) {
    case "manage-working": return [checkout("ready", { runtimeActivity: { online: true, activeTurns: 1, pendingApprovals: 0, reportedAt: Date.now(), stale: false } }), stopped];
    case "manage-failed-stop": return [checkout("attention-required", {}, { id: STOP_ID, state: "failed", action: "suspend", type: "create", errorCode: "cloud_provider_unavailable" }), stopped];
    case "manage-provider-refused": return [checkout("attention-required", {}, { id: DELETE_ID, state: "failed", action: "delete", type: "create", errorCode: "cloud_provider_permission_denied" }), stopped];
    case "manage-being-deleted": return [checkout("deleting", {}, { id: DELETE_ID, state: "running", action: "delete", type: "create" }), stopped];
    case "manage-old-link": return [stopped];
    default: return [checkout("ready"), stopped];
  }
}

const base = (orgId: string) => `^/v1/mobile/orgs/${orgId}`;

export const handle: SetupHandler = (request: SetupRequest) => {
  const scenario = request.argument("fixtureWorkspace");
  if (!scenario) return undefined;
  const { method, path, json } = request;
  const org = /^\/v1\/mobile\/orgs\/([^/]+)\//.exec(path)?.[1];
  if (!org) return undefined;
  const orgId = decodeURIComponent(org);

  if (method === "GET" && new RegExp(`${base("[^/]+")}/cloud-providers$`).test(path)) return json(200, { providers: [BOAT] });
  // The fixture's own lists serve `manage-stopped` and `manage-not-manager`.
  if (scenario === "manage-stopped" || scenario === "manage-not-manager" || orgId !== ACME) return undefined;

  if (method === "GET" && new RegExp(`${base(ACME)}/cloud-workspaces$`).test(path)) {
    return json(200, { workspaces: acmeList(scenario), tombstones: scenario === "manage-old-link" ? [{ id: "ws-gone", orgId: ACME, deletedAt: at(60), expiresAt: Date.now() + 30 * 24 * 60 * MINUTE }] : [] });
  }

  // A running workspace's connection is not part of the fixture: it stays connecting.
  if (method === "POST" && /\/cloud-workspaces\/[^/]+\/open$/.test(path)) return never;

  const operationRead = /\/cloud-workspace-operations\/([^/]+)(\/cancel)?$/.exec(path);
  if (operationRead) {
    const id = decodeURIComponent(operationRead[1]!);
    if (id === "op-launch" && LAUNCHES[scenario]) {
      launchReads += 1;
      if (scenario === "launch-offline" && launchReads > 1) return offline();
      return json(200, launchAnswer(scenario));
    }
    if (id === STOP_ID) {
      const failed = scenario === "manage-failed-stop";
      return json(200, { workspace: workspace(CHECKOUT, "Checkout redesign", failed ? "attention-required" : "ready"), operation: operation(STOP_ID, CHECKOUT, { action: "suspend", state: failed ? "failed" : "running", stage: null, cancelable: false, progress: { phase: "suspending" }, ...(failed ? { errorCode: "cloud_provider_unavailable" } : {}) }) });
    }
    if (id === DELETE_ID) return json(200, { workspace: workspace(CHECKOUT, "Checkout redesign", "attention-required"), operation: REFUSED_DELETE });
    return json(404, { error: "cloud_workspace_operation_not_found" });
  }

  const lifecycle = /\/cloud-workspaces\/([^/]+)\/(suspend|delete)$/.exec(path);
  if (method === "POST" && lifecycle) {
    const [, id, action] = lifecycle;
    if (action === "suspend") {
      if (scenario === "manage-busy") return json(409, { error: "cloud_workspace_operation_in_progress" });
      return json(200, { workspace: workspace(decodeURIComponent(id!), "Checkout redesign", "ready"), operation: operation(STOP_ID, decodeURIComponent(id!), { action: "suspend", stage: null, cancelable: false, progress: { phase: "suspending" } }) });
    }
    if (scenario === "delete-active-work") return json(409, { error: "cloud_workspace_active_work" });
    if (scenario === "delete-busy") return json(409, { error: "cloud_workspace_operation_in_progress" });
    if (scenario === "delete-offline") return offline();
    // `delete-pending` and the rest: the answer has not come yet, so the page shows it sending.
    return never;
  }
  return undefined;
};
