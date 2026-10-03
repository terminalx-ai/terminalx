import { describe, expect, it, vi } from "vitest";
import { CloudApi, CloudApiError } from "./api";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function api(answers: (call: Call) => { status?: number; body?: unknown } | Promise<never>, token: string | null = "access-token") {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const answer = await answers(call);
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (answer.body === undefined ? "" : JSON.stringify(answer.body)) } as Response;
  });
  return { client: new CloudApi({ origin: "https://login.terminalx.ai", accessToken: async () => token, fetch: fetcher as never }), calls };
}

const workspace = (fields: Record<string, unknown> = {}) => ({ workspace: { id: "ws-1", orgId: "org-1", name: "fix-login", provider: "box", state: "ready", authority: "participate", you: { role: "driver", canApprove: false, canManageShares: false }, ...fields }, latestOperation: null });

describe("the phone's cloud API client", () => {
  it("lists an organization's workspaces with the account's token and the contract headers, and only reads", async () => {
    const { client, calls } = api(() => ({ body: { workspaces: [workspace()], tombstones: [{ id: "gone", orgId: "org-1", deletedAt: 1, expiresAt: 2 }], quota: { used: 1, limit: 2 } } }));
    const list = await client.workspaces("org-1");
    expect(list.workspaces[0].workspace).toMatchObject({ id: "ws-1", state: "ready", you: { role: "driver" } });
    expect(list.tombstones).toEqual([{ id: "gone", orgId: "org-1", deletedAt: 1, expiresAt: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://login.terminalx.ai/v1/mobile/orgs/org-1/cloud-workspaces" });
    expect(calls[0].headers).toMatchObject({
      authorization: "Bearer access-token",
      "X-TerminalX-Cloud-Workspace-Contract": "providers-v1",
      "X-TerminalX-Cloud-Workspace-Lifecycle": "archive-v1",
    });
  });

  it("refuses a list that names another organization's workspace", async () => {
    const { client } = api(() => ({ body: { workspaces: [workspace({ orgId: "org-2" })] } }));
    await expect(client.workspaces("org-1")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
  });

  it("reads the organizations and the role in each", async () => {
    const { client, calls } = api(() => ({ body: { cloud: { userId: "u" }, organizations: [{ orgId: "org-1", name: "Acme", role: "member" }], capabilities: { flags: {}, refreshedAt: 1 } } }));
    expect(await client.organizations()).toEqual([{ orgId: "org-1", name: "Acme", role: "member" }]);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://login.terminalx.ai/v1/desktop/auth/capabilities", body: {} });
  });

  it("opens with an attach ticket and never asks the provider to reconcile (which could resume compute)", async () => {
    const attachment = { id: "a1", workspaceId: "ws-1", state: "ready", authority: "participate", expiresAt: 9, pairingCode: "code", attachTicket: { v: 1, token: "jwt", expiresAt: 9, runtimeGeneration: 3, protocol: "terminalx-workspace-rpc/1" } };
    const { client, calls } = api(() => ({ status: 202, body: attachment }));
    expect(await client.open("org-1", "ws-1", "install-1")).toMatchObject({ state: "ready", pairingCode: "code", attachTicket: { runtimeGeneration: 3 } });
    await client.open("org-1", "ws-1", "install-1", { refreshPairing: true });
    expect(calls.map((call) => [call.url, call.body])).toEqual([
      ["https://login.terminalx.ai/v1/mobile/orgs/org-1/cloud-workspaces/ws-1/open?attachTicket=1", { clientInstallationId: "install-1" }],
      ["https://login.terminalx.ai/v1/mobile/orgs/org-1/cloud-workspaces/ws-1/open?attachTicket=1", { clientInstallationId: "install-1", refreshPairing: true }],
    ]);
    expect(calls.every((call) => !call.url.includes("reconcileProvider"))).toBe(true);
  });

  it("does not accept an attachment that claims runtime scope for a phone", async () => {
    const { client } = api(() => ({ status: 202, body: { id: "a1", workspaceId: "ws-1", state: "ready", authority: "manage", expiresAt: 9, pairingCode: "code" } }));
    await expect(client.open("org-1", "ws-1", "install-1")).rejects.toThrow();
  });

  it("queues an envelope as it is and reports what it did to the workspace's compute", async () => {
    const envelope = { v: 1 as const, clientCommandId: "c1", tabId: "t1", kind: "send" as const, keyId: "k1", iv: "iv", ciphertext: "ct" };
    const command = { clientCommandId: "c1", tabId: "t1", kind: "send", state: "queued", keyId: "k1", createdAt: 1, updatedAt: 1 };
    const { client, calls } = api(() => ({ status: 202, body: { command, existing: false, wake: "queued" } }));
    expect(await client.enqueue("org-1", "ws-1", envelope)).toEqual({ command, existing: false, wake: "queued" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://login.terminalx.ai/v1/mobile/orgs/org-1/cloud-workspaces/ws-1/agent-commands", body: envelope });
  });

  it("asks for command statuses 100 at a time", async () => {
    const { client, calls } = api((call) => ({ body: { commands: (call.body as { clientCommandIds: string[] }).clientCommandIds.map((clientCommandId) => ({ clientCommandId, tabId: "t", kind: "send", state: "applied", keyId: "k", createdAt: 1, updatedAt: 1 })) } }));
    const ids = Array.from({ length: 230 }, (_, index) => `c${index}`);
    expect(await client.commandStatuses("org-1", "ws-1", ids)).toHaveLength(230);
    expect(calls.map((call) => (call.body as { clientCommandIds: string[] }).clientCommandIds.length)).toEqual([100, 100, 30]);
  });

  it("reads a tab's checkpoint after a cursor, and none is not an error", async () => {
    const checkpoint = { tabId: "t1", epoch: 2, version: 5, schemaVersion: 1, keyId: "k1", sha256: "ab", iv: "iv", ciphertext: "ct" };
    const { client, calls } = api((call) => (call.url.includes("afterEpoch") ? { body: { checkpoint: null } } : call.url.endsWith("/missing") ? { status: 404, body: { error: "cloud_workspace_transcript_checkpoint_not_found" } } : { body: { checkpoint } }));
    expect(await client.checkpoint("org-1", "ws-1", "t1")).toEqual(checkpoint);
    expect(await client.checkpoint("org-1", "ws-1", "t1", { epoch: 2, version: 5 })).toBeNull();
    expect(await client.checkpoint("org-1", "ws-1", "missing")).toBeNull();
    expect(calls[1].url).toBe("https://login.terminalx.ai/v1/mobile/orgs/org-1/cloud-workspaces/ws-1/transcript-checkpoints/t1?afterEpoch=2&afterVersion=5");
  });

  it("reads and changes shares, and treats an answer about someone else as invalid", async () => {
    const share = { userId: "u-alice", email: "alice@example.com", name: "Alice", role: "driver", canApprove: false, createdBy: "u-me", createdAt: 1, updatedAt: 1 };
    const { client, calls } = api((call) => (call.method === "GET" ? { body: { shares: [share], you: { role: "manager", canApprove: true, canManageShares: true } } } : call.method === "PUT" ? { body: { share: call.url.endsWith("u-bob") ? share : { ...share, role: "viewer" }, created: false } } : { body: { share } }));
    expect((await client.shares("org-1", "ws-1")).you).toEqual({ role: "manager", canApprove: true, canManageShares: true });
    expect(await client.putShare("org-1", "ws-1", "u-alice", { role: "viewer", canApprove: false })).toMatchObject({ userId: "u-alice", role: "viewer" });
    expect(calls[1]).toMatchObject({ method: "PUT", body: { v: 1, role: "viewer", canApprove: false } });
    await expect(client.putShare("org-1", "ws-1", "u-bob", { role: "viewer", canApprove: false })).rejects.toMatchObject({ code: "cloud_workspace_invalid_response" });
    await client.revokeShare("org-1", "ws-1", "u-alice");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://login.terminalx.ai/v1/mobile/orgs/org-1/cloud-workspaces/ws-1/shares/u-alice" });
  });

  it("reads the organization's members", async () => {
    const { client, calls } = api(() => ({ body: { members: [{ userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" }, { userId: "u-bob", email: "bob@example.com", role: "admin" }], pendingInvites: [] } }));
    expect((await client.members("org-1")).map((member) => [member.userId, member.displayName ?? null])).toEqual([["u-alice", "Alice"], ["u-bob", null]]);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://login.terminalx.ai/v1/desktop/orgs/org-1/members" });
  });

  it("keeps the server's refusal code, and tells a workspace's answer from an unreachable service", async () => {
    const refused = api(() => ({ status: 404, body: { error: "cloud_workspace_not_found" } }));
    const error = await refused.client.open("org-1", "ws-1", "i").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({ code: "cloud_workspace_not_found", status: 404, unreachable: false });

    const down = api(() => ({ status: 503, body: { error: "cloud_provider_unavailable" } }));
    await expect(down.client.workspaces("org-1")).rejects.toMatchObject({ code: "cloud_provider_unavailable", unreachable: true });

    const offline = api(() => Promise.reject(new Error("Network request failed")));
    await expect(offline.client.workspaces("org-1")).rejects.toMatchObject({ code: "cloud_workspace_unavailable", status: null, unreachable: true });

    // Anything that is not a plain code never reaches the screen as one.
    const odd = api(() => ({ status: 400, body: { error: "<b>bad</b>" } }));
    await expect(odd.client.workspaces("org-1")).rejects.toMatchObject({ code: "cloud_workspace_unavailable" });
  });

  it("reads the server's clock from its answers, for judging expiry on a phone whose clock is off", async () => {
    const calls: unknown[] = [];
    const serverTime = Date.now() - 90_000;
    const fetcher = vi.fn(async () => {
      calls.push(1);
      return { ok: true, status: 200, headers: { get: (name: string) => (name.toLowerCase() === "date" ? new Date(serverTime).toUTCString() : null) }, text: async () => JSON.stringify({ workspaces: [] }) } as unknown as Response;
    });
    const client = new CloudApi({ origin: "https://login.terminalx.ai", accessToken: async () => "t", fetch: fetcher as never });
    expect(Math.abs(client.serverNow() - Date.now())).toBeLessThan(50);
    await client.workspaces("org-1");
    expect(Math.abs(client.serverNow() - serverTime)).toBeLessThan(1_500);
  });

  it("reports an answer in an unknown shape as one code, whatever the call", async () => {
    const { client } = api(() => ({ status: 202, body: { id: "a1", state: "brand-new-state" } }));
    await expect(client.open("org-1", "ws-1", "i")).rejects.toMatchObject({ code: "cloud_workspace_invalid_response", unreachable: false });
    const list = api(() => ({ body: { workspaces: "no" } }));
    await expect(list.client.workspaces("org-1")).rejects.toBeInstanceOf(CloudApiError);
  });

  it("sends nothing while signed out", async () => {
    const { client, calls } = api(() => ({ body: {} }), null);
    await expect(client.workspaces("org-1")).rejects.toMatchObject({ code: "account_signed_out" });
    expect(calls).toEqual([]);
  });
});
