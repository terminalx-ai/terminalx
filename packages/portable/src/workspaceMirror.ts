import { WorkspaceRpcClient, WorkspaceRpcError } from "./workspace";
import { remotePath } from "./workspaceFiles";

/**
 * `mirror/1` (PRO-25): the files a desktop may copy into its local mirror of
 * a cloud workspace. The runtime lists; the desktop reads each file with
 * `fs.read` and writes it into a directory of its own. Nothing sent here
 * names a place on this machine: the request carries only the id and cursor
 * of the listing being paged.
 */

/** One file of the mirror's file set. */
export interface MirrorEntry {
  /** Workspace-relative. */
  path: string;
  size: number;
  /** `fs.stat`'s `version`: changes whenever the file is rewritten. */
  version: string;
  executable: boolean;
}

export interface MirrorRepository {
  repo: string;
  branch: string | null;
  head: string | null;
}

/** Files left out of the set, by reason. */
export interface MirrorSkipped {
  secret: number;
  excluded: number;
  symlink: number;
  unsupported: number;
  tooLarge: number;
}

export interface MirrorManifest {
  /** Identifies this exact file set: the same files at the same versions give the same id. */
  manifestId: string;
  repositories: MirrorRepository[];
  entries: MirrorEntry[];
  totalBytes: number;
  skipped: MirrorSkipped;
  /** More files than a mirror holds: this listing must not be published. */
  truncated: boolean;
}

interface ManifestPage extends Omit<MirrorManifest, "entries"> {
  entries: MirrorEntry[];
  next: number | null;
  total: number;
}

/** A listing that keeps changing is asked for again at most this often. */
const MAX_RESTARTS = 3;

export class MirrorManifestError extends Error {
  constructor(readonly code: "aborted" | "unstable" | "invalid", message: string) {
    super(message);
  }
}

/**
 * The whole manifest, page by page. If the workspace's files change between
 * pages the listing starts over, a few times, then gives up as `unstable`.
 * Every path is checked to be workspace-relative before it is returned.
 */
export async function readMirrorManifest(client: WorkspaceRpcClient, options: { signal?: AbortSignal } = {}): Promise<MirrorManifest> {
  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    const first = await client.call<ManifestPage>("mirror.manifest", {});
    const entries = [...first.entries];
    let next = first.next;
    let restarted = false;
    while (next !== null) {
      if (options.signal?.aborted) throw new MirrorManifestError("aborted", "the mirror scan was stopped");
      try {
        const page = await client.call<ManifestPage>("mirror.manifest", { manifestId: first.manifestId, cursor: next });
        entries.push(...page.entries);
        next = page.next;
      } catch (error) {
        if (!(error instanceof WorkspaceRpcError) || error.code !== "cursor_expired") throw error;
        restarted = true;
        break;
      }
    }
    if (restarted) continue;
    if (entries.length !== first.total) throw new MirrorManifestError("invalid", "the manifest is incomplete");
    const seen = new Set<string>();
    for (const entry of entries) {
      // Throws for an absolute path or one that climbs out.
      if (remotePath(entry.path) !== entry.path || seen.has(entry.path)) throw new MirrorManifestError("invalid", `the manifest names an invalid path: ${entry.path}`);
      seen.add(entry.path);
    }
    return {
      manifestId: first.manifestId,
      repositories: first.repositories,
      entries,
      totalBytes: first.totalBytes,
      skipped: first.skipped,
      truncated: first.truncated,
    };
  }
  throw new MirrorManifestError("unstable", "the workspace's files kept changing while they were listed");
}
