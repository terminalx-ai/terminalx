import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/Markdown";
import { useSessionStore } from "@/lib/sessions";
import {
  addThreadsToChat, discoverSessionPr, githubAuthorName, githubReviewLocation, githubThreadLines, registerReviewPr, replyToThread, reviewAccessFor, reviewBody,
  REVIEW_REFRESH_MS, setThreadReplyDraft, setThreadResolved, threadInitials, useReviewPr, useThreadReplyDraft, useWatchThreads,
  type ReviewPr, type ReviewThread, type SessionReviewPr, type ThreadView,
} from "@/lib/reviewThreads";
import type { GitSource } from "@/lib/gitSource";
import { ReviewThreadList } from "./PrChecks";

export { REVIEW_REFRESH_MS };

type Props = { source: GitSource; url: string; number?: number; sessionId?: string; active: boolean; prState?: "OPEN" | "CLOSED" | "MERGED" };

/**
 * The PR's review threads (PRO-234). The PR panel says which PR this workspace
 * has; the threads are drawn inline in the Changes diff and listed here, in
 * the Checks section, with their counts.
 */
export function ReviewThreads({ source, url, number = 0, sessionId, active, prState = "OPEN" }: Props) {
  const view = useRegisteredThreads(source, sessionId, active, { url, number, state: prState });
  if (!view) return null;
  return <ReviewThreadList workspace={source.key} view={view} />;
}

function useRegisteredThreads(source: GitSource | undefined, sessionId: string | undefined, active: boolean, found: SessionReviewPr | null): ThreadView | null {
  const tabId = useSessionStore().sessions.find((session) => session.id === sessionId)?.activeTab ?? null;
  const url = found?.url;
  const access = useMemo(() => source && url ? reviewAccessFor(source, url) : undefined, [source, url]);
  const pr = useMemo<ReviewPr | null>(() => source && found && access ? { url: found.url, number: found.number, state: found.state, access, canWrite: source.canWrite, tabId, errorMessage: source.errorMessage } : null,
    [found?.url, found?.number, found?.state, access, source, tabId]);
  useEffect(() => source && pr ? registerReviewPr(source.key, pr) : undefined, [source?.key, pr]);
  return useWatchThreads(source?.key, active && !!pr, url);
}

/**
 * The session's PR and its review threads for the Changes view and its diff
 * tabs (PRO-234), found the way the PR panel finds them, so they show without
 * that panel ever being opened. Both share one snapshot and one poller; the
 * PR is looked for again on focus and every few minutes while shown.
 */
