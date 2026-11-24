import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudApi, CloudApiError, organizationNameValid } from "./api";

/**
 * Creating an organization from the phone (PRO-526) against the account
 * service's answers, as terminalx-saas#291 builds them: `POST /orgs` on the
 * desktop router with `desktopOrMobileAuth`, answering 201 `{ id, name, role }`;
 * 400 `organization_name_invalid` for a name outside 2 to 60 characters once
 * trimmed; 400 `organization_idempotency_key_invalid` for a malformed key;
 * 409 `organization_idempotency_key_reused` for the same key with another
 * name; and the flag `organizations.create.mobile.v1` in the capabilities.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Answer = { status?: number; body?: unknown; text?: string };

const ORIGIN = "https://login.terminalx.ai";

function api(answers: (call: Call) => Answer | Promise<Answer>, token: string | null = "access-token") {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const answer = await answers(call);
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body)) } as Response;
  };
  return { client: new CloudApi({ origin: ORIGIN, accessToken: async () => token, fetch: fetcher as never }), calls };
}

const created = { id: "org-new", name: "Northwind", role: "owner" };

afterEach(() => { vi.useRealTimers(); });

describe("createOrganization", () => {
  it("posts the trimmed name with the phone's token and the idempotency key, and answers the new organization", async () => {
    const { client, calls } = api(() => ({ status: 201, body: created }));
    await expect(client.createOrganization("  Northwind ", "key-1")).resolves.toEqual({ orgId: "org-new", name: "Northwind", role: "owner", isPersonal: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${ORIGIN}/v1/desktop/orgs`, method: "POST", body: { name: "Northwind" } });
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer access-token", "Idempotency-Key": "key-1" });
    // Exactly the one key the server reads.
    expect(Object.keys(calls[0]!.body as object)).toEqual(["name"]);
  });

  it("checks the name and the key on the phone before anything is sent", async () => {
    const { client, calls } = api(() => ({ status: 201, body: created }));
    for (const name of ["", " ", "N", " N ", "a".repeat(61)]) await expect(client.createOrganization(name, "key-1")).rejects.toMatchObject({ code: "organization_name_invalid", refusal: "invalid-request" });
    for (const key of ["", "a".repeat(129), "kéy"]) await expect(client.createOrganization("Northwind", key)).rejects.toMatchObject({ code: "organization_idempotency_key_invalid", refusal: "invalid-request" });
    expect(calls).toHaveLength(0);
    expect(organizationNameValid("ab")).toBe(true);
    expect(organizationNameValid(` ${"a".repeat(60)} `)).toBe(true);
    expect(organizationNameValid("a".repeat(61))).toBe(false);
  });

  it("sends the same key again on a retry, and the server's replay is the same organization", async () => {
    let first = true;
    const { client, calls } = api(() => {
      if (first) { first = false; return Promise.reject(new Error("offline")); }
      return { status: 201, body: created };
    });
    await expect(client.createOrganization("Northwind", "key-retry")).rejects.toMatchObject({ code: "cloud_workspace_unavailable", status: null, reason: "network", refusal: "unreachable" });
    await expect(client.createOrganization("Northwind", "key-retry")).resolves.toMatchObject({ orgId: "org-new" });
    expect(calls.map((call) => call.headers["Idempotency-Key"])).toEqual(["key-retry", "key-retry"]);
  });

  it("says a timeout as unreachable, so the page tries again with the same key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetcher = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const client = new CloudApi({ origin: ORIGIN, accessToken: async () => "access-token", fetch: fetcher as never });
    const pending = client.createOrganization("Northwind", "key-1").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "cloud_workspace_unavailable", reason: "timeout", refusal: "unreachable" });
  });

  it("keeps the server's refusals as codes with their kinds", async () => {
    const cases: [string, number, string][] = [
      ["organization_name_invalid", 400, "invalid-request"],
      ["organization_idempotency_key_invalid", 400, "invalid-request"],
      ["organization_idempotency_key_reused", 409, "idempotency-key-reused"],
      ["unauthorized", 401, "signed-out"],
    ];
    for (const [code, status, refusal] of cases) {
      const error = await api(() => ({ status, body: { error: code } })).client.createOrganization("Northwind", "key-1").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CloudApiError);
      expect(error).toMatchObject({ code, status, refusal });
    }
  });

  it("refuses an answer it cannot read, and sends nothing while signed out", async () => {
    for (const body of [{}, { id: "", name: "Northwind", role: "owner" }, { id: "org-new", name: 4, role: "owner" }, null]) {
      await expect(api(() => ({ status: 201, body })).client.createOrganization("Northwind", "key-1")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
    }
    const signedOut = api(() => ({ status: 201, body: created }), null);
    await expect(signedOut.client.createOrganization("Northwind", "key-1")).rejects.toMatchObject({ code: "account_signed_out" });
    expect(signedOut.calls).toHaveLength(0);
  });
});

describe("createsOrganizations", () => {
  it("is true only after a capabilities read that carries the flag", async () => {
    const answers = [{ organizations: [], capabilities: { flags: { "organizations.create.mobile.v1": true } } }, { organizations: [], capabilities: { flags: {} } }, { organizations: [] }];
    let next = 0;
    const { client } = api(() => ({ body: answers[next++] }));
    expect(client.createsOrganizations()).toBe(false);
    await client.organizations();
    expect(client.createsOrganizations()).toBe(true);
    await client.organizations();
    expect(client.createsOrganizations()).toBe(false);
    await client.organizations();
    expect(client.createsOrganizations()).toBe(false);
  });
});
