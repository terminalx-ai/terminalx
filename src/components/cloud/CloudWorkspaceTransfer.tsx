import { useSyncExternalStore } from "react";
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
import { selectSession, upsertSession, useSessionStore } from "@/lib/sessions";

type Imported = Awaited<ReturnType<typeof importCloudWorkspace>>;

interface TransferState {
  opened: boolean;
  busy: boolean;
  notice: string | null;
  imported: Imported | null;
  archiveChosen: boolean;
}

const EMPTY: TransferState = { opened: false, busy: false, notice: null, imported: null, archiveChosen: false };
const transfers = new Map<string, TransferState>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function updateTransfer(key: string, patch: Partial<TransferState>) {
  const next = { ...(transfers.get(key) ?? EMPTY), ...patch };
  transfers.delete(key);
  transfers.set(key, next);
  for (const [candidate, state] of transfers) {
    if (transfers.size <= 16) break;
    if (candidate !== key && !state.busy) transfers.delete(candidate);
  }
  for (const listener of listeners) listener();
}

export function CloudWorkspaceTransfer({ cloud, sessionId, tabId, accountRevision }: {
  cloud: CloudSessionModel;
  sessionId: string;
  tabId: string;
  accountRevision: string;
}) {
  const { client, workspaceId, orgId } = cloud;
  const key = JSON.stringify([accountRevision, orgId, workspaceId, sessionId, tabId]);
  const { opened, busy, notice, imported, archiveChosen } = useSyncExternalStore(subscribe, () => transfers.get(key) ?? EMPTY);
  const sessions = useSessionStore();
  const localAvailable = !imported || !sessions.loaded || sessions.sessions.some((entry) => entry.id === imported.local.sessionId);
  const update = (patch: Partial<TransferState>) => updateTransfer(key, patch);

  const current = () => {
    const { status } = getAccount();
    return status.context?.revision === accountRevision && phase2Ready(status, orgId, "workspaceTransferToLocal");
  };

  const start = async () => {
    if (!client || !current() || transfers.get(key)?.busy) return;
    update({ busy: true, notice: null });
    try {
      const projectPath = await open({ directory: true, multiple: false, title: "Choose a local Git project" });
      if (typeof projectPath !== "string" || !current()) return;
      const transfer = await importCloudWorkspace({ id: workspaceId, orgId }, async () => {
        const snapshot = await readCloudTransfer(client, { sessionId, tabId }, () => current() && client.connection.state === "connected");
        const local = await invoke<SessionEntry>("cloud_transfer_import", {
          input: { ...snapshot, orgId, accountRevision, projectPath },
        });
        if (current()) upsertSession(local);
        return { sessionId: local.id, worktreePath: local.cwd };
      }, current);
      update({ imported: transfer });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      const detail = error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message : String(error);
      update({ notice: code === "transfer_too_large" ? "This workspace is too large to transfer."
        : code === "transfer_fetch_first" ? `${detail} Then retry the transfer.`
        : code === "transfer_no_base" ? "This cloud branch has no usable upstream base. A common upstream commit is required to transfer it." : detail });
    } finally {
      update({ busy: false });
    }
  };

  const archive = async () => {
    if (!imported || !current() || transfers.get(key)?.busy) return;
    update({ archiveChosen: true, busy: true });
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
      update({ notice: result.status === "archived" ? "Cloud workspace archived."
        : result.status === "failed" ? "The cloud workspace was not archived. Your local worktree is ready."
        : "Archive could not be confirmed. Your local worktree is ready." });
    } catch {
      update({ notice: "Archive could not be confirmed. Your local worktree is ready." });
    } finally {
      update({ busy: false });
    }
  };

  return <>
    <Button size="sm" variant="ghost" onClick={() => update({ opened: true })}>Transfer to local…</Button>
    <Dialog open={opened} onOpenChange={(next) => { if (!busy) update({ opened: next }); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer to local</DialogTitle>
          <DialogDescription>{imported
            ? localAvailable
              ? "The local worktree and conversation are ready. You can keep or archive the cloud workspace."
              : "The previously imported local session is no longer available."
            : "Choose a local Git project. TerminalX transfers the committed branch and this conversation’s messages. Uncommitted files and attachments stay in the cloud."}</DialogDescription>
        </DialogHeader>
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => update({ opened: false })}>{imported ? "Close" : "Cancel"}</Button>
          {!imported && <Button disabled={busy} onClick={() => void start()}>{busy ? "Transferring…" : "Choose project…"}</Button>}
          {imported && <Button variant="ghost" disabled={busy} onClick={() => update({ imported: null, archiveChosen: false, notice: null })}>Transfer again…</Button>}
          {imported && localAvailable && !archiveChosen && <Button variant="outline" disabled={busy} onClick={() => void archive()}>Archive cloud workspace</Button>}
          {imported && localAvailable && <Button disabled={busy} onClick={() => { update({ opened: false }); selectSession(imported.local.sessionId); }}>Open local worktree</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
