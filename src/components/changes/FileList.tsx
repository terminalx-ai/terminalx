import { cn } from "@/lib/cn";
import { dirName, fileName } from "@/lib/paths";
import type { ChangedFile } from "@/types/session";

const STATUS_GLYPH: Record<ChangedFile["status"], [string, string]> = {
  added: ["A", "text-add"],
  modified: ["M", "text-warning"],
  deleted: ["D", "text-destructive"],
  renamed: ["R", "text-info"],
};

/** Rows of changed files: name first (it wins the truncation), directory after. */
export function FileList({
  files,
  selected,
  onSelect,
  empty,
  trailing,
}: {
  files: ChangedFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  empty: string;
  trailing?: (f: ChangedFile) => React.ReactNode;
}) {
  if (!files.length) return <div className="px-3 py-4 text-xs text-muted-foreground">{empty}</div>;
  return (
    <div className="flex flex-col px-1.5 py-1">
      {files.map((f) => {
        const [glyph, color] = STATUS_GLYPH[f.status];
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => onSelect(f.path)}
            className={cn(
              "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              selected === f.path ? "bg-selected" : "hover:bg-selected/50",
            )}
          >
            <span className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", color)}>{glyph}</span>
            <span className="shrink-0 truncate font-mono">{fileName(f.path)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{dirName(f.path)}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums">
              {f.additions > 0 && <span className="text-add">+{f.additions}</span>}{" "}
              {f.deletions > 0 && <span className="text-destructive">−{f.deletions}</span>}
            </span>
            {trailing?.(f)}
          </button>
        );
      })}
    </div>
  );
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
