// The words a worktree's name is drawn from, as `src-tauri/src/names.rs` draws them; a test there keeps the two the same.
const ADJECTIVES = new Set([
  "quiet", "brisk", "calm", "clever", "cozy", "dapper", "eager", "fuzzy", "gentle", "happy", "jolly",
  "keen", "lively", "merry", "nimble", "plucky", "proud", "quick", "rusty", "sleepy", "sly", "snug",
  "spry", "sturdy", "sunny", "swift", "tidy", "tiny", "wily", "witty", "zesty", "bold",
]);

const COLORS = new Set([
  "amber", "ash", "azure", "bronze", "cedar", "cherry", "clay", "cobalt", "copper", "coral", "cream",
  "ember", "fern", "flax", "ginger", "hazel", "indigo", "ivory", "jade", "lilac", "maple", "mint",
  "moss", "ochre", "olive", "pearl", "plum", "rose", "sage", "slate", "teal", "umber",
]);

const ANIMALS = new Set([
  "badger", "bear", "beaver", "bison", "crane", "deer", "falcon", "finch", "fox", "hare", "heron",
  "ibis", "jay", "koala", "lark", "lemur", "lynx", "marten", "mole", "moose", "otter", "owl", "panda",
  "quail", "raccoon", "raven", "robin", "seal", "stoat", "tern", "vole", "wren",
]);

/** A name drawn for a worktree (`calm-ember-panda`), not one somebody chose. */
export function isWorktreeName(name: string): boolean {
  const [adjective, color, animal] = name.split("-");
  return ADJECTIVES.has(adjective) && COLORS.has(color) && ANIMALS.has(animal ?? "");
}

/**
 * A branch named only by its worktree's drawn name, after any prefix (`dc/calm-ember-panda`): nobody has named it.
 * Known from the name alone, so the sidebar draws its rows right the first time rather than once the checkouts load.
 */
export function isPlaceholderBranch(branch: string): boolean {
  return isWorktreeName(branch.split("/").pop() ?? branch);
}

const FILLER = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from", "into", "is", "are", "be", "it", "this", "that",
  "i", "we", "you", "me", "my", "our", "please", "can", "could", "would", "should", "let", "lets", "let's", "need", "want", "like", "just", "some", "so",
]);

/**
 * A worktree name from what the session is asked to do: its first few words
 * that say something (`fix-login-redirect`), at most 40 characters. Empty when
 * the prompt has none, and the drawn name is used instead.
 */
export function worktreeNameFromPrompt(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]+/g, ""))
    .filter((word) => word && !FILLER.has(word));
  let name = "";
  for (const word of words.slice(0, 5)) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > 40) break;
    name = next;
  }
  return name;
}
