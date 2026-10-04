import { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { FolderSync } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/menu";
import type { CloudMirrorDivergence } from "@/lib/api";
import { loadCloudMirror, resolveCloudMirror, setCloudMirrorEnabled, useCloudMirror, type CloudMirrorState } from "@/lib/cloudMirror";
import { cn } from "@/lib/cn";

/**
 * The local mirror of a cloud workspace (PRO-25, docs/CLOUD-MIRROR.md): the
 * opt-in, what it is doing, its last successful revision, and the one place
 * a divergence is resolved. Everything here says "files": nothing in it may
 * suggest that commands run on this computer or that the workspace is backed
 * up.
 */

export type MirrorRequest = { orgId: string; workspaceId: string; workspaceName: string };

export function CloudMirrorMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <FolderSync /> Local mirror…
    </DropdownMenuItem>
  );
}

const REASONS: Record<CloudMirrorDivergence["reason"], string> = {
  modified: "edited here",
  deleted: "deleted here",
  replaced: "replaced here by a link or folder",
  "in-the-way": "a file of yours is where the workspace has one",
};

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line for where the mirror stands. Used by the dialog and the header chip. */
export function mirrorSummary(state: CloudMirrorState): string {
  switch (state.phase) {
    case "off":
      return "Off";
    case "paused":
      return "Paused: the workspace is not connected";
    case "queued":
      return "Waiting to sync";
    case "syncing":
      return state.progress ? `Copying files: ${state.progress.files} of ${state.progress.totalFiles}` : "Copying files";
    case "synced":
      return "Files synced";
    case "failed":
      return "Sync failed";
    case "diverged":
      return `${state.divergedTotal} local ${state.divergedTotal === 1 ? "change" : "changes"}: not syncing`;
    case "unsupported":
      return "This workspace's runtime is too old for a mirror";
  }
}

function skippedLine(skipped: Record<string, number> | null): string | null {
  if (!skipped) return null;
  const parts = [
    skipped.secret ? `${skipped.secret} secret ${skipped.secret === 1 ? "file" : "files"}` : null,
    skipped.excluded ? `${skipped.excluded} excluded by the repository` : null,
    skipped.symlink ? `${skipped.symlink} ${skipped.symlink === 1 ? "link" : "links"}` : null,
    skipped.tooLarge ? `${skipped.tooLarge} over 32 MB` : null,
    skipped.unsupported ? `${skipped.unsupported} other` : null,
  ].filter(Boolean);
  return parts.length ? `Left out: ${parts.join(", ")}.` : null;
}

