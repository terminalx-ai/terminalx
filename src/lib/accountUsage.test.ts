import { describe, expect, it } from "vitest";
import type { UsageSnapshot, UsageWindow } from "@/lib/api";
import { accountAgent, accountUsageNotice, agentAccountUsage, tabAccountFirst, usageByAgent, windowIsStale, type AccountUsage } from "./accountUsage";

const window = (agent: UsageWindow["agent"], usedPercent: number): UsageWindow => ({ agent, key: "five_hour", label: "5h", usedPercent, resetsAt: null, windowMinutes: 300, updatedAt: 1_000, stale: false });
const account = (agent: string | undefined, accountId: string, windows: UsageWindow[] = [], patch: Partial<AccountUsage> = {}): AccountUsage =>
  ({ ...(agent ? { agent } : {}), accountId, label: accountId, windows, error: null, unavailable: false, ...patch });

describe("account usage", () => {
  it("lists nothing with This Mac's login alone, or from a runtime without accounts", () => {
    expect(agentAccountUsage({ windows: [] }, "claude")).toEqual([]);
    expect(agentAccountUsage({ windows: [], accounts: [account("claude", "local")] }, "claude")).toEqual([]);
    expect(usageByAgent(undefined)).toEqual([]);
  });

  it("groups each agent's accounts, telling apart the ids every agent has", () => {
    const usage: UsageSnapshot = { windows: [], accounts: [
      account("claude", "local", [window("claude", 1)]),
      account("claude", "aaaa1111bbbb2222", [window("claude", 2)]),
      account("codex", "local"),
      account("codex", "api-key", [], { unavailable: true }),
    ] };
    expect(agentAccountUsage(usage, "claude").map((entry) => entry.accountId)).toEqual(["local", "aaaa1111bbbb2222"]);
    expect(agentAccountUsage(usage, "codex").map((entry) => entry.accountId)).toEqual(["local", "api-key"]);
    expect(usageByAgent(usage).map((group) => group.agent)).toEqual(["claude", "codex"]);
    // Without `agent`, its windows say which agent it is.
    expect(accountAgent(account(undefined, "x", [window("codex", 3)]))).toBe("codex");
  });

  it("puts the tab's own account first; no account recorded is This Mac's login", () => {
    const accounts = [account("claude", "local"), account("claude", "a"), account("claude", "b")];
    expect(tabAccountFirst(accounts, "b").map((entry) => entry.accountId)).toEqual(["b", "local", "a"]);
    expect(tabAccountFirst(accounts, null).map((entry) => entry.accountId)).toEqual(["local", "a", "b"]);
  });

  it("says why an account has no windows", () => {
    expect(accountUsageNotice(account("claude", "a", [window("claude", 5)]))).toBeNull();
    expect(accountUsageNotice(account("claude", "api-key", [], { unavailable: true }))).toMatch(/API key/);
    expect(accountUsageNotice(account("claude", "a", [], { unavailable: true, error: "HTTP 401" }))).toBe("Usage unavailable");
    expect(accountUsageNotice(account("claude", "a"))).toBe("Reading usage…");
  });

  it("treats a window past its reset or half an hour old as last known", () => {
    expect(windowIsStale(window("claude", 1), 2_000)).toBe(false);
    expect(windowIsStale(window("claude", 1), 1_000 + 30 * 60_000)).toBe(true);
    expect(windowIsStale({ ...window("claude", 1), resetsAt: 1_500 }, 2_000)).toBe(true);
  });
});
