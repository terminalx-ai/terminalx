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

/** A prompt as a turn's name: whitespace folded, cut at a word (never mid-word), with the whole prompt kept for its title. */
export function turnName(prompt: string, max = 48): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,.;:–—-]+$/, "")}…`;
}

export interface TurnCheckpoint {
  id: string;
  /** 1 for the conversation's first turn with a snapshot. */
  number: number;
  /** "Turn 3 · Sort by any column", or "Latest turn · …" for the newest. */
  label: string;
  /** The whole prompt, folded to one line. */
  prompt: string;
  /** When the turn's snapshot was taken (ISO), when the event says. */
  at: string | null;
  base: string;
  head: string;
}

/** Resolve only checkpoints in this conversation's events, never a saved tree from another tab. Newest first. */
export function checkpointChoices(events: AgentEvent[]): TurnCheckpoint[] {
  const key = (event: AgentEvent, seq: number) => JSON.stringify([event.sessionId, event.tabId, seq]);
  const prompts = new Map<string, string>();
  const checkpoints = new Map<string, Omit<TurnCheckpoint, "number" | "label">>();
  for (const event of events) {
    if (event.subagent) continue;
    const payload = event.payload;
    if (payload.type === "user_message" && !payload.queued) prompts.set(key(event, event.seq), payload.text);
    if (payload.type !== "turn_checkpoint") continue;
    const id = key(event, payload.seq);
    const prompt = (prompts.get(id) ?? "").replace(/\s+/g, " ").trim();
    checkpoints.set(id, { id, prompt, at: event.ts || null, base: payload.base, head: payload.head });
  }
  const list = [...checkpoints.values()];
  return list.map((entry, index) => {
    const number = index + 1;
    const name = turnName(entry.prompt) || `checkpoint ${number}`;
    return { ...entry, number, label: `${index === list.length - 1 ? "Latest turn" : `Turn ${number}`} · ${name}` };
  }).reverse();
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
