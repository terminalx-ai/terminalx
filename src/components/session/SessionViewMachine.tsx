import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, Copy, Ellipsis, Folder, Gauge, GitBranch, GitPullRequest, Loader2, RefreshCw, SessionContinue, Trash2 } from "@/icons";
import { agentName } from "@/components/AgentMark";
import { removeMachineWorkspace } from "@/components/changes/machinePanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { BRANCH_ACTIONS, BRANCH_STATES, type BranchAction } from "@/lib/branchStep";
import { copyText } from "@/lib/clipboard";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { cn } from "@/lib/cn";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import type { MachineBranchSnapshot } from "@/lib/machineSessionBranch";
import { modelLabel } from "@/lib/models";
import { showPanelTab } from "@/lib/panelTab";
import type { ModelUsage, SessionEntry } from "@/types/session";
import { billingOf, formatCost, formatTokens, modelAgent, resetLabel, sessionModels, totals } from "./SessionCost";

/**
 * A session on a paired machine, in its header (PRO-404, PRO-406, PRO-408):
 * the branch's diff size, its pull requests and its next Git step, the
 * session's cost, the worktree's menu (Remove worktree, Continue in a new
 * tab) and Fix check errors. Each control acts through the machine session's
 * model (`CloudSessionModel.branch`, `checks`, `usage`, `removableWorkspace`,
 * `continueInNewTab`): it reads from and runs on the machine. None of them
 * runs git or gh here, reads this computer's session files or transcripts,
 * or removes a worktree of this computer.
 */

type MergeMethod = "merge" | "squash" | "rebase";

/** What a machine session's Fix check errors is doing, shared by the header and the side panel's checks. */
export interface MachineCheckFix {
  /** The machine reads failed logs (`machine/10`), this computer manages it, and a tab can be sent them. */
  offered: boolean;
  /** Why it cannot run now; null when it can. */
  blocked: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  /** Save the failed logs on the machine and send the open tab the prompt naming them. */
  fix(prUrl?: string): Promise<void>;
  clear(): void;
}

/** Fix check errors for a machine session's open tab, through `cloud.checks` (`session.checkFailures` on the machine). */
export function useMachineCheckFix(cloud: CloudSessionModel | undefined, tabId: string | undefined): MachineCheckFix {
  const checks = cloud?.machine ? cloud.checks : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionId = cloud?.session.id;
  useEffect(() => {
    setError(null);
    setNotice(null);
  }, [sessionId]);
  const lock = useRef(false);
  const fix = useCallback(
    async (prUrl?: string) => {
      if (lock.current) return;
      if (!checks || !tabId) {
        setError("Open an agent tab to send it the failed check logs.");
        return;
      }
      lock.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        setNotice(await checks.fix(tabId, prUrl));
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [checks, tabId],
  );
  const clear = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);
  return { offered: !!checks?.served && !!tabId, blocked: checks?.blocked ?? null, busy, error, notice, fix, clear };
}

/** The bar under the header while failed logs are collected on the machine, and what came of it. */
export function MachineCheckFixNotice({ fix }: { fix: MachineCheckFix }) {
  if (!fix.busy && !fix.error && !fix.notice) return null;
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-3 py-2 text-xs" role={fix.error ? "alert" : "status"} data-testid="machine-check-fix">
      <span className={cn("min-w-0 flex-1", fix.error ? "text-destructive" : "text-muted-foreground")}>{fix.busy ? "Collecting failed check logs on the machine…" : (fix.error ?? fix.notice)}</span>
      {!fix.busy && <Button size="xs" variant="ghost" onClick={fix.clear}>Dismiss</Button>}
    </div>
  );
}

const STAT_CHIP = "ml-1 flex h-5 shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 text-[11px] text-muted-foreground";

/** The branch's diff size and its pull requests, beside its name (21.08). Nothing until the machine has answered. */
export function MachineBranchStats({ cloud, className }: { cloud: CloudSessionModel; className?: string }) {
  const branch = cloud.branch;
  if (!branch?.served) return null;
  const { diff, prs, prsKnown, snapshot } = branch;
  const open = prs.filter((pr) => pr.state === "OPEN").length;
  return (
    <>
      {diff && (
        <span
          className={cn(STAT_CHIP, "font-mono", className)}
          title={`Lines added and removed on ${snapshot?.branch ?? branch.branchName ?? "the branch"} against ${snapshot?.base ?? "its base"} on ${cloud.machine?.name ?? "the machine"}, uncommitted work included`}
          data-testid="machine-diff-size"
        >
          <span className="text-add">+{diff.additions}</span>
          <span className="text-destructive">−{diff.deletions}</span>
        </span>
      )}
      {prsKnown && prs.length > 0 && (
        <button
          type="button"
          className={cn(STAT_CHIP, "hover:text-foreground", className)}
          title={open ? `${open} open of ${prs.length} on GitHub` : `${prs.length} on GitHub, none open`}
          onClick={() => showPanelTab("branch")}
          data-testid="machine-pr-count"
        >
          <GitPullRequest className="size-3" />
          {prs.length} {prs.length === 1 ? "PR" : "PRs"}
        </button>
      )}
    </>
  );
}

