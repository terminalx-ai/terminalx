import { useState } from "react";
import { ChevronRight } from "@/icons";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { cn } from "@/lib/cn";
import { dirName, fileName } from "@/lib/paths";
import type { ChangedFile } from "@/types/session";

/**
 * A file's status, as a word for its title and a dot on its icon. Modified, by
 * far the most common, wears no dot: the dot marks the exceptions (new, gone,
 * moved), and a deleted file's name is struck through as the chat shows it.
 */
const STATUS: Record<ChangedFile["status"], { word: string; dot: string | null }> = {
  added: { word: "Added", dot: "bg-add" },
  modified: { word: "Modified", dot: null },
  deleted: { word: "Deleted", dot: "bg-destructive" },
  renamed: { word: "Renamed", dot: "bg-info" },
};

/** Rows of changed files: name first (it wins the truncation), directory after. */
export function FileList({
  files,
  selected,
  onSelect,
  empty,
  trailing,
  folders = false,
  expandAll = false,
}: {
  files: ChangedFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  empty: string;
  trailing?: (f: ChangedFile) => React.ReactNode;
  folders?: boolean;
  expandAll?: boolean;
}) {
  if (!files.length) return <div className="px-3 py-4 text-xs text-muted-foreground">{empty}</div>;
  const row = (f: ChangedFile) => {
    const status = STATUS[f.status];
    return <div key={f.path} className={cn("group flex min-w-0 items-center rounded-md", selected === f.path ? "bg-selected" : "hover:bg-selected/50")}>
      <button type="button" title={`${status.word} · ${f.path}`} onClick={() => onSelect(f.path)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <span className="relative flex shrink-0" data-status={f.status}>
          <FileTypeIcon name={fileName(f.path)} isDir={false} size={14} />
          {status.dot && <span aria-hidden className={cn("absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-background", status.dot)} />}
          <span className="sr-only">{status.word}</span>
        </span>
        <span className={cn("min-w-0 truncate font-mono", f.status === "deleted" && "text-muted-foreground line-through")}>{fileName(f.path)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{!folders && dirName(f.path)}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {f.additions > 0 && <span className="text-add">+{f.additions}</span>}{" "}
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
