import { CloudApi, type CloudCredential } from "../api";

/**
 * The account service's agent-login routes, for tests: it answers the real
 * client (`CloudApi`) the way terminalx-saas does at origin/main f67dbabf
 * (`controllers/mobile/cloudMachineAdmin.ts`, `services/cloudWorkspaceCredentials`),
 * so a screen under test sends real requests and reads real answers.
 */
export interface Sent { method: string; path: string; body: any }
export interface Reply { status?: number; body?: unknown }
type Handler = (sent: Sent) => Reply | Promise<Reply>;

export const ORIGIN = "https://login.terminalx.ai";
export const ORG = "org-northwind";
const ROOT = `/v1/mobile/orgs/${ORG}/cloud-workspace-credentials`;

export const NOW = Date.UTC(2026, 10, 23, 10, 25, 0);
export const DEVICE = { attemptId: "attempt_1", deviceAuthId: "device-auth-1", userCode: "K7QM-4TXP", verificationUri: "https://auth.openai.com/codex/device", intervalSeconds: 5, expiresInSeconds: 900 };

/** A login as `credentialResponseFor` answers it. */
export function credential(provider: string, over: Partial<CloudCredential> = {}): CloudCredential {
  return { id: `credential_${provider}`, provider, authKind: provider === "github" ? "personal-access-token" : "api-key", fingerprint: "sha256:5be2d913", version: 1, updatedAt: NOW, state: "connected", stateChangedAt: NOW, sharedUse: "organization", epoch: 1, ...over };
}

export const refuse = (code: string, status: number): Reply => ({ status, body: { error: code } });
/** The request never got an answer. */
export const offline = (): never => { throw new TypeError("Network request failed"); };

export function loginService(stored: CloudCredential[] = []) {
  const overrides = new Map<string, Handler>();
  const service = {
    credentials: [...stored],
    calls: [] as Sent[],
    /** What the next device poll says. */
    device: "pending" as "pending" | "complete" | "failed" | "expired" | "canceled",
    starts: 0,
    /** Answer one route differently until `restore`: `on("POST", "/codex/device-poll", …)`; the list is `""`. */
    on(method: string, route: string, handler: Handler) { overrides.set(`${method} ${route}`, handler); },
    restore(method: string, route: string) { overrides.delete(`${method} ${route}`); },
    sent: (method: string, route: string) => service.calls.filter((call) => call.method === method && call.path === `${ROOT}${route}`),
    api: null as unknown as CloudApi,
  };

  const answer = (sent: Sent, route: string): Reply => {
    const provider = route.split("/")[1] ?? "";
    if (sent.method === "GET" && route === "") return { body: { credentials: service.credentials } };
    if (sent.method === "POST" && route === "/codex/device-start") {
      service.starts += 1;
      return { body: { ...DEVICE, attemptId: `attempt_${service.starts}` } };
    }
    if (sent.method === "POST" && route === "/codex/device-poll") {
      if (sent.body?.confirmOrganizationSharing !== true || sent.body?.confirmMachineInstallation !== true) return refuse("cloud_workspace_request_invalid", 422);
      if (service.device !== "complete") return { body: { status: service.device } };
      const saved = credential("codex", { authKind: "oauth-credentials-json", displayIdentity: "alex@example.com" });
      service.credentials = [...service.credentials.filter((entry) => entry.provider !== "codex"), saved];
      return { body: { status: "complete", credential: saved } };
    }
    if (sent.method === "POST" && route === "/codex/device-cancel") return { body: { status: "canceled" } };
    if (sent.method === "POST" && route === `/${provider}/revoke`) {
      const current = service.credentials.find((entry) => entry.provider === provider);
      if (!current) return refuse("cloud_workspace_credential_required", 404);
      const revoked = { ...current, state: "revoked", epoch: current.epoch + 1 };
      service.credentials = service.credentials.map((entry) => (entry === current ? revoked : entry));
      return { body: revoked };
    }
    if (sent.method === "PUT" && route === `/${provider}`) {
      const body = sent.body ?? {};
      if (typeof body.secret !== "string" || !body.secret || body.confirmOrganizationSharing !== true || body.confirmMachineInstallation !== true) return refuse("cloud_workspace_request_invalid", 422);
      const saved = credential(provider, { authKind: body.authKind, ...(body.displayIdentity ? { displayIdentity: body.displayIdentity } : {}), version: 2 });
      service.credentials = [...service.credentials.filter((entry) => entry.provider !== provider), saved];
      return { body: saved };
    }
    if (sent.method === "DELETE" && route === `/${provider}`) {
      service.credentials = service.credentials.filter((entry) => entry.provider !== provider);
      return { body: {} };
    }
    return refuse("not_found", 404);
  };

  const fetcher = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const sent: Sent = { method: init.method ?? "GET", path, body: init.body ? JSON.parse(init.body as string) : undefined };
    service.calls.push(sent);
    const route = path.startsWith(ROOT) ? path.slice(ROOT.length) : path;
    const reply = await (overrides.get(`${sent.method} ${route}`) ?? ((call: Sent) => answer(call, route)))(sent);
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)) } as unknown as Response;
  };
  service.api = new CloudApi({ origin: ORIGIN, accessToken: async () => "access-token", fetch: fetcher as never });
  return service;
}
