import { useEffect, useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { showError } from "@/lib/errorToasts";
import { getDraft, setDraft } from "@/lib/drafts";
import type { ReviewComment } from "@/lib/reviewComments";
import type { GitSource } from "@/lib/gitSource";
import { sessionPrs } from "@/lib/sessionPrs";

/** Coordinates from GitHub are already rebased to the PR head, not the original push. */
export type GitHubReviewSide = "LEFT" | "RIGHT";
export interface GitHubReviewComment {
  id: string;
  author: { login: string; name?: string | null } | null;
  body: string;
  url: string;
  createdAt: string;
  diffHunk: string;
}
export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: GitHubReviewSide;
  startDiffSide: GitHubReviewSide | null;
  isOutdated: boolean;
  isResolved: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  comments: GitHubReviewComment[];
}
export interface ReviewThreads {
  url: string;
  headOid: string;
  baseOid: string;
  threads: ReviewThread[];
}
export interface ReviewFile {
  path: string;
  oldPath: string | null;
  headOid: string;
  baseOid: string;
  patch: string | null;
  /** False when the thread refers to a file no longer changed in this PR. */
  changed?: boolean;
}
export interface ReviewThreadAccess {
  file(path: string, snapshot: Pick<ReviewThreads, "headOid" | "baseOid">): Promise<ReviewFile>;
  read(): Promise<ReviewThreads>;
  resolve(id: string, resolved: boolean): Promise<void>;
  reply(id: string, body: string): Promise<void>;
}

/** One revision's entire file list per PR access object, including in-flight reads.
 * Switching files is a lookup; a new head/base replaces the cache. Errors are retryable.
 */
export function reviewFileReader(load: (snapshot: Pick<ReviewThreads, "headOid" | "baseOid">) => Promise<ReviewFile[]>): ReviewThreadAccess["file"] {
  let cached: { key: string; files: Promise<ReviewFile[]> } | undefined;
  return async (path, snapshot) => {
    const key = JSON.stringify([snapshot.headOid, snapshot.baseOid]);
    if (cached?.key !== key) {
      const files = load(snapshot).then((files) => {
        if (files.some((file) => file.headOid !== snapshot.headOid || file.baseOid !== snapshot.baseOid)) {
          throw new Error("The pull request changed. Refresh threads to load its latest diff.");
        }
        return files;
      });
      cached = { key, files };
      void files.catch(() => { if (cached?.files === files) cached = undefined; });
    }
    const files = await cached.files;
    return files.find((file) => file.path === path) ?? files.find((file) => file.oldPath === path)
      ?? { path, oldPath: null, headOid: snapshot.headOid, baseOid: snapshot.baseOid, patch: null, changed: false };
  };
}

/** Original lines are labels only, never anchors in a newer revision. */
export function githubReviewLocation(thread: ReviewThread) {
  const original = thread.isOutdated || thread.line == null;
  const line = original ? thread.originalLine : thread.line;
  const start = original ? thread.originalStartLine : thread.startLine;
  const side = thread.diffSide === "LEFT" ? "base" : "head";
  const range = line == null ? "" : `:${start != null && start !== line ? `${start}-` : ""}${line}`;
  return `${thread.path}${range} (${side}${original && line != null ? ", original" : ""})`;
}

/** Only anchor against a GitHub diff verified against the thread snapshot's revisions. */
export function githubReviewAnchor(thread: ReviewThread, snapshot: Pick<ReviewThreads, "headOid" | "baseOid">, file: {
  path: string; oldPath?: string | null; headOid: string; baseOid: string; beforeLines: number; afterLines: number;
}): { side: GitHubReviewSide; start: number; end: number } | null {
  if (thread.isOutdated || thread.line == null || snapshot.headOid !== file.headOid || snapshot.baseOid !== file.baseOid) return null;
  if (thread.path !== file.path && !(thread.diffSide === "LEFT" && thread.path === file.oldPath)) return null;
  // A cross-side range cannot be represented as one inline range.
  if (thread.startLine != null && thread.startDiffSide != null && thread.startDiffSide !== thread.diffSide) return null;
  const start = thread.startLine ?? thread.line;
  const limit = thread.diffSide === "LEFT" ? file.beforeLines : file.afterLines;
  if (start < 1 || start > thread.line || thread.line > limit) return null;
  return { side: thread.diffSide, start, end: thread.line };
}

