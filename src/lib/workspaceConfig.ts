import { invoke } from "@tauri-apps/api/core";

// Cloud workspace configuration for the account's active organization
// (PRO-19). Layers apply organization < repository < workspace; every member
// can read the non-secret layers, only owners and admins edit them, and the
// secrets vault is write-only: values go to the server once and come back as
// a mask. Edits carry the account contextRevision and the layer version.

export type ConfigScope = "organization" | "repository" | "workspace";
export type ConfigField = "env" | "prompt" | "mcpServers" | "secrets";
export type ConfigImpact = "new-sessions" | "restart-sessions";
export type SecretRuntimeAccess = "private-workspaces" | "all-workspaces";

export interface MemberOverrides {
  env: boolean;
  prompt: boolean;
  mcpServers: boolean;
}

export interface ConfigLayer {
  scope: ConfigScope;
  scopeKey: string;
  version: number;
  env: Record<string, string>;
  prompt: string | null;
  mcpServers: unknown[];
  memberOverrides: MemberOverrides | null;
  lockedEnvKeys: string[];
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface OrganizationConfigView {
  organization: ConfigLayer;
  repositories: ConfigLayer[];
  canEdit: boolean;
  fieldImpact: Record<ConfigField, ConfigImpact>;
  contextRevision: string;
}

export interface WriteImpact {
  changed: ConfigField[];
  runningSessions: "restart-required" | "unaffected";
  rebuildRequired: boolean;
}

export interface ConfigWriteResult {
  layer: ConfigLayer;
  impact: WriteImpact;
  contextRevision: string;
}

export interface SecretBinding {
  id: string;
  scope: ConfigScope;
  scopeKey: string;
  envName: string;
  createdAt: number;
}

export interface SecretSummary {
  id: string;
  name: string;
  version: number;
  runtimeAccess: SecretRuntimeAccess;
  value: string;
  updatedAt: number;
  bindings: SecretBinding[];
}

export interface SecretsView {
  secrets: SecretSummary[];
  canEdit: boolean;
  contextRevision: string;
}

export interface LayerEdit {
  expectedVersion: number;
  env: Record<string, string>;
  prompt: string | null;
  mcpServers: unknown[];
}

export interface OrganizationLayerEdit extends LayerEdit {
  memberOverrides: MemberOverrides;
  lockedEnvKeys: string[];
}

const DEFAULT_IMPACT: Record<ConfigField, ConfigImpact> = {
  env: "restart-sessions",
  prompt: "new-sessions",
  mcpServers: "restart-sessions",
  secrets: "restart-sessions",
};
const DEFAULT_OVERRIDES: MemberOverrides = { env: true, prompt: true, mcpServers: false };

const unavailable = () => ({ code: "cloud_workspace_config_unavailable", status: null, retryAfterSeconds: null });
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stringRecord = (value: unknown): Record<string, string> =>
  isObject(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
const revisionOf = (value: Record<string, unknown>) => (typeof value.contextRevision === "string" ? value.contextRevision : "");

export function normalizeLayer(value: unknown): ConfigLayer {
  if (!isObject(value) || typeof value.version !== "number") throw unavailable();
  const overrides = isObject(value.memberOverrides) ? value.memberOverrides : null;
  const scope = value.scope === "repository" || value.scope === "workspace" ? value.scope : "organization";
  return {
    scope,
    scopeKey: typeof value.scopeKey === "string" ? value.scopeKey : "",
    version: value.version,
    env: stringRecord(value.env),
    prompt: typeof value.prompt === "string" ? value.prompt : null,
    mcpServers: Array.isArray(value.mcpServers) ? value.mcpServers : [],
    memberOverrides:
      scope !== "organization"
        ? null
        : overrides
          ? { env: overrides.env === true, prompt: overrides.prompt === true, mcpServers: overrides.mcpServers === true }
          : { ...DEFAULT_OVERRIDES },
    lockedEnvKeys: Array.isArray(value.lockedEnvKeys) ? value.lockedEnvKeys.filter((key): key is string => typeof key === "string") : [],
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : null,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
  };
}

export function normalizeOrganizationView(value: unknown): OrganizationConfigView {
  if (!isObject(value)) throw unavailable();
  return {
    organization: normalizeLayer(value.organization),
    repositories: Array.isArray(value.repositories) ? value.repositories.flatMap((layer) => (isObject(layer) && typeof layer.version === "number" ? [normalizeLayer(layer)] : [])) : [],
    canEdit: value.canEdit === true,
    fieldImpact: { ...DEFAULT_IMPACT, ...(isObject(value.fieldImpact) ? (value.fieldImpact as Partial<Record<ConfigField, ConfigImpact>>) : {}) },
    contextRevision: revisionOf(value),
  };
}

export function normalizeWriteResult(value: unknown): ConfigWriteResult {
  if (!isObject(value) || !isObject(value.impact)) throw unavailable();
  return {
    layer: normalizeLayer(value.layer),
    impact: {
      changed: Array.isArray(value.impact.changed) ? (value.impact.changed as ConfigField[]) : [],
      runningSessions: value.impact.runningSessions === "restart-required" ? "restart-required" : "unaffected",
      rebuildRequired: value.impact.rebuildRequired === true,
    },
    contextRevision: revisionOf(value),
  };
}

export function normalizeSecretsView(value: unknown): SecretsView {
  if (!isObject(value) || !Array.isArray(value.secrets)) throw unavailable();
  return {
    secrets: value.secrets.filter(isObject).map((secret) => ({
      id: String(secret.id ?? ""),
      name: String(secret.name ?? ""),
      version: typeof secret.version === "number" ? secret.version : 0,
      runtimeAccess: secret.runtimeAccess === "all-workspaces" ? "all-workspaces" : "private-workspaces",
      // Whatever a server sends, the webview only ever shows a mask.
      value: "********",
      updatedAt: typeof secret.updatedAt === "number" ? secret.updatedAt : 0,
      bindings: Array.isArray(secret.bindings) ? (secret.bindings.filter(isObject) as unknown as SecretBinding[]) : [],
    })),
    canEdit: value.canEdit === true,
    contextRevision: revisionOf(value),
  };
}

export const workspaceConfig = {
  organization: () => invoke<unknown>("workspace_config_organization").then(normalizeOrganizationView),
  updateOrganization: (layer: OrganizationLayerEdit, contextRevision: string) =>
    invoke<unknown>("workspace_config_organization_update", { layer, contextRevision }).then(normalizeWriteResult),
  updateRepository: (repository: string, layer: LayerEdit, contextRevision: string) =>
    invoke<unknown>("workspace_config_repository_update", { layer: { ...layer, repository }, contextRevision }).then(normalizeWriteResult),
  secrets: () => invoke<unknown>("workspace_config_secrets").then(normalizeSecretsView),
  putSecret: (name: string, value: string, runtimeAccess: SecretRuntimeAccess, contextRevision: string) =>
    invoke<unknown>("workspace_config_secret_put", { name, value, runtimeAccess, contextRevision }).then(normalizeSecretsView),
  deleteSecret: (name: string, contextRevision: string) => invoke<unknown>("workspace_config_secret_delete", { name, contextRevision }).then(normalizeSecretsView),
  bindSecret: (name: string, scope: ConfigScope, target: string, envName: string, contextRevision: string) =>
    invoke<unknown>("workspace_config_secret_bind", { name, scope, target, envName, contextRevision }).then(normalizeSecretsView),
  unbindSecret: (bindingId: string, contextRevision: string) =>
    invoke<unknown>("workspace_config_secret_unbind", { bindingId, contextRevision }).then(normalizeSecretsView),
};

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRET_LOOKING = /TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API_KEY/;

/** `KEY=value` per line, blank lines ignored. Errors name the first bad line. */
export function parseEnvText(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const split = line.indexOf("=");
    const key = split > 0 ? line.slice(0, split).trim() : "";
    if (!ENV_NAME.test(key)) return { error: `Line ${index + 1}: use NAME=value with an upper-case NAME.` };
    if (SECRET_LOOKING.test(key)) return { error: `${key} looks like a secret. Store it in Secrets and bind it instead.` };
    env[key] = line.slice(split + 1);
  }
  return { env };
}

export const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

export function parseMcpText(text: string): { servers: unknown[] } | { error: string } {
  if (!text.trim()) return { servers: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? { servers: parsed } : { error: "MCP servers must be a JSON array." };
  } catch {
    return { error: "MCP servers must be valid JSON." };
  }
}

export const isEnvName = (name: string) => ENV_NAME.test(name);

export function impactMessage(impact: WriteImpact): string {
  if (!impact.changed.length) return "Saved. Nothing changed.";
  const running = impact.runningSessions === "restart-required" ? "Running agent sessions keep their old settings until they are restarted." : "Running agent sessions are unaffected.";
  return `Saved. New agent sessions use it at once. ${running} No rebuild is needed.`;
}

export const IMPACT_LABEL: Record<ConfigImpact, string> = {
  "new-sessions": "applies to new sessions",
  "restart-sessions": "running sessions need a restart",
};

export function scopeLabel(scope: ConfigScope, scopeKey: string): string {
  if (scope === "organization") return "Organization";
  return scope === "repository" ? scopeKey : `Workspace ${scopeKey}`;
}

export function configErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "organization_admin_required":
      return "Only organization owners and admins can change workspace configuration and secrets.";
    case "cloud_workspace_config_conflict":
      return "Someone else changed this configuration. The latest version has been loaded; review it and try again.";
    case "cloud_workspace_config_env_invalid":
      return "A variable was refused. Names must be upper case, values at most 8 KB, and anything secret-looking belongs in Secrets.";
    case "cloud_workspace_config_mcp_invalid":
      return "An MCP server was refused. Commands must run from PATH, the workspace or a system bin directory, never a shell or a home directory, and credentials go in secret references.";
    case "cloud_workspace_config_secret_missing":
      return "An MCP server refers to a secret that does not exist. Add the secret first.";
    case "cloud_workspace_config_override_denied":
      return "That setting is locked by the organization or not open to member overrides.";
    case "cloud_workspace_secret_invalid":
      return "That secret was refused. Use an upper-case name the runtime does not reserve and a value of at most 8 KB.";
    case "cloud_workspace_secret_not_found":
      return "That secret no longer exists. The list has been refreshed.";
    case "cloud_workspace_secret_binding_conflict":
      return "That variable is already bound at this scope.";
    case "cloud_workspace_request_invalid":
      return "That request was not valid. Check the values and try again.";
    case "cloud_workspace_config_outcome_unknown":
    case "account_context_changed_after_send":
      return "TerminalX lost the response, so the change may or may not have been applied. The view has been refreshed; check it before trying again.";
    case "account_context_changed":
      return "Your account or organization changed. The view has been refreshed.";
    case "account_signed_out":
      return "Sign in to manage workspace configuration.";
    case "account_organization_unavailable":
    case "active_organization_required":
      return "Select an organization to manage its workspace configuration.";
    case "invalid_access_token":
      return "Your session expired. Sign in again.";
    default:
      return "TerminalX could not reach the account service. Try again.";
  }
}
