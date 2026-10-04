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
  /** Tool configuration that runs commands by itself (agent settings, MCP servers, editor tasks, Git hooks). */
  toolConfig: number;
  /** Files inside a folder Git would take for a repository's own directory. */
  gitDirectory: number;
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
/**
 * This side's own bounds. The workspace is not trusted to stop: its
 * `truncated` flag and its 50,000 limit are only its word.
 */
export const MIRROR_MAX_ENTRIES = 50_000;
export const MIRROR_MAX_PAGES = 1_000;

export class MirrorManifestError extends Error {
  constructor(readonly code: "aborted" | "unstable" | "invalid" | "too_many", message: string) {
    super(message);
  }
}

/**
 * The whole manifest, page by page. If the workspace's files change between
 * pages the listing starts over, a few times, then gives up as `unstable`.
 * A path that is not a plain workspace-relative one (a backslash, a drive
 * letter, a `..`) is left out and counted as unsupported: one odd name must
 * not stop the whole mirror, and it is never asked for or written.
 */
/** The runtime's counts, with zero for a reason an older runtime does not report, plus the names left out here. */
function countsOf(reported: Partial<MirrorSkipped> | undefined, odd: number): MirrorSkipped {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    secret: count(reported?.secret),
    toolConfig: count(reported?.toolConfig),
    gitDirectory: count(reported?.gitDirectory),
    excluded: count(reported?.excluded),
    symlink: count(reported?.symlink),
    unsupported: count(reported?.unsupported) + odd,
    tooLarge: count(reported?.tooLarge),
  };
}

/** Exactly what `remotePath` would send: relative, no `..`, no backslash, no drive. */
function plainPath(path: string): boolean {
  try {
    return path.length > 0 && remotePath(path) === path;
  } catch {
    return false;
  }
}

export async function readMirrorManifest(client: WorkspaceRpcClient, options: { signal?: AbortSignal } = {}): Promise<MirrorManifest> {
  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    const first = await client.call<ManifestPage>("mirror.manifest", {});
    const entries = [...first.entries];
    let next = first.next;
    let restarted = false;
    let pages = 1;
    const tooMany = () => new MirrorManifestError("too_many", "the workspace lists more files than a mirror holds");
    if (entries.length > MIRROR_MAX_ENTRIES) throw tooMany();
    while (next !== null) {
      if (options.signal?.aborted) throw new MirrorManifestError("aborted", "the mirror scan was stopped");
      // A cursor that does not move forward would never end.
      if (++pages > MIRROR_MAX_PAGES || !Number.isInteger(next) || next !== entries.length) {
        throw pages > MIRROR_MAX_PAGES ? tooMany() : new MirrorManifestError("invalid", "the manifest's pages do not follow one another");
      }
      try {
        const page = await client.call<ManifestPage>("mirror.manifest", { manifestId: first.manifestId, cursor: next });
        if (page.manifestId !== first.manifestId || !Array.isArray(page.entries) || page.entries.length === 0) {
          throw new MirrorManifestError("invalid", "the manifest's pages do not follow one another");
        }
        entries.push(...page.entries);
        if (entries.length > MIRROR_MAX_ENTRIES) throw tooMany();
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
    const kept: MirrorEntry[] = [];
    let odd = 0;
    for (const entry of entries) {
      if (typeof entry?.path !== "string" || !Number.isFinite(entry.size) || entry.size < 0 || typeof entry.version !== "string") {
        throw new MirrorManifestError("invalid", "the manifest has an entry that is not a file");
      }
      if (seen.has(entry.path)) throw new MirrorManifestError("invalid", `the manifest names a path twice: ${entry.path}`);
      seen.add(entry.path);
      if (!plainPath(entry.path)) odd += 1;
      else kept.push(entry);
    }
    return {
      manifestId: first.manifestId,
      repositories: first.repositories,
      entries: kept,
      totalBytes: kept.reduce((sum, entry) => sum + entry.size, 0),
      skipped: countsOf(first.skipped, odd),
      truncated: first.truncated === true,
    };
  }
  throw new MirrorManifestError("unstable", "the workspace's files kept changing while they were listed");
}
