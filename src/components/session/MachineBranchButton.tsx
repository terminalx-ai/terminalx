import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, GitBranch, Loader2, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { DiffStats } from "@/components/changes/FileDiff";
import { isMac, joinKeycaps } from "@/lib/shortcuts";
import { useShortcut, useShortcutKeycaps } from "@/lib/hotkeys";
import { BRANCH_ACTIONS, BRANCH_STATES, type BranchAction } from "@/lib/branchStep";
import { currentMergeMethod, noteMerge, type MergeMethod } from "@/lib/mergeMethods";
import { openWorkspaceDelete } from "@/lib/dialogs";
import type { GitSource } from "@/lib/gitSource";
import type { FileSource } from "@/lib/workspaceFiles";
import type { SessionBackend } from "@/lib/sessionBackend";
import { agentPrompt, branchPr, composeMachineSnapshot, isAgentAction, isGithubRemote, machineBranchBase, sameBranchState, type MachineBranchSnapshot } from "@/lib/machineBranchStep";
import { primeSharedPrompts } from "@/lib/sharedSetups";
import type { SessionEntry } from "@/types/session";
import { WorkspaceRpcError } from "@terminalx/portable/workspace";
import type { RemovableWorkspace } from "@/lib/workspaceRemoval";

/** How often the machine's `git.status` is read while the window shows; file changes on the machine read it sooner. */
export const MACHINE_STATUS_EVERY_MS = 15_000;
/** How often the branch's pull request is read from GitHub through the machine. */
export const MACHINE_PR_EVERY_MS = 2 * 60_000;
/** File changes on the machine come in bursts (a save, an install): read once they settle. */
const SETTLE_MS = 800;

/** The pieces of a machine session the header's Git step reads and runs through (`CloudSessionModel`). */
export interface MachineBranchInput {
  session: SessionEntry;
  /** The machine's name, for the words that say where an action runs. */
  machineName: string;
  backend: SessionBackend;
  gitSource: GitSource | undefined;
  fileSource: FileSource | undefined;
  /** `origin`'s URL on the machine, for the repository the session works in. */
  remote: string | null;
  /** The branch the machine cut the worktree from. */
  baseRef: string | null;
  connected: boolean;
  tabId?: string;
}

interface Read {
  currentBranch: string | null | undefined;
  prCount: number | null;
  snapshot: MachineBranchSnapshot | null;
  diff: { additions: number; deletions: number; base: string } | null;
  diffNeedsUpdate: boolean;
  error: string | null;
  refreshing: boolean;
}

const EMPTY_READ: Read = { currentBranch: undefined, prCount: null, snapshot: null, diff: null, diffNeedsUpdate: false, error: null, refreshing: false };
const errorText = (source: GitSource | undefined, error: unknown) => (source ? source.errorMessage(error) : error instanceof Error ? error.message : String(error));

/**
 * The branch, its diff size and its next step, read from the machine (21.08).
 * Local Git (`git.status`) is read often and on every file change there; the
 * pull request (`git.prs`, GitHub through the machine's sign-in) is read on a
 * slower clock, after each action and when the window comes back. Every read
 * belongs to one source: a source that changed (another repository, a
 * reconnect) drops what the last one said.
 */
