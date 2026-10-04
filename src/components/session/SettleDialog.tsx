import { closeSettle, useDialogs } from "@/lib/dialogs";
import { useSessionStore } from "@/lib/sessions";
import { WorkspaceRemovalDialog } from "./WorkspaceDeleteDialog";

/** Settlement shares workspace deletion's check, warning and confirmation. */
export function SettleDialog() {
  const { settleFor } = useDialogs();
  const session = useSessionStore().sessions.find((s) => s.id === settleFor);
  if (!session) return null;
  return <WorkspaceRemovalDialog projectPath={session.projectPath} path={session.cwd}
    name={session.worktreeName ?? session.title} sessionId={session.id} intent="settle" onClose={closeSettle} />;
}
