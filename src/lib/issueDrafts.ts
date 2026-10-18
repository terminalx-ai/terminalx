import { useSyncExternalStore } from "react";
import { errorMessage } from "@/lib/api";
import { getDraft, setDraft, subscribeDrafts } from "@/lib/drafts";
import { readAllComments } from "@/lib/issueComments";
import { issueOps, type IssueComment, type IssueDetails, type IssueProvider } from "@/lib/issueOps";
import { issueViewer } from "@/lib/issueViewer";

/**
 * What the reader is writing under an issue, and the comments on their way
 * to it. The text is a draft in `@/lib/drafts` like the chat composer's,
 * named by the issue (`issueDraftKey`), so dictation and a remount treat it
 * the same way. Unlike a tab's draft it is also kept in `localStorage`, with
 * the posts that failed, so neither is lost to an app restart.
 *
 * A post runs here rather than in the composer: switching to another issue
 * while it is on its way neither drops it nor lands its answer on the issue
 * now open. Its outcome stays on its own issue's outbox until a composer for
 * that issue takes it in (`settleIssuePost`).
 */

export interface IssueRef {
  projectPath: string;
  provider: IssueProvider;
  id: string;
}

export type OutgoingStatus = "sending" | "failed" | "sent";

export interface OutgoingComment {
  /** This post's own id, until the provider names the comment. */
  id: string;
  body: string;
  /** "Close with comment" (GitHub): the issue is closed as completed once the comment is in. */
  close: boolean;
  status: OutgoingStatus;
  error?: string | null;
  /** The comment as the provider took it; once set, a retry only closes. */
  posted?: IssueComment | null;
  /** When the comment was last sent (ms), to know it again in the thread if the answer was lost. */
  sentAt?: number;
  /** The issue as closing it answered. */
  closed?: IssueDetails | null;
}

/** The view's hooks a post reports to: the write on the issue's status, and the issue it answers with. */
export interface PostHooks {
  begin?: (issueKey: string) => void;
  end?: (issueKey: string) => void;
  onIssue?: (issue: IssueDetails) => void;
}

const STORAGE_KEY = "terminalx.issueDrafts.v1";
const PREFIX = "issue\n";

export const issueDraftKey = (issue: IssueRef) => `${PREFIX}${issue.projectPath}\n${issue.provider}\n${issue.id}`;

interface Stored {
  text?: string;
  outbox?: OutgoingComment[];
}

const outboxes = new Map<string, OutgoingComment[]>();
const listeners = new Map<string, Set<() => void>>();
const NONE: OutgoingComment[] = [];
let made = 0;
/** The issue drafts that have had text this run, so an emptied one is dropped from storage. */
const draftKeys = new Set<string>();
/** While the last run's drafts are read back, nothing is written over them. */
let loading = false;

function save() {
  if (loading) return;
  const all: Record<string, Stored> = {};
  const keys = new Set([...outboxes.keys()]);
  for (const key of draftKeys) keys.add(key);
  for (const key of keys) {
    const text = getDraft(key);
    // A comment the provider has is in the thread; only what it may not have is kept.
    const outbox = (outboxes.get(key) ?? []).filter((post) => post.status !== "sent");
    if (!text && outbox.length === 0) continue;
    all[key] = { ...(text ? { text } : {}), ...(outbox.length ? { outbox } : {}) };
  }
  try {
    if (Object.keys(all).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage full or unavailable: the drafts still live for this run */
  }
}

function publish(key: string, next: OutgoingComment[]) {
  if (next.length) outboxes.set(key, next);
  else outboxes.delete(key);
  save();
  for (const l of listeners.get(key) ?? []) l();
}

function update(key: string, id: string, patch: Partial<OutgoingComment>) {
  const now = outboxes.get(key);
  if (!now?.some((post) => post.id === id)) return;
  publish(key, now.map((post) => (post.id === id ? { ...post, ...patch } : post)));
}

/** Read what the last run left; a post that was on its way then may or may not have reached the provider. */
export function loadIssueDrafts() {
  let stored: Record<string, Stored> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (value && typeof value === "object") stored = value as Record<string, Stored>;
  } catch {
    stored = {};
  }
  loading = true;
  for (const [key, entry] of Object.entries(stored)) {
    if (!key.startsWith(PREFIX) || !entry || typeof entry !== "object") continue;
    if (typeof entry.text === "string" && entry.text && !getDraft(key)) setDraft(key, entry.text);
    const outbox = Array.isArray(entry.outbox)
      ? entry.outbox
          .filter((post) => post && typeof post.body === "string" && typeof post.id === "string")
          .map((post): OutgoingComment =>
            post.status === "sending"
              ? { ...post, status: "failed", error: "TerminalX closed while this was being posted. Check the thread before you retry: it may already be there." }
              : post,
          )
      : [];
    if (outbox.length) outboxes.set(key, outbox);
  }
  loading = false;
}

