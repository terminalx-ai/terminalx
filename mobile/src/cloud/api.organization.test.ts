import { describe, expect, it } from "vitest";
import { CloudApi, ORGANIZATION_CREATE_CAPABILITY } from "./api";

/**
 * Creating an organization from the phone (PRO-527) against the account
 * service's answers as terminalx-saas builds them at origin/main f67dbabf
 * (PRO-526): `routes/desktop.ts` (`POST /v1/desktop/orgs` behind the
 * desktop-or-phone token check), `controllers/desktop/orgCreate.ts` (201 with
 * `{ id, name, role }`; 400 and 409 with `{ error }`), and the capability
 * flag of `buildDesktopSession.ts`.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Answer = { status?: number; body?: unknown };

function api(answers: (call: Call) => Answer | Promise<Answer>, token: string | null = "access-token") {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const answer = await answers(call);
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (answer.body === undefined ? "" : JSON.stringify(answer.body)) } as Response;
  };
  return { client: new CloudApi({ origin: "https://login.terminalx.ai", accessToken: async () => token, fetch: fetcher as never }), calls };
}

const KEY = "0b0e3c0e-6f0a-4f61-9f0e-2a3d1b7c9f10";

describe("creating an organization from the phone", () => {
  it("sends the trimmed name with the attempt's idempotency key and returns the new organization, owned", async () => {
    const { client, calls } = api(() => ({ status: 201, body: { id: "org-new", name: "Northwind", role: "owner" } }));
    await expect(client.createOrganization("  Northwind ", KEY)).resolves.toEqual({ orgId: "org-new", name: "Northwind", role: "owner", isPersonal: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://login.terminalx.ai/v1/desktop/orgs", method: "POST", body: { name: "Northwind" } });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe(KEY);
    expect(calls[0]!.headers.authorization).toBe("Bearer access-token");
  });

  it("sends nothing for a name the server would refuse, or a key it would not take", async () => {
    const { client, calls } = api(() => ({ status: 201, body: { id: "org-new", name: "x", role: "owner" } }));
    for (const name of ["", " N ", "x".repeat(61)]) await expect(client.createOrganization(name, KEY)).rejects.toMatchObject({ code: "organization_name_invalid", refusal: "invalid-request" });
    await expect(client.createOrganization("x".repeat(60), KEY)).resolves.toMatchObject({ orgId: "org-new" });
    await expect(client.createOrganization("Northwind", "")).rejects.toMatchObject({ code: "organization_idempotency_key_invalid", refusal: "invalid-request" });
    await expect(client.createOrganization("Northwind", "clé")).rejects.toMatchObject({ code: "organization_idempotency_key_invalid" });
    expect(calls).toHaveLength(1);
  });

  it("tells the server's refusals apart, and no answer from a refusal", async () => {
    const refused = (code: string, status: number) => api(() => ({ status, body: { error: code } })).client.createOrganization("Northwind", KEY);
    await expect(refused("organization_name_invalid", 400)).rejects.toMatchObject({ refusal: "invalid-request", status: 400 });
    await expect(refused("organization_idempotency_key_invalid", 400)).rejects.toMatchObject({ refusal: "invalid-request" });
    await expect(refused("organization_idempotency_key_reused", 409)).rejects.toMatchObject({ refusal: "idempotency-key-reused" });
    await expect(refused("organization_idempotency_result_unavailable", 409)).rejects.toMatchObject({ refusal: "unknown", unreachable: false });
    await expect(refused("unauthorized", 401)).rejects.toMatchObject({ refusal: "signed-out" });
    await expect(refused("internal", 500)).rejects.toMatchObject({ refusal: "unreachable" });
    await expect(api(() => Promise.reject(new Error("offline"))).client.createOrganization("Northwind", KEY)).rejects.toMatchObject({ refusal: "unreachable", status: null, reason: "network" });
    const signedOut = api(() => ({ body: {} }), null);
    await expect(signedOut.client.createOrganization("Northwind", KEY)).rejects.toMatchObject({ code: "account_signed_out" });
    expect(signedOut.calls).toEqual([]);
  });

  it("reads an answer without the new organization's id as one it cannot use", async () => {
    for (const body of [{}, { id: "", name: "Northwind", role: "owner" }, { organization: { id: "org-new" } }]) {
      await expect(api(() => ({ status: 201, body })).client.createOrganization("Northwind", KEY)).rejects.toMatchObject({ code: "cloud_workspace_invalid_response", refusal: "invalid-response" });
    }
  });

  it("offers creation only when the server says its route takes a phone's token", async () => {
    const older = api(() => ({ body: { organizations: [], capabilities: { flags: { "organizations.delete.mobile.v1": true } } } }));
    expect(older.client.createsOrganizations()).toBe(false);
    await older.client.organizations();
    expect(older.client.createsOrganizations()).toBe(false);
    const newer = api(() => ({ body: { organizations: [], capabilities: { flags: { [ORGANIZATION_CREATE_CAPABILITY]: true } } } }));
    await newer.client.organizations();
    expect(newer.client.createsOrganizations()).toBe(true);
    expect(ORGANIZATION_CREATE_CAPABILITY).toBe("organizations.create.mobile.v1");
  });
});
