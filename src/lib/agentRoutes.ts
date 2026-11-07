import type { AgentRoute, AgentRouteCheckResult, AgentRouteField, AgentRouteSettings, AgentRouteTemplate } from "@/lib/api";

/**
 * Words for a member's own agent model routes (PRO-18): what a route's
 * checks found, why one was refused, and the field rules the account
 * service applies, checked here first so a form says what is wrong before
 * anything is asked for or sent. The service decides; nothing here widens
 * what it accepts.
 *
 * A check is reported as codes and model ids only. Nothing an endpoint
 * answered or a helper printed ever reaches the page, so no text here can
 * carry a credential.
 */

const PLACE = "Settings → Organizations → Your model access";

/** What a check's code means. A code this app does not know is never shown as is. */
export function checkReason(code: string | undefined, model?: string): string {
  switch (code) {
    case "unauthorized":
      return "the endpoint refused the credential (401)";
    case "forbidden":
      return "the endpoint refused the credential for its model list (403)";
    case "not-found":
    case "models-unlisted":
      return "the endpoint has no model list, so the credential could not be checked";
    case "rate-limited":
      return "the endpoint is rate limiting (429)";
    case "http-error":
      return "the endpoint answered with an error";
    case "bad-response":
      return "the endpoint did not answer like a model API";
    case "redirect":
      return "the endpoint answered with a redirect, which is never followed with a credential";
    case "unreachable":
      return "the endpoint could not be reached";
    case "timeout":
      return "the endpoint did not answer in time";
    case "tls":
      return "the endpoint's certificate was not accepted";
    case "model-unsupported":
      return model ? `the endpoint does not list the model ${model}` : "the endpoint does not list the route's model";
    case "helper-not-found":
      return "the credential helper is not in the workspace";
    case "helper-not-executable":
      return "the credential helper is not executable";
    case "helper-failed":
      return "the credential helper failed";
    case "helper-timeout":
      return "the credential helper did not finish in time";
    case "helper-empty":
      return "the credential helper printed nothing";
    case "helper-output":
      return "the credential helper printed more than one credential";
    case "template-unsupported":
      return "the workspace's TerminalX does not apply this template version";
    default:
      return "the check did not pass";
  }
}

/** The models a check listed, for a line under the route. */
export function listedModels(check: Pick<AgentRouteCheckResult, "models"> | undefined, limit = 12): string | null {
  const models = check?.models ?? [];
  if (!models.length) return null;
  const shown = models.slice(0, limit).join(", ");
  return models.length > limit ? `${shown} and ${models.length - limit} more` : shown;
}

/**
 * What a route row says, and whether it needs attention. A custom endpoint
 * is connected once a workspace read its model list with the credential. A
 * user-managed route is never called connected before that: it is "user
 * managed" until a workspace ran the helper and its credential worked.
 */
export function routeStatus(route: AgentRoute): { text: string; tone: "ok" | "neutral" | "warn" } {
  const helper = route.mode === "user-managed";
  const lead = helper ? "User managed" : "Your endpoint";
  const check = route.lastCheck;
  switch (route.status) {
    case "connected":
      if (route.templateId === "claude-bedrock") return { text: "Amazon Bedrock accepted the test model from the account service. New sessions use this route.", tone: "ok" };
      return { text: helper ? "User managed · working: a workspace ran the helper and the endpoint accepted its credential" : "Connected: a workspace reached the endpoint with the credential", tone: "ok" };
    case "unverified":
      return {
        text: `${lead} · reached from a workspace, but ${checkReason(check?.code)}${helper ? "" : "; the first prompt will tell"}`,
        tone: "neutral",
      };
    case "failed":
      return { text: `${lead} · the last check from a workspace failed: ${checkReason(check?.code, route.settings.model)}`, tone: "warn" };
    default:
      return {
        text: helper ? "User managed · not checked yet: a workspace checks it when it gets the route or starts the agent" : "Saved · not checked from a workspace yet",
        tone: "neutral",
      };
  }
}

/** What this Mac's check before saving found, in words. */
export function macCheckLine(check: AgentRouteCheckResult, model?: string): { text: string; warn: boolean } {
  if (check.outcome === "ok") {
    const models = listedModels(check, 8);
    return { text: `Reached from this Mac with the credential.${models ? ` It lists ${models}.` : ""}`, warn: false };
  }
  if (check.outcome === "unverified") {
    return { text: `Reached from this Mac, but ${checkReason(check.code)}. Saved; the workspace checks it again.`, warn: false };
  }
  const models = check.code === "model-unsupported" ? listedModels(check, 8) : null;
  return { text: `Checked from this Mac: ${checkReason(check.code, model)}.${models ? ` It lists ${models}.` : ""}`, warn: true };
}

