import { issueOps, type IssueComment, type IssueProvider } from "@/lib/issueOps";

/** More pages than any real thread has; a cursor that never ends stops here. */
const MAX_PAGES = 200;

/**
 * Every comment on an issue, oldest first. `issue_comments` pages forward
 * from the oldest, so the newest are only known once the last page is read.
 * A comment that turns up on two pages (one posted while paging) is kept once.
 */
export async function readAllComments(projectPath: string, provider: IssueProvider, id: string): Promise<IssueComment[]> {
  const byId = new Map<string, IssueComment>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await issueOps.comments(projectPath, provider, id, cursor);
    for (const comment of answer.comments) byId.set(comment.id, comment);
    cursor = answer.nextCursor ?? null;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  return [...byId.values()];
}

/** The discussion in a first prompt stays under this many characters, the newest comments first in line. */
export const PROMPT_DISCUSSION_LIMIT = 12_000;
/** One comment's share of it, so a single pasted log does not crowd out the rest. */
const PROMPT_COMMENT_LIMIT = 3_000;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}\n…(cut)`;
}

/**
 * The comments as Markdown for an agent's first prompt: the most recent ones
 * that fit, in order, and a line saying how many earlier ones were left out
 * and where to read them.
 */
export function discussionForPrompt(comments: IssueComment[], issueUrl: string, limit = PROMPT_DISCUSSION_LIMIT): string {
  if (comments.length === 0) return "";
  const kept: string[] = [];
  let size = 0;
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    const who = comment.author?.login ?? comment.author?.name ?? "someone";
    const when = comment.createdAt ? ` (${comment.createdAt.slice(0, 10)})` : "";
    const entry = `**${who}**${when}:\n${clip(comment.body.trim(), PROMPT_COMMENT_LIMIT)}`;
    // The newest comment always goes in, clipped to the limit if it must be.
    if (kept.length > 0 && size + entry.length > limit) break;
    const fitted = clip(entry, limit);
    kept.unshift(fitted);
    size += fitted.length;
  }
  const omitted = comments.length - kept.length;
  const note = omitted > 0 ? `…${omitted} earlier comment${omitted === 1 ? "" : "s"} omitted; read them at ${issueUrl}\n\n` : "";
  return `## Comments\n\n${note}${kept.join("\n\n")}`;
}
