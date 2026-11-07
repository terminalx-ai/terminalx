import { invoke } from "@tauri-apps/api/core";

export type McpAuth = "none" | "oauth" | "bearer" | "headers";
export type McpStatus = "connected" | "needs-reauth" | "error";
export interface OrganizationMcpServer {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  version: number;
  status: McpStatus;
  checkedAt: number | null;
  hasClientIdentity: boolean;
}
export interface McpView { oauthRedirectUri?: string | null; servers: OrganizationMcpServer[]; canEdit: boolean; contextRevision: string }
export interface McpDraft {
  name: string;
  url: string;
  auth: McpAuth;
  bearer: string;
  headers: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  replaceIdentity: boolean;
}
export interface McpInput {
  name: string;
  url: string;
  auth: McpAuth;
  expectedVersion: number;
  bearer?: string;
  headers?: Record<string, string>;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}
export interface McpImport { servers: { name: string; url: string; requiresAuth: boolean }[]; skipped: number }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const unavailable = () => new Error("MCP servers are unavailable. Update the account service and try again.");
export const emptyMcpDraft = (): McpDraft => ({ name: "", url: "", auth: "oauth", bearer: "", headers: "", clientId: "", clientSecret: "", scope: "", replaceIdentity: false });
export const MCP_STATUS_LABELS: Record<McpStatus, string> = { connected: "Connected", "needs-reauth": "Needs re-auth", error: "Error" };

export function normalizeMcpView(value: unknown): McpView {
  if (!object(value) || !Array.isArray(value.servers) || typeof value.contextRevision !== "string") throw unavailable();
  return {
    canEdit: value.canEdit === true,
    oauthRedirectUri: typeof value.oauthRedirectUri === "string" ? value.oauthRedirectUri : null,
    contextRevision: value.contextRevision,
    servers: value.servers.map((row) => {
      if (!object(row) || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.url !== "string" || typeof row.version !== "number" || !["oauth", "bearer", "headers", "none"].includes(String(row.auth))) throw unavailable();
      return { id: row.id, name: row.name, url: row.url, version: row.version, auth: row.auth as McpAuth, status: row.status === "connected" || row.status === "needs-reauth" ? row.status : "error", checkedAt: typeof row.checkedAt === "number" ? row.checkedAt : null, hasClientIdentity: row.hasClientIdentity === true };
    }),
  };
}
export function normalizeMcpImport(value: unknown): McpImport {
  if (!object(value) || !Array.isArray(value.servers)) throw new Error("Could not read ~/.claude.json.");
  return { servers: value.servers.flatMap((row) => object(row) && typeof row.name === "string" && typeof row.url === "string" ? [{ name: row.name, url: row.url, requiresAuth: row.requiresAuth === true }] : []), skipped: typeof value.skipped === "number" ? value.skipped : 0 };
}
export function mcpFormInput(draft: McpDraft, previous?: OrganizationMcpServer): McpInput {
  const name = draft.name.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("Use up to 64 lower-case letters, digits, hyphens or underscores for the name.");
  let url: URL;
  try { url = new URL(draft.url.trim()); } catch { throw new Error("Enter a valid HTTPS server URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS URL without credentials, query parameters or a fragment.");
  const result: McpInput = { name, url: url.href, auth: draft.auth, expectedVersion: previous?.version ?? 0 };
  const preserves = previous?.url === result.url && previous.auth === result.auth;
  if (draft.auth === "bearer") {
    if (draft.bearer) result.bearer = draft.bearer;
    else if (!preserves) throw new Error("Enter a bearer token.");
  }
  if (draft.auth === "headers") {
    if (draft.headers.trim()) {
      const headers: Record<string, string> = {};
      for (const line of draft.headers.split("\n").filter((line) => line.trim())) {
        const split = line.indexOf(":");
        const key = line.slice(0, split).trim();
        const value = line.slice(split + 1).trim();
        if (split < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /^(host|connection|content-length|transfer-encoding|proxy-.*|cookie|set-cookie|upgrade|trailer|te)$/i.test(key) || !value || /[\r\0]/.test(value)) throw new Error("Use one allowed Header-Name: value per line.");
        if (Object.keys(headers).some((existing) => existing.toLowerCase() === key.toLowerCase())) throw new Error("Header names must be unique.");
        headers[key] = value;
      }
      if (Object.keys(headers).length > 32) throw new Error("Use at most 32 custom headers.");
      result.headers = headers;
    } else if (!preserves) throw new Error("Enter at least one custom header.");
  }
  if (draft.auth === "oauth" && (!preserves || draft.replaceIdentity || draft.clientId || draft.clientSecret || draft.scope)) {
    if (draft.clientSecret && !draft.clientId) throw new Error("A client secret also requires a client ID.");
    if (draft.clientId || draft.replaceIdentity) result.clientId = draft.clientId.trim();
    if (draft.clientSecret || draft.replaceIdentity) result.clientSecret = draft.clientSecret;
    if (draft.scope || draft.replaceIdentity) result.scope = draft.scope.trim();
  }
  return result;
}
export function mcpError(error: unknown): string {
  const code = object(error) ? error.code : undefined;
  switch (code) {
    case "organization_admin_required": return "Only organisation owners and admins can manage MCP servers.";
    case "organization_mcp_conflict": return "This server changed, or its name is already installed. Refresh and try again.";
    case "organization_mcp_invalid": return "The server settings were refused. Check the HTTPS URL and authentication fields.";
    case "organization_mcp_oauth_failed": return "Sign-in failed. Check the server’s OAuth support and client identity, then try again.";
    case "organization_mcp_import_failed": return "Could not read ~/.claude.json. Check that it contains valid JSON and is under 2 MB.";
    case "account_context_changed": case "account_context_changed_after_send": return "Your account or organisation changed. Refresh the list before trying again.";
    default: return error instanceof Error ? error.message : "Could not reach MCP settings. Refresh and try again.";
  }
}
const action = (action: string, id: string | null, input: unknown, contextRevision: string) => invoke<unknown>("organization_mcp_action", { action, id, input, contextRevision });
export const organizationMcp = {
  list: () => invoke<unknown>("organization_mcp_servers").then(normalizeMcpView),
  save: (input: McpInput, id: string | null, revision: string) => action("save", id, input, revision).then(normalizeMcpView),
  remove: (server: OrganizationMcpServer, revision: string) => action("delete", server.id, { expectedVersion: server.version }, revision).then(normalizeMcpView),
  signIn: async (server: OrganizationMcpServer, revision: string) => {
    const value = await action("sign-in", server.id, { expectedVersion: server.version }, revision);
    if (!object(value) || typeof value.authorizationUrl !== "string") throw unavailable();
    const url = new URL(value.authorizationUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw unavailable();
    return url.href;
  },
  import: () => invoke<unknown>("organization_mcp_import").then(normalizeMcpImport),
};
