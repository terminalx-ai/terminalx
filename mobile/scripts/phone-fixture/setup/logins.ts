import type { SetupHandler } from "./types";

/**
 * The fixture's answers for agent logins and the Codex device sign-in (25.04).
 * Placeholder logins only: no key, token or code here is real.
 *
 * Launch arguments:
 * - `fixtureLogins`: `none` (default), `some` (the list's "Some connected"),
 *   `saved` (one login in each state a saved login's page draws), `unreadable`.
 * - `fixtureLoginsSave`: `ok` (default), `hold` (the check never answers),
 *   `invalid` (cloud_workspace_credential_invalid), `unavailable`
 *   (cloud_workspace_credential_verification_unavailable).
 * - `fixtureLoginsDelete`: `ok` (default), `in-use` (cloud_workspace_credential_in_use).
 * - `fixtureCodex`: `pending` (default), `complete`, `failed`, `expired`,
 *   `offline` (questions never reach the service), `unavailable`
 *   (cloud_workspace_device_auth_unavailable), `hold` (no code comes).
 */

const day = (month: number, date: number) => Date.UTC(2026, month - 1, date, 12);
const never = new Promise<never>(() => undefined);

interface Login { id: string; provider: string; authKind: string; fingerprint: string; displayIdentity?: string; version: number; updatedAt: number; state: string; stateChangedAt?: number; sharedUse: string; epoch: number }
const login = (provider: string, authKind: string, state: string, updatedAt: number, displayIdentity?: string): Login => ({
  id: `cred-${provider}`, provider, authKind, fingerprint: "sha256:5be2d913", ...(displayIdentity ? { displayIdentity } : {}), version: 1, updatedAt, state, stateChangedAt: updatedAt, sharedUse: "organization", epoch: 1,
});

function scenario(name: string | undefined): Login[] {
  if (name === "some") return [
    login("codex", "oauth-credentials-json", "connected", day(11, 20), "alex@example.com"),
    login("claude", "api-key", "sign-in-required", day(11, 2)),
    login("cursor", "api-key", "revoked", day(10, 14)),
    login("github", "personal-access-token", "connected", day(11, 23)),
  ];
  if (name === "saved") return [
    login("codex", "oauth-credentials-json", "sign-in-required", day(11, 23), "alex@example.com"),
    login("claude", "api-key", "connected", day(11, 23), "alex@example.com"),
    login("cursor", "api-key", "revoked", day(11, 23), "alex@example.com"),
  ];
  return [];
}

// What this launch's service holds; a save, revoke or removal changes it, as the server would.
let held: Login[] | null = null;
const PATH = /^\/v1\/mobile\/orgs\/([^/]+)\/cloud-workspace-credentials(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const CODE = { attemptId: "attempt-fixture", deviceAuthId: "device-fixture", userCode: "K7QM-4TXP", verificationUri: "https://cloud.fixture.invalid/codex/device", intervalSeconds: 5, expiresInSeconds: 900 };

export const handle: SetupHandler = (request) => {
  const match = PATH.exec(request.path);
  if (!match) return undefined;
  const [, , provider, action] = match.map((part) => (part ? decodeURIComponent(part) : part));
  held ??= scenario(request.argument("fixtureLogins"));
  const logins = held;
  const codex = request.argument("fixtureCodex");

  if (!provider && request.method === "GET") {
    if (request.argument("fixtureLogins") === "unreadable") return request.json(503, { error: "cloud_workspace_unavailable" });
    return request.json(200, { credentials: logins });
  }
  if (provider === "codex" && action === "device-start") {
    if (codex === "unavailable") return request.json(503, { error: "cloud_workspace_device_auth_unavailable" });
    if (codex === "hold") return never;
    return request.json(200, CODE);
  }
  if (provider === "codex" && action === "device-poll") {
    if (codex === "offline") return Promise.reject(new TypeError("Network request failed"));
    if (codex === "failed" || codex === "expired") return request.json(200, { status: codex });
    if (codex === "complete") {
      const saved = login("codex", "oauth-credentials-json", "connected", Date.now(), "alex@example.com");
      held = [...logins.filter((item) => item.provider !== "codex"), saved];
      return request.json(200, { status: "complete", credential: saved });
    }
    return request.json(200, { status: "pending" });
  }
  if (provider === "codex" && action === "device-cancel") return request.json(200, { status: "canceled" });
  if (provider && action === "revoke" && request.method === "POST") {
    const found = logins.find((item) => item.provider === provider);
    if (!found) return request.json(404, { error: "cloud_workspace_not_found" });
    const revoked = { ...found, state: "revoked", stateChangedAt: Date.now() };
    held = logins.map((item) => (item.provider === provider ? revoked : item));
    return request.json(200, revoked);
  }
  if (provider && !action && request.method === "DELETE") {
    if (request.argument("fixtureLoginsDelete") === "in-use") return request.json(409, { error: "cloud_workspace_credential_in_use" });
    held = logins.filter((item) => item.provider !== provider);
    return new Response(null, { status: 204 });
  }
  if (provider && !action && request.method === "PUT") {
    const outcome = request.argument("fixtureLoginsSave");
    if (outcome === "hold") return never;
    if (outcome === "invalid") return request.json(422, { error: "cloud_workspace_credential_invalid" });
    if (outcome === "unavailable") return request.json(503, { error: "cloud_workspace_credential_verification_unavailable" });
    const body = request.body as { authKind?: string; displayIdentity?: string | null } | null;
    // The key itself is not kept: the service answers with a fingerprint only.
    const saved = login(provider, body?.authKind ?? "api-key", "connected", Date.now(), body?.displayIdentity ?? undefined);
    held = [...logins.filter((item) => item.provider !== provider), saved];
    return request.json(200, saved);
  }
  return undefined;
};
