import { useState } from "react";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { cn } from "@/lib/cn";
import { fileName, shortPath } from "@/lib/paths";
import type { ApprovalFile, ApprovalLine } from "@/lib/approvalDiff";

/** Rows a long file shows before "Show all N lines". */
const PREVIEW_LINES = 12;
/** A file this little over the preview shows whole: folding away two lines saves nothing. */
const FOLD_SLACK = 4;

/**
 * What a held edit would change, file by file, inside its approval card.
 * The box keeps its own height and scrolls, so however long the patch,
 * the card's buttons stay where they are. Lines wrap rather than run off
 * to the right: nothing that is approved sits out of view.
 */
export function ApprovalDiff({ files, cwd }: { files: ApprovalFile[]; cwd?: string }) {
  return (
    <div
      className="mt-2 max-h-[min(22rem,32vh)] overflow-y-auto scrollbar-thin rounded-md border border-hairline bg-well outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid="permission-diff"
      // Scrollable by keyboard too: it is a stop on the way back from the buttons, never the first one.
      tabIndex={0}
      role="region"
      aria-label="Proposed changes"
    >
      {files.map((file, i) => (
        <FileDiff key={`${i}:${file.path}`} file={file} cwd={cwd} first={i === 0} />
      ))}
    </div>
  );
}

function FileDiff({ file, cwd, first }: { file: ApprovalFile; cwd?: string; first: boolean }) {
  const [all, setAll] = useState(false);
  const foldable = file.lines.length > PREVIEW_LINES + FOLD_SLACK;
  const shown = foldable && !all ? file.lines.slice(0, PREVIEW_LINES) : file.lines;
  const name = shortPath(file.path, cwd);
  const to = file.movePath ? shortPath(file.movePath, cwd) : null;
  return (
    <section className={cn(!first && "border-t border-hairline")} data-testid="permission-diff-file" aria-label={to ? `${name} → ${to}` : name}>
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">
        <FileTypeIcon name={fileName(file.movePath ?? file.path)} isDir={false} size={13} />
        {/* Wrapped, never cut short: the end of a path is the part that says where the edit lands. */}
        <span className={cn("min-w-0 text-foreground/90 [overflow-wrap:anywhere]", file.kind === "delete" && "line-through")} title={to ? `${file.path} → ${file.movePath}` : file.path} data-testid="permission-diff-path">
          {name}
          {to && <> <span className="text-faint">→</span> {to}</>}
        </span>
        <Badge kind={file.kind} />
        <Counts added={file.added} removed={file.removed} className="ml-auto" />
      </div>
      {file.note && <p className="px-2.5 pb-1 text-[11px] text-warning">{file.note}</p>}
      {shown.length > 0 && (
        <div className="pb-1 font-mono text-[12px] leading-[1.45]">
          {shown.map((line, i) => (
            <Row key={i} line={line} />
          ))}
        </div>
      )}
      {foldable && (
        <button
          type="button"
          onClick={() => setAll((open) => !open)}
          aria-expanded={all}
          className="mb-1 ml-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {all ? "Show fewer lines" : `Show all ${file.lines.length} lines`}
        </button>
      )}
    </section>
  );
}

function Badge({ kind }: { kind: ApprovalFile["kind"] }) {
  const label = kind === "create" ? "new file" : kind === "delete" ? "deleted" : kind === "rename" ? "renamed" : kind === "write" ? "whole file" : null;
  if (!label) return null;
  return <span className={cn("shrink-0 font-sans text-[11px]", kind === "create" ? "text-add" : kind === "delete" ? "text-destructive" : "text-faint")}>{label}</span>;
}

/** Lines added and removed, as the changes row writes them. */
export function Counts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null;
  return (
    <span className={cn("shrink-0 font-mono text-[11.5px] tabular-nums", className)} data-testid="permission-diff-counts">
      {added > 0 && <span className="text-add">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}

function Row({ line }: { line: ApprovalLine }) {
  if (line.kind === "hunk") {
    return <div className="select-none px-2.5 py-0.5 text-[11px] text-faint [overflow-wrap:anywhere]" data-kind="hunk">{line.text || "⋯"}</div>;
  }
  return (
    <div
      className={cn(
        "flex select-text",
        line.kind === "add" && "bg-add/10 text-foreground",
        line.kind === "del" && "bg-destructive/10 text-foreground",
        line.kind === "ctx" && "text-muted-foreground",
      )}
      data-kind={line.kind}
    >
      <span aria-hidden className={cn("w-5 shrink-0 select-none text-center", line.kind === "add" ? "text-add" : line.kind === "del" ? "text-destructive" : "text-faint")}>
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
      </span>
      {/* Read as written: no links, so nothing in the diff is a tab stop or a click away. */}
      <span className="min-w-0 whitespace-pre-wrap pr-2.5 [overflow-wrap:anywhere]">{line.text || " "}</span>
    </div>
  );
}
