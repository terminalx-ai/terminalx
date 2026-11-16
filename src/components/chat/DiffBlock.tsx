import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { LinkedText } from "./LinkedText";
import { diffLines, patchLines, type DiffLine } from "@/lib/diff";

/**
 * A compact inline diff for one edit, under the row that already names its file: no header of its own. Line-level
 * LCS over the two fragments, which is right for Edit's old/new pairs and for small Writes; whole-file diffs in the
 * changes panel go through the editor's merge view instead.
 *
 * Its gutters number the lines where the edit sits in the file only when the edit itself says so: the numbered
 * snippet its result quotes, or a new file's first line. Searching the file as it is now could land on the wrong
 * copy of short or repeated text, or on a file edited since, so otherwise the gutters stay off.
 */
export function DiffBlock({
  oldText,
  newText,
  kind,
  resultText,
  maxLines = 40,
}: {
  path: string;
  oldText: string;
  newText: string;
  kind?: string;
  cwd?: string;
  /** The edit's own result: a numbered snippet of the file after it, when the harness quotes one. */
  resultText?: string;
  maxLines?: number;
}) {
  const lines = useMemo(() => removedFirst(diffLines(oldText, newText)), [oldText, newText]);
  const quoted = useMemo(() => (kind !== "create" && resultText ? snippetStart(resultText, newText) : null), [kind, resultText, newText]);
  // A new file starts at its first line; any other edit only where its own result says.
  const start = kind === "create" ? 1 : quoted;
  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - shown.length;
  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-well" data-testid="diff-block">
      <div className="overflow-x-auto scrollbar-thin font-mono text-[12px] leading-[1.45]">
        {shown.map((l, i) => (
          <DiffRow key={i} line={start == null ? l : { ...l, oldNo: l.oldNo == null ? undefined : l.oldNo + start - 1, newNo: l.newNo == null ? undefined : l.newNo + start - 1 }} numbered={start != null} />
        ))}
        {hidden > 0 && <div className="px-2.5 py-1 text-[12px] text-faint">… {hidden} more lines</div>}
      </div>
    </div>
  );
}

/** Within each run of changed lines, the removed ones before the added ones: what was there, then what replaced it. */
export function removedFirst(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "del") dels.push(line);
    else if (line.kind === "add") adds.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

/** The new text's first line number in a numbered snippet ("  41→text" or "  41\ttext"), or null. */
export function snippetStart(resultText: string, newText: string): number | null {
  const want = newText.split("\n");
  if (!want.length || !want[0].trim()) return null;
  const rows = resultText.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)(?:→|\t)(.*)$/);
    return m ? [{ no: Number(m[1]), text: m[2] }] : [];
  });
  // A snippet can end inside the edit: the lines it does show must all match.
  for (let i = 0; i < rows.length; i++) {
    if (want.every((text, k) => rows[i + k] === undefined || rows[i + k].text === text)) return rows[i].no;
  }
  return null;
}

function DiffRow({ line, numbered }: { line: DiffLine; numbered: boolean }) {
  return (
    <div
      className={cn(
        "flex whitespace-pre select-text",
        line.kind === "add" && "bg-add/10 text-foreground",
        line.kind === "del" && "bg-destructive/10 text-foreground",
        line.kind === "ctx" && "text-muted-foreground",
      )}
      data-diff-line={line.kind}
    >
      {numbered && (
        <span className="w-9 shrink-0 select-none pr-1.5 text-right tabular-nums text-faint" aria-hidden>
          {line.kind === "add" ? line.newNo : line.oldNo ?? line.newNo ?? ""}
        </span>
      )}
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center",
          line.kind === "add" ? "text-add" : line.kind === "del" ? "text-destructive" : "text-faint",
        )}
      >
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
      </span>
      <span className="pr-3"><LinkedText text={line.text || " "} /></span>
    </div>
  );
}

/** The lines of a diff the harness already produced in unified form, numbered from its hunk headers. */
export function unifiedRows(unified: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let hunks = 0;
  for (const l of patchLines(unified)) {
    const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      // A later hunk is a jump in the file: marked, as the inline diff marks unchanged lines it leaves out.
      if (hunks++ > 0) out.push({ kind: "ctx", text: "⋯" });
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (l.startsWith("\\")) continue;
    if (l.startsWith("+")) out.push({ kind: "add", text: l.slice(1), newNo: newNo++ });
    else if (l.startsWith("-")) out.push({ kind: "del", text: l.slice(1), oldNo: oldNo++ });
    else out.push({ kind: "ctx", text: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return removedFirst(out);
}

/** A diff the harness already produced in unified form. */
export function UnifiedBlock({ unified, maxLines = 60 }: { path: string; unified: string; kind?: string; cwd?: string; maxLines?: number }) {
  const lines = useMemo(() => unifiedRows(unified), [unified]);
  const numbered = /^@@ /m.test(unified);
  const shown = lines.slice(0, maxLines);
  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-well" data-testid="diff-block">
      <div className="overflow-x-auto scrollbar-thin font-mono text-[12px] leading-[1.45]">
        {shown.map((l, i) => <DiffRow key={i} line={l} numbered={numbered} />)}
        {lines.length > shown.length && <div className="px-2.5 py-1 text-[12px] text-faint">… {lines.length - shown.length} more lines</div>}
      </div>
    </div>
  );
}
