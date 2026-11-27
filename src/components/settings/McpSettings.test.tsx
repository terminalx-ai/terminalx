import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import type { McpImportScan, McpListing, McpServerRow } from "@/lib/mcpServers";
import { McpPage } from "./McpSettings";

const { invoke, calls } = vi.hoisted(() => ({ invoke: vi.fn(), calls: [] as [string, unknown][] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
function account() {
  return {
    status: {
      state: "signed-in",
      organizations: [{ id: "org-p", name: "Procyon Labs", role: "owner" }],
      phase2Readiness: { "org-p": ["organization.mcp-servers.v1"] },
    } as unknown as AccountStatus,
  };
}
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account, subscribeAccount: () => () => {} }));
vi.mock("@/lib/errorToasts", () => ({ showError: vi.fn() }));
vi.mock("@/lib/api", () => ({ errorMessage: (e: unknown) => String(e) }));

const server = (name: string, target: string, extra: Partial<McpServerRow> = {}): McpServerRow => ({
  key: `local/${name}`, name, target, auth: "none", headerNames: [], agents: { claudeCode: true, codex: true }, sharedBy: null, off: false, shadowed: false, offer: null, clash: false, hasSecret: false, clientId: null, ...extra,
});

const INSTALLED: McpServerRow[] = [
  server("linear", "https://mcp.linear.app/mcp", { auth: "oauth", hasSecret: true }),
  server("sentry", "https://mcp.sentry.dev/mcp", { auth: "oauth" }),
  server("playwright", "npx @playwright/mcp@latest", { agents: { claudeCode: true, codex: false } }),
  server("procyon-docs", "https://docs-mcp.example.com", { key: "org-p/s1", auth: "bearer", sharedBy: "org-p", hasSecret: true }),
  server("postgres-dev", "uvx mcp-server-postgres $DATABASE_URL", { agents: { claudeCode: true, codex: false } }),
];
const STATUS: Record<string, unknown> = {
  "local/linear": { state: "connected" },
  "local/sentry": { state: "needsSignIn" },
  "local/playwright": { state: "connected" },
  "org-p/s1": { state: "connected" },
  "local/postgres-dev": { state: "exited", code: 1 },
};
const EMPTY_SCAN: McpImportScan = {
  claudeCode: { files: [{ path: "~/.claude.json", count: null }, { path: "~/.claude/settings.json", count: 0 }], new: [] },
  codex: { files: [{ path: "~/.codex/config.toml", count: null }], new: [] },
};

let listing: McpListing;
let scan: McpImportScan;

beforeEach(() => {
  listing = { servers: INSTALLED, callbackUrl: "http://127.0.0.1:47219/mcp/oauth/callback", problems: [] };
  scan = EMPTY_SCAN;
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    switch (command) {
      case "mcp_servers": return listing;
      case "mcp_server_check": return STATUS[(args as { key: string }).key];
      case "mcp_import_scan": return scan;
      case "mcp_server_save": return listing;
      case "mcp_import": return { added: ["context7"], skipped: [["fromenv", "it reads a header from an environment variable; add it by hand"]], listing };
      default: return listing;
    }
  });
});

afterEach(() => {
  cleanup();
  calls.length = 0;
  vi.clearAllMocks();
});

const saved = () => calls.filter(([command]) => command === "mcp_server_save").map(([, args]) => (args as { input: Record<string, unknown> }).input);

