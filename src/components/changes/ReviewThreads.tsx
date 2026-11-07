import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/Markdown";
import { getDraft, setDraft } from "@/lib/drafts";
import { useSessionStore } from "@/lib/sessions";
import { reviewBody, reviewDraft, reviewLocation, type ReviewThread, type ReviewThreads as ThreadSnapshot } from "@/lib/reviewThreads";
import type { GitSource } from "@/lib/gitSource";

export const REVIEW_REFRESH_MS = 3 * 60_000;

export function ReviewThreads({ source, url, sessionId, active }: { source: GitSource; url: string; sessionId?: string; active: boolean }) {
  if (!source.reviewThreads) return null;
  return <ThreadList key={`${source.key}:${url}:${sessionId ?? ""}`} source={source} url={url} sessionId={sessionId} active={active} />;
}

function ThreadList({ source, url, sessionId, active }: { source: GitSource; url: string; sessionId?: string; active: boolean }) {
  const access = useMemo(() => source.reviewThreads!(url), [source, url]);
  const tabId = useSessionStore().sessions.find((session) => session.id === sessionId)?.activeTab;
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const reading = useRef(false);
  const mutating = useRef(false);
  const mounted = useRef(true);
  const visible = useRef(active && open);
  visible.current = active && open;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current || !visible.current || document.visibilityState === "hidden" || reading.current || mutating.current) return;
    const token = ++request.current;
    reading.current = true;
    setLoading(true);
    try {
      const next = await access.read();
      if (mounted.current && token === request.current) { setSnapshot(next); setError(null); }
    } catch (error) {
      if (mounted.current && token === request.current) setError(source.errorMessage(error));
    } finally {
      if (token === request.current) { reading.current = false; if (mounted.current) setLoading(false); }
    }
  }, [access, active, open, source]);

  useEffect(() => {
    void refresh();
    if (!active || !open) return;
    const refreshVisible = () => { void refresh(); };
    const timer = window.setInterval(refreshVisible, REVIEW_REFRESH_MS);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      request.current++;
      reading.current = false;
      setLoading(false);
    };
  }, [active, open, refresh]);

  const act = async (id: string, action: () => Promise<void>) => {
    if (mutating.current || !source.canWrite) return false;
    mutating.current = true;
    request.current++; // A read started before the write must not overwrite it.
    reading.current = false;
    setLoading(false);
    setWorking(id);
    try {
      await action();
      return true;
    } finally {
      mutating.current = false;
      if (mounted.current) { setWorking(null); void refresh(); }
    }
  };

  return <section aria-label="GitHub review threads" className="mt-2 text-xs">
    <div className="flex items-center gap-2">
      <button type="button" className="text-muted-foreground hover:text-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Review threads{snapshot ? ` · ${snapshot.threads.filter((thread) => !thread.isResolved).length} unresolved` : ""}
      </button>
      {open && <Button size="xs" variant="ghost" disabled={loading || !!working} onClick={() => void refresh()}>Refresh threads</Button>}
    </div>
    {/* Keep reply drafts when the disclosure closes. Poll only while it is visible. */}
    <div hidden={!open} className="mt-2 space-y-2">
      {loading && <p role="status">Refreshing review threads…</p>}
      {error && <p role="alert" className="text-destructive">Could not refresh review threads: {error}</p>}
      {!error && snapshot?.threads.length === 0 && <p className="text-muted-foreground">No review threads.</p>}
      {snapshot?.threads.map((thread) => <ReviewThreadCard key={thread.id} thread={thread} prUrl={url} tabId={tabId}
        disabled={!source.canWrite || !!working || !!error} errorMessage={source.errorMessage}
        onResolve={() => act(thread.id, () => access.resolve(thread.id, !thread.isResolved))}
        onReply={(body) => act(thread.id, () => access.reply(thread.id, body))} />)}
    </div>
  </section>;
}

export function ReviewThreadCard({ thread, prUrl, tabId, disabled, onResolve, onReply, errorMessage }: {
  thread: ReviewThread; prUrl: string; tabId?: string | null; disabled: boolean;
  onResolve(): Promise<boolean>; onReply(body: string): Promise<boolean>; errorMessage(error: unknown): string;
}) {
  const [body, setBody] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const submit = async (reply: boolean) => {
    setError(null);
    try {
      if (reply) { if (await onReply(body)) { setBody(""); setReplyOpen(false); } }
      else await onResolve();
    } catch (error) { setError(`${errorMessage(error)}${reply ? " Refresh threads before retrying to check whether the reply was posted." : ""}`); }
  };
  return <article aria-label={`Review thread ${reviewLocation(thread)}`} className="rounded-md border border-hairline bg-well/40 p-2 select-text">
    <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
      <span className="break-all font-mono">{reviewLocation(thread)}</span>
      {thread.isOutdated && <span>Outdated</span>}
      {thread.isResolved && <span>Resolved</span>}
    </div>
    {thread.comments.map((comment) => <div key={comment.id} className="mb-2 border-b border-hairline pb-2">
      <div className="mb-1 font-medium">{comment.author?.login ?? "Deleted user"} <time className="font-normal text-faint" dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></div>
      {reviewBody(comment.body, thread).map((part, index) => part.kind === "markdown"
        ? <Markdown key={index} text={part.text} className="text-xs" />
        : <Suggestion key={index} before={part.before} text={part.text} />)}
    </div>)}
    <div className="flex flex-wrap gap-2">
      {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) && <Button size="xs" variant="secondary" disabled={disabled} onClick={() => void submit(false)}>{thread.isResolved ? "Unresolve" : "Resolve"}</Button>}
      {thread.viewerCanReply && <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setReplyOpen(!replyOpen)}>Reply</Button>}
      {tabId && <Button size="xs" variant="ghost" onClick={() => {
        const draft = getDraft(tabId);
        setDraft(tabId, `${draft}${draft ? "\n\n" : ""}${reviewDraft(thread, prUrl)}`);
        setSentTo(tabId);
      }}>Send to agent</Button>}
      {tabId && sentTo === tabId && <span role="status" className="text-muted-foreground">Added to chat draft</span>}
    </div>
    {replyOpen && <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
      <textarea aria-label="Reply to review thread" value={body} onChange={(event) => setBody(event.target.value)} disabled={disabled} className="min-h-20 w-full rounded border border-hairline bg-background p-2" />
      <Button type="submit" size="xs" disabled={disabled || !body.trim()}>Post reply</Button>
    </form>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </article>;
}

function Suggestion({ before, text }: { before: string | null; text: string }) {
  const [notice, setNotice] = useState<string | null>(null);
  return <div className="my-2 overflow-hidden rounded border border-hairline">
    <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground">
      <span>Suggestion</span>
      <Button size="xs" variant="ghost" onClick={() => {
        void (async () => {
          try { await navigator.clipboard.writeText(text); setNotice("Copied"); }
          catch { setNotice("Could not copy suggestion"); }
        })();
      }}>Copy suggestion</Button>
      {notice && <span role="status">{notice}</span>}
    </div>
    <pre aria-label="Suggestion diff" className="overflow-x-auto p-2 font-mono text-[11px]">
      {before != null && before.split("\n").map((line, index) => <div key={`old-${index}`} className="bg-destructive/10 text-destructive">-{line}</div>)}
      {text !== "" && text.split("\n").map((line, index) => <div key={`new-${index}`} className="bg-add/10 text-add">+{line}</div>)}
    </pre>
    {before == null && <p className="px-2 pb-1 text-faint">Original lines unavailable.</p>}
  </div>;
}
