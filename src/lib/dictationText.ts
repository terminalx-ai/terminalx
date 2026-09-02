/**
 * The text half of dictation: where spoken words land in a draft, and how a
 * stream of recogniser results becomes settled text.
 *
 * Apple's recogniser does not hand back one transcript that only grows. Inside
 * an utterance each partial result revises the last — a word corrected, a comma
 * added, more words on the end — but after a pause it starts a fresh segment
 * whose text stands alone: the words from before the pause are simply not in it
 * any more. A draft rebuilt from the newest partial alone therefore loses
 * everything said before the pause, which is what "it replaces instead of
 * appending" looks like from the composer.
 *
 * So the stream is held as two parts. `committed` is what the recogniser has
 * moved on from; `live` is the segment it is still revising. Only `live` is
 * ever replaced. When a result turns out not to be a revision of `live`, the
 * old `live` is folded into `committed` first, so nothing is dropped.
 *
 * Everything here is pure: the same results always make the same draft.
 */

/** What has been heard so far, split into what has settled and what has not. */
export interface DictationBuffer {
  /** Segments the recogniser has moved on from, joined with single spaces. */
  committed: string;
  /** The segment still being revised; every partial replaces it wholesale. */
  live: string;
}

export const EMPTY_BUFFER: DictationBuffer = { committed: "", live: "" };

/**
 * The draft split where the caret was when the mic opened: the words go
 * between the halves, and neither half is ever rewritten.
 */
export interface DictationAnchor {
  before: string;
  after: string;
}

/**
 * Split `text` for a caret (or a selection) in a field. A selection is
 * replaced, as typing into it would be; a plain caret keeps everything.
 */
export function anchorAt(text: string, start: number, end: number): DictationAnchor {
  const from = clamp(Math.min(start, end), text.length);
  const to = Math.max(from, clamp(Math.max(start, end), text.length));
  return { before: text.slice(0, from), after: text.slice(to) };
}

function clamp(n: number, max: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : max;
}

/** Two pieces of text with exactly one space between them, and none added at an edge. */
export function joinSpoken(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return /\s$/.test(left) ? left + right : left + " " + right;
}

/** Everything heard so far, as one string. */
export function spokenText(buffer: DictationBuffer): string {
  return joinSpoken(buffer.committed, buffer.live);
}

/** The words of a transcript, lowercased and stripped of punctuation. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Whether `next` is the recogniser thinking again about `prev` rather than
 * starting somewhere new. A revision keeps the opening words: it extends them,
 * shortens back to them, or rewrites a tail while most of the head survives. A
 * new segment after a pause is a different sentence and shares almost nothing,
 * so requiring half of the previous words to still be there at the front tells
 * the two apart without needing the recogniser to say which it is.
 */
export function revises(prev: string, next: string): boolean {
  const a = words(prev);
  const b = words(next);
  if (a.length === 0) return true;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  // One is a word-for-word prefix of the other: plainly the same segment.
  if (shared === a.length || shared === b.length) return true;
  return shared * 2 >= a.length;
}

/** Take a partial result. Blank ones say nothing and change nothing. */
export function applyPartial(buffer: DictationBuffer, partial: string): DictationBuffer {
  const next = partial.trim();
  if (!next) return buffer;
  if (revises(buffer.live, next)) return { committed: buffer.committed, live: next };
  return { committed: joinSpoken(buffer.committed, buffer.live), live: next };
}

/**
 * Take a final result: the segment is over either way. A final that is the
 * last partial said again (or tidied up) replaces it; one that stands on its
 * own is kept as well, so a phrase is never lost to a dedupe.
 */
export function applyFinal(buffer: DictationBuffer, final: string): DictationBuffer {
  const text = final.trim();
  if (!text) return { committed: spokenText(buffer), live: "" };
  if (revises(buffer.live, text)) return { committed: joinSpoken(buffer.committed, text), live: "" };
  return { committed: joinSpoken(spokenText(buffer), text), live: "" };
}

/**
 * The draft to show, and where the caret belongs in it: the words sit between
 * the anchor's halves with one space on each side where one is wanted — none
 * against an empty edge, and none after a line break, which already separates.
 */
export function draftWithSpeech(anchor: DictationAnchor, buffer: DictationBuffer): { text: string; caret: number } {
  return insertSpoken(anchor, spokenText(buffer));
}

/**
 * The draft to show once `spoken` has been heard, and where the caret belongs
 * in it. Nothing accumulates here: the whole draft is built from the anchor and
 * the words every time, so a write that never arrives costs a moment, not a
 * phrase.
 */
export function insertSpoken(anchor: DictationAnchor, spoken: string): { text: string; caret: number } {
  if (!spoken) return { text: anchor.before + anchor.after, caret: anchor.before.length };
  const head = anchor.before && !/\s$/.test(anchor.before) ? anchor.before + " " : anchor.before;
  const tail = anchor.after && !/^\s/.test(anchor.after) ? " " + anchor.after : anchor.after;
  return { text: head + spoken + tail, caret: head.length + spoken.length };
}