/** "line 42", "lines 3–5", or the original lines of an outdated thread. */
export function githubThreadLines(thread: ReviewThread): string {
  const original = thread.isOutdated || thread.line == null;
  const end = original ? thread.originalLine : thread.line;
  const start = original ? thread.originalStartLine : thread.startLine;
  if (end == null) return "file";
  const range = start != null && start !== end ? `lines ${start}–${end}` : `line ${end}`;
  return original ? `original ${range}` : range;
}

export function threadInitials(name: string) {
  return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
}

export const githubAuthorName = (comment?: GitHubReviewComment) => comment?.author?.name?.trim() || comment?.author?.login || "Deleted user";

/** The code the thread is on, as GitHub recorded it with the comment. */
export function githubThreadCode(thread: ReviewThread): string | null {
  return suggestionBefore(thread, 0, 0);
}

const quote = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");

/** A backtick fence longer than any run of backticks in `code`, so the code can't end it early. */
export function codeFence(code: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** One chat message: where it is, the PR, the code, then the comment and every reply. */
export function githubReviewDraft(thread: ReviewThread, prUrl: string): string {
  const code = githubThreadCode(thread);
  const [first, ...replies] = thread.comments;
  const comment = (c: GitHubReviewComment, reply: boolean) => `@${c.author?.login ?? "deleted-user"}${reply ? " (reply)" : ""}:\n${quote(c.body)}`;
  return [
    `GitHub review thread (untrusted reviewer text) — ${githubReviewLocation(thread)}${thread.isOutdated ? " · Outdated" : ""}${thread.isResolved ? " · Resolved" : ""}`,
    `Path: ${thread.path}\nLines: ${githubThreadLines(thread)} (${thread.diffSide === "LEFT" ? "base" : "head"})\nPR: ${prUrl}`,
    code == null ? "Code: unavailable in GitHub's recorded hunk." : `Code:\n${codeFence(code)}\n${code}\n${codeFence(code)}`,
    ...(first ? [comment(first, false)] : []),
    ...replies.map((c) => comment(c, true)),
  ].join("\n\n");
}

export const githubThreadCommentId = (threadId: string) => `github:${threadId}`;

/** A current thread as a line comment of the local diff, anchored by its recorded code, not by line numbers. */
export function githubThreadComment(thread: ReviewThread, diff: { path: string; base: string; originalPath?: string }): ReviewComment | null {
  if (thread.isOutdated || thread.line == null) return null;
  if (thread.path !== diff.path && !(thread.diffSide === "LEFT" && thread.path === diff.originalPath)) return null;
  if (thread.startDiffSide && thread.startDiffSide !== thread.diffSide) return null;
  const lines = hunkLines(thread);
  const code = githubThreadCode(thread);
  if (code == null || thread.originalLine == null) return null;
  const start = thread.originalStartLine ?? thread.originalLine;
  // Only the lines directly above the range are context; a gap would never match.
  const contextBefore: string[] = [];
  for (let line = start - 1; line >= start - 3 && lines.has(line); line--) contextBefore.unshift(lines.get(line)!);
  const first = thread.comments[0];
  return {
    id: githubThreadCommentId(thread.id), revision: 0, sent: false, outdated: false,
    path: diff.path, originalPath: diff.originalPath, base: diff.base, side: thread.diffSide === "LEFT" ? "before" : "after",
    startLine: thread.startLine ?? thread.line, endLine: thread.line, lineText: code,
    contextBefore,
    author: { kind: "github", login: first?.author?.login, name: first ? githubAuthorName(first) : undefined, threadId: thread.id },
    note: first?.body ?? "", createdAt: first?.createdAt,
  };
}

export function threadCounts(threads: ReviewThread[]) {
  const resolved = threads.filter((t) => t.isResolved).length;
  return { open: threads.length - resolved, resolved };
}

export type ReviewBodyPart = { kind: "markdown"; text: string } | { kind: "suggestion"; text: string; before: string | null };

/** The thread side's lines in GitHub's recorded hunk, by line number. */
function hunkLines(thread: ReviewThread): Map<number, string> {
  let oldLine = 0;
  let newLine = 0;
  const found = new Map<number, string>();
  for (const line of (thread.comments[0]?.diffHunk ?? "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (!oldLine && !newLine) continue;
    const sideLine = thread.diffSide === "LEFT" ? oldLine : newLine;
    if (line[0] === " " || line[0] === (thread.diffSide === "LEFT" ? "-" : "+")) found.set(sideLine, line.slice(1));
    if (line[0] === " " || line[0] === "-") oldLine++;
    if (line[0] === " " || line[0] === "+") newLine++;
  }
  return found;
}

/** Read the original side's lines from GitHub's recorded hunk, not the local worktree. */
function suggestionBefore(thread: ReviewThread, above: number, below: number): string | null {
  if (thread.originalLine == null || (thread.startDiffSide && thread.startDiffSide !== thread.diffSide)) return null;
  const start = (thread.originalStartLine ?? thread.originalLine) - above;
  const end = thread.originalLine + below;
  if (start < 1 || end - start > 10000) return null;
  const lines = hunkLines(thread);
  const found: string[] = [];
  for (let n = start; n <= end; n++) { const line = lines.get(n); if (line === undefined) return null; found.push(line); }
  return found.join("\n");
}

/** Respect enclosing code fences so an example containing a suggestion stays an example. */
export function reviewBody(body: string, thread: ReviewThread): ReviewBodyPart[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const parts: ReviewBodyPart[] = [];
  let markdown: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!fence) { markdown.push(lines[i]); continue; }
    const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !closing.test(lines[end])) end++;
    const suggestion = /^suggestion(?::-([0-9]+)\+([0-9]+))?\s*$/.exec(fence[2]);
    if (!suggestion || end === lines.length) { markdown.push(...lines.slice(i, Math.min(end + 1, lines.length))); i = end; continue; }
    if (markdown.length) parts.push({ kind: "markdown", text: markdown.join("\n") });
    markdown = [];
    parts.push({ kind: "suggestion", text: lines.slice(i + 1, end).join("\n"), before: suggestionBefore(thread, Number(suggestion[1] ?? 0), Number(suggestion[2] ?? 0)) });
    i = end;
  }
  if (markdown.length) parts.push({ kind: "markdown", text: markdown.join("\n") });
  return parts;
}

