export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Remove unified-diff file metadata, retaining +/- content even when it resembles a header. */
export function patchLines(unified: string): string[] {
  const lines = unified.split("\n");
  const body: string[] = [];
  let inHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("index ")) continue;
    if (line.startsWith("@@")) inHunk = true;
    // File headers are an adjacent old/new pair before the hunk. Codex also
    // supplies headerless patches, so a leading '-' or '+' alone proves nothing.
    if (!inHunk && /^---[ \t]/.test(line) && /^\+\+\+[ \t]/.test(lines[i + 1] ?? "")) {
      i++;
      continue;
    }
    body.push(line);
  }
  return body;
}

/** Maximum edit distance explored by Myers before degrading to delete-all + add-all on the changed middle. */
const MYERS_HARD_CAP = 2000;

/**
 * Line diff by Myers O((N + M) · D) shortest edit script after trimming common
 * prefix/suffix lines. Pathological pairs whose edit distance exceeds `limit`
 * (capped at `MYERS_HARD_CAP`) degrade cleanly to delete-all + add-all on the
 * differing middle region without allocating an O(N · M) matrix.
 */
export function diffLines(oldText: string, newText: string, limit = 4000): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  // Trim common prefix/suffix first; most edits touch a small middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });

  if (n === 0) {
    for (let j = 0; j < m; j++) out.push({ kind: "add", text: b[start + j], newNo: start + j + 1 });
  } else if (m === 0) {
    for (let i = 0; i < n; i++) out.push({ kind: "del", text: a[start + i], oldNo: start + i + 1 });
  } else {
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const maxD = Math.min(n + m, limit, MYERS_HARD_CAP);
    const midOps = myersDiff(midA, midB, start, maxD);
    if (midOps) {
      for (const op of midOps) out.push(op);
    } else {
      for (let i = 0; i < n; i++) out.push({ kind: "del", text: midA[i], oldNo: start + i + 1 });
      for (let j = 0; j < m; j++) out.push({ kind: "add", text: midB[j], newNo: start + j + 1 });
    }
  }

  const tail = a.length - endA;
  for (let k = 0; k < tail; k++) {
    out.push({ kind: "ctx", text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return collapseContext(out);
}

/**
 * Myers O((N + M) · D) forward search + backtrack on the trimmed middle slice.
 * Returns null if the shortest edit distance exceeds `maxD`.
 */
function myersDiff(a: string[], b: string[], offsetLines: number, maxD: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  // trace[d] stores the frontier for diagonals -d..d (index k + d) after edit step d.
  const trace: Int32Array[] = [];
  let foundD = -1;

  // d = 0: follow diagonal 0 snake from (0, 0)
  {
    let x = 0;
    let y = 0;
    while (x < n && y < m && a[x] === b[y]) {
      x++;
      y++;
    }
    v[offset] = x;
    const snap = new Int32Array(1);
    snap[0] = x;
    trace.push(snap);
    if (x >= n && y >= m) foundD = 0;
  }

  for (let d = 1; foundD < 0 && d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD < 0 && d < maxD) {
      trace.push(v.slice(offset - d, offset + d + 1));
    }
  }

  if (foundD < 0) return null;

  const rev: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let step = foundD; step > 0; step--) {
    const prevD = step - 1;
    const prevV = trace[prevD];
    const k = x - y;
    const insert = k === -step || (k !== step && prevV[k - 1 + prevD] < prevV[k + 1 + prevD]);
    const prevK = insert ? k + 1 : k - 1;
    const prevX = prevV[prevK + prevD];
    const snakeStartX = insert ? prevX : prevX + 1;
    while (x > snakeStartX) {
      x--;
      y--;
      rev.push({ kind: "ctx", text: a[x], oldNo: offsetLines + x + 1, newNo: offsetLines + y + 1 });
    }
    if (insert) {
      y--;
      rev.push({ kind: "add", text: b[y], newNo: offsetLines + y + 1 });
    } else {
      x--;
      rev.push({ kind: "del", text: a[x], oldNo: offsetLines + x + 1 });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rev.push({ kind: "ctx", text: a[x], oldNo: offsetLines + x + 1, newNo: offsetLines + y + 1 });
  }
  rev.reverse();
  return rev;
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
