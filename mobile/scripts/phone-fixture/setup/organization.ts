import type { SetupHandler } from "./types";

/**
 * The fixture's answers for first run and organizations (25.01, 25.02).
 * `fixtureSetup: <state>` (a launch argument) picks the account the boards
 * draw; without it this area answers nothing and the 22.06 list is shown.
 *
 * | `fixtureSetup` | The account |
 * | --- | --- |
 * | `first-run` | a personal organization, nothing connected |
 * | `half-way` | Boat connected, no agent login |
 * | `ready` | Boat connected, Codex signed in |
 * | `attention` | Boat rejected the stored key; Codex signed in |
 * | `unread` | the provider and login lists answer in a shape the app cannot read |
 * | `offline-later` | `half-way`, and the service stops answering 15 s after launch |
 * | `with-workspaces` | Northwind with two workspaces, and the personal one half-way |
 * | `member` | a member of Northwind, which has no compute, and the personal one |
 * | `several` | the personal one, Northwind (owner, compute connected) and Acme (member) |
 * | `begun-elsewhere` | Northwind with two workspaces, the personal one with nothing, and Demo with Boat and Codex connected |
 * | `no-route` | `first-run` on a server that does not take creation from a phone |
 *
 * `fixtureCreate: slow` answers a creation after 20 s, `fixtureCreate: fail`
 * never answers it (the connection fails); otherwise it is created and listed.
 */
const PERSONAL = { orgId: "org-personal", name: "Personal (alex@example.com)", role: "owner", isPersonal: true };
const NORTHWIND = (role: string) => ({ orgId: "org-northwind", name: "Northwind", role });
const ACME = { orgId: "org-acme", name: "Acme", role: "member" };
const DEMO = { orgId: "org-demo", name: "Demo", role: "owner" };

const MINUTE = 60_000;
const started = Date.now();
const created: { orgId: string; name: string; role: string }[] = [];

// The descriptors as the account service registers them (terminalx-saas `cloudWorkspaceProviders`).
function descriptor(id: string, label: string, icon: string, order: number, description: string, billing: string, field: string, credentialSource: "organization" | "platform" = "organization") {
  return {
    id, label, icon, order, description, billing, billedByProvider: credentialSource === "organization", listed: true, credentialSource,
    credentialFields: credentialSource === "organization" ? [{ name: "apiKey", kind: "secret", label: field }] : [],
    capabilities: { pauseResumeWithMemory: true, stopStart: true, snapshots: false, exec: true, computeRunsUntilStopped: false },
    offering: { locations: "provider", sources: "provider", machineClasses: "provider", pricingSource: "provider", suspendedBilling: "none" },
    allowedIdleSuspendMinutes: [15, 30, 60], allowedRetentionDays: [7, 30],
  };
}
const BOAT = descriptor("box", "Boat", "ship", 1, "Fast-start sandboxes that sleep when idle. Part of the disk resets on resume.", "Per second, billed by Boat", "Boat API token");
const AGENT37 = descriptor("agent37", "Agent37", "server", 2, "Full virtual machines with Docker in the US, France and India. Sleeps when idle.", "Per minute from your Agent37 wallet; only disk bills while asleep", "Agent37 API key");
const TERMINALX = descriptor("terminalx-cloud", "TerminalX Cloud", "cloud", 0, "Machines on TerminalX Cloud. Nothing to connect: they are ready to use.", "Billed by TerminalX", "", "platform");

type Compute = "none" | "connected" | "attention";
function providers(boat: Compute, canManage: boolean) {
  const connection = boat === "none" ? {} : { connection: { state: boat === "attention" ? "attention-required" : "connected", connectedAt: started - 3 * 24 * 60 * MINUTE, lastValidatedAt: started - MINUTE, credentialFingerprint: "fixture" } };
  return [
    { id: TERMINALX.id, displayName: TERMINALX.label, availability: "available", canManage, descriptor: TERMINALX },
    { id: BOAT.id, displayName: BOAT.label, availability: boat === "none" ? "not-connected" : boat === "attention" ? "attention-required" : "available", canManage, ...connection, descriptor: BOAT },
    { id: AGENT37.id, displayName: AGENT37.label, availability: "not-connected", canManage, descriptor: AGENT37 },
  ];
}
const codex = { id: "cred-codex", provider: "codex", authKind: "api-key", fingerprint: "fixture", displayIdentity: "alex@example.com", version: 1, updatedAt: started - 60 * MINUTE, state: "connected", sharedUse: "organization", epoch: 1 };

function workspace(orgId: string, id: string, name: string, state: string, idleMinutes: number, repository: string) {
  return {
    workspace: {
      // As the account service sends a workspace: its provider by id only. The row names it from the provider list (PRO-566).
      id, orgId, name, provider: "box", state, accessMode: "organization",
      you: { role: "manager", canApprove: true, canManageShares: true }, sharedWith: 0, createdBy: "fixture", lastActivityAt: Date.now() - idleMinutes * MINUTE,
      runtimeActivity: null, repositories: [{ identity: repository, fullName: repository, primary: true }],
    },
    latestOperation: null,
  };
}

