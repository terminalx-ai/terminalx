import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Tauri bridge stands in for the desktop: each test says what the commands answer. */
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  LOCAL_ACCOUNT,
  SAVED_KEY_ACCOUNT,
  accountLabel,
  agentAccounts,
  resolveAccount,
  showsAccounts,
  takesAccounts,
  waitForSignIn,
  type AgentAccount,
  type AgentAccountUsage,
  type AgentAccounts,
} from "./agentAccounts";

function account(id: string, label: string, extra: Partial<AgentAccount> = {}): AgentAccount {
  return { id, agent: "claude", kind: "subscription", label, email: null, plan: null, organization: null, local: id === LOCAL_ACCOUNT, isDefault: false, missing: false, addedAt: null, ...extra };
}

const onlyLocal: AgentAccounts = { agent: "claude", accounts: [account(LOCAL_ACCOUNT, "This Mac's login", { isDefault: true })], defaultAccount: LOCAL_ACCOUNT, projectDefaults: {} };
const several: AgentAccounts = {
  agent: "claude",
  accounts: [
    account(LOCAL_ACCOUNT, "This Mac's login"),
    account(SAVED_KEY_ACCOUNT, "API key", { kind: "apiKey" }),
    account("aaaa1111", "bo@example.com · Pro", { email: "bo@example.com", plan: "Pro", isDefault: true }),
  ],
  defaultAccount: "aaaa1111",
  projectDefaults: { "project-1": LOCAL_ACCOUNT, "project-2": "removed0" },
};

beforeEach(() => mocks.invoke.mockReset());

describe("agent accounts", () => {
  it("shows pickers only when an agent has more than one account", () => {
    expect(showsAccounts(onlyLocal)).toBe(false);
    expect(showsAccounts(several)).toBe(true);
    expect(showsAccounts(null)).toBe(false);
    expect(takesAccounts("claude") && takesAccounts("codex")).toBe(true);
    expect(takesAccounts("opencode")).toBe(false);
  });

  it("resolves a launch's account as the runtime does: chosen, project, agent, This Mac", () => {
    expect(resolveAccount(several).id).toBe("aaaa1111");
    expect(resolveAccount(several, { accountId: SAVED_KEY_ACCOUNT }).id).toBe(SAVED_KEY_ACCOUNT);
    expect(resolveAccount(several, { projectId: "project-1" }).id).toBe(LOCAL_ACCOUNT);
    // A project default naming a removed account, and an unknown choice, fall through.
    expect(resolveAccount(several, { projectId: "project-2" }).id).toBe("aaaa1111");
    expect(resolveAccount(several, { accountId: "gone0000", projectId: "project-1" }).id).toBe(LOCAL_ACCOUNT);
    expect(resolveAccount(onlyLocal, { accountId: "aaaa1111" }).id).toBe(LOCAL_ACCOUNT);
    expect(accountLabel(several, "aaaa1111")).toBe("bo@example.com · Pro");
    expect(accountLabel(several, "gone0000")).toBeNull();
  });

  it("calls each desktop command by its name with camelCase arguments", async () => {
    mocks.invoke.mockResolvedValue(several);
    await agentAccounts.list("claude");
    await agentAccounts.relabel("claude", "aaaa1111", "Work");
    await agentAccounts.setDefault("claude", "aaaa1111", "project-1");
    await agentAccounts.setDefault("codex", LOCAL_ACCOUNT);
    await agentAccounts.addKey("codex", "sk-proj-x", "Company");
    await agentAccounts.remove("claude", "aaaa1111");
    await agentAccounts.signInAgain("claude", "aaaa1111");
    await agentAccounts.readiness("codex", "bbbb2222");
    expect(mocks.invoke.mock.calls).toEqual([
      ["agent_accounts_list", { harness: "claude" }],
      ["agent_accounts_relabel", { harness: "claude", accountId: "aaaa1111", label: "Work" }],
      ["agent_accounts_set_default", { harness: "claude", accountId: "aaaa1111", projectId: "project-1" }],
      ["agent_accounts_set_default", { harness: "codex", accountId: LOCAL_ACCOUNT, projectId: null }],
      ["agent_accounts_add_key", { harness: "codex", key: "sk-proj-x", label: "Company" }],
      ["agent_accounts_remove", { harness: "claude", accountId: "aaaa1111", confirmed: false }],
      ["agent_accounts_sign_in_again", { harness: "claude", accountId: "aaaa1111" }],
      ["agent_accounts_readiness", { harness: "codex", accountId: "bbbb2222" }],
    ]);
  });

  it("waits for a sign-in to end, and cancels it when asked to stop", async () => {
    const answers = [{ status: "waiting" }, { status: "waiting" }, { status: "duplicate", accountId: "aaaa1111", label: "bo@example.com · Pro" }];
    mocks.invoke.mockImplementation(async (command: string) => (command === "agent_accounts_add_finish" ? answers.shift() : undefined));
    await expect(waitForSignIn("attempt-1", { intervalMs: 1 })).resolves.toEqual({ status: "duplicate", accountId: "aaaa1111", label: "bo@example.com · Pro" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "agent_accounts_add_finish")).toHaveLength(3);

    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ status: "waiting" });
    const stop = new AbortController();
    const waiting = waitForSignIn("attempt-2", { intervalMs: 10_000, signal: stop.signal });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("agent_accounts_add_finish", { attemptId: "attempt-2" }));
    stop.abort();
    await expect(waiting).resolves.toEqual({ status: "cancelled" });
    expect(mocks.invoke).toHaveBeenCalledWith("agent_accounts_add_cancel", { attemptId: "attempt-2" });
  });

  it("types an account's usage as the usage piece fills it", () => {
    const usage: AgentAccountUsage = { accountId: SAVED_KEY_ACCOUNT, label: "API key", windows: [], error: null, unavailable: true };
    expect(Object.keys(usage).sort()).toEqual(["accountId", "error", "label", "unavailable", "windows"]);
  });
});
