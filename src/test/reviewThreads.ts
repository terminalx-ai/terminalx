import type { ReviewThread, ReviewThreads } from "@/lib/reviewThreads";

export const reviewThread: ReviewThread = {
  id: "thread-1", path: "src/login.ts", diffSide: "RIGHT", startDiffSide: null,
  line: 42, startLine: null, originalLine: 12, originalStartLine: null,
  isOutdated: false, isResolved: false, viewerCanResolve: true, viewerCanUnresolve: true, viewerCanReply: true,
  comments: [{ id: "comment-1", author: { login: "reviewer" }, body: "Use the session token.\n```suggestion\nconst token = session.token;\n```", url: "https://github.com/org/repo/pull/1#discussion_r1", createdAt: "2026-11-01T10:00:00Z", diffHunk: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n const token = legacy.token;" }],
};
export const reviewSnapshot: ReviewThreads = { url: "https://github.com/org/repo/pull/1", headOid: "head-3", baseOid: "base", threads: [reviewThread] };
