import type { SetupHandler, SetupRequest } from "./types";

/**
 * The fixture's answers for compute providers (25.03): the list, connect and
 * disconnect, held in memory for one launch. Every name, description, price
 * line and fingerprint here is placeholder data for screenshots; the app
 * draws whatever the list says.
 *
 * Launch arguments:
 * - `fixtureCompute`: what the list holds. `nothing` (default): three providers
 *   and none connected. `one`: the second one connected. `agent37`: the third
 *   connected. `attention`: the second one's stored key failed its last check.
 *   `described`: a provider with a text field and a secret field. `member`:
 *   the list as a member sees it. `none`: no providers. `reading`: the list is
 *   never answered. `unreadable`: the service cannot be reached.
 * - `fixtureConnect`: how a connect is answered. `ok` (default) after a short
 *   check; `checking`: never; `invalid`, `permission`, `billing`, `unavailable`:
 *   refused with the provider's code; `network`: the request never leaves.
 * - `fixtureDisconnect`: `ok` (default), or `refused` while the provider still holds workspaces.
 *
 * The credential a connect carries is never read, kept or logged here.
 */

const MINUTE = 60_000;
const FINGERPRINT = "sha256:9c41e07a";

const capabilities = { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false };
const base = {
  billedByProvider: true,
  listed: true,
  credentialSource: "organization",
  capabilities,
  offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "estimate", suspendedBilling: "none" },
  allowedIdleSuspendMinutes: [5, 15, 30, 60, 0],
  allowedRetentionDays: [7, 30],
};

const DESCRIPTORS = {
  "terminalx-cloud": { ...base, id: "terminalx-cloud", label: "TerminalX Cloud", icon: "cloud", order: 5, description: "Machines on TerminalX Cloud. Nothing to connect: they are ready to use.", billing: "Billed by TerminalX", billedByProvider: false, credentialSource: "platform", credentialFields: [] },
  box: { ...base, id: "box", label: "Boat", icon: "ship", order: 10, description: "Fast-start sandboxes that sleep when idle. Part of the disk resets on resume.", billing: "Per second, billed by Boat", credentialFields: [{ name: "credential", kind: "secret", label: "Boat API token" }] },
  agent37: { ...base, id: "agent37", label: "Agent37", icon: "server", order: 30, description: "Full virtual machines with Docker in the US, France and India. Sleeps when idle.", billing: "Per minute from your Agent37 wallet; only disk bills while asleep", credentialFields: [{ name: "credential", kind: "secret", label: "Agent37 API key", helpUrl: "https://agent37.example/keys" }] },
  // A provider this app has never heard of, with two fields and a mark it has no glyph for.
  lattice: { ...base, id: "lattice", label: "Lattice", icon: "lattice", order: 40, description: "Machines in a Lattice account you already have.", billing: "Hourly, billed by Lattice", credentialFields: [{ name: "accountId", kind: "text", label: "Lattice account ID" }, { name: "token", kind: "secret", label: "Lattice API token", helpUrl: "https://lattice.example/tokens" }] },
} as const;
type Id = keyof typeof DESCRIPTORS;

interface Stored { fingerprint: string; connectedAt: number; lastValidatedAt: number; attention: boolean }

/** Today at the given time, as the board's "Last checked today, 10:02". */
const todayAt = (hours: number, minutes: number) => { const at = new Date(); at.setHours(hours, minutes, 0, 0); return Math.min(at.getTime(), Date.now()); };
const yesterday = () => todayAt(9, 0) - 24 * 60 * MINUTE;

let scenario: string | null = null;
let shown: Id[] = [];
const stored = new Map<Id, Stored>();

