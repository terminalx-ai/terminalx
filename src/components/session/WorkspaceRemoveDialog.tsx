import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, FolderInput, GitMerge, GitPullRequest, Loader2, Trash2 } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/controls";
import { CONVERSATION_DELETION } from "@/lib/conversationRetention";
import { errorMessage } from "@/lib/api";
import { closeWorkspaceRemove, openWorktreeCleanup, useDialogs } from "@/lib/dialogs";
import { relocateSession } from "@/lib/sessions";
import { localWorkspaceHost, type WorkspaceHost } from "@/lib/workspaceRemoval";
import { confirmRiskyRemoval, reportBranchOutcome } from "@/lib/worktreeConfirm";
import type { Landed, WorkspaceDisposition } from "@/types/session";

const MERGED_HOW: Record<NonNullable<Landed["merged"]>, string> = {
  ancestor: "is in",
  rebase: "was rebased into",
  squash: "was squash-merged into",
  noChanges: "changes nothing relative to",
};

/**
 * The one dialog for removing a workspace, whichever way it was started: the
 * workspace menu, the right panel, settling, or deleting a workspace's last
 * session. Removing the checkout keeps conversations by default through the
 * existing settle transition. Permanent conversation deletion is a separate
 * explicit choice, regardless of whether the checkout is clean and merged.
 *
 * One check decides how much confirmation is needed: the workspace is safe
 * when it is clean and its work is merged into the default branch. Then the
 * button here is the only confirmation. Otherwise what would be lost is
 * listed and a second, explicit confirmation is asked.
 */
