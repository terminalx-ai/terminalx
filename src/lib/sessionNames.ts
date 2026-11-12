/**
 * Short names for sessions started from a long prompt (PRO-333). Pure and
 * deterministic, no model call. Mirrors src-tauri/src/session_names.rs, which
 * names desktop sessions after their first turn: keep the two in step.
 *
 * A ticket/PR reference (PRO-123, #456) leads the name, followed by the title
 * written after it or else the first clause; otherwise the name is the first
 * imperative clause, skipping role preambles ("You are …"). Which name wins
 * (`chosenSessionName`): a reference-based name, else the agent's own title,
 * else the clause.
 */
const MAX_WORDS = 6;
const ATTRIBUTION = "[TerminalX Effective User v1] ";

const PREAMBLES = ["you are", "you're", "you will be", "your role", "your job", "act as", "as the", "as a", "continue work from", "continue from", "continuing", "context", "background", "this is", "the goal", "goal", "why"];
const LEADERS = ["please", "can you", "could you", "would you", "i want you to", "i need you to", "i'd like you to", "help me", "we need to", "we should", "let's", "lets", "go ahead and", "now", "first", "then", "your task is to", "your task", "task"];
const TRAILING_STOPWORDS = new Set(["a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "with", "by", "at", "from", "that", "so"]);
const SEPARATORS = new Set(["-", "—", "–", ":"]);

function body(prompt: string): string {
  const text = prompt.trim();
  if (text.startsWith(ATTRIBUTION)) {
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(newline + 1).trim();
  }
  return text;
}

/** A markdown line's text without heading, list or quote marks; `#456` stays. */
function unmark(line: string): string {
  let text = line.trim();
  for (;;) {
    const next = text.replace(/^#+(?=\s|$)/, "").replace(/^[*\->+]/, "").trimStart();
    if (next === text) return text;
    text = next;
  }
}

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n").map(unmark)) {
    for (const piece of line.match(/[^.!?]*[.!?](?= |$)|[^.!?]+$|.+$/g) ?? []) {
      const trimmed = piece.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** Whether the prompt is longer than a sentence. */
export function isLongPrompt(prompt: string): boolean {
  const text = body(prompt);
  return sentences(text).length > 1 || text.split(/\s+/).filter(Boolean).length > MAX_WORDS * 2;
}

function isReference(token: string): boolean {
  return /^#\d{1,7}$/.test(token) || /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(token);
}

const cleanReference = (raw: string) => raw.replace(/^[^A-Za-z0-9#-]+|[^A-Za-z0-9#-]+$/g, "");

/** A ticket or PR reference named in the prompt, the first one. */
export function promptReference(prompt: string): string | null {
  for (const raw of body(prompt).split(/\s+/)) {
    const token = cleanReference(raw);
    if (isReference(token)) return token;
  }
  return null;
}

/** Whether the generated name comes from a reference: such a name is kept over the agent's own title. */
export function isReferenceName(prompt: string): boolean {
  return isLongPrompt(prompt) && promptReference(prompt) !== null;
}

function startsWithAny(lower: string, list: string[]): string | undefined {
  return list.find((p) => lower.startsWith(p) && !/^[\p{L}\p{N}']/u.test(lower.slice(p.length)));
}

const stripLead = (text: string) => text.replace(/^[^\p{L}\p{N}#]+/u, "");
const cutClause = (text: string) => {
  const cut = text.search(/[,;:—–(]/);
  return cut >= 0 ? text.slice(0, cut) : text;
};

function wordsOf(clause: string, reference: string | null, budget: number): string[] {
  const words = clause
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}#/-]+|[^\p{L}\p{N}#/-]+$/gu, ""))
    .filter((w) => /[\p{L}\p{N}]/u.test(w) && w !== reference)
    .slice(0, budget);
  while (words.length && TRAILING_STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words;
}

/** The title written after the reference: `ENG-42: Fix login timeout`. */
function titledWords(text: string, reference: string, budget: number): string[] {
  for (const line of text.split("\n")) {
    const all = line.split(/\s+/).filter(Boolean);
    const at = all.findIndex((raw) => cleanReference(raw) === reference);
    if (at < 0) continue;
    const [first, ...rest] = all.slice(at);
    const separated = /[:—–]$/.test(first) || (rest.length > 0 && SEPARATORS.has(rest[0]));
    if (!separated) return [];
    let skip = 0;
    while (skip < rest.length && SEPARATORS.has(rest[skip])) skip++;
    const title = sentences(rest.slice(skip).join(" "))[0] ?? "";
    return wordsOf(cutClause(title), reference, budget);
  }
  return [];
}

function clauseWords(text: string, reference: string | null, budget: number): string[] {
  const all = sentences(text);
  const work = all.filter((s) => !startsWithAny(stripLead(s).toLowerCase(), PREAMBLES));
  // A heading or label of one word ("Goal") says less than the sentence after it.
  let clause = stripLead(work.find((s) => s.split(/\s+/).length > 1) ?? work[0] ?? all[0] ?? "");
  for (;;) {
    const lead = startsWithAny(clause.toLowerCase(), LEADERS);
    if (!lead) break;
    clause = stripLead(clause.slice(lead.length));
  }
  return wordsOf(cutClause(clause), reference, budget);
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The name for a session started from `prompt`; null when the prompt is no longer than a sentence or says nothing. */
export function generatedSessionName(prompt: string): string | null {
  if (!isLongPrompt(prompt)) return null;
  const text = body(prompt);
  const reference = promptReference(text);
  const budget = MAX_WORDS - (reference ? 1 : 0);
  let words = reference ? titledWords(text, reference, budget) : [];
  if (!words.length) words = clauseWords(text, reference, budget);
  const named = capitalize(words.join(" "));
  if (reference) return named ? `${reference} ${named}` : reference;
  return named || null;
}

/** The name a session takes given its agent's title: a reference-based name, else the agent's, else the clause. */
export function chosenSessionName(prompt: string, agentTitle?: string | null): string | null {
  if (isReferenceName(prompt)) return generatedSessionName(prompt);
  return agentTitle?.trim() || generatedSessionName(prompt);
}
