import { useSyncExternalStore } from "react";
import { WorkspaceRpcError, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { listRepositories } from "@terminalx/portable/workspaceGit";
import {
  FS_MAX_FILE_BYTES,
  listRemoteDir,
  readRemoteFile,
  remotePath,
  searchRemote,
  statRemote,
  writeRemoteFile,
} from "@terminalx/portable/workspaceFiles";
import { files, fs, type DirEntry, type FileHit, type ReplaceReport, type ReplaceTarget, type TextSearch } from "@/lib/api";
import type { ChangeStatus } from "@/types/session";

/**
 * Where the file tree and editor read and write (PRO-24): the local checkout
 * through the Tauri commands, or a cloud workspace through its runtime's
 * `fs/1` (docs/CLOUD-FILES.md). A cloud source only ever sends
 * workspace-relative paths over its own connection, so nothing it does can
 * reach a file on this computer or in another workspace.
 */
export interface FileSource {
  /** `local:<root>`, or the cloud workspace's target key. */
  readonly key: string;
  readonly kind: "local" | "cloud";
  /** A participant may browse and read a cloud workspace, not change it. */
  readonly readOnly: boolean;
  listDir(rel: string): Promise<SourceEntry[]>;
  readText(rel: string): Promise<SourceText>;
  /**
   * Replace a file's text. `baseEtag` is the content the buffer was based
   * on: a cloud workspace refuses the save with a conflict if the file
   * changed since. Null: the file must not exist. Undefined overwrites.
   */
  writeText(rel: string, text: string, baseEtag: string | null | undefined): Promise<FileState>;
  /**
   * The file's current state, or null when it is gone. `etag` asks for the
   * content hash even of a large file (a cloud save needs it).
   */
  stat(rel: string, options?: { etag?: boolean }): Promise<FileState | null>;
  /** Changed paths as they happen; null means "re-read everything" (after a reconnect). */
  watch?(listener: (paths: string[] | null) => void): () => void;
  /** Git status of changed files, for the tree's badges. */
  changes?(): Promise<{ path: string; status: ChangeStatus }[]>;
  /**
   * Grep the files. `replacement` asks each hit to carry what its matches
   * would become (a preview; nothing is written). `limit` caps the hits.
   */
  search?(query: SearchQuery, signal: AbortSignal): Promise<TextSearch>;
  /** Fuzzy file-name search, best first (Quick Open). */
  findFiles?(query: string, limit: number): Promise<FileHit[]>;
  /**
   * Rewrite matches in files. Null `targets` walks every searchable file,
   * skipping the paths in `skip`. Local only for now.
   */
  replaceText?(input: ReplaceInput): Promise<ReplaceReport>;
  /** A media file as an object URL; release it when done. */
  readMedia?(rel: string): Promise<{ url: string; state: FileState; release(): void }>;
}

export interface SearchQuery {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  replacement?: string;
  limit?: number;
}

export interface ReplaceInput {
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  targets: ReplaceTarget[] | null;
  skip: string[];
}

export interface SourceEntry extends DirEntry {
  /** A symlink that leaves the workspace: shown, never followed. */
  escapes?: boolean;
  symlink?: boolean;
}

/** Enough to tell whether a file changed since it was read. */
export interface FileState {
  /** Cheap identity (mtime locally; size, mtime and inode remotely). */
  version: string;
  /** Content hash, where known; a save is conditional on it. */
  etag?: string;
}

export interface SourceText extends FileState {
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

/** Text files larger than this are not opened for editing remotely. */
export const CLOUD_TEXT_LIMIT = 4 * 1024 * 1024;
export const CLOUD_MEDIA_LIMIT = FS_MAX_FILE_BYTES;

/** A different file state; a matching content hash means nothing that matters changed. */
export function changedSince(before: FileState, now: FileState | null): boolean {
  if (!now) return true;
  if (now.version === before.version) return false;
  return !(before.etag && now.etag && before.etag === now.etag);
}

/** The local checkout, exactly as the editor used it before cloud workspaces. */
export function localFileSource(root: string): FileSource {
  const abs = (rel: string) => (rel ? `${root}/${rel}` : root);
  return {
    key: `local:${root}`,
    kind: "local",
    readOnly: false,
    listDir: (rel) => fs.listDir(root, rel),
    readText: async (rel) => {
      const file = await fs.readText(abs(rel));
      return { ...file, version: String(file.mtimeMs) };
    },
    writeText: async (rel, text) => ({ version: String(await fs.writeText(abs(rel), text)) }),
    stat: async (rel) => {
      const mtime = await fs.mtime(abs(rel));
      return mtime == null ? null : { version: String(mtime) };
    },
    search: ({ query, regex, caseSensitive, limit, replacement }) => fs.searchText(root, query, regex, caseSensitive, limit, replacement),
    findFiles: (query, limit) => files.search(root, query, limit),
    replaceText: ({ query, replacement, regex, caseSensitive, targets, skip }) => fs.replaceText(root, query, replacement, regex, caseSensitive, targets, skip),
  };
}

/** A request whose workspace was closed or switched away from; its answer is dropped. */
export class StaleRequestError extends Error {
  constructor() {
    super("The workspace was closed");
    this.name = "StaleRequestError";
  }
}

export interface CloudFileSource extends FileSource {
  readonly kind: "cloud";
  /** Stop watching, cancel searches and drop every answer still on its way. */
  dispose(): void;
}

const PORCELAIN: Record<string, ChangeStatus> = { "?": "added", A: "added", M: "modified", D: "deleted", R: "renamed", C: "added" };

/** A cloud workspace's files over one connection. */
export function cloudFileSource(key: string, client: WorkspaceRpcClient, readOnly: boolean): CloudFileSource {
  let disposed = false;
  const controllers = new Set<AbortController>();
  const listeners = new Set<(paths: string[] | null) => void>();
  let stopWatch: (() => void) | null = null;
  let watching: Promise<void> | null = null;

  const live = <T>(request: Promise<T>): Promise<T> =>
    request.then(
      (value) => {
        if (disposed) throw new StaleRequestError();
        return value;
      },
      (error) => {
        throw disposed ? new StaleRequestError() : error;
      },
    );

  const ensureWatch = () => {
    if (watching || disposed) return;
    watching = client
      .watchFiles("", (paths) => {
        for (const listener of listeners) listener(paths);
      })
      .then((stop) => {
        if (disposed) stop();
        else stopWatch = stop;
      })
      .catch(() => {
        // Not granted, or refused: callers fall back to explicit refreshes.
        watching = null;
      });
  };

  return {
    key,
    kind: "cloud",
    readOnly,
    listDir: (rel) =>
      live(listRemoteDir(client, rel)).then((listing) =>
        listing.entries
          .filter((entry) => entry.name !== ".git" && entry.name !== ".DS_Store")
          .map((entry) => ({
            name: entry.name,
            path: entry.path,
            isDir: entry.kind === "directory",
            symlink: entry.symlink,
            escapes: entry.escapes,
          }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
      ),
    readText: async (rel) => {
      const file = await live(readRemoteFile(client, rel, { maxBytes: CLOUD_TEXT_LIMIT }));
      return {
        content: file.text ?? "",
        size: file.size,
        binary: file.binary || file.text === null,
        truncated: false,
        version: file.version,
        etag: file.etag,
      };
    },
    writeText: async (rel, text, baseEtag) => {
      const written = await live(writeRemoteFile(client, rel, text, baseEtag));
      return { version: written.version ?? "", etag: written.etag };
    },
    stat: async (rel, options) => {
      try {
        const stat = await live(statRemote(client, rel, options));
        return { version: stat.version ?? String(stat.modifiedMs), etag: stat.etag };
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as { code: string }).code === "not_found") return null;
        throw error;
      }
    },
    watch: (listener) => {
      listeners.add(listener);
      ensureWatch();
      return () => listeners.delete(listener);
    },
    changes: async () => {
      type Status = { repository: boolean; repo?: string; files?: { path: string; index: string; worktree: string }[] };
      const under = (repo: string | undefined) => (repo && repo !== "." ? `${repo}/` : "");
      const badges = (status: Status, prefix: string) =>
        (status.files ?? []).flatMap((file) => {
          const code = file.index === "?" ? "?" : file.worktree !== " " ? file.worktree : file.index;
          const change = PORCELAIN[code];
          return change ? [{ path: prefix + file.path, status: change }] : [];
        });
      try {
        const status = await live(client.call<Status>("git.status"));
        // Paths are the repository's; a lone clone below the root is prefixed too.
        return status.repository ? badges(status, under(status.repo)) : [];
      } catch (error) {
        if (!(error instanceof WorkspaceRpcError) || error.code !== "ambiguous_repository") throw error;
      }
      // Several repositories (PRO-27): each one's badges, under its directory.
      const repositories = await live(listRepositories(client));
      const each = await Promise.all(
        repositories.map((repository) =>
          live(client.call<Status>("git.status", { repo: repository.repo }))
            .then((status) => badges(status, under(repository.repo)))
            .catch(() => []),
        ),
      );
      return each.flat();
    },
    search: async (query, signal) => {
      const controller = new AbortController();
      controllers.add(controller);
      const forward = () => controller.abort();
      signal.addEventListener("abort", forward, { once: true });
      try {
        const result = await live(searchRemote(client, { query: query.query, regex: query.regex, caseSensitive: query.caseSensitive, maxResults: query.limit ?? 500 }, controller.signal));
        return { hits: result.hits, files: result.files, capped: result.capped || result.cancelled };
      } finally {
        signal.removeEventListener("abort", forward);
        controllers.delete(controller);
      }
    },
    readMedia: async (rel) => {
      const file = await live(readRemoteFile(client, rel, { maxBytes: CLOUD_MEDIA_LIMIT }));
      const blob = new Blob([file.bytes as BlobPart], { type: file.mediaType ?? "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      return { url, state: { version: file.version, etag: file.etag }, release: () => URL.revokeObjectURL(url) };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      listeners.clear();
      stopWatch?.();
    },
  };
}

// ---- the sources editors and trees resolve by key

const sources = new Map<string, FileSource>();
const sourceListeners = new Set<() => void>();

/** Make a cloud workspace's files reachable by editors opened on it. */
export function registerFileSource(source: FileSource): () => void {
  sources.set(source.key, source);
  for (const listener of sourceListeners) listener();
  return () => {
    if (sources.get(source.key) !== source) return;
    sources.delete(source.key);
    for (const listener of sourceListeners) listener();
  };
}

export function fileSourceFor(sourceKey: string | undefined, root: string): FileSource | null {
  if (!sourceKey) return localFileSource(root);
  return sources.get(sourceKey) ?? null;
}

export function onFileSourcesChanged(listener: () => void): () => void {
  sourceListeners.add(listener);
  return () => sourceListeners.delete(listener);
}

// ---- unsaved cloud buffers, kept while their view is away

/** An editor's unsaved text and the file state it was based on. */
export interface StashedBuffer {
  text: string;
  saved: string;
  state: FileState;
}

const stashed = new Map<string, StashedBuffer>();

/**
 * Keep a cloud editor's unsaved text when its view unmounts (the workspace
 * page closed or the connection went away), to restore it when the editor
 * shows again. Nothing is written anywhere; the text lives in memory only.
 */
export function stashBuffer(editorId: string, buffer: StashedBuffer): void {
  stashed.set(editorId, buffer);
}

export function takeStashedBuffer(editorId: string): StashedBuffer | undefined {
  const buffer = stashed.get(editorId);
  stashed.delete(editorId);
  return buffer;
}

/** The editor closed: whatever it had unsaved is gone with it. */
export function discardStashedBuffers(editorIds: string[]): void {
  for (const id of editorIds) stashed.delete(id);
}

/** The user left an organization (CS-18): its workspaces' file sources go; unsaved text goes with their editors. */
export function resetCloudFilesIn(orgId: string): void {
  const prefix = `cloud:${orgId}:`;
  let changed = false;
  for (const [key, source] of sources) {
    if (source.kind === "cloud" && key.startsWith(prefix)) {
      (source as CloudFileSource).dispose();
      sources.delete(key);
      changed = true;
    }
  }
  if (changed) for (const listener of sourceListeners) listener();
}

/** On an account or organization change: nothing of the old identity's workspaces stays. */
export function resetCloudFiles(): void {
  stashed.clear();
  for (const [key, source] of sources) {
    if (source.kind === "cloud") {
      (source as CloudFileSource).dispose();
      sources.delete(key);
    }
  }
  for (const listener of sourceListeners) listener();
}

export { remotePath };

/** The runtime refused a save because the file changed since it was read. */
export function isConflict(error: unknown): boolean {
  return typeof error === "object" && !!error && "code" in error && (error as { code: unknown }).code === "conflict";
}

/** Short text for an error from either source. */
export function fileErrorText(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : null;
  switch (code) {
    case "path_forbidden":
      return "This path is outside the workspace and cannot be opened.";
    case "too_large":
      return "This file is too large to open from the cloud workspace.";
    case "not_found":
      return "This file no longer exists in the workspace.";
    case "forbidden":
      return "This attachment can read the workspace but not change it.";
    case "conflict":
      return "The file changed in the workspace.";
    case "capability_not_granted":
    case "method_not_found":
      return "The workspace runtime does not serve this; update it to use files.";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

const localSources = new Map<string, FileSource>();

/**
 * The source an editor entry reads and writes through; null while its cloud
 * workspace is not open. Re-resolves when a workspace opens or closes.
 */
export function useFileSource(sourceKey: string | undefined, root: string): FileSource | null {
  return useSyncExternalStore(onFileSourcesChanged, () => {
    if (sourceKey) return sources.get(sourceKey) ?? null;
    let local = localSources.get(root);
    if (!local) localSources.set(root, (local = localFileSource(root)));
    return local;
  });
}