// ---------------------------------------------------------------------------
// One shared copy of each PR's threads (PRO-234): the Checks list, the Changes
// footer and every inline thread in a diff read the same snapshot, and one
// poller per PR refreshes it while any of them is on screen.

export const REVIEW_REFRESH_MS = 3 * 60_000;

export interface ReviewPr {
  url: string;
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  access: ReviewThreadAccess;
  canWrite: boolean;
  /** The agent tab Send to agent and Add all write into. */
  tabId?: string | null;
  errorMessage(error: unknown): string;
}
export interface ThreadView {
  pr: ReviewPr;
  snapshot: ReviewThreads | null;
  loading: boolean;
  error: string | null;
  working: string | null;
  /** Grows on each successful read; cards clear stale action errors with it. */
  refreshed: number;
}
interface PrState {
  view: ThreadView;
  registrations: number;
  watchers: number;
  retry: { failures: number; at: number };
  loaded: boolean;
  request: number;
  reading: boolean;
  mutating: boolean;
  stop?: () => void;
}
const prs = new Map<string, PrState>();
const replyDrafts = new Map<string, string>();
const storeListeners = new Set<() => void>();
let focus: { workspace: string; threadId: string; nonce: number } | null = null;
let nonce = 0;
const emitStore = () => { for (const listener of storeListeners) listener(); };
const subscribeStore = (listener: () => void) => { storeListeners.add(listener); return () => { storeListeners.delete(listener); }; };
const prKey = (workspace: string, url: string) => `${workspace}\0${url}`;
const setView = (state: PrState, change: Partial<ThreadView>) => { state.view = { ...state.view, ...change }; emitStore(); };

/** The PR panel says which PR a workspace's branch has; unregistering forgets it. */
export function registerReviewPr(workspace: string, pr: ReviewPr): () => void {
  const key = prKey(workspace, pr.url);
  let state = prs.get(key);
  if (!state) {
    state = { view: { pr, snapshot: null, loading: false, error: null, working: null, refreshed: 0 }, registrations: 0, watchers: 0, retry: { failures: 0, at: 0 }, loaded: false, request: 0, reading: false, mutating: false };
    prs.set(key, state);
  }
  state.registrations++;
  // The PR panel and the Changes view register the same PR; an equal one changes nothing.
  if (state.view.pr !== pr && !samePr(state.view.pr, pr)) {
    const moved = state.view.pr.state !== pr.state;
    setView(state, { pr });
    if (moved && state.watchers) void refreshThreads(workspace, pr.url);
  }
  const held = state;
  return () => {
    held.registrations--;
    // A re-render that replaces the registration keeps the snapshot it read.
    queueMicrotask(() => {
      if (held.registrations > 0 || prs.get(key) !== held) return;
      held.stop?.(); held.stop = undefined; held.request++;
      prs.delete(key);
      emitStore();
    });
  };
}

