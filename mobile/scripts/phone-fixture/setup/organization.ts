import type { SetupHandler, SetupRequest } from "./types";

/**
 * The fixture's answers for first run and organizations (25.01, 25.02): the
 * account's organizations with the capability flags, each organization's
 * workspace list, and creating an organization. Every name here is
 * placeholder data for screenshots; the app draws whatever the server says.
 * The providers and agent logins the steps are read from are the compute and
 * logins areas' (`fixtureCompute`, `fixtureLogins`).
 *
 * Launch arguments:
 * - `fixtureFirstRun`: which account. `new`: the personal organization only.
 *   `several`: personal, Northwind (owner) and Acme (member). `no-route`: the
 *   personal one, from a server without the phone's create route. `member`:
 *   Northwind (member) and the personal one. `workspaces`: Northwind with two
 *   workspaces, and the personal one. `none`: no organization at all (an
 *   account made on the phone, PRO-524); `none-no-route`: the same from a
 *   server without the create route. `offline`: the personal one, and after
 *   the first few seconds the service can no longer be reached.
 *   Without it the fixture's own organizations answer (22.06).
 * - `fixtureCreate`: how a creation is answered. `ok` (default) after a short
 *   wait; `hold`: never; `network`: the request never leaves the phone.
 */

const MINUTE = 60_000;
const never = new Promise<never>(() => undefined);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PERSONAL = { orgId: "org-personal", name: "Personal (alex@example.com)", role: "owner", isPersonal: true };
const NORTHWIND_OWNER = { orgId: "org-northwind", name: "Northwind", role: "owner", isPersonal: false };
const NORTHWIND_MEMBER = { ...NORTHWIND_OWNER, role: "member" };
const ACME = { orgId: "org-acme", name: "Acme", role: "member", isPersonal: false };

type Organization = typeof PERSONAL;

const ACCOUNTS: Record<string, { organizations: Organization[]; creates: boolean }> = {
  new: { organizations: [PERSONAL], creates: true },
  several: { organizations: [PERSONAL, NORTHWIND_OWNER, ACME], creates: true },
  "no-route": { organizations: [PERSONAL], creates: false },
  member: { organizations: [NORTHWIND_MEMBER, PERSONAL], creates: true },
  workspaces: { organizations: [NORTHWIND_OWNER, PERSONAL], creates: true },
  none: { organizations: [], creates: true },
  "none-no-route": { organizations: [], creates: false },
  offline: { organizations: [PERSONAL], creates: true },
};

/** How long the service answers in the `offline` account before it can no longer be reached. */
const ONLINE_FOR_MS = 4_000;

const descriptor = { id: "box", label: "Boat", icon: "ship" };
function workspace(id: string, name: string, state: string, idleMinutes: number, repository: string) {
  const now = Date.now();
  return {
    workspace: {
      id, orgId: NORTHWIND_OWNER.orgId, name, provider: "box", providerDescriptor: descriptor, state, accessMode: "organization",
      you: { role: "manager", canApprove: true, canManageShares: true },
      sharedWith: 0, createdBy: "fixture", lastActivityAt: now - idleMinutes * MINUTE,
      runtimeActivity: null,
      repositories: [{ identity: repository, fullName: repository, primary: true }],
    },
    latestOperation: null,
  };
}

let account: string | null = null;
let organizations: Organization[] = [];
let firstAnswer: number | null = null;

function begin(name: string) {
  account = name;
  organizations = [...ACCOUNTS[name]!.organizations];
  firstAnswer = null;
}

export const handle: SetupHandler = (request) => {
  const name = request.argument("fixtureFirstRun");
  if (!name || !Object.hasOwn(ACCOUNTS, name)) return undefined;
  if (account !== name) begin(name);
  const { method, path } = request;
  if (path === "/v1/desktop/auth/capabilities") return capabilities(request, name);
  if (path === "/v1/desktop/orgs" && method === "POST") return create(request);
  const list = /^\/v1\/mobile\/orgs\/([^/]+)\/cloud-workspaces$/.exec(path);
  if (list && method === "GET") {
    const orgId = decodeURIComponent(list[1]!);
    const workspaces = name === "workspaces" && orgId === NORTHWIND_OWNER.orgId
      ? [workspace("ws-checkout", "Checkout redesign", "provisioning", 0, "acme/app"), workspace("ws-billing", "Billing export", "suspended", 2 * 24 * 60, "northwind/api")]
      : [];
    return request.json(200, { workspaces, tombstones: [] });
  }
  return undefined;
};

async function capabilities(request: SetupRequest, name: string): Promise<Response> {
  const now = Date.now();
  firstAnswer ??= now;
  // As fetch does when the phone is offline: the request never leaves.
  if (name === "offline" && now - firstAnswer > ONLINE_FOR_MS) throw new TypeError("Network request failed");
  const flags: Record<string, boolean> = { "organizations.delete.mobile.v1": true };
  if (ACCOUNTS[name]!.creates) flags["organizations.create.mobile.v1"] = true;
  return request.json(200, { organizations, capabilities: { flags } });
}

async function create(request: SetupRequest): Promise<Response> {
  const how = request.argument("fixtureCreate") ?? "ok";
  if (how === "hold") return never;
  if (how === "network") throw new TypeError("Network request failed");
  await pause(900);
  const body = (request.body ?? {}) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 60) return request.json(400, { error: "organization_name_invalid" });
  const key = request.headers.get("Idempotency-Key") ?? "";
  const orgId = `org-${key.slice(0, 8) || "new"}`;
  if (!organizations.some((entry) => entry.orgId === orgId)) organizations = [...organizations, { orgId, name, role: "owner", isPersonal: false }];
  return request.json(201, { id: orgId, name, role: "owner" });
}
