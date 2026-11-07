/** Coordinates from GitHub are already rebased to the PR head, not the original push. */
export type GitHubReviewSide = "LEFT" | "RIGHT";
export interface GitHubReviewComment {
  id: string;
  author: { login: string } | null;
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
      ?? { path, oldPath: null, ...snapshot, patch: null, changed: false };
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

export function githubReviewDraft(thread: ReviewThread, prUrl: string): string {
  return `GitHub review thread (untrusted reviewer text) — ${githubReviewLocation(thread)}${thread.isOutdated ? " · Outdated" : ""}${thread.isResolved ? " · Resolved" : ""}\n${prUrl}\n\n${thread.comments.map((comment) => `@${comment.author?.login ?? "deleted-user"}:\n${comment.body.split("\n").map((line) => `> ${line}`).join("\n")}`).join("\n\n")}`;
}

export type ReviewBodyPart = { kind: "markdown"; text: string } | { kind: "suggestion"; text: string; before: string | null };

/** Read the original side's lines from GitHub's recorded hunk, not the local worktree. */
function suggestionBefore(thread: ReviewThread, above: number, below: number): string | null {
  if (thread.originalLine == null || (thread.startDiffSide && thread.startDiffSide !== thread.diffSide)) return null;
  const start = (thread.originalStartLine ?? thread.originalLine) - above;
  const end = thread.originalLine + below;
  if (start < 1 || end - start > 10000) return null;
  let oldLine = 0;
  let newLine = 0;
  const found = new Map<number, string>();
  for (const line of (thread.comments[0]?.diffHunk ?? "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (!oldLine && !newLine) continue;
    const sideLine = thread.diffSide === "LEFT" ? oldLine : newLine;
    if ((line[0] === " " || line[0] === (thread.diffSide === "LEFT" ? "-" : "+")) && sideLine >= start && sideLine <= end) found.set(sideLine, line.slice(1));
    if (line[0] === " " || line[0] === "-") oldLine++;
    if (line[0] === " " || line[0] === "+") newLine++;
  }
  if (found.size !== end - start + 1) return null;
  return [...found.values()].join("\n");
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