const samePr = (a: ReviewPr, b: ReviewPr) => a.url === b.url && a.number === b.number && a.state === b.state && a.access === b.access
  && a.canWrite === b.canWrite && (a.tabId ?? null) === (b.tabId ?? null) && a.errorMessage === b.errorMessage;

/** One thread access object per source and PR, so every surface shares its file cache. */
const accesses = new WeakMap<GitSource, Map<string, ReviewThreadAccess>>();
export function reviewAccessFor(source: GitSource, url: string): ReviewThreadAccess | undefined {
  if (!source.reviewThreads) return undefined;
  const mine = accesses.get(source) ?? new Map<string, ReviewThreadAccess>();
  accesses.set(source, mine);
  let access = mine.get(url);
  if (!access) { access = source.reviewThreads(url); mine.set(url, access); }
  return access;
}

/** Which PR a session's branch has, as the Changes view needs it without the PR panel. */
export interface SessionReviewPr { url: string; number: number; state: ReviewPr["state"] }
/** A fresh answer, from either surface, is reused rather than asked again. */
export const SESSION_PR_FRESH_MS = 30_000;
const sessionPrCache = new Map<string, { at: number; pr: Promise<SessionReviewPr | null> }>();
const sessionPrKey = (source: GitSource, sessionId: string | undefined) => `${source.key}\0${sessionId ?? ""}`;
const pickPr = (prs: SessionReviewPr[]) => prs.find((pr) => pr.state === "OPEN") ?? prs[0] ?? null;

/** The PR panel says what it read, so the Changes view does not read it again. */
export function noteSessionPrs(source: GitSource, sessionId: string | undefined, prs: SessionReviewPr[]) {
  const pr = pickPr(prs.map(({ url, number, state }) => ({ url, number, state })));
  sessionPrCache.set(sessionPrKey(source, sessionId), { at: Date.now(), pr: Promise.resolve(pr) });
}
export function sessionReviewPrCached(source: GitSource, sessionId: string | undefined): boolean {
  const cached = sessionPrCache.get(sessionPrKey(source, sessionId));
  return !!cached && Date.now() - cached.at < SESSION_PR_FRESH_MS;
}

/** The session's PR the way the PR panel finds it: its branch's PR and the ones it opened or linked, an open one first. */
export function discoverSessionPr(source: GitSource, sessionId: string | undefined, force = false): Promise<SessionReviewPr | null> {
  const key = sessionPrKey(source, sessionId);
  const cached = sessionPrCache.get(key);
  if (cached && (cached.at === 0 || (!force && Date.now() - cached.at < SESSION_PR_FRESH_MS))) return cached.pr;
  const pr = (async () => {
    if (!source.reviewThreads) return null;
    const status = await source.workStatus();
    const branch = status.branch && status.branch !== status.defaultBranch ? status.branch : null;
    const { rows } = await sessionPrs(source, sessionId, branch);
    return pickPr(rows.flatMap((row) => row.pr ? [{ url: row.pr.url, number: row.pr.number, state: row.pr.state }] : []));
  })();
  // In flight (at 0) is shared; once settled it is fresh for a while. A failure is asked again next time.
  const entry = { at: 0, pr };
  sessionPrCache.set(key, entry);
  pr.then(() => { if (sessionPrCache.get(key) === entry) entry.at = Date.now(); },
    () => { if (sessionPrCache.get(key) === entry) sessionPrCache.delete(key); });
  return pr;
}

/** The workspace's PR: the one at `url`, else the first open one, else the first registered. */
function currentState(workspace: string | undefined, url?: string): PrState | undefined {
  if (!workspace) return undefined;
  if (url) return prs.get(prKey(workspace, url));
  const mine = [...prs.entries()].filter(([key]) => key.startsWith(`${workspace}\0`)).map(([, state]) => state);
  return mine.find((state) => state.view.pr.state === "OPEN") ?? mine[0];
}
export function useReviewPr(workspace: string | undefined, url?: string): ThreadView | null {
  return useSyncExternalStore(subscribeStore, () => currentState(workspace, url)?.view ?? null);
}
export function reviewPrView(workspace: string | undefined): ThreadView | null {
  return currentState(workspace)?.view ?? null;
}

