import { describe, expect, it } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { RECOMMENDED, agentsLabel, isUrlTarget, matchesServer, mcpSettingsOffered, nameError, parseHeaders, recommendedAdded, sharingOrganizations, type McpServerRow } from "./mcpServers";

const KEY = "organization.mcp-servers.v1";

function status(readiness: Record<string, string[]>, organizations: { id: string; role: string; isPersonal?: boolean }[] = []): AccountStatus {
  return { state: "signed-in", phase2Readiness: readiness, organizations: organizations.map((org) => ({ name: `Org ${org.id}`, ...org })) } as unknown as AccountStatus;
}

const row = (name: string, target: string): McpServerRow => ({ key: `local/${name}`, name, target, auth: "none", headerNames: [], agents: { claudeCode: true, codex: false }, sharedBy: null, off: false, shadowed: false, hasSecret: false, clientId: null });

describe("Settings › MCP readiness", () => {
  it("is offered only while an organization reports the key, and off when signed out", () => {
    expect(mcpSettingsOffered(status({}))).toBe(false);
    expect(mcpSettingsOffered(status({ a: ["team.nudges.v1"] }))).toBe(false);
    expect(mcpSettingsOffered(status({ a: [KEY] }))).toBe(true);
    expect(mcpSettingsOffered({ state: "signed-out", phase2Readiness: { a: [KEY] } } as unknown as AccountStatus)).toBe(false);
  });

  it("shares only with ready organizations this person manages", () => {
    const account = status({ a: [KEY], b: [KEY], c: [] }, [{ id: "a", role: "owner" }, { id: "b", role: "member" }, { id: "c", role: "admin" }, { id: "p", role: "owner", isPersonal: true }]);
    expect(sharingOrganizations(account)).toEqual([{ id: "a", name: "Org a" }]);
  });
});

describe("the Add MCP server form", () => {
  it("reads one header per line as Name: value", () => {
    expect(parseHeaders("X-Api-Key: abc\n\nX-Team:  procyon:docs ")).toEqual({ names: ["X-Api-Key", "X-Team"], values: ["abc", "procyon:docs"], error: null });
    expect(parseHeaders("no colon here").error).toBe("Write each header as Name: value.");
    expect(parseHeaders("X-A: 1\nx-a: 2").error).toBe("x-a is listed twice.");
    expect(parseHeaders("  \n").error).toBe("Add at least one header.");
  });

  it("checks names as the agents need them", () => {
    expect(nameError("procyon-docs")).toBeNull();
    expect(nameError("")).toBe("Enter a name.");
    expect(nameError("has space")).not.toBeNull();
    expect(nameError("-leading")).not.toBeNull();
  });

  it("tells URLs from commands", () => {
    expect(isUrlTarget(" https://mcp.linear.app/mcp")).toBe(true);
    expect(isUrlTarget("npx @playwright/mcp@latest")).toBe(false);
  });

  it("names the agents a server is installed for", () => {
    expect(agentsLabel({ claudeCode: true, codex: true })).toBe("Both");
    expect(agentsLabel({ claudeCode: true, codex: false })).toBe("Claude Code");
    expect(agentsLabel({ claudeCode: false, codex: true })).toBe("Codex");
  });
});

describe("search and Recommended", () => {
  it("searches names, URLs and commands", () => {
    expect(matchesServer(row("postgres-dev", "uvx mcp-server-postgres"), "UVX")).toBe(true);
    expect(matchesServer(row("linear", "https://mcp.linear.app/mcp"), "linear.app")).toBe(true);
    expect(matchesServer(row("linear", "https://mcp.linear.app/mcp"), "datadog")).toBe(false);
  });

  it("marks a recommended server added when one installed reaches the same place", () => {
    const linear = RECOMMENDED.find((server) => server.name === "linear")!;
    expect(recommendedAdded(linear, [row("my-linear", "https://mcp.linear.app/mcp/")])).toBe(true);
    expect(recommendedAdded(linear, [row("linear", "https://elsewhere.example/mcp")])).toBe(false);
  });

  it("lists each server once, with a URL or command", () => {
    expect(new Set(RECOMMENDED.map((server) => server.name)).size).toBe(RECOMMENDED.length);
    for (const server of RECOMMENDED) expect(server.target.startsWith("https://") || server.target.startsWith("npx ")).toBe(true);
  });
});
