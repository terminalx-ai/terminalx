import type { CleanupCandidate, CleanupProject, CleanupRemoveItem, CleanupResult, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { api, errorMessage } from "@/lib/api";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import { connectedCloudClient } from "@/lib/cloudConnections";
import { managesOf } from "@/lib/cloudSessions";
import { cloudWorkspaceKey } from "@/types/target";

/**
 * The bulk worktree clean-up, across the hosts this desktop can reach.
 *
 * A host is this computer or one cloud workspace. Each owns its worktrees:
 * it scans them, measures them and removes them itself, and a path it
 * reports is only ever sent back to it. Two hosts can report the same path
 * (`/home/user/repo/...` on two VMs); a candidate is therefore always named
 * by host and path together.
 *
 * A host that cannot be asked (not connected, an older runtime, no manager
 * access, a call that fails) is unverifiable. Nothing of it is listed as
 * removable and nothing is assumed about it.
 */

export const LOCAL_HOST = "local";

export interface CleanupHost {
  id: string;
  kind: "local" | "cloud";
  name: string;
  /** Why it cannot be asked right now; null when it can. */
  unavailable: string | null;
  scan(): Promise<CleanupProject[]>;
  size(job: string, projectPath: string, path: string): Promise<number | null>;
  cancelSizes(): Promise<void>;
  /** May throw: the host stopped answering, and what it did is not known. */
  remove(items: CleanupRemoveItem[]): Promise<CleanupResult[]>;
}

export interface HostScan {
  host: CleanupHost;
  /** Null when the host could not be scanned; `error` then says why. */
  projects: CleanupProject[] | null;
  error: string | null;
}

/** What one selected worktree came to. `unknown`: the host stopped answering while it was being removed. */
export interface CleanupOutcome extends Omit<CleanupResult, "outcome"> {
  hostId: string;
  outcome: CleanupResult["outcome"] | "unknown";
}

export interface CleanupSelection {
  hostId: string;
  candidate: CleanupCandidate;
  deleteSessions: boolean;
}

export function candidateKey(hostId: string, path: string): string {
  return `${hostId}\n${path}`;
}

/** A candidate the clean-up may remove: eligible, or holding ignored local files the person agreed to lose. */
export function selectable(candidate: CleanupCandidate, includeIgnored: boolean): boolean {
  return candidate.verdict === "eligible" || (includeIgnored && candidate.verdict === "ignoredData");
}

export const localHost: CleanupHost = {
  id: LOCAL_HOST,
  kind: "local",
  name: "This computer",
  unavailable: null,
  scan: () => api.worktreeCleanupScan(),
  size: (job, projectPath, path) => api.worktreeCleanupSize(job, projectPath, path),
  cancelSizes: () => api.worktreeCleanupCancelSizes(""),
  remove: (items) => api.worktreeCleanupRemove(items),
};

const NOT_CONNECTED = "Not connected. A workspace that cannot be reached is skipped, never assumed clean or idle. Open it and scan again to include it.";

function cloudUnavailable(client: WorkspaceRpcClient | null): string | null {
  if (!client) return NOT_CONNECTED;
  if (!client.hasCapability("cleanup/1")) return "Its runtime is older than this clean-up. Restart the workspace to update it.";
  if (!managesOf(client)) return "Cleaning up its worktrees needs manager access to the workspace.";
  return null;
}

/** A cloud workspace as a host. The connection is looked up at each call: one that dropped is not waited for. */
export function cloudHost(orgId: string, workspaceId: string, name: string, clientOf: (key: string) => WorkspaceRpcClient | null = connectedCloudClient): CleanupHost {
  const key = cloudWorkspaceKey(orgId, workspaceId);
  const client = () => {
    const current = clientOf(key);
    const unavailable = cloudUnavailable(current);
    if (!current || unavailable) throw new Error(unavailable ?? NOT_CONNECTED);
    return current;
  };
  return {
    id: key,
    kind: "cloud",
    name,
    unavailable: cloudUnavailable(clientOf(key)),
    scan: async () => client().scanCleanup(),
    size: async (job, projectPath, path) => client().cleanupSize(job, projectPath, path),
    cancelSizes: async () => client().cancelCleanupSizes(),
    // One at a time: each answer comes back before the next is asked, so a
    // drop leaves exactly one worktree whose fate is not known.
    remove: async (items) => {
      const results: CleanupResult[] = [];
      for (const item of items) results.push(...(await client().removeCleanup([item])));
      return results;
    },
  };
}

/** This computer, then every cloud workspace that is not archived or gone. */
export function cleanupHosts(catalog: CloudCatalogState, clientOf?: (key: string) => WorkspaceRpcClient | null): CleanupHost[] {
  const cloud = Object.values(catalog.orgs)
    .flatMap((org) => org.workspaces)
    .map((item) => item.workspace)
    .filter((workspace) => workspace.state !== "archived" && workspace.state !== "destroyed")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((workspace) => cloudHost(workspace.orgId, workspace.id, workspace.name, clientOf));
  return [localHost, ...cloud];
}

/** Scan the hosts side by side. One that fails is reported as unverifiable; the others still answer. */
export function scanHosts(hosts: CleanupHost[]): Promise<HostScan[]> {
  return Promise.all(
    hosts.map(async (host): Promise<HostScan> => {
      if (host.unavailable) return { host, projects: null, error: host.unavailable };
      try {
        return { host, projects: await host.scan(), error: null };
      } catch (error) {
        return { host, projects: null, error: `It could not be scanned (${errorMessage(error)}), so nothing of it is offered.` };
      }
    }),
  );
}

/**
 * Measure candidates one at a time, per host, reporting each as it is known.
 * `stop()` ends it: no further estimate starts, and the one under way is
 * cancelled on its host. A size that cannot be read is simply not reported.
 */
export function estimateSizes(scans: HostScan[], onSize: (key: string, bytes: number) => void, onDone: () => void = () => undefined): () => void {
  let stopped = false;
  const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const started = scans.filter((scan) => scan.projects);
  const work = started.map(async ({ host, projects }) => {
    let job = 0;
    for (const candidate of (projects ?? []).flatMap((project) => project.candidates)) {
      if (stopped) return;
      if (candidate.verdict === "protected") continue;
      try {
        const bytes = await host.size(`${run}-${++job}`, candidate.projectPath, candidate.path);
        if (!stopped && typeof bytes === "number") onSize(candidateKey(host.id, candidate.path), bytes);
      } catch {
        // The host stopped answering: its remaining sizes stay unknown.
        return;
      }
    }
  });
  void Promise.all(work).then(() => {
    if (!stopped) onDone();
  });
  return () => {
    if (stopped) return;
    stopped = true;
    for (const { host } of started) void host.cancelSizes().catch(() => undefined);
  };
}

function unanswered(hostId: string, item: CleanupRemoveItem, outcome: "unknown" | "skipped", reason: string): CleanupOutcome {
  return { hostId, projectPath: item.projectPath, path: item.path, outcome, reason, freedBytes: 0, keptBranch: null, sessionsKept: [], sessionsDeleted: [] };
}

/**
 * Remove what was confirmed, host by host. Each host checks its own
 * worktrees again and answers for each. When a host stops answering, the
 * worktree it was asked about is reported as unknown and the ones not yet
 * asked as skipped; the other hosts carry on.
 */
export async function runCleanup(hosts: CleanupHost[], selections: CleanupSelection[], onProgress: (done: CleanupOutcome[]) => void = () => undefined): Promise<CleanupOutcome[]> {
  const out: CleanupOutcome[] = [];
  const report = (outcomes: CleanupOutcome[]) => {
    out.push(...outcomes);
    onProgress([...out]);
  };
  for (const host of hosts) {
    const chosen = selections.filter((selection) => selection.hostId === host.id);
    if (!chosen.length) continue;
    const items: CleanupRemoveItem[] = chosen.map(({ candidate, deleteSessions }) => ({
      projectPath: candidate.projectPath,
      path: candidate.path,
      token: candidate.token,
      deleteSessions,
      acceptIgnored: candidate.verdict === "ignoredData",
    }));
    // Local removals answer together; a cloud host is asked one by one so a
    // drop is pinned to a single worktree.
    const batches = host.kind === "cloud" ? items.map((item) => [item]) : [items];
    for (let index = 0; index < batches.length; index++) {
      try {
        const results = await host.remove(batches[index]!);
        const answered = new Set(results.map((result) => result.path));
        report([
          ...results.map((result) => ({ ...result, hostId: host.id })),
          // A host must answer for everything it was asked; what it did not is unknown, not done.
          ...batches[index]!.filter((item) => !answered.has(item.path)).map((item) => unanswered(host.id, item, "unknown", "The host gave no answer for it. Scan again to see where it stands.")),
        ]);
      } catch (error) {
        const why = errorMessage(error);
        report([
          ...batches[index]!.map((item) => unanswered(host.id, item, "unknown", `The host stopped answering (${why}). It may or may not have been removed; scan again to see.`)),
          ...batches.slice(index + 1).flat().map((item) => unanswered(host.id, item, "skipped", "Not attempted: the host stopped answering.")),
        ]);
        break;
      }
    }
  }
  return out;
}

export interface CleanupTotals {
  removed: number;
  skipped: number;
  failed: number;
  freedBytes: number;
}

export function totals(outcomes: CleanupOutcome[]): CleanupTotals {
  const count = (...kinds: CleanupOutcome["outcome"][]) => outcomes.filter((outcome) => kinds.includes(outcome.outcome)).length;
  return {
    removed: count("removed", "alreadyRemoved"),
    skipped: count("skipped"),
    failed: count("failed", "unknown"),
    freedBytes: outcomes.reduce((sum, outcome) => sum + outcome.freedBytes, 0),
  };
}
