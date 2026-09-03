import type { Issue, PullRequest } from "@/lib/api";

/** The worktree name a session gets from an issue or pull request. */
export function issueWorktreeName(identifier: string, title: string): string {
  return `${identifier} ${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** The first prompt of a session started from an issue. */
export function issuePrompt(issue: Issue): string {
  const body = issue.body?.trim() ? `\n\n${issue.body.trim()}` : "";
  const provider = issue.provider === "github" ? "GitHub" : "Linear";
  return `Work on ${provider} issue ${issue.identifier}: ${issue.title}${body}\n\nIssue link: ${issue.url}\nWhen done, summarise what changed.`;
}

/** The first prompt of a session started from a GitHub pull request URL. */
export function pullRequestPrompt(pullRequest: PullRequest): string {
  const body = pullRequest.body.trim() ? `\n\n${pullRequest.body.trim()}` : "";
  return `Work on GitHub pull request #${pullRequest.number}: ${pullRequest.title}${body}\n\nPull request link: ${pullRequest.url}\nWhen done, summarise what changed.`;
}
