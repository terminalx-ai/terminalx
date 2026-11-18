import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { closeWorkspaceRestore, useDialogs } from "@/lib/dialogs";
import { homeShort, useHome } from "@/lib/homePath";
import { restoreWorkspace } from "@/lib/sessions";
import type { WorkspaceRestorePreview } from "@/types/session";

export function WorkspaceRestoreDialog() {
  const { workspaceRestore } = useDialogs();
  return workspaceRestore ? <Restore key={workspaceRestore} sessionId={workspaceRestore} /> : null;
}

/**
 * Put a removed workspace back (02.16): its commit and path, and, when its branch cannot be had back as it was, a
 * choice between a new branch from the recorded commit and that commit checked out detached.
 */
function Restore({ sessionId }: { sessionId: string }) {
  const home = useHome();
  const [preview, setPreview] = useState<WorkspaceRestorePreview | null>(null);
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<"branch" | "detached">("branch");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setChecking(true);
    setError(null);
    setPreview(null);
    api.previewWorkspaceRestore(sessionId).then((value) => {
      if (!live) return;
      setPreview(value);
      setBranch(value.suggestedBranch);
    }).catch((error) => live && setError(errorMessage(error))).finally(() => live && setChecking(false));
    return () => { live = false; };
  }, [sessionId, attempt]);

  const detached = !!preview?.needsBranch && mode === "detached";
  const ready = !!preview && !busy && !checking && (!preview.needsBranch || detached || !!branch.trim());
  const restore = async () => {
    if (!preview || !ready) return;
    setBusy(true);
    setError(null);
    try {
      if (detached) await restoreWorkspace(sessionId, preview, null, true);
      else await restoreWorkspace(sessionId, preview, preview.needsBranch ? branch.trim() : null);
      closeWorkspaceRestore();
    } catch (error) {
      setPreview(null);
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const short = preview?.commit.slice(0, 7) ?? "";
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && closeWorkspaceRestore()}>
      <DialogContent width="max-w-[520px]" showClose={!busy} className="gap-0 p-0">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void restore();
          }}
        >
          <div className="px-5 pt-5">
            <DialogTitle className="text-base font-semibold">{preview?.needsBranch ? "Restore on a new branch?" : "Restore session?"}</DialogTitle>
            <DialogDescription className="mt-1.5 text-[13px] text-muted-foreground">
              {preview?.needsBranch
                ? `${preview.needsBranch} TerminalX can put the worktree back at the commit it was archived at.`
                : preview
                  ? <>TerminalX puts the worktree back on <span className="font-mono text-[12.5px]">{preview.branch}</span> and reopens {preview.sessionIds.length === 1 ? "its conversation" : `its ${preview.sessionIds.length} conversations`} there.</>
                  : "TerminalX puts the worktree back at the commit it was archived at."}
            </DialogDescription>
          </div>
          {checking && <p className="mx-5 mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking the saved workspace…</p>}
          {preview && (
            <dl className="mx-5 mt-4 grid grid-cols-[70px_minmax(0,1fr)] gap-y-1.5 rounded-lg bg-raised px-3 py-2.5 text-[12.5px] hairline">
              <dt className="text-faint">Commit</dt>
              <dd className="truncate font-mono" title={preview.commit}>{short}</dd>
              <dt className="text-faint">Path</dt>
              <dd className="truncate font-mono text-xs" title={preview.path}>{homeShort(preview.path, home)}</dd>
              {!preview.needsBranch && preview.branch && <><dt className="text-faint">Branch</dt><dd className="truncate font-mono text-xs">{preview.branch}</dd></>}
            </dl>
          )}
          {preview?.legacy && <p className="mx-5 mt-3 text-xs text-warning">No removal commit was saved by this older version. This restores the branch at its current commit.</p>}
          {preview?.needsBranch && (
            <div role="radiogroup" aria-label="Restore as" className="mx-5 mt-4 grid gap-2">
              <Choice selected={mode === "branch"} onSelect={() => setMode("branch")} label="New branch" disabled={busy}>
                {mode === "branch" && (
                  <input
                    aria-label="New branch name"
                    className="mt-1.5 h-8 w-full rounded-md border border-border bg-popover px-2.5 font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                  />
                )}
              </Choice>
              <Choice selected={mode === "detached"} onSelect={() => setMode("detached")} label={`Detached at ${short}`} disabled={busy}>
                <div className="text-xs text-faint">Read-only. Good for checking something without a branch.</div>
              </Choice>
            </div>
          )}
          {preview && <p className="mx-5 mt-3 text-[11.5px] text-faint">Only committed files come back. Uncommitted changes and deleted conversations can't be recovered.</p>}
          {error && <p role="alert" className="mx-5 mt-3 whitespace-pre-line text-sm text-destructive">{error}</p>}
          <div className="mt-2 flex items-center gap-2 px-5 py-4">
            <span className="text-xs text-faint">Chats and terminals come back as they were.</span>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={closeWorkspaceRestore}>Cancel</Button>
              {error && !preview && <Button type="button" variant="outline" size="sm" disabled={busy || checking} onClick={() => setAttempt((value) => value + 1)}>Check again</Button>}
              <Button type="submit" variant="accent" size="sm" disabled={!ready} className="font-semibold">
                {busy && <Loader2 className="animate-spin" />} Restore session
                <kbd aria-hidden className="rounded-[4px] border border-current/30 px-1 font-sans text-[10.5px] opacity-80">↵</kbd>
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Choice({ selected, onSelect, label, disabled, children }: { selected: boolean; onSelect: () => void; label: string; disabled: boolean; children?: ReactNode }) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={0}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(event) => {
        if (disabled || event.key !== " ") return;
        if ((event.target as HTMLElement).tagName === "INPUT") return;
        event.preventDefault();
        onSelect();
      }}
      className={cn(
        "flex cursor-default items-start gap-2.5 rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        selected ? "border-accent/50 bg-accent/5" : "border-border",
      )}
    >
      <span aria-hidden className={cn("mt-0.5 size-4 shrink-0 rounded-full", selected ? "border-[5px] border-accent" : "border border-border")} />
      <div className="min-w-0 flex-1">
        <div className={cn("text-[13px]", selected && "font-medium")}>{label}</div>
        {children}
      </div>
    </div>
  );
}
