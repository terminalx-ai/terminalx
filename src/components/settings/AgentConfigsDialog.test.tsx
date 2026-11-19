import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigChange, AgentConfigComparison, AgentConfigItem, AgentConfigPreview } from "@/types/agentConfigs";
import { AgentConfigsDialog, defaultDirection, initialSelection } from "./AgentConfigsDialog";

const mock = vi.hoisted(() => ({ compare: vi.fn(), preview: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/api", () => ({
  agentConfigs: { compare: mock.compare, preview: mock.preview, apply: mock.apply },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const item = (over: Partial<AgentConfigItem> & Pick<AgentConfigItem, "kind" | "name" | "status">): AgentConfigItem => ({
  claudeSummary: null, codexSummary: null, toCodexBlocked: null, toClaudeBlocked: null, ...over,
});

// The rows of design 09.05, plus an SSE server Codex cannot take.
const comparison: AgentConfigComparison = {
  claudeFile: "~/.claude.json",
  codexFile: "~/.codex/config.toml",
  problems: [],
  items: [
    item({ kind: "mcp", name: "linear", status: "onlyClaude", claudeSummary: "https://mcp.linear.app/mcp" }),
    item({ kind: "mcp", name: "playwright", status: "onlyClaude", claudeSummary: "npx @playwright/mcp@latest" }),
    item({ kind: "mcp", name: "events", status: "onlyClaude", claudeSummary: "https://events.example.com/sse · SSE", toCodexBlocked: "Codex has no SSE transport; it takes stdio and streamable HTTP servers" }),
    item({ kind: "mcp", name: "sentry", status: "different", claudeSummary: "https://mcp.sentry.dev/mcp", codexSummary: "https://sentry.internal/mcp" }),
    item({ kind: "mcp", name: "context7", status: "onlyCodex", codexSummary: "npx -y @upstash/context7-mcp" }),
    item({ kind: "mcp", name: "github", status: "same", claudeSummary: "gh mcp-server", codexSummary: "gh mcp-server" }),
    item({ kind: "command", name: "review", status: "onlyClaude", claudeSummary: "Review the branch" }),
    item({ kind: "command", name: "changelog", status: "same", claudeSummary: "Draft a changelog entry" }),
    item({ kind: "skill", name: "release-notes", status: "onlyClaude", claudeSummary: "Write release notes · 1 file" }),
  ],
};

const preview = (changes: AgentConfigChange[]): AgentConfigPreview => ({
  files: [{
    path: "~/.codex/config.toml",
    backup: "~/.codex/config.toml.bak-2026-11-19",
    text: changes.filter((c) => c.kind === "mcp" && c.direction === "toCodex").map((c) => `[mcp_servers.${c.name}]\nurl = "https://example/${c.name}"\n`).join("\n"),
  }],
  notes: [{ kind: "mcp", name: "context7", text: "`startup_timeout_sec` stays in Codex only" }],
  added: { mcp: changes.filter((c) => c.kind === "mcp" && c.name !== "sentry").length, command: changes.filter((c) => c.kind === "command").length, skill: changes.filter((c) => c.kind === "skill").length },
  replaced: { mcp: changes.some((c) => c.name === "sentry") ? 1 : 0, command: 0, skill: 0 },
  token: `token-${changes.map((c) => `${c.name}:${c.direction}`).join(",")}`,
});

const lastChanges = (): AgentConfigChange[] => mock.preview.mock.calls.at(-1)?.[0] ?? [];
const row = (kind: string, name: string) => document.querySelector(`[data-agent-config="${kind}:${name}"]`) as HTMLElement;
const applyButton = () => screen.getByRole("button", { name: /^Apply/ });

beforeEach(() => {
  vi.clearAllMocks();
  mock.compare.mockResolvedValue(comparison);
  mock.preview.mockImplementation(async (changes: AgentConfigChange[]) => preview(changes));
  mock.apply.mockResolvedValue([{ path: "~/.codex/config.toml", backup: "~/.codex/config.toml.bak-2026-11-19" }]);
});
afterEach(cleanup);

async function open(onClose = vi.fn()) {
  render(<AgentConfigsDialog onClose={onClose} />);
  await screen.findByText("linear");
  await waitFor(() => expect(applyButton()).toHaveProperty("disabled", false));
  return onClose;
}

describe("copy agent configs", () => {
  it("picks each item's way: toward the side lacking it, Claude's for a difference, none when blocked or the same", () => {
    const [linear, , events, sentry, context7, github] = comparison.items;
    expect(defaultDirection(linear)).toBe("toCodex");
    expect(defaultDirection(events)).toBeNull();
    expect(defaultDirection(sentry)).toBe("toCodex");
    expect(defaultDirection(context7)).toBe("toClaude");
    expect(defaultDirection(github)).toBeNull();
    expect(defaultDirection({ ...sentry, toCodexBlocked: "no" })).toBe("toClaude");
    expect([...initialSelection(comparison.items).keys()]).toEqual(["mcp:linear", "mcp:playwright", "mcp:sentry", "mcp:context7", "command:review", "skill:release-notes"]);
  });

  it("lists the tabs with their counts and marks each row as the design does", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Copy between Claude Code and Codex" })).toBeTruthy();
    expect(screen.getByText(/TerminalX reads ~\/\.claude\.json and ~\/\.codex\/config\.toml\. Nothing is deleted, and each file is backed up before it changes\./)).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["MCP servers · 6", "Slash commands · 2", "Skills · 1"]);
    expect(within(row("mcp", "linear")).getByText("Only in Claude Code")).toBeTruthy();
    expect(within(row("mcp", "linear")).getByText("Copy to Codex →")).toBeTruthy();
    expect(within(row("mcp", "sentry")).getByText("Different")).toBeTruthy();
    expect(within(row("mcp", "sentry")).getByRole("button", { name: "Use Claude’s →" })).toBeTruthy();
    expect(within(row("mcp", "context7")).getByText("Only in Codex")).toBeTruthy();
    expect(within(row("mcp", "context7")).getByText("← Copy to Claude")).toBeTruthy();
    expect(within(row("mcp", "github")).getByText("Same")).toBeTruthy();
    expect(within(row("mcp", "github")).getByRole("checkbox")).toHaveProperty("disabled", true);
    expect(within(row("mcp", "events")).getByText("Codex has no SSE transport; it takes stdio and streamable HTTP servers")).toBeTruthy();
    expect(within(row("mcp", "events")).getByRole("checkbox")).toHaveProperty("disabled", true);
    expect(applyButton().textContent).toContain("Apply 6 changes");
    expect(screen.getByText("Agents pick up the change in new tabs.")).toBeTruthy();
  });

  it("previews every ticked change together, with the file, its backup and the counts", async () => {
    await open();
    const box = document.querySelector("[data-agent-config-preview]") as HTMLElement;
    expect(within(box).getByText("# ~/.codex/config.toml (backed up to config.toml.bak-2026-11-19)")).toBeTruthy();
    expect(within(box).getByText("[mcp_servers.linear]")).toBeTruthy();
    expect(within(box).getByText("+3 servers, 1 command, 1 skill")).toBeTruthy();
    expect(within(box).getByText("1 server replaced")).toBeTruthy();
    expect(within(box).getByText(/startup_timeout_sec/)).toBeTruthy();

    fireEvent.click(within(row("mcp", "linear")).getByRole("checkbox"));
    await waitFor(() => expect(lastChanges().map((c) => c.name)).not.toContain("linear"));
    expect(applyButton().textContent).toContain("Apply 5 changes");
    fireEvent.click(within(row("mcp", "sentry")).getByRole("button", { name: "Use Claude’s →" }));
    await waitFor(() => expect(lastChanges().find((c) => c.name === "sentry")?.direction).toBe("toClaude"));
    expect(within(row("mcp", "sentry")).getByRole("button", { name: "← Use Codex’s" })).toBeTruthy();
  });

  it("cancel writes nothing", async () => {
    const onClose = await open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(mock.apply).not.toHaveBeenCalled();
  });

  it("applies the previewed changes with their token on ⌘↵ and reads both homes again", async () => {
    await open();
    fireEvent.keyDown(applyButton(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mock.apply).toHaveBeenCalledTimes(1));
    const [changes, token] = mock.apply.mock.calls[0];
    expect(changes).toEqual(lastChanges());
    expect(token).toBe(preview(changes).token);
    expect(await screen.findByText(/Wrote 1 file\./)).toBeTruthy();
    expect(screen.getByText("~/.codex/config.toml.bak-2026-11-19")).toBeTruthy();
    await waitFor(() => expect(mock.compare).toHaveBeenCalledTimes(2));
  });

  it("says nothing was written when the files changed since the preview", async () => {
    mock.apply.mockRejectedValue(new Error("These files changed since the preview. Look over the new preview and apply again."));
    await open();
    fireEvent.click(applyButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Nothing was written: These files changed since the preview. Look over the new preview and apply again.");
  });

  it("disables Apply when the preview cannot be made", async () => {
    mock.preview.mockRejectedValue(new Error("~/.codex/config.toml is not valid TOML"));
    render(<AgentConfigsDialog onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Can’t write this: ~/.codex/config.toml is not valid TOML");
    expect(applyButton()).toHaveProperty("disabled", true);
  });

  it("shows slash commands with their slash, and the skills tab", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "Slash commands · 2" }));
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.getByText("/changelog")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Skills · 1" }));
    expect(screen.getByText("release-notes")).toBeTruthy();
  });
});
