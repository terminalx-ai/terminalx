// `git/1` and `lifecycle.dispositionFacts` from a client (PRO-27,
// docs/CLOUD-GIT.md): review, commit, push and pull requests in a cloud
// workspace's repositories.
// - Every call names its repository. A workspace with several is never
//   answered for "whichever": the runtime refuses `ambiguous_repository`.
// - A commit carries the person's own Git identity; the workspace's GitHub
//   credentials stay in the runtime and are never sent from here.
// - A resend after a dropped connection keeps its `clientRequestId`, so the
//   runtime answers it from its cache. Trying again after a refusal is a new
//   request, and the runtime checks the remote before repeating anything.
import { WorkspaceRpcError, type WorkspaceRpcClient } from "./workspace";

export interface GitAuthor {
  name: string;
  email: string;
}

export interface RemoteRepository {
  /** Workspace-relative; `.` for a workspace that is itself the repository. */
  repo: string;
  branch: string | null;
  head: string | null;
  remote: string | null;
  defaultBranch: string | null;
}

export interface RemoteStatusFile {
  path: string;
  index: string;
  worktree: string;
  from?: string | null;
}

export interface RemoteGitStatus {
  repository: true;
  repo: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  defaultBranch: string | null;
  aheadOfBase: number | null;
  dirty: boolean;
  /** A merge, rebase or cherry-pick left in progress. */
  operation: "merge" | "rebase" | "cherry-pick" | null;
  conflicted: string[];
  files: RemoteStatusFile[];
}

export interface RemoteChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface RemoteCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  parent: string | null;
  tree: string;
}

export interface RemoteBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface RemotePullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: string | null;
  checks: { name: string; state: string; url?: string | null }[];
  body: string;
  author: string;
}

export interface RemotePushResult {
  repo: string;
  branch: string;
  head: string;
  /** False when the remote already had the head: nothing was pushed. */
  pushed: boolean;
  /** The answer came from asking the remote, after a resend or an ambiguous failure. */
  reconciled: boolean;
}

export interface RemotePrCreateResult {
  repo: string;
  pr: RemotePullRequest;
  created: boolean;
  /** An open pull request for the branch already existed; it is linked, not duplicated. */
  existing: boolean;
  reconciled?: boolean;
}

export interface RepositoryFacts {
  path: string;
  branch: string | null;
  dirtyFiles: number | null;
  untrackedFiles: number | null;
  /** Ahead of the upstream; null without one. */
  unpushedCommits: number | null;
  hasUpstream: boolean;
  /** Commits no remote branch has, upstream or not. */
  localOnlyCommits: number | null;
  /** Null when GitHub could not be asked in time. */
  openPullRequests: { number: number; url: string; state: string }[] | null;
}

export interface DispositionFacts {
  v: 1;
  repositories: RepositoryFacts[];
  activeTasks: { sessionId: string; tabId?: string; kind: string; startedAt: unknown }[];
  runningProcesses: number;
  observedAt: number;
}

/** Whether a repository's facts show work that archiving or deleting would put at risk. */
export function hasUnpublishedWork(facts: RepositoryFacts): boolean {
  return !!(facts.dirtyFiles || facts.unpushedCommits || facts.localOnlyCommits || facts.openPullRequests?.length);
}

/** The repositories of a cloud workspace. */
export async function listRepositories(client: WorkspaceRpcClient): Promise<RemoteRepository[]> {
  const listed = await client.call<{ repositories: RemoteRepository[] }>("git.repositories");
  return listed.repositories;
}

/** What an archive or delete would lose; null when the runtime does not report it. */
export async function dispositionFacts(client: WorkspaceRpcClient): Promise<DispositionFacts | null> {
  try {
    return await client.call<DispositionFacts>("lifecycle.dispositionFacts");
  } catch (error) {
    if (error instanceof WorkspaceRpcError && ["capability_not_granted", "method_not_found"].includes(error.code)) return null;
    throw error;
  }
}

