import type { GitSource } from "./gitSource";

export type ChangesScope = "all" | "uncommitted" | "turn" | "commit" | "history";
export type ChangesChoice = { scope: ChangesScope; target: string | null; commit: string | null };
const preferenceKey = (source: string) => `changes-scope:${source}`;
const objectId = /^[a-f0-9]{7,64}$/i;
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function readChangesChoice(source: string): ChangesChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(source)) ?? "null");
    if (saved && ["all", "uncommitted", "turn", "commit", "history"].includes(saved.scope)) {
      return { scope: saved.scope, target: typeof saved.target === "string" ? saved.target : null,
        commit: typeof saved.commit === "string" && objectId.test(saved.commit) ? saved.commit : null };
    }
  } catch { /* Storage may be unavailable. */ }
  return { scope: "all", target: null, commit: null };
}

export function saveChangesChoice(source: string, choice: ChangesChoice) {
  try { localStorage.setItem(preferenceKey(source), JSON.stringify(choice)); } catch { /* Optional persistence. */ }
}

/** Use the commit's own trees, never a workspace snapshot or merge-base. */
export async function commitRange(source: GitSource, sha: string) {
  if (!objectId.test(sha)) throw new Error("Invalid commit ID.");
  sha = sha.toLowerCase();
  const commit = (await source.logCommits(sha, 1))[0];
  if (!commit || !commit.sha.startsWith(sha)) throw new Error("This commit is unavailable in the workspace.");
  const parent = commit.parent ? (await source.logCommits(commit.parent, 1))[0] : null;
  if (commit.parent && (!parent || parent.sha !== commit.parent)) throw new Error("The parent of this commit is unavailable. Fetch its history and try again.");
  return { base: parent?.tree ?? EMPTY_TREE, head: commit.tree, target: `${commit.shortSha} · ${commit.subject}` };
}