export function useMachineBranch(input: MachineBranchInput) {
  const { gitSource: source, fileSource, remote, connected, session, baseRef } = input;
  const busyTabs = session.tabs.some((tab) => tab.status === "in_progress" || tab.status === "waiting");
  const [agentPending, setAgentPending] = useState(false);
  const working = agentPending || busyTabs;
  const [read, setRead] = useState<Read>(EMPTY_READ);
  const refreshRef = useRef<(hosted: boolean) => Promise<MachineBranchSnapshot | null>>(async () => null);
  const workingRef = useRef(working);
  workingRef.current = working;
  const refresh = useCallback((hosted = true) => refreshRef.current(hosted), []);

  useEffect(() => {
    setRead(EMPTY_READ);
    if (!source || !connected) {
      refreshRef.current = async () => null;
      return;
    }
    let disposed = false;
    let hostedState: { key: string; pr: ReturnType<typeof branchPr>; count: number | null } | null = null;
    let running: Promise<MachineBranchSnapshot | null> | null = null;
    let again: boolean | null = null;
    let diffKey: string | null = null;
    let diffPending = false;

    const once = async (hosted: boolean): Promise<MachineBranchSnapshot | null> => {
      setRead((current) => ({ ...current, refreshing: true }));
      try {
        let work = await source.workStatus();
        if (disposed) return null;
        if (hosted && source.canWrite && source.fetch && work.branch && work.head && work.branch !== work.defaultBranch && isGithubRemote(remote)) {
          // Fetch first, as a local refresh does, so "behind" is what the remote has now.
          try {
            await source.fetch();
            if (disposed) return null;
            work = await source.workStatus();
          } catch { /* offline: the local steps still stand */ }
          if (disposed) return null;
        }
        const currentBranch = work.branch;
        if (currentBranch && work.head && currentBranch !== work.defaultBranch && isGithubRemote(remote)) {
          const key = JSON.stringify([currentBranch, work.head, work.upstream, work.ahead, work.behind]);
          if (hosted || hostedState?.key !== key) {
            try {
              const prs = (await source.prs(currentBranch)).filter((pr) => pr.head === currentBranch);
              hostedState = { key, pr: branchPr(prs, currentBranch), count: prs.length };
            } catch {
              hostedState = { key, pr: null, count: null };
            }
          }
          if (disposed) return null;
        } else {
          hostedState = null;
        }
        const prCount = hostedState?.count ?? null;
        const pr = hostedState?.pr ?? null;
        let selectedBaseRef = baseRef;
        let base = machineBranchBase(work, pr, selectedBaseRef);
        const comparison = work.isRepo && work.head && base && base !== work.defaultBranch
          ? await source.branchBase?.(base).catch((error: unknown) => {
            if (pr?.state !== "OPEN" && error instanceof WorkspaceRpcError && error.code === "base_not_found") {
              selectedBaseRef = null;
              base = work.defaultBranch;
            }
            return null;
          })
          : null;
        if (disposed) return null;
        const aheadOfBase = comparison ? (comparison.head === work.head ? comparison.aheadOfBase : null) : undefined;
        const snapshot = composeMachineSnapshot({ work, remote, pr, known: prCount !== null, working: workingRef.current, baseRef: selectedBaseRef, aheadOfBase });
        const key = work.isRepo && base ? JSON.stringify([currentBranch, work.head, base]) : null;
        const sameDiff = key === diffKey;
        diffKey = key;
        setRead((current) => ({
          ...current, currentBranch, prCount, snapshot, diff: sameDiff ? current.diff : null, error: null, refreshing: false,
        }));
        if (key && base && source.branchDiffSize && !diffPending) {
          const diffBase = base;
          diffPending = true;
          void source.branchDiffSize(diffBase).then((size) => {
            if (disposed || key !== diffKey) return;
            const diff = size !== "unsupported" && size.head === work.head
              ? { additions: size.additions, deletions: size.deletions, base: diffBase } : null;
            setRead((current) => ({ ...current, diff, diffNeedsUpdate: size === "unsupported" }));
          }).catch(() => {
            if (!disposed && key === diffKey) setRead((current) => ({ ...current, diff: null }));
          }).finally(() => { diffPending = false; });
        }
        return snapshot;
      } catch (error) {
        diffKey = null;
        if (!disposed) setRead({ ...EMPTY_READ, error: errorText(source, error) });
        return null;
      }
    };
    // One read at a time; a request while one runs is folded into one more after it (a hosted one wins).
    const run = (hosted: boolean): Promise<MachineBranchSnapshot | null> => {
      if (running) {
        again = again || hosted;
        return running.then(() => (running ?? Promise.resolve(null)));
      }
      running = once(hosted).finally(() => {
        running = null;
        const next = again;
        again = null;
        if (next !== null && !disposed) void run(next);
      });
      return running;
    };
    refreshRef.current = run;
    void run(true);

    const statusTimer = setInterval(() => { if (!document.hidden) void run(false); }, MACHINE_STATUS_EVERY_MS);
    const prTimer = setInterval(() => { if (!document.hidden) void run(true); }, MACHINE_PR_EVERY_MS);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const stopWatch = fileSource?.watch?.(() => {
      clearTimeout(settle);
      settle = setTimeout(() => void run(false), SETTLE_MS);
    });
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => {
      if (document.hidden) return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => void run(true), 600);
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearInterval(statusTimer);
      clearInterval(prTimer);
      clearTimeout(settle);
      clearTimeout(focusTimer);
      stopWatch?.();
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [source, fileSource, remote, connected, baseRef]);

  // An agent step is over once its tab has worked and gone idle again.
  const agentRun = useRef<{ tabId: string; started: boolean } | null>(null);
  const [agentDone, setAgentDone] = useState(0);
  useEffect(() => {
    const tracked = agentRun.current;
    if (!tracked) return;
    const tab = session.tabs.find((entry) => entry.id === tracked.tabId);
    if (tab?.status === "in_progress" || tab?.status === "waiting") tracked.started = true;
    else if (tracked.started || !tab) {
      agentRun.current = null;
      setAgentPending(false);
      setAgentDone((count) => count + 1);
    }
  }, [session.tabs]);
  // A completed turn may have committed, pushed, or opened a PR.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) void refresh(true);
    wasWorking.current = working;
  }, [working, refresh]);
  const agent = useMemo(() => ({
    start(tabId: string) { agentRun.current = { tabId, started: false }; setAgentPending(true); },
    cancel() { agentRun.current = null; setAgentPending(false); },
  }), []);

  return { ...read, refresh, working, agent, agentDone, input };
}

