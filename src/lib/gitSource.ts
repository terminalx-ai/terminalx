import { RemoteGit, gitErrorMessage, type GitAuthor } from "@terminalx/portable/workspaceGit";
import { api, errorMessage, gh, git, type PullRequest } from "@/lib/api";
import type { BranchInfo, ChangedFile, CommitInfo, WorkStatus } from "@/types/session";

/** A workspace's Git status, plus what only a cloud repository reports so far. */
export interface SourceStatus extends WorkStatus {
  /** Paths with unresolved merge conflicts. */
  conflicted?: string[];
  /** A merge, rebase or cherry-pick left in progress. */
  operation?: string | null;
}

/**
 * Where the Changes, Repo and PR panels read and write Git: the local
 * checkout through the Tauri commands (unchanged behaviour), or one
 * repository of a cloud workspace over its connection (PRO-27). The panels
 * never branch on which it is beyond the optional capabilities below.
 */
export interface GitSource {
  /** Changes whenever what it points at does; effects key on it. */
  key: string;
  /** A cloud repository: its commits carry `author` and its PRs go through the runtime. */
  cloud: boolean;
  /** False for a read-only (participate) attachment. */
  canWrite: boolean;
  workingChanges(): Promise<{ head: string | null; files: ChangedFile[] }>;
  changesBetween(base: string, head: string | null): Promise<ChangedFile[]>;
  fileContentsAt(path: string, base: string, head: string | null): Promise<{ before: string | null; after: string | null }>;
  workStatus(): Promise<SourceStatus>;
  logCommits(from: string | null, limit: number): Promise<CommitInfo[]>;
  branches(): Promise<BranchInfo[]>;
  /** Resolves to a notice worth showing (e.g. what a reconciled push found), or null. */
  commit(message: string): Promise<string | null>;
  push(): Promise<string | null>;
  pull(): Promise<string | null>;
  fetch?(): Promise<string | null>;
  /** Local only: discarding in a cloud workspace is left to its terminal. */
  discard?(path: string): Promise<void>;
  ghAvailable(): Promise<boolean>;
  prs(branch: string): Promise<PullRequest[]>;
  createPr(input: { title: string; body: string; base: string | null; draft: boolean }): Promise<string | null>;
  readyPr(number: number): Promise<void>;
  mergePr(number: number, method: "merge" | "squash" | "rebase"): Promise<void>;
  errorMessage(error: unknown): string;
}

const locals = new Map<string, GitSource>();

/** The local checkout at `cwd`, through the existing Tauri commands. */
export function localGitSource(cwd: string): GitSource {
  const known = locals.get(cwd);
  if (known) return known;
  const source: GitSource = {
    key: `local:${cwd}`,
    cloud: false,
    canWrite: true,
    workingChanges: () => git.workingChanges(cwd).then(([head, files]) => ({ head, files })),
    changesBetween: (base, head) => api.changesBetween(cwd, base, head),
    fileContentsAt: (path, base, head) => api.fileContentsAt(cwd, path, base, head),
    workStatus: () => api.workStatus(cwd),
    logCommits: (from, limit) => api.logCommits(cwd, from, limit),
    branches: () => api.listBranches(cwd),
    commit: (message) => git.commit(cwd, message).then(() => null),
    push: () => git.push(cwd).then(() => null),
    pull: () => git.pull(cwd).then(() => null),
    discard: (path) => git.discard(cwd, path),
    ghAvailable: () => gh.available(),
    prs: (branch) => gh.list(cwd, branch),
    createPr: ({ title, body, base, draft }) => gh.create(cwd, title, body, base, draft).then(() => null),
    readyPr: (number) => gh.ready(cwd, number),
    mergePr: (number, method) => gh.merge(cwd, number, method),
    errorMessage,
  };
  if (locals.size > 64) locals.clear();
  locals.set(cwd, source);
  return source;
}

export class MissingIdentityError extends Error {
  constructor() {
    super('Commits in a cloud workspace carry your Git identity. Set it on this computer with git config --global user.name "…" and user.email "…".');
  }
}

/**
 * One repository of a cloud workspace. `author` is read when committing
 * (the person's own Git identity from this computer); the workspace's GitHub
 * credentials never leave the runtime.
 */
export function cloudGitSource(input: { workspaceKey: string; remote: RemoteGit; canWrite: boolean; author: () => Promise<GitAuthor | null> }): GitSource {
  const { remote } = input;
  const statusOf = async (): Promise<SourceStatus> => {
    const status = await remote.status();
    return {
      isRepo: true,
      dirty: status.dirty,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      defaultBranch: status.defaultBranch,
      aheadOfBase: status.aheadOfBase,
      head: status.head,
      conflicted: status.conflicted,
      operation: status.operation,
    };
  };
  return {
    key: `${input.workspaceKey}|${remote.repo}`,
    cloud: true,
    canWrite: input.canWrite,
    workingChanges: () => remote.workingChanges().then(({ head, files }) => ({ head, files })),
    changesBetween: (base, head) => remote.changesBetween(base, head).then((answer) => answer.files),
    fileContentsAt: (path, base, head) => remote.fileContents(path, base, head),
    workStatus: statusOf,
    logCommits: (from, limit) => remote.log(limit, from),
    branches: () => remote.branches().then((answer) => answer.branches),
    commit: async (message) => {
      const author = await input.author();
      if (!author) throw new MissingIdentityError();
      await remote.commit(message, author);
      return null;
    },
    push: async () => {
      const result = await remote.push();
      if (!result.pushed) return `GitHub already has ${result.branch} at ${result.head.slice(0, 7)}; nothing was pushed again.`;
      return result.reconciled ? `Pushed ${result.branch} (confirmed with GitHub after the connection faltered).` : null;
    },
    pull: () => remote.pull().then(() => null),
    fetch: () => remote.fetch().then(() => null),
    ghAvailable: () => Promise.resolve(true),
    prs: (branch) => remote.prs(branch).then((answer) => answer.prs),
    createPr: async ({ title, body, base, draft }) => {
      const result = await remote.createPr({ title, body, base, draft });
      if (result.existing) return `Pull request #${result.pr.number} for this branch already exists; it is linked below, not duplicated.`;
      return result.reconciled ? `Created #${result.pr.number} (found on GitHub after the answer was lost).` : null;
    },
    readyPr: (number) => remote.readyPr(number).then(() => undefined),
    mergePr: (number, method) => remote.mergePr(number, method).then(() => undefined),
    errorMessage: (error) => (error instanceof MissingIdentityError ? error.message : gitErrorMessage(error)),
  };
}

let identity: Promise<GitAuthor | null> | null = null;

/** This person's Git identity, read once (and again after a miss). */
export function desktopGitIdentity(): Promise<GitAuthor | null> {
  if (!identity) {
    identity = api.gitIdentity().catch(() => null);
    void identity.then((found) => {
      if (!found) identity = null;
    });
  }
  return identity;
}
