import { FileTreeView } from "./FileTreeView";

/** The right panel's Files tab: the app's single checkout browser. */
export function FileTree({
  sessionId,
  root,
  rootName,
  active,
  mentionTabId,
  statusKey,
}: {
  sessionId: string;
  root: string;
  rootName?: string;
  active: boolean;
  mentionTabId?: string | null;
  statusKey?: string;
}) {
  return (
    <FileTreeView
      sessionId={sessionId}
      root={root}
      rootName={rootName ?? root.split("/").pop() ?? "project"}
      active={active}
      mentionTabId={mentionTabId}
      statusKey={statusKey}
    />
  );
}
