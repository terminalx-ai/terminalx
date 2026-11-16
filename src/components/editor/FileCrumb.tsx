import { Fragment, useEffect, useState } from "react";
import { ChevronRight } from "@/icons";
import { cn } from "@/lib/cn";
import { localGitSource } from "@/lib/gitSource";
import type { ChangedFile } from "@/types/session";

/**
 * Where a file is, in a file tab's toolbar (PRO-402, screen 06.11): its
 * folders, a separator between each, and its name last, all in mono. The
 * name never gives way; the folders before it are cut when the toolbar narrows.
 */
export function FileCrumb({ path, relativePath, className }: { path: string; relativePath: string; className?: string }) {
  const parts = relativePath.split("/").filter(Boolean);
  const name = parts.pop() ?? relativePath;
  return (
    <span className={cn("flex min-w-0 items-center gap-1 font-mono text-[12px]", className)} title={path} aria-label={relativePath} data-testid="file-crumb">
      {parts.length > 0 && (
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden text-muted-foreground" data-testid="file-crumb-folders">
          {parts.map((part, index) => (
            <Fragment key={index}>
              <span className="min-w-0 shrink truncate">{part}</span>
              <ChevronRight aria-hidden className="size-3 shrink-0 text-faint" data-testid="file-crumb-separator" />
            </Fragment>
          ))}
        </span>
      )}
      <span className="max-w-full shrink-0 truncate text-foreground" data-testid="file-crumb-name">{name}</span>
    </span>
  );
}

/** What git says of one file: its status, and the lines added and removed. */
export type FileChange = Pick<ChangedFile, "status" | "additions" | "deletions">;

/**
 * The file's uncommitted change in its checkout, read from the same source as
 * the Changes panel and the file tree (the checkout's working changes); null
 * for a file git has nothing to say about (unchanged, ignored, or not in a
 * repository). `tick` asks again: after a save, and when the file changed on disk.
 */
export function useFileChange(root: string | undefined, rel: string, active: boolean, tick = 0): FileChange | null {
  const [change, setChange] = useState<FileChange | null>(null);
  useEffect(() => {
    if (!root || !active) return;
    let cancelled = false;
    void (async () => {
      let found: FileChange | null = null;
      try {
        const { files } = await localGitSource(root).workingChanges(false);
        const file = files.find((candidate) => candidate.path === rel);
        if (file) found = { status: file.status, additions: file.additions, deletions: file.deletions };
      } catch {
        // Not a repository, or git could not be asked: the file has no badge.
      }
      if (!cancelled) setChange((now) => (now?.status === found?.status && now?.additions === found?.additions && now?.deletions === found?.deletions ? now : found));
    })();
    return () => {
      cancelled = true;
    };
  }, [root, rel, active, tick]);
  return root ? change : null;
}

const STATUS: Record<ChangedFile["status"], { letter: string; word: string; tone: string }> = {
  added: { letter: "A", word: "Added", tone: "bg-add/15 text-add" },
  modified: { letter: "M", word: "Modified", tone: "bg-warning/15 text-warning" },
  deleted: { letter: "D", word: "Deleted", tone: "bg-destructive/15 text-destructive" },
  renamed: { letter: "R", word: "Renamed", tone: "bg-info/15 text-info" },
};

/** A changed file's git status and line counts beside its path: "A +41", "M +3 −2". An unchanged file has none. */
export function FileStatusBadge({ change }: { change: FileChange | null }) {
  if (!change) return null;
  const status = STATUS[change.status];
  const counts = [change.additions > 0 && `+${change.additions}`, change.deletions > 0 && `−${change.deletions}`].filter((count): count is string => typeof count === "string");
  const said = [status.word, change.additions > 0 && `${change.additions} added`, change.deletions > 0 && `${change.deletions} removed`].filter(Boolean).join(", ");
  return (
    // In a toolbar too narrow for it, the badge goes before the controls are crushed.
    <span className={cn("hidden h-5 shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[11px] tabular-nums @min-[360px]/editor-toolbar:flex", status.tone)} title={said} aria-label={said} data-testid="file-status" data-status={change.status}>
      <span>{status.letter}</span>
      {counts.map((count) => <span key={count}>{count}</span>)}
    </span>
  );
}
