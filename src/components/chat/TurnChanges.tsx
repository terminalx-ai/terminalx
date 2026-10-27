import { useState } from "react";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { openChatLink, type ChatLinkContext } from "@/lib/chatLinks";
import { fileName, shortPath } from "@/lib/paths";
import type { TurnFileChange } from "@/lib/turnChanges";
import { File } from "@/icons";

/** Chips shown before the rest fold into "+N more"; a list one longer than this shows whole. */
const SHOWN = 2;

/**
 * What a finished turn changed, under its answer: a chip per file with its
 * lines added and removed, the rest folded into one "+N more" chip that
 * shows them. A file's chip opens it. A setting turns the row off.
 */
export function TurnChanges({ changes, cwd, linkContext }: { changes: TurnFileChange[]; cwd?: string; linkContext?: ChatLinkContext }) {
  const [all, setAll] = useState(false);
  if (!changes.length) return null;
  const folded = !all && changes.length > SHOWN + 1;
  const shown = folded ? changes.slice(0, SHOWN) : changes;
  const rest = changes.slice(SHOWN);
  const sum = (list: TurnFileChange[], key: "added" | "removed") => list.reduce((n, c) => n + c[key], 0);
  return (
    <div className="mb-3 flex flex-wrap gap-1.5 px-1.5" data-testid="turn-changes" aria-label="Files changed in this turn">
      {shown.map((change) => {
        const label = `${shortPath(change.path, cwd)}${change.kind === "create" ? " (new)" : change.kind === "delete" ? " (deleted)" : ""}`;
        return (
          <Chip
            key={change.path}
            title={label}
            icon={<FileTypeIcon name={fileName(change.path)} isDir={false} size={14} />}
            name={fileName(change.path)}
            added={change.added}
            removed={change.removed}
            deleted={change.kind === "delete"}
            onClick={linkContext && change.kind !== "delete" ? () => void openChatLink({ kind: "local", href: change.path, path: change.path }, linkContext).catch(() => {}) : undefined}
          />
        );
      })}
      {folded && (
        <Chip
          icon={<File className="size-3.5 text-muted-foreground" />}
          name={`+${rest.length} more`}
          added={sum(rest, "added")}
          removed={sum(rest, "removed")}
          onClick={() => setAll(true)}
        />
      )}
    </div>
  );
}

function Chip({ icon, name, added, removed, deleted, title, onClick }: { title?: string; icon: React.ReactNode; name: string; added: number; removed: number; deleted?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={!onClick}
      className="flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md px-2 text-[12.5px] ring-1 ring-hairline-strong transition-colors enabled:hover:bg-veil-raised disabled:cursor-default"
    >
      {icon}
      <span className={deleted ? "min-w-0 truncate text-muted-foreground line-through" : "min-w-0 truncate text-muted-foreground"}>{name}</span>
      <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
        {added > 0 && <span className="text-add">+{added}</span>}
        {added > 0 && removed > 0 && " "}
        {removed > 0 && <span className="text-destructive">−{removed}</span>}
      </span>
    </button>
  );
}