export type MachineBranch = ReturnType<typeof useMachineBranch>;

/** The branch's lines added and removed against its base, after the branch chip (21.08). */
export function MachineDiffSize({ branch, className }: { branch: MachineBranch; className?: string }) {
  const { diff, currentBranch } = branch;
  if (branch.diffNeedsUpdate) {
    const notice = `Update ${branch.input.machineName} for diff totals`;
    return <span role="status" className={className}><span className="max-w-48 truncate text-xs text-warning" title={notice}>{notice}</span></span>;
  }
  if (!diff || (!diff.additions && !diff.deletions)) return null;
  return (
    <span className={className} title={`Changes on ${currentBranch ?? "detached HEAD"} against ${diff.base}, uncommitted work included`} data-testid="machine-diff-size">
      <DiffStats additions={diff.additions} deletions={diff.deletions} />
    </span>
  );
}

/** The pending confirmation: what will run, on which snapshot, and the merge method a Merge uses. */
interface Pending { action: BranchAction; expected: MachineBranchSnapshot; source: GitSource; method?: MergeMethod }

/**
 * The header's branch actions for a session on a paired machine (21.08):
 * the branch's diff size, and the same split button as a local session's, whose
 * actions run on the machine through its `git/1` with the machine's Git
 * sign-in. Commits carry this computer's Git identity, as in Changes.
 */