export function CloudMirrorDialog({ request, onClose }: { request: MirrorRequest; onClose: () => void }) {
  const { orgId, workspaceId } = request;
  const state = useCloudMirror(orgId, workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportedTo, setExportedTo] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const on = state.phase !== "off";

  // Reads this computer's record only: it connects to nothing.
  useEffect(() => {
    void loadCloudMirror({ orgId, workspaceId }).catch(() => undefined);
  }, [orgId, workspaceId]);

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    work()
      .catch((failure) => setError(typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "That did not work."))
      .finally(() => setBusy(false));
  };

  const revision = state.revision;
  const left = skippedLine(state.skipped);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[36rem]" className="flex max-h-[85vh] flex-col" data-testid="cloud-mirror-dialog">
        <DialogHeader className="pr-6">
          <DialogTitle className="truncate">Local mirror · {request.workspaceName}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            A copy of the workspace's files on this computer, for local tools to read. It goes one way, from the workspace to here. Commands, agents and terminals still run in the
            cloud workspace, and this is not a backup.
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-2 text-[13px]">
          <div className="flex items-center gap-2">
            <span
              className={cn("size-1.5 shrink-0 rounded-full", state.phase === "synced" ? "bg-success" : state.phase === "failed" || state.phase === "diverged" ? "bg-warning" : "bg-faint")}
              aria-hidden
            />
            <span role="status" data-testid="cloud-mirror-state">
              {mirrorSummary(state)}
            </span>
          </div>

          {state.phase === "failed" && state.error && (
            <p className="text-xs text-destructive" role="alert">
              {state.error}
            </p>
          )}
          {state.phase === "paused" && (
            <p className="text-xs text-muted-foreground">The mirror updates while the workspace is open and connected. It never starts a stopped workspace.</p>
          )}

          {on && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Last synced</dt>
              <dd data-testid="cloud-mirror-revision">
                {revision ? (
                  <>
                    {when(revision.atMs)} · {revision.files} {revision.files === 1 ? "file" : "files"} · {megabytes(revision.bytes)}
                    {revision.repositories.map((repository) => (
                      <span key={repository.repo} className="block text-muted-foreground">
                        {repository.repo === "." ? "" : `${repository.repo}: `}
                        {repository.branch ?? "detached"} at {repository.head?.slice(0, 7) ?? "no commit"}, with the workspace's uncommitted files
                      </span>
                    ))}
                  </>
                ) : (
                  "Never"
                )}
              </dd>
              {state.root && (
                <>
                  <dt className="text-muted-foreground">Folder</dt>
                  <dd className="break-all font-mono text-[11px]">{state.root}</dd>
                </>
              )}
            </dl>
          )}
          {on && left && <p className="text-xs text-muted-foreground">{left}</p>}

          {state.phase === "diverged" && (
            <div className="space-y-2 rounded-lg p-3 hairline" data-testid="cloud-mirror-diverged">
              <p>
                Files in the mirror were changed on this computer. The mirror is not being updated, and nothing here was overwritten or sent to the workspace. To sync again, choose what
                happens to these {state.divergedTotal === 1 ? "" : `${state.divergedTotal} `}local {state.divergedTotal === 1 ? "change" : "changes"}:
              </p>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px]">
                {state.diverged.map((item) => (
                  <li key={item.path} className="flex gap-2">
                    <span className="min-w-0 flex-1 truncate">{item.path}</span>
                    <span className="shrink-0 font-sans text-muted-foreground">{REASONS[item.reason]}</span>
                  </li>
                ))}
                {state.divergedTotal > state.diverged.length && <li className="font-sans text-muted-foreground">and {state.divergedTotal - state.diverged.length} more</li>}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(async () => setExportedTo(await resolveCloudMirror({ orgId, workspaceId }, "export")))}
                >
                  Keep a copy, then use the workspace's files
                </Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => run(async () => void (await resolveCloudMirror({ orgId, workspaceId }, "discard")))}>
                  Discard my changes
                </Button>
              </div>
            </div>
          )}
          {exportedTo && (
            <p className="text-xs text-muted-foreground" data-testid="cloud-mirror-exported">
              Your versions were copied to <span className="break-all font-mono text-[11px]">{exportedTo}</span>
            </p>
          )}

          {removing && (
            <div className="space-y-2 rounded-lg p-3 hairline">
              <p>Remove the mirrored files from this computer? Files you added to the mirror folder yourself are removed too. Copies you kept when resolving changes stay.</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await setCloudMirrorEnabled({ orgId, workspaceId }, false, { removeFiles: true });
                      setRemoving(false);
                    })
                  }
                >
                  Remove the local copy
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="flex-wrap">
          {on && state.root && revision && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => openPath(state.root!))}>
              Show folder
            </Button>
          )}
          {on && !removing && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(true)}>
              Remove local copy…
            </Button>
          )}
          {on ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => setCloudMirrorEnabled({ orgId, workspaceId }, false))}>
              Turn off
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => run(() => setCloudMirrorEnabled({ orgId, workspaceId }, true))}>
              Turn on for this computer
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CHIP: Record<CloudMirrorState["phase"], string> = {
  off: "",
  paused: "Mirror paused",
  queued: "Mirror waiting",
  syncing: "Mirroring files",
  synced: "Files mirrored",
  failed: "Mirror failed",
  diverged: "Mirror: local changes",
  unsupported: "Mirror unavailable",
};

/** The header's note that a mirror exists and where it stands. Hidden while the mirror is off. */
export function CloudMirrorChip({ orgId, workspaceId, onOpen }: { orgId: string; workspaceId: string; onOpen: () => void }) {
  const state = useCloudMirror(orgId, workspaceId);
  if (state.phase === "off") return null;
  const attention = state.phase === "failed" || state.phase === "diverged";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "ml-1 flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] hairline outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        attention ? "text-warning" : "text-muted-foreground hover:text-foreground",
      )}
      data-testid="cloud-mirror-chip"
      // Files only: never a claim that anything runs here or that the workspace is backed up.
      title={`Local mirror: ${mirrorSummary(state)}. A copy of files only; commands still run in the cloud workspace, and it is not a backup.`}
      aria-label={`Local mirror: ${mirrorSummary(state)}`}
    >
      <FolderSync className="size-3" aria-hidden />
      {CHIP[state.phase]}
    </button>
  );
}
