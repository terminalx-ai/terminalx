import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Streamdown } from "streamdown";
import { useSessionStore } from "@/lib/sessions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";

export interface IssueConfirmationRequest {
  id: string;
  expiresAt: number;
  question: {
    title: string;
    sessionId: string | null;
    sessionTitle: string | null;
    project: string;
    target: string;
    summary: string;
    description: string | null;
    agree: string;
  };
}

/** Mounted only in the main window. Arrival never opens a modal or moves focus. */
export function IssueConfirmation() {
  const [request, setRequest] = useState<IssueConfirmationRequest | null>(null);
  const [review, setReview] = useState<{ id: string; navigation: number; context: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const store = useSessionStore();
  const context = JSON.stringify([store.selectedSessionId, store.view, store.selectedProject, store.selectedCloudWorkspace]);
  useEffect(() => setReview(null), [store.navigationVersion, context]);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const next = await invoke<IssueConfirmationRequest | null>("issue_confirmation_pending");
        if (!disposed && current === revision) setRequest(next);
      } catch { /* The native deadline still refuses an unavailable window. */ }
    };
    const unlisten = listen("issue-confirmation-changed", refresh);
    void unlisten.then(() => { if (!disposed) void refresh(); }).catch(() => { /* Native expiry remains authoritative. */ });
    return () => { disposed = true; void unlisten.then((stop) => stop()).catch(() => {}); };
  }, []);
  useEffect(() => {
    setReview(null);
    setError("");
    setSending(false);
    if (!request) return;
    const timer = setTimeout(() => setRequest(null), Math.max(0, request.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [request?.id, request?.expiresAt]);
  if (!request || request.expiresAt <= Date.now()) return null;
  const q = request.question;
  const open = review?.id === request.id && review.navigation === store.navigationVersion && review.context === context;
  const answer = async (approved: boolean) => {
    if (sending || Date.now() >= request.expiresAt) return;
    setSending(true);
    setError("");
    try {
      await invoke<boolean>("issue_confirmation_reply", { id: request.id, approved });
      setRequest((current) => current?.id === request.id ? null : current);
    } catch {
      setError("Could not send the decision. The request still needs confirmation.");
    } finally { setSending(false); }
  };
  return <>
    <aside aria-label="Pending issue request" className="fixed bottom-10 right-4 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border bg-popover p-3 text-sm shadow-lg">
      <div className="min-w-0 max-w-64">
        <p className="truncate font-medium">{q.title}</p>
        <p className="truncate text-muted-foreground">{q.sessionTitle ?? "Unknown session"} · {q.project}</p>
      </div>
      <Button size="sm" onClick={() => setReview({ id: request.id, navigation: store.navigationVersion, context })}>Review</Button>
    </aside>
    <Dialog open={open} onOpenChange={(next) => { if (!next) setReview(null); }}>
      <DialogContent layout="pinned" showClose={false} className="overflow-hidden" onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>{q.title}</DialogTitle>
          <DialogDescription>Review before approving. Unanswered requests expire after 40 seconds.</DialogDescription>
        </DialogHeader>
        <DialogScrollArea aria-label="Issue request details" className="min-h-0 [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap">
          <dl className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt>Session (reported)</dt><dd>{q.sessionTitle ?? "Unknown session"}{q.sessionId && <span className="block text-xs text-muted-foreground">{q.sessionId}</span>}</dd>
            <dt>Project</dt><dd>{q.project}</dd>
            <dt>Target</dt><dd>{q.target}</dd>
            <dt>Action</dt><dd>{q.agree}</dd>
          </dl>
          <p className="mb-3 text-sm">{q.summary}</p>
          {q.description != null && <div className="rounded-lg border p-3">
            <div className="prose-chat select-text">
              <Streamdown mode="static" controls={false} components={{
                // Request content must not load remote images or hide a link's destination.
                img: ({ alt }) => <span>Image: {alt}</span>,
                a: ({ children, href }) => <span>{children} ({href})</span>,
              }}>{q.description}</Streamdown>
            </div>
            <details className="mt-3 text-sm"><summary className="cursor-pointer">Source text</summary><pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{q.description}</pre></details>
          </div>}
          <p className="mt-3 text-sm text-muted-foreground">This changes the issue tracker and may notify other people. Cancel if you did not request it.</p>
        </DialogScrollArea>
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button ref={cancel} variant="outline" disabled={sending} onClick={() => void answer(false)}>Cancel request</Button>
          <Button disabled={sending} onClick={() => void answer(true)}>{q.agree}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
