import { useEffect, useState } from "react";
import { issueOps, type IssueProvider, type IssueUser } from "@/lib/issueOps";

/**
 * Who the reader is to an issue provider, read once per project, provider
 * and `revision`: the `gh` login can differ between repositories' hosts, and
 * the Linear key can be added or swapped. A caller passes a new `revision`
 * when what the reader is may have changed; a failed read is tried again on
 * the next ask.
 */
const viewers = new Map<string, Promise<IssueUser>>();

export function issueViewer(projectPath: string, provider: IssueProvider, revision = ""): Promise<IssueUser> {
  const key = `${projectPath}\n${provider}\n${revision}`;
  let viewer = viewers.get(key);
  if (!viewer) {
    viewer = issueOps.viewer(projectPath, provider);
    viewers.set(key, viewer);
    viewer.catch(() => viewers.delete(key));
  }
  return viewer;
}

/** Forget the readers read so far, of one provider or all; a new Linear key calls it. */
export function forgetIssueViewers(provider?: IssueProvider) {
  for (const key of [...viewers.keys()]) if (!provider || key.split("\n")[1] === provider) viewers.delete(key);
}

/** The reader, once read; `null` until then and when it can't be. */
export function useIssueViewer(projectPath: string | null | undefined, provider: IssueProvider, revision = ""): IssueUser | null {
  const [viewer, setViewer] = useState<{ key: string; user: IssueUser | null } | null>(null);
  const key = projectPath ? `${projectPath}\n${provider}` : null;
  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    issueViewer(projectPath, provider, revision)
      .then((user) => live && setViewer({ key: `${projectPath}\n${provider}`, user: user ?? null }))
      .catch(() => live && setViewer(null));
    return () => {
      live = false;
    };
  }, [projectPath, provider, revision]);
  return viewer && viewer.key === key ? viewer.user : null;
}
