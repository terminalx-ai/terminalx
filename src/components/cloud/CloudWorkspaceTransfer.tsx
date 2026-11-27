import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Check, Download, Loader2 } from "@/icons";
import { getAccount } from "@/lib/account";
import { api } from "@/lib/api";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { workspaceAuthority } from "@/lib/cloudCollab";
import type { SessionEntry } from "@/types/session";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { importCloudWorkspace, readCloudTransfer, readTransferPreview, type TransferPreview } from "@/lib/cloudWorkspaceTransfer";
import { phase2Ready } from "@/lib/phase2Readiness";
import { selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";

type Imported = Awaited<ReturnType<typeof importCloudWorkspace>>;
type Then = "archive" | "keep";

interface TransferState {
  opened: boolean;
  busy: boolean;
  notice: string | null;
  imported: Imported | null;
  archiveChosen: boolean;
  preview: TransferPreview | null | "loading" | "unavailable";
  projectPath: string | null;
  then: Then;
}

const EMPTY: TransferState = {
  opened: false, busy: false, notice: null, imported: null, archiveChosen: false,
  preview: null, projectPath: null, then: "archive",
};
const transfers = new Map<string, TransferState>();
const listeners = new Set<() => void>();
/** The local project last chosen for a cloud repository, so the next move proposes it. */
const PROJECT_MEMORY = "terminalx.cloudMove.projects";

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

function rememberedProject(repository: string): string | null {
  try {
    const value = (JSON.parse(localStorage.getItem(PROJECT_MEMORY) ?? "{}") as Record<string, unknown>)[repository];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function rememberProject(repository: string, path: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECT_MEMORY) ?? "{}") as Record<string, string>;
    localStorage.setItem(PROJECT_MEMORY, JSON.stringify({ ...saved, [repository]: path }));
  } catch {
    // Only a convenience: the next move asks again.
  }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function homeRelative(path: string) {
  const home = /^\/Users\/[^/]+/.exec(path)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

/**
 * "Move to this Mac" (design 14.16): the committed branch, then this
 * conversation, land in a new local worktree that opens as a local session.
 * The person decides up front what happens to the cloud copy. Nothing is
 * pushed: the commits travel as a Git bundle, over the remote base when the
 * branch has one, and as its whole history when it has none.
 */
export function CloudWorkspaceTransfer({ cloud, sessionId, tabId, accountRevision }: {
  cloud: CloudSessionModel;
  sessionId: string;
  tabId: string;
  accountRevision: string;
}) {
  const { client, workspaceId, orgId } = cloud;
  const key = JSON.stringify([accountRevision, orgId, workspaceId, sessionId, tabId]);
  const state = useSyncExternalStore(subscribe, () => transfers.get(key) ?? EMPTY);
  const { opened, busy, notice, imported, archiveChosen, preview } = state;
  const repository = cloud.projectName || workspaceId;
  const catalog = useCloudCatalog();
  const org = catalog.orgs[orgId];
  const row = org?.source === "live" && !org.error ? org.workspaces.find((entry) => entry.workspace.id === workspaceId) : undefined;
  // Archive is offered to whoever the server lets archive (owners and admins);
  // anyone else keeps the cloud copy running.
  const mayArchive = row ? workspaceAuthority(row.workspace).lifecycle : false;
  const projectPath = state.projectPath ?? rememberedProject(repository);
  const sessions = useSessionStore();
  const localAvailable = !imported || !sessions.loaded || sessions.sessions.some((entry) => entry.id === imported.local.sessionId);
  const update = (patch: Partial<TransferState>) => updateTransfer(key, patch);
  const shown = preview && typeof preview === "object" ? preview : null;
  const then: Then = mayArchive ? state.then : "keep";

  const current = () => {
    const { status } = getAccount();
    return status.context?.revision === accountRevision && phase2Ready(status, orgId, "workspaceTransferToLocal");
  };

  // What would move, read when the dialog opens. A runtime without the
  // preview still moves; the steps then say less.
  useEffect(() => {
    if (!opened || imported || preview !== null || !client) return;
    update({ preview: "loading" });
    void readTransferPreview(client, { sessionId, tabId })
      .then((result) => update({ preview: result }))
      .catch(() => update({ preview: "unavailable" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, imported, preview, client, sessionId, tabId]);

  const chooseProject = async () => {
    const path = await open({ directory: true, multiple: false, title: "Choose a local Git project, or an empty folder" });
    if (typeof path === "string") update({ projectPath: path, notice: null });
  };

  const archive = async (from: Imported) => {
    update({ archiveChosen: true, busy: true });
    try {
      let result = await from.archiveCloudCopy();
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
      update({ notice: result.status === "archived" ? `Moved to this Mac. ${cloud.workspaceName} is archived.`
        : result.status === "failed" ? "Moved to this Mac. The cloud workspace was not archived."
        : "Moved to this Mac. Archiving the cloud workspace could not be confirmed." });
    } catch {
      update({ notice: "Moved to this Mac. Archiving the cloud workspace could not be confirmed." });
    } finally {
      update({ busy: false });
    }
  };

  const move = async () => {
    if (!client || !current() || transfers.get(key)?.busy) return;
    let target = projectPath;
    if (!target) {
      await chooseProject();
      target = transfers.get(key)?.projectPath ?? null;
      if (!target) return;
    }
    if (!current()) return;
    const chosen = then;
    update({ busy: true, notice: null, projectPath: target });
    let done: Imported | null = null;
    try {
      const transfer = await importCloudWorkspace({ id: workspaceId, orgId }, async () => {
        const snapshot = await readCloudTransfer(client, { sessionId, tabId }, () => current() && client.connection.state === "connected");
        const local = await invoke<SessionEntry>("cloud_transfer_import", {
          input: { ...snapshot, orgId, accountRevision, projectPath: target },
        });
        if (current()) upsertSession(local);
        return { sessionId: local.id, worktreePath: local.cwd };
      }, current);
      rememberProject(repository, target);
      done = transfer;
      update({ imported: transfer, notice: chosen === "keep" ? "Moved to this Mac. The cloud workspace keeps running." : null });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      const detail = error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message : String(error);
      update({ notice: code === "transfer_too_large" ? "This workspace is too large to move."
        : code === "transfer_fetch_first" ? `${detail} Then try again.` : detail });
    } finally {
      update({ busy: false });
    }
    if (done && chosen === "archive" && current()) await archive(done);
  };

  const workspaceName = cloud.workspaceName;
  const steps: { title: string; detail: string }[] = [
    {
      title: shown ? `Bring ${shown.branch}` : "Bring the branch",
      detail: !shown ? "Committed work, as a Git bundle"
        : shown.hasRemoteBase ? `${plural(shown.commits, "commit")} after its remote base, as a Git bundle`
        : `${plural(shown.commits, "commit")} · without a remote it moves as a Git bundle`,
    },
    {
      title: "Bring the conversation",
      detail: shown && shown.messages !== null ? `${plural(shown.messages, "message")} from this conversation` : "This conversation's messages",
    },
    {
      title: "Create a local worktree",
      detail: projectPath ? `${homeRelative(projectPath)}/.raccoon/worktrees/…` : "In a local Git project you choose",
    },
    {
      title: "Open it as a local session",
      detail: `${cloudAgentLabel(shown?.harness ?? "")} continues with the same history`,
    },
  ];
  const sharedWith = row?.workspace.sharedWith ?? 0;
  const archiveDetail = `Stops compute now; deleted after 30 days.${sharedWith > 0 ? ` ${plural(sharedWith, "person", "people")} it is shared with lose access.` : ""}`;
  const uncommitted = shown ? shown.uncommittedFiles : null;

  return <>
    <Button size="sm" variant="ghost" onClick={() => update({ opened: true, preview: imported ? preview : null })}>Move to this Mac…</Button>
    <Dialog open={opened} onOpenChange={(next) => { if (!busy) update({ opened: next }); }}>
      <DialogContent width="max-w-[38rem]" className="gap-0 p-0">
        <DialogHeader className="mb-0 flex-row items-start gap-3 border-b border-hairline px-5 py-4">
          <Download className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle className="text-sm font-semibold">Move {workspaceName} to this Mac</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {[cloud.session.title, cloud.location.provider].filter(Boolean).join(" · ")}
            </DialogDescription>
          </div>
        </DialogHeader>
        <ol className="flex flex-col gap-4 border-b border-hairline px-5 py-4" aria-label="What moves">
          {steps.map((step, index) => (
            <li key={step.title} className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {imported ? <Check className="size-3.5" aria-label="Done" /> : index + 1}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-sm">{step.title}</span>
                <span className="truncate text-xs text-muted-foreground">{step.detail}</span>
              </div>
              {index === 2 && !imported && (
                <Button size="sm" variant="ghost" className="ml-auto h-6 shrink-0" disabled={busy} onClick={() => void chooseProject()}>
                  {projectPath ? "Change…" : "Choose…"}
                </Button>
              )}
            </li>
          ))}
        </ol>
        {!imported && (
          <fieldset className="flex flex-col gap-2 px-5 py-4" disabled={busy} aria-labelledby={`${key}-then`}>
            <p id={`${key}-then`} className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Then, in the cloud</p>
            {([
              ...(mayArchive ? [["archive", `Archive ${workspaceName}`, archiveDetail] as const] : []),
              ["keep", "Keep it running", "Both copies exist; changes don't sync between them."] as const,
            ]).map(([value, title, detail]) => (
              <label key={value} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5",
                then === value ? "border-foreground/40 bg-muted/60" : "border-hairline")}>
                <input type="radio" name={`cloud-move-then-${key}`} className="mt-1" checked={then === value} onChange={() => update({ then: value })} />
                <span className="flex flex-col">
                  <span className="text-sm">{title}</span>
                  <span className="text-xs text-muted-foreground">{detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {notice && <p role="status" className="px-5 pt-3 text-sm">{notice}</p>}
        {imported && !localAvailable && <p role="status" className="px-5 pt-3 text-sm">The moved local session is no longer available.</p>}
        <DialogFooter className="mt-0 items-center border-t border-hairline px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">
            {uncommitted === null ? "Uncommitted files stay in the cloud"
              : uncommitted === 0 ? "Uncommitted files: none"
              : `Uncommitted files: ${uncommitted} (they stay in the cloud)`}
          </span>
          <Button variant="outline" disabled={busy} onClick={() => update({ opened: false })}>{imported ? "Close" : "Cancel"}</Button>
          {imported && localAvailable && mayArchive && !archiveChosen && then === "keep" && (
            <Button variant="outline" disabled={busy} onClick={() => void archive(imported)}>Archive cloud workspace</Button>
          )}
          {imported && localAvailable && (
            <Button disabled={busy} onClick={() => { update({ opened: false }); selectSession(imported.local.sessionId); }}>Open local session</Button>
          )}
          {!imported && (
            <Button disabled={busy || preview === "loading"} onClick={() => void move()}>
              {busy ? <><Loader2 className="animate-spin" aria-hidden /> Moving…</> : <><Download aria-hidden /> Move to this Mac</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