function begin(name: string) {
  scenario = name;
  stored.clear();
  shown = name === "described" ? ["terminalx-cloud", "lattice"] : ["terminalx-cloud", "box", "agent37"];
  if (name === "one") stored.set("box", { fingerprint: FINGERPRINT, connectedAt: yesterday(), lastValidatedAt: todayAt(10, 2), attention: false });
  if (name === "agent37") stored.set("agent37", { fingerprint: FINGERPRINT, connectedAt: yesterday(), lastValidatedAt: todayAt(10, 2), attention: false });
  if (name === "attention") stored.set("box", { fingerprint: FINGERPRINT, connectedAt: yesterday(), lastValidatedAt: todayAt(10, 21), attention: true });
}

function provider(id: Id, member: boolean) {
  const descriptor = DESCRIPTORS[id];
  const key = stored.get(id);
  if (member) {
    // A member is sent no connection details, only whether each provider can be used.
    const availability = id === "terminalx-cloud" ? "disabled-for-create" : id === "box" ? "available" : "not-connected";
    return { id, displayName: descriptor.label, availability, canManage: false, descriptor };
  }
  if (!descriptor.credentialFields.length) return { id, displayName: descriptor.label, availability: "available", canManage: true, descriptor };
  if (!key) return { id, displayName: descriptor.label, availability: "not-connected", canManage: true, descriptor };
  return {
    id, displayName: descriptor.label, availability: key.attention ? "attention-required" : "available", canManage: true, descriptor,
    connection: { state: key.attention ? "attention-required" : "connected", connectedAt: key.connectedAt, lastValidatedAt: key.lastValidatedAt, credentialFingerprint: key.fingerprint },
  };
}

const never = new Promise<never>(() => undefined);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const REFUSALS: Record<string, [number, string]> = {
  invalid: [422, "cloud_provider_credential_invalid"],
  permission: [403, "cloud_provider_permission_denied"],
  billing: [402, "cloud_provider_billing_required"],
  unavailable: [503, "cloud_provider_unavailable"],
};

const LIST = /^\/v1\/mobile\/orgs\/[^/]+\/cloud-providers$/;
const ACTION = /^\/v1\/mobile\/orgs\/[^/]+\/cloud-providers\/([^/]+)\/(connect|disconnect)$/;

export const handle: SetupHandler = (request) => (LIST.test(request.path) || ACTION.test(request.path) ? answer(request) : undefined);

async function answer(request: SetupRequest): Promise<Response> {
  const list = LIST.exec(request.path);
  const action = ACTION.exec(request.path);
  const name = request.argument("fixtureCompute") ?? "nothing";
  if (scenario !== name) begin(name);

  if (list && request.method === "GET") {
    if (name === "reading") return never;
    if (name === "unreadable") return request.json(503, { error: "cloud_workspace_unavailable" });
    if (name === "none") return request.json(200, { providers: [] });
    return request.json(200, { providers: shown.map((id) => provider(id, name === "member")) });
  }

  const id = decodeURIComponent(action?.[1] ?? "") as Id;
  if (!action || request.method !== "POST" || !Object.hasOwn(DESCRIPTORS, id)) return request.json(404, { error: "cloud_provider_not_found" });

  if (action[2] === "connect") {
    const how = request.argument("fixtureConnect") ?? "ok";
    if (how === "checking") return never;
    // As fetch does when the phone is offline: the request never leaves.
    if (how === "network") throw new TypeError("Network request failed");
    await pause(900);
    const refused = REFUSALS[how];
    if (refused) return request.json(refused[0], { error: refused[1] });
    const now = Date.now();
    const key = { fingerprint: FINGERPRINT, connectedAt: stored.get(id)?.connectedAt ?? now, lastValidatedAt: now, attention: false };
    stored.set(id, key);
    return request.json(200, { provider: id, state: "connected", canManage: true, credentialFingerprint: key.fingerprint, connectedAt: key.connectedAt, lastValidatedAt: key.lastValidatedAt });
  }

  if (request.argument("fixtureDisconnect") === "refused") return request.json(409, { error: "cloud_provider_disposition_required" });
  stored.delete(id);
  return request.json(200, { provider: id, state: "not-connected", canManage: true, resources: [] });
}