describe("Installed (design 10.09)", () => {
  it("lists each server with its auth, agents and status, and the shared note", async () => {
    render(<McpPage />);
    const table = await screen.findByRole("table", { name: "Installed MCP servers" });
    await waitFor(() => expect(within(table).getByText("Needs sign-in")).toBeTruthy());
    // Opening the page starts no local command: those wait for Check.
    const checked = () => calls.filter(([command]) => command === "mcp_server_check").map(([, args]) => (args as { key: string }).key);
    expect(checked()).not.toContain("local/playwright");
    expect(checked()).not.toContain("local/postgres-dev");
    const postgres = within(table).getByText("postgres-dev").closest("tr")!;
    expect(within(postgres).getByText("Not checked")).toBeTruthy();
    fireEvent.click(within(postgres).getByRole("button", { name: "Check" }));
    await waitFor(() => expect(within(table).getByText("Exited (1)")).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Installed · 5" }).getAttribute("aria-selected")).toBe("true");
    const sentry = within(table).getByText("sentry").closest("tr")!;
    expect(within(sentry).getByText("Needs sign-in")).toBeTruthy();
    expect(within(sentry).getByRole("button", { name: "Sign in" })).toBeTruthy();
    const docs = within(table).getByText("procyon-docs").closest("tr")!;
    expect(within(docs).getByText("Shared")).toBeTruthy();
    expect(within(docs).getByText("Bearer token")).toBeTruthy();
    expect(within(table).getByText("playwright").closest("tr")!.textContent).toContain("Claude Code");
    expect(screen.getByText(/A shared server is offered to everyone in Procyon Labs\. Add it to use it; you can turn it off for yourself, not remove it\./)).toBeTruthy();

    fireEvent.click(within(sentry).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(calls.some(([command, args]) => command === "mcp_server_sign_in" && (args as { key: string }).key === "local/sentry")).toBe(true));
    fireEvent.click(within(within(table).getByText("postgres-dev").closest("tr")!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter(([command, args]) => command === "mcp_server_check" && (args as { key: string }).key === "local/postgres-dev").length).toBe(2));
  });

  it("offers a shared server until it is added, asks again when its URL changes, and shows a name clash", async () => {
    listing = { ...listing, servers: [
      server("team-wiki", "https://wiki.example.com/mcp", { key: "org-p/s2", sharedBy: "org-p", offer: "new" }),
      server("moved", "https://new.example.com/mcp", { key: "org-p/s3", sharedBy: "org-p", offer: "changed", auth: "bearer" }),
      server("docs", "https://docs.example.com/mcp", { clash: true }),
    ] };
    render(<McpPage />);
    const table = await screen.findByRole("table", { name: "Installed MCP servers" });
    const wiki = within(table).getByText("team-wiki").closest("tr")!;
    expect(within(wiki).getByText("Not added")).toBeTruthy();
    expect(within(within(table).getByText("moved").closest("tr")!).getByText("URL changed")).toBeTruthy();
    expect(within(within(table).getByText("docs").closest("tr")!).getByText("Name already used on this Mac")).toBeTruthy();
    expect(calls.filter(([command]) => command === "mcp_server_check")).toEqual([]);
    fireEvent.click(within(wiki).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls).toContainEqual(["mcp_server_add_shared", { key: "org-p/s2" }]));
  });

  it("says when a search matches nothing, and points to Recommended (design 10.17)", async () => {
    render(<McpPage />);
    await screen.findByText("linear");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search installed servers" }), { target: { value: "datadog" } });
    expect(screen.getByText("No installed servers match “datadog”")).toBeTruthy();
    expect(screen.getByText("Searched the names, URLs and commands of your 5 servers.")).toBeTruthy();
    expect(screen.getByText("Datadog is in Recommended")).toBeTruthy();
    expect(screen.getByText("Monitors, logs and incidents · OAuth")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("linear")).toBeTruthy();
  });
});

