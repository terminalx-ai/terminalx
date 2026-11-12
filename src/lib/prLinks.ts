import { gh, type OpenPr, type PrAssociation } from "@/lib/api";
import { checkCounts } from "@/lib/checks";

/**
 * "Link pull request…" (PRO-294): a session shows an open pull request's
 * checks and review even when it is on another branch, or someone else's.
 * The link is kept with the session's other PR associations (on disk, so it
 * survives a restart). Push is not affected: it still goes to the session's
 * own branch.
 */

/** Matches the dialog's "Search open PRs by number, title or branch": every word must match one of them. */
export function filterOpenPrs<T extends OpenPr>(prs: readonly T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...prs];
  return prs.filter((pr) => words.every((word) => {
    const number = word.replace(/^#/, "");
    if (/^\d+$/.test(number) && String(pr.number).startsWith(number)) return true;
    return pr.title.toLowerCase().includes(word) || pr.headLabel.toLowerCase().includes(word) || pr.head.toLowerCase().includes(word) || pr.base.toLowerCase().includes(word);
  }));
}

export type CheckBadge = { tone: "passed" | "running" | "failed" | "draft" | "none"; text: string };

/** A row's check summary: "✓ 7 of 7", "● 2 running", "✕ 1 failed" or "Draft". */
export function checkBadge(pr: Pick<OpenPr, "isDraft" | "checks">): CheckBadge {
  if (pr.isDraft) return { tone: "draft", text: "Draft" };
  const counts = checkCounts(pr.checks);
  if (counts.total === 0) return { tone: "none", text: "No checks" };
  if (counts.failed) return { tone: "failed", text: `✕ ${counts.failed} failed` };
  if (counts.running) return { tone: "running", text: `● ${counts.running} running` };
  return { tone: "passed", text: `✓ ${counts.passed} of ${counts.total}` };
}

/** Two letters for an author's avatar: "aisha-k" → "AK", "paresh" → "PA". */
export function authorInitials(login: string): string {
  const name = login.replace(/\[bot\]$/i, "");
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase() || "?";
}

/** One of the avatar tints, the same for an author every time. */
export function authorTint(login: string): "info" | "accent" | "merged" | "add" {
  const tints = ["info", "accent", "merged", "add"] as const;
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tints[hash % tints.length];
}

/** True when `pr` is on a different branch from the session's (a fork head always is). */
export function onAnotherBranch(pr: Pick<OpenPr, "head" | "headLabel">, sessionBranch: string | null | undefined): boolean {
  return !sessionBranch || pr.headLabel !== pr.head || pr.head !== sessionBranch;
}

const listeners = new Set<(sessionId: string) => void>();

/** Told when a session's linked pull requests change, so its PR section reads them again at once. */
export function onPrLinksChanged(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(sessionId: string) {
  for (const listener of listeners) listener(sessionId);
}

export async function linkPr(sessionId: string, cwd: string, pr: OpenPr): Promise<PrAssociation[]> {
  const rows = await gh.link(sessionId, { url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd } });
  changed(sessionId);
  return rows;
}

export async function unlinkPr(sessionId: string, url: string): Promise<PrAssociation[]> {
  const rows = await gh.unlink(sessionId, url);
  changed(sessionId);
  return rows;
}
