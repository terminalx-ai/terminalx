import { useEffect, useState, useSyncExternalStore } from "react";
import { UserRound } from "@/icons";
import { Button } from "@/components/ui/button";
import { agent as agentApi, errorMessage, tabAccount, type UsageSnapshot, type UsageWindow } from "@/lib/api";
import { LOCAL_ACCOUNT, showsAccounts, type AgentAccount, type AgentAccounts } from "@/lib/agentAccounts";
import { agentAccountUsage, type AccountUsage } from "@/lib/accountUsage";
import { refreshAgentAccounts, useAgentAccounts } from "@/lib/useSessionAgent";
import { useStatus } from "@/lib/status";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * Switch account (#980, docs/AGENT-ACCOUNTS.md): restart a tab's agent on
 * another of its agent's accounts and resume the same conversation. Always
 * the person's click; nothing here switches by itself. With one account
 * nothing here draws.
 */

/** Whether a usage window still has room at `now`: under its limit, or past its reset. */
export function windowHasRoom(window: UsageWindow, now: number): boolean {
  return window.usedPercent < 100 || (window.resetsAt != null && window.resetsAt <= now);
}

/**
 * Whether an account's usage says it has room: it was read, it has windows,
 * and each has room. An account whose usage could not be read, or that has
 * no windows (an API key's), is not offered at a limit: nothing says it has room.
 */
export function accountHasRoom(usage: AccountUsage | undefined, now: number): boolean {
  return !!usage && !usage.error && !usage.unavailable && usage.windows.length > 0 && usage.windows.every((window) => windowHasRoom(window, now));
}

/** The account `tab` runs on: the one it asked for or launched on, else This Mac's login. */
export function tabAccountId(tab: TabEntry): string {
  return tabAccount(tab) ?? LOCAL_ACCOUNT;
}

/** The other accounts a tab may switch to: listed, signed in, and not its own. */
export function switchTargets(view: AgentAccounts | null | undefined, tab: TabEntry): AgentAccount[] {
  if (!view || !showsAccounts(view)) return [];
  const own = tabAccountId(tab);
  return view.accounts.filter((account) => account.id !== own && !account.missing);
}

/** Those of `targets` whose usage windows have room, in the same order. */
export function targetsWithRoom(targets: readonly AgentAccount[], usage: UsageSnapshot | null | undefined, agent: string, now: number): AgentAccount[] {
  const byId = new Map(agentAccountUsage(usage, agent).map((account) => [account.accountId, account]));
  return targets.filter((account) => accountHasRoom(byId.get(account.id), now));
}

/** Why a tab's own account cannot carry it on: removed from Settings, or signed out (its directory is gone). */
export type AccountGone = { reason: "removed" } | { reason: "signedOut"; label: string };

/** `tab`'s account, gone: it asked for one no longer listed, or one that is listed but signed out. */
export function accountGone(view: AgentAccounts | null | undefined, tab: TabEntry): AccountGone | null {
  if (!view) return null;
  const id = tabAccount(tab);
  if (!id || id === LOCAL_ACCOUNT) return null;
  const account = view.accounts.find((candidate) => candidate.id === id);
  if (!account) return { reason: "removed" };
  return account.missing ? { reason: "signedOut", label: account.label } : null;
}

/** How old an agent's accounts may be before a tab's menu or card reads them again, as the tab mark. */
const ACCOUNTS_MAX_AGE_MS = 30_000;

/** A switch made in a tab: the account it went to and the model the agent reported before it. */
interface SwitchMade {
  label: string;
  modelBefore: string | null;
}

const switches = new Map<string, SwitchMade>();
/** The model each open tab's agent last reported, so a switch from its menu knows it too. */
const reportedModels = new Map<string, string>();
const switchListeners = new Set<() => void>();
const __subscribe_switchListeners = (listener: () => void) => { switchListeners.add(listener); return () => { switchListeners.delete(listener); }; };
const changed = () => { for (const listener of switchListeners) listener(); };

/** The last switch made in tab `tabId` from this window, until it is dismissed. */
export function useSwitchMade(tabId: string): SwitchMade | null {
  return useSyncExternalStore(
    __subscribe_switchListeners,
    () => switches.get(tabId) ?? null,
  );
}

export function forgetSwitch(tabId: string) {
  if (switches.delete(tabId)) changed();
}

/**
 * Restart `tab`'s agent on account `account` and resume its conversation.
 * The model its agent reported before is kept for the note that says which
 * model runs now when the new account's plan gives another.
 */
export async function switchTabAccount(session: Pick<SessionEntry, "id">, tab: TabEntry, account: AgentAccount): Promise<void> {
  if (!tab.providerSessionId) throw new Error("This tab has no conversation to continue yet.");
  const modelBefore = reportedModels.get(tab.id) ?? null;
  await agentApi.switchAccount(session.id, tab.id, tab.harness, tab.providerSessionId, account.id);
  switches.set(tab.id, { label: account.label, modelBefore });
  changed();
  // Settings → Agents and the tab mark read the tab's account again.
  void refreshAgentAccounts(tab.harness, 0);
}

/**
 * What a tab offers to switch to, and the switch itself: every other signed
 * in account (the tab menu), those with room (a usage limit), and whether
 * its own account is gone. `enabled` false (a cloud tab) offers nothing.
 */
export function useAccountSwitch(session: Pick<SessionEntry, "id">, tab: TabEntry, enabled = true) {
  const view = useAgentAccounts(enabled ? tab.harness : null, ACCOUNTS_MAX_AGE_MS);
  const { usage } = useStatus();
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = enabled ? switchTargets(view, tab) : [];
  const now = Date.now();
  return {
    targets,
    withRoom: targetsWithRoom(targets, usage, tab.harness, now),
    gone: enabled ? accountGone(view, tab) : null,
    switching,
    error,
    switchTo: async (account: AgentAccount) => {
      if (switching) return;
      setSwitching(account.id);
      setError(null);
      try {
        await switchTabAccount(session, tab, account);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSwitching(null);
      }
    },
  };
}

/**
 * After a switch, the tab says which model runs on the new account when it
 * is not the one before: a plan without that model falls back by itself.
 */
export function AccountSwitchNote({ tabId, reportedModel, modelName }: { tabId: string; reportedModel: string | null | undefined; modelName?: (id: string) => string }) {
  const made = useSwitchMade(tabId);
  // Kept only until a switch is made: after it, the model reported is the new account's.
  useEffect(() => {
    if (reportedModel && !switches.has(tabId)) reportedModels.set(tabId, reportedModel);
  }, [tabId, reportedModel]);
  if (!made) return null;
  const now = reportedModel ?? null;
  const fellBack = !!now && !!made.modelBefore && now !== made.modelBefore;
  const name = (id: string) => modelName?.(id) ?? id;
  return (
    <div role="status" data-testid="account-switch-note" className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 px-6 text-xs text-muted-foreground">
      <UserRound className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {fellBack
          ? `Now on ${made.label}. Its plan runs ${name(now!)}, not ${name(made.modelBefore!)}.`
          : `Now on ${made.label}.`}
      </span>
      <Button size="xs" variant="ghost" onClick={() => forgetSwitch(tabId)}>Dismiss</Button>
    </div>
  );
}

/**
 * A running tab whose account was removed in Settings, or signed out, says
 * so, and offers the agent's other accounts. Nothing with one account left.
 */
export function AccountGoneNotice({ gone, targets, switching, error, onSwitch }: {
  gone: AccountGone | null;
  targets: AgentAccount[];
  switching: string | null;
  error: string | null;
  onSwitch: (account: AgentAccount) => void;
}) {
  if (!gone) return null;
  const what = gone.reason === "removed"
    ? "This tab's account was removed. Its agent keeps running as it is; it cannot start on that account again."
    : `${gone.label} is signed out. Sign it in again in Settings → Agents, or continue on another account.`;
  return (
    <div role="status" data-testid="account-gone" className="mx-auto mb-2 w-full max-w-3xl px-6 text-xs">
      <div className="rounded-xl border border-warning/30 bg-warning/10 p-3">
        <p>{what}</p>
        {error ? <p className="mt-1 text-warning">{error}</p> : null}
        {targets.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {targets.map((account) => (
              <Button key={account.id} size="sm" variant="outline" disabled={!!switching} onClick={() => onSwitch(account)}>
                Continue with {account.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
