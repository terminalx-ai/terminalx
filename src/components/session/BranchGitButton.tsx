import { gh } from "@/lib/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, GitBranch, Loader2 } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { isMac } from "@/lib/shortcuts";
import { useShortcut, useShortcutKeycaps } from "@/lib/hotkeys";
import { BRANCH_ACTIONS, BRANCH_STATES, branchError, branchStep, useBranchStep, type BranchAction, type BranchRequest } from "@/lib/branchStep";
import type { SessionEntry } from "@/types/session";
import type { AgentEvent } from "@/types/events";

export function BranchGitButton({ session, tabId }: { session: SessionEntry; tabId?: string }) {
  const statusKey = session.tabs.map((tab) => `${tab.id}:${tab.status}`).join(",");
  const { snapshot, error: readError, refreshing, refresh } = useBranchStep(session.id, statusKey);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<BranchRequest | null>(null);
  const [message, setMessage] = useState("");
  const [body, setBody] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const agentRun = useRef<{ tabId: string; started: boolean; acceptedAfter?: number } | null>(null);
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const [agentPending, setAgentPending] = useState(false);
  const keycaps = useShortcutKeycaps();
  // A new saved status disables actions immediately. Once refreshed, the live
  // runtime wins: saved in_progress/waiting can survive a lost event or restart.
  const statusObservation = useRef({ key: statusKey, revision: 0 });
  if (statusObservation.current.key !== statusKey) {
    statusObservation.current = { key: statusKey, revision: snapshot?.revision ?? 0 };
  }
  const awaitingStatus = !snapshot || snapshot.revision <= statusObservation.current.revision;
  const agentWorking = agentPending || snapshot?.state === "agentWorking"
    || (awaitingStatus && session.tabs.some((tab) => tab.status === "in_progress" || tab.status === "waiting"));
  const state = agentWorking ? BRANCH_STATES.agentWorking : snapshot ? BRANCH_STATES[snapshot.state] : null;
  const agentAction = (action: BranchAction) => BRANCH_ACTIONS[action].agent || (action === "pull" && snapshot?.pullNeedsAgent);
  const enabled = (action: BranchAction) => !!snapshot?.actions.includes(action) && !readError && !agentWorking && !running && (!agentAction(action) || !!tabId);

  useEffect(() => {
    alive.current = true;
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<AgentEvent>("agent_event", ({ payload: event }) => {
      const tracked = agentRun.current;
      if (disposed || !tracked || event.sessionId !== session.id || event.tabId !== tracked.tabId || event.subagent) return;
      const payload = event.payload;
      if (payload.type === "turn_started") tracked.started = true;
      if (payload.type === "error" && tracked.started) setError(payload.message);
      if (payload.type === "turn_completed" && tracked.started) {
        agentRun.current = null;
        setAgentPending(false);
        if (payload.status !== "ok") setError(payload.detail ?? "The agent did not complete the Git action. See the conversation for details.");
        else setNotice("Agent finished. Review the changes before committing and pushing.");
        refresh();
      }
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { disposed = true; alive.current = false; stop?.(); };
  }, [session.id, refresh]);

  // A reconnect can lose the completion event. A fresh native read must still
  // release the header; never keep saying "working" after the runtime is idle.
  useEffect(() => {
    const after = agentRun.current?.acceptedAfter;
    if (snapshot && after != null && snapshot.revision > after && snapshot.state !== "agentWorking") {
      agentRun.current = null;
      setAgentPending(false);
      setNotice("Agent is idle. See the conversation for its result.");
    }
  }, [snapshot]);

  const run = async (request: BranchRequest) => {
    lock.current = true;
    setPending(null);
    setError(null);
    setNotice(null);
    const isAgent = BRANCH_ACTIONS[request.action].agent || (request.action === "pull" && request.expected.pullNeedsAgent);
    setRunning(isAgent ? "Sending to agent…" : BRANCH_ACTIONS[request.action].progress);
    if (isAgent && request.tabId) {
      agentRun.current = { tabId: request.tabId, started: false };
      setAgentPending(true);
    }
    try {
      const result = await branchStep.run(session.id, request);
      if (agentRun.current) agentRun.current.acceptedAfter = latestSnapshot.current?.revision ?? 0;
      if (!isAgent || agentRun.current) setNotice(result);
    }
    catch (reason) { agentRun.current = null; setAgentPending(false); setError(branchError(reason)); }
    finally { lock.current = false; setRunning(null); refresh(false); }
  };
  const prepare = async (action: BranchAction) => {
    if (lock.current || pending || !snapshot || !enabled(action)) return;
    lock.current = true;
    setError(null);
    setNotice(null);
    const request: BranchRequest = { action, expected: snapshot, tabId };
    try {
      request.authority = await gh.checkAuthority();
      if (!alive.current) return;
      if (BRANCH_ACTIONS[action].publishes) {
        setRunning("Checking GitHub account…");
        const account = await branchStep.account(session.id, action, request.authority);
        if (!alive.current) return;
        request.confirmedAccount = account;
      }
      if (action === "commitPush" || action === "createPr" || (request.confirmedAccount && !request.confirmedAccount.approved)) {
        setMessage(action === "createPr" ? session.title : "");
        setBody("");
        setPending(request);
      } else {
        await run(request);
      }
    } catch (reason) { setError(branchError(reason)); }
    finally { lock.current = false; setRunning(null); }
  };
  const latest = useRef({ prepare, enabled, pending, snapshot });
  latest.current = { prepare, enabled, pending, snapshot };
  // Stable registrations keep shortcut precedence unchanged as status updates.
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

  const tooltip = snapshot
    ? `${state?.detail}. Base: ${snapshot.base}. Merge method: ${snapshot.mergeMethod}.${snapshot.state === "behind" ? (snapshot.pullNeedsAgent ? " The agent preserves uncommitted work while pulling." : snapshot.behindUpstream ? " Pull fast-forwards from the upstream branch." : " Pull merges the latest base into this branch.") : ""}`
    : "Reading branch status";
  const failure = error;
  if ((!snapshot || snapshot.state === "hidden" || snapshot.state === "merged") && !error && !running && !pending) return null;
  const needsMessage = pending?.action === "commitPush" || pending?.action === "createPr";
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="branch-git-button">
      <div className="flex shrink-0 items-center">
        <WithTooltip label={tooltip} shortcut={state?.action ? BRANCH_ACTIONS[state.action].shortcut : undefined}>
          <Button variant="outline" size="sm" className="max-w-44 rounded-r-none border-r-0" aria-label={running ?? (state?.label || "Git actions")} disabled={!state?.action || !enabled(state.action) || !!pending} onClick={() => state?.action && void prepare(state.action)}>
            {running || refreshing || agentWorking ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
            <span className="truncate @max-[520px]/session-header:hidden">{running ?? (state?.label || "Git actions")}</span>
          </Button>
        </WithTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="rounded-l-none px-1.5" aria-label="Git actions"><ChevronDown className="size-3" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.entries(BRANCH_ACTIONS) as [BranchAction, typeof BRANCH_ACTIONS[BranchAction]][]).map(([action, definition]) => (
              <DropdownMenuItem key={action} disabled={!enabled(action) || !!pending} onSelect={() => void prepare(action)}>
                {action === "resolveConflicts" && snapshot?.state === "diverged" ? BRANCH_STATES.diverged.label : definition.label}{definition.shortcut && <span className="ml-auto pl-4 text-xs text-muted-foreground">{keycaps(definition.shortcut).join("")}</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {snapshot?.pr && <DropdownMenuItem onSelect={() => void openUrl(snapshot.pr!.url).catch((reason) => setError(branchError(reason)))}>Open pull request</DropdownMenuItem>}
            <DropdownMenuItem disabled={refreshing} onSelect={() => refresh()}>Refresh Git status</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {failure ? <span role="alert" className="max-w-48 truncate text-xs text-destructive" title={failure}>{failure}</span>
        : notice && <span role="status" className="max-w-48 truncate text-xs text-muted-foreground" title={notice}>{notice}</span>}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending ? BRANCH_ACTIONS[pending.action].label : "Git action"}</DialogTitle>
            <DialogDescription>
              {pending?.action === "commitPush" ? "Commit all staged, unstaged and new files in this checkout, then push to origin. " : null}
              {pending?.action === "merge" ? `Merge into ${pending.expected.base} using ${pending.expected.mergeMethod}. ` : null}
              {pending?.confirmedAccount && <>{pending.action === "merge" ? "GitHub account" : "Push as"}: <strong>{pending.confirmedAccount.login}</strong>. {pending.confirmedAccount.approved ? "Publishing is approved for this session." : "Allow publishing from this session with this account?"}</>}
            </DialogDescription>
          </DialogHeader>
          {pending?.confirmedAccount && <p className="mb-3 break-all text-xs text-muted-foreground">{pending.confirmedAccount.destination}</p>}
          {needsMessage && <label className="block text-sm">{pending?.action === "createPr" ? "PR title" : "Commit message"}<input autoFocus className="mt-1 w-full rounded-md border border-hairline bg-transparent px-3 py-2" value={message} onChange={(event) => setMessage(event.target.value)} /></label>}
          {pending?.action === "createPr" && <label className="mt-3 block text-sm">Description<textarea className="mt-1 min-h-24 w-full rounded-md border border-hairline bg-transparent px-3 py-2" value={body} onChange={(event) => setBody(event.target.value)} /></label>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button disabled={!pending || (needsMessage && !message.trim())} onClick={() => pending && void run({ ...pending, message, body })}>{pending ? BRANCH_ACTIONS[pending.action].label : "Continue"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