export function MachineBranchButton({ branch, workspace }: { branch: MachineBranch; workspace?: RemovableWorkspace }) {
  const { session, backend, gitSource: source, machineName, tabId } = branch.input;
  const { snapshot, error: readError, refreshing, refresh, working, agent: agentRun, agentDone } = branch;
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState("");
  const [body, setBody] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const activeSource = useRef(source);
  activeSource.current = source;
  // Publishing from this session through the machine's sign-in, allowed once per branch while the view is open.
  const approved = useRef(new Set<string>());
  const keycaps = useShortcutKeycaps();
  const canWrite = !!source?.canWrite;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (agentDone) setNotice("Agent finished. Review the changes before committing and pushing."); }, [agentDone]);

  const state = working ? BRANCH_STATES.agentWorking : snapshot ? BRANCH_STATES[snapshot.state] : null;
  const enabled = (action: BranchAction) => canWrite && !!snapshot?.actions.includes(action) && !readError && !working && !running
    && (!isAgentAction(action, snapshot) || !!tabId);

  const run = async (request: Pending, text: { message: string; body: string }) => {
    if (lock.current || !source) return;
    lock.current = true;
    setPending(null);
    setError(null);
    setNotice(null);
    const agent = isAgentAction(request.action, request.expected);
    setRunning(agent ? "Sending to agent…" : BRANCH_ACTIONS[request.action].progress);
    try {
      if (request.source !== source) throw new Error("The machine reconnected while preparing the action. Refresh and try again.");
      // The branch is read again on the machine; an action prepared on an older state does not run.
      const now = await refresh(true);
      if (!alive.current || activeSource.current !== source) return;
      if (!now || !sameBranchState(request.expected, now) || !now.actions.includes(request.action)) {
        throw new Error("The branch changed on the machine while preparing the action. Refresh and try again.");
      }
      let result: string | null = null;
      if (agent) {
        if (!tabId) throw new Error("Open an agent tab to send this to the agent.");
        agentRun.start(tabId);
        await primeSharedPrompts(session.id);
        await backend.send(tabId, agentPrompt(request.action, now, session.id), []);
      } else {
        const pr = now.pr?.state === "OPEN" ? now.pr : null;
        switch (request.action) {
          case "commitPush": {
            if (!source.commitForPush) throw new Error("Commit and push is unavailable for this checkout.");
            const committed = await source.commitForPush(text.message.trim(), now.branch, now.head);
            try { result = await source.push(now.branch, committed); }
            catch (reason) { throw new Error(`Committed on ${machineName}, but the push failed: ${errorText(source, reason)} Your commit is safe; refresh to see the next step.`); }
            break;
          }
          case "push":
            result = await source.push(now.branch, now.head);
            break;
          case "createPr": {
            const input = { title: text.message.trim(), body: text.body, base: now.base, draft: false, sessionId: session.id, branch: now.branch };
            if (now.state === "ahead") {
              if (!source.createPrWithPush || !now.head) throw new Error("Verified PR publishing is unavailable for this checkout.");
              result = await source.createPrWithPush(input, now.head);
            } else {
              result = await source.createPr(input);
            }
            break;
          }
          case "pull":
            result = await source.pull();
            break;
          case "markReady":
            if (!pr) throw new Error("There is no open pull request.");
            await source.readyPr(pr.number);
            break;
          case "merge": {
            if (!pr?.headSha) throw new Error("There is no open pull request to merge. Refresh and try again.");
            const method = request.method ?? currentMergeMethod(pr.url, null);
            // Pinned to the head that was checked: GitHub refuses it once the head has moved.
            await source.mergePr(pr.number, method, pr.headSha);
            noteMerge(pr.url, method);
            result = "Merged";
            break;
          }
          default:
            throw new Error("This action is not available in the branch's current state. Refresh and try again.");
        }
      }
      if (!agent && alive.current) setNotice(result ?? `${BRANCH_ACTIONS[request.action].label}: done on ${machineName}.`);
    } catch (reason) {
      if (agent) agentRun.cancel();
      if (alive.current) setError(errorText(source, reason));
    } finally {
      lock.current = false;
      if (alive.current) setRunning(null);
      void refresh(true);
    }
  };

  const prepare = async (action: BranchAction) => {
    if (lock.current || pending || !snapshot || !enabled(action) || !source) return;
    setError(null);
    setNotice(null);
    const request: Pending = { action, expected: snapshot, source };
    if (action === "merge" && snapshot.pr) {
      lock.current = true;
      setRunning("Reading merge methods…");
      try {
        const methods = source.conversation ? (await source.conversation(snapshot.pr).read()).mergeMethods : null;
        request.method = currentMergeMethod(snapshot.pr.url, methods);
      } catch {
        request.method = currentMergeMethod(snapshot.pr.url, null);
      } finally {
        lock.current = false;
        if (alive.current) setRunning(null);
      }
      if (!alive.current || activeSource.current !== source) return;
    }
    const publishes = !!BRANCH_ACTIONS[action].publishes;
    if (action === "commitPush" || action === "createPr" || action === "merge" || (publishes && !approved.current.has(snapshot.branch))) {
      setMessage(action === "createPr" ? session.title : "");
      setBody("");
      setPending(request);
      return;
    }
    await run(request, { message: "", body: "" });
  };

  const latest = useRef({ prepare, enabled, pending, snapshot });
  latest.current = { prepare, enabled, pending, snapshot };
  // Stable registrations keep shortcut precedence unchanged as status updates (as BranchGitButton's).
  const shortcuts = useMemo(() => {
    const handler = (action: BranchAction) => (event: KeyboardEvent) => {
      if (!isMac && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c" && event.target instanceof Element && event.target.closest(".xterm, .terminal-host")) return false;
      const now = latest.current;
      const actual = action === "commitPush" && now.snapshot?.state === "ahead" ? "push" : action;
      if (lock.current || now.pending || !now.enabled(actual) || document.querySelector('[role="dialog"], [role="alertdialog"]')) return false;
      void now.prepare(actual);
    };
    return { commitPush: handler("commitPush"), createPr: handler("createPr"), pull: handler("pull"), fixChecks: handler("fixChecks"), merge: handler("merge") };
  }, []);
  useShortcut("git.commitPush", shortcuts.commitPush);
  useShortcut("git.createPr", shortcuts.createPr);
  useShortcut("git.pull", shortcuts.pull);
  useShortcut("git.fixChecks", shortcuts.fixChecks);
  useShortcut("git.merge", shortcuts.merge);

  const failure = error ?? readError;
  const hasGitFeedback = !!(failure || running || pending);
  const showGitStep = !!snapshot && (snapshot.state !== "merged" || hasGitFeedback);
  if (!showGitStep && !workspace && !hasGitFeedback) return null;
  const where = `Runs on ${machineName} with its Git sign-in.`;
  const tooltip = snapshot
    ? `${state?.detail}. Base: ${snapshot.base}. ${where}${snapshot.state === "behind" ? (snapshot.pullNeedsAgent ? (snapshot.behindUpstream ? " The agent preserves uncommitted work while pulling." : " The agent merges the latest base into this branch.") : " Pull fast-forwards from the upstream branch.") : ""}${canWrite ? "" : " You may only read this machine's Git."}`
    : "Reading branch status";
  const needsMessage = pending?.action === "commitPush" || pending?.action === "createPr";
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="machine-branch-button">
      {(showGitStep || workspace) && <div className="flex shrink-0 items-center">
        {showGitStep && <WithTooltip label={tooltip} shortcut={state?.action ? BRANCH_ACTIONS[state.action].shortcut : undefined}>
          <Button variant="outline" size="sm" className="max-w-44 rounded-r-none border-r-0" aria-label={running ?? (state?.label || "Git actions")} disabled={!state?.action || !enabled(state.action) || !!pending} onClick={() => state?.action && void prepare(state.action)}>
            {running || refreshing || working ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
            <span className="truncate @max-[520px]/session-header:hidden">{running ?? (state?.label || "Git actions")}</span>
          </Button>
        </WithTooltip>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className={showGitStep ? "rounded-l-none px-1.5" : undefined} aria-label="Git actions">{!showGitStep && <GitBranch className="size-3.5" />}<ChevronDown className="size-3" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showGitStep && (Object.entries(BRANCH_ACTIONS) as [BranchAction, typeof BRANCH_ACTIONS[BranchAction]][]).map(([action, definition]) => (
              <DropdownMenuItem key={action} disabled={!enabled(action) || !!pending} onSelect={() => void prepare(action)}>
                {action === "resolveConflicts" && snapshot.state === "diverged" ? BRANCH_STATES.diverged.label : definition.label}{definition.shortcut && <span className="ml-auto pl-4 text-xs text-muted-foreground">{joinKeycaps(keycaps(definition.shortcut))}</span>}
              </DropdownMenuItem>
            ))}
            {showGitStep && <DropdownMenuSeparator />}
            {snapshot?.pr && <DropdownMenuItem onSelect={() => void openUrl(snapshot.pr!.url).catch((reason) => setError(errorText(source, reason)))}>Open pull request</DropdownMenuItem>}
            {source && <DropdownMenuItem disabled={refreshing} onSelect={() => void refresh(true)}>Refresh Git status</DropdownMenuItem>}
            {workspace && (
              <DropdownMenuItem destructive onSelect={() => openWorkspaceDelete(workspace.projectPath, workspace.path, workspace.name, workspace.host)}>
                <Trash2 /> Delete workspace…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
      {failure ? <span role="alert" className="max-w-48 truncate text-xs text-destructive" title={failure}>{failure}</span>
        : notice && <span role="status" className="max-w-48 truncate text-xs text-muted-foreground" title={notice}>{notice}</span>}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending ? BRANCH_ACTIONS[pending.action].label : "Git action"}</DialogTitle>
            <DialogDescription>
              {pending?.action === "commitPush" ? `Commit all staged, unstaged and new files in this checkout on ${machineName}, then push to origin. ` : null}
              {pending?.action === "createPr" ? `Push ${pending.expected.branch} and open a pull request into ${pending.expected.base}. ` : null}
              {pending?.action === "merge" ? `Merge #${pending.expected.pr?.number} into ${pending.expected.base} using ${pending.method}. ` : null}
              {pending?.action === "push" ? `Push ${pending.expected.branch} to origin. ` : null}
              {where}
            </DialogDescription>
          </DialogHeader>
          {needsMessage && <label className="block text-sm">{pending?.action === "createPr" ? "PR title" : "Commit message"}<input autoFocus className="mt-1 w-full rounded-md border border-hairline bg-transparent px-3 py-2" value={message} onChange={(event) => setMessage(event.target.value)} /></label>}
          {pending?.action === "createPr" && <label className="mt-3 block text-sm">Description<textarea className="mt-1 min-h-24 w-full rounded-md border border-hairline bg-transparent px-3 py-2" value={body} onChange={(event) => setBody(event.target.value)} /></label>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button disabled={!pending || (needsMessage && !message.trim())} onClick={() => {
              if (!pending) return;
              if (BRANCH_ACTIONS[pending.action].publishes) approved.current.add(pending.expected.branch);
              void run(pending, { message, body });
            }}>{pending ? BRANCH_ACTIONS[pending.action].label : "Continue"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
