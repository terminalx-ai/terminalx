import { gh, type PrAssociation, type PullRequest } from "@/lib/api";
import type { GitSource } from "@/lib/gitSource";

export interface SessionPr {
  identity: string;
  association?: PrAssociation;
  pr?: PullRequest;
  /** Present only when returned by discovery for the current checkout branch. */
  current: boolean;
  error?: string;
}

export function prIdentity(url: string): string {
  return url.toLowerCase().replace(/\/$/, "");
}

/** Branch discovery locates current work; only recorded evidence establishes ownership. */
export async function sessionPrs(source: GitSource, sessionId: string | undefined, branch: string | null, isCurrent: () => boolean = () => true, checkLegacy = false): Promise<{ rows: SessionPr[]; error?: string; recoverable?: PullRequest[] }> {
  if (!isCurrent()) return { rows: [] };
  const discovery = await (branch ? source.prs(branch) : Promise.resolve([]))
    .then((prs) => ({ prs, error: undefined as string | undefined }), (error: unknown) => ({ prs: [] as PullRequest[], error: source.errorMessage(error) }));
  if (!isCurrent()) return { rows: [] };
  // Read after discovery to include creation evidence recorded while it was
  // in flight. The native registry also recovers durable session tool results.
  const { associations, discoveryOnly, legacyCandidates } = sessionId && source.prAssociations
    ? await source.prAssociations(sessionId, checkLegacy && discovery.prs.length > 0)
    : { associations: sessionId ? await gh.associations(sessionId) : [], discoveryOnly: false, legacyCandidates: undefined };
  if (!isCurrent()) return { rows: [] };
  const rows = new Map<string, SessionPr>();
  for (const association of associations) rows.set(prIdentity(association.url), { identity: prIdentity(association.url), association, current: false });
  for (const pr of discovery.prs) {
    const identity = prIdentity(pr.url);
    // Neither a live nor a saved branch proves ownership in a shared checkout.
    if (sessionId && !discoveryOnly && !rows.has(identity)) continue;
    rows.set(identity, { identity, pr, association: rows.get(identity)?.association, current: true });
  }
  await Promise.all([...rows.values()].filter((row) => !row.pr).map(async (row) => {
    try {
      if (!source.prAccess || !row.association) throw new Error("This PR's repository is unavailable.");
      const pr = await source.prAccess(row.association).read();
      if (prIdentity(pr.url) !== row.identity) throw new Error("GitHub returned a different pull request.");
      row.pr = pr;
    } catch (error) {
      row.error = source.errorMessage(error);
    }
  }));
  const recoverable = legacyCandidates && discovery.prs.filter((pr) => pr.state === "OPEN" && pr.head === branch &&
    legacyCandidates.some((entry) => entry.head === branch && entry.number === pr.number && prIdentity(entry.url) === prIdentity(pr.url)));
  return { recoverable, error: discovery.error ?? (discoveryOnly ? "Update the workspace runtime to verify complete session PR history. Branch PRs are shown without being associated with this session." : undefined), rows: [...rows.values()].sort((a, b) => Number(b.pr?.state === "OPEN") - Number(a.pr?.state === "OPEN") || (b.pr?.number ?? 0) - (a.pr?.number ?? 0)) };
}
