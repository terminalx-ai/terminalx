import { expect, it } from "vitest";
import { impactMessage, normalizeOrganizationView, normalizeSecretsView, parseEnvText, parseMcpText } from "./workspaceConfig";

it("parses NAME=value lines and sends secret-looking names to the vault", () => {
  expect(parseEnvText("NODE_ENV=test\n\nURL=https://x?a=b")).toEqual({ env: { NODE_ENV: "test", URL: "https://x?a=b" } });
  expect(parseEnvText("lower=1")).toEqual({ error: expect.stringContaining("Line 1") });
  expect(parseEnvText("NPM_TOKEN=abc")).toEqual({ error: expect.stringContaining("Secrets") });
});

it("requires MCP servers as a JSON array", () => {
  expect(parseMcpText("")).toEqual({ servers: [] });
  expect(parseMcpText('[{"name":"docs"}]')).toEqual({ servers: [{ name: "docs" }] });
  expect(parseMcpText("{}")).toHaveProperty("error");
  expect(parseMcpText("nope")).toHaveProperty("error");
});

it("defaults what a server leaves out and never shows a secret value", () => {
  const view = normalizeOrganizationView({ organization: { version: 0 }, canEdit: true, contextRevision: "rev" });
  expect(view.organization).toMatchObject({ env: {}, memberOverrides: { env: true, prompt: true, mcpServers: false }, lockedEnvKeys: [] });
  expect(view.fieldImpact.prompt).toBe("new-sessions");
  const secrets = normalizeSecretsView({ secrets: [{ id: "s", name: "NPM_TOKEN", value: "leaked", bindings: [] }], canEdit: true });
  expect(secrets.secrets[0].value).toBe("********");
  expect(() => normalizeOrganizationView(null)).toThrow();
});

it("says what a save means for running sessions", () => {
  expect(impactMessage({ changed: ["env"], runningSessions: "restart-required", rebuildRequired: false })).toContain("until they are restarted");
  expect(impactMessage({ changed: ["prompt"], runningSessions: "unaffected", rebuildRequired: false })).toContain("unaffected");
  expect(impactMessage({ changed: [], runningSessions: "unaffected", rebuildRequired: false })).toContain("Nothing changed");
});
