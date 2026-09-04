import { z } from "zod";
import type { CloudSession } from "../auth/protocol";

const hostSchema = z.object({
  hostId: z.string().min(1),
  hostPublicKeyB64: z.string().min(1),
  bindingGeneration: z.number().int().positive(),
  displayName: z.string().min(1),
  platform: z.string().min(1).optional(),
  environmentKind: z.enum(["native", "wsl", "ssh"]).optional(),
  capabilities: z.array(z.string()),
  state: z.literal("active"),
  reachability: z.enum(["live", "unverifiable", "exited"]),
  lastSeenAt: z.string().datetime().nullable().optional(),
});

const grantSchema = z.object({
  hostId: z.string().min(1),
  clientInstallationId: z.string().min(1),
  grantRequestId: z.string().min(1),
  bindingGeneration: z.number().int().positive(),
  state: z.enum(["pending", "granted", "consumed", "expired", "rejected", "revoked"]),
  associatedData: z.string().min(1),
  expiresAt: z.string(),
  envelope: z.object({ version: z.literal(1), algorithm: z.literal("HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305"), encapsulatedKey: z.string().min(1), ciphertext: z.string().min(1) }).optional(),
});

export type AccountHost = z.infer<typeof hostSchema>;
export type AccountGrant = z.infer<typeof grantSchema>;

export class AccountPairingClient {
  private readonly origin: string;

  constructor(sessionEndpoint: string, private readonly session: CloudSession) {
    this.origin = new URL(sessionEndpoint).origin;
  }

  async registerInstallation(clientInstallationId: string, proof: object) {
    const response = await this.request(`/v1/account/client-installations/${encodeURIComponent(clientInstallationId)}`, "PUT", { userId: this.session.user.userId, ...proof });
    return z.object({ installation: z.object({ clientInstallationId: z.string(), trustState: z.enum(["pending", "trusted", "revoked"]), generation: z.number().int().positive() }), reauthenticationRequired: z.boolean() }).parse(response);
  }

  async hosts(): Promise<AccountHost[]> {
    return z.object({ hosts: z.array(hostSchema) }).parse(await this.request("/v1/account/hosts")).hosts;
  }

  async requestGrant(input: object): Promise<AccountGrant> {
    return z.object({ grant: grantSchema }).parse(await this.request("/v1/account/pairing-grant-requests", "POST", input)).grant;
  }

  async grant(id: string, installationId: string): Promise<AccountGrant> {
    return z.object({ grant: grantSchema }).parse(await this.request(`/v1/account/pairing-grant-requests/${encodeURIComponent(id)}?clientInstallationId=${encodeURIComponent(installationId)}`)).grant;
  }

  async consume(grant: AccountGrant, userId: string): Promise<void> {
    await this.request(`/v1/account/pairing-grant-requests/${encodeURIComponent(grant.grantRequestId)}/consume`, "POST", { userId, clientInstallationId: grant.clientInstallationId, bindingGeneration: grant.bindingGeneration });
  }

  async revoke(grant: AccountGrant, userId: string): Promise<void> {
    await this.request(`/v1/account/pairing-grant-requests/${encodeURIComponent(grant.grantRequestId)}/revoke`, "POST", { userId, clientInstallationId: grant.clientInstallationId, reason: "user-request" });
  }

  async logout(installationId: string): Promise<void> {
    await this.request(`/v1/account/client-installations/${encodeURIComponent(installationId)}/logout`, "POST", { userId: this.session.user.userId, scope: "local", reason: "user-sign-out" });
  }

  private async request(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.origin}${path}`, { method, headers: { authorization: `Bearer ${this.session.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error(`account_pairing_request_failed_${response.status}`);
      return response.status === 204 ? undefined : response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
