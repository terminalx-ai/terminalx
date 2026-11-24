import { CloudCatalog } from "../catalog";
import { agent37, agent37Setup, boat, boatQuote, boatSetup, claudeKey, codexLogin, operation, refuse, server, workspace, type Answer, type Call } from "./server";

/**
 * A small account service for screen tests: it keeps workspaces, operations,
 * quotes and idempotency keys the way terminalx-saas does, and answers the
 * mobile routes with them. The screens under test talk to it through the real
 * `CloudApi` and the real `CloudCatalog`; nothing of theirs is replaced.
 *
 * A test changes what the server holds (`state`), moves an operation along
 * (`advance`), moves a first task along (`advanceLaunch`), or answers one
 * request its own way (`state.answer`).
 *
 * A launch's first task is kept as the server's intent row is, and every
 * workspace answer carries its view (contract 19.2) as `loadLaunchViews`
 * and `launchPhase` build it. The mobile create route takes `launch` once
 * PRO-544 is deployed; this service answers as that server will.
 */

/** A first task as the server holds it (`cloud_workspace_launch_intents`). */
export interface HeldLaunch {
  launchId: string;
  state: "pending" | "claimed" | "started" | "failed" | "outcome-unknown" | "canceled" | "expired";
  agent: string;
  model?: string;
  effort?: string;
  mode?: string;
  promptBytes: number;
  category?: string;
  sessionId?: string;
  tabId?: string;
  createdAt: number;
  syncingAt?: number;
  startingAgentAt?: number;
  runningAt?: number;
  failedAt?: number;
}

/** `launchPhase`: the phase a person sees, from the intent and the launch's operation. */
function launchPhase(intent: HeldLaunch, operation: Record<string, unknown> | null): string {
  if (intent.state === "started") return "running";
  if (intent.state === "failed" || intent.state === "outcome-unknown" || intent.state === "expired") return "failed";
  if (intent.state === "canceled") return "canceled";
  if (intent.state === "claimed") return intent.startingAgentAt ? "starting-agent" : "syncing-repository";
  if (!operation) return "allocating";
  if (operation.state === "canceled" || operation.state === "cancel-requested") return "canceled";
  if (operation.state === "failed") return "failed";
  if (operation.state === "succeeded") return "authenticating-runtime";
  if (operation.stage === "bootstrapping") return "booting";
  if (operation.stage === "connecting-relay" || operation.stage === "ready") return "authenticating-runtime";
  if (operation.stage === "cleanup") return "failed";
  return "allocating";
}

