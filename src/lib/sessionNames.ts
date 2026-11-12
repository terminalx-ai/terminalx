/**
 * Short names for sessions started from a long prompt (PRO-333). Pure and
 * deterministic, no model call. Mirrors src-tauri/src/session_names.rs: keep
 * the two in step.
 *
 * A ticket/PR reference (PRO-123, #456) leads the name; otherwise the name is
 * the first imperative clause, skipping role preambles ("You are …").
 */
const MAX_WORDS = 6;

const PREAMBLES = ["you are", "you're", "you will be", "your role", "your job", "act as", "as the", "as a", "continue work from", "continue from", "continuing", "context", "background", "this is", "the goal", "goal:"];
const LEADERS = ["please", "can you", "could you", "would you", "i want you to", "i need you to", "i'd like you to", "we need to", "we should", "let's", "lets", "go ahead and", "now", "first", "then", "your task is to", "your task:", "task:"];
const TRAILING_STOPWORDS = new Set(["a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "with", "by", "at", "from", "that", "so"]);

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const piece of line.match(/[^.!?]*[.!?](?=\s|$)|[^.!?]+$/g) ?? []) {
      const trimmed = piece.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** Whether the prompt is longer than a sentence. */
export function isLongPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return sentences(text).length > 1 || text.split(/\s+/).filter(Boolean).length > MAX_WORDS * 2;
}

function isReference(token: string): boolean {
  return /^#\d{1,7}$/.test(token) || /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(token);
}

/** A ticket or PR reference named in the prompt, the first one. */
export function promptReference(prompt: string): string | null {
  for (const raw of prompt.split(/\s+/)) {
    const token = raw.replace(/^[^A-Za-z0-9#-]+|[^A-Za-z0-9#-]+$/g, "");
    if (isReference(token)) return token;
  }
  return null;
}

/** Whether the generated name comes from a reference: such a name is kept over the agent's own title. */
export function isReferenceName(prompt: string): boolean {
  return isLongPrompt(prompt) && promptReference(prompt) !== null;
}

function startsWithAny(lower: string, list: string[]): string | undefined {
  return list.find((p) => lower.startsWith(p) && !/^[\p{L}\p{N}]/u.test(lower.slice(p.length)));
}

function clauseWords(prompt: string, reference: string | null, budget: number): string[] {
  const all = sentences(prompt.trim());
  let clause = all.find((s) => !startsWithAny(s.toLowerCase(), PREAMBLES)) ?? all[0] ?? "";
  const strip = (text: string) => text.replace(/^[^\p{L}\p{N}#]+/u, "");
  clause = strip(clause);
  for (;;) {
    const lead = startsWithAny(clause.toLowerCase(), LEADERS);
    if (!lead) break;
    clause = strip(clause.slice(lead.length));
  }
  const cut = clause.search(/[,;:—(]/);
  if (cut >= 0) clause = clause.slice(0, cut);
  const words = clause
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}#/-]+|[^\p{L}\p{N}#/-]+$/gu, ""))
    .filter((w) => w && w !== reference)
    .slice(0, budget);
  while (words.length > 1 && TRAILING_STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words;
}

/** The name for a session started from `prompt`; null when the prompt is no longer than a sentence or says nothing. */
export function generatedSessionName(prompt: string): string | null {
  if (!isLongPrompt(prompt)) return null;
  const reference = promptReference(prompt);
  const words = clauseWords(prompt, reference, MAX_WORDS - (reference ? 1 : 0));
  if (reference) return words.length ? `${reference} ${words.join(" ")}` : reference;
  if (!words.length) return null;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
