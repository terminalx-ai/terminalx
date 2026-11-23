import { useState } from "react";
import { ChevronDown } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { ACCOUNT_AGENTS, accountLabel, agentAccounts, showsAccounts, type AgentAccountAgent, type AgentAccounts } from "@/lib/agentAccounts";
import { errorMessage } from "@/lib/api";
import { useSessionStore } from "@/lib/sessions";
import { takeAgentAccounts, useAgentAccounts } from "@/lib/useSessionAgent";

/** The radio value for "no project default": new sessions follow the agent's. */
const FOLLOW_AGENT = "";

/**
 * A project's default account per agent (#980, docs/AGENT-ACCOUNTS.md): new
 * sessions of the project start on it unless another is chosen when they
 * start. Kept on this Mac only, keyed by the project. Only an agent with
 * more than one account has a row; with none, nothing is drawn, so a
 * project's settings look as they did before accounts.
 */
export function ProjectAgentAccounts({ projectPath }: { projectPath: string }) {
  const { harnesses } = useSessionStore();
  const claude = useAgentAccounts("claude");
  const codex = useAgentAccounts("codex");
  const views: Record<AgentAccountAgent, AgentAccounts | null> = { claude, codex };
  const rows = ACCOUNT_AGENTS.filter((agent) => showsAccounts(views[agent]));
  if (!rows.length) return null;
  return (
    <section aria-labelledby="project-agent-accounts" className="border-b border-hairline py-4">
      <h4 id="project-agent-accounts" className="text-sm font-medium">Agent accounts</h4>
      <p className="text-xs text-muted-foreground">New sessions of this project start on these accounts. You can still choose another when you start one. Kept on this Mac only.</p>
      <div className="mt-3 flex flex-col gap-2">
        {rows.map((agent) => (
          <ProjectAccountRow key={agent} agent={agent} agentName={harnesses.find((harness) => harness.id === agent)?.name ?? (agent === "claude" ? "Claude Code" : "Codex")}
            view={views[agent]!} projectPath={projectPath} />
        ))}
      </div>
    </section>
  );
}

function ProjectAccountRow({ agent, agentName, view, projectPath }: { agent: AgentAccountAgent; agentName: string; view: AgentAccounts; projectPath: string }) {
  const menu = useRowMenu();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = view.projectDefaults[projectPath] ?? null;
  const ownLabel = accountLabel(view, own);
  const agentDefault = accountLabel(view, view.defaultAccount) ?? "This Mac's login";
  const never = view.autoSwitch?.setting.neverProjects.includes(projectPath) ?? false;
  const neverSwitch = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      takeAgentAccounts(await agentAccounts.setNeverSwitch(agent, projectPath, next));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = async (value: string) => {
    const next = value === FOLLOW_AGENT ? null : value;
    if (next === own) return;
    setBusy(true);
    setError(null);
    try {
      takeAgentAccounts(await agentAccounts.setDefault(agent, next, projectPath));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-sm">
        <AgentMark id={agent} className="size-3.5" decorative brand />
        {agentName}
      </span>
      <DropdownMenu {...menu.root}>
        <DropdownMenuTrigger asChild {...menu.trigger}>
          <Button size="sm" variant="outline" className="min-w-0 max-w-full gap-1.5" disabled={busy} aria-label={`${agentName} account for this project: ${ownLabel ?? `agent default, ${agentDefault}`}`}>
            <span className="truncate">{ownLabel ?? `Agent default (${agentDefault})`}</span>
            <ChevronDown className="text-faint" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[14rem]">
          <DropdownMenuLabel>{agentName} account</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={own ?? FOLLOW_AGENT} onValueChange={(value) => void choose(value)}>
            <DropdownMenuRadioItem value={FOLLOW_AGENT}>
              <span>Agent default</span>
              <span className="ml-auto pl-3 text-[12px] text-faint">{agentDefault}</span>
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {view.accounts.map((account) => (
              <DropdownMenuRadioItem key={account.id} value={account.id} disabled={account.missing}>
                <span className="min-w-0 truncate">{account.label}</span>
                {account.missing ? <span className="ml-auto pl-3 text-[12px] text-faint">sign in again</span> : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A project with an account of its own may keep its tabs there (#981). */}
      {view.autoSwitch?.offered && (own || never) && (
        <label className="flex basis-full items-center gap-2 pl-5.5 text-[12px] text-muted-foreground">
          <input type="checkbox" checked={never} disabled={busy} onChange={(e) => void neverSwitch(e.target.checked)} />
          Never switch accounts in this project
        </label>
      )}
      {error && <p role="alert" className="basis-full text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
