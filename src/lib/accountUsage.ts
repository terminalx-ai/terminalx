import type { UsageSnapshot, UsageWindow } from "@/lib/api";
import type { AgentAccountUsage } from "@/lib/agentAccounts";

/** This Mac's own login: the snapshot's top-level windows. */
export const LOCAL_ACCOUNT = "local";

/**
 * One account's usage as the runtime sends it (#980): the core's contract plus
 * the agent it belongs to, since `local` and `api-key` are ids every agent has.
 */
export type AccountUsage = AgentAccountUsage & { agent?: string };

/** The agent an account's usage belongs to: as sent, else as its windows say. */
export function accountAgent(usage: AccountUsage): string | null {
  return usage.agent ?? usage.windows[0]?.agent ?? null;
}

/**
 * `agent`'s accounts, each with its own windows, in Settings' order; empty when
 * it has only This Mac's login, so everything shows exactly as before.
 */
export function agentAccountUsage(usage: UsageSnapshot | null | undefined, agent: string): AccountUsage[] {
  const accounts = ((usage?.accounts ?? []) as AccountUsage[]).filter((account) => accountAgent(account) === agent);
  return accounts.length > 1 ? accounts : [];
}

/** The agents that have more than one account, each with its accounts. */
export function usageByAgent(usage: UsageSnapshot | null | undefined): Array<{ agent: string; accounts: AccountUsage[] }> {
  const agents: string[] = [];
  for (const account of (usage?.accounts ?? []) as AccountUsage[]) {
    const agent = accountAgent(account);
    if (agent && !agents.includes(agent)) agents.push(agent);
  }
  return agents.map((agent) => ({ agent, accounts: agentAccountUsage(usage, agent) })).filter((group) => group.accounts.length);
}

/**
 * The tab's own account first, then the others. A tab with no account
 * recorded runs on This Mac's login.
 */
export function tabAccountFirst(accounts: readonly AccountUsage[], tabAccount: string | null | undefined): AccountUsage[] {
  const id = tabAccount ?? LOCAL_ACCOUNT;
  const own = accounts.find((account) => account.accountId === id);
  return own ? [own, ...accounts.filter((account) => account !== own)] : [...accounts];
}

/** What to say for an account with no windows to show. */
export function accountUsageNotice(account: AccountUsage): string | null {
  if (account.windows.length) return null;
  if (account.unavailable && !account.error) return "No subscription usage windows for an API key";
  if (account.unavailable) return "Usage unavailable";
  return "Reading usage…";
}

/** Past its reset, or not heard from in half an hour: the last known value. */
export function windowIsStale(window: UsageWindow, now: number): boolean {
  return window.stale || now - window.updatedAt >= 30 * 60_000 || (window.resetsAt != null && window.resetsAt <= now);
}

/**
 * Whether an account counts as full for automatic switching (#981), as the
 * popover marks it: any window still running at or past `threshold`. The
 * runtime's own decision also weighs usage-limit errors and the tab's model.
 */
export function accountFull(account: AccountUsage, threshold: number, now: number): boolean {
  return account.windows.some((window) => window.usedPercent >= threshold && !(window.resetsAt != null && window.resetsAt <= now));
}
