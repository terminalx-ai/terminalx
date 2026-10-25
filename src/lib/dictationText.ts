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

/** A reducer-owned utterance boundary, retained even after finalization.
 * IDs are local to one recording; a revision retains its ID, a fold starts another. */
export interface DictationPart {
  id: number;
  raw: string;
  text: string;
}

/** What has been heard so far, split into what has settled and what has not. */
export interface DictationBuffer {
  /** Utterances the recogniser has moved on from, joined with single spaces. */
  committed: string;
  /** The utterance still being revised; every partial replaces it wholesale. */
  live: string;
  /** Raw live recognition, before personalization changes its words. */
  raw?: string;
  /** Raw counterparts of settled utterances, retained across edit boundaries. */
  rawCommitted?: string;
  /** Paired forms without flattening known settled/live boundaries. */
  parts?: readonly DictationPart[];
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
  /** Untransformed text used only to identify revisions. */
  raw?: string;
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
    return rewrites(buffer.raw ?? buffer.live, result.raw ?? next, true);
  }
  return revises(buffer.raw ?? buffer.live, result.raw ?? next, result.sincePreviousMs);
}

/**
 * A result about an utterance the recogniser has already moved past: it has
 * been committed as it stood, and folding a late correction in would repeat
 * it after the words that followed. Identities only ever count up.
 */
function outOfOrder(buffer: DictationBuffer, result: DictationResult): boolean {
  return buffer.segment != null && result.segment != null && result.segment < buffer.segment;
}

function withLive(committed: string, live: string, segment: number | undefined, raw?: string): DictationBuffer {
  const buffer: DictationBuffer = segment == null ? { committed, live } : { committed, live, segment };
  return raw == null ? buffer : { ...buffer, raw };
}

/** Everything recognised before formatting, with the same utterance folding. */
export function rawSpokenText(buffer: DictationBuffer): string {
  return joinSpoken(buffer.rawCommitted ?? buffer.committed, buffer.raw ?? buffer.live);
}

function hasRaw(buffer: DictationBuffer, result: DictationResult): boolean {
  return result.raw != null || buffer.raw != null || buffer.rawCommitted != null;
}

function recognitionParts(buffer: DictationBuffer): readonly DictationPart[] {
  if (buffer.parts) return buffer.parts;
  // Compatibility for a stream that gains raw metadata after its first result.
  const parts: DictationPart[] = [];
  if (buffer.committed) parts.push({ id: 0, raw: buffer.rawCommitted ?? buffer.committed, text: buffer.committed });
  if (buffer.live) parts.push({ id: parts.length, raw: buffer.raw ?? buffer.live, text: buffer.live });
  return parts;
}

function updateParts(buffer: DictationBuffer, raw: string, text: string, revision: boolean): readonly DictationPart[] {
  const parts = recognitionParts(buffer);
  const last = parts.at(-1);
  if (revision && buffer.live && last) return [...parts.slice(0, -1), { id: last.id, raw, text }];
  return [...parts, { id: (last?.id ?? -1) + 1, raw, text }];
}

/** Take a partial result. Blank ones say nothing and change nothing. */
export function applyPartial(buffer: DictationBuffer, partial: string, result: DictationResult = {}): DictationBuffer {
  const next = partial.trim();
  if (!next || outOfOrder(buffer, result)) return buffer;
  const revision = isRevision(buffer, next, result);
  const updated = withLive(revision ? buffer.committed : spokenText(buffer), next, result.segment, result.raw);
  if (hasRaw(buffer, result)) {
    updated.rawCommitted = revision ? buffer.rawCommitted ?? buffer.committed : rawSpokenText(buffer);
    updated.raw = result.raw ?? next;
    updated.parts = updateParts(buffer, result.raw ?? next, next, revision);
  }
  return updated;
}

/**
 * Take a final result: fold raw and formatted forms at the same boundary so
 * an edit can keep ownership even after the live utterance has settled.
 */
export function applyFinal(buffer: DictationBuffer, final: string, result: DictationResult = {}): DictationBuffer {
  if (outOfOrder(buffer, result)) return buffer;
  const text = final.trim();
  const revision = isRevision(buffer, text, result);
  const updated: DictationBuffer = { committed: !text ? spokenText(buffer)
    : joinSpoken(revision ? buffer.committed : spokenText(buffer), text), live: "" };
  if (hasRaw(buffer, result)) {
    updated.rawCommitted = !text ? rawSpokenText(buffer)
      : joinSpoken(revision ? buffer.rawCommitted ?? buffer.committed : rawSpokenText(buffer), result.raw ?? text);
    updated.raw = "";
    updated.parts = text ? updateParts(buffer, result.raw ?? text, text, revision) : recognitionParts(buffer);
  }
  return updated;
}

/** One word of a transcript as it was heard, where it starts, and the form it is compared in. */
interface SpokenWord {
  at: number;
  word: string;
}

