import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cancelLinkSession, startLinkSession, useLinkSessionRequest } from "@/lib/linkSessionStart";

/**
 * "Start a session from a link?" (17.08, PRO-130): the session a
 * `terminalx://new` link asks for, named in full before anything is made.
 * Project, the branch it starts from, the issue and the prompt are each a
 * row; Cancel starts nothing, Create session starts it and opens it. While
 * the issue or the project's default branch is read, Create waits.
 */
export function LinkSessionDialog() {
  const request = useLinkSessionRequest();
  const cancel = useRef<HTMLButtonElement | null>(null);
  // Create waits until what the dialog says has been up a moment, and again after it changes.
  const armedAt = request?.armedAt ?? 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wait = armedAt - Date.now();
    setNow(Date.now());
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [armedAt]);
  if (!request) return null;
  const { id, link, project, isGit, branch, issue, reading, blocked, busy, error } = request;
  const arming = now < armedAt;
  const lines = link.prompt ? link.prompt.split(/\r\n|\r|\n/).length : 0;
  const branchText = !isGit ? "No Git: runs in the project folder" : branch ? `from ${branch}` : reading ? "Reading the default branch…" : "from the default branch";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancelLinkSession(); }}>
      <DialogContent
        data-link-session-dialog=""
        showClose={false}
        width="max-w-[26rem]"
        className="p-0"
        // Opened by another app, it starts on Cancel: a keypress meant for that app never starts a session.
        onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
      >
        <div className="px-4 pt-4">
          <DialogTitle className="text-sm font-semibold">Start a session from a link?</DialogTitle>
          <DialogDescription className="mt-1 text-[12.5px] text-muted-foreground">A link wants to start a session.</DialogDescription>
          <dl aria-label="The session the link asks for" className="mt-2 grid grid-cols-[58px_minmax(0,1fr)] gap-y-1 rounded-md border border-border bg-raised px-2.5 py-2 text-xs">
            <dt className="text-faint">Project</dt>
            <dd className="truncate" title={project.path}>{project.name}</dd>
            <dt className="text-faint">Branch</dt>
            <dd className={isGit && branch ? "truncate font-mono" : "truncate text-muted-foreground"}>{branchText}</dd>
            {link.linear && (
              <>
                <dt className="text-faint">Issue</dt>
                <dd className="truncate" data-link-issue="">
                  {issue ? <><span className="font-mono">{issue.identifier}</span> {issue.title}</> : reading ? <span className="text-muted-foreground">Reading {link.linear}…</span> : <span className="font-mono">{link.linear}</span>}
                </dd>
              </>
            )}
            {link.prompt && (
              <>
                <dt className="text-faint">Prompt{lines > 1 && <span className="block text-[11px]" data-link-prompt-lines="">{lines} lines</span>}</dt>
                <dd className="max-h-32 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]" data-link-prompt="">{link.prompt}</dd>
              </>
            )}
          </dl>
          {isGit && <p className="mt-2 text-xs text-muted-foreground">Merge when green stays off for a session started from a link.</p>}
          {(blocked || error) && <p role="alert" className="mt-2 text-xs leading-[18px] text-destructive [overflow-wrap:anywhere]">{error ?? blocked}</p>}
        </div>
        <div className="mt-1 flex justify-end gap-2 px-4 py-3">
          <Button ref={cancel} variant="outline" size="sm" className="text-muted-foreground" disabled={busy} onClick={cancelLinkSession}>Cancel</Button>
          <Button variant="accent" size="sm" disabled={busy || reading || arming || !!blocked} aria-busy={busy || undefined} onClick={() => void startLinkSession(id)}>
            {busy && <Loader2 aria-hidden className="animate-spin" />}
            Create session
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
