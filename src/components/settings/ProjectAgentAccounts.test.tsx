import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccount, AgentAccounts } from "@/lib/agentAccounts";

// The Mac's account index (#980): read and changed through the desktop's commands, held here.
const index = vi.hoisted(() => ({ views: {} as Record<string, AgentAccounts>, calls: [] as [string, Record<string, unknown>][], refuse: null as string | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    index.calls.push([command, args]);
    const view = index.views[args.harness as string];
    if (!view) throw new Error("no index");
    if (command === "agent_accounts_list") return view;
    if (command === "agent_accounts_set_default") {
      if (index.refuse) throw new Error(index.refuse);
      const projectDefaults = { ...view.projectDefaults };
      if (args.accountId) projectDefaults[args.projectId as string] = args.accountId as string;
      else delete projectDefaults[args.projectId as string];
      index.views[args.harness as string] = { ...view, projectDefaults };
      return index.views[args.harness as string];
    }
    throw new Error(`unexpected command ${command}`);
  }),
}));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ harnesses: [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }] }) }));

const { ProjectAgentAccounts } = await import("./ProjectAgentAccounts");
const { forgetAgentAccounts } = await import("@/lib/useSessionAgent");

const WORK = "0123456789abcdef";
const PROJECT = "/repos/raccoon";
const account = (agent: "claude" | "codex", id: string, label: string, isDefault = id === "local"): AgentAccount => ({
  id, agent, kind: "subscription", label, email: null, plan: null, organization: null, local: id === "local", isDefault, missing: false, addedAt: null,
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  forgetAgentAccounts();
  index.calls = [];
  index.refuse = null;
  index.views = {
    claude: { agent: "claude", accounts: [account("claude", "local", "This Mac's login"), account("claude", WORK, "work@example.com · Max")], defaultAccount: "local", projectDefaults: {} },
    codex: { agent: "codex", accounts: [account("codex", "local", "This Mac's login")], defaultAccount: "local", projectDefaults: {} },
  };
});
afterEach(cleanup);

describe("a project's default account (#980)", () => {
  it("draws nothing while no agent has more than one account", async () => {
    index.views.claude = { ...index.views.claude, accounts: [account("claude", "local", "This Mac's login")] };
    const { container } = render(<ProjectAgentAccounts projectPath={PROJECT} />);
    await settle();
    expect(index.calls.map(([command]) => command).sort()).toEqual(["agent_accounts_list", "agent_accounts_list"]);
    expect(container.textContent).toBe("");
  });

  it("offers a row for each agent with several accounts, following the agent's default until one is set", async () => {
    render(<ProjectAgentAccounts projectPath={PROJECT} />);
    const trigger = await screen.findByRole("button", { name: /Claude Code account for this project/ });
    expect(trigger.textContent).toContain("Agent default (This Mac's login)");
    // Codex has one account: it has no row.
    expect(screen.queryByRole("button", { name: /Codex account/ })).toBeNull();
  });

  it("sets this project's default by its id, and follows the agent's again when cleared", async () => {
    render(<ProjectAgentAccounts projectPath={PROJECT} />);
    fireEvent.click(await screen.findByRole("button", { name: /Claude Code account for this project/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /work@example.com · Max/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Claude Code account for this project/ }).textContent).toContain("work@example.com · Max"));
    expect(index.calls.filter(([command]) => command === "agent_accounts_set_default").map(([, args]) => args)).toEqual([{ harness: "claude", accountId: WORK, projectId: PROJECT }]);

    fireEvent.click(screen.getByRole("button", { name: /Claude Code account for this project/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Agent default/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Claude Code account for this project/ }).textContent).toContain("Agent default"));
    expect(index.calls.filter(([command]) => command === "agent_accounts_set_default").at(-1)![1]).toEqual({ harness: "claude", accountId: null, projectId: PROJECT });
  });

  it("shows a project default already set, and says why a change was refused", async () => {
    index.views.claude = { ...index.views.claude, projectDefaults: { [PROJECT]: WORK, "/repos/other": "local" } };
    index.refuse = "The account index could not be saved.";
    render(<ProjectAgentAccounts projectPath={PROJECT} />);
    const trigger = await screen.findByRole("button", { name: /Claude Code account for this project/ });
    expect(trigger.textContent).toContain("work@example.com · Max");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "This Mac's login" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The account index could not be saved.");
    expect(screen.getByRole("button", { name: /Claude Code account for this project/ }).textContent).toContain("work@example.com · Max");
  });
});