export async function refreshThreads(workspace: string, url: string, force = false): Promise<void> {
  const state = prs.get(prKey(workspace, url));
  if (!state || !state.watchers || document.visibilityState === "hidden" || state.reading || state.mutating) return;
  if (!force && (Date.now() < state.retry.at || (state.view.pr.state !== "OPEN" && state.loaded))) return;
  const token = ++state.request;
  state.reading = true;
  setView(state, { loading: true });
  try {
    const next = await state.view.pr.access.read();
    if (token === state.request) {
      state.retry = { failures: 0, at: 0 }; state.loaded = true;
      setView(state, { snapshot: next, error: null, refreshed: state.view.refreshed + 1 });
    }
  } catch (error) {
    if (token === state.request) {
      const failures = state.retry.failures + 1;
      state.retry = { failures, at: Date.now() + Math.min(30 * 60_000, REVIEW_REFRESH_MS * 2 ** Math.min(failures - 1, 4)) };
      setView(state, { error: state.view.pr.errorMessage(error) });
    }
  } finally {
    if (token === state.request) { state.reading = false; setView(state, { loading: false }); }
  }
}

/** Read and poll a workspace's PR threads (or one PR's, by `prUrl`) while `active`; any number of surfaces share one poller. */
export function useWatchThreads(workspace: string | undefined, active: boolean, prUrl?: string) {
  const view = useReviewPr(workspace, prUrl);
  const url = view?.pr.url;
  const held = workspace && url ? prs.get(prKey(workspace, url)) : undefined;
  useEffect(() => {
    const state = held;
    if (!workspace || !url || !active || !state) return;
    state.watchers++;
    if (state.watchers === 1) {
      const refresh = () => { void refreshThreads(workspace, url); };
      const timer = window.setInterval(() => { if (state.view.pr.state === "OPEN") refresh(); }, REVIEW_REFRESH_MS);
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", refresh);
      state.stop = () => {
        window.clearInterval(timer);
        window.removeEventListener("focus", refresh);
        document.removeEventListener("visibilitychange", refresh);
      };
    }
    void refreshThreads(workspace, url);
    return () => {
      state.watchers--;
      if (state.watchers > 0) return;
      state.stop?.(); state.stop = undefined;
      // A read started while shown must not land once nothing shows it.
      state.request++; state.reading = false;
      if (state.view.loading) setView(state, { loading: false });
    };
  }, [workspace, url, active, held]);
  return view;
}

async function mutate(workspace: string, url: string, id: string, action: (access: ReviewThreadAccess) => Promise<void>): Promise<boolean> {
  const state = prs.get(prKey(workspace, url));
  if (!state || state.mutating || !state.view.pr.canWrite || state.view.pr.state !== "OPEN") return false;
  state.mutating = true;
  state.request++; // A read started before the write must not overwrite it.
  state.reading = false;
  setView(state, { loading: false, working: id });
  try {
    await action(state.view.pr.access);
    return true;
  } finally {
    state.mutating = false;
    setView(state, { working: null });
    void refreshThreads(workspace, url, true);
  }
}

/** Only web links leave the app; anything else falls back to the PR's own page. */
function webLink(value: string | undefined, fallback: string): string {
  try { const link = new URL(value ?? ""); if (link.protocol === "https:" && !link.username && !link.password) return link.href; } catch { /* fall back */ }
  return fallback;
}

export async function setThreadResolved(workspace: string, url: string, thread: ReviewThread): Promise<boolean> {
  const resolving = !thread.isResolved;
  const done = await mutate(workspace, url, thread.id, (access) => access.resolve(thread.id, resolving));
  const number = prs.get(prKey(workspace, url))?.view.pr.number;
  if (done && resolving) {
    const link = webLink(thread.comments[0]?.url, url);
    // 05.13 names the commenter by first name: "Aisha's comment on …".
    const author = githubAuthorName(thread.comments[0]).split(/\s+/)[0];
    showError(`${author}'s comment on ${thread.path} · ${githubThreadLines(thread)}${number ? ` · PR #${number}` : ""}`, undefined, {
      title: "Thread resolved on GitHub",
      key: `review-thread-resolved:${thread.id}`,
      tone: "success",
      actions: [{ label: "View on GitHub", keepOpen: true, run: () => openUrl(link) }],
    });
  }
  return done;
}
export function replyToThread(workspace: string, url: string, thread: ReviewThread, body: string): Promise<boolean> {
  return mutate(workspace, url, thread.id, (access) => access.reply(thread.id, body));
}

