import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/Markdown";
import { getDraft, setDraft } from "@/lib/drafts";
import { useSessionStore } from "@/lib/sessions";
import { reviewBody, githubReviewDraft, githubReviewLocation, type ReviewFile, type ReviewThread, type ReviewThreads as ThreadSnapshot } from "@/lib/reviewThreads";
import type { GitSource } from "@/lib/gitSource";
import { GitHubReviewPatchPane } from "./GitHubReviewPatchPane";

export const REVIEW_REFRESH_MS = 3 * 60_000;

type Props = { source: GitSource; url: string; sessionId?: string; active: boolean; prState?: "OPEN" | "CLOSED" | "MERGED" };

export function ReviewThreads({ source, url, sessionId, active, prState = "OPEN" }: Props) {
  if (!source.reviewThreads) return null;
  return <ThreadList key={`${source.key}:${url}:${sessionId ?? ""}`} source={source} url={url} sessionId={sessionId} active={active} prState={prState} />;
}

function ThreadList({ source, url, sessionId, active, prState }: Props) {
  const access = useMemo(() => source.reviewThreads!(url), [source, url]);
  const tabId = useSessionStore().sessions.find((session) => session.id === sessionId)?.activeTab;
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"split" | "unified">("unified");
  const [fileResult, setFileResult] = useState<{ key: string; file?: ReviewFile; error?: string } | null>(null);
  const [fileTick, setFileTick] = useState(0);
  const [fileVisible, setFileVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const changed = () => setFileVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [refreshed, setRefreshed] = useState(0);
  const retry = useRef({ failures: 0, at: 0 });
  const loaded = useRef(false);
  const request = useRef(0);
  const reading = useRef(false);
  const mutating = useRef(false);
  const mounted = useRef(true);
  const visible = useRef(active && open);
  visible.current = active && open;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);

  const refresh = useCallback(async (force = false) => {
    if (!mounted.current || !visible.current || document.visibilityState === "hidden" || reading.current || mutating.current) return;
    if (!force && (Date.now() < retry.current.at || (prState !== "OPEN" && loaded.current))) return;
    const token = ++request.current;
    reading.current = true;
    setLoading(true);
    try {
      const next = await access.read();
      if (mounted.current && token === request.current) {
        setSnapshot(next); setError(null); setRefreshed((value) => value + 1);
        retry.current = { failures: 0, at: 0 }; loaded.current = true;
      }
    } catch (error) {
      if (mounted.current && token === request.current) {
        setError(source.errorMessage(error));
        const failures = retry.current.failures + 1;
        retry.current = { failures, at: Date.now() + Math.min(30 * 60_000, REVIEW_REFRESH_MS * 2 ** Math.min(failures - 1, 4)) };
      }
    } finally {
      if (token === request.current) { reading.current = false; if (mounted.current) setLoading(false); }
    }
  }, [access, active, open, source, prState]);

  useEffect(() => {
    void refresh();
    if (!active || !open) return;
    const refreshVisible = () => { void refresh(); };
    const timer = prState === "OPEN" ? window.setInterval(refreshVisible, REVIEW_REFRESH_MS) : undefined;
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
    if (mutating.current || !source.canWrite || prState !== "OPEN") return false;
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
      if (mounted.current) { setWorking(null); void refresh(true); }
    }
  };

  const paths = [...new Set(snapshot?.threads.map((thread) => thread.path) ?? [])];
  const path = selected && paths.includes(selected) ? selected : paths[0];
  const fileKey = snapshot && path ? `${snapshot.headOid}:${snapshot.baseOid}:${path}` : null;
  const shownFile = fileResult?.key === fileKey ? fileResult : null;
  useEffect(() => {
    if (!active || !open || !snapshot || !path || !fileKey || !fileVisible || fileResult?.key === fileKey) return;
    let cancelled = false;
    setFileResult(null);
    void access.file(path, snapshot).then(
      (file) => { if (!cancelled) setFileResult({ key: fileKey, file }); },
      (error) => { if (!cancelled) setFileResult({ key: fileKey, error: source.errorMessage(error) }); },
    );
    return () => { cancelled = true; };
    // A thread refresh on the same revisions must not reload all the file pages.
  }, [access, active, open, fileKey, fileTick, fileVisible, source]);
  const renderThread = (thread: ReviewThread) => <ReviewThreadCard key={thread.id} thread={thread} prUrl={url} tabId={tabId}
    disabled={!source.canWrite || !!working || !!error} readOnly={prState !== "OPEN"} refreshed={refreshed} errorMessage={source.errorMessage}
    draft={drafts[thread.id] ?? ""} onDraftChange={(body) => setDrafts((drafts) => ({ ...drafts, [thread.id]: body }))}
    onResolve={() => act(thread.id, () => access.resolve(thread.id, !thread.isResolved))}
    onReply={(body) => act(thread.id, () => access.reply(thread.id, body))} />;

  return <section aria-label="GitHub review threads" className="mt-2 text-xs">
    <div className="flex items-center gap-2">
      <button type="button" className="text-muted-foreground hover:text-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Review threads
      </button>
      {open && <Button size="xs" variant="ghost" disabled={loading || !!working} onClick={() => void refresh(true)}>Refresh threads</Button>}
    </div>
    {/* Keep reply drafts when the disclosure closes. Poll only while it is visible. */}
    <div hidden={!open} className="mt-2 space-y-2">
      {loading && <p role="status">Refreshing review threads…</p>}
      {error && <p role="alert" className="text-destructive">Could not refresh review threads: {error}</p>}
      {!error && snapshot?.threads.length === 0 && <p className="text-muted-foreground">No review threads.</p>}
      {snapshot && path && <>
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-0 flex-1">Review file <select aria-label="Review file" value={path} onChange={(event) => setSelected(event.target.value)} className="w-full rounded bg-well p-1">
            {paths.map((path) => <option key={path} value={path}>{path}</option>)}
          </select></label>
          <label>Diff layout <select aria-label="Review diff layout" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} className="rounded bg-well p-1">
            <option value="unified">Unified</option><option value="split">Split</option>
          </select></label>
        </div>
        <p className="text-faint">PR head {snapshot.headOid.slice(0, 7)}</p>
        {!shownFile && <p role="status">Loading PR file diff…</p>}
        {shownFile?.error && <div role="alert">Could not load PR file diff: {shownFile.error} <Button variant="ghost" size="xs" onClick={() => { setFileResult(null); setFileTick((tick) => tick + 1); }}>Retry file diff</Button></div>}
        {shownFile?.file
          ? <GitHubReviewPatchPane mode={mode} review={{ file: shownFile.file, snapshot, renderThread }} />
          : shownFile?.error ? snapshot.threads.filter((thread) => thread.path === path).map(renderThread) : null}
      </>}
    </div>
  </section>;
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
  return <article aria-label={`Review thread ${githubReviewLocation(thread)}`} className="rounded-md border border-hairline bg-well/40 p-2 select-text">
    <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
      <span className="break-all font-mono">{githubReviewLocation(thread)}</span>
      {thread.isOutdated && <span>Outdated</span>}
      {thread.isResolved && <span>Resolved</span>}
    </div>
    {thread.comments.map((comment) => <div key={comment.id} className="mb-2 border-b border-hairline pb-2">
      <div className="mb-1 font-medium">{comment.author?.login ?? "Deleted user"} <time className="font-normal text-faint" dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></div>
      {reviewBody(comment.body, thread).map((part, index) => part.kind === "markdown"
        ? <Markdown key={index} text={part.text} className="text-xs" remoteImages={false} webLinksOnly />
        : <Suggestion key={index} before={part.before} text={part.text} />)}
    </div>)}
    {!readOnly && <div className="flex flex-wrap gap-2">
      {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) && <Button size="xs" variant="secondary" disabled={disabled} onClick={() => void submit(false)}>{thread.isResolved ? "Unresolve" : "Resolve"}</Button>}
      {thread.viewerCanReply && <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setReplyOpen(!replyOpen)}>Reply</Button>}
      {tabId && <Button size="xs" variant="ghost" onClick={() => {
        const draft = getDraft(tabId);
        setDraft(tabId, `${draft}${draft ? "\n\n" : ""}${githubReviewDraft(thread, prUrl)}`);
        setSentTo(tabId);
      }}>Send to agent</Button>}
      {tabId && sentTo === tabId && <span role="status" className="text-muted-foreground">Added to chat draft</span>}
    </div>}
    {!readOnly && replyOpen && <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
      <textarea aria-label="Reply to review thread" value={body} onChange={(event) => setBody(event.target.value)} disabled={disabled} className="min-h-20 w-full rounded border border-hairline bg-background p-2" />
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