export function WorkspaceRemoveDialog() {
  const { workspaceRemove: request } = useDialogs();
  const [disp, setDisp] = useState<WorkspaceDisposition | null>(null);
  // The check itself failed: the workspace is then as unknown as one that
  // could not be verified.
  const [checkFailed, setCheckFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"remove" | "relocate" | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [deleteConversations, setDeleteConversations] = useState(false);

  const check = useCallback(async (host: WorkspaceHost, isLive: () => boolean = () => true) => {
    setDisp(null);
    setCheckFailed(false);
    try {
      // The one caller that fetches: the answer decides whether this
      // workspace can go with a single confirmation.
      const d = await host.disposition({ fetch: true });
      if (!isLive()) return;
      setDisp(d);
      // The branch goes by default only with a workspace found clean and
      // merged. Otherwise it is the person's to turn on (and even then a
      // branch holding commits nothing else has is kept).
      setDeleteBranch(!!d.landed?.safe);
    } catch (e) {
      if (!isLive()) return;
      setCheckFailed(true);
      setError(errorMessage(e));
    }
  }, []);

  // The host that owns the workspace: this computer, unless the request names a cloud runtime.
  const host = useMemo(() => (request ? (request.host ?? localWorkspaceHost(request.projectPath, request.path)) : null), [request]);

  useEffect(() => {
    if (!host) return;
    setError(null);
    setDeleteConversations(false);
    setDeleteBranch(false);
    let live = true;
    void check(host, () => live);
    return () => {
      live = false;
    };
  }, [host, check]);

  if (!request || !host) return null;
  const settle = !deleteConversations;
  const keepUnavailable = host.keepConversationsUnavailable;
  const landed = disp?.landed ?? null;
  // A folder that is not on disk (removed by hand, or on a volume that is not
  // mounted) cannot be checked, so it is never "safe".
  const gone = !!disp && !disp.exists;
  const safe = !!landed?.safe;
  const known = !!disp || checkFailed;
  const risky = known && !safe;
  // The second confirmation is given for what was shown; without a check
  // there is nothing to confirm against, so there is nothing to remove.
  const confirmable = !!landed;
  const losses = landed?.losses ?? [];
  const pr = disp?.pr ?? null;
  const verb = settle ? "Remove" : "Delete";

  const remove = async () => {
    if (settle && keepUnavailable) return;
    if (risky && !(await confirmRiskyRemoval(request.path, losses))) return;
    setBusy("remove");
    setError(null);
    try {
      const report = await host.remove({
        keepSessions: settle,
        deleteBranch,
        confirmedDigest: risky ? (landed?.digest ?? null) : null,
        expectedSessions: disp?.sessionIds ?? [],
      });
      closeWorkspaceRemove();
      await reportBranchOutcome(report);
    } catch (e) {
      // It may have changed since it was checked, or been partly removed:
      // read it again before the next attempt is offered.
      await check(host);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const relocate = async () => {
    if (!request.sessionId) return;
    setBusy("relocate");
    setError(null);
    try {
      await relocateSession(request.sessionId);
      closeWorkspaceRemove();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && closeWorkspaceRemove()}>
      <DialogContent width="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle className="pr-6">{settle ? "Remove workspace, keep conversations" : "Permanently delete conversations and workspace"}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{request.name}</span>
            {disp?.branch && (
              <>
                {" "}
                on <span className="font-mono text-foreground">{disp.branch}</span>
              </>
            )}
            .{" "}
            The directory is deleted; it is not moved to the Trash. Choose separately what happens to its conversations.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="mt-3 space-y-2 text-xs" disabled={!!busy}>
          <legend className="mb-2 font-medium">Conversations</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="conversation-retention" checked={settle} onChange={() => setDeleteConversations(false)} />
            Remove workspace, keep conversations
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="conversation-retention" checked={!settle} onChange={() => setDeleteConversations(true)} />
            Permanently delete conversations too
          </label>
          <p className="wrap-anywhere text-muted-foreground">
            {settle
              ? keepUnavailable ?? `Conversations and their original workspace context stay readable. Agents stop and resume in the project folder (${request.projectPath}) when opened again. Keep the workspace instead if you do not want agents to run there. Claude Code and Codex need their provider-native files to resume; missing files cannot be reconstructed from accounting.`
              : CONVERSATION_DELETION}
          </p>
        </fieldset>

        <div className="mt-3 flex flex-col gap-1.5 rounded-lg bg-well px-3 py-2 text-xs">
          {!known && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Fetching the default branch and checking the workspace…
            </span>
          )}
          {checkFailed && <Row ok={false} text="The workspace could not be checked, so it cannot be removed from here. Close this and try again." />}
          {gone && <Row ok={false} text="The workspace folder is not on disk. It may have been removed by hand, or be on a volume that is not mounted." />}
          {disp && (
            <>
              <SessionsRow count={disp.sessions} titles={disp.sessionTitles ?? []} kept={settle} />
              {landed?.checked && (
                <>
                  <Row ok={landed.clean} text={landed.clean ? "Clean: nothing uncommitted, untracked or stashed." : "Not clean."} />
                  <Row
                    ok={!!landed.merged && !landed.notVerified}
                    text={
                      landed.merged
                        ? `Merged: the branch ${MERGED_HOW[landed.merged]} ${landed.base ?? "the default branch"}${landed.notVerified ? ", as far as could be checked" : ""}.`
                        : `Not merged into ${landed.base ?? "the default branch"}.`
                    }
                  />
                </>
              )}
              {losses.length > 0 && (
                <ul aria-label="What would be lost" className="ml-5 list-disc text-warning">
                  {losses.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {pr ? (
                <div className="flex items-start gap-2">
                  {pr.state === "MERGED" ? <GitMerge className="mt-0.5 size-3.5 shrink-0 text-merged" /> : <GitPullRequest className={`mt-0.5 size-3.5 shrink-0 ${pr.state === "OPEN" ? "text-warning" : "text-faint"}`} />}
                  <span className="min-w-0">
                    Pull request{" "}
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => void openUrl(pr.url)}>
                      #{pr.number}
                    </button>{" "}
                    is {pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? (pr.isDraft ? "still an open draft" : "still open") : "closed without merging"}.
                  </span>
                </div>
              ) : null}
              <div className={`mt-1 ${safe ? "text-add" : "text-warning"}`}>
                {safe ? "Clean and merged: safe to remove." : "Removing it now needs a second confirmation."}
              </div>
            </>
          )}
          {error && <div className="whitespace-pre-line text-destructive">{error}</div>}
        </div>

        {disp?.exists && !disp.isMain && disp.branch && (
          <label className="mt-3 flex items-center justify-between text-xs">
            <span>
              Also delete the branch <span className="font-mono">{disp.branch}</span>
            </span>
            <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} />
          </label>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={closeWorkspaceRemove} disabled={!!busy}>
            {settle ? "Keep as is" : "Cancel"}
          </Button>
          {settle && keepUnavailable && (
            <Button variant="outline" disabled={!!busy} onClick={() => { closeWorkspaceRemove(); openWorktreeCleanup(); }}>
              Clean up worktrees…
            </Button>
          )}
          {settle && request.sessionId && (
            <Button variant="outline" onClick={() => void relocate()} disabled={!!busy}>
              {busy === "relocate" ? <Loader2 className="animate-spin" /> : <FolderInput />} Move session to project
            </Button>
          )}
          <Button variant={risky || !settle ? "destructive" : "default"} onClick={() => void remove()} disabled={!!busy || !known || !confirmable || !!disp?.isMain || (settle && !!keepUnavailable)}>
            {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} {risky ? `${verb} anyway…` : settle ? "Remove workspace" : "Delete conversations and workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The sessions in the workspace, by name, and what happens to them. Not a warning: it is what was asked for. */
function SessionsRow({ count, titles, kept }: { count: number; titles: string[]; kept: boolean }) {
  const many = count !== 1;
  const text =
    count === 0
      ? "No sessions run here."
      : kept
        ? `${count} session${many ? "s are" : " is"} kept and move${many ? "" : "s"} to the project${titles.length ? ":" : "."}`
        : `${count} session${many ? "s" : ""} and ${many ? "their" : "its"} transcripts will be deleted${titles.length ? ":" : "."}`;
  return (
    <div className="flex items-start gap-2">
      <Trash2 className={`mt-0.5 size-3.5 shrink-0 ${count === 0 || kept ? "text-faint" : "text-muted-foreground"}`} />
      <div className="min-w-0">
        <div>{text}</div>
        {titles.length > 0 && (
          <ul aria-label="Sessions in this workspace" className="mt-0.5 max-h-24 overflow-y-auto scrollbar-thin text-muted-foreground">
            {titles.map((title, i) => (
              <li key={`${i}-${title}`} className="truncate">
                {title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="flex items-start gap-2">
      {ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-add" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />}
      <span>{text}</span>
    </div>
  );
}
