import { describe, expect, it } from "vitest";
import { emptyMcpDraft, mcpFormInput, normalizeMcpImport, normalizeMcpView } from "./organizationMcp";

const draft = () => ({ ...emptyMcpDraft(), name: "docs", url: "https://docs.example/mcp" });
describe("organisation MCP form", () => {
  it("supports OAuth, none, bearer and custom headers without storing secrets in summaries", () => {
    expect(mcpFormInput(draft())).toEqual({ name: "docs", url: "https://docs.example/mcp", auth: "oauth", expectedVersion: 0 });
    expect(mcpFormInput({ ...draft(), auth: "none" }).auth).toBe("none");
    expect(mcpFormInput({ ...draft(), auth: "bearer", bearer: "fixture" }).bearer).toBe("fixture");
    expect(mcpFormInput({ ...draft(), auth: "headers", headers: "X-API-Key: fixture\nX-Tenant: acme" }).headers).toEqual({ "X-API-Key": "fixture", "X-Tenant": "acme" });
  });
  it("rejects missing auth, unsafe URLs and reserved or duplicate headers", () => {
    for (const url of ["http://a.example", "https://u:p@a.example", "https://a.example?token=x", "https://a.example#x"]) expect(() => mcpFormInput({ ...draft(), url })).toThrow();
    expect(() => mcpFormInput({ ...draft(), auth: "bearer" })).toThrow("Enter a bearer token");
    for (const headers of ["Host: other.example", "Connection: close", "X-Key: a\nx-key: b", "invalid"]) expect(() => mcpFormInput({ ...draft(), auth: "headers", headers })).toThrow();
  });
  it("preserves write-only secrets only for an unchanged identity", () => {
    const previous = { id: "mcp-1", name: "docs", url: draft().url, version: 4, auth: "bearer" as const, status: "connected" as const, checkedAt: 1, hasClientIdentity: false };
    expect(mcpFormInput({ ...draft(), auth: "bearer" }, previous)).toEqual({ name: "docs", url: draft().url, auth: "bearer", expectedVersion: 4 });
    expect(() => mcpFormInput({ ...draft(), auth: "bearer", url: "https://other.example" }, previous)).toThrow();
  });
  it("keeps explicit client identity replacement separate from a normal edit", () => {
    expect(() => mcpFormInput({ ...draft(), clientSecret: "x" })).toThrow("client ID");
    expect(mcpFormInput({ ...draft(), clientId: "client", clientSecret: "secret", scope: "read" })).toMatchObject({ clientId: "client", clientSecret: "secret", scope: "read" });
  });
});
it("allowlists metadata returned to the view and import preview", () => {
  const imported = normalizeMcpImport({ servers: [{ name: "docs", url: draft().url, requiresAuth: true, access_token: "never", headers: { Authorization: "never" } }], skipped: 2, secret: "never" });
  expect(JSON.stringify(imported)).not.toContain("never");
  expect(imported.skipped).toBe(2);
  const view = normalizeMcpView({ contextRevision: "rev", canEdit: false, servers: [{ id: "mcp", name: "docs", url: draft().url, auth: "oauth", version: 1, status: "needs-reauth", accessToken: "never", clientSecret: "never" }] });
  expect(view.servers[0].status).toBe("needs-reauth");
  expect(JSON.stringify(view)).not.toContain("never");
});
