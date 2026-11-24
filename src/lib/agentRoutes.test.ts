import { describe, expect, it } from "vitest";
import type { AgentRoute, AgentRouteField, AgentRouteTemplate } from "@/lib/api";
import { checkReason, credentialCarriesOver, fieldProblem, listedModels, macCheckLine, routeErrorMessage, routeStatus, routeSummary, templateSettings } from "./agentRoutes";

const route = (fields: Partial<AgentRoute>): AgentRoute => ({
  id: "route_1",
  provider: "claude",
  mode: "custom-endpoint",
  templateId: "claude-gateway",
  templateVersion: 1,
  templateCurrent: true,
  settings: { baseUrl: "https://llm.example.com/anthropic", authScheme: "bearer" },
  credentialStored: true,
  version: 1,
  updatedAt: 1,
  status: "not-checked",
  ...fields,
});

const field = (fields: Partial<AgentRouteField>): AgentRouteField => ({ key: "baseUrl", kind: "url", required: true, label: "Base URL", help: "", ...fields });

describe("agent route words (PRO-18)", () => {
  it("never calls a user-managed route connected before a workspace checked it", () => {
    const helper = route({ mode: "user-managed", templateId: "claude-key-helper", credentialStored: false, settings: { helperPath: "./scripts/key" } });
    expect(routeStatus(helper)).toEqual({ text: expect.stringMatching(/^User managed · not checked yet/), tone: "neutral" });
    expect(routeStatus(helper).text).not.toMatch(/connected/i);
    const failed = routeStatus({ ...helper, status: "failed", lastCheck: { workspaceId: "w", version: 1, checkedAt: 1, outcome: "failed", code: "helper-not-found" } });
    expect(failed).toEqual({ text: "User managed · the last check from a workspace failed: the credential helper is not in the workspace", tone: "warn" });
    expect(routeStatus({ ...helper, status: "connected" })).toMatchObject({ text: expect.stringMatching(/^User managed · working/), tone: "ok" });
    // A custom endpoint is connected only once a workspace reached it with the credential.
    expect(routeStatus(route({})).text).toBe("Saved · not checked from a workspace yet");
    expect(routeStatus(route({ status: "connected" })).tone).toBe("ok");
    expect(routeStatus(route({ status: "unverified", lastCheck: { workspaceId: "w", version: 1, checkedAt: 1, outcome: "unverified", code: "models-unlisted" } })).text).toMatch(
      /could not be checked; the first prompt will tell$/,
    );
  });

  it("says clearly which model an endpoint does not serve, and what it lists", () => {
    const unsupported = route({
      settings: { baseUrl: "https://llm.example.com", authScheme: "bearer", model: "gw-opus" },
      status: "failed",
      lastCheck: { workspaceId: "w", version: 1, checkedAt: 1, outcome: "failed", code: "model-unsupported", models: ["gw-sonnet", "gw-haiku"] },
    });
    expect(routeStatus(unsupported).text).toContain("the endpoint does not list the model gw-opus");
    expect(listedModels(unsupported.lastCheck)).toBe("gw-sonnet, gw-haiku");
    expect(listedModels({ models: Array.from({ length: 15 }, (_, i) => `m${i}`) }, 12)).toMatch(/m11 and 3 more$/);
    expect(macCheckLine({ outcome: "failed", code: "model-unsupported", models: ["gw-sonnet"] }, "gw-opus")).toEqual({
      text: "Checked from this computer: the endpoint does not list the model gw-opus. It lists gw-sonnet.",
      warn: true,
    });
    expect(macCheckLine({ outcome: "ok", httpStatus: 200, models: ["gw-sonnet"] })).toEqual({ text: "Reached from this computer with the credential. It lists gw-sonnet.", warn: false });
  });

  it("shows codes as words and never a code it does not know", () => {
    expect(checkReason("unauthorized")).toBe("the endpoint refused the credential (401)");
    expect(checkReason("redirect")).toMatch(/never followed with a credential/);
    expect(checkReason("sk-secret-in-a-code")).toBe("the check did not pass");
    expect(routeErrorMessage({ code: "cloud_agent_route_credential_required" })).toMatch(/never sent somewhere new/);
    expect(routeErrorMessage({ code: "cloud_agent_route_conflict" })).toMatch(/changed elsewhere/);
    expect(routeErrorMessage(new Error("raw text with sk-secret"))).not.toContain("sk-secret");
  });

  it("checks fields by the service's rules", () => {
    const url = field({});
    expect(fieldProblem(url, "https://llm.example.com/anthropic")).toBeNull();
    expect(fieldProblem(url, "http://127.0.0.1:4000")).toBeNull();
    expect(fieldProblem(url, "http://llm.example.com")).toMatch(/https/);
    expect(fieldProblem(url, "https://llm.example.com/?key=x")).toMatch(/query/);
    expect(fieldProblem(url, "https://u:p@llm.example.com")).toMatch(/user name/);
    expect(fieldProblem(url, "")).toBe("Base URL is required.");
    const model = field({ key: "model", kind: "model", required: false, label: "Model" });
    expect(fieldProblem(model, "")).toBeNull();
    expect(fieldProblem(model, "vendor/model[1m]")).toBeNull();
    expect(fieldProblem(model, "two words")).not.toBeNull();
    const helper = field({ key: "helperPath", kind: "path", label: "Credential helper" });
    expect(fieldProblem(helper, "./scripts/llm-key")).toBeNull();
    for (const bad of ["scripts/key", "./key --x", "./a/../b", "~/key", "./dir/"]) expect(fieldProblem(helper, bad), bad).not.toBeNull();
    const choice = field({ key: "authScheme", kind: "choice", label: "Scheme", choices: [{ value: "bearer", label: "Bearer" }] });
    expect(fieldProblem(choice, "bearer")).toBeNull();
    expect(fieldProblem(choice, "basic")).not.toBeNull();
  });

  it("keeps a stored credential only within its template and origin", () => {
    const stored = route({});
    expect(credentialCarriesOver(stored, "claude-gateway", "https://llm.example.com/other")).toBe(true);
    expect(credentialCarriesOver(stored, "claude-gateway", "https://evil.example.com")).toBe(false);
    expect(credentialCarriesOver(stored, "claude-key-helper", "https://llm.example.com")).toBe(false);
    expect(credentialCarriesOver(route({ credentialStored: false }), "claude-gateway", "https://llm.example.com")).toBe(false);
    expect(credentialCarriesOver(undefined, "claude-gateway", "https://llm.example.com")).toBe(false);
  });

  it("sends only the template's fields, trimmed, with its default choice", () => {
    const template = {
      id: "claude-gateway",
      fields: [field({}), field({ key: "authScheme", kind: "choice", default: "bearer", choices: [{ value: "bearer", label: "B" }] }), field({ key: "model", kind: "model", required: false })],
    } as AgentRouteTemplate;
    expect(templateSettings(template, { baseUrl: " https://x ", model: "", helperPath: "./stray" })).toEqual({ baseUrl: "https://x", authScheme: "bearer" });
    expect(routeSummary(route({ settings: { baseUrl: "https://llm.example.com:8443/a", model: "m" } }), { label: "LLM gateway" } as AgentRouteTemplate)).toBe(
      "LLM gateway · llm.example.com:8443 · model m",
    );
  });
});