subscribeDrafts((key) => {
  if (!key.startsWith(PREFIX)) return;
  draftKeys.add(key);
  save();
});
loadIssueDrafts();

export function useIssueOutbox(key: string): OutgoingComment[] {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    () => outboxes.get(key) ?? NONE,
    () => NONE,
  );
}

/** How far the provider's clock may be behind ours when a post that seemed to fail is looked for. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The comment a post that was answered with a failure (a timeout, a dropped
 * connection) made after all: the reader's, with this text, made since it
 * was sent, and not one another post here already stands for.
 */
async function landed(issue: IssueRef, key: string, post: OutgoingComment): Promise<IssueComment | null> {
  try {
    const [me, thread] = await Promise.all([issueViewer(issue.projectPath, issue.provider), readAllComments(issue.projectPath, issue.provider, issue.id)]);
    const taken = new Set((outboxes.get(key) ?? []).flatMap((each) => (each.posted ? [each.posted.id] : [])));
    const since = (post.sentAt ?? 0) - CLOCK_SKEW_MS;
    return (
      [...thread.comments]
        .reverse()
        .find(
          (comment) =>
            !taken.has(comment.id) &&
            comment.body.trim() === post.body.trim() &&
            comment.author?.id.toLowerCase() === me.id.toLowerCase() &&
            Date.parse(comment.createdAt) >= since,
        ) ?? null
    );
  } catch {
    return null;
  }
}

async function run(issue: IssueRef, key: string, id: string, hooks: PostHooks) {
  update(key, id, { status: "sending", error: null });
  let post = outboxes.get(key)?.find((each) => each.id === id);
  if (!post) return;
  // After a failed write the issue is read again, so what is shown is what the provider has.
  const reread = () =>
    issueOps
      .details(issue.projectPath, issue.provider, issue.id)
      .then((value) => hooks.onIssue?.(value))
      .catch(() => {});
  if (!post.posted) {
    const sentAt = Date.now();
    update(key, id, { sentAt });
    post = { ...post, sentAt };
    try {
      const posted = await issueOps.commentAdd(issue.projectPath, issue.provider, issue.id, post.body);
      update(key, id, { posted });
      post = { ...post, posted };
    } catch (e) {
      const error = errorMessage(e);
      void reread();
      // A post can fail on the way back after the provider took it; a retry would then post it twice.
      const found = await landed(issue, key, post);
      if (!found) return update(key, id, { status: "failed", error });
      update(key, id, { posted: found });
      post = { ...post, posted: found };
    }
  }
  if (post.close) {
    const writeKey = `${issue.provider}:${issue.id}`;
    hooks.begin?.(writeKey);
    try {
      const closed = await issueOps.setState(issue.projectPath, issue.provider, issue.id, { kind: "close", reason: "completed" });
      update(key, id, { closed });
      hooks.onIssue?.(closed);
    } catch (e) {
      update(key, id, { status: "failed", error: `The comment is posted, but the issue couldn’t be closed. ${errorMessage(e)}` });
      await reread();
      return;
    } finally {
      hooks.end?.(writeKey);
    }
  }
  update(key, id, { status: "sent" });
}

/** Posts `body` on the issue (and closes it, with `close`), showing it in the outbox until the provider answers. */
export function postIssueComment(issue: IssueRef, body: string, close: boolean, hooks: PostHooks = {}): Promise<void> {
  const key = issueDraftKey(issue);
  const id = `local-${Date.now()}-${++made}`;
  publish(key, [...(outboxes.get(key) ?? []), { id, body, close, status: "sending" }]);
  return run(issue, key, id, hooks);
}

/** Tries a failed post again: the comment, or only the close when the comment is already in (and found again). */
export function retryIssueComment(issue: IssueRef, id: string, hooks: PostHooks = {}): Promise<void> {
  const key = issueDraftKey(issue);
  if (outboxes.get(key)?.find((post) => post.id === id)?.status !== "failed") return Promise.resolve();
  return run(issue, key, id, hooks);
}

/**
 * Drops a post from the outbox: a failed one given up on, or a sent one now
 * in the thread. A comment the provider has (a close that failed after it)
 * is the caller's to put in the thread.
 */
export function settleIssuePost(issue: IssueRef, id: string) {
  const key = issueDraftKey(issue);
  const now = outboxes.get(key);
  if (now?.some((post) => post.id === id)) publish(key, now.filter((post) => post.id !== id));
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