/** One repository of a cloud workspace, by its `repo` path. */
export class RemoteGit {
  constructor(readonly client: WorkspaceRpcClient, readonly repo: string) {}

  private read<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.call<T>(method, { ...params, repo: this.repo });
  }

  private write<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.mutate<T>(method, { ...params, repo: this.repo });
  }

  status(): Promise<RemoteGitStatus> {
    return this.read("git.status");
  }

  workingChanges(): Promise<{ head: string; files: RemoteChangedFile[]; truncated: boolean }> {
    return this.read("git.workingChanges");
  }

  changesBetween(base: string, head: string | null): Promise<{ files: RemoteChangedFile[] }> {
    return this.read("git.changesBetween", head ? { base, head } : { base });
  }

  fileContents(path: string, base: string, head: string | null): Promise<{ before: string | null; after: string | null }> {
    return this.read("git.fileContents", head ? { path, base, head } : { path, base });
  }

  async log(limit = 60, from?: string | null): Promise<RemoteCommit[]> {
    const listed = await this.read<{ commits: RemoteCommit[] }>("git.log", from ? { limit, from } : { limit });
    return listed.commits;
  }

  branches(): Promise<{ branches: RemoteBranch[]; current: string | null; defaultBranch: string | null }> {
    return this.read("git.branches");
  }

  prs(branch?: string): Promise<{ branch: string; prs: RemotePullRequest[] }> {
    return this.read("git.prs", branch ? { branch } : {});
  }

  stage(paths: string[]): Promise<unknown> {
    return this.write("git.stage", { paths });
  }

  unstage(paths: string[]): Promise<unknown> {
    return this.write("git.unstage", { paths });
  }

  /** Stages everything (or only `paths`) and commits it as `author`. */
  commit(message: string, author: GitAuthor, options: { paths?: string[]; staged?: boolean } = {}): Promise<{ commit: string; branch: string | null }> {
    return this.write("git.commit", { message, author, ...options });
  }

  checkout(branch: string, options: { create?: boolean; from?: string } = {}): Promise<unknown> {
    return this.write("git.checkout", { branch, ...options });
  }

  fetch(): Promise<{ ahead: number; behind: number }> {
    return this.write("git.fetch");
  }

  pull(): Promise<unknown> {
    return this.write("git.pull");
  }

  push(branch?: string): Promise<RemotePushResult> {
    return this.write("git.push", branch ? { branch } : {});
  }

  createPr(input: { title: string; body: string; base: string | null; draft: boolean; branch?: string }): Promise<RemotePrCreateResult> {
    const { base, ...rest } = input;
    return this.write("git.prCreate", base ? { ...rest, base } : rest);
  }

  readyPr(number: number): Promise<unknown> {
    return this.write("git.prReady", { number });
  }

  mergePr(number: number, method: "merge" | "squash" | "rebase"): Promise<unknown> {
    return this.write("git.prMerge", { number, method });
  }
}

/** What a refused Git call means to the person, by the runtime's error code. */
export function gitErrorMessage(error: unknown): string {
  if (!(error instanceof WorkspaceRpcError)) {
    return "The workspace did not answer, so it is unknown whether this happened. Trying again checks the remote first.";
  }
  switch (error.code) {
    case "auth_failed":
      return "GitHub refused this workspace's access: its token expired or the GitHub App lost access to the repository. Try again; if it keeps failing, an organization admin can reconnect GitHub in Settings.";
    case "outcome_unknown":
      return "GitHub could not be reached, so it is unknown whether this happened. Trying again checks the remote first and never repeats it.";
    case "conflict":
      return error.message.includes("push")
        ? "The remote branch has commits this one does not. Pull (or fetch and merge) first; nothing was forced."
        : error.message;
    case "unpushed":
      return "Push the branch first: GitHub does not have its latest commit.";
    case "ambiguous_repository":
      return "This workspace has several repositories. Choose one first.";
    case "forbidden":
      return "This attachment can only read; committing and publishing need manage access.";
    default:
      return error.message;
  }
}
