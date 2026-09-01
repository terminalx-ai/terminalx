export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/**
 * Line diff by longest common subsequence, with a cap so a pathological pair
 * (two huge unrelated files) degrades to delete-all + add-all instead of an
 * O(n·m) table the size of memory.
 */
export function diffLines(oldText: string, newText: string, limit = 4000): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if (a.length * b.length > limit * limit) {
    return [...a.map((t, i) => ({ kind: "del" as const, text: t, oldNo: i + 1 })), ...b.map((t, i) => ({ kind: "add" as const, text: t, newNo: i + 1 }))];
  }
  // Trim common prefix/suffix first; most edits touch a small middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      out.push({ kind: "ctx", text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
      out.push({ kind: "add", text: midB[j], newNo: start + j + 1 });
      j++;
    } else {
      out.push({ kind: "del", text: midA[i], oldNo: start + i + 1 });
      i++;
    }
  }
  const tail = a.length - endA;
  for (let k = 0; k < tail; k++) {
    out.push({ kind: "ctx", text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return collapseContext(out);
}

/** Keep 3 context lines around each change; elide the rest as a marker. */
function collapseContext(lines: DiffLine[], keep = 3): DiffLine[] {
  const changed = lines.map((l) => l.kind !== "ctx");
  if (!changed.some(Boolean)) return lines.slice(0, keep * 2);
  const show = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (changed[i]) for (let k = Math.max(0, i - keep); k <= Math.min(lines.length - 1, i + keep); k++) show[k] = true;
  }
  const out: DiffLine[] = [];
  let skipping = 0;
  for (let i = 0; i < lines.length; i++) {
    if (show[i]) {
      if (skipping) {
        out.push({ kind: "ctx", text: `⋯ ${skipping} unchanged lines` });
        skipping = 0;
      }
      out.push(lines[i]);
    } else skipping++;
  }
  if (skipping) out.push({ kind: "ctx", text: `⋯ ${skipping} unchanged lines` });
  return out;
}

export function countChanges(lines: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.kind === "add") additions++;
    else if (l.kind === "del") deletions++;
  }
  return { additions, deletions };
}
