import { CloudCatalog } from "../catalog";
import { agent37, agent37Setup, boat, boatQuote, boatSetup, claudeKey, codexLogin, operation, refuse, server, workspace, type Answer, type Call } from "./server";

/**
 * A small account service for screen tests: it keeps workspaces, operations,
 * quotes and idempotency keys the way terminalx-saas does, and answers the
 * mobile routes with them. The screens under test talk to it through the real
 * `CloudApi` and the real `CloudCatalog`; nothing of theirs is replaced.
 *
 * A test changes what the server holds (`state`), moves an operation along
 * (`advance`), or answers one request its own way (`state.answer`).
 */
export function account(start: { role?: "owner" | "admin" | "member"; workspaces?: { workspace: Record<string, unknown>; latestOperation: Record<string, unknown> | null }[] } = {}) {
  const state = {
    role: start.role ?? "admin",
    providers: [boat, agent37] as unknown[],
    credentials: [codexLogin, claudeKey] as unknown[],
    preflight: { version: 1, ready: true, checks: [] as unknown[] } as unknown,
    hourlyMicros: 18_000,
    quoteHoldsMs: 300_000,
    workspaces: new Map<string, Record<string, unknown>>(),
    operations: new Map<string, Record<string, unknown>>(),
    latest: new Map<string, string>(),
    quotes: new Map<string, number>(),
    keys: new Map<string, string>(),
    /** Answers one request instead of the service, when it returns something. */
    answer: null as ((call: Call) => Answer | undefined | void) | null,
  };
  for (const item of start.workspaces ?? []) {
    state.workspaces.set(item.workspace.id as string, item.workspace);
    if (item.latestOperation) { state.operations.set(item.latestOperation.id as string, item.latestOperation); state.latest.set(item.workspace.id as string, item.latestOperation.id as string); }
  }
  let made = 0;
  const life = (operationId: string) => { const op = state.operations.get(operationId)!; return { workspace: state.workspaces.get(op.workspaceId as string)!, operation: op }; };
  const begin = (workspaceId: string, fields: Record<string, unknown>) => {
    const op = operation({ id: `op-${++made}`, workspaceId, ...fields });
    state.operations.set(op.id, op);
    state.latest.set(workspaceId, op.id);
    return life(op.id);
  };

  const respond = (call: Call): Answer => state.answer?.(call) || handle(call);
  /** The service's own answer to a request, whatever `state.answer` says. */
  function handle(call: Call): Answer {
    const { path, method } = call;
    if (path.endsWith("/v1/desktop/auth/capabilities")) return { body: { cloud: { userId: "u" }, organizations: [{ orgId: "org-1", name: "Acme", role: state.role }], capabilities: { flags: {}, refreshedAt: 1 } } };
    if (path === "/cloud-providers") return { body: { providers: state.providers } };
    if (path === "/cloud-workspace-credentials") return state.role === "member" ? refuse("organization_admin_required", 403) : { body: { credentials: state.credentials } };
    if (path.startsWith("/cloud-workspaces/setup")) return { body: path.endsWith("agent37") ? agent37Setup : boatSetup };
    if (path === "/cloud-workspaces/preflight") return { body: state.preflight };
    if (path === "/cloud-workspaces/quote") {
      const id = `quote_${++made}`;
      const expiresAt = Date.now() + state.quoteHoldsMs;
      state.quotes.set(id, expiresAt);
      const asked = call.body as { machineClassId: string; idleSuspendMinutes: number; provider: string; locationId: string };
      const size = (asked.provider === "agent37" ? agent37Setup : boatSetup).machineClasses.find((entry) => entry.id === asked.machineClassId)!;
      const base = boatQuote(expiresAt, { id, provider: asked.provider, activeHourlyMicros: state.hourlyMicros, alwaysOnThirtyDayMicros: state.hourlyMicros * 720 });
      return { body: { ...base, configuration: { ...base.configuration, machineClassId: size.id, machineClassLabel: size.label, vcpu: size.vcpu, memoryMiB: size.memoryMiB, diskGiB: size.diskGiB, idleSuspendMinutes: asked.idleSuspendMinutes, locationId: asked.locationId } } };
    }
    if (path === "/cloud-workspaces" && method === "POST") {
      const key = call.headers["Idempotency-Key"]!;
      // A key seen before answers with the launch it started; nothing is created again.
      if (state.keys.has(key)) return { status: 200, body: life(state.keys.get(key)!) };
      const body = call.body as { name: string; quoteId: string; confirmProviderSpend: boolean };
      if (body.confirmProviderSpend !== true) return refuse("cloud_workspace_request_invalid", 422);
      if ((state.quotes.get(body.quoteId) ?? 0) <= Date.now()) return refuse("cloud_workspace_quote_expired", 409);
      const id = `ws-${++made}`;
      state.workspaces.set(id, workspace({ id, name: body.name }));
      const answer = begin(id, {});
      state.keys.set(key, answer.operation.id as string);
      return { status: 202, body: answer };
    }
    if (path === "/cloud-workspaces") return { body: { workspaces: [...state.workspaces.values()].filter((held) => held.state !== "destroyed").map((held) => ({ workspace: held, latestOperation: state.operations.get(state.latest.get(held.id as string) ?? "") ?? null })), tombstones: [] } };
    const op = /^\/cloud-workspace-operations\/([^/]+)(\/cancel)?$/.exec(path);
    if (op) {
      if (!state.operations.has(op[1]!)) return refuse("cloud_workspace_operation_not_found", 404);
      if (op[2]) advance(op[1]!, { state: "cancel-requested", stage: "cleanup", cancelable: false });
      return { body: life(op[1]!) };
    }
    const act = /^\/cloud-workspaces\/([^/]+)\/(suspend|delete|resume)$/.exec(path);
    if (act && state.workspaces.has(act[1]!)) return { status: 202, body: begin(act[1]!, { type: "lifecycle", action: act[2], cancelable: false }) };
    return refuse("cloud_workspace_not_found", 404);
  }

  /** Move an operation along, and its workspace with it. */
  function advance(operationId: string, fields: Record<string, unknown>, ws: Record<string, unknown> = {}) {
    const held = state.operations.get(operationId)!;
    state.operations.set(operationId, { ...held, ...fields });
    state.workspaces.set(held.workspaceId as string, { ...state.workspaces.get(held.workspaceId as string)!, ...ws });
  }

  const { api, calls } = server(respond);
  const secrets = new Map<string, string>();
  const blobs = new Map<string, string>();
  const catalog = new CloudCatalog({
    api,
    secrets: { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) },
    storage: { getItem: async (name) => blobs.get(name) ?? null, setItem: async (name, value) => void blobs.set(name, value), removeItem: async (name) => void blobs.delete(name), getAllKeys: async () => [...blobs.keys()] },
    clientInstallationId: "mobile-1",
    appVersion: "0.1.0",
  });
  const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);
  return { state, api, calls, catalog, advance, handle, sent };
}
