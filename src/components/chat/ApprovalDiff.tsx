import { useState } from "react";
import { ChevronDown, ChevronRight } from "@/icons";
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
 * The first file is open; the others are folded to their header row, each
 * opened on its own. The box keeps its own height and scrolls, so however
 * long the patch, the card's buttons stay where they are. Lines wrap rather
 * than run off to the right: nothing that is approved sits out of view.
 */
export function ApprovalDiff({ files, cwd }: { files: ApprovalFile[]; cwd?: string }) {
  return (
    <div
      className="max-h-[min(22rem,32vh)] overflow-y-auto scrollbar-thin bg-well outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
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
  const [open, setOpen] = useState(first);
  const [all, setAll] = useState(false);
  const rows = file.lines.filter((l) => l.kind !== "hunk").length;
  const opens = file.lines.length > 0 || !!file.note;
  const foldable = file.lines.length > PREVIEW_LINES + FOLD_SLACK;
  const shown = foldable && !all ? file.lines.slice(0, PREVIEW_LINES) : file.lines;
  // Only a new file or a whole-file write says where its lines sit: from line 1. An edit's request does not, so it has no numbers.
  const numbered = file.kind === "create" || file.kind === "write";
  const name = shortPath(file.path, cwd);
  const to = file.movePath ? shortPath(file.movePath, cwd) : null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const header = (
    <>
      <FileTypeIcon name={fileName(file.movePath ?? file.path)} isDir={false} size={14} />
      {/* Wrapped, never cut short: the end of a path is the part that says where the edit lands. */}
      <span className={cn("min-w-0 text-left text-foreground/90 [overflow-wrap:anywhere]", file.kind === "delete" && "line-through")} title={to ? `${file.path} → ${file.movePath}` : file.path} data-testid="permission-diff-path">
        {name}
        {to && <> <span className="text-faint">→</span> {to}</>}
      </span>
      <Counts added={file.added} removed={file.removed} />
      <Badge kind={file.kind} />
      {opens && !open && rows > 0 && <span className="shrink-0 font-sans text-[12px] text-faint" data-testid="permission-diff-folded">Show {rows} {rows === 1 ? "line" : "lines"}</span>}
      {opens && <Chevron aria-hidden className="ml-auto size-3.5 shrink-0 text-faint" />}
    </>
  );
  const headerClass = "flex w-full min-w-0 items-center gap-2 px-4 py-2 font-mono text-[12.5px] text-muted-foreground";
  return (
    <section className={cn(!first && "border-t border-hairline")} data-testid="permission-diff-file" aria-label={to ? `${name} → ${to}` : name}>
      {opens ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn(headerClass, "outline-none hover:bg-veil-card focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40")}
        >
          {header}
        </button>
      ) : (
        <div className={headerClass}>{header}</div>
      )}
      {open && file.note && <p className="px-4 pb-1.5 text-[12px] text-warning">{file.note}</p>}
      {open && shown.length > 0 && (
        <div className="border-t border-hairline py-1 font-mono text-[12px] leading-[1.5]">
          {shown.map((line, i) => (
            <Row key={i} line={line} no={numbered ? i + 1 : null} />
          ))}
        </div>
      )}
      {open && foldable && (
        <button
          type="button"
          onClick={() => setAll((on) => !on)}
          aria-expanded={all}
          className="mb-1 ml-3 rounded px-1 py-0.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
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
  return <span className={cn("shrink-0 font-sans text-[12px]", kind === "create" ? "text-add" : kind === "delete" ? "text-destructive" : "text-faint")}>{label}</span>;
}

/** Lines added and removed, as the changes row writes them. */
export function Counts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null;
  return (
    <span className={cn("shrink-0 font-mono text-[12px] tabular-nums", className)} data-testid="permission-diff-counts">
      {added > 0 && <span className="text-add">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}

/** `no`: the row's line in the file, where the request says it; null leaves the gutter to the sign alone. */
function Row({ line, no }: { line: ApprovalLine; no: number | null }) {
  if (line.kind === "hunk") {
    return <div className="select-none px-4 py-0.5 text-[12px] text-faint [overflow-wrap:anywhere]" data-kind="hunk">{line.text || "⋯"}</div>;
  }
  return (
    <div
      className={cn(
        "flex select-text pl-2",
        line.kind === "add" && "bg-add/10 text-foreground",
        line.kind === "del" && "bg-destructive/10 text-foreground",
        line.kind === "ctx" && "text-muted-foreground",
      )}
      data-kind={line.kind}
    >
      {no != null && <span aria-hidden className="w-8 shrink-0 select-none pr-1 text-right tabular-nums text-faint" data-testid="permission-diff-line-no">{no}</span>}
      <span aria-hidden className={cn("w-6 shrink-0 select-none text-center", line.kind === "add" ? "text-add" : line.kind === "del" ? "text-destructive" : "text-faint")}>
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
      </span>
      {/* Read as written: no links, so nothing in the diff is a tab stop or a click away. */}
      <span className="min-w-0 whitespace-pre-wrap pr-4 [overflow-wrap:anywhere]">{line.text || " "}</span>
    </div>
  );
}
