import { useEffect, useRef, useState } from "react";
import { FolderSync } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage, type RepoMirrorStatus } from "@/lib/api";
import type { SessionEntry } from "@/types/session";

/** Local-session header control. Kept available from the root session too,
 * so a removed workspace or an app restart cannot strand the cleanup action. */
export function RepoMirrorControl({ session }: { session: SessionEntry }) {
  const [status, setStatus] = useState<RepoMirrorStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const request = useRef(0);
  const changing = useRef(false);
  const eligible = session.kind !== "quick" && !!session.worktreeName && !session.worktreeRemoved;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!changing.current) {
        const version = ++request.current;
        try {
          const value = await api.repoMirrorStatus(session.id);
          if (!disposed && version === request.current) {
            setStatus(value);
            setReadError(null);
          }
        } catch (failure) {
          if (!disposed && version === request.current) setReadError(errorMessage(failure));
        }
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); ++request.current; };
  }, [session.id]);

  const on = !!status?.source;
  if (!eligible && !on) return null;
  const label = on ? (status?.active ? "Mirroring to repo root" : "Repo root mirror paused") : "Mirror into repo root";
  const change = async () => {
    if (changing.current || !status) return;
    changing.current = true;
    setBusy(true);
    setError(null);
    ++request.current;
    try {
      const value = on ? await api.repoMirrorStop(session.id) : await api.repoMirrorStart(session.id, true);
      setStatus(value);
      if (!value.error) setOpen(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };

  return <>
    <Button variant="ghost" size="sm" className="shrink-0 text-xs" onClick={() => setOpen(true)} title={label}>
      <FolderSync className="size-3.5" /> {label}
    </Button>
    <Dialog open={open} onOpenChange={(value) => !busy && setOpen(value)}>
      <DialogContent width="max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>{on ? "Stop mirroring" : "Mirror into repo root"}</DialogTitle>
          <DialogDescription>
            {on
              ? "Stop copying changes and restore the repository root to its original clean checkout. If files were edited in the root, cleanup pauses so you can save those edits first."
              : "Copy this workspace’s committed changes, edits and new files into the repository root, then keep them in sync every few seconds. The root must be clean. Ignored files are left alone."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 break-all text-xs text-muted-foreground">
          <p>From: <span className="text-foreground">{status?.source ?? session.cwd}</span></p>
          <p>Into: <span className="text-foreground">{status?.root ?? session.projectPath}</span></p>
          {!on && <p className="break-normal">Edit in the workspace while mirroring. Changes go one way. Stop mirroring restores the root; closing this dialog keeps mirroring on. If TerminalX quits, reopen it and stop mirroring to restore the root.</p>}
        </div>
        {(error || readError || status?.error) && <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error || readError || status?.error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={busy || !status || (!on && !eligible)} onClick={() => void change()}>{busy ? "Working…" : on ? "Stop mirroring" : "Mirror into repo root"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
