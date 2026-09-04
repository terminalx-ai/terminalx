/**
 * The text half of dictation: where spoken words land in a draft, and how a
 * stream of recogniser results becomes settled text.
 *
 * Apple's recogniser does not hand back one transcript that only grows. Inside
 * an utterance each partial result revises the last — a word corrected, a comma
 * added, more words on the end — but after a pause it starts a fresh utterance
 * whose text stands alone: the words from before the pause are simply not in it
 * any more. A draft rebuilt from the newest partial alone therefore loses
 * everything said before the pause, which is what "it replaces instead of
 * appending" looks like from the composer.
 *
 * So the stream is held as two parts. `committed` is what the recogniser has
 * moved on from; `live` is the utterance it is still revising. Only `live` is
 * ever replaced, and only by a result of the same utterance. When a result
 * belongs to a new one, the old `live` is folded into `committed` first, so
 * nothing is dropped. Whether two results are the same utterance is the
 * recogniser's call where it says (see `DictationResult.segment`), and a
 * guess from the words and the timing where it does not; inside one
 * utterance only the words say whether a result is a rewrite of the last.
 *
 * Everything here is pure: the same results always make the same draft.
 */

/** What has been heard so far, split into what has settled and what has not. */
export interface DictationBuffer {
  /** Utterances the recogniser has moved on from, joined with single spaces. */
  committed: string;
  /** The utterance still being revised; every partial replaces it wholesale. */
  live: string;
  /** Recogniser-owned identity for `live`, when the engine can provide one. */
  segment?: number;
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

/** How many words from `prev` still occur in `next`, including duplicates. */
function survivingWordCount(prev: string[], next: string[]): number {
  const available = new Map<string, number>();
  for (const word of next) available.set(word, (available.get(word) ?? 0) + 1);
  let count = 0;
  for (const word of prev) {
    const left = available.get(word) ?? 0;
    if (left === 0) continue;
    count += 1;
    available.set(word, left - 1);
  }
  return count;
}

/** What the recogniser knows about a result beyond its text. */
export interface DictationResult {
  /**
   * Stable within one utterance and different for the next. Apple's is derived
   * in Rust from its timestamps: a partial has placeholder ones, and an
   * utterance ends when it comes back with real ones (see `dictation.rs`).
   */
  segment?: number;
  /** Time since the preceding partial, for engines without segment metadata. */
  sincePreviousMs?: number;
}

const SHORT_PARTIAL_WORDS = 3;
const SEGMENT_PAUSE_MS = 1_500;
/** The share of the old words that must survive a rewrite for it to be a revision. */
const REVISION_SURVIVAL = 1 / 2;

/** How many words `a` and `b` open with in common. */
function sharedPrefixLength(a: string[], b: string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * Whether `next` is the recogniser thinking again about `prev` rather than
 * starting somewhere new. A revision extends or shortens an opening, keeps
 * most of the old head, or arrives quickly enough that a short guess or shared
 * first word is likelier to be a corrected tail. After 1.5 seconds the recent
 * result allowances stop applying, so a new phrase after a pause is folded.
 */
export function revises(prev: string, next: string, sincePreviousMs?: number): boolean {
  const recent = sincePreviousMs != null && Number.isFinite(sincePreviousMs) && sincePreviousMs >= 0 && sincePreviousMs < SEGMENT_PAUSE_MS;
  return rewrites(prev, next, recent);
}

function rewrites(prev: string, next: string, recent: boolean): boolean {
  const a = words(prev);
  const b = words(next);
  if (a.length === 0) return true;
  const shared = sharedPrefixLength(a, b);
  // One is a word-for-word prefix of the other: plainly the same utterance.
  if (shared === a.length || shared === b.length) return true;
  // With no pause, a short guess or a stable leading word is much likelier to
  // be a correction than a new utterance. A long enough gap restores the old
  // text-only distinction for engines that cannot identify their utterances.
  if (recent && (a.length < SHORT_PARTIAL_WORDS || a[0] === b[0])) return true;
  // Inserted or removed guesses can move the matching tail out of prefix
  // position. If enough of the old words survived, it is still a rewrite.
  return survivingWordCount(a, b) >= a.length * REVISION_SURVIVAL;
}

function isRevision(buffer: DictationBuffer, next: string, result: DictationResult): boolean {
  if (buffer.segment != null && result.segment != null) {
    // The recogniser's word is final: a changed identity is a new utterance,
    // whose text stands alone, and what it said before is kept as well.
    if (result.segment !== buffer.segment) return false;
    // The same utterance. Its settled form arrives a couple of seconds after
    // the last partial and can correct any word of it, so the gap between
    // results must not tighten the test. The words alone still decide, since
    // a phrase that shares nothing with the live one is not a rewrite of it.
    return rewrites(buffer.live, next, true);
  }
  return revises(buffer.live, next, result.sincePreviousMs);
}

/**
 * A result about an utterance the recogniser has already moved past: it has
 * been committed as it stood, and folding a late correction in would repeat
 * it after the words that followed. Identities only ever count up.
 */
function outOfOrder(buffer: DictationBuffer, result: DictationResult): boolean {
  return buffer.segment != null && result.segment != null && result.segment < buffer.segment;
}

function withLive(committed: string, live: string, segment: number | undefined): DictationBuffer {
  return segment == null ? { committed, live } : { committed, live, segment };
}

/** Take a partial result. Blank ones say nothing and change nothing. */
export function applyPartial(buffer: DictationBuffer, partial: string, result: DictationResult = {}): DictationBuffer {
  const next = partial.trim();
  if (!next || outOfOrder(buffer, result)) return buffer;
  if (isRevision(buffer, next, result)) return withLive(buffer.committed, next, result.segment);
  return withLive(joinSpoken(buffer.committed, buffer.live), next, result.segment);
}

/**
 * Take a final result: the utterance is over either way. A final that is the
 * last partial said again (or tidied up) replaces it; one that stands on its
 * own is kept as well, so a phrase is never lost to a dedupe.
 */
export function applyFinal(buffer: DictationBuffer, final: string, result: DictationResult = {}): DictationBuffer {
  if (outOfOrder(buffer, result)) return buffer;
  const text = final.trim();
  if (!text) return { committed: spokenText(buffer), live: "" };
  if (isRevision(buffer, text, result)) return { committed: joinSpoken(buffer.committed, text), live: "" };
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
