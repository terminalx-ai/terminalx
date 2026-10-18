import { useEffect, useState } from "react";
import { issueOps, type IssueProvider, type IssueUser } from "@/lib/issueOps";

/**
 * Who the reader is to an issue provider, read once per project and
 * provider: the `gh` login can differ between repositories' hosts, and the
 * Linear key between none and one. A failed read is tried again next time.
 */
const viewers = new Map<string, Promise<IssueUser>>();

export function issueViewer(projectPath: string, provider: IssueProvider): Promise<IssueUser> {
  const key = `${projectPath}\n${provider}`;
  let viewer = viewers.get(key);
  if (!viewer) {
    viewer = issueOps.viewer(projectPath, provider);
    viewers.set(key, viewer);
    viewer.catch(() => viewers.delete(key));
  }
  return viewer;
}

/** For tests: forget every reader read so far. */
export function forgetIssueViewers() {
  viewers.clear();
}

/** The reader, once read; `null` until then and when it can't be. */
export function useIssueViewer(projectPath: string | null | undefined, provider: IssueProvider): IssueUser | null {
  const [viewer, setViewer] = useState<{ key: string; user: IssueUser } | null>(null);
  const key = projectPath ? `${projectPath}\n${provider}` : null;
  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    issueViewer(projectPath, provider)
      .then((user) => live && setViewer({ key: `${projectPath}\n${provider}`, user }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, provider]);
  return viewer && viewer.key === key ? viewer.user : null;
}
