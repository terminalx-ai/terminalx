import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAccount } from "@/lib/account";
import { api } from "@/lib/api";
import type { SessionEntry } from "@/types/session";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { importCloudWorkspace, readCloudTransfer } from "@/lib/cloudWorkspaceTransfer";
import { phase2Ready } from "@/lib/phase2Readiness";
import { selectSession } from "@/lib/sessions";

type Imported = Awaited<ReturnType<typeof importCloudWorkspace>>;

export function CloudWorkspaceTransfer({ cloud, sessionId, tabId, accountRevision }: {
  cloud: CloudSessionModel;
  sessionId: string;
  tabId: string;
  accountRevision: string;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [imported, setImported] = useState<Imported | null>(null);
  const [archiveChosen, setArchiveChosen] = useState(false);
  const { client, workspaceId, orgId } = cloud;

  const current = () => {
    const { status } = getAccount();
    return status.context?.revision === accountRevision && phase2Ready(status, orgId, "workspaceTransferToLocal");
  };

  const start = async () => {
    if (!client || !current()) return;
    setBusy(true);
    setNotice(null);
    try {
      const projectPath = await open({ directory: true, multiple: false, title: "Choose a local Git project" });
      if (typeof projectPath !== "string" || !current()) return;
      const transfer = await importCloudWorkspace({ id: workspaceId, orgId }, async () => {
        const snapshot = await readCloudTransfer(client, { sessionId, tabId }, () => current() && client.connection.state === "connected");
        const local = await invoke<SessionEntry>("cloud_transfer_import", {
          input: { ...snapshot, orgId, accountRevision, projectPath },
        });
        return { sessionId: local.id, worktreePath: local.cwd };
      }, current);
      setImported(transfer);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!imported || !current()) return;
    setArchiveChosen(true);
    setBusy(true);
    try {
      let result = await imported.archiveCloudCopy();
      if (result.status === "queued") {
        const operationId = result.operationId;
        let settled = false;
        for (let attempt = 0; attempt < 20 && current(); attempt++) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
          if (!current()) break;
          const { workspace, operation } = await api.cloudWorkspaceOperation(operationId, orgId);
          if (workspace.id !== workspaceId || workspace.orgId !== orgId || operation.workspaceId !== workspaceId
            || operation.id !== operationId || operation.action !== "archive") break;
          if (operation.state === "succeeded" || operation.state === "failed" || operation.state === "canceled") {
            result = { status: operation.state === "succeeded" ? "archived" : "failed" };
            settled = true;
            break;
          }
        }
        if (!settled) result = { status: "unconfirmed" };
      }
      setNotice(result.status === "archived" ? "Cloud workspace archived."
        : result.status === "failed" ? "The cloud workspace was not archived. Your local worktree is ready."
        : "Archive could not be confirmed. Your local worktree is ready.");
    } catch {
      setNotice("Archive could not be confirmed. Your local worktree is ready.");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpened(true)}>Transfer to local…</Button>
    <Dialog open={opened} onOpenChange={(next) => { if (!busy) setOpened(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer to local</DialogTitle>
          <DialogDescription>{imported
            ? "The local worktree and conversation are ready. You can keep or archive the cloud workspace."
            : "Choose a local Git project. TerminalX transfers the committed branch and this conversation’s messages. Uncommitted files and attachments stay in the cloud."}</DialogDescription>
        </DialogHeader>
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setOpened(false)}>{imported ? "Close" : "Cancel"}</Button>
          {!imported && <Button disabled={busy} onClick={() => void start()}>{busy ? "Transferring…" : "Choose project…"}</Button>}
          {imported && !archiveChosen && <Button variant="outline" disabled={busy} onClick={() => void archive()}>Archive cloud workspace</Button>}
          {imported && <Button disabled={busy} onClick={() => { setOpened(false); selectSession(imported.local.sessionId); }}>Open local worktree</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