function spokenWords(text: string): SpokenWord[] {
  return Array.from(text.matchAll(/\S+/gu), (match) => ({ at: match.index, word: match[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") }));
}

/**
 * How many of the words `now` opens with are `had` said again. The recogniser
 * may have thought again about any of them, so they are lined up by the fewest
 * words changed, dropped or added, and a changed word at the end counts as a
 * correction of the old one, not as something new.
 */
function saidAgain(had: string[], now: string[]): number {
  const shared = sharedPrefixLength(had, now);
  const a = had.slice(shared);
  if (a.length === 0) return shared;
  // Past twice the old words, more of the new ones can only cost more.
  const b = now.slice(shared, shared + 2 * a.length);
  // row[j]: the edits that turn the old words read so far into the first j new ones.
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  let best = 0;
  for (let j = 1; j <= b.length; j += 1) if (row[j] <= row[best]) best = j;
  return shared + best;
}

/**
 * What of `heard` was said after `taken`, where `taken` is everything that had
 * been heard when the reader made the dictated words their own (they edited
 * the draft). A count of characters cannot answer that: the utterance still
 * being revised comes back with a comma added or a word corrected, and a cut
 * at the old length lands in the middle of a word. So the words are compared
 * instead, and what the reader already has stays theirs however it is respelt.
 *
 * `taken` comes back as it now reads in `heard`, for the next comparison.
 */
export function spokenSince(taken: string, heard: string): { taken: string; spoken: string } {
  const had = spokenWords(taken);
  if (had.length === 0) return { taken: "", spoken: heard.trimStart() };
  const now = spokenWords(heard);
  const kept = saidAgain(
    had.map((w) => w.word),
    now.map((w) => w.word),
  );
  if (kept >= now.length) return { taken: heard, spoken: "" };
  const at = now[kept].at;
  return { taken: heard.slice(0, at).trimEnd(), spoken: heard.slice(at) };
}

/**
 * Project an edit's raw ownership into the current formatted stream. Compare
 * recognition with recognition first; never count formatted words as though
 * they were raw words. Unchanged words anchor the projection. Each changed
 * span is atomic: if it overlaps owned raw input, its entire expansion stays
 * owned (including a closing formatting marker which arrived after the edit).
 * Unchanged suffix words beyond that span remain newly spoken.
 */
export function formattedSince(taken: string, raw: string, formatted: string): { taken: string; formattedTaken: string; spoken: string } {
  const recognition = spokenSince(taken, raw);
  let owned = spokenWords(recognition.taken).length;
  if (owned === 0) return { taken: "", formattedTaken: "", spoken: formatted.trimStart() };
  const a = spokenWords(raw);
  const b = spokenWords(formatted);
  const anchors: [number, number][] = [];
  let head = 0;
  while (head < a.length && head < b.length && a[head].word === b[head].word) {
    anchors.push([head, head]);
    head++;
  }
  let endA = a.length, endB = b.length;
  while (endA > head && endB > head && a[endA - 1].word === b[endB - 1].word) { endA--; endB--; }
  // Most dictation is an unchanged prefix/suffix. Bound alignment of the
  // changed middle; an ambiguous larger rewrite remains one atomic span.
  const n = endA - head, m = endB - head;
  if (n <= 256 && m <= 256) {
    const rows = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      rows[i][j] = a[head + i].word === b[head + j].word ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[head + i].word === b[head + j].word) { anchors.push([head + i++, head + j++]); }
      else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
      else j++;
    }
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) anchors.push([i, j]);
  anchors.push([a.length, b.length]);
  let rawAt = 0, displayAt = 0, displayOwned = 0;
  for (const [rawEnd, displayEnd] of anchors) {
    // A pure insertion at the owned boundary belongs to the preceding span.
    const changed = rawEnd > rawAt || displayEnd > displayAt;
    if (changed && (rawAt < owned || (rawAt === rawEnd && rawAt === owned))) {
      owned = Math.max(owned, rawEnd);
      displayOwned = displayEnd;
    }
    if (rawEnd < owned) displayOwned = displayEnd + 1;
    rawAt = rawEnd + 1;
    displayAt = displayEnd + 1;
  }
  const rawCut = owned >= a.length ? raw.length : a[owned].at;
  const displayCut = displayOwned >= b.length ? formatted.length : b[displayOwned].at;
  return { taken: raw.slice(0, rawCut).trimEnd(), formattedTaken: formatted.slice(0, displayCut).trimEnd(), spoken: formatted.slice(displayCut) };
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

/** Keep both surrounding anchors exact; ambiguity means no learning. */
export function correctedSegment(before: string, after: string, sent: string): string | null {
  if (!sent.startsWith(before) || !sent.endsWith(after) || sent.length < before.length + after.length) return null;
  return sent.slice(before.length, sent.length - after.length || undefined);
}