interface Account { organizations: { orgId: string; name: string; role: string; isPersonal?: boolean }[]; compute: Record<string, Compute>; codex: string[]; workspaces: Record<string, unknown[]>; unread?: boolean; creates: boolean }
function account(state: string): Account | null {
  const base = { organizations: [PERSONAL], compute: {}, codex: [], workspaces: {}, creates: true } satisfies Account;
  switch (state) {
    case "first-run": return base;
    case "no-route": return { ...base, creates: false };
    case "half-way": case "offline-later": return { ...base, compute: { [PERSONAL.orgId]: "connected" } };
    case "ready": return { ...base, compute: { [PERSONAL.orgId]: "connected" }, codex: [PERSONAL.orgId] };
    case "attention": return { ...base, compute: { [PERSONAL.orgId]: "attention" }, codex: [PERSONAL.orgId] };
    case "unread": return { ...base, unread: true };
    case "with-workspaces": {
      const northwind = NORTHWIND("owner");
      return { ...base, organizations: [northwind, PERSONAL], compute: { [northwind.orgId]: "connected", [PERSONAL.orgId]: "connected" }, codex: [northwind.orgId],
        workspaces: { [northwind.orgId]: [workspace(northwind.orgId, "ws-checkout", "Checkout redesign", "provisioning", 0, "acme/app"), workspace(northwind.orgId, "ws-billing", "Billing export", "suspended", 2 * 24 * 60, "northwind/api")] } };
    }
    case "begun-elsewhere": {
      const northwind = NORTHWIND("owner");
      return { ...base, organizations: [northwind, PERSONAL, DEMO], compute: { [northwind.orgId]: "connected", [DEMO.orgId]: "connected" }, codex: [northwind.orgId, DEMO.orgId],
        workspaces: { [northwind.orgId]: [workspace(northwind.orgId, "ws-checkout", "Checkout redesign", "ready", 0, "acme/app"), workspace(northwind.orgId, "ws-billing", "Billing export", "suspended", 2 * 24 * 60, "northwind/api")] } };
    }
    case "member": return { ...base, organizations: [NORTHWIND("member"), PERSONAL] };
    case "several": return { ...base, organizations: [PERSONAL, NORTHWIND("owner"), ACME], compute: { "org-northwind": "connected" } };
    default: return null;
  }
}

export const handle: SetupHandler = async ({ method, path, body, headers, argument, json }) => {
  const state = argument("fixtureSetup");
  const held = state ? account(state) : null;
  if (!held) return undefined;
  // The phone lost its network after the page was read: nothing answers any more.
  if (state === "offline-later" && Date.now() - started > 15_000) throw new TypeError("Network request failed");
  if (path === "/v1/desktop/auth/capabilities") return json(200, { organizations: [...held.organizations, ...created], capabilities: { flags: held.creates ? { "organizations.create.mobile.v1": true } : {} } });
  if (path === "/v1/desktop/orgs" && method === "POST") {
    const name = body && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 60) return json(400, { error: "organization_name_invalid" });
    if (!headers.get("Idempotency-Key")) return json(400, { error: "organization_idempotency_key_invalid" });
    if (argument("fixtureCreate") === "fail") throw new TypeError("Network request failed");
    if (argument("fixtureCreate") === "slow") await new Promise((resolve) => setTimeout(resolve, 20_000));
    const organization = { orgId: `org-created-${created.length + 1}`, name, role: "owner" };
    created.push(organization);
    return json(201, { id: organization.orgId, name, role: "owner" });
  }
  const scoped = /^\/v1\/mobile\/orgs\/([^/]+)\/(cloud-workspaces|cloud-providers|cloud-workspace-credentials)$/.exec(path);
  if (!scoped || method !== "GET") return undefined;
  const orgId = decodeURIComponent(scoped[1]!);
  const organization = [...held.organizations, ...created].find((entry) => entry.orgId === orgId);
  if (!organization) return json(404, { error: "cloud_workspace_not_found" });
  const manages = organization.role !== "member";
  if (scoped[2] === "cloud-workspaces") return json(200, { workspaces: held.workspaces[orgId] ?? [], tombstones: [] });
  if (held.unread) return json(200, { unexpected: true });
  if (scoped[2] === "cloud-providers") return json(200, { providers: providers(held.compute[orgId] ?? "none", manages) });
  // Agent logins are their owners' and admins' to see.
  if (!manages) return json(403, { error: "organization_admin_required" });
  return json(200, { credentials: held.codex.includes(orgId) ? [codex] : [] });
};
