import type { GitSource } from "./gitSource";
import type { AgentEvent } from "@/types/events";

export type ChangesScope = "all" | "uncommitted" | "turn" | "checkpoint" | "commit" | "history";
export type ChangesChoice = { scope: ChangesScope; target: string | null; commit: string | null; checkpoint?: string };
const preferenceKey = (source: string) => `changes-scope:${source}`;
const objectId = /^[a-f0-9]{7,64}$/i;
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function readChangesChoice(source: string): ChangesChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(source)) ?? "null");
    if (saved && ["all", "uncommitted", "turn", "checkpoint", "commit", "history"].includes(saved.scope)) {
      return { scope: saved.scope, target: typeof saved.target === "string" ? saved.target : null,
        commit: typeof saved.commit === "string" && objectId.test(saved.commit) ? saved.commit : null,
        ...(typeof saved.checkpoint === "string" ? { checkpoint: saved.checkpoint } : {}) };
    }
  } catch { /* Storage may be unavailable. */ }
  return { scope: "all", target: null, commit: null };
}

/** Resolve only checkpoints in this conversation's events, never a saved tree from another tab. */
export function checkpointChoices(events: AgentEvent[]) {
  const key = (event: AgentEvent, seq: number) => JSON.stringify([event.sessionId, event.tabId, seq]);
  const prompts = new Map<string, string>();
  const checkpoints = new Map<string, { id: string; label: string; base: string; head: string }>();
  for (const event of events) {
    if (event.subagent) continue;
    const payload = event.payload;
    if (payload.type === "user_message" && !payload.queued) prompts.set(key(event, event.seq), payload.text);
    if (payload.type !== "turn_checkpoint") continue;
    const id = key(event, payload.seq);
    const prompt = prompts.get(id)?.replace(/\s+/g, " ").trim().slice(0, 80);
    checkpoints.set(id, { id, label: `Turn · ${prompt || `checkpoint ${payload.seq}`}`, base: payload.base, head: payload.head });
  }
  return [...checkpoints.values()].reverse();
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