describe("the Add MCP server form (designs 10.11, 10.12)", () => {
  it("adds a command server for Claude Code only, without authentication", async () => {
    render(<McpPage />);
    await screen.findByText("linear");
    fireEvent.click(screen.getAllByRole("button", { name: "Add MCP server" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remote servers by URL, or a local command such as npx or uvx.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "fetch" } });
    fireEvent.change(within(dialog).getByLabelText("URL or command"), { target: { value: "uvx mcp-server-fetch" } });
    expect(within(dialog).queryByRole("button", { name: "Authentication" })).toBeNull();
    fireEvent.click(within(dialog).getByLabelText("Codex"));
    fireEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ name: "fetch", target: "uvx mcp-server-fetch", auth: "none", agents: { claudeCode: true, codex: false }, organization: null, headerNames: [] });
  });

  it("sends a Bearer token only to be stored, and shares with the organization when asked", async () => {
    render(<McpPage />);
    await screen.findByText("linear");
    fireEvent.click(screen.getByRole("tab", { name: "Recommended" }));
    fireEvent.click(within(await screen.findByRole("group", { name: "GitHub" })).getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("URL or command") as HTMLInputElement).value).toBe("https://api.githubcopilot.com/mcp/");
    expect(within(dialog).getByRole("button", { name: "Authentication" }).textContent).toContain("Bearer token");
    expect(within(dialog).getByText("Stored in the Keychain, sent as Authorization: Bearer.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Token"), { target: { value: "  ghp_secret  " } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Procyon Labs" }));
    fireEvent.keyDown(within(dialog).getByLabelText("Token"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ name: "github", auth: "bearer", organization: "org-p", secret: { token: "ghp_secret" } });
  });

  it("reads Custom headers one per line and refuses a malformed one", async () => {
    render(<McpPage />);
    await screen.findByText("linear");
    fireEvent.click(screen.getAllByRole("button", { name: "Add MCP server" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "internal-search" } });
    fireEvent.change(within(dialog).getByLabelText("URL or command"), { target: { value: "https://search.example.com/mcp" } });
    const picker = within(dialog).getByRole("button", { name: "Authentication" });
    expect(picker.textContent).toContain("OAuth");
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Custom headers/ }));
    fireEvent.change(within(dialog).getByLabelText("Headers"), { target: { value: "oops" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(saved()).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText("Headers"), { target: { value: "X-Api-Key: k1\nX-Team: docs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ auth: "headers", headerNames: ["X-Api-Key", "X-Team"], secret: { headerValues: ["k1", "docs"] } });
  });

  it("keeps an own OAuth client under Advanced client identity, with the callback to allow", async () => {
    render(<McpPage />);
    await screen.findByText("linear");
    fireEvent.click(screen.getAllByRole("button", { name: "Add MCP server" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "sentry2" } });
    fireEvent.change(within(dialog).getByLabelText("URL or command"), { target: { value: "https://mcp.sentry.dev/mcp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Advanced client identity" }));
    expect((within(dialog).getByLabelText("OAuth callback URL") as HTMLInputElement).value).toBe("http://127.0.0.1:47219/mcp/oauth/callback");
    fireEvent.change(within(dialog).getByLabelText("Client ID"), { target: { value: "tx-procyon-sentry" } });
    fireEvent.change(within(dialog).getByLabelText("Client secret"), { target: { value: "s3cret" } });
    expect((within(dialog).getByLabelText("Client secret") as HTMLInputElement).type).toBe("password");
    fireEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ auth: "oauth", clientId: "tx-procyon-sentry", secret: { clientSecret: "s3cret" } });
  });

  it("lets a member set only their own token for a shared server", async () => {
    render(<McpPage />);
    const table = await screen.findByRole("table", { name: "Installed MCP servers" });
    await screen.findByText("procyon-docs");
    const docs = within(table).getByText("procyon-docs").closest("tr")!;
    fireEvent.pointerDown(within(docs).getByRole("button", { name: "procyon-docs actions" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set your token" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("URL or command") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).queryByText("Install for")).toBeNull();
    expect((within(dialog).getByLabelText("Token") as HTMLInputElement).placeholder).toBe("Saved · paste to replace");
  });
});

describe("import (designs 10.10, 10.18)", () => {
  it("offers each agent's servers and says what it brought over", async () => {
    scan = {
      claudeCode: { files: [{ path: "~/.claude.json", count: 4 }, { path: "~/.claude/settings.json", count: null }], new: ["context7", "fromenv"] },
      codex: { files: [{ path: "~/.codex/config.toml", count: 2 }], new: [] },
    };
    render(<McpPage />);
    await screen.findByText("linear");
    fireEvent.click(screen.getByRole("button", { name: "Import from this Mac" }));
    expect(await screen.findByText("4 servers in ~/.claude.json")).toBeTruthy();
    expect(screen.getByText("2 servers in ~/.codex/config.toml")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Linear" })).getByText("Added")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Import from Codex" })).getByText("Added")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Import from Claude Code" })).getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/Imported 1 server\. Left where they were: fromenv/)).toBeTruthy();
    expect(calls).toContainEqual(["mcp_import", { agent: "claudeCode" }]);
    expect(screen.getByRole("tab", { name: "Installed · 5" }).getAttribute("aria-selected")).toBe("true");
  });

  it("says when neither agent has servers, file by file, and looks again", async () => {
    listing = { ...listing, servers: [] };
    render(<McpPage />);
    await screen.findByText("No MCP servers yet");
    fireEvent.click(screen.getByRole("tab", { name: "Recommended" }));
    expect(await screen.findByText("No MCP servers found in ~/.claude.json or ~/.codex/config.toml")).toBeTruthy();
    for (const path of ["~/.claude.json", "~/.claude/settings.json", "~/.codex/config.toml"]) expect(screen.getByText(path)).toBeTruthy();
    expect(screen.queryByText(/^Import from/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Look again" }));
    await waitFor(() => expect(calls.filter(([command]) => command === "mcp_import_scan")).toHaveLength(2));
  });
});
