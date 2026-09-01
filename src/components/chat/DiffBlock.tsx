import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { shortPath } from "@/lib/paths";
import { diffLines, type DiffLine } from "@/lib/diff";

/**
 * A compact inline diff for one edit. Line-level LCS over the two fragments,
 * which is right for Edit's old/new pairs and for small Writes; whole-file
 * diffs in the changes panel go through the editor's merge view instead.
 */
export function DiffBlock({
  path,
  oldText,
  newText,
  kind,
  cwd,
  maxLines = 40,
}: {
  path: string;
  oldText: string;
  newText: string;
  kind?: string;
  cwd?: string;
  maxLines?: number;
}) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - shown.length;
  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-well">
      <div className="flex items-center gap-2 border-b border-hairline px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{shortPath(path, cwd)}</span>
        {kind === "create" && <span className="text-add">new file</span>}
        {kind === "delete" && <span className="text-destructive">deleted</span>}
      </div>
      <div className="overflow-x-auto scrollbar-thin font-mono text-[12px] leading-[1.45]">
        {shown.map((l, i) => (
          <DiffRow key={i} line={l} />
        ))}
        {hidden > 0 && <div className="px-2.5 py-1 text-[11px] text-faint">… {hidden} more lines</div>}
      </div>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        "flex whitespace-pre select-text",
        line.kind === "add" && "bg-add/10 text-foreground",
        line.kind === "del" && "bg-destructive/10 text-foreground",
        line.kind === "ctx" && "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center",
          line.kind === "add" ? "text-add" : line.kind === "del" ? "text-destructive" : "text-faint",
        )}
      >
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
      </span>
      <span className="pr-3">{line.text || " "}</span>
    </div>
  );
}