/** The server's launch parser (`parseLaunch`): exactly the contract's keys and shapes, or nothing. */
function parsedLaunch(value: unknown): Omit<HeldLaunch, "launchId" | "state" | "createdAt"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const launch = value as Record<string, unknown>;
  if (Object.keys(launch).some((key) => !["v", "agent", "model", "effort", "mode", "prompt", "nativeCodex"].includes(key))) return null;
  if (launch.v !== 1 || typeof launch.agent !== "string" || !/^[a-z0-9-]{1,32}$/.test(launch.agent)) return null;
  if (launch.model !== undefined && (typeof launch.model !== "string" || !/^[\x20-\x7e]{1,100}$/.test(launch.model))) return null;
  if (launch.effort !== undefined && (typeof launch.effort !== "string" || !/^[a-z]{1,16}$/.test(launch.effort))) return null;
  if (launch.mode !== undefined && !["plan", "manual", "auto", "acceptEdits", "bypassPermissions"].includes(launch.mode as string)) return null;
  const prompt = launch.prompt;
  if (prompt !== undefined && (typeof prompt !== "string" || prompt === "" || prompt.includes("\u0000"))) return null;
  const promptBytes = typeof prompt === "string" ? new TextEncoder().encode(prompt).length : 0;
  if (promptBytes > 32 * 1024) return null;
  return { agent: launch.agent, ...(launch.model ? { model: launch.model as string } : {}), ...(launch.effort ? { effort: launch.effort as string } : {}), ...(launch.mode ? { mode: launch.mode as string } : {}), promptBytes };
}
export function account(start: { role?: "owner" | "admin" | "member"; workspaces?: { workspace: Record<string, unknown>; latestOperation: Record<string, unknown> | null; launch?: Partial<HeldLaunch> }[] } = {}) {
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
    /** First tasks by workspace id, and what each create body carried. */
    launches: new Map<string, HeldLaunch>(),
    /** When each launch's operation first reached `bootstrapping` and `connecting-relay`, by workspace id. */
    reached: new Map<string, { bootingAt?: number; authenticatingAt?: number }>(),
    /** Answers one request instead of the service, when it returns something. */
    answer: null as ((call: Call) => Answer | undefined | void) | null,
  };
  for (const item of start.workspaces ?? []) {
    state.workspaces.set(item.workspace.id as string, item.workspace);
    if (item.latestOperation) { state.operations.set(item.latestOperation.id as string, item.latestOperation); state.latest.set(item.workspace.id as string, item.latestOperation.id as string); }
    if (item.launch) state.launches.set(item.workspace.id as string, { launchId: `launch-${item.workspace.id as string}`, state: "pending", agent: "claude", mode: "manual", promptBytes: 0, createdAt: 1_795_000_300_000, ...item.launch });
  }
  /** `loadLaunchViews` for one workspace: absent when it was launched with no first task. */
  const launchView = (workspaceId: string) => {
    const intent = state.launches.get(workspaceId);
    if (!intent) return undefined;
    const operation = state.operations.get(state.latest.get(workspaceId) ?? "") ?? null;
    const phase = launchPhase(intent, operation);
    const reached = state.reached.get(workspaceId) ?? {};
    const failedAt = intent.failedAt ?? (phase === "failed" && intent.state === "pending" ? (operation?.updatedAt as number | undefined) : undefined);
    const timings: Record<string, number> = { requestedAt: intent.createdAt };
    for (const [key, at] of [["bootingAt", reached.bootingAt], ["authenticatingAt", reached.authenticatingAt], ["syncingAt", intent.syncingAt], ["startingAgentAt", intent.startingAgentAt], ["runningAt", intent.runningAt], ["failedAt", failedAt]] as const) if (at) timings[key] = at;
    return {
      launchId: intent.launchId, phase, state: intent.state, workBranch: null, agent: intent.agent,
      ...(intent.model ? { model: intent.model } : {}), ...(intent.effort ? { effort: intent.effort } : {}), ...(intent.mode ? { mode: intent.mode } : {}),
      hasPrompt: intent.promptBytes > 0, ...(intent.category ? { category: intent.category } : {}), ...(intent.sessionId ? { sessionId: intent.sessionId } : {}), ...(intent.tabId ? { tabId: intent.tabId } : {}),
      timings,
    };
  };
  /** A workspace as every answer carries it: with its launch view (`withLaunch`). */
  const viewed = (held: Record<string, unknown>) => { const launch = launchView(held.id as string); return launch ? { ...held, launch } : held; };
  let made = 0;
  const life = (operationId: string) => { const op = state.operations.get(operationId)!; return { workspace: viewed(state.workspaces.get(op.workspaceId as string)!), operation: op }; };
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
      const body = call.body as { name: string; quoteId: string; confirmProviderSpend: boolean; launch?: unknown };
      if (body.confirmProviderSpend !== true) return refuse("cloud_workspace_request_invalid", 422);
      const launch = body.launch === undefined ? null : parsedLaunch(body.launch);
      if (body.launch !== undefined && !launch) return refuse("cloud_workspace_launch_invalid", 422);
      if ((state.quotes.get(body.quoteId) ?? 0) <= Date.now()) return refuse("cloud_workspace_quote_expired", 409);
      const id = `ws-${++made}`;
      state.workspaces.set(id, workspace({ id, name: body.name }));
      if (launch) state.launches.set(id, { launchId: `launch-${id}`, state: "pending", createdAt: Date.now(), ...launch });
      const answer = begin(id, {});
      state.keys.set(key, answer.operation.id as string);
      return { status: 202, body: answer };
    }
    if (path === "/cloud-workspaces") return { body: { workspaces: [...state.workspaces.values()].filter((held) => held.state !== "destroyed").map((held) => ({ workspace: viewed(held), latestOperation: state.operations.get(state.latest.get(held.id as string) ?? "") ?? null })), tombstones: [] } };
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
    // The server stamps every change of an operation.
    state.operations.set(operationId, { ...held, updatedAt: Date.now(), ...fields });
    const workspaceId = held.workspaceId as string;
    state.workspaces.set(workspaceId, { ...state.workspaces.get(workspaceId)!, ...ws });
    // The history `loadLaunchViews` reads its booting and authenticating times from.
    const reached = state.reached.get(workspaceId) ?? {};
    if (fields.stage === "bootstrapping") reached.bootingAt ??= Date.now();
    if (fields.stage === "connecting-relay") reached.authenticatingAt ??= Date.now();
    state.reached.set(workspaceId, reached);
  }

  /** The runtime moves the workspace's first task along: claims it, starts the agent, reports how it went. */
  function advanceLaunch(workspaceId: string, fields: Partial<HeldLaunch>) {
    state.launches.set(workspaceId, { ...state.launches.get(workspaceId)!, ...fields });
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
  return { state, api, calls, catalog, advance, advanceLaunch, handle, sent };
}