/** Reply text survives the inline widget being redrawn or scrolled out of the diff. */
export const threadReplyDraft = (threadId: string) => replyDrafts.get(threadId) ?? "";
export function setThreadReplyDraft(threadId: string, body: string) {
  if (body) replyDrafts.set(threadId, body); else replyDrafts.delete(threadId);
  emitStore();
}
export function useThreadReplyDraft(threadId: string): string {
  return useSyncExternalStore(subscribeStore, () => threadReplyDraft(threadId));
}

/** At most this many threads, and about this much text, go into one draft at once. */
export const MAX_THREADS_TO_CHAT = 20;
export const MAX_THREADS_TEXT = 64 * 1024;

/**
 * Append threads to an agent tab's chat draft, one message per thread, in
 * order, up to [`MAX_THREADS_TO_CHAT`] threads and about
 * [`MAX_THREADS_TEXT`] characters. When some are left out the draft says so.
 * Returns how many were added and how many were left out.
 */
export function addThreadsToChat(tabId: string, threads: ReviewThread[], prUrl: string): { added: number; omitted: number } {
  if (!threads.length) return { added: 0, omitted: 0 };
  const messages: string[] = [];
  let size = 0;
  for (const thread of threads.slice(0, MAX_THREADS_TO_CHAT)) {
    const message = githubReviewDraft(thread, prUrl);
    // The first always goes in, however long, as Send to agent does.
    if (messages.length && size + message.length > MAX_THREADS_TEXT) break;
    messages.push(message);
    size += message.length + 2;
  }
  const omitted = threads.length - messages.length;
  if (omitted) messages.push(`(${omitted} more open review ${omitted === 1 ? "thread was" : "threads were"} left out to keep this message short. Add them from the Checks panel once these are done.)`);
  const draft = getDraft(tabId);
  setDraft(tabId, `${draft}${draft.trim() ? "\n\n" : ""}${messages.join("\n\n")}`);
  return { added: threads.length - omitted, omitted };
}

type JumpHandler = (thread: ReviewThread) => boolean | Promise<boolean>;
const jumpHandlers = new Map<string, Set<JumpHandler>>();
const jumpFallbacks = new Map<string, Set<JumpHandler>>();
const pendingJumps = new Map<string, ReviewThread>();
const subscribe = (handlers: Map<string, Set<JumpHandler>>, workspace: string, handler: JumpHandler) => {
  const set = handlers.get(workspace) ?? new Set<JumpHandler>();
  set.add(handler); handlers.set(workspace, set);
  return () => { set.delete(handler); if (!set.size) handlers.delete(workspace); };
};
/** The Changes panel opens the thread's file when it lists it. */
export function onThreadJump(workspace: string, handler: (thread: ReviewThread) => boolean): () => void {
  return subscribe(jumpHandlers, workspace, handler);
}
/** Asked when no Changes list has the file yet: it reads the changes itself, then opens the file or leaves the jump pending. */
export function onThreadJumpFallback(workspace: string, handler: (thread: ReviewThread) => Promise<boolean>): () => void {
  return subscribe(jumpFallbacks, workspace, handler);
}
/** Ask for a thread's file diff and its place in it. False when no Changes view has the file, even after reading its changes. */
export async function requestThreadJump(workspace: string, thread: ReviewThread): Promise<boolean> {
  focus = { workspace, threadId: thread.id, nonce: ++nonce };
  pendingJumps.delete(workspace);
  emitStore();
  let handled = false;
  for (const handler of jumpHandlers.get(workspace) ?? []) handled = (handler(thread) as boolean) || handled;
  if (handled) return true;
  const results = await Promise.all([...jumpFallbacks.get(workspace) ?? []].map((handler) => Promise.resolve().then(() => handler(thread)).catch(() => false)));
  return results.some(Boolean);
}
/** A jump waiting for a Changes list to load its file. */
export const pendingThreadJump = (workspace: string) => pendingJumps.get(workspace) ?? null;
export function setPendingThreadJump(workspace: string, thread: ReviewThread | null) {
  if (thread) pendingJumps.set(workspace, thread); else pendingJumps.delete(workspace);
}
/** The file a thread is on in a list of changed files, by its path or, on the base side, its old path. */
export function threadFile<T extends { path: string; oldPath?: string | null }>(files: T[], thread: ReviewThread): T | undefined {
  return files.find((f) => f.path === thread.path) ?? files.find((f) => f.oldPath === thread.path);
}
export function useThreadFocus(workspace: string | undefined) {
  return useSyncExternalStore(subscribeStore, () => focus && focus.workspace === workspace ? focus : null);
}
export function clearThreadFocus(at: number) {
  if (focus?.nonce === at) { focus = null; emitStore(); }
}