/** Why a route change was refused, in words. */
export function routeErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  switch (code) {
    case "cloud_agent_route_template_unknown":
      return "This server does not offer that endpoint type for this agent. Refresh and choose again. Nothing was changed.";
    case "cloud_agent_route_base_url_invalid":
      return "The base URL must be an https address (or http to the workspace itself), without a user name, query or fragment. Nothing was changed.";
    case "cloud_agent_route_model_invalid":
      return "Enter the model as the endpoint names it: one word, without spaces. Nothing was changed.";
    case "cloud_agent_route_helper_invalid":
      return "The credential helper must be one executable path, ./relative or absolute, without spaces, arguments or .. segments. Put arguments in a script. Nothing was changed.";
    case "cloud_agent_route_credential_invalid":
      return "The credential format is invalid. Check all required fields; temporary AWS keys need their session token. Nothing was changed.";
    case "cloud_agent_route_credential_required":
      return "Enter the credential: the endpoint type or its address changed, and a stored credential is never sent somewhere new. Nothing was changed.";
    case "cloud_agent_route_conflict":
      return "Your route for this agent changed elsewhere meanwhile. Refresh to see it, then try again. Nothing was changed.";
    case "cloud_agent_route_bedrock_unauthorized":
      return "Amazon Bedrock refused the credentials (UnrecognizedClient, InvalidSignature or expired token). Check the keys and session token. Nothing was saved.";
    case "cloud_agent_route_bedrock_forbidden":
      return "Amazon Bedrock returned AccessDenied (403). Check model access and bedrock:InvokeModel permission. Nothing was saved.";
    case "cloud_agent_route_bedrock_quota":
      return "Amazon Bedrock returned ServiceQuotaExceeded. Ask an organisation admin to raise the quota or switch logins. Nothing was saved.";
    case "cloud_agent_route_bedrock_throttled":
      return "Amazon Bedrock is temporarily throttling requests. Try again later. Nothing was saved.";
    case "cloud_agent_route_bedrock_model":
      return "Amazon Bedrock refused the test model (ValidationException or not found). Check its ID and region. Nothing was saved.";
    case "cloud_agent_route_bedrock_unavailable":
      return "Amazon Bedrock did not complete the test. Try again later. Nothing was saved.";
    case "cloud_agent_route_invalid":
      return "That is not a setting this endpoint type takes. Nothing was changed.";
    case "cloud_workspace_not_found":
      return "You are no longer a member of this organization.";
    case "cloud_provider_entry_cancelled":
      return "Credential entry canceled. Nothing was changed.";
    case "cloud_provider_credential_required":
      return "No credential was entered. Nothing was changed.";
    case "cloud_provider_secure_input_unavailable":
      return "The secure dialog for the credential is not available on this computer.";
    case "cloud_provider_operation_in_progress":
      return "Another route is being saved. Wait for it to finish.";
    case "account_context_changed":
    case "account_context_changed_after_send":
      return "The account or organization changed. Refresh before trying again.";
    case "cloud_organization_unavailable":
      return "This organization can't be reached from here: you may no longer be a member. Refresh.";
    default:
      return "The request could not be confirmed. Refresh to see what is saved, then try again.";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The same rule as the service: `https`, or `http` to the workspace itself; no userinfo, query or fragment. */
export function baseUrlProblem(value: string): string | null {
  if (value.length > 512 || /[\s?#]/.test(value)) return "Use an address without spaces, a query or a fragment.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full address, such as https://llm.example.com.";
  }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) return "Use https (http only to the workspace itself: localhost or 127.0.0.1).";
  if (url.username || url.password) return "Leave the user name and password out; the credential has its own field.";
  return null;
}

export function modelProblem(value: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/.test(value) && !value.includes("..") ? null : "One model id as the endpoint lists it, without spaces.";
}

export function helperProblem(value: string): string | null {
  const shape = /^(\.\/|\/)[A-Za-z0-9._/-]+$/.test(value) && value.length <= 256 && !value.endsWith("/") && !value.includes("//");
  const segments = value.split("/").slice(1);
  return shape && !segments.some((segment) => segment === ".." || segment === ".")
    ? null
    : "One executable path, ./relative or absolute, without spaces or arguments (put those in a script).";
}

/** What is wrong with a field's value, or null. Empty optional fields are fine. */
export function fieldProblem(field: AgentRouteField, raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return field.required ? `${field.label} is required.` : null;
  switch (field.kind) {
    case "region":
      return /^(us|eu|ap|sa|ca|me|af|il|mx|cn)-(gov-)?[a-z]+-\d$/.test(value) ? null : "Enter an AWS region, such as us-east-1.";
    case "url":
      return baseUrlProblem(value);
    case "model":
      return modelProblem(value);
    case "path":
      return helperProblem(value);
    case "choice":
      return field.choices?.some((choice) => choice.value === value) ? null : `Choose one of the ${field.label.toLowerCase()} options.`;
  }
}

/** The settings a template takes, trimmed, with empty optional fields left out. */
export function templateSettings(template: AgentRouteTemplate, values: AgentRouteSettings): AgentRouteSettings {
  const settings: AgentRouteSettings = {};
  for (const field of template.fields) {
    const value = (values[field.key] ?? (field.kind === "choice" ? field.default : "") ?? "").trim();
    if (value) settings[field.key] = value;
  }
  return settings;
}

function originOf(value: string | undefined): string | null {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether the stored credential may stay with these settings: the same
 * template and the same origin, as the service requires. Otherwise it has
 * to be entered again, so a credential is never sent somewhere new.
 */
export function credentialCarriesOver(route: AgentRoute | undefined, templateId: string, baseUrl: string | undefined): boolean {
  if (!route?.credentialStored || route.templateId !== templateId) return false;
  const stored = originOf(route.settings.baseUrl);
  return stored !== null && stored === originOf(baseUrl?.trim());
}

/** A short line naming what a route uses. */
export function routeSummary(route: AgentRoute, template: AgentRouteTemplate | undefined): string {
  const parts = [template?.label ?? `${route.templateId} (version ${route.templateVersion})`];
  const host = originOf(route.settings.baseUrl);
  if (host) parts.push(new URL(host).host);
  if (route.settings.region) parts.push(route.settings.region);
  if (route.settings.helperPath) parts.push(`helper ${route.settings.helperPath}`);
  if (route.settings.model) parts.push(`model ${route.settings.model}`);
  return parts.join(" · ");
}

export { PLACE as AGENT_ROUTES_PLACE };