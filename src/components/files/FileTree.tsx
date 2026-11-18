import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FileSource } from "@/lib/workspaceFiles";
import { FileTreeView } from "./FileTreeView";

/** The right panel's Files tab: the app's single checkout browser. */
export function FileTree({
  sessionId,
  root,
  rootName,
  active,
  isGit = true,
  mentionTabId,
  statusKey,
  source,
}: {
  sessionId: string;
  root: string;
  rootName?: string;
  active: boolean;
  isGit?: boolean;
  mentionTabId?: string | null;
  statusKey?: string;
  /** Where the files are read; the local checkout at `root` when absent. */
  source?: FileSource;
}) {
  const branch = useCheckoutBranch(root, active && isGit && source?.kind !== "cloud", statusKey);
  return (
    <FileTreeView
      sessionId={sessionId}
      root={root}
      rootName={rootName ?? root.split("/").pop() ?? "project"}
      branch={branch}
      active={active}
      isGit={isGit}
      mentionTabId={mentionTabId}
      statusKey={statusKey}
      source={source}
    />
  );
}

/** The local checkout's branch for the tree's header, re-read when an agent's status changes. */
function useCheckoutBranch(root: string, enabled: boolean, statusKey = ""): string | null {
  const [state, setState] = useState<{ root: string; branch: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .workStatus(root)
      .then((status) => !cancelled && setState({ root, branch: status.isRepo ? (status.branch ?? null) : null }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [root, enabled, statusKey]);
  return enabled && state?.root === root ? state.branch : null;
}