export function useSessionThreads(source: GitSource | undefined, sessionId: string | undefined, active: boolean): ThreadView | null {
  const [found, setFound] = useState<{ key: string; pr: SessionReviewPr } | null>(null);
  const key = source ? `${source.key}\0${sessionId ?? ""}` : "";
  useEffect(() => {
    if (!source?.reviewThreads || !active) return;
    let alive = true;
    const look = (force: boolean) => {
      if (document.visibilityState === "hidden") return;
      void discoverSessionPr(source, sessionId, force).then((pr) => {
        if (!alive) return;
        setFound((old) => !pr ? null : old?.key === key && old.pr.url === pr.url && old.pr.number === pr.number && old.pr.state === pr.state ? old : { key, pr });
      }, () => { /* No PR is said by the PR panel; here nothing shows. */ });
    };
    look(false);
    const timer = window.setInterval(() => look(true), REVIEW_REFRESH_MS);
    const onFocus = () => look(false);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [source, sessionId, active, key]);
  return useRegisteredThreads(source, sessionId, active, found?.key === key ? found.pr : null);
}

/** A thread drawn in a diff: the shared line-comment widget's GitHub kind reads it from the PR's snapshot. */
export function GitHubThreadComment({ workspace, threadId }: { workspace?: string; threadId: string }) {
  const view = useReviewPr(workspace);
  const draft = useThreadReplyDraft(threadId);
  const thread = view?.snapshot?.threads.find((t) => t.id === threadId);
  if (!workspace || !view || !thread) return null;
  return <ReviewThreadCard thread={thread} prUrl={view.pr.url} tabId={view.pr.tabId} refreshed={view.refreshed} errorMessage={view.pr.errorMessage}
    disabled={!view.pr.canWrite || !!view.working || !!view.error} readOnly={view.pr.state !== "OPEN"}
    draft={draft} onDraftChange={(body) => setThreadReplyDraft(threadId, body)}
    onResolve={() => setThreadResolved(workspace, view.pr.url, thread)}
    onReply={(body) => replyToThread(workspace, view.pr.url, thread, body)} />;
}

export function ReviewThreadCard({ thread, prUrl, tabId, disabled, onResolve, onReply, errorMessage, readOnly = false, draft, onDraftChange, refreshed = 0 }: {
  thread: ReviewThread; prUrl: string; tabId?: string | null; disabled: boolean;
  readOnly?: boolean; draft?: string; onDraftChange?(body: string): void; refreshed?: number;
  onResolve(): Promise<boolean>; onReply(body: string): Promise<boolean>; errorMessage(error: unknown): string;
}) {
  const [ownBody, setOwnBody] = useState("");
  const body = draft ?? ownBody;
  const setBody = onDraftChange ?? setOwnBody;
  const [replyOpen, setReplyOpen] = useState(Boolean(body));
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [error, setError] = useState<{ message: string; reply: boolean } | null>(null);
  useEffect(() => { setError((error) => error?.reply ? error : null); }, [refreshed]);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const submit = async (reply: boolean) => {
    if (readOnly || disabled) return;
    setError(null);
    try {
      if (reply) { if (await onReply(body)) { setBody(""); setReplyOpen(false); } }
      else await onResolve();
    } catch (error) { setError({ reply, message: `${errorMessage(error)}${reply ? " Refresh threads before retrying to check whether the reply was posted." : ""}` }); }
  };
  const [first, ...replies] = thread.comments;
  const name = githubAuthorName(first);
  const comment = (c: ReviewThread["comments"][number]) => <div key={c.id} className="min-w-0">
    {c !== first && <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px]"><span className="font-medium text-foreground">{githubAuthorName(c)}</span><time className="text-faint" dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time></div>}
    {reviewBody(c.body, thread).map((part, index) => part.kind === "markdown"
      ? <Markdown key={index} text={part.text} className="text-xs" remoteImages={false} webLinksOnly />
      : <Suggestion key={index} before={part.before} text={part.text} />)}
  </div>;
  return <article tabIndex={-1} data-review-thread={thread.id} aria-label={`Review thread ${githubReviewLocation(thread)}`}
    className="min-w-0 rounded-md border border-hairline bg-card p-2 text-xs font-sans whitespace-normal select-text [overflow-wrap:anywhere] outline-none focus-visible:ring-1 focus-visible:ring-ring">
    <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-veil-strong text-[9px] font-semibold text-muted-foreground">{threadInitials(name)}</span>
      <span className="min-w-0 font-medium text-foreground">{name}</span>
      <span className="min-w-0 text-[11px] text-faint">on GitHub · {githubThreadLines(thread)}</span>
      {thread.isOutdated && <span className="rounded bg-warning/10 px-1 text-[10px] text-warning">Outdated</span>}
      {thread.isResolved && <span className="rounded bg-add/10 px-1 text-[10px] text-add">Resolved</span>}
      {!readOnly && (thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) && <Button className="ml-auto" size="xs" variant={thread.isResolved ? "ghost" : "secondary"} disabled={disabled} onClick={() => void submit(false)}>{thread.isResolved ? "Unresolve" : "Resolve"}</Button>}
    </div>
    {first && comment(first)}
    {replies.length > 0 && <button type="button" aria-expanded={repliesOpen} onClick={() => setRepliesOpen(!repliesOpen)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">
      {repliesOpen ? "Hide replies" : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
    </button>}
    {repliesOpen && <div className="mt-1 space-y-2 border-l-2 border-hairline pl-2">{replies.map(comment)}</div>}
    {!readOnly && <div className="mt-2 flex flex-wrap items-center gap-1">
      {thread.viewerCanReply && <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setReplyOpen(!replyOpen)}>Reply</Button>}
      {tabId && <Button size="xs" variant="ghost" onClick={() => { addThreadsToChat(tabId, [thread], prUrl); setSentTo(tabId); }}>Send to agent</Button>}
      {tabId && sentTo === tabId && <span role="status" className="text-muted-foreground">Added to chat draft</span>}
    </div>}
    {!readOnly && replyOpen && <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
      <textarea aria-label="Reply to review thread" value={body} onChange={(event) => setBody(event.target.value)} disabled={disabled} placeholder="Reply on GitHub…" className="min-h-20 w-full rounded border border-hairline bg-background p-2" />
      <Button type="submit" size="xs" disabled={disabled || !body.trim()}>Post reply</Button>
    </form>}
    {error && <p role="alert" className="mt-2 text-destructive">{error.message}</p>}
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
