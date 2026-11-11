import type { Row } from "./screen";

const textOf = (row: Row) => row.spans.map((span) => span.text).join("").trimEnd();
/** Rows that must stay put, at least, for a change to be a scroll rather than a new screen. */
const MIN_KEPT = 3;
/** The share of the compared rows that must stay put. */
const KEPT_SHARE = 0.6;

/**
 * How many rows a screen moved up between two draws: by how far the rows of
 * the first reappear, higher, in the second (`prev[d + i]` is `next[i]` for
 * most of them, a footer that stays put set aside first). 0 when it did not
 * move, or when it is a screen drawn anew.
 */
export function scrolledOff(prev: string[], next: string[]): number {
  // A footer that stays put (a prompt box, a status line) is no part of what scrolls: it is set aside.
  let n = Math.min(prev.length, next.length);
  while (n > 0 && prev[n - 1] === next[n - 1]) n -= 1;
  const kept = (d: number) => {
    let compared = 0;
    let same = 0;
    for (let i = 0; i + d < n; i++) {
      const before = prev[i + d];
      const after = next[i];
      if (!before.trim() && !after.trim()) continue;
      compared += 1;
      if (before === after) same += 1;
    }
    return same >= MIN_KEPT && same / Math.max(compared, 1) >= KEPT_SHARE ? same : 0;
  };
  const still = kept(0);
  let best = 0;
  let bestKept = still;
  for (let d = 1; d < n - MIN_KEPT; d++) {
    const score = kept(d);
    if (score > bestKept) { best = d; bestKept = score; }
  }
  return best;
}

/**
 * The history of a program that redraws its screen in place, as Claude Code
 * does: no terminal keeps one for it, so what moves off the top of its screen
 * is kept here, oldest first, up to `limit` rows.
 */
export class ScreenHistory {
  private kept: Row[] = [];
  private last: { texts: string[]; rows: Row[] } | null = null;
  private count = 0;

  constructor(private readonly limit = 5000) {}

  /** Sees the screen as it is now; rows that moved off its top since the last look are kept. */
  observe(rows: Row[]) {
    const texts = rows.map(textOf);
    const moved = this.last ? scrolledOff(this.last.texts, texts) : 0;
    for (let i = 0; i < moved; i++) this.kept.push({ ...this.last!.rows[i], key: `history:${this.count++}` });
    if (this.kept.length > this.limit) this.kept.splice(0, this.kept.length - this.limit);
    this.last = { texts, rows };
  }

  get rows(): Row[] { return this.kept; }
}
