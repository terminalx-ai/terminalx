import type { DiffLine } from "./diff";

export type ReviewPatchRow = DiffLine | { kind: "hunk"; text: string; oldNo?: never; newNo?: never };

/** GitHub's patch coordinates describe the PR diff, including its merge base and renames. */
export function reviewPatch(patch: string) {
  const rows: ReviewPatchRow[] = [];
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
  let valid = true, inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (oldLeft || newLeft) valid = false;
      oldNo = Number(hunk[1]); newNo = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1); newLeft = Number(hunk[4] ?? 1);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
    } else if (inHunk && line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      oldLeft--; newLeft--;
    } else if (inHunk && line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      oldLeft--;
    } else if (inHunk && line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      newLeft--;
    } else if (line !== "" && !line.startsWith("\\ No newline")) valid = false;
    if (oldLeft < 0 || newLeft < 0) valid = false;
  }
  return { rows, complete: valid && inHunk && oldLeft === 0 && newLeft === 0 };
}

/** Pair each run of deletions/additions without changing either side's line numbers. */
export function splitReviewRows(rows: ReviewPatchRow[]) {
  const pairs: { left?: ReviewPatchRow; right?: ReviewPatchRow; hunk?: string }[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === "hunk") { pairs.push({ hunk: row.text }); i++; }
    else if (row.kind === "ctx") { pairs.push({ left: row, right: row }); i++; }
    else {
      const left: ReviewPatchRow[] = [], right: ReviewPatchRow[] = [];
      while (i < rows.length && (rows[i].kind === "del" || rows[i].kind === "add")) {
        (rows[i].kind === "del" ? left : right).push(rows[i++]);
      }
      for (let j = 0; j < Math.max(left.length, right.length); j++) pairs.push({ left: left[j], right: right[j] });
    }
  }
  return pairs;
}
