import { useMemo, useState } from "react";
import { ChevronRight } from "@/icons";
import { useReviewComments } from "./ReviewComments";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { cn } from "@/lib/cn";
import { dirName, fileName } from "@/lib/paths";
import type { ChangedFile } from "@/types/session";

/** A file's status as a coloured letter (M, A, D, R) and the word its title and screen readers use. */
export const STATUS_LETTER: Record<ChangedFile["status"], { letter: string; tone: string; word: string }> = {
  added: { letter: "A", tone: "text-add", word: "Added" },
  modified: { letter: "M", tone: "text-warning", word: "Modified" },
  deleted: { letter: "D", tone: "text-destructive", word: "Deleted" },
  renamed: { letter: "R", tone: "text-info", word: "Renamed" },
};

/** Rows of changed files: name first (it wins the truncation), directory after. */
export function FileList({
  files,
  selected,
  onSelect,
  empty,
  trailing,
  leading,
  base,
  folders = false,
  expandAll = false,
}: {
  base?: string;
  files: ChangedFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  empty: string;
  trailing?: (f: ChangedFile) => React.ReactNode;
  /** Ahead of the row's button: the Viewed box. */
  leading?: (f: ChangedFile) => React.ReactNode;
  folders?: boolean;
  expandAll?: boolean;
}) {
  const review = useReviewComments();
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const c of review?.comments ?? []) if (base && c.base === base && files.some((file) => file.path === c.path && (file.oldPath ?? file.path) === (c.originalPath ?? c.path))) result.set(c.path, (result.get(c.path) ?? 0) + 1);
    return result;
  }, [review?.comments, base, files]);
  if (!files.length) return <div className="px-3 py-4 text-xs text-muted-foreground">{empty}</div>;
  const row = (f: ChangedFile) => {
    const status = STATUS_LETTER[f.status];
    return <div key={f.path} className={cn("group flex h-8 min-w-0 items-center rounded-md", leading && "pl-2", selected === f.path ? "bg-selected" : "hover:bg-selected/50")}>
      {leading?.(f)}
      <button type="button" title={`${status.word} · ${f.path}`} onClick={() => onSelect(f.path)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <span className={cn("w-3 shrink-0 font-mono text-[11px]", status.tone)} data-status={f.status}>
          <span aria-hidden>{status.letter}</span><span className="sr-only">{status.word}</span>
        </span>
        <span className={cn("min-w-0 shrink truncate font-mono", f.status === "deleted" && "text-muted-foreground line-through")}>{fileName(f.path)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{!folders && dirName(f.path)}</span>
        {!!counts.get(f.path) && <span className="shrink-0 text-[11px] text-info">{counts.get(f.path)} {counts.get(f.path) === 1 ? "comment" : "comments"}</span>}
        <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums">
          {f.additions > 0 && <span className="text-add">+{f.additions}</span>}{f.additions > 0 && f.deletions > 0 && " "}
          {f.deletions > 0 && <span className="text-destructive">−{f.deletions}</span>}
        </span>
      </button>
      {trailing?.(f)}
    </div>;
  };
  return <div className="flex flex-col px-1.5 py-1">
    {folders ? <FolderContents files={files} prefix="" row={row} expandAll={expandAll} /> : files.map(row)}
  </div>;
}

function FolderContents({ files, prefix, row, expandAll }: { files: ChangedFile[]; prefix: string; row: (f: ChangedFile) => React.ReactNode; expandAll: boolean }) {
  const directories = new Map<string, ChangedFile[]>();
  const direct: ChangedFile[] = [];
  for (const file of files) {
    const relative = file.path.slice(prefix.length);
    const slash = relative.indexOf("/");
    if (slash < 0) direct.push(file);
    else {
      const name = relative.slice(0, slash);
      const children = directories.get(name) ?? [];
      children.push(file);
      directories.set(name, children);
    }
  }
  return <>
    {[...directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, children]) => <Folder key={name} name={name} path={`${prefix}${name}`} expandAll={expandAll}>
      <FolderContents files={children} prefix={`${prefix}${name}/`} row={row} expandAll={expandAll} />
    </Folder>)}
    {direct.sort((a, b) => a.path.localeCompare(b.path)).map(row)}
  </>;
}

function Folder({ name, path, expandAll, children }: { name: string; path: string; expandAll: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const expanded = expandAll || open;
  return <div>
    <button type="button" aria-label={`Folder ${path}`} aria-expanded={expanded} onClick={() => setOpen(!open)}
      className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
      <ChevronRight className={cn("size-3 shrink-0", expanded && "rotate-90")} />
      <FileTypeIcon name={name} isDir size={14} /><span className="truncate">{name}</span>
    </button>
    {expanded && <div className="ml-3 border-l border-hairline">{children}</div>}
  </div>;
}

export function sumChanges(files: ChangedFile[]) {
  let a = 0;
  let d = 0;
  for (const f of files) {
    a += f.additions;
    d += f.deletions;
  }
  return { additions: a, deletions: d };
}
