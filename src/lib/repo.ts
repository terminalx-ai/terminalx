/// Where TerminalX's source lives. One constant so the About tab, and anything
/// else that needs to point a reader at the repository, agree on it.
export const REPO_URL = "https://github.com/terminalx-ai/raccoon";

/// A file at the tip of the default branch, as GitHub renders it.
export function repoFile(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}
