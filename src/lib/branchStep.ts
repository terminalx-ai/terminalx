import type { CheckAuthority } from "./api";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/api";
import type { ShortcutId } from "@/lib/shortcuts";

export type BranchState = "hidden" | "noPr" | "agentWorking" | "uncommitted" | "behind" | "ahead" | "diverged" | "conflicts" | "changesRequested" | "draft" | "checksFailing" | "checksPending" | "reviewRequired" | "ready" | "merged";
export type BranchAction = "createPr" | "commitPush" | "push" | "pull" | "resolveConflicts" | "fixChecks" | "addressReview" | "markReady" | "merge";
export interface BranchSnapshot {
  revision: number;
  sessionId: string;
  cwd: string;
  branch: string;
  head: string;
  base: string;
  mergeMethod: "merge" | "squash" | "rebase";
  state: BranchState;
  actions: BranchAction[];
  pr: { number: number; url: string; headSha: string; state: string } | null;
  behindUpstream: boolean;
  pullNeedsAgent?: boolean;
}
export interface PublishAccount { login: string; destination: string; approved: boolean }
export interface BranchRequest {
  authority?: CheckAuthority;
  action: BranchAction;
  expected: BranchSnapshot;
  confirmedAccount?: PublishAccount;
  message?: string;
  body?: string;
  tabId?: string;
}

export const BRANCH_ACTIONS: Record<BranchAction, { label: string; progress: string; shortcut?: ShortcutId; publishes?: boolean; agent?: boolean }> = {
  createPr: { label: "Create PR", progress: "Creating PR…", shortcut: "git.createPr", publishes: true },
  commitPush: { label: "Commit and push", progress: "Committing and pushing…", shortcut: "git.commitPush", publishes: true },
  push: { label: "Push", progress: "Pushing…", publishes: true },
  pull: { label: "Pull latest", progress: "Pulling latest…", shortcut: "git.pull" },
  resolveConflicts: { label: "Resolve conflicts", progress: "Sending to agent…", agent: true },
  fixChecks: { label: "Fix checks", progress: "Sending to agent…", shortcut: "git.fixChecks", agent: true },
  addressReview: { label: "Address review", progress: "Sending to agent…", agent: true },
  markReady: { label: "Mark ready", progress: "Marking ready…" },
  merge: { label: "Merge", progress: "Merging…", shortcut: "git.merge", publishes: true },
};

export const BRANCH_STATES: Record<BranchState, { label: string; action: BranchAction | null; detail: string }> = {
  hidden: { label: "", action: null, detail: "" },
  noPr: { label: "Create PR", action: "createPr", detail: "No pull request" },
  agentWorking: { label: "Agent working", action: null, detail: "Wait for the agent to finish" },
  uncommitted: { label: "Commit and push", action: "commitPush", detail: "Uncommitted changes" },
  behind: { label: "Pull latest", action: "pull", detail: "Branch is behind" },
  ahead: { label: "Push", action: "push", detail: "Unpushed commits" },
  diverged: { label: "Reconcile with upstream", action: "resolveConflicts", detail: "Branch has diverged from its upstream" },
  conflicts: { label: "Resolve conflicts", action: "resolveConflicts", detail: "Conflicts or an unfinished Git operation" },
  changesRequested: { label: "Address review", action: "addressReview", detail: "Changes requested" },
  draft: { label: "Mark ready", action: "markReady", detail: "Draft pull request" },
  checksFailing: { label: "Fix checks", action: "fixChecks", detail: "Checks failing" },
  checksPending: { label: "Checks pending", action: null, detail: "Waiting for checks or GitHub mergeability" },
  reviewRequired: { label: "Review required", action: null, detail: "Review or a branch protection requirement is outstanding" },
  ready: { label: "Merge", action: "merge", detail: "Ready to merge" },
  merged: { label: "Merged", action: null, detail: "Pull request merged" },
};

export const branchStep = {
  refresh: (sessionId: string, mode: "local" | "auto" | "remote" = "remote") => invoke<BranchSnapshot>("branch_step_refresh", { sessionId, mode }),
  account: (sessionId: string, action: BranchAction, authority?: CheckAuthority) => invoke<PublishAccount>("branch_step_account", { sessionId, action, authority }),
  run: (sessionId: string, request: BranchRequest) => invoke<string>("branch_step_action", { sessionId, request, authority: request.authority }),
};

export const branchError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Local polling stays responsive during slow hosted requests. Each lane
 * coalesces its own requests; native revisions discard out-of-order events. */
export function useBranchStep(sessionId: string, statusKey: string) {
  const [snapshot, setSnapshot] = useState<BranchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef<(remote: boolean) => void>(() => {});
  const refresh = useCallback((remote = true) => refreshRef.current(remote), []);
  useEffect(() => {
    let disposed = false;
    const inFlight = { local: false, hosted: false };
    const again: Record<"local" | "hosted", "local" | "auto" | "remote" | null> = { local: null, hosted: null };
    let revision = 0;
    let unlisten: (() => void) | undefined;
    const accept = (value: BranchSnapshot) => {
      if (!disposed && value?.sessionId === sessionId && value.revision >= revision) {
        revision = value.revision;
        setSnapshot(value);
        setError(null);
      }
    };
    const read = async (mode: "local" | "auto" | "remote") => {
      if (disposed) return;
      const lane = mode === "local" ? "local" : "hosted";
      if (inFlight[lane]) {
        if (again[lane] !== "remote") again[lane] = mode;
        return;
      }
      inFlight[lane] = true;
      const beganAtRevision = revision;
      setRefreshing(true);
      try { accept(await branchStep.refresh(sessionId, mode)); }
      catch (reason) { if (!disposed && revision === beganAtRevision) { setError(branchError(reason)); setSnapshot(null); } }
      finally {
        inFlight[lane] = false;
        if (!disposed) {
          setRefreshing(inFlight.local || inFlight.hosted);
          const next = again[lane];
          if (next) { again[lane] = null; void read(next); }
        }
      }
    };
    setSnapshot(null);
    setError(null);
    refreshRef.current = (remote) => void read(remote ? "remote" : "local");
    void listen<BranchSnapshot>("branch_step_changed", ({ payload }) => accept(payload)).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => {});
    // Read local state immediately, before any slow hosted request.
    void read("local");
    const timer = setInterval(() => { if (!document.hidden) void read("local"); }, 15_000);
    let hostedTimer: ReturnType<typeof setTimeout> | undefined;
    const pollHosted = async () => {
      if (!document.hidden) await read("auto");
      // Start the next interval after completion, matching the native cache
      // deadline. A fixed interval could arrive just before that deadline and
      // skip every other hosted refresh when the network takes time.
      if (!disposed) hostedTimer = setTimeout(() => void pollHosted(), 5 * 60_000);
    };
    void pollHosted();
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => {
      if (document.hidden) return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => void read("auto"), 600);
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(hostedTimer);
      clearTimeout(focusTimer);
      unlisten?.();
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [sessionId]);
  const previousStatus = useRef(statusKey);
  useEffect(() => {
    if (previousStatus.current !== statusKey) { previousStatus.current = statusKey; refreshRef.current(false); }
  }, [statusKey, refresh]);
  return { snapshot, error, refreshing, refresh };
}
