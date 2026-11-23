import { useCallback, useEffect, useRef, useState } from "react";
import { ThisComputer } from "@/lib/platform";
import { UserPlus } from "@/icons";
import { Button } from "@/components/ui/button";
import { agentAccounts, LOCAL_ACCOUNT, SAVED_KEY_ACCOUNT, type AgentAccount, type AgentAccountAgent, type AgentAccounts } from "@/lib/agentAccounts";
import { keepLine, showAgentLoginNotice, tabsKeepingOlderLogin, type AgentLoginStatus } from "@/lib/agentLogins";
import type { AgentReadiness } from "@/lib/agentReadiness";
import { errorMessage } from "@/lib/api";
import { AgentAccountAdd, MCP_NOTE } from "./AgentAccountAdd";
import { AgentAccountRow } from "./AgentAccountRow";
import { AgentAutoSwitch } from "./AgentAutoSwitch";

/**
 * One agent's accounts (#980), read again whenever `revision` changes.
 * `null`: an agent without accounts; nothing is asked and the view stays empty.
 */
export function useAgentAccountsView(harness: AgentAccountAgent | null, revision: unknown) {
  const [view, setView] = useState<AgentAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++run.current;
    if (!harness) { setView(null); setError(null); return null; }
    try {
      const next = await agentAccounts.list(harness);
      if (mine === run.current) { setView(next); setError(null); }
      return next;
    } catch (e) {
      if (mine === run.current) setError(errorMessage(e));
      return null;
    }
  }, [harness]);
  useEffect(() => {
    void reload();
    return () => { run.current++; };
  }, [reload, revision]);
  const take = useCallback((next: AgentAccounts) => { run.current++; setView(next); setError(null); }, []);
  return { view, error, reload, take };
}

/**
 * The accounts beyond This Mac's login and the PRO-306 saved key, which
 * the sign-in choice above already shows. With none, the panel is as it
 * was before accounts, with only Add account below it.
 */
export function addedAccounts(view: AgentAccounts | null): AgentAccount[] {
  return view?.accounts.filter((account) => account.id !== LOCAL_ACCOUNT && account.id !== SAVED_KEY_ACCOUNT) ?? [];
}

/** Settings → Agents: an agent's accounts, and Add account (#980). */
export function AgentAccountsSection({ harness, agentName, accounts, localReadiness, login, onChanged }: {
  harness: AgentAccountAgent;
  agentName: string;
  accounts: ReturnType<typeof useAgentAccountsView>;
  localReadiness: AgentReadiness | null;
  login: AgentLoginStatus | null;
  /** What new tabs start with changed: the sign-in settings and readiness should be read again. */
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const { view, error } = accounts;
  const several = addedAccounts(view).length > 0;

  const announce = async (title: string, lead: string) => {
    const stale = await tabsKeepingOlderLogin(harness);
    showAgentLoginNotice({ harness, kind: "account", stale, title, body: [lead, keepLine(stale.length)].filter(Boolean).join(" ") });
  };
  const added = async (account: AgentAccount | null, next: AgentAccounts | null) => {
    setAdding(false);
    if (next) accounts.take(next);
    else await accounts.reload();
    // A key comes back as the new list, with the new account last.
    const label = account?.label ?? next?.accounts.at(-1)?.label ?? "the account";
    showAgentLoginNotice({ harness, kind: "account", stale: [], title: `Added ${label}`, body: "Choose it when you start a session, or make it the default here." });
  };
  const changed = ({ kind, account, view: next }: { kind: "default" | "removed"; account: AgentAccount; view: AgentAccounts }) => {
    onChanged();
    if (kind === "default") void announce(`New ${agentName} tabs use ${account.label}`, "It is the default account now.");
    else void announce(`Removed ${account.label}`, account.isDefault ? `New ${agentName} tabs use ${next.accounts.find((other) => other.isDefault)?.label ?? `${ThisComputer}'s login`}.` : "");
  };

  const add = <AgentAccountAdd harness={harness} agentName={agentName} onClose={() => setAdding(false)} onAdded={(account, next) => void added(account, next)} />;
  if (!several) {
    return <div className="mt-3">
      {!adding && <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={() => setAdding(true)}><UserPlus /> Add account</Button>}
      {adding && add}
      {error && <p role="alert" className="mt-2 text-[12px] text-destructive">{error}</p>}
    </div>;
  }
  return <section aria-labelledby={`${harness}-accounts`} className="mt-4">
    <div className="flex items-center">
      <span id={`${harness}-accounts`} className="text-[12.5px] font-medium">Accounts</span>
      {!adding && <Button size="sm" variant="ghost" className="ml-auto whitespace-nowrap" onClick={() => setAdding(true)}><UserPlus /> Add account</Button>}
    </div>
    <ul aria-label={`${agentName} accounts`} className="mt-2 rounded-lg border border-hairline">
      {view!.accounts.map((account) => <AgentAccountRow key={account.id} harness={harness} agentName={agentName} account={account}
        localReadiness={localReadiness} login={login} onView={accounts.take} onChanged={changed} />)}
    </ul>
    <p className="mt-1.5 text-[12px] text-faint">The default is what new tabs use; choose another one when you start a session.{harness === "claude" ? ` ${MCP_NOTE}` : ""}</p>
    {adding && add}
    {/* With two or more subscription accounts only (#981). */}
    <AgentAutoSwitch harness={harness} agentName={agentName} view={view!} onView={accounts.take} />
    {error && <p role="alert" className="mt-2 text-[12px] text-destructive">{error}</p>}
  </section>;
}
