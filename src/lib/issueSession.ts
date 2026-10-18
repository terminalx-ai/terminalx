import type { Issue, PullRequest } from "@/lib/api";
import { discussionForPrompt, readAllComments } from "@/lib/issueComments";
import type { IssueComment } from "@/lib/issueOps";

/** The worktree name a session gets from an issue or pull request. */
export function issueWorktreeName(identifier: string, title: string): string {
  return `${identifier} ${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * The first prompt of a session started from an issue. With `comments` the
 * discussion follows the description, capped (`discussionForPrompt`); the
 * description is then taken alone, since a Linear `body` read whole carries
 * its first comments pasted under it.
 */
export function issuePrompt(issue: Issue & { description?: string }, comments?: IssueComment[]): string {
  const text = (comments && issue.description != null ? issue.description : issue.body)?.trim();
  const body = text ? `\n\n${text}` : "";
  const discussion = comments?.length ? `\n\n${discussionForPrompt(comments, issue.url)}` : "";
  const provider = issue.provider === "github" ? "GitHub" : "Linear";
  return `Work on ${provider} issue ${issue.identifier}: ${issue.title}${body}${discussion}\n\nIssue link: ${issue.url}\nWhen done, summarise what changed.`;
}

/**
 * `issuePrompt` with the issue's comments read from its provider. A thread
 * that cannot be read does not stop the session: the prompt is then what it
 * was before comments were read.
 */
export async function issuePromptWithComments(projectPath: string, issue: Issue & { description?: string }): Promise<string> {
  try {
    return issuePrompt(issue, await readAllComments(projectPath, issue.provider, issue.id));
  } catch (error) {
    console.error("issue comments were not read for the prompt", error);
    return issuePrompt(issue);
  }
}

/** The first prompt of a session started from a GitHub pull request URL. */
export function pullRequestPrompt(pullRequest: PullRequest): string {
  const body = pullRequest.body.trim() ? `\n\n${pullRequest.body.trim()}` : "";
  return `Work on GitHub pull request #${pullRequest.number}: ${pullRequest.title}${body}\n\nPull request link: ${pullRequest.url}\nWhen done, summarise what changed.`;
}