interface Pending {
  action: BranchAction;
  expected: MachineBranchSnapshot;
}

/**
 * The header's Git step for a machine session (PRO-404): Create PR, Push,
 * Commit and push, Pull, Mark ready and Merge run through the machine's
 * `git/1` with its Git sign-in (`cloud.branch`); a merge is checked again
 * there and pinned to the head shown (`machine/9`). The agent's steps
 * (Resolve conflicts, Address review, Fix checks) are sent to the open tab on
 * the machine; Fix checks first saves the failed logs there (`cloud.checks`).
 */
export function MachineBranchButton({ cloud, tabId, checkFix }: { cloud: CloudSessionModel; tabId?: string; checkFix: MachineCheckFix }) {
  const branch = cloud.branch;
  const name = cloud.machine?.name ?? "the machine";
  const snapshot = branch?.snapshot ?? null;
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("merge");
  const lock = useRef(false);
  const sessionId = cloud.session.id;
  useEffect(() => {
    setError(null);
    setNotice(null);
    setPending(null);
  }, [sessionId]);
  if (!branch?.served) return null;

  const state = snapshot ? BRANCH_STATES[snapshot.state] : null;
  const isAgent = (action: BranchAction) => branch.isAgentAction(action);
  const readOnly = !cloud.manage ? `Only a computer paired with ${name} changes its Git.` : null;
  const enabled = (action: BranchAction) =>
    !!snapshot?.actions.includes(action) && !readOnly && !running && !pending && !checkFix.busy && (!isAgent(action) || !!tabId);

  const toAgent = async (action: BranchAction): Promise<string> => {
    if (!tabId) throw new Error("Open an agent tab to send it this step.");
    // Fix checks with the failed logs saved on the machine, where it serves that; else the step's words alone.
    if (action === "fixChecks" && cloud.checks?.served) {
      await checkFix.fix(snapshot?.pr?.url);
      return "";
    }
    const prompt = branch.agentPrompt(action);
    if (!prompt) throw new Error("The branch changed since it was shown. Look at it again.");
    const sent = await cloud.backend.send(tabId, prompt, []);
    return sent.queued ? `Queued for the agent on ${name}.` : `Sent to the agent on ${name}.`;
  };

  const run = async (action: BranchAction, expected: MachineBranchSnapshot) => {
    if (lock.current) return;
    lock.current = true;
    setPending(null);
    setError(null);
    setNotice(null);
    setRunning(isAgent(action) ? "Sending to agent…" : BRANCH_ACTIONS[action].progress);
    try {
      let said: string | null = null;
      if (isAgent(action)) said = await toAgent(action);
      else if (action === "push") said = await branch.push();
      else if (action === "pull") said = await branch.pull();
      else if (action === "commitPush") said = await branch.commitPush(message.trim());
      else if (action === "createPr") said = await branch.createPr({ title: message.trim(), body, draft });
      else if (action === "markReady") await branch.markReady();
      else if (action === "merge") {
        await branch.merge(method, expected);
        said = `Merged #${expected.pr?.number ?? ""} into ${expected.base}.`;
      }
      if (said) setNotice(said);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setRunning(null);
    }
  };

  const prepare = (action: BranchAction) => {
    if (!snapshot || !enabled(action)) return;
    // A message, a title or a merge method first; the rest runs at once.
    if (action === "commitPush" || action === "createPr" || action === "merge") {
      setMessage(action === "createPr" ? cloud.session.title : "");
      setBody("");
      setDraft(false);
      setPending({ action, expected: snapshot });
      return;
    }
    void run(action, snapshot);
  };

  if ((!snapshot || snapshot.state === "hidden" || snapshot.state === "merged") && !branch.error && !error && !running && !pending) return null;
  const primary = state?.action ?? null;
  const tooltip = readOnly ?? (snapshot ? `${state?.detail}. Base: ${snapshot.base}. Runs on ${name}.` : branch.error ? `Couldn't read the branch on ${name}: ${branch.error}` : `Reading the branch on ${name}`);
  const label = running ?? (state?.label || "Git actions");
  const failure = error ?? (snapshot ? null : branch.error);
  const needsMessage = pending?.action === "commitPush" || pending?.action === "createPr";
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="machine-branch-button">
      <div className="flex shrink-0 items-center">
        <WithTooltip label={tooltip}>
          <Button variant="outline" size="sm" className="max-w-44 rounded-r-none border-r-0" aria-label={label} disabled={!primary || !enabled(primary)} onClick={() => primary && prepare(primary)}>
            {running || branch.loading || snapshot?.state === "agentWorking" ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
            <span className="truncate @max-[520px]/session-header:hidden">{label}</span>
          </Button>
        </WithTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="rounded-l-none px-1.5" aria-label="Git actions">
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="font-normal text-muted-foreground">On {name}</DropdownMenuLabel>
            {(Object.entries(BRANCH_ACTIONS) as [BranchAction, (typeof BRANCH_ACTIONS)[BranchAction]][]).map(([action, definition]) => (
              <DropdownMenuItem key={action} disabled={!enabled(action)} onSelect={() => prepare(action)}>
                {action === "resolveConflicts" && snapshot?.state === "diverged" ? BRANCH_STATES.diverged.label : definition.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {snapshot?.pr && <DropdownMenuItem onSelect={() => void openUrl(snapshot.pr!.url).catch((cause: unknown) => setError(errorMessage(cause)))}>Open pull request</DropdownMenuItem>}
            <DropdownMenuItem disabled={branch.loading} onSelect={() => void branch.refresh()}>
              Refresh Git status
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {failure ? (
        <span role="alert" className="max-w-48 truncate text-xs text-destructive" title={failure}>{failure}</span>
      ) : (
        notice && <span role="status" className="max-w-48 truncate text-xs text-muted-foreground" title={notice}>{notice}</span>
      )}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending ? BRANCH_ACTIONS[pending.action].label : "Git action"}</DialogTitle>
            <DialogDescription>
              {pending?.action === "commitPush" && `Commit all staged, unstaged and new files in the session's worktree on ${name}, then push to origin with ${name}'s Git sign-in.`}
              {pending?.action === "createPr" && `Open a pull request from ${pending.expected.branch} into ${pending.expected.base}, through ${name}'s GitHub sign-in.`}
              {pending?.action === "merge" &&
                `Merge #${pending.expected.pr?.number ?? ""} into ${pending.expected.base} through ${name}'s GitHub sign-in. ${branch.headPinned ? `GitHub refuses it if the head moved from ${pending.expected.head.slice(0, 7)}.` : "The branch is read again first, and nothing merges if it changed."}`}
            </DialogDescription>
          </DialogHeader>
          {needsMessage && (
            <label className="block text-sm">
              {pending?.action === "createPr" ? "PR title" : "Commit message"}
              <input autoFocus className="mt-1 w-full rounded-md border border-hairline bg-transparent px-3 py-2" value={message} onChange={(event) => setMessage(event.target.value)} />
            </label>
          )}
          {pending?.action === "createPr" && (
            <>
              <label className="mt-3 block text-sm">
                Description
                <textarea className="mt-1 min-h-24 w-full rounded-md border border-hairline bg-transparent px-3 py-2" value={body} onChange={(event) => setBody(event.target.value)} />
              </label>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
                Open as a draft
              </label>
            </>
          )}
          {pending?.action === "merge" && (
            <label className="block text-sm">
              Merge method
              <select aria-label="Merge method" className="mt-1 h-8 w-full rounded-md border border-hairline bg-transparent px-2" value={method} onChange={(event) => setMethod(event.target.value as MergeMethod)}>
                <option value="merge">Merge commit</option>
                <option value="squash">Squash and merge</option>
                <option value="rebase">Rebase and merge</option>
              </select>
            </label>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button disabled={!pending || (needsMessage && !message.trim())} onClick={() => pending && void run(pending.action, pending.expected)}>
              {pending ? BRANCH_ACTIONS[pending.action].label : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const COLUMNS = { gridTemplateColumns: "minmax(0,1fr) 48px 48px 56px 54px" };

const SUBTITLE = {
  subscription: "subscriptions · nothing billed per token",
  api: "API key · billed per token",
  unknown: "at API list prices",
} as const;

/**
 * A machine session's estimated cost (PRO-408): each tab's totals as the
 * machine's session list carries them (`TabEntry.usage`), read again on the
 * machine when the popover opens (`session.usage`), with how its agents sign
 * in there and its usage windows. Behind Settings → Experimental → Session
 * cost, as a local session's.
 */
export function MachineSessionCost({ cloud, session, className }: { cloud: CloudSessionModel; session: SessionEntry; className?: string }) {
  const settings = useExperimentalSettings();
  const usage = cloud.usage;
  const [open, setOpen] = useState(false);
  const read = usage?.read ?? null;
  // The machine's last count once read; until then what its session list says of each tab.
  const models = useMemo<ModelUsage[]>(() => (read ? [...read.usage.models].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.model.localeCompare(b.model)) : sessionModels(session)), [read, session]);
  const total = useMemo(() => totals(models), [models]);
  const refresh = usage?.refresh;
  useEffect(() => {
    if (open && refresh) void refresh();
  }, [open, refresh]);
  if (settings?.sessionCost !== true || !models.length) return null;
  const partial = total.costUsd != null && total.unpricedModels.length > 0;
  const label = total.costUsd == null ? "≈ —" : `≈ ${formatCost(total.costUsd)}${partial ? "+" : ""}`;
  const name = cloud.machine?.name ?? "the machine";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={total.costUsd == null ? "Session usage: no price for its models" : `Session usage: estimated ${formatCost(total.costUsd)}${partial ? " and more" : ""}`}
          title={`Estimated session cost, counted on ${name}`}
          className={cn("flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-veil-raised px-2 font-mono text-[12px] text-foreground hover:bg-veil-strong focus-visible:outline focus-visible:outline-ring", className)}
          data-testid="session-cost"
        >
          <Gauge className="size-3 text-muted-foreground" />
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Session usage"
          className="z-(--z-menu) w-[400px] max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-auto rounded-xl border border-hairline bg-popover text-sm text-popover-foreground shadow-surface outline-none"
        >
          <MachineUsage cloud={cloud} session={session} models={models} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MachineUsage({ cloud, session, models }: { cloud: CloudSessionModel; session: SessionEntry; models: ModelUsage[] }) {
  const usage = cloud.usage;
  const read = usage?.read ?? null;
  const name = cloud.machine?.name ?? "the machine";
  const total = totals(models);
  const agents = [...new Set(models.map((row) => modelAgent(row.model)))];
  const billing = read ? billingOf(agents.map((agent) => read.loginMethods[agent] ?? null)) : "unknown";
  const now = Date.now();
  const windows = (read?.windows ?? []).filter((window) => agents.includes(window.agent));
  const tabs = read
    ? read.usage.tabs.filter((tab) => tab.models.length).map((tab) => ({ id: tab.tabId, title: tab.title || agentName(tab.agent), models: tab.models }))
    : session.tabs.filter((tab) => tab.usage?.models.length).map((tab) => ({ id: tab.id, title: tab.title || agentName(tab.harness), models: tab.usage!.models }));
  return (
    <>
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2.5 text-[13px]">
        <span className="shrink-0 whitespace-nowrap font-medium">Session usage</span>
        <span className="truncate text-[11px] text-faint" data-testid="session-usage-billing">{SUBTITLE[billing]}</span>
        <span className="ml-auto shrink-0 text-right leading-4">
          <span className="font-mono text-[15px] font-semibold" data-testid="session-usage-total">{formatCost(total.costUsd)}</span>
          <span className="block text-[10.5px] text-faint">{billing === "subscription" ? "API-equivalent" : "estimate"}</span>
        </span>
      </div>
      <div className="mx-3 rounded-lg border border-hairline bg-(--surface-raised)" role="table" aria-label="Tokens by model">
        <div role="row" className="grid h-7 items-center gap-x-3 border-b border-hairline px-3 text-[10.5px] font-medium uppercase tracking-[.08em] text-faint" style={COLUMNS}>
          <span role="columnheader">Model</span>
          <span role="columnheader" className="text-right">In</span>
          <span role="columnheader" className="text-right">Out</span>
          <span role="columnheader" className="text-right">Cache</span>
          <span role="columnheader" className="text-right">Cost</span>
        </div>
        {models.map((row) => (
          <div key={row.model} role="row" className="grid h-8 items-center gap-x-3 border-b border-hairline px-3 font-mono text-[12px] last:border-b-0" style={COLUMNS} data-testid="session-usage-model">
            <span role="cell" className="flex min-w-0 items-center gap-1.5 font-sans" title={row.model}>
              <span className={cn("size-1.5 shrink-0 rounded-full", modelAgent(row.model) === "claude" ? "bg-(--accent-add)" : "bg-accent")} />
              <span className="truncate">{modelLabel(modelAgent(row.model), row.model)}</span>
            </span>
            <span role="cell" className="text-right text-muted-foreground">{formatTokens(row.inputTokens)}</span>
            <span role="cell" className="text-right text-muted-foreground">{formatTokens(row.outputTokens)}</span>
            <span role="cell" className="text-right text-muted-foreground">{formatTokens(row.cacheReadTokens + row.cacheWriteTokens)}</span>
            <span role="cell" className={cn("text-right", row.costUsd == null ? "text-faint" : "text-foreground")}>{formatCost(row.costUsd)}</span>
          </div>
        ))}
      </div>
      {(tabs.length > 1 || total.unpricedModels.length > 0) && (
        <div className="grid gap-1.5 px-3.5 py-2.5 text-[12px]">
          {tabs.length > 1 &&
            tabs.map((tab) => (
              <div key={tab.id} className="flex items-center gap-2" data-testid="session-usage-tab">
                <span className="min-w-0 truncate text-muted-foreground">Tab “{tab.title}”</span>
                <span className="ml-auto font-mono">{formatCost(totals(tab.models).costUsd)}</span>
              </div>
            ))}
          {total.unpricedModels.length > 0 && <p className="text-[11px] text-faint">No price for {total.unpricedModels.join(", ")}: its tokens are counted, its cost is not.</p>}
        </div>
      )}
      {windows.length > 0 && (
        <div className="grid gap-2 border-t border-hairline px-3.5 py-2.5 text-[12px]">
          <div className="text-[10.5px] font-medium uppercase tracking-[.08em] text-faint">Usage windows on {name}</div>
          {windows.map((window) => {
            const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
            return (
              <div key={`${window.agent}:${window.key}`} className="flex items-center gap-2" data-testid="session-usage-window">
                <span className="w-[104px] shrink-0 truncate text-muted-foreground">{agentName(window.agent)} · {window.label}</span>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-veil-strong"><span className="block h-1 bg-accent" style={{ width: `${percent}%` }} /></span>
                <span className="w-9 text-right font-mono tabular-nums">{percent}%</span>
                <span className="w-[76px] text-right text-faint">{window.resetsAt != null && window.resetsAt > now ? resetLabel(window.resetsAt, now) : window.stale ? "last known" : ""}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex h-10 items-center gap-2 border-t border-hairline px-3.5 text-[12px] text-muted-foreground">
        <span className="min-w-0 truncate" role={usage?.error ? "alert" : undefined}>
          {usage?.error ? `Couldn't read it again on ${name}: ${usage.error}` : !usage?.served ? `${name} runs an older TerminalX: these are its session list's totals.` : `Counted on ${name} from its agents' transcripts.`}
        </span>
        {usage?.served && (
          <button type="button" className="ml-auto flex shrink-0 items-center gap-1.5 hover:text-foreground" disabled={usage.loading} onClick={() => void usage.refresh()}>
            <RefreshCw className={cn("size-[13px]", usage.loading && "animate-spin")} /> Read again
          </button>
        )}
      </div>
    </>
  );
}

/**
 * A machine session's worktree menu, beside its branch: the folder it runs
 * in on the machine, Copy branch name, Continue in a new tab and Remove
 * worktree. The removal dialog asks the machine (`removableWorkspace.host`,
 * `workspace.disposition`/`workspace.remove`) what would be lost and removes
 * it there; it is offered only to a manager, for a worktree other than the
 * project's own folder. The machine's path is only shown.
 */
export function MachineWorkspaceMenu({ cloud, session, onContinue }: { cloud: CloudSessionModel; session: SessionEntry; onContinue: (() => void) | null }) {
  const name = cloud.machine?.name ?? "the machine";
  const workspace = cloud.removableWorkspace;
  const branch = session.branch;
  if (!workspace && !branch && !onContinue) return null;
  return (
    <DropdownMenu>
      <WithTooltip label="Workspace">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Workspace details" className="ml-0.5 shrink-0 text-faint hover:text-foreground" data-testid="machine-workspace-menu">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          {workspace && (
            <span className="flex items-center gap-1.5 text-foreground" title={workspace.path}>
              <Folder className="size-3.5 text-faint" />
              {workspace.name}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">On {name}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {branch && (
          <DropdownMenuItem onSelect={() => void copyText(branch).catch(() => {})}>
            <Copy /> Copy branch name
          </DropdownMenuItem>
        )}
        {onContinue && (
          <DropdownMenuItem disabled={!!cloud.continueBlocked} onSelect={onContinue} title={cloud.continueBlocked ?? undefined}>
            <SessionContinue /> Continue in a New Tab…
          </DropdownMenuItem>
        )}
        {workspace && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => removeMachineWorkspace(workspace)} className="text-destructive">
              <Trash2 /> Remove worktree on {name}…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